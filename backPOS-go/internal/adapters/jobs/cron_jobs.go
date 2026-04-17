package jobs

import (
	"fmt"
	"log"
	"time"

	"backPOS-go/internal/core/services"
	"github.com/robfig/cron/v3"
)

type CronManager struct {
	scheduler *cron.Cron
	telegram  *services.TelegramService
	inventory *services.InventoryService
	supplier  *services.SupplierService
	orders    *services.PurchaseOrderService
}

func NewCronManager(
	tg *services.TelegramService,
	inv *services.InventoryService,
	sup *services.SupplierService,
	ord *services.PurchaseOrderService,
) *CronManager {
	// Force America/Bogota as per user request
	loc, err := time.LoadLocation("America/Bogota")
	if err != nil {
		log.Printf("❌ Failed to load location America/Bogota: %v. Using UTC.", err)
		loc = time.UTC
	}

	scheduler := cron.New(cron.WithLocation(loc))

	return &CronManager{
		scheduler: scheduler,
		telegram:  tg,
		inventory: inv,
		supplier:  sup,
		orders:    ord,
	}
}

func (m *CronManager) Start() {
	// Job 1: Suggested Orders (Daily at 07:00 AM)
	_, err := m.scheduler.AddFunc("0 7 * * *", m.handleSuggestedOrdersAlert)
	if err != nil {
		log.Printf("❌ Failed to schedule Job 1: %v", err)
	}

	// Job 2: Pending Deliveries / Cash Required (Daily at 08:00 AM)
	_, err = m.scheduler.AddFunc("0 8 * * *", m.handlePendingDeliveriesAlert)
	if err != nil {
		log.Printf("❌ Failed to schedule Job 2: %v", err)
	}

	m.scheduler.Start()
	log.Println("🕒 Cron Scheduler Started with America/Bogota Location")
}

func (m *CronManager) handleSuggestedOrdersAlert() {
	log.Println("🤖 Running Daily Suggested Orders Job...")
	
	// Determine current day in Spanish for filtering
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

func formatMoney(amount float64) string {
	return fmt.Sprintf("%.2f", amount)
}
