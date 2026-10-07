package handlers

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"backPOS-go/internal/infrastructure/dbbackup"
	"backPOS-go/internal/infrastructure/sse"
	"github.com/gin-gonic/gin"
	"github.com/jung-kurt/gofpdf"
	"gorm.io/gorm"
	"os"
	"os/exec"
	"path/filepath"
)

func formatCOP(amount float64) string {
	// Manejo de negativos
	isNegative := amount < 0
	if isNegative {
		amount = -amount
	}

	s := fmt.Sprintf("%.0f", amount)
	var res strings.Builder

	if isNegative {
		res.WriteRune('-')
	}

	n := len(s)
	for i, r := range s {
		res.WriteRune(r)
		if i < n-1 && (n-i-1)%3 == 0 {
			res.WriteRune('.')
		}
	}
	return res.String()
}

type DashboardHandler struct {
	service         *services.DashboardService
	telegramService *services.TelegramService
	auditService    *services.AuditService
	authService     *services.AuthService
	db              *gorm.DB
}

// NewDashboardHandler compone el handler con todas sus dependencias.
// `auth` se usa para verificar el token corto de autorización de
// faltante (/auth/verify-admin), consumido server-side por SaveClosure.
func NewDashboardHandler(s *services.DashboardService, tg *services.TelegramService, a *services.AuditService, auth *services.AuthService, db *gorm.DB) *DashboardHandler {
	return &DashboardHandler{service: s, telegramService: tg, auditService: a, authService: auth, db: db}
}

func (h *DashboardHandler) GetOverview(c *gin.Context) {
	startDate := c.Query("startDate")
	endDate := c.Query("endDate")

	data, err := h.service.GetOverview(c.Request.Context(), startDate, endDate)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener resumen del dashboard", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) GetCashierClosure(c *gin.Context) {
	data, err := h.service.GetCashierClosure()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener cierre de caja", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func applyTrustedClosureData(target *models.CashierClosure, trusted *services.CashierClosure) {
	manualExpenses := make([]models.Expense, 0)
	for _, expense := range target.Expenses {
		if expense.ID == 0 {
			manualExpenses = append(manualExpenses, expense)
		}
	}
	target.SalesCount = trusted.SalesCount
	target.TotalSales = trusted.TotalSales
	target.TotalCash = trusted.TotalCash
	target.TotalTransfer = trusted.TotalTransfer
	target.TotalCard = trusted.TotalCard
	target.TotalReturns = trusted.TotalReturns
	target.ReturnsCount = trusted.ReturnsCount
	target.TotalCreditIssued = trusted.TotalCreditIssued
	target.TotalCreditCollected = trusted.TotalCreditCollected
	target.OpeningCash = trusted.OpeningCash
	target.OpeningNequi = trusted.OpeningNequi
	target.OpeningDaviplata = trusted.OpeningDaviplata
	target.TotalNequi = trusted.TotalNequi
	target.TotalDaviplata = trusted.TotalDaviplata
	target.TotalBancolombia = trusted.TotalBancolombia
	target.TotalOtherTransfer = trusted.TotalOtherTransfer
	target.NetBalance = trusted.NetBalance
	target.CreditsIssued = trusted.CreditsIssued
	target.CreditPayments = trusted.CreditPayments
	target.Expenses = append(append([]models.Expense{}, trusted.Expenses...), manualExpenses...)
}

func (h *DashboardHandler) SaveClosure(c *gin.Context) {
	// Payload envolvente: el cuerpo trae el closure Y los campos
	// "fuera de modelo" (authorizationToken y clientTxId). Los dos últimos
	// NO viven en models.CashierClosure para no exponerlos al Save de GORM.
	var payload struct {
		models.CashierClosure
		AuthorizationToken string `json:"authorizationToken,omitempty"`
		ClientTxID         string `json:"clientTxId,omitempty"`
	}
	if err := c.ShouldBindJSON(&payload); err != nil {
		log.Printf("❌ [SaveClosure] Error al bindear JSON: %v", err)
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de cierre inválido", err)
		return
	}
	closure := payload.CashierClosure

	// ─── P0: rechazo estricto de `id` en POST create ────────────────────────
	// GORM Save hace UPSERT por PK: aceptar un id arbitrario permitiría
	// sobrescribir un cierre existente con el payload de uno nuevo. La
	// edición pasa por PUT /dashboard/cashier-history/:id, que está detrás
	// de RoleMiddleware("admin").
	if closure.ID != 0 {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "No se admite id en la creación de un cierre; use PUT para editar", nil)
		return
	}

	// ─── P0: no confiar en AuthorizedBy del body ────────────────────────────
	// El autorizador real se deriva del rol del actor o del claim JWT del
	// `authorizationToken`. Limpiar el string libre del body impide spoof.
	closure.AuthorizedBy = ""

	// ─── P1: idempotencia por client_tx_id (migración 018) ──────────────────
	// Lo validamos acá para dar error 400 legible si el UUID viene con
	// una longitud absurda (ataque de inflación). El servicio decide si
	// la verificación idempotente procede (tolerante a 018 no aplicada).
	if txID := strings.TrimSpace(payload.ClientTxID); txID != "" {
		if len(txID) > 64 {
			SendError(c, http.StatusBadRequest, ErrBadRequest, "clientTxId excede 64 caracteres", nil)
			return
		}
		closure.ClientTxID = &txID
	}

	// Obtener usuario del contexto de forma segura.
	dniStr, nameStr := GetContextUser(c)
	closure.ClosedByDNI = dniStr
	closure.ClosedByName = nameStr

	log.Printf("💾 [SaveClosure] Iniciando persistencia. Cajero: %s (%s)", closure.ClosedByName, closure.ClosedByDNI)

	// Asegurar que la fecha de fin sea la hora actual del servidor (UTC para consistencia)
	closure.EndDate = time.Now()

	// Obtener la fecha de inicio correcta (desde el último cierre o inicio de turno).
	// En POST create siempre pasa por aquí porque arriba se rechazó ID != 0.
	activeData, err := h.service.GetCashierClosure()
	if err != nil || activeData == nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudieron verificar los totales reales del turno", err)
		return
	}
	applyTrustedClosureData(&closure, activeData)
	if !activeData.StartDate.IsZero() {
		closure.StartDate = activeData.StartDate
	} else {
		loc := time.FixedZone("America/Bogota", -5*60*60)
		nowLocal := time.Now().In(loc)
		closure.StartDate = time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 0, 0, 1, 0, loc)
	}

	// ── REGLA DE MAYORÍA DE VENTAS ──────────────────────────────────────────
	// Si el turno abarca más de un día calendario (ej. viernes-sábado madrugada),
	// el cierre se registra en el día donde cayó la MAYORÍA de las ventas,
	// conservando la hora real de EndDate.
	// Así un turno que abre el viernes y cierra el sábado a las 2 AM queda como "viernes".
	loc := time.FixedZone("America/Bogota", -5*60*60)
	startLocal := closure.StartDate.In(loc)
	endLocal := closure.EndDate.In(loc)

	// Solo aplicar si el turno cruza al menos un día calendario
	if startLocal.Format("2006-01-02") != endLocal.Format("2006-01-02") {
		type daySales struct {
			Day   string
			Count int
		}
		var results []daySales
		h.db.Raw(
			`SELECT TO_CHAR("saleDate" AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS day,
			        COUNT(*) AS count
			 FROM sales
			 WHERE "saleDate" BETWEEN ? AND ?
			   AND deleted_at IS NULL
			 GROUP BY day
			 ORDER BY count DESC
			 LIMIT 1`,
			closure.StartDate, closure.EndDate,
		).Scan(&results)

		if len(results) > 0 && results[0].Day != "" {
			// Reemplazamos solo la fecha (año-mes-día) por la del día con más ventas,
			// manteniendo la hora real del EndDate en hora Bogotá.
			if majority, parseErr := time.ParseInLocation("2006-01-02", results[0].Day, loc); parseErr == nil {
				closure.Date = time.Date(
					majority.Year(), majority.Month(), majority.Day(),
					endLocal.Hour(), endLocal.Minute(), endLocal.Second(), 0, loc,
				)
				log.Printf("📅 [SaveClosure] Mayoría de ventas: %s (%d ventas) → fecha del cierre ajustada a %s",
					results[0].Day, results[0].Count, closure.Date.Format("2006-01-02 15:04"))
			} else {
				closure.Date = closure.EndDate
			}
		} else {
			closure.Date = closure.EndDate
		}
	} else {
		// Turno de un solo día: usar EndDate directamente
		closure.Date = closure.EndDate
	}

	// ─── P0: componer la autorización server-side ───────────────────────────
	// `authz.ActorIsAdmin` → el admin propio autoriza con su sesión.
	// `authz.Token*`       → el cajero empleado adjunta el token corto.
	// Cualquier otra ruta (string libre, header) queda cerrada.
	role := GetContextRole(c)
	authz := services.SaveClosureAuthorization{
		ActorIsAdmin: isAdminRole(role),
		ActorDNI:     dniStr,
		ActorName:    nameStr,
	}
	if !authz.ActorIsAdmin && strings.TrimSpace(payload.AuthorizationToken) != "" {
		claims, verr := h.authService.VerifyClosureAuthorization(payload.AuthorizationToken)
		if verr != nil {
			log.Printf("⚠️ [SaveClosure] Token de autorización rechazado para %s: %v", dniStr, verr)
			SendError(c, http.StatusForbidden, ErrForbidden, "Token de autorización inválido o expirado; vuelva a pedir la firma del admin", verr)
			return
		}
		authz.TokenAdminDNI = claims.AdminDNI
		authz.TokenAdminName = claims.AdminName
	}

	result, err := h.service.SaveClosure(&closure, authz)
	if err != nil {
		if errors.Is(err, services.ErrAuthorizationRequired) {
			log.Printf("⛔ [SaveClosure] Faltante sin autorización por %s", dniStr)
			SendError(c, http.StatusForbidden, ErrForbidden, "El faltante requiere autorización de un administrador antes de cerrar", err)
			return
		}
		log.Printf("❌ [SaveClosure] Error en servicio SaveClosure: %v", err)
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al guardar cierre de caja en base de datos", err)
		return
	}

	log.Printf("✅ [SaveClosure] Cierre guardado con éxito. ID: %d (reused=%v). Iniciando envío asíncrono de reportes...", result.ID, result.ReusedByClientTx)

	// ─── Auditoría ──────────────────────────────────────────────────────────
	// FIX P1 (isCritical en faltantes autorizados): un cierre con faltante
	// autorizado por admin es un evento forense. Antes se registraba como
	// no-crítico siempre y la autorización fraudulenta no quedaba marcada.
	expectedCash := closure.ExpectedCash
	if expectedCash == 0 {
		expectedCash = closure.TotalCash - closure.TotalExpenses - closure.TotalReturns
	}
	realBalance := closure.PhysicalCash + closure.TotalNequi + closure.TotalDaviplata + closure.TotalCard + closure.TotalBancolombia + closure.TotalOtherTransfer - closure.TotalExpenses

	isCritical := result.Difference < -closureAuditToleranceCOP
	auditAction := "CASH_CLOSURE"
	if result.ReusedByClientTx {
		auditAction = "CASH_CLOSURE_IDEMPOTENT_REUSE"
	}

	details := fmt.Sprintf("Cierre de caja ID #%d realizado por %s", result.ID, closure.ClosedByName)
	human := fmt.Sprintf("El cajero %s realizó el cierre de caja. Balance Real Físico: $%s. (Esperado sistema: $%s)",
		closure.ClosedByName, fmt.Sprintf("%.2f", realBalance), fmt.Sprintf("%.2f", expectedCash))
	changes := fmt.Sprintf(`{"expected": %f, "physical": %f, "realBalance": %f, "difference": %f, "authorizedBy": %q, "reusedByClientTx": %t}`,
		expectedCash, closure.PhysicalCash, realBalance, result.Difference, closure.AuthorizedBy, result.ReusedByClientTx)

	h.auditService.Log(dniStr, nameStr, auditAction, "SALES", details, human, changes, c.ClientIP(), c.Request.UserAgent(), isCritical)

	// Si el POST es un replay idempotente, NO re-emitimos Telegram ni PDF:
	// la primera llamada ya los disparó y repetirlos sería spam.
	if !result.ReusedByClientTx {
		go func(cl models.CashierClosure) {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("⚠️ [SaveClosure] El proceso de reportes asíncronos entró en PANIC: %v", r)
				}
			}()

			tgMsg := h.formatTelegramClosureMessage(cl, false)
			h.telegramService.SendMarkdownAlert(tgMsg)

			pdfBuf := h.generateClosurePDF(cl, false)
			filename := fmt.Sprintf("CIERRE_%s_%s.pdf", time.Now().Format("20060102"), cl.ClosedByDNI)
			_ = h.telegramService.SendDocument(pdfBuf, filename, "📄 Reporte de Cierre Profesional (PDF)")

			log.Printf("📤 [SaveClosure] Reportes asíncronos enviados para cierre ID: %d", cl.ID)

			h.triggerPostClosureBackup(cl)
		}(closure)
	}

	// Notificar a todos los clientes conectados que hubo un cierre (Zero-Reload)
	go sse.GetSSEService().BroadcastDashboardUpdate()

	status := http.StatusOK
	msg := "Cierre de caja procesado y guardado correctamente"
	if result.ReusedByClientTx {
		msg = "Cierre ya registrado previamente (idempotencia). Devolviendo id existente."
	}
	c.JSON(status, gin.H{
		"message":          msg,
		"id":               result.ID,
		"reusedByClientTx": result.ReusedByClientTx,
	})
}

// isAdminRole centraliza el reconocimiento de rol administrador en el
// handler. Está también replicado en el helper `actorIsAdmin` del
// LabelHandler; se mantiene duplicado a propósito para no cruzar
// paquetes (el helper del label handler usa el role del context en vez
// del param).
func isAdminRole(role string) bool {
	normalized := strings.ToLower(strings.TrimSpace(role))
	return normalized == "admin" || normalized == "administrador" || normalized == "superadmin"
}

// closureAuditToleranceCOP es la tolerancia en pesos para considerar un
// faltante como "crítico" en auditoría. Faltantes menores a un peso son
// aritmética de float64, no plata real que falta.
const closureAuditToleranceCOP = 1.0

func (h *DashboardHandler) triggerPostClosureBackup(cl models.CashierClosure) {
	host := os.Getenv("DB_HOST")
	port := os.Getenv("DB_PORT")
	user := os.Getenv("DB_USER")
	dbname := os.Getenv("DB_NAME")
	pass := os.Getenv("DB_PASSWORD")

	if host == "" {
		host = "localhost"
	}
	if port == "" {
		port = "5432"
	}
	if user == "" {
		user = "postgres"
	}
	if dbname == "" {
		dbname = "sistemapos"
	}

	pgDumpPath, _, err := dbbackup.ResolvePgDumpPath()
	if err != nil {
		log.Printf("❌ [PostClosureBackup] Error resolviendo pg_dump: %v", err)
		return
	}

	timeStr := time.Now().Format("2006-01-02_15-04")
	filename := fmt.Sprintf("backup_pos_cierre_%d_%s.sql", cl.ID, timeStr)
	backupPath := filepath.Join(os.TempDir(), filename)

	args := []string{"-h", host, "-p", port, "-U", user, "-d", dbname, "-F", "p", "-f", backupPath}
	cmd := exec.Command(pgDumpPath, args...)
	cmd.Env = append(os.Environ(), "PGPASSWORD="+pass)

	log.Printf("🛠️ [PostClosureBackup] Generando respaldo tras Cierre #%d: %s %v", cl.ID, pgDumpPath, args)
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("❌ [PostClosureBackup] Error ejecutando pg_dump: %v. Salida: %s", err, string(output))
		return
	}

	// 1. Guardar copia en el Escritorio para fácil acceso del usuario
	desktopDir := `C:\Users\jaide\OneDrive\Desktop`
	if _, errStat := os.Stat(desktopDir); os.IsNotExist(errStat) {
		desktopDir = `C:\Users\jaide\Desktop`
	}
	desktopBackupPath := filepath.Join(desktopDir, filename)
	if data, errRead := os.ReadFile(backupPath); errRead == nil {
		_ = os.WriteFile(desktopBackupPath, data, 0644)
		log.Printf("💾 [PostClosureBackup] Copia de respaldo guardada en Escritorio: %s", desktopBackupPath)
	}

	// 2. Enviar por Telegram
	file, errOpen := os.Open(backupPath)
	if errOpen != nil {
		log.Printf("❌ [PostClosureBackup] Error abriendo archivo de respaldo: %v", errOpen)
		return
	}
	defer file.Close()
	defer os.Remove(backupPath)

	caption := fmt.Sprintf("💾 *RESPALDO AUTOMÁTICO POST-CIERRE #%d*\n👤 Cajero: `%s` (%s)\n📅 Fecha Cierre: `%s`\n✅ _Base de datos limpia con caja cerrada y sin turnos pendientes_",
		cl.ID, cl.ClosedByName, cl.ClosedByDNI, time.Now().Format("02/01/2006 15:04"))

	if h.telegramService != nil {
		_ = h.telegramService.SendDocument(file, filename, caption)
		log.Printf("🚀 [PostClosureBackup] Respaldo enviado exitosamente a Telegram.")
	}
}

func (h *DashboardHandler) AdjustInitialBalance(c *gin.Context) {
	var body struct {
		Cash      float64 `json:"cash"`
		Nequi     float64 `json:"nequi"`
		Daviplata float64 `json:"daviplata"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato inválido", err)
		return
	}

	dniStr, nameStr := GetContextUser(c)
	err := h.service.AdjustInitialBalance(body.Cash, body.Nequi, body.Daviplata, nameStr, dniStr)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al ajustar saldo inicial", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Saldo inicial ajustado correctamente"})

	// AVISO GLOBAL: Ajuste de saldo base de caja
	go sse.GetSSEService().BroadcastDashboardUpdate()
}

func (h *DashboardHandler) SendPartialReport(c *gin.Context) {
	// FIX P1 (SendPartialReport confiable, 2026-10-04): antes el handler
	// aceptaba un `models.CashierClosure` crudo del body y lo pasaba
	// directo a Telegram y PDF. Un cajero podía inventar las cifras del
	// reporte parcial. Ahora reconstruimos el cierre a partir del
	// servicio (datos trusted) y aceptamos sólo campos del conteo en
	// curso (physical cash y desglose JSON).
	type partialBody struct {
		PhysicalCash  float64 `json:"physicalCash"`
		CashBills     float64 `json:"cashBills"`
		Coins100      float64 `json:"coins100"`
		Coins200      float64 `json:"coins200"`
		Coins500      float64 `json:"coins500"`
		Coins1000     float64 `json:"coins1000"`
		CashBreakdown string  `json:"cashBreakdown"`
		Note          string  `json:"note"`
	}
	var body partialBody
	// Payload opcional: si el cliente no envía nada, el reporte usa 0 en
	// efectivo contado (lo cual es información útil: "aún no se cuenta").
	_ = c.ShouldBindJSON(&body)

	trusted, err := h.service.GetCashierClosure()
	if err != nil || trusted == nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudo obtener el turno activo para el reporte parcial", err)
		return
	}

	dniStr, nameStr := GetContextUser(c)

	loc := bogotaLocation()

	// Reconstruir un models.CashierClosure a partir de los datos trusted
	// del servicio + el conteo físico opcional del cuerpo.
	closure := models.CashierClosure{
		Date:                 time.Now().In(loc),
		StartDate:            trusted.StartDate,
		EndDate:              time.Now().In(loc),
		SalesCount:           trusted.SalesCount,
		TotalSales:           trusted.TotalSales,
		TotalCash:            trusted.TotalCash,
		TotalTransfer:        trusted.TotalTransfer,
		TotalCard:            trusted.TotalCard,
		TotalNequi:           trusted.TotalNequi,
		TotalDaviplata:       trusted.TotalDaviplata,
		TotalBancolombia:     trusted.TotalBancolombia,
		TotalOtherTransfer:   trusted.TotalOtherTransfer,
		TotalReturns:         trusted.TotalReturns,
		ReturnsCount:         trusted.ReturnsCount,
		TotalCreditIssued:    trusted.TotalCreditIssued,
		TotalCreditCollected: trusted.TotalCreditCollected,
		OpeningCash:          trusted.OpeningCash,
		OpeningNequi:         trusted.OpeningNequi,
		OpeningDaviplata:     trusted.OpeningDaviplata,
		NetBalance:           trusted.NetBalance,
		ExpectedCash:         trusted.ExpectedCash,
		ClosedByDNI:          dniStr,
		ClosedByName:         nameStr,
		PhysicalCash:         body.PhysicalCash,
		CashBills:            body.CashBills,
		Coins100:             body.Coins100,
		Coins200:             body.Coins200,
		Coins500:             body.Coins500,
		Coins1000:            body.Coins1000,
		CashBreakdown:        body.CashBreakdown,
		Expenses:             trusted.Expenses,
		CreditPayments:       trusted.CreditPayments,
		CreditsIssued:        trusted.CreditsIssued,
	}
	// Recalcular arqueo con la fuente única: nunca aceptar `difference`
	// del cuerpo. ComputeClosureMetrics ya consume CashBreakdown vía
	// resolvePhysicalCash (que es tolerante a strings vacíos), así que
	// no necesitamos duplicar la lógica aquí.
	metrics := services.ComputeClosureMetrics(&closure)
	closure.PhysicalCash = metrics.PhysicalCash
	closure.ExpectedCash = closure.OpeningCash + closure.TotalCash - metrics.EgresosCaja - closure.TotalReturns
	closure.Difference = metrics.PhysicalCash - closure.ExpectedCash

	// Nota del cajero: viaja al PDF/Telegram vía SalariesDetail (campo
	// text libre que ya existía). Es trazabilidad, no cuenta en el arqueo.
	if strings.TrimSpace(body.Note) != "" {
		closure.SalariesDetail = strings.TrimSpace(body.Note)
	}

	// Telegram Alert (Partial)
	tgMsg := h.formatTelegramClosureMessage(closure, true)
	tgMsg = "⏳ *CIFRAS DEL SERVIDOR (REPORTE PARCIAL)* ⏳\n" + tgMsg
	h.telegramService.SendMarkdownAlert(tgMsg)

	// PDF Alert (Partial)
	pdfBuf := h.generateClosurePDF(closure, true)
	filename := fmt.Sprintf("PARCIAL_%s_%s.pdf", time.Now().Format("20060102"), closure.ClosedByDNI)
	h.telegramService.SendDocument(pdfBuf, filename, "⏳ Reporte Parcial de Caja (PDF)")

	c.JSON(http.StatusOK, gin.H{"message": "Reporte parcial enviado a Telegram"})
}

func parseCurrencyHelper(s string) float64 {
	var numStr strings.Builder
	for _, r := range s {
		if (r >= '0' && r <= '9') || r == '.' || r == ',' {
			numStr.WriteRune(r)
		}
	}
	raw := numStr.String()
	if raw == "" {
		return 0
	}
	if strings.Contains(raw, ",") && strings.Contains(raw, ".") {
		raw = strings.ReplaceAll(raw, ".", "")
		raw = strings.ReplaceAll(raw, ",", ".")
	} else if strings.Count(raw, ".") > 1 {
		raw = strings.ReplaceAll(raw, ".", "")
	} else if strings.Contains(raw, ".") {
		parts := strings.Split(raw, ".")
		if len(parts) == 2 && len(parts[1]) == 3 {
			raw = strings.ReplaceAll(raw, ".", "")
		}
	}
	val, _ := strconv.ParseFloat(raw, 64)
	return val
}

func normalizeExpensesForReport(expenses []models.Expense) {
	for i := range expenses {
		e := &expenses[i]
		if e.Status == "PENDING" {
			e.CashAmount = 0
			e.NequiAmount = 0
			e.DaviplataAmount = 0
			e.FondoAmount = 0
			continue
		}

		src := strings.ToUpper(strings.TrimSpace(e.PaymentSource))
		tax := e.TaxAmount
		base := e.Amount
		total := base + tax

		rawCash := e.CashAmount
		rawNequi := e.NequiAmount
		rawDavi := e.DaviplataAmount
		rawFondo := e.FondoAmount
		sumChannels := rawCash + rawNequi + rawDavi + rawFondo

		finalCash := 0.0
		finalNequi := 0.0
		finalDavi := 0.0
		finalFondo := 0.0

		if strings.Contains(src, "/") {
			for _, part := range strings.Split(src, "/") {
				p := strings.TrimSpace(part)
				val := parseCurrencyHelper(p)
				if strings.Contains(p, "NEQUI") || strings.Contains(p, "NEQ") {
					finalNequi += val
				} else if strings.Contains(p, "DAVIPLATA") || strings.Contains(p, "DAVI") {
					finalDavi += val
				} else if strings.Contains(p, "FONDO") || strings.Contains(p, "BOVEDA") || strings.Contains(p, "BÓVEDA") || strings.Contains(p, "FOND") {
					finalFondo += val
				} else if strings.Contains(p, "CAJA") || strings.Contains(p, "EFECTIVO") || strings.Contains(p, "CASH") || strings.Contains(p, "EFEC") {
					finalCash += val
				}
			}
			if finalCash+finalNequi+finalDavi+finalFondo == 0 {
				finalCash = total
			}
		} else if sumChannels > 0 {
			finalCash = rawCash
			finalNequi = rawNequi
			finalDavi = rawDavi
			finalFondo = rawFondo
			if tax > 0 && sumChannels == base {
				if rawCash > 0 && rawNequi == 0 && rawDavi == 0 && rawFondo == 0 {
					finalCash += tax
				} else if rawNequi > 0 && rawCash == 0 && rawDavi == 0 && rawFondo == 0 {
					finalNequi += tax
				} else if rawDavi > 0 && rawCash == 0 && rawNequi == 0 && rawFondo == 0 {
					finalDavi += tax
				} else if rawFondo > 0 && rawCash == 0 && rawNequi == 0 && rawDavi == 0 {
					finalFondo += tax
				} else {
					if rawNequi > 0 {
						finalNequi += tax
					} else if rawDavi > 0 {
						finalDavi += tax
					} else {
						finalCash += tax
					}
				}
			}
		} else if src == "NEQUI" {
			finalNequi = total
		} else if src == "DAVIPLATA" || src == "DAVI" {
			finalDavi = total
		} else if src == "FONDO" || src == "BOVEDA" || src == "BÓVEDA" {
			finalFondo = total
		} else if src == "PREST." || src == "DEUDA" || src == "PRESTAMO" {
			// Debt -> 0
		} else {
			finalCash = total
		}

		e.CashAmount = finalCash
		e.NequiAmount = finalNequi
		e.DaviplataAmount = finalDavi
		e.FondoAmount = finalFondo
	}
}

func (h *DashboardHandler) formatTelegramClosureMessage(closure models.CashierClosure, isPartial bool) string {
	return FormatTelegramClosureMessage(closure, isPartial)
}

func FormatTelegramClosureMessage(closure models.CashierClosure, isPartial bool) string {
	title := "🧾 *REPORTE DE CIERRE PROFESIONAL*"
	if isPartial {
		title = "⏳ *REPORTE DE AVANCE (PARCIAL)*"
	}

	// 1. FUENTE ÚNICA DEL ARQUEO
	// Antes esta función tenía su propia matemática: leía PhysicalCash crudo,
	// sumaba e.CashAmount a mano, omitía la base de apertura y forzaba el
	// esperado a $0 cuando salía negativo. Por eso el mensaje de Telegram no
	// coincidía con el modal ni con el reporte.
	if len(closure.Expenses) == 0 && closure.ExpensesDetail != "" {
		json.Unmarshal([]byte(closure.ExpensesDetail), &closure.Expenses)
	}
	normalizeExpensesForReport(closure.Expenses)

	m := services.ComputeClosureMetrics(&closure)
	efectivoContado := m.PhysicalCash
	ingresosDigitales := m.DigitalIncome
	egresosEfectivoTurno := m.EgresosCaja
	ventasTotalesCajero := m.VentasCajero

	ventasTotalesSistema := closure.TotalSales
	if ventasTotalesSistema == 0 {
		ventasTotalesSistema = closure.TotalCash + ingresosDigitales
	}

	// Sin piso a cero: si los egresos superan lo que entró, el esperado es
	// negativo y el sobrante real es la resta completa.
	expectedCash := closure.OpeningCash + closure.TotalCash - egresosEfectivoTurno - closure.TotalReturns
	diferenciaFisica := efectivoContado - expectedCash

	// Variables auxiliares para la vista
	diferenciaFisicaAbs := diferenciaFisica
	if diferenciaFisicaAbs < 0 {
		diferenciaFisicaAbs = -diferenciaFisicaAbs
	}
	diferenciaIcon := "🟢 SOBRANTE"
	if diferenciaFisica < 0 {
		diferenciaIcon = "🔴 FALTANTE"
	} else if diferenciaFisica == 0 {
		diferenciaIcon = "⚪ CUADRADO"
	}

	loc := time.FixedZone("America/Bogota", -5*60*60)

	// 2. CONSTRUCCIÓN DE PLANTILLA
	var msg strings.Builder

	msg.WriteString(fmt.Sprintf("%s\n", title))
	msg.WriteString("━━━━━━━━━━━━━━━━━━━━\n")
	msg.WriteString(fmt.Sprintf("👤 *CAJERO:* %s\n", closure.ClosedByName))
	msg.WriteString(fmt.Sprintf("📅 *INICIO:* `%s`\n", closure.StartDate.In(loc).Format("02/01/2006 15:04")))
	msg.WriteString(fmt.Sprintf("🏁 *FIN:*    `%s`\n", closure.EndDate.In(loc).Format("02/01/2006 15:04")))
	msg.WriteString("━━━━━━━━━━━━━━━━━━━━\n\n")

	msg.WriteString("🧮 *VENTA TOTAL DEL CAJERO (RECAUDO REAL)*\n")
	msg.WriteString(fmt.Sprintf("💰 *TOTAL RECAUDADO:* `$%s`\n", formatCOP(ventasTotalesCajero)))
	msg.WriteString(fmt.Sprintf("📋 _(Efectivo Contado $%s + Digital $%s + Egresos Caja $%s)_\n\n", formatCOP(efectivoContado), formatCOP(ingresosDigitales), formatCOP(egresosEfectivoTurno)))

	msg.WriteString("📊 *VENTAS REGISTRADAS EN EL POS (SISTEMA)*\n")
	msg.WriteString(fmt.Sprintf("▫️ Total Sistema: `$%s`\n", formatCOP(ventasTotalesSistema)))
	msg.WriteString(fmt.Sprintf("▫️ Efectivo POS: `$%s` | Digital: `$%s`\n\n", formatCOP(closure.TotalCash), formatCOP(ingresosDigitales)))

	msg.WriteString("💵 *1. RESUMEN DE CAJA (ARQUEO FÍSICO)*\n")
	msg.WriteString(fmt.Sprintf("▫️ Entradas Efectivo: `$%s`\n", formatCOP(closure.TotalCash)))
	msg.WriteString(fmt.Sprintf("▫️ Egresos de Caja:   `-$%s`\n", formatCOP(egresosEfectivoTurno)))
	if closure.TotalReturns > 0 {
		msg.WriteString(fmt.Sprintf("▫️ Devoluciones:      `-$%s`\n", formatCOP(closure.TotalReturns)))
	}
	msg.WriteString(fmt.Sprintf("▫️ Efectivo Esperado: `$%s`\n", formatCOP(expectedCash)))
	msg.WriteString(fmt.Sprintf("▫️ Efectivo Contado:  `$%s`\n", formatCOP(efectivoContado)))
	msg.WriteString("────────────────────\n")
	msg.WriteString(fmt.Sprintf("🚨 *DIFERENCIA FÍSICA:* %s `$%s`\n\n", diferenciaIcon, formatCOP(diferenciaFisicaAbs)))

	// Desglose de billetes y monedas reportado por el cajero
	totalBillsAmount := closure.CashBills
	c1000 := closure.Coins1000
	c500 := closure.Coins500
	c200 := closure.Coins200
	c100 := closure.Coins100

	if closure.CashBreakdown != "" {
		var bd struct {
			Bills map[string]string `json:"bills"`
			Coins map[string]string `json:"coins"`
		}
		if err := json.Unmarshal([]byte(closure.CashBreakdown), &bd); err == nil {
			if len(bd.Bills) > 0 {
				sumB := 0.0
				for valStr, qtyStr := range bd.Bills {
					val, _ := strconv.ParseFloat(valStr, 64)
					qty, _ := strconv.ParseFloat(qtyStr, 64)
					sumB += val * qty
				}
				if sumB > 0 {
					totalBillsAmount = sumB
				}
			}
			if len(bd.Coins) > 0 {
				if v, ok := bd.Coins["500/1000"]; ok {
					if val, err := strconv.ParseFloat(v, 64); err == nil && val > 0 {
						c1000 = val
					}
				}
				if v, ok := bd.Coins["200"]; ok {
					if val, err := strconv.ParseFloat(v, 64); err == nil && val > 0 {
						c200 = val
					}
				}
				if v, ok := bd.Coins["100"]; ok {
					if val, err := strconv.ParseFloat(v, 64); err == nil && val > 0 {
						c100 = val
					}
				}
			}
		}
	}

	msg.WriteString("🧩 *DESGLOSE DE EFECTIVO REPORTADO*\n")
	if totalBillsAmount > 0 || closure.CashBills > 0 {
		if totalBillsAmount == 0 {
			totalBillsAmount = closure.CashBills
		}
		msg.WriteString(fmt.Sprintf("▫️ Billetes:            `$%s`\n", formatCOP(totalBillsAmount)))
	}
	if c1000 > 0 {
		msg.WriteString(fmt.Sprintf("▫️ Monedas 500 / 1000:   `$%s`\n", formatCOP(c1000)))
	}
	if c500 > 0 {
		msg.WriteString(fmt.Sprintf("▫️ Monedas 500:          `$%s`\n", formatCOP(c500)))
	}
	if c200 > 0 {
		msg.WriteString(fmt.Sprintf("▫️ Monedas 200:          `$%s`\n", formatCOP(c200)))
	}
	if c100 > 0 {
		msg.WriteString(fmt.Sprintf("▫️ Monedas 100:          `$%s`\n", formatCOP(c100)))
	}
	msg.WriteString("────────────────────\n")
	msg.WriteString(fmt.Sprintf("💵 *TOTAL CONTEO:*       `$%s`\n\n", formatCOP(efectivoContado)))

	msg.WriteString("📱 *2. MEDIOS DIGITALES Y OTROS*\n")
	msg.WriteString(fmt.Sprintf("▫️ Nequi:      `$%s`\n", formatCOP(closure.TotalNequi)))
	msg.WriteString(fmt.Sprintf("▫️ Daviplata:  `$%s`\n", formatCOP(closure.TotalDaviplata)))
	msg.WriteString(fmt.Sprintf("▫️ Tarjeta:    `$%s`\n", formatCOP(closure.TotalCard)))
	if closure.TotalBancolombia+closure.TotalOtherTransfer > 0 {
		msg.WriteString(fmt.Sprintf("▫️ Otros:      `$%s`\n", formatCOP(closure.TotalBancolombia+closure.TotalOtherTransfer)))
	}
	msg.WriteString("────────────────────\n")
	msg.WriteString(fmt.Sprintf("📲 *TOTAL DIGITAL:*  `$%s`\n\n", formatCOP(ingresosDigitales)))

	msg.WriteString("💸 *3. EGRESOS DETALLADOS POR CANAL*\n")

	// 3. CONTROL DE EGRESOS POR CANAL
	type splitExpense struct {
		Desc   string
		Amount float64
	}
	egresosAgrupados := make(map[string][]splitExpense)

	totalEfectivo := 0.0
	totalFondo := 0.0

	for _, e := range closure.Expenses {
		if e.CashAmount > 0 {
			egresosAgrupados["EFECTIVO"] = append(egresosAgrupados["EFECTIVO"], splitExpense{Desc: e.Description, Amount: e.CashAmount})
			totalEfectivo += e.CashAmount
		}
		if e.NequiAmount > 0 {
			egresosAgrupados["NEQUI"] = append(egresosAgrupados["NEQUI"], splitExpense{Desc: e.Description, Amount: e.NequiAmount})
		}
		if e.DaviplataAmount > 0 {
			egresosAgrupados["DAVIPLATA"] = append(egresosAgrupados["DAVIPLATA"], splitExpense{Desc: e.Description, Amount: e.DaviplataAmount})
		}
		if e.FondoAmount > 0 {
			egresosAgrupados["FONDO"] = append(egresosAgrupados["FONDO"], splitExpense{Desc: e.Description, Amount: e.FondoAmount})
			totalFondo += e.FondoAmount
		}
		if e.CoinsAmount > 0 {
			egresosAgrupados["ALCANCIA"] = append(egresosAgrupados["ALCANCIA"], splitExpense{Desc: e.Description, Amount: e.CoinsAmount})
		}
	}

	canalesOrder := []string{"EFECTIVO", "NEQUI", "DAVIPLATA", "FONDO", "ALCANCIA"}
	for k := range egresosAgrupados {
		found := false
		for _, c := range canalesOrder {
			if c == k {
				found = true
				break
			}
		}
		if !found {
			canalesOrder = append(canalesOrder, k)
		}
	}

	hayEgresos := false
	for _, canal := range canalesOrder {
		egresosCanal := egresosAgrupados[canal]
		if len(egresosCanal) > 0 {
			hayEgresos = true
			totalCanal := 0.0
			for _, e := range egresosCanal {
				totalCanal += e.Amount
			}
			msg.WriteString(fmt.Sprintf("📍 *%s:* `$%s`\n", canal, formatCOP(totalCanal)))
			for _, e := range egresosCanal {
				msg.WriteString(fmt.Sprintf("   • %s: `$%s`\n", e.Desc, formatCOP(e.Amount)))
			}
		}
	}
	if !hayEgresos {
		msg.WriteString("_Sin egresos registrados._\n")
	}

	msg.WriteString("────────────────────\n")
	msg.WriteString(fmt.Sprintf("▫️ Total gastado de la Venta del día (Efectivo): `$%s`\n", formatCOP(totalEfectivo)))
	msg.WriteString(fmt.Sprintf("▫️ Total gastado del Fondo (Plata de adentro): `$%s`\n", formatCOP(totalFondo)))
	msg.WriteString("\n")

	msg.WriteString("🤝 *4. CRÉDITOS Y ABONOS*\n")
	totalFiados := 0.0
	for _, s := range closure.CreditsIssued {
		totalFiados += s.CreditAmount
	}
	totalAbonos := 0.0
	for _, p := range closure.CreditPayments {
		totalAbonos += p.TotalPaid
	}

	msg.WriteString(fmt.Sprintf("📍 *FIADOS ENTREGADOS:* `$%s`\n", formatCOP(totalFiados)))
	if len(closure.CreditsIssued) > 0 {
		for _, s := range closure.CreditsIssued {
			name := s.Client.Name
			if name == "" {
				name = s.ClientDNI
			}
			msg.WriteString(fmt.Sprintf("   • %s: `$%s` (Saldo actual: `$%s`)\n", name, formatCOP(s.CreditAmount), formatCOP(s.Client.CurrentCredit)))
		}
	} else {
		msg.WriteString("   _Sin fiados emitidos._\n")
	}

	msg.WriteString(fmt.Sprintf("📍 *ABONOS RECIBIDOS:* `$%s`\n", formatCOP(totalAbonos)))
	if len(closure.CreditPayments) > 0 {
		for _, p := range closure.CreditPayments {
			name := p.Client.Name
			if name == "" {
				name = p.ClientDNI
			}
			msg.WriteString(fmt.Sprintf("   • %s: `$%s` (Saldo actual: `$%s`)\n", name, formatCOP(p.TotalPaid), formatCOP(p.Client.CurrentCredit)))
		}
	} else {
		msg.WriteString("   _Sin abonos recibidos._\n")
	}
	msg.WriteString("\n")

	authName := closure.AuthorizedBy
	if authName == "" {
		authName = closure.ClosedByName
	}
	msg.WriteString(fmt.Sprintf("🚨 *VERIFICADO POR:* %s 🚨\n", authName))
	msg.WriteString("━━━━━━━━━━━━━━━━━━━━\n")
	msg.WriteString("_Generado por POS Pro_")

	return msg.String()
}

func (h *DashboardHandler) GetClosuresHistory(c *gin.Context) {
	data, err := h.service.GetClosuresHistory()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener historial de cierres", err)
		return
	}
	if data == nil {
		data = []models.CashierClosure{}
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) DeleteClosure(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "ID de cierre inválido", err)
		return
	}

	err = h.service.DeleteClosure(uint(id))
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al eliminar cierre de caja", err)
		return
	}

	// Auditoría Forense: Eliminación de cierre es SIEMPRE crítica
	dniStr, nameStr := GetContextUser(c)

	details := fmt.Sprintf("Cierre de caja ID #%d ELIMINADO permanentemente por %s", id, nameStr)
	human := fmt.Sprintf("El administrador %s eliminó el cierre de caja #%d del sistema. Este registro fue borrado permanentemente.", nameStr, id)
	changes := fmt.Sprintf(`{"deletedClosureId": %d, "deletedBy": "%s"}`, id, nameStr)

	h.auditService.Log(dniStr, nameStr, "CLOSURE_DELETE", "SALES", details, human, changes, c.ClientIP(), c.Request.UserAgent(), true)

	log.Printf("🗑️ [DeleteClosure] Admin %s (%s) eliminó cierre ID #%d", nameStr, dniStr, id)

	c.JSON(http.StatusOK, gin.H{
		"message": fmt.Sprintf("Cierre #%d eliminado correctamente", id),
	})

	// AVISO GLOBAL: Cierre eliminado (Actualiza historial)
	go sse.GetSSEService().BroadcastDashboardUpdate()
}

// bogotaLocation devuelve la zona America/Bogota con fallback a FixedZone.
// Centraliza la zona del negocio para que ningún parseo caiga en
// time.Local (hora del PC Windows): el servidor puede estar en UTC o en
// otra zona, y entonces un "2026-09-15T22:00" se interpretaría mal.
// Fix P2 (zona Bogotá consistente, 2026-10-04).
func bogotaLocation() *time.Location {
	if loc, err := time.LoadLocation("America/Bogota"); err == nil {
		return loc
	}
	return time.FixedZone("America/Bogota", -5*60*60)
}

// updateClosureAllowedKeys es la allowlist estricta de campos editables
// vía PUT /dashboard/cashier-history/:id. Cualquier otra clave en el
// body se rechaza con 400 para que no viajen cambios silenciosos a
// columnas sensibles (closed_by_dni, created_at, deleted_at, id,
// client_tx_id, totales calculados por el servidor…).
var updateClosureAllowedKeys = map[string]struct{}{
	"start_date":         {},
	"end_date":           {},
	"date":               {},
	"physical_cash":      {},
	"coins100":           {},
	"coins200":           {},
	"coins500":           {},
	"coins1000":          {},
	"cash_bills":         {},
	"cash_breakdown":     {},
	"authorized_by":      {},
	"total_expenses":     {},
	"total_returns":      {},
	"expenses_detail":    {},
	"forgotten_expenses": {},
}

func (h *DashboardHandler) UpdateClosure(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "ID de cierre inválido", err)
		return
	}

	// Deserializar primero a map[string]json.RawMessage para poder validar
	// las claves presentes. Fix P1 (DTO/allowlist, 2026-10-04): antes el
	// handler aceptaba cualquier mapa y lo pasaba a GORM Updates(). Un
	// cliente malicioso podía renombrar `closed_by_dni` o resucitar un
	// cierre con `deleted_at: null`. Ahora las claves fuera de la
	// allowlist devuelven 400.
	var raw map[string]json.RawMessage
	if err := c.ShouldBindJSON(&raw); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Cuerpo inválido", err)
		return
	}
	for key := range raw {
		if _, ok := updateClosureAllowedKeys[key]; !ok {
			SendError(c, http.StatusBadRequest, ErrBadRequest, "Campo no editable: "+key, nil)
			return
		}
	}

	// Desempaquetar valores concretos a `updates` para el servicio.
	updates := make(map[string]interface{}, len(raw))
	bogota := bogotaLocation()

	// Fechas en zona Bogotá (fix P2). El frontend envía
	// "2006-01-02T15:04" (datetime-local sin zona).
	parseLocalDateTime := func(key string, value json.RawMessage) {
		var s string
		if err := json.Unmarshal(value, &s); err != nil || strings.TrimSpace(s) == "" {
			return
		}
		if parsed, perr := time.ParseInLocation("2006-01-02T15:04", s, bogota); perr == nil {
			updates[key] = parsed
		}
	}
	if v, ok := raw["start_date"]; ok {
		parseLocalDateTime("start_date", v)
	}
	if v, ok := raw["end_date"]; ok {
		parseLocalDateTime("end_date", v)
	}
	if v, ok := raw["date"]; ok {
		var s string
		if err := json.Unmarshal(v, &s); err == nil && strings.TrimSpace(s) != "" {
			if parsed, perr := time.ParseInLocation("2006-01-02", s, bogota); perr == nil {
				now := time.Now().In(bogota)
				updates["date"] = time.Date(parsed.Year(), parsed.Month(), parsed.Day(),
					now.Hour(), now.Minute(), now.Second(), 0, bogota)
			} else if parsed, perr := time.ParseInLocation("2006-01-02T15:04", s, bogota); perr == nil {
				updates["date"] = parsed
			}
		}
	}

	// Campos numéricos y texto: pasarlos tal cual al servicio. Si el
	// cliente envía un número como string lo normalizamos.
	numericKeys := []string{"physical_cash", "coins100", "coins200", "coins500", "coins1000", "cash_bills", "total_expenses", "total_returns"}
	for _, key := range numericKeys {
		v, ok := raw[key]
		if !ok {
			continue
		}
		var num float64
		if err := json.Unmarshal(v, &num); err == nil {
			updates[key] = num
			continue
		}
		var s string
		if err := json.Unmarshal(v, &s); err == nil {
			clean := strings.ReplaceAll(strings.TrimSpace(s), ".", "")
			clean = strings.ReplaceAll(clean, ",", ".")
			if parsed, perr := strconv.ParseFloat(clean, 64); perr == nil {
				updates[key] = parsed
			}
		}
	}
	// Campos de texto literal.
	for _, key := range []string{"authorized_by", "cash_breakdown", "expenses_detail"} {
		v, ok := raw[key]
		if !ok {
			continue
		}
		var s string
		if err := json.Unmarshal(v, &s); err == nil {
			updates[key] = s
		}
	}
	// forgotten_expenses se pasa como arreglo opaco al servicio para que
	// lo deserialice con el modelo correcto.
	if v, ok := raw["forgotten_expenses"]; ok {
		var exps []models.Expense
		if err := json.Unmarshal(v, &exps); err == nil {
			updates["forgotten_expenses"] = exps
		}
	}

	// ─── P1: autorizador — regla "preservar si no viene nuevo" ──────────────
	// El frontend sobre-escribía authorized_by en cada edición con el
	// nombre del admin que ingresaba al modal. Si un cierre se editaba
	// dos veces, perdíamos el nombre del admin original. Ahora el
	// servicio preserva el valor existente cuando el DTO no trae
	// `authorized_by`. Como ya corrimos la allowlist, aquí basta con no
	// forzar el campo.

	// Normalización canónica de egresos (misma que ya existía antes).
	// NO calcula arqueo acá: lo recalcula el servicio dentro de la
	// transacción con fechas efectivas.
	if closureObj, err := h.service.GetClosureByID(uint(id)); err == nil && closureObj != nil {
		if len(closureObj.Expenses) > 0 {
			normalizeExpensesForReport(closureObj.Expenses)
			expBytes, _ := json.Marshal(closureObj.Expenses)
			// Si el cliente ya mandó expenses_detail, no lo pisamos: el
			// servicio terminará rearmando el detail con los egresos
			// recalculados dentro de la transacción.
			if _, provided := updates["expenses_detail"]; !provided {
				updates["expenses_detail"] = string(expBytes)
			}
		}
	}

	err = h.service.UpdateClosure(uint(id), updates)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al actualizar cierre", err)
		return
	}

	// Re-enviar a Telegram tras editar el cierre.
	if updatedClosure, err := h.service.GetClosureByID(uint(id)); err == nil && updatedClosure != nil {
		tgMsg := h.formatTelegramClosureMessage(*updatedClosure, false)
		tgMsg = "⚠️ *REPORTE EDITADO MANUALMENTE* ⚠️\n" + tgMsg
		h.telegramService.SendMarkdownAlert(tgMsg)
	} else {
		log.Printf("⚠️ No se pudo obtener el cierre %d para reenviar reporte de Telegram: %v", id, err)
	}

	// Auditoría Forense: edición de cierre es siempre crítica.
	dniStr, nameStr := GetContextUser(c)
	details := fmt.Sprintf("Cierre de caja ID #%d EDITADO por %s", id, nameStr)
	human := fmt.Sprintf("El administrador %s editó el cierre de caja #%d.", nameStr, id)
	updatesJSON, _ := json.Marshal(updates)
	changes := fmt.Sprintf(`{"updatedClosureId": %d, "updatedBy": "%s", "changes": %s}`, id, nameStr, string(updatesJSON))

	h.auditService.Log(dniStr, nameStr, "CLOSURE_UPDATE", "SALES", details, human, changes, c.ClientIP(), c.Request.UserAgent(), true)

	c.JSON(http.StatusOK, gin.H{
		"message": fmt.Sprintf("Cierre #%d actualizado correctamente", id),
	})

	go sse.GetSSEService().BroadcastDashboardUpdate()
}

func (h *DashboardHandler) GetDetailedReport(c *gin.Context) {
	employeeDni := c.Query("employeeDni")
	data, err := h.service.GetDetailedShiftReport(employeeDni)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al generar reporte detallado", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) GetVaultAudit(c *gin.Context) {
	data, err := h.service.GetVaultAudit()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener arqueo de bóveda", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) GetGlobalDebt(c *gin.Context) {
	debt, err := h.service.GetGlobalDebt()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener cartera global", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"totalDebt": debt})
}

func (h *DashboardHandler) generateClosurePDF(closure models.CashierClosure, isPartial bool) *bytes.Buffer {
	return GenerateClosurePDF(closure, isPartial)
}

func GenerateClosurePDF(closure models.CashierClosure, isPartial bool) *bytes.Buffer {
	if len(closure.Expenses) == 0 && closure.ExpensesDetail != "" {
		var snapshotExps []models.Expense
		if err := json.Unmarshal([]byte(closure.ExpensesDetail), &snapshotExps); err == nil && len(snapshotExps) > 0 {
			closure.Expenses = snapshotExps
		}
	}
	normalizeExpensesForReport(closure.Expenses)

	pdf := gofpdf.New("P", "mm", "A4", "")
	tr := pdf.UnicodeTranslatorFromDescriptor("")
	loc := time.FixedZone("America/Bogota", -5*60*60)

	subTitle := "AUDITORÍA OFICIAL DE CIERRE DE CAJA"
	if isPartial {
		subTitle = "REPORTE PARCIAL DE CAJA (CORTE)"
	}

	printData := services.ClosurePrintData{
		Title:                "SUPERMERCADO SURTIFAMILIAR",
		SubTitle:             subTitle,
		Cajero:               closure.ClosedByName,
		IDStr:                fmt.Sprintf("CC-%d", closure.ID),
		RangoFechaStr:        "TURNO:",
		TurnoStr:             fmt.Sprintf("%s a %s", closure.StartDate.In(loc).Format("02/01/06 15:04"), closure.EndDate.In(loc).Format("02/01/06 15:04")),
		PhysicalCash:         closure.PhysicalCash,
		TotalSales:           closure.TotalSales,
		TotalCreditCollected: closure.TotalCreditCollected,
		TotalNequi:           closure.TotalNequi,
		TotalDaviplata:       closure.TotalDaviplata,
		TotalCard:            closure.TotalCard,
		TotalBancolombia:     closure.TotalBancolombia,
		TotalOtherTransfer:   closure.TotalOtherTransfer,
		TotalCash:            closure.TotalCash,
		TotalExpenses:        closure.TotalExpenses,
		TotalReturns:         closure.TotalReturns,
		ExpectedCash:         closure.ExpectedCash,
		CashBills:            closure.CashBills,
		Coins1000:            closure.Coins1000,
		Coins500:             closure.Coins500,
		Coins200:             closure.Coins200,
		Coins100:             closure.Coins100,
		Expenses:             closure.Expenses,
		Payments:             closure.CreditPayments,
	}

	services.RenderClosurePDFData(pdf, tr, loc, printData)

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		log.Printf("[GenerateClosurePDF] Error generating pdf: %v", err)
		return nil
	}
	return &buf
}
