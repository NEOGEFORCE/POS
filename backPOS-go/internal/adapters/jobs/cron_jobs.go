package jobs

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

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
}

func NewCronManager(
	db *gorm.DB,
	tg *services.TelegramService,
	inv *services.InventoryService,
	sup *services.SupplierService,
	ord *services.PurchaseOrderService,
	exp *services.ExpectedOrderService,
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

	m.scheduler.Start()
	log.Println("🕒 Cron Scheduler Started with America/Bogota Location")
}

func (m *CronManager) handleSuggestedOrdersAlert() {
	log.Println("🤖 Running Daily Suggested Orders Job (07:05 AM)...")
	
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
	
	today := days[time.Now().Weekday()]
	suppliers, err := m.supplier.GetSuppliersByVisitDay(today)
	if err != nil {
		log.Printf("❌ Job 1 Error: %v", err)
		return
	}

	if len(suppliers) == 0 {
		return
	}

	message := "🛒 *Sugerencias de Pedido para Hoy (" + today + ")*:\n\n"
	foundAny := false

	for _, s := range suppliers {
		suggested, _ := m.inventory.GetSuggestedOrders(s.ID)
		if len(suggested) > 0 {
			message += fmt.Sprintf("• *%s*: %d items a reponer\n", s.Name, len(suggested))
			foundAny = true
		}
	}

	if foundAny {
		message += "\n👉 Revisa el panel para confirmar las órdenes."
		m.telegram.SendAlert(message)
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
	log.Println("🤖 Running Daily Logistic Report Job (07:00 AM)...")

	// Get Expected Orders for today
	todayStr := time.Now().Format("2006-01-02")
	expectedOrders, err := m.expected.GetExpectedOrdersByDate(todayStr)
	if err != nil {
		log.Printf("❌ Logistic Job Error: %v", err)
		return
	}

	if len(expectedOrders) == 0 {
		log.Println("ℹ️ No hay entregas programadas para hoy.")
		m.telegram.SendAlert("📅 *REPORTE LOGÍSTICO*\n\n✅ No hay entregas programadas para el día de hoy. ¡Que tengas un excelente turno!")
		return
	}

	var totalAmount float64
	var list strings.Builder

	for _, o := range expectedOrders {
		list.WriteString(fmt.Sprintf("▫️ *%s*\n   💰 Valor: `$%s` | 📦 Ítems: `%d`\n\n", 
			o.SupplierName, formatMoney(o.TotalEstimated), o.ItemCount))
		totalAmount += o.TotalEstimated
	}

	message := fmt.Sprintf(
		"📊 *PLAN DE ENTREGAS - HOY*\n"+
			"📅 *Fecha:* `%s` 🕒 *07:00 AM*\n"+
			"━━━━━━━━━━━━━━━━━━━━\n\n"+
			"💰 *INVERSIÓN TOTAL:* `$%s COP`\n"+
			"🚚 *PEDIDOS EN CAMINO:* `%d`\n\n"+
			"%s"+
			"━━━━━━━━━━━━━━━━━━━━\n"+
			"🚀 _Sistema Cerberus POS Sincronizado_",
		time.Now().Format("02/01/2006"),
		formatMoney(totalAmount),
		len(expectedOrders),
		list.String(),
	)

	m.telegram.SendAlert(message)
	log.Printf("✅ Logistic report sent to Telegram: %d orders", len(expectedOrders))
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
	pgDumpPath := strings.Trim(os.Getenv("PG_DUMP_PATH"), "\"")
	if pgDumpPath == "" {
		pgDumpPath = "pg_dump" // Si está en el PATH
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

	caption := fmt.Sprintf("💾 *RESPALDO NOCTURNO AUTOMÁTICO*\n📅 Fecha: `%s`\n🚀 _Sistema Cerberus POS Protegido_", 
		time.Now().Format("02/01/2006 15:04"))
	
	err = m.telegram.SendDocument(file, filename, caption)
	if err != nil {
		log.Printf("❌ Failed to send backup to Telegram: %v", err)
	}
}
