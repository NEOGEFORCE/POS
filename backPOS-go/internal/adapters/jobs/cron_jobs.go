package jobs

import (
	"context"
	"fmt"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"backPOS-go/internal/core/services/scheduling"
	"backPOS-go/internal/infrastructure/orchestrator"
	"backPOS-go/internal/infrastructure/refresher"
	"backPOS-go/internal/infrastructure/sse"
	"gorm.io/gorm"
)

// Claves de los jobs. Son la llave primaria en job_definitions, así que
// cambiarlas crea una definición nueva y pierde el historial de la anterior.
const (
	JobDashboardRefresh   = "dashboard_refresh"
	JobNightlyRestock     = "nightly_restock"
	JobSuggestedOrders    = "suggested_orders"
	JobPendingDeliveries  = "pending_deliveries"
	JobLogisticReport     = "logistic_report"
	JobNightlyBackup      = "nightly_backup"
	JobShelfStockCritical = "shelf_stock_critical"
)

// CronManager agrupa los jobs de negocio del POS. La programación, el
// historial, los reintentos y la recuperación de ocurrencias perdidas los
// aporta el orquestador; aquí sólo vive la lógica de cada tarea.
type CronManager struct {
	orchestrator   *orchestrator.Orchestrator
	db             *gorm.DB
	telegram       *services.TelegramService
	inventory      *services.InventoryService
	supplier       *services.SupplierService
	orders         *services.PurchaseOrderService
	expected       *services.ExpectedOrderService
	restock        *services.RestockService
	restockNightly *services.RestockNightlyService
}

func NewCronManager(
	db *gorm.DB,
	tg *services.TelegramService,
	inv *services.InventoryService,
	sup *services.SupplierService,
	ord *services.PurchaseOrderService,
	exp *services.ExpectedOrderService,
	res *services.RestockService,
	rns *services.RestockNightlyService,
) *CronManager {
	// LOCALIZACIÓN FIJA: Colombia (UTC-5) - Independiente de la configuración del servidor
	loc := time.FixedZone("America/Bogota", -5*60*60)

	return &CronManager{
		orchestrator:   orchestrator.New(db, loc),
		db:             db,
		telegram:       tg,
		inventory:      inv,
		supplier:       sup,
		orders:         ord,
		expected:       exp,
		restock:        res,
		restockNightly: rns,
	}
}

// Orchestrator expone el motor para que los handlers de administración puedan
// consultar estado e historial.
func (m *CronManager) Orchestrator() *orchestrator.Orchestrator {
	return m.orchestrator
}

// Start registra las definiciones y arranca el scheduler durable.
func (m *CronManager) Start(ctx context.Context) error {
	definitions := []struct {
		def orchestrator.Definition
		fn  orchestrator.JobFunc
	}{
		{
			def: orchestrator.Definition{
				Key:         JobDashboardRefresh,
				Description: "Refresca la vista materializada del dashboard y avisa por SSE",
				Schedule:    "@every 5m",
				Timeout:     3 * time.Minute,
				MaxAttempts: 1,
				// Sin catch-up: un refresco perdido lo cubre el siguiente.
				CatchUp: false,
			},
			fn: m.handleDashboardRefresh,
		},
		{
			def: orchestrator.Definition{
				Key:         JobNightlyRestock,
				Description: "Precálculo nocturno de métricas de Smart Restock",
				Schedule:    "0 21 * * *",
				Timeout:     25 * time.Minute,
				MaxAttempts: 2,
				CatchUp:     true,
			},
			fn: m.handleNightlyRestockCalculation,
		},
		{
			def: orchestrator.Definition{
				Key:         JobSuggestedOrders,
				Description: "Alerta de pedidos sugeridos para los proveedores que visitan hoy",
				Schedule:    "0 7 * * *",
				Timeout:     5 * time.Minute,
				MaxAttempts: 3,
				CatchUp:     true,
			},
			fn: m.handleSuggestedOrdersAlert,
		},
		{
			def: orchestrator.Definition{
				Key:         JobPendingDeliveries,
				Description: "Entregas programadas del día y efectivo requerido",
				Schedule:    "0 8 * * *",
				Timeout:     5 * time.Minute,
				MaxAttempts: 3,
				CatchUp:     true,
			},
			fn: m.handlePendingDeliveriesAlert,
		},
		{
			def: orchestrator.Definition{
				Key:         JobLogisticReport,
				Description: "Plan de entregas consolidado por proveedor",
				Schedule:    "0 7 * * *",
				Timeout:     5 * time.Minute,
				MaxAttempts: 3,
				CatchUp:     true,
			},
			fn: m.handleLogisticReportJob,
		},
		{
			def: orchestrator.Definition{
				Key:         JobNightlyBackup,
				Description: "Respaldo nocturno de PostgreSQL enviado por Telegram",
				Schedule:    "20 21 * * *",
				Timeout:     30 * time.Minute,
				MaxAttempts: 2,
				// El job más importante para recuperar: si el PC estaba
				// apagado a las 21:20, se ejecuta al encender.
				CatchUp: true,
			},
			fn: m.handleNightlyBackupJob,
		},
		{
			def: orchestrator.Definition{
				Key:         JobShelfStockCritical,
				Description: "Alerta de productos críticos en góndola",
				Schedule:    "0 7 * * *",
				Timeout:     5 * time.Minute,
				MaxAttempts: 3,
				CatchUp:     true,
			},
			fn: m.handleShelfStockCriticalAlert,
		},
	}

	for _, entry := range definitions {
		if err := m.orchestrator.Register(entry.def, entry.fn); err != nil {
			return fmt.Errorf("registrando job: %w", err)
		}
	}

	return m.orchestrator.Start(ctx)
}

func (m *CronManager) Stop(ctx context.Context) error {
	return m.orchestrator.Stop(ctx)
}

func (m *CronManager) handleDashboardRefresh(ctx context.Context) error {
	log.Println("📊 [Cron] Solicitando Refresco de Dashboard...")
	refresher.GetRefresherService(m.db).RequestRefresh("mv_dashboard_stats_monthly")

	// AVISO GLOBAL: Estadísticas pesadas actualizadas por el sistema
	go sse.GetSSEService().BroadcastDashboardUpdate()
	return nil
}

func (m *CronManager) handleSuggestedOrdersAlert(ctx context.Context) error {
	log.Println("🔄 Running Daily Suggested Orders Job...")

	loc, _ := time.LoadLocation("America/Bogota")
	// Determinar día actual. Se reusa el mapa canonico del paquete scheduling
	// para no duplicar la lista de nombres — el resto del sistema ya se
	// referia a el (WeekdayLabels con tildes: Miércoles, Sábado). Ademas
	// GetSuppliersByVisitDay ahora compara con unaccent+lower, asi que la
	// forma exacta del literal ya no manda: el proveedor guardado como
	// "Miercoles" hace match con la busqueda por "Miércoles" y viceversa.
	today := scheduling.WeekdayLabels[time.Now().In(loc).Weekday()]
	suppliers, err := m.supplier.GetSuppliersByVisitDay(today)
	if err != nil {
		return fmt.Errorf("consultando proveedores del día %s: %w", today, err)
	}

	if len(suppliers) == 0 {
		return nil
	}

	for _, s := range suppliers {
		if err := ctx.Err(); err != nil {
			return err
		}

		suggested, _ := m.inventory.GetSuggestedOrders(s.ID, false)

		var criticalItems []string
		var urgentAlerts []string

		for _, item := range suggested {
			qtyToOrder := item.TotalIdeal
			if qtyToOrder <= 0 {
				// Fallback bajo la regla nueva del dueno (agosto 2026): el
				// minimo es alarma, NO meta. Prohibido usar "MinStock -
				// Stock" (eso pide llenar hasta el 100% del minimo y encarece
				// el pedido). Se compone del piso "salir del rojo" (25% del
				// minimo) mas la demanda de una semana como respaldo, para
				// que la alerta de Telegram nunca proponga un cero raro y
				// tampoco un numero sobredimensionado.
				redFloor := models.RedFloorShortfall(item.MinStock, item.Stock, item.PendingOrderQty)
				weeklyDemand := math.Ceil(item.AvgDailySales * 7)
				qtyToOrder = math.Max(redFloor, weeklyDemand)
				if qtyToOrder <= 0 {
					qtyToOrder = 1
				}
			}

			// Escanear y destacar Alertas de Aumento de Stock Base sugeridas por la IA
			if item.AlertType == "INCREASE_MIN_STOCK" || item.AlertType == "HIGH_MOVER" {
				newMin := item.SuggestedMinStock
				if newMin <= 0 {
					newMin = item.MinStock + 2
				}
				urgentAlerts = append(urgentAlerts, fmt.Sprintf("• *%s*: Subir stock base a *%.0f un* _(%s)_", item.ProductName, newMin, item.Alert))
			}

			// Items agotados o bajo min stock con cantidad sugerida a pedir
			if item.Stock <= 0 || item.Status == "CRITICAL" {
				criticalItems = append(criticalItems, fmt.Sprintf("• *%s* ➔ Pedir *%.0f un*", item.ProductName, qtyToOrder))
			}
		}

		if len(criticalItems) > 0 || len(urgentAlerts) > 0 {
			var message strings.Builder
			message.WriteString(fmt.Sprintf("🛎️ *VISITAS HOY: %s*\n", strings.ToUpper(s.Name)))
			message.WriteString("➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖\n\n")

			if len(criticalItems) > 0 {
				message.WriteString("📦 *PRODUCTOS AGOTADOS A PEDIR*:\n")
				for _, ci := range criticalItems {
					message.WriteString(ci + "\n")
				}
				message.WriteString("\n")
			}

			if len(urgentAlerts) > 0 {
				message.WriteString("⚡ *RECOMENDACIONES DE LA IA (STOCK BASE)*:\n")
				for _, alert := range urgentAlerts {
					message.WriteString(alert + "\n")
				}
				message.WriteString("\n")
			}

			message.WriteString("➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖\n")
			message.WriteString("📱 _Abre el panel de Pedidos Inteligentes para autorizar y generar._")
			m.telegram.SendAlert(message.String())
		}
	}

	return nil
}

func (m *CronManager) handlePendingDeliveriesAlert(ctx context.Context) error {
	log.Println("🤖 Running Daily Pending Deliveries Job...")

	orders, err := m.orders.GetPendingOrdersByDeliveryDate(time.Now())
	if err != nil {
		return fmt.Errorf("consultando entregas pendientes: %w", err)
	}

	if len(orders) == 0 {
		return nil
	}

	message := "🚚 *Entregas Programadas para Hoy*:\n\n"
	var totalCash float64

	for _, o := range orders {
		message += fmt.Sprintf("- %s: $%s COP\n", o.Supplier.Name, formatMoney(o.EstimatedCost))
		totalCash += o.EstimatedCost
	}

	message += fmt.Sprintf("\n💰 *Efectivo Total Requerido*: $%s COP", formatMoney(totalCash))
	m.telegram.SendAlert(message)
	return nil
}

func (m *CronManager) handleLogisticReportJob(ctx context.Context) error {
	log.Println("✅ Running Daily Logistic Report Job...")

	loc, _ := time.LoadLocation("America/Bogota")
	todayStr := time.Now().In(loc).Format("2006-01-02")

	// Excluir proveedores que ya tienen egreso registrado hoy
	var paidSupplierIDs []uint
	if err := m.db.WithContext(ctx).Model(&models.Expense{}).
		Where("category = ? AND supplier_id IS NOT NULL AND DATE(date) >= ?", "Proveedores", todayStr).
		Pluck("supplier_id", &paidSupplierIDs).Error; err != nil {
		return fmt.Errorf("consultando egresos pagados: %w", err)
	}
	paidMap := make(map[uint]bool)
	for _, id := range paidSupplierIDs {
		paidMap[id] = true
	}

	type UnifiedOrder struct {
		SupplierName string
		Total        float64
		ItemCount    int
	}
	supplierMap := make(map[string]*UnifiedOrder)
	var supplierOrderList []string

	// Helper func to extract value from invoiceRef
	getVal := func(est float64, totalEst float64, invoiceRef string) float64 {
		val := est
		if val == 0 {
			val = totalEst
		}
		if invoiceRef != "" {
			cleanInv := regexp.MustCompile(`[^0-9.]`).ReplaceAllString(invoiceRef, "")
			if parsedInv, err := strconv.ParseFloat(cleanInv, 64); err == nil && parsedInv > 0 {
				val = parsedInv
			}
		}
		return val
	}

	// 1. Confirmed Orders (Solo pedidos programados para HOY que no hayan sido cerrados o pagados)
	var confirmed []models.ConfirmedOrder
	if err := m.db.WithContext(ctx).Preload("Supplier").Preload("Items").
		Where("DATE(expected_date) = ? AND UPPER(status) NOT IN ('COMPLETED', 'DISCARDED', 'RECEIVED', 'DELIVERED', 'CANCELED', 'CANCELLED')", todayStr).
		Find(&confirmed).Error; err != nil {
		return fmt.Errorf("consultando pedidos confirmados: %w", err)
	}

	for _, o := range confirmed {
		if o.SupplierID > 0 && paidMap[o.SupplierID] {
			continue // Ya fue pagado hoy
		}
		supName := strings.TrimSpace(o.Supplier.Name)
		if supName == "" {
			supName = "PROVEEDOR VARIADO"
		}
		val := getVal(0, o.EstimatedTotal, o.InvoiceRef)
		itemsCount := len(o.Items)

		if existing, exists := supplierMap[supName]; exists {
			existing.Total += val
			existing.ItemCount += itemsCount
		} else {
			supplierMap[supName] = &UnifiedOrder{
				SupplierName: supName,
				Total:        val,
				ItemCount:    itemsCount,
			}
			supplierOrderList = append(supplierOrderList, supName)
		}
	}

	if len(supplierOrderList) == 0 {
		log.Println("💤 No hay entregas programadas para hoy.")
		m.telegram.SendAlert("📅 *REPORTE LOGÍSTICO HOY*\n\n✅ No hay entregas pendientes programadas para hoy. ¡Que tengas un excelente turno!")
		return nil
	}

	var totalAmount float64
	var list strings.Builder

	for _, supName := range supplierOrderList {
		o := supplierMap[supName]
		list.WriteString(fmt.Sprintf("🚛 *%s*\n   💰 Valor: `$%s COP` | 📦 Ítems: `%d`\n\n",
			o.SupplierName, formatMoney(o.Total), o.ItemCount))
		totalAmount += o.Total
	}

	message := fmt.Sprintf(
		"📦 *PLAN DE ENTREGAS - HOY*\n"+
			"📅 *Fecha:* `%s` ⏰ *07:00 AM*\n"+
			"➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖\n\n"+
			"💰 *INVERSIÓN TOTAL:* `$%s COP`\n"+
			"📋 *PEDIDOS EN CAMINO:* `%d`\n\n"+
			"%s"+
			"➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖\n"+
			"🤖 _Sistema POS Pro Sincronizado_",
		time.Now().In(loc).Format("02/01/2006"),
		formatMoney(totalAmount),
		len(supplierOrderList),
		list.String(),
	)

	m.telegram.SendAlert(message)
	log.Printf("📩 Logistic report sent to Telegram: %d suppliers, total $%s", len(supplierOrderList), formatMoney(totalAmount))
	return nil
}

func formatMoney(amount float64) string {
	s := fmt.Sprintf("%.0f", amount)
	n := len(s)
	if n <= 3 {
		return s
	}

	var res []string
	for i := n; i > 0; i -= 3 {
		start := i - 3
		if start < 0 {
			start = 0
		}
		res = append([]string{s[start:i]}, res...)
	}

	return strings.Join(res, ".")
}

func (m *CronManager) handleNightlyBackupJob(ctx context.Context) error {
	log.Println("💾 Running Nightly Database Backup...")

	// 1. Obtener credenciales de la DB
	dbUser := os.Getenv("DB_USER")
	dbName := os.Getenv("DB_NAME")
	dbPass := os.Getenv("DB_PASSWORD")

	// 2. Ruta de pg_dump (Configurable por .env para producción)
	pgDumpRaw := strings.TrimSpace(strings.Trim(os.Getenv("PG_DUMP_PATH"), "\""))
	pgDumpPath := filepath.Clean(pgDumpRaw)
	if pgDumpPath == "" || pgDumpPath == "." {
		pgDumpPath = "pg_dump" // Si está en el PATH
	}

	// Validar que el binario exista antes de invocarlo
	if _, err := os.Stat(pgDumpPath); os.IsNotExist(err) && pgDumpPath != "pg_dump" {
		m.telegram.SendAlert(fmt.Sprintf("❌ *FALLO DE RESPALDO:* El ejecutable pg_dump no se encontró en `%s`. Verifica el .env.", pgDumpPath))
		return fmt.Errorf("binario pg_dump no encontrado en %s", pgDumpPath)
	}

	// 3. Crear archivo temporal para el backup
	filename := fmt.Sprintf("backup_pos_%s.sql", time.Now().Format("2006-01-02_15-04"))
	backupPath := filepath.Join(os.TempDir(), filename)

	// 4. Ejecutar pg_dump directamente (Más estable que usar cmd /C).
	// CommandContext permite que el timeout del job mate un pg_dump colgado.
	args := []string{"-U", dbUser, "-d", dbName, "-f", backupPath}
	cmd := exec.CommandContext(ctx, pgDumpPath, args...)

	// Pasar PGPASSWORD via Environment para evitar diálogos interactivos
	cmd.Env = append(os.Environ(), "PGPASSWORD="+dbPass)

	log.Printf("🛠️ Executing Backup: %s %v", pgDumpPath, args)
	output, err := cmd.CombinedOutput()
	if err != nil {
		m.telegram.SendAlert(fmt.Sprintf("❌ *FALLO DE RESPALDO:* %v\n_Verifica la ruta de pg_dump en el .env de producción._", err))
		return fmt.Errorf("pg_dump falló: %w (salida: %s)", err, strings.TrimSpace(string(output)))
	}

	// 5. Leer el archivo y enviarlo por Telegram
	file, err := os.Open(backupPath)
	if err != nil {
		return fmt.Errorf("abriendo el respaldo generado: %w", err)
	}
	defer file.Close()
	defer os.Remove(backupPath) // Limpiar después de enviar

	caption := fmt.Sprintf("💾 *RESPALDO NOCTURNO AUTOMÁTICO*\n📅 Fecha: `%s`\n🚀 _Sistema POS Pro Protegido_",
		time.Now().Format("02/01/2006 15:04"))

	if err := m.telegram.SendDocument(file, filename, caption); err != nil {
		// El dump existe pero no salió del PC: se reporta como fallo para que
		// el reintento del orquestador vuelva a mandarlo.
		return fmt.Errorf("enviando el respaldo por Telegram: %w", err)
	}
	return nil
}

func (m *CronManager) handleShelfStockCriticalAlert(ctx context.Context) error {
	log.Println("🤖 Running Daily Shelf Stock Critical Job...")

	loc, _ := time.LoadLocation("America/Bogota")
	todayStr := time.Now().In(loc).Format("2006-01-02")

	expectedOrders, _ := m.expected.GetExpectedOrdersByDate(todayStr)
	expectedSuppliers := make(map[string]bool)
	for _, o := range expectedOrders {
		expectedSuppliers[o.SupplierName] = true
	}

	criticals, err := m.inventory.GetGlobalRestockSuggestions(false)
	if err != nil {
		return fmt.Errorf("consultando sugerencias globales de restock: %w", err)
	}

	primarySuppliersMap := make(map[string][]services.SuggestedOrder)
	secondarySuppliersMap := make(map[string][]services.SuggestedOrder)

	for _, c := range criticals {
		if c.Stock <= c.MinShelfStock && c.AvgDailySales > 3 {
			if expectedSuppliers[c.BestSupplierName] {
				primarySuppliersMap[c.BestSupplierName] = append(primarySuppliersMap[c.BestSupplierName], c)
			} else {
				secondarySuppliersMap[c.BestSupplierName] = append(secondarySuppliersMap[c.BestSupplierName], c)
			}
		}
	}

	if len(primarySuppliersMap) == 0 && len(secondarySuppliersMap) == 0 {
		return nil
	}

	todayFmt := time.Now().In(loc).Format("02/01/2006")
	message := fmt.Sprintf("🚨 *PRODUCTOS CRÍTICOS* — %s\n", todayFmt)

	if len(primarySuppliersMap) > 0 {
		message += "\n🚚 *PROVEEDORES QUE LLEGAN HOY (PRIORIDAD ALTA)*:\n"
		for suppName, items := range primarySuppliersMap {
			for _, item := range items {
				message += fmt.Sprintf("· *%s*: stock %.0f | vende %.1f/día | prov: %s\n", item.ProductName, item.Stock, item.AvgDailySales, suppName)
			}
		}
	}

	if len(secondarySuppliersMap) > 0 {
		message += "\n⚠️ *OTROS CRÍTICOS (SIN ENTREGA HOY)*:\n"
		for suppName, items := range secondarySuppliersMap {
			for _, item := range items {
				message += fmt.Sprintf("· *%s*: stock %.0f | vende %.1f/día | prov: %s\n", item.ProductName, item.Stock, item.AvgDailySales, suppName)
			}
		}
	}

	m.telegram.SendAlert(message)
	return nil
}

func (m *CronManager) handleNightlyRestockCalculation(ctx context.Context) error {
	log.Println("🌙 Running Nightly Smart Restock Calculation Job...")

	if err := m.restockNightly.RunNightlyMetricsCalculation(ctx); err != nil {
		m.telegram.SendAlert(fmt.Sprintf("⚠️ *FALLO EN CÁLCULO NOCTURNO DE RESTOCK:* %v", err))
		return fmt.Errorf("cálculo nocturno de restock: %w", err)
	}

	log.Println("✅ Nightly Smart Restock Calculation Finished Successfully.")
	go sse.GetSSEService().Broadcast("RESTOCK_UPDATE", map[string]string{"status": "completed"})
	return nil
}
