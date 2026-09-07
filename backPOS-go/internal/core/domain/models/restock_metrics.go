package models

import (
	"math"
	"time"
)

// DailyStockSnapshot is the closing stock captured for one product and date.
type DailyStockSnapshot struct {
	ID           uint      `json:"id" gorm:"primaryKey"`
	ProductID    string    `json:"productId" gorm:"column:product_id;size:50;uniqueIndex:uq_dss_product_date"`
	SnapshotDate string    `json:"snapshotDate" gorm:"column:snapshot_date;type:date;uniqueIndex:uq_dss_product_date"`
	ClosingStock float64   `json:"closingStock" gorm:"column:closing_stock"`
	WasZero      bool      `json:"wasZero" gorm:"column:was_zero"`
	CreatedAt    time.Time `json:"createdAt" gorm:"column:created_at"`
}

func (DailyStockSnapshot) TableName() string { return "daily_stock_snapshots" }

// ProductRestockMetric contains the result of the latest nightly batch.
type ProductRestockMetric struct {
	ID                uint      `json:"id" gorm:"primaryKey"`
	ProductID         string    `json:"productId" gorm:"column:product_id;uniqueIndex"`
	ProductName       string    `json:"productName" gorm:"column:product_name"`
	TotalSold30d      float64   `json:"totalSold30d" gorm:"column:total_sold_30d"`
	DaysWithStock     int       `json:"daysWithStock" gorm:"column:days_with_stock"`
	DaysZeroStock     int       `json:"daysZeroStock" gorm:"column:days_zero_stock"`
	AvgDailySales     float64   `json:"avgDailySales" gorm:"column:avg_daily_sales"`
	ABCCategory       string    `json:"abcCategory" gorm:"column:abc_category;size:1"`
	CurrentStock      float64   `json:"currentStock" gorm:"column:current_stock"`
	InTransitQty      float64   `json:"inTransitQty" gorm:"column:in_transit_qty"`
	IdealStock        float64   `json:"idealStock" gorm:"column:ideal_stock"`
	SuggestedOrderQty float64   `json:"suggestedOrderQty" gorm:"column:suggested_order_qty"`
	PrimarySupplierID *uint     `json:"primarySupplierId" gorm:"column:primary_supplier_id"`
	SupplierName      string    `json:"supplierName" gorm:"column:supplier_name"`
	SupplierLeadDays  int       `json:"supplierLeadDays" gorm:"column:supplier_lead_days"`
	UnitCost          float64   `json:"unitCost" gorm:"column:unit_cost"`
	CalculatedAt      time.Time `json:"calculatedAt" gorm:"column:calculated_at"`

	// Precalculados por el batch nocturno para que la pantalla de pedidos
	// inteligentes no tenga que recalcularlos en caliente en cada request
	// (ver migración 013_restock_hot_path.sql).
	LastReceptionAt    *time.Time `json:"lastReceptionAt,omitempty" gorm:"column:last_reception_at"`
	SoldSinceReception float64    `json:"soldSinceReception" gorm:"column:sold_since_reception"`
}

func (ProductRestockMetric) TableName() string { return "product_restock_metrics" }

// SuggestedOrderQty es cuanto hay que pedir hoy, contando lo que ya viene en
// camino. Fase 1 (agosto 2026): la clase ABC NO bloquea pedidos; solo
// determina el safetyFactor con el que se calcula idealStock aguas arriba.
//
// La cantidad final es el MAYOR entre dos calculos:
//
//	(a) POR OBJETIVO: TargetShortfall(minStock, current, transit).
//	    Apunta al 75% del minimo (RestockTargetRatio). Aplica a ROJO y
//	    AMARILLO; en VERDE naturalmente da 0.
//	(b) POR DEMANDA: max(0, idealStock - (current + transit)). Aplica a
//	    todas las clases, incluyendo C — la rotacion baja se refleja en un
//	    idealStock chico, no en un veto binario.
//
// Detalles clave:
//   - Lo que viene en camino cuenta como disponible en ambas ramas.
//   - El objetivo viene redondeado hacia arriba (TargetShortfall usa
//     math.Ceil): no se pueden pedir 2.5 unidades reales.
//   - La demanda no se ceilea aca: idealStock ya viene ceileado en el
//     batch nocturno.
//   - Sin minimo configurado (minStock <= 0) la rama por objetivo degrada
//     a 0 y manda la rama por demanda.
//
// Se calcula al recomputar las metricas (batch nocturno) y al consultar las
// sugerencias (con stock/transito/minimo vivos), asi un pedido recien
// confirmado descuenta de inmediato y un minimo recien editado se respeta
// sin esperar al batch de la noche.
//
// El parametro abcCategory se conserva por retrocompatibilidad de firma —
// bajo la Fase 1 ya no participa en la decision. Se documenta como campo
// puramente informativo hasta que quede claro que ningun caller lo lea.
// RawOrderNeed es la necesidad REAL de reposicion, SIN el piso de necesidad
// marginal.
//
// Es el mayor entre el faltante al objetivo (75% del minimo) y el faltante por
// demanda, igual que SuggestedOrderQty, pero sin suprimir las necesidades
// chicas.
//
// PARA QUE EXISTE: los productos con EMPAQUE aprendido necesitan la necesidad
// cruda. El piso de MinMeaningfulOrderQty se creo para que no aparezcan pedidos
// de a 1, pero con caja de 12 ese piso estorba: convertia una necesidad de 2 en
// 0 y el producto no se pedia nunca, cuando lo correcto es pedir la caja. Con
// empaque, la CAJA es el piso.
func RawOrderNeed(idealStock, currentStock, inTransitQty, minStock float64) float64 {
	byTarget := TargetShortfall(minStock, currentStock, inTransitQty)
	byDemand := 0.0
	if missing := idealStock - (currentStock + inTransitQty); missing > 0 {
		byDemand = missing
	}
	return math.Max(byTarget, byDemand)
}

func SuggestedOrderQty(idealStock, currentStock, inTransitQty, minStock float64, abcCategory string) float64 {
	_ = abcCategory // ABC ya no bloquea pedidos (Fase 1, agosto 2026).

	byTarget := TargetShortfall(minStock, currentStock, inTransitQty)

	byDemand := 0.0
	if missing := idealStock - (currentStock + inTransitQty); missing > 0 {
		byDemand = missing
	}

	qty := math.Max(byTarget, byDemand)
	if qty <= 0 {
		return 0
	}

	// FILTRO DE NECESIDAD MARGINAL (regla del dueño, 2026-09-04).
	//
	// Pedir 1 o 2 unidades de muchos productos infla la factura sin resolver el
	// abastecimiento de ninguno. Si la necesidad no alcanza el piso, se deja
	// para el proximo pedido: mientras haya existencia se puede seguir
	// vendiendo, y la necesidad se acumula hasta valer el renglon.
	//
	// El AGOTADO es la excepcion: ahi no hay con que vender, asi que se pide
	// aunque la cantidad sea 1.
	if qty < MinMeaningfulOrderQty {
		available := currentStock + inTransitQty
		if available > 0 {
			return 0
		}
	}

	return qty
}

// RestockCalculationInput is loaded for every active product by one batch query.
type RestockCalculationInput struct {
	ProductID     string  `gorm:"column:product_id"`
	ProductName   string  `gorm:"column:product_name"`
	CurrentStock  float64 `gorm:"column:current_stock"`
	TotalSold30d  float64 `gorm:"column:total_sold_30d"`
	DaysZeroStock int     `gorm:"column:days_zero_stock"`
	// Fase 1 (agosto 2026): ventana ampliada a 90 dias en paralelo a la de 30
	// para que la demanda efectiva pueda apoyarse en la historia mas larga
	// cuando la corta esta en cero pero el producto SI se movio. Nombres en
	// snake_case para calzar con las columnas del SQL en LoadCalculationInputs.
	TotalSold90d     float64 `gorm:"column:total_sold_90d"`
	DaysZeroStock90d int     `gorm:"column:days_zero_stock_90d"`
	// Ventana CORTA (14 dias), señal principal de demanda desde 2026-09-05.
	// El proveedor vuelve en ~8 dias, asi que lo que se vendio en las ultimas
	// dos semanas pesa mas que el promedio del trimestre.
	TotalSold14d      float64 `gorm:"column:total_sold_14d"`
	DaysZeroStock14d  int     `gorm:"column:days_zero_stock_14d"`
	InTransitQty      float64 `gorm:"column:in_transit_qty"`
	PrimarySupplierID *uint   `gorm:"column:primary_supplier_id"`
	SupplierName      string  `gorm:"column:supplier_name"`
	SupplierLeadDays  int     `gorm:"column:supplier_lead_days"`
	UnitCost          float64 `gorm:"column:unit_cost"`

	// MinStock es el minimo configurado por el dueño en el producto
	// (products."minStock"). Entra al batch nocturno como PISO del
	// ideal_stock: sin esto, un producto sin ventas daba ideal 0, sugerencia 0
	// y nunca aparecia en la pantalla de pedidos inteligentes aunque el dueño
	// lo hubiera puesto explicitamente en un minimo. Ver calculateRestockMetric.
	MinStock float64 `gorm:"column:min_stock"`
	// Nuevo (arreglo 4): la fecha de la última recepción del producto y el
	// consumo posterior a esa recepción se precalculan en el batch nocturno y
	// se persisten en product_restock_metrics para que la pantalla de pedidos
	// inteligentes no tenga que recalcular dos CTEs pesados en cada request.
	LastReceptionAt    *time.Time `gorm:"column:last_reception_at"`
	SoldSinceReception float64    `gorm:"column:sold_since_reception"`

	// Nuevo (arreglo 5): agenda del proveedor primario. Se traen los dias
	// configurados a mano por el dueno para que el batch nocturno pueda
	// preferirlos sobre "visit_frequency_days", que se aprende sola y suele
	// inflar el numero. El batch usa scheduling.PlanSupplierOrderSchedule para
	// derivar el lead_time real; si no hay dias configurados, cae al
	// learned_lead_time_days (si es confiable), luego al lead_time_days
	// explicito, luego a visit_frequency_days y por ultimo a 7.
	PrimaryVisitDays            StringArray `gorm:"column:primary_visit_days;type:jsonb"`
	PrimaryDeliveryDays         StringArray `gorm:"column:primary_delivery_days;type:jsonb"`
	PrimaryLegacyVisitDay       *string     `gorm:"column:primary_legacy_visit_day"`
	PrimaryLegacyDeliveryDay    *string     `gorm:"column:primary_legacy_delivery_day"`
	PrimaryExplicitLeadTimeDays *int        `gorm:"column:primary_explicit_lead_time_days"`
	PrimaryVisitFrequencyDays   int         `gorm:"column:primary_visit_frequency_days"`

	// Agenda APRENDIDA por el batch anterior (columnas learned_* de la
	// migracion 014). Se cargan aca para que el batch nocturno actual pueda
	// preferir el learned_lead_time_days sobre el explicit_lead_time y sobre
	// visit_frequency_days, en el orden documentado por
	// scheduling.ResolveSupplierLeadTime.
	//
	// Convencion: si PrimaryLearnedSampleCount == 0 el aprendizaje anterior
	// no cuajo (o la migracion no se ha aplicado y las columnas estan en
	// NULL/0). En ese caso el batch NO usa learned_* — degrada limpio a las
	// otras fuentes.
	PrimaryLearnedVisitDays    StringArray `gorm:"column:primary_learned_visit_days;type:jsonb"`
	PrimaryLearnedDeliveryDays StringArray `gorm:"column:primary_learned_delivery_days;type:jsonb"`
	PrimaryLearnedLeadTimeDays *int        `gorm:"column:primary_learned_lead_time_days"`
	PrimaryLearnedSampleCount  int         `gorm:"column:primary_learned_sample_count"`
}

type CheaperSupplierAlert struct {
	SupplierID   uint    `json:"supplierId"`
	SupplierName string  `json:"supplierName"`
	UnitPrice    float64 `json:"unitPrice"`
	Savings      float64 `json:"savings"`
	TotalSavings float64 `json:"totalSavings"`
}

type RestockSuggestionResponse struct {
	ProductRestockMetric
	InTransit       bool                  `json:"inTransit"`
	CheaperSupplier *CheaperSupplierAlert `json:"cheaperSupplier,omitempty"`

	// Señales calculadas en el momento de la consulta, siempre frescas.
	LastReceptionAt     *time.Time `json:"lastReceptionAt,omitempty"`
	DaysSinceReception  *int       `json:"daysSinceReception,omitempty"`
	SoldSinceReception  float64    `json:"soldSinceReception"`
	Recommendation      string     `json:"recommendation"`
	RecommendationLevel string     `json:"recommendationLevel"`

	// MinStock es el mínimo configurado en el producto y LiveStock la existencia
	// actual. Las métricas guardan el stock del último recálculo, así que el
	// semáforo de salud se calcula con estos dos valores en vivo.
	MinStock  float64 `json:"minStock"`
	LiveStock float64 `json:"liveStock"`

	// ========================================================================
	// SEMAFORO Y SUGERENCIA DE MINIMO (regla del dueno, agosto 2026)
	// ========================================================================
	//
	//   stockBand         string   banda del semaforo:
	//                              "RED"   ratio < 0.25
	//                              "YELLOW" 0.25 <= ratio < 0.75
	//                              "GREEN"  ratio >= 0.75
	//                              "UNSET" cuando minStock <= 0 y stock > 0
	//                              (no se juzga contra el minimo).
	//                              Se calcula EN VIVO con LiveStock + MinStock.
	//   suggestedMinStock float64  minimo mas realista sugerido. Fase 1 amplio
	//                              la sugerencia a AMBOS lados:
	//                                - subir cuando idealStock > minStock*1.25
	//                                - bajar cuando idealStock < minStock*0.5
	//                                - si minStock<=0 e idealStock>0 -> subir
	//                              0 (o campo ausente) significa que el minimo
	//                              actual esta bien puesto. El dueno decide;
	//                              el sistema NUNCA lo escribe solo.
	//   suggestedMinStockReason string
	//                              "increase" -> hay que subir el minimo
	//                              "decrease" -> hay que bajar el minimo
	//                              ""         -> no hay sugerencia
	//   orderReason       string   por que se pide, o por que no se pide:
	//                              "target"    -> se pide por objetivo 75%
	//                              "demand"    -> se pide por demanda hasta la
	//                                             proxima visita
	//                              "none"      -> no se pide
	//
	// Todos se calculan en vivo en buildRestockSuggestion, sin migracion.
	StockBand               string  `json:"stockBand"`
	SuggestedMinStock       float64 `json:"suggestedMinStock,omitempty"`
	SuggestedMinStockReason string  `json:"suggestedMinStockReason,omitempty"`
	OrderReason             string  `json:"orderReason"`

	// ========================================================================
	// VENTANAS DE DEMANDA 30 / 90 DIAS (Fase 1, agosto 2026)
	// ========================================================================
	// avgDailySales es la demanda EFECTIVA usada por el motor de pedidos
	// (max entre la ventana corta y la larga). Fase 1 expone las dos ventanas
	// separadas para que el front pueda dibujar tendencias y para justificar
	// por que la sugerencia es la que es.
	//
	//   totalSold30d      float64   ventas netas de los ultimos 30 dias
	//   totalSold90d      float64   ventas netas de los ultimos 90 dias
	//   avgDailySales30d  float64   demanda 30d = sold30 / (30 - daysZero30)
	//   avgDailySales90d  float64   demanda 90d = sold90 / (90 - daysZero90)
	//   daysZeroStock90d  int       dias sin stock en la ventana de 90 dias
	//
	// El campo avgDailySales heredado del batch nocturno guarda el valor
	// EFECTIVO (max entre 30d y 90d). Los dos nuevos son informativos y
	// pueden omitirse en callers antiguos con omitempty=false intencional.
	TotalSold90d     float64 `json:"totalSold90d"`
	AvgDailySales30d float64 `json:"avgDailySales30d"`
	AvgDailySales90d float64 `json:"avgDailySales90d"`
	DaysZeroStock90d int     `json:"daysZeroStock90d"`

	// ========================================================================
	// VENTANA CORTA DE 14 DIAS (2026-09-05)
	// ========================================================================
	// Es la SEÑAL PRINCIPAL de demanda desde que el dueño pidió apoyarse en lo
	// reciente: los proveedores vuelven en ~8 días, así que el promedio del
	// trimestre reacciona tarde.
	//
	// Se exponen para que la tarjeta pueda decir la verdad: mostraba
	// "VENTA 30 DÍAS" cuando el motor ya decidía con 14, y esa etiqueta mentía.
	TotalSold14d     float64 `json:"totalSold14d"`
	AvgDailySales14d float64 `json:"avgDailySales14d"`
	DaysZeroStock14d int     `json:"daysZeroStock14d"`

	// Fechas derivadas de los DIAS DE LA SEMANA. Reemplazan el "hoy + N días"
	// que antes salía de visit_frequency_days y quedaba demasiado lejos.
	//
	// La agenda vive en DOS bloques SEPARADOS por decisión de producto:
	//
	//   1) Bloque MANUAL (schedule.*): lo que el dueño configuró a mano.
	//        visitDays, deliveryDays          -> dias literales guardados
	//        scheduleHasConfigured            -> true si al menos hay 1 dia en
	//                                            visita y 1 en entrega
	//
	//   2) Bloque APRENDIDO (learned*): lo que el sistema observó del
	//      histórico de pedidos confirmados y recibidos. NUNCA sobreescribe
	//      el manual — vive en columnas learned_* aparte (migración 014).
	//        learnedVisitDays, learnedDeliveryDays
	//        learnedLeadTimeDays              -> null si no hay confianza
	//        learnedSampleCount               -> N pedidos que lo respaldan
	//        learnedAt                        -> ultimo recalculo (null si nunca)
	//
	// La UI debe mostrar los dos por separado: "tú configuraste X /
	// el sistema observó Y (con N pedidos de respaldo)". NUNCA mezclar.
	//
	// Fechas EFECTIVAS (nextVisitDate / nextDeliveryDate / daysUntilNextVisit):
	//   - Si hay agenda manual, se calculan con ella (agendaSource="manual").
	//   - Si NO hay manual pero SÍ hay aprendida con evidencia, se calculan
	//     con la aprendida (agendaSource="learned").
	//   - Si no hay ninguna, quedan en null (agendaSource="none").
	//
	// leadTimeSource cuenta de dónde salió supplierLeadDays:
	//     "configured_days"           = calculado con los días configurados
	//     "learned_days"              = mediana aprendida del histórico
	//     "explicit_lead_time"        = columna lead_time_days del proveedor
	//     "visit_frequency_learned"   = visit_frequency_days (aprendido, sospechoso)
	//     "default"                   = fallback de 7 días
	//
	// Formato de fechas: "YYYY-MM-DD" en zona America/Bogota.
	VisitDays             StringArray `json:"visitDays,omitempty"`
	DeliveryDays          StringArray `json:"deliveryDays,omitempty"`
	ScheduleHasConfigured bool        `json:"scheduleHasConfigured"`
	LearnedVisitDays      StringArray `json:"learnedVisitDays,omitempty"`
	LearnedDeliveryDays   StringArray `json:"learnedDeliveryDays,omitempty"`
	LearnedLeadTimeDays   *int        `json:"learnedLeadTimeDays,omitempty"`
	LearnedSampleCount    int         `json:"learnedSampleCount"`
	LearnedAt             *time.Time  `json:"learnedAt,omitempty"`
	NextVisitDate         *string     `json:"nextVisitDate,omitempty"`
	NextDeliveryDate      *string     `json:"nextDeliveryDate,omitempty"`
	DaysUntilNextVisit    *int        `json:"daysUntilNextVisit,omitempty"`
	LeadTimeSource        string      `json:"leadTimeSource"`
	AgendaSource          string      `json:"agendaSource"` // "manual" | "learned" | "none"
}

// InTransitProduct identifies an item that cannot be ordered again while pending.
type InTransitProduct struct {
	ProductID   string  `json:"productId" gorm:"column:product_id"`
	ProductName string  `json:"productName" gorm:"column:product_name"`
	Quantity    float64 `json:"quantity" gorm:"column:quantity"`
}
