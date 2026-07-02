package jobs

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"backPOS-go/internal/infrastructure/refresher"
	"backPOS-go/internal/infrastructure/sse"
	"github.com/robfig/cron/v3"
	"gorm.io/gorm"
)

type CronManager struct {
	scheduler *cron.Cron
	db        *gorm.DB
	telegram  *services.TelegramService
	inventory *services.InventoryService
	supplier  *services.SupplierService
	orders    *services.PurchaseOrderService
	expected  *services.ExpectedOrderService
	restock   *services.RestockService
}

func NewCronManager(
	db *gorm.DB,
	tg *services.TelegramService,
	inv *services.InventoryService,
	sup *services.SupplierService,
	ord *services.PurchaseOrderService,
	exp *services.ExpectedOrderService,
	res *services.RestockService,
) *CronManager {
	// LOCALIZACIÓN FIJA: Colombia (UTC-5) - Independiente de la configuración del servidor
	loc := time.FixedZone("America/Bogota", -5*60*60)
	scheduler := cron.New(cron.WithLocation(loc))

	return &CronManager{
		scheduler: scheduler,
		db:        db,
		telegram:  tg,
		inventory: inv,
		supplier:  sup,
		orders:    ord,
		expected:  exp,
		restock:   res,
	}
}

func (m *CronManager) Start() {
	// Job 0: High-Performance Dashboard Refresher (Every 5 minutes)
	_, err := m.scheduler.AddFunc("@every 5m", func() {
		log.Println("📊 [Cron] Solicitando Refresco de Dashboard...")
		refresher.GetRefresherService(m.db).RequestRefresh("mv_dashboard_stats_monthly")
		
		// AVISO GLOBAL: Estadísticas pesadas actualizadas por el sistema
		go sse.GetSSEService().BroadcastDashboardUpdate()
	})
	if err != nil {
		log.Printf("❌ Failed to schedule Dashboard Refresher: %v", err)
	}

	// Job 1: Suggested Orders (Daily at 07:00 AM)
	_, err = m.scheduler.AddFunc("0 7 * * *", m.handleSuggestedOrdersAlert)
	if err != nil {
		log.Printf("❌ Failed to schedule Job 1: %v", err)
	}

	// Job 2: Pending Deliveries / Cash Required (Daily at 08:00 AM)
	_, err = m.scheduler.AddFunc("0 8 * * *", m.handlePendingDeliveriesAlert)
	if err != nil {
		log.Printf("❌ Failed to schedule Job 2: %v", err)
	}

	// Job 3: Logistic Report (Daily at 07:00 AM - User Requested)
	_, err = m.scheduler.AddFunc("0 7 * * *", m.handleLogisticReportJob)
	if err != nil {
		log.Printf("❌ Failed to schedule Job 3: %v", err)
	}

	// Job 4: Nightly Database Backup (Daily at 09:20 PM - User Requested)
	_, err = m.scheduler.AddFunc("20 21 * * *", m.handleNightlyBackupJob)
	if err != nil {
		log.Printf("❌ Failed to schedule Job 4: %v", err)
	}

	// Job 5: Critical Shelf Stock Alert (Daily at 07:00 AM)
	_, err = m.scheduler.AddFunc("0 7 * * *", m.handleShelfStockCriticalAlert)
	if err != nil {
		log.Printf("❌ Failed to schedule Job 5: %v", err)
	}

	m.scheduler.Start()
	log.Println("🕒 Cron Scheduler Started with America/Bogota Location")
}

func (m *CronManager) handleSuggestedOrdersAlert() {
	log.Println("🔄 Running Daily Suggested Orders Job (07:05 AM)...")
	
	loc, _ := time.LoadLocation("America/Bogota")
	// Determinar día actual
	days := map[time.Weekday]string{
		time.Monday:    "Lunes",
		time.Tuesday:   "Martes",
		time.Wednesday: "Miércoles",
		time.Thursday:  "Jueves",
		time.Friday:    "Viernes",
		time.Saturday:  "Sábado",
		time.Sunday:    "Domingo",
	}
	
	today := days[time.Now().In(loc).Weekday()]
	suppliers, err := m.supplier.GetSuppliersByVisitDay(today)
	if err != nil {
		log.Printf("❌ Job 1 Error: %v", err)
		return
	}

	if len(suppliers) == 0 {
		return
	}

	for _, s := range suppliers {
		suggested, _ := m.inventory.GetSuggestedOrders(s.ID, false)
		
		var criticalItems []string
		var urgentAlerts []string

		for _, item := range suggested {
			// TAREA 2: Escanear y destacar Alertas de Aumento de Stock Base
			if item.AlertType == "INCREASE_MIN_STOCK" || item.AlertType == "HIGH_MOVER" {
				urgentAlerts = append(urgentAlerts, fmt.Sprintf("   🚨 *%s*: %s", item.ProductName, item.Alert))
			}
			
			// Solo items en estado realmente crǟtico (Stock <= 0)
			if item.Stock <= 0 {
				criticalItems = append(criticalItems, fmt.Sprintf("• %s: stock %.2f | min: %.2f", item.ProductName, item.Stock, item.MinStock))
			}
		}

		if len(criticalItems) > 0 || len(urgentAlerts) > 0 {
			var message strings.Builder
			message.WriteString(fmt.Sprintf("🛎️ *VISITAS HOY: %s*\n\n", s.Name))
			
			if len(criticalItems) > 0 {
				message.WriteString("🚨 *ESTADO CRÍTICO (AGOTADOS)*:\n")
				for _, ci := range criticalItems {
					message.WriteString(ci + "\n")
				}
				message.WriteString("\n")
			}
			
			if len(urgentAlerts) > 0 {
				message.WriteString("⚠️ *¡ATENCIÓN A ESTOS PRODUCTOS!*\n_Se están vendiendo muy rápido. ¡Pide más y sube tu Stock Base!_\n")
				for _, alert := range urgentAlerts {
					message.WriteString(alert + "\n")
				}
				message.WriteString("\n")
			}
			
			message.WriteString("📱 Revisa el panel de Pedidos Inteligentes para confirmar.")
			m.telegram.SendAlert(message.String())
		}
	}
}

func (m *CronManager) handlePendingDeliveriesAlert() {
	log.Println("🤖 Running Daily Pending Deliveries Job...")
	
	orders, err := m.orders.GetPendingOrdersByDeliveryDate(time.Now())
	if err != nil {
		log.Printf("❌ Job 2 Error: %v", err)
		return
	}

	if len(orders) == 0 {
		return
	}

	message := "🚚 *Entregas Programadas para Hoy*:\n\n"
	var totalCash float64

	for _, o := range orders {
		message += fmt.Sprintf("- %s: $%s COP\n", o.Supplier.Name, formatMoney(o.EstimatedCost))
		totalCash += o.EstimatedCost
	}

	message += fmt.Sprintf("\n💰 *Efectivo Total Requerido*: $%s COP", formatMoney(totalCash))
	m.telegram.SendAlert(message)
}

func (m *CronManager) handleLogisticReportJob() {
	log.Println("✅ Running Daily Logistic Report Job (07:00 AM)...")

	loc, _ := time.LoadLocation("America/Bogota")
	todayStr := time.Now().In(loc).Format("2006-01-02")
	
	type UnifiedOrder struct {
		SupplierName string
		Total        float64
		ItemCount    int
	}
	var allOrders []UnifiedOrder

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

	// 1. Confirmed Orders (Pending for Delivery)
	var confirmed []models.ConfirmedOrder
	m.db.Preload("Supplier").Preload("Items").Where("DATE(expected_date) <= ? AND UPPER(status) NOT IN ('COMPLETED', 'DISCARDED', 'RECEIVED', 'DELIVERED', 'CANCELED', 'CANCELLED')", todayStr).Find(&confirmed)
	for _, o := range confirmed {
		allOrders = append(allOrders, UnifiedOrder{o.Supplier.Name, getVal(0, o.EstimatedTotal, o.InvoiceRef), len(o.Items)})
	}

	if len(allOrders) == 0 {
		log.Println("💤 No hay entregas programadas para hoy.")
		m.telegram.SendAlert("📅 *REPORTE LOGÍSTICO*\n\n✅ No hay entregas programadas para el día de hoy. ¡Que tengas un excelente turno!")
		return
	}

	var totalAmount float64
	var list strings.Builder

	for _, o := range allOrders {
		list.WriteString(fmt.Sprintf("🚛 *%s*\n   💰 Valor: `$%s` | 📦 Ítems: `%d`\n\n", 
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
		len(allOrders),
		list.String(),
	)

	m.telegram.SendAlert(message)
	log.Printf("📩 Logistic report sent to Telegram: %d orders", len(allOrders))
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

func (m *CronManager) handleNightlyBackupJob() {
	log.Println("💾 Running Nightly Database Backup (09:20 PM)...")

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
		log.Printf("❌ Error: Binario pg_dump no encontrado en la ruta: %s", pgDumpPath)
		m.telegram.SendAlert(fmt.Sprintf("❌ *FALLO DE RESPALDO:* El ejecutable pg_dump no se encontró en `%s`. Verifica el .env.", pgDumpPath))
		return
	}
	
	// 3. Crear archivo temporal para el backup
	filename := fmt.Sprintf("backup_pos_%s.sql", time.Now().Format("2006-01-02_15-04"))
	backupPath := filepath.Join(os.TempDir(), filename)
	
	// 4. Ejecutar pg_dump directamente (Más estable que usar cmd /C)
	args := []string{"-U", dbUser, "-d", dbName, "-f", backupPath}
	cmd := exec.Command(pgDumpPath, args...)
	
	// Pasar PGPASSWORD via Environment para evitar diálogos interactivos
	cmd.Env = append(os.Environ(), "PGPASSWORD="+dbPass)
	
	log.Printf("🛠️ Executing Backup: %s %v", pgDumpPath, args)
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("❌ Failed to create backup: %v\nOutput: %s", err, string(output))
		m.telegram.SendAlert(fmt.Sprintf("❌ *FALLO DE RESPALDO:* %v\n_Verifica la ruta de pg_dump en el .env de producción._", err))
		return
	}

	// 5. Leer el archivo y enviarlo por Telegram
	file, err := os.Open(backupPath)
	if err != nil {
		log.Printf("❌ Failed to open backup file: %v", err)
		return
	}
	defer file.Close()
	defer os.Remove(backupPath) // Limpiar después de enviar

	caption := fmt.Sprintf("💾 *RESPALDO NOCTURNO AUTOMÁTICO*\n📅 Fecha: `%s`\n🚀 _Sistema POS Pro Protegido_", 
		time.Now().Format("02/01/2006 15:04"))
	
	err = m.telegram.SendDocument(file, filename, caption)
	if err != nil {
		log.Printf("❌ Failed to send backup to Telegram: %v", err)
	}
}

func (m *CronManager) handleShelfStockCriticalAlert() {
	log.Println("🤖 Running Daily Shelf Stock Critical Job (07:00 AM)...")

	loc, _ := time.LoadLocation("America/Bogota")
	todayStr := time.Now().In(loc).Format("2006-01-02")
	
	expectedOrders, _ := m.expected.GetExpectedOrdersByDate(todayStr)
	expectedSuppliers := make(map[string]bool)
	for _, o := range expectedOrders {
		expectedSuppliers[o.SupplierName] = true
	}

	criticals, err := m.inventory.GetGlobalRestockSuggestions(false)
	if err != nil {
		log.Printf("❌ Shelf Stock Job Error: %v", err)
		return
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
		return
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
}
