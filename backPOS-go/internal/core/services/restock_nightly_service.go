package services

import (
	"context"
	"log"
	"math"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services/scheduling"
)

const (
	// restockWindowRecentDays es la ventana CORTA y es la señal PRINCIPAL de
	// demanda desde el 2026-09-05, por pedido del dueño:
	//
	//	"aparte de basarte en los 90 tienes que basarte mucho mucho en las
	//	 ultimas 2 semanas o una semana porque los proveedores la mayoria se
	//	 demoran 8 dias y uno que otro 15 o 20"
	//
	// El razonamiento es de negocio: si el proveedor vuelve en 8 días, lo que
	// importa es cuánto se está vendiendo AHORA, no el promedio de tres meses.
	// Con ventanas largas un producto que se aceleró esta semana queda diluido y
	// se pide de menos; uno que se frenó queda inflado y se pide de más.
	//
	// Son 14 días y no 7 porque a 7 días un fin de semana flojo o un puente
	// distorsionan demasiado la tasa diaria.
	restockWindowRecentDays = 14

	// Las ventanas largas quedan como RESPALDO para los productos lentos que no
	// registran nada en dos semanas pero sí rotan en el trimestre.
	restockWindowDays   = 30
	restockWindow90Days = 90
)

var bogotaLocation = time.FixedZone("America/Bogota", -5*60*60)

type RestockNightlyService struct {
	metricsRepo *repositories.RestockMetricsRepository
	now         func() time.Time
}

func NewRestockNightlyService(mr *repositories.RestockMetricsRepository) *RestockNightlyService {
	return &RestockNightlyService{
		metricsRepo: mr,
		now:         time.Now,
	}
}

func (s *RestockNightlyService) RunNightlyMetricsCalculation(ctx context.Context) error {
	now := s.now().In(bogotaLocation)
	// El batch pide en un solo query ambas ventanas de demanda (30 y 90
	// dias). "since30" es el borde inferior del 30d; el repositorio
	// deriva el 90d por su cuenta a partir de asOf.
	since := now.AddDate(0, 0, -restockWindowDays)
	inputs, err := s.metricsRepo.LoadCalculationInputs(ctx, since, now)
	if err != nil {
		return err
	}

	snapshots := make([]models.DailyStockSnapshot, 0, len(inputs))
	metrics := make([]models.ProductRestockMetric, 0, len(inputs))
	for _, input := range inputs {
		snapshots = append(snapshots, models.DailyStockSnapshot{
			ProductID:    input.ProductID,
			SnapshotDate: now.Format("2006-01-02"),
			ClosingStock: input.CurrentStock,
			WasZero:      input.CurrentStock <= 0,
		})
		metrics = append(metrics, calculateRestockMetric(input, now))
	}

	if err := s.metricsRepo.SaveNightlyBatch(ctx, snapshots, metrics); err != nil {
		return err
	}

	// APRENDIZAJE DE AGENDA (migracion 014). El batch mira los pedidos ya
	// recibidos del ultimo LearnLookbackDays y calcula, POR PROVEEDOR, la
	// agenda observada. Escribe exclusivamente en columnas learned_* — no
	// toca visit_days ni delivery_days por regla absoluta del dueno.
	//
	// Si esta etapa falla, se REGISTRA pero NO se propaga: el resto de la
	// corrida (metricas por producto, snapshots) ya se guardo con exito y
	// tumbar todo el job por un fallo en el aprendizaje seria peor. El job
	// del orquestador ya reintenta al dia siguiente.
	if err := s.runSupplierScheduleLearning(ctx, now); err != nil {
		log.Printf("[RESTOCK-NIGHTLY] aprendizaje de agenda fallo (no critico): %v", err)
	}

	log.Printf("[RESTOCK-NIGHTLY] completed batch for %d products", len(metrics))
	return nil
}

// runSupplierScheduleLearning ejecuta la fase de aprendizaje pasivo.
//
// Fuentes (agosto 2026):
//   - Dias de VISITA: confirmed_orders.confirmed_at (dia en que el
//     preventista cerro el pedido).
//   - Dias de ENTREGA: expenses.date filtrando category='Proveedores',
//     supplier_id NOT NULL, deleted_at IS NULL. Segun la regla del dueno,
//     el egreso se registra el MISMO dia que llega la mercancia (a
//     diferencia de received_at, que puede registrarse dias despues).
//
// El caller lee ambas series por separado, las agrupa por proveedor y las
// pasa a scheduling.LearnSupplierSchedule (pura). El emparejamiento
// (visita, entrega) del mismo pedido queda descartado por fragil:
// expenses.reference_id apunta a la recepcion, no al confirmed_order que la
// origino. El lead time se deriva luego con PlanSupplierOrderSchedule
// dentro del propio aprendizaje.
func (s *RestockNightlyService) runSupplierScheduleLearning(ctx context.Context, now time.Time) error {
	windowStart := now.AddDate(0, 0, -scheduling.LearnLookbackDays)

	visitRows, err := s.metricsRepo.LoadSupplierVisitObservations(ctx, windowStart)
	if err != nil {
		return err
	}
	deliveryRows, err := s.metricsRepo.LoadSupplierDeliveryObservations(ctx, windowStart)
	if err != nil {
		return err
	}

	// Agrupar por proveedor. Un mapa con slice basta: la cantidad de
	// proveedores es del orden de decenas.
	visitsBySupplier := make(map[uint][]scheduling.SupplierVisitObservation, 32)
	for _, row := range visitRows {
		visitsBySupplier[row.SupplierID] = append(
			visitsBySupplier[row.SupplierID],
			scheduling.SupplierVisitObservation{ConfirmedAt: row.ConfirmedAt},
		)
	}
	deliveriesBySupplier := make(map[uint][]scheduling.SupplierDeliveryObservation, 32)
	for _, row := range deliveryRows {
		deliveriesBySupplier[row.SupplierID] = append(
			deliveriesBySupplier[row.SupplierID],
			scheduling.SupplierDeliveryObservation{PaidAt: row.PaidAt},
		)
	}

	// Union de IDs para no dejar por fuera proveedores que solo tienen
	// egresos (pago al contado directo, sin capturar la visita) o solo
	// confirmed_orders (raro, pero posible si el operador olvida registrar
	// el pago).
	suppliers := make(map[uint]struct{}, len(visitsBySupplier)+len(deliveriesBySupplier))
	for id := range visitsBySupplier {
		suppliers[id] = struct{}{}
	}
	for id := range deliveriesBySupplier {
		suppliers[id] = struct{}{}
	}
	if len(suppliers) == 0 {
		return nil
	}

	updates := make([]repositories.SupplierLearnedScheduleUpdate, 0, len(suppliers))
	for supplierID := range suppliers {
		learned := scheduling.LearnSupplierSchedule(
			visitsBySupplier[supplierID],
			deliveriesBySupplier[supplierID],
			now,
		)
		updates = append(updates, repositories.SupplierLearnedScheduleUpdate{
			SupplierID:   supplierID,
			HasLearned:   learned.HasLearned,
			VisitDays:    learned.VisitDays,
			DeliveryDays: learned.DeliveryDays,
			LeadTimeDays: learned.LeadTimeDays,
			SampleCount:  learned.SampleCount,
			LearnedAt:    now,
		})
	}

	if err := s.metricsRepo.SaveSupplierLearnedSchedules(ctx, updates); err != nil {
		return err
	}
	log.Printf("[RESTOCK-NIGHTLY] agenda aprendida para %d proveedores", len(updates))
	return nil
}

func calculateRestockMetric(input models.RestockCalculationInput, calculatedAt time.Time) models.ProductRestockMetric {
	// --------- Demanda 30 dias ----------------------------------------
	daysZero30 := input.DaysZeroStock
	if daysZero30 < 0 {
		daysZero30 = 0
	}
	if daysZero30 > restockWindowDays {
		daysZero30 = restockWindowDays
	}
	daysWithStock30 := restockWindowDays - daysZero30
	if daysWithStock30 < 1 {
		daysWithStock30 = 1
	}
	demand30 := input.TotalSold30d / float64(daysWithStock30)
	if demand30 < 0 {
		demand30 = 0
	}

	// --------- Demanda 90 dias ----------------------------------------
	// Fase 1 (agosto 2026): la ventana larga permite ver rotacion en
	// productos lentos que dieron cero en 30d pero SI se movieron. Igual
	// que la ventana corta, el denominador NO se infla con dias sin
	// snapshot: solo se descuentan los dias con snapshot confirmado que
	// dio was_zero=TRUE.
	daysZero90 := input.DaysZeroStock90d
	if daysZero90 < 0 {
		daysZero90 = 0
	}
	if daysZero90 > restockWindow90Days {
		daysZero90 = restockWindow90Days
	}
	daysWithStock90 := restockWindow90Days - daysZero90
	if daysWithStock90 < 1 {
		daysWithStock90 = 1
	}
	demand90 := input.TotalSold90d / float64(daysWithStock90)
	if demand90 < 0 {
		demand90 = 0
	}

	// --------- Demanda 14 dias (SEÑAL PRINCIPAL) ----------------------
	// Regla del dueño (2026-09-05): lo reciente MANDA sobre lo viejo, porque el
	// proveedor vuelve en 8 dias y hay que pedir contra lo que se esta vendiendo
	// ahora. Mismo criterio de denominador que las otras ventanas: no se
	// castiga al producto por los dias en que estuvo agotado.
	daysZero14 := input.DaysZeroStock14d
	if daysZero14 < 0 {
		daysZero14 = 0
	}
	if daysZero14 > restockWindowRecentDays {
		daysZero14 = restockWindowRecentDays
	}
	daysWithStock14 := restockWindowRecentDays - daysZero14
	if daysWithStock14 < 1 {
		daysWithStock14 = 1
	}
	demand14 := input.TotalSold14d / float64(daysWithStock14)
	if demand14 < 0 {
		demand14 = 0
	}

	// DEMANDA EFECTIVA: lo reciente manda.
	//
	// Si el producto se movio en las ultimas dos semanas, esa es la tasa que se
	// usa, incluso si es MENOR que la de 30 o 90 dias. Eso es deliberado: un
	// producto que se freno debe pedirse menos, y antes el max() lo mantenia
	// inflado con ventas viejas.
	//
	// Si NO se movio en dos semanas, se cae a las ventanas largas para no
	// olvidar a los lentos que igual rotan en el trimestre. Su tasa va a ser
	// chica, y combinada con el piso de MinMeaningfulOrderQty eso evita que se
	// llene el pedido de productos de a 1.
	demand := demand14
	if demand14 <= 0 {
		demand = math.Max(demand30, demand90)
	}

	// Lead time efectivo. Se prefiere lo que salga de los DIAS de la semana
	// que el dueno configuro a mano en el proveedor primario (VisitDays /
	// DeliveryDays). Si no alcanzan, se cae a learned_lead_time_days (si el
	// batch anterior lo aprendio con muestras suficientes), luego a
	// lead_time_days explicito, luego a visit_frequency_days (aprendido,
	// sospechoso) y por ultimo a 7. El mismo orden se aplica en
	// GetSuggestions para que las fechas expuestas al frontend sean
	// coherentes con el ideal_stock persistido.
	visitDays := collectSupplierScheduleDays(input.PrimaryVisitDays, input.PrimaryLegacyVisitDay)
	deliveryDays := collectSupplierScheduleDays(input.PrimaryDeliveryDays, input.PrimaryLegacyDeliveryDay)
	schedule := scheduling.PlanSupplierOrderSchedule(visitDays, deliveryDays, calculatedAt.In(bogotaLocation))
	// learned_lead_time_days solo se usa cuando el batch anterior tuvo
	// muestras suficientes. Si learned_sample_count esta debajo del umbral
	// pasamos nil para que la precedencia caiga a explicit / visit_frequency.
	// Ver scheduling/learn.go para el criterio del umbral.
	var learnedLead *int
	if input.PrimaryLearnedSampleCount >= scheduling.LearnMinSamples && input.PrimaryLearnedLeadTimeDays != nil && *input.PrimaryLearnedLeadTimeDays > 0 {
		learnedLead = input.PrimaryLearnedLeadTimeDays
	}
	leadDays, _ := scheduling.ResolveSupplierLeadTime(
		schedule,
		learnedLead,
		input.PrimaryExplicitLeadTimeDays,
		input.PrimaryVisitFrequencyDays,
	)
	// Compatibilidad con inputs construidos a mano (tests) o inputs viejos
	// donde solo se poblo input.SupplierLeadDays: si no hay ninguna fuente
	// nueva (schedule, learned, explicit, visit_frequency) pero el input
	// trae un lead time computado por la SQL antigua, tiene mas informacion
	// que caer al default duro de 7.
	if !schedule.HasSchedule &&
		learnedLead == nil &&
		(input.PrimaryExplicitLeadTimeDays == nil || *input.PrimaryExplicitLeadTimeDays == 0) &&
		input.PrimaryVisitFrequencyDays == 0 &&
		input.SupplierLeadDays > 0 {
		leadDays = input.SupplierLeadDays
	}
	if leadDays <= 0 {
		leadDays = 7
	}
	category := classifyABC(demand, input.TotalSold30d)
	idealStock := math.Ceil(demand * float64(leadDays) * safetyFactor(category))

	// EL MINIMO ES ALARMA, NO META (regla del dueno, agosto 2026 / Fase 1).
	//
	// El ideal sale SOLO de la demanda (con colchon por clase ABC).
	// SuggestedOrderQty combina el objetivo por 75% del minimo y la
	// demanda; ninguno de los dos usa el minimo entero como meta. Los
	// productos que no llegan al objetivo aparecen en la pantalla porque
	// GetSuggestions itera product_restock_metrics y aplica la logica viva.
	minStock := input.MinStock
	if minStock < 0 {
		minStock = 0
	}

	suggested := models.SuggestedOrderQty(idealStock, input.CurrentStock, input.InTransitQty, minStock, category)

	return models.ProductRestockMetric{
		ProductID:         input.ProductID,
		ProductName:       input.ProductName,
		TotalSold30d:      input.TotalSold30d,
		DaysWithStock:     daysWithStock30,
		DaysZeroStock:     daysZero30,
		AvgDailySales:     math.Round(demand*10000) / 10000,
		ABCCategory:       category,
		CurrentStock:      input.CurrentStock,
		InTransitQty:      input.InTransitQty,
		IdealStock:        idealStock,
		SuggestedOrderQty: suggested,
		PrimarySupplierID: input.PrimarySupplierID,
		SupplierName:      input.SupplierName,
		SupplierLeadDays:  leadDays,
		UnitCost:          input.UnitCost,
		CalculatedAt:      calculatedAt,
		// Arreglo 4: pasamos al batch las señales que antes recalculaba
		// GetSuggestions en caliente. Si el input no tiene fecha (producto
		// sin recepciones históricas), LastReceptionAt queda en nil y la
		// pantalla mostrará "dato desconocido".
		LastReceptionAt:    input.LastReceptionAt,
		SoldSinceReception: input.SoldSinceReception,
	}
}

// collectSupplierScheduleDays reune el campo JSONB y el campo legacy en una
// sola lista para pasarsela a scheduling.PlanSupplierOrderSchedule. El
// paquete scheduling ya tolera CSV embebido, mayusculas y tildes.
func collectSupplierScheduleDays(jsonbDays models.StringArray, legacyCSV *string) []string {
	out := make([]string, 0, len(jsonbDays)+1)
	for _, day := range jsonbDays {
		out = append(out, day)
	}
	if legacyCSV != nil && *legacyCSV != "" {
		out = append(out, *legacyCSV)
	}
	return out
}

// safetyFactor es el colchón sobre la demanda del tiempo de entrega.
//
// Sin colchón el stock ideal se agota justo el día de la visita del proveedor:
// cualquier retraso del camión o un pico de ventas deja el producto en cero, y
// en los de alta rotación eso es venta perdida directa. El margen se reparte
// según lo que cuesta quedarse sin cada producto:
//
//	A  +30%  son los que mueven la caja; no pueden faltar
//	B  +15%  colchón moderado
//	C   sin margen; igual no se sugiere pedirlos
func safetyFactor(category string) float64 {
	switch category {
	case "A":
		return 1.30
	case "B":
		return 1.15
	default:
		return 1.0
	}
}

func classifyABC(avgDaily, totalSold float64) string {
	if avgDaily >= 3 || totalSold >= 60 {
		return "A"
	}
	if avgDaily >= 0.5 || totalSold >= 15 {
		return "B"
	}
	return "C"
}
