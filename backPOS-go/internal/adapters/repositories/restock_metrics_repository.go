package repositories

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services/scheduling"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const restockBatchSize = 500

type RestockMetricsRepository struct {
	db *gorm.DB
}

func NewRestockMetricsRepository(db *gorm.DB) *RestockMetricsRepository {
	return &RestockMetricsRepository{db: db}
}

// GetSupplierName devuelve el nombre del proveedor para usarlo en mensajes
// dirigidos a personas (alertas de Telegram, auditoría).
//
// Nunca falla hacia arriba: si el proveedor no existe, fue borrado o la
// consulta falla, devuelve cadena vacía y el llamador decide el texto de
// respaldo. Una alerta es informativa; no vale la pena abortar la operación
// que la disparó porque no se pudo resolver una etiqueta.
func (r *RestockMetricsRepository) GetSupplierName(supplierID uint) string {
	if supplierID == 0 {
		return ""
	}
	var name string
	if err := r.db.Table("suppliers").
		Select("name").
		Where("id = ?", supplierID).
		Scan(&name).Error; err != nil {
		return ""
	}
	return strings.TrimSpace(name)
}

// LoadCalculationInputs loads sales, zero-stock days, transit and the current supplier
// for every active product with one parameterized query.
//
// El asOf define el borde superior del mes; el metodo deriva por su cuenta la
// ventana de 90 dias que Fase 1 introdujo. El primer parametro (`since30d`)
// se conserva por retrocompatibilidad con callers antiguos y por claridad al
// leer el SQL.
func (r *RestockMetricsRepository) LoadCalculationInputs(
	ctx context.Context,
	since time.Time,
	asOf time.Time,
) ([]models.RestockCalculationInput, error) {
	var inputs []models.RestockCalculationInput
	// Fase 1 (agosto 2026): el batch nocturno pide ambas ventanas de demanda
	// (30 y 90 dias) para poder tomar la mayor. Se calcula tambien
	// days_zero_stock por cada ventana; la de 30d se persiste como antes,
	// la de 90d se pasa como campo del input (no se persiste — no hay
	// columna correspondiente).
	//
	// Arreglo 4 (2026-08): ultima recepcion y consumo posterior siguen
	// precomputandose aca para que la pantalla no tenga que recalcularlos
	// en caliente.
	since90 := asOf.AddDate(0, 0, -90)
	// Ventana corta: es la señal principal de demanda desde el 2026-09-05.
	since14 := asOf.AddDate(0, 0, -14)
	// TRAMPA QUE ROMPIO EL BATCH NOCTURNO EN PRODUCCION (2026-09-04/05):
	//
	// La primera CTE se llamaba `sales`, igual que la TABLA real. En Postgres una
	// CTE SOMBREA a la tabla del mismo nombre para todo lo que venga despues, asi
	// que la CTE `consumo_posterior` (declarada mas abajo) hacia
	// `JOIN sales s ON s."saleId" = ...` creyendo que usaba la tabla y en realidad
	// resolvia a la CTE, que solo tiene product_id / total_sold_30d /
	// total_sold_90d. Resultado: "ERROR: no existe la columna s.saleId
	// (SQLSTATE 42703)" y el calculo nocturno completo abortaba cada noche.
	//
	// Se renombro a `ventas_por_producto`. REGLA: ninguna CTE de este archivo
	// puede llamarse igual que una tabla (sales, products, expenses...), porque
	// el error aparece lejos del nombre y es dificil de rastrear.
	err := r.db.WithContext(ctx).Raw(`
		WITH ventas_por_producto AS (
			SELECT sd.barcode AS product_id,
				SUM(CASE WHEN sa."saleDate" >= ? THEN sd.quantity ELSE 0 END)::numeric AS total_sold_14d,
				SUM(CASE WHEN sa."saleDate" >= ? THEN sd.quantity ELSE 0 END)::numeric AS total_sold_30d,
				SUM(sd.quantity)::numeric AS total_sold_90d
			FROM sale_details sd
			JOIN sales sa ON sa."saleId" = sd."saleId"
			WHERE sa."saleDate" >= ?
			  AND sa.deleted_at IS NULL
			  AND sd.deleted_at IS NULL
			  AND COALESCE(UPPER(sa.status), '') NOT IN ('CANCELED', 'CANCELLED')
			GROUP BY sd.barcode
		), zero_days AS (
			SELECT product_id,
				COUNT(DISTINCT snapshot_date) FILTER (WHERE snapshot_date > CAST(? AS date))::integer AS days_zero_stock_14d,
				COUNT(DISTINCT snapshot_date) FILTER (WHERE snapshot_date > CAST(? AS date))::integer AS days_zero_stock_30d,
				COUNT(DISTINCT snapshot_date)::integer AS days_zero_stock_90d
			FROM daily_stock_snapshots
			WHERE snapshot_date > CAST(? AS date)
			  AND snapshot_date < CAST(? AS date)
			  AND was_zero = TRUE
			GROUP BY product_id
		), transit AS (
			SELECT product_id, SUM(quantity)::numeric AS quantity
			FROM (
				SELECT coi.product_id, SUM(coi.quantity)::numeric AS quantity
				FROM confirmed_order_items coi
				JOIN confirmed_orders co ON co.id = coi.confirmed_order_id
				WHERE co.status IN ('pending', 'in_transit')
				GROUP BY coi.product_id
				UNION ALL
				SELECT poi."productBarcode" AS product_id, SUM(poi.quantity)::numeric AS quantity
				FROM purchase_order_items poi
				JOIN purchase_orders po ON po.id = poi."orderId"
				WHERE po.status IN ('PENDING', 'IN_TRANSIT')
				  AND po.deleted_at IS NULL
				  AND poi.deleted_at IS NULL
				GROUP BY poi."productBarcode"
			) pending
			GROUP BY product_id
		), ultima_recepcion AS (
			SELECT barcode, MAX(date) AS last_reception_at
			FROM stock_movements
			WHERE reason = 'RECEPTION'
			GROUP BY barcode
		), consumo_posterior AS (
			SELECT sd.barcode, COALESCE(SUM(sd.quantity), 0)::numeric AS sold_since_reception
			FROM sale_details sd
			JOIN sales s ON s."saleId" = sd."saleId"
			JOIN ultima_recepcion ur ON ur.barcode = sd.barcode
			WHERE s.deleted_at IS NULL
			  AND UPPER(s.status) IN ('PAID', 'CREDIT')
			  AND s."saleDate" >= ur.last_reception_at
			GROUP BY sd.barcode
		)
		SELECT
			p.barcode AS product_id,
			p."productName" AS product_name,
			COALESCE(p.quantity, 0)::numeric AS current_stock,
			COALESCE(v.total_sold_14d, 0)::numeric AS total_sold_14d,
			COALESCE(v.total_sold_30d, 0)::numeric AS total_sold_30d,
			COALESCE(v.total_sold_90d, 0)::numeric AS total_sold_90d,
			LEAST(14, COALESCE(z.days_zero_stock_14d, 0) +
				CASE WHEN COALESCE(p.quantity, 0) <= 0 THEN 1 ELSE 0 END)::integer AS days_zero_stock_14d,
			LEAST(30, COALESCE(z.days_zero_stock_30d, 0) +
				CASE WHEN COALESCE(p.quantity, 0) <= 0 THEN 1 ELSE 0 END)::integer AS days_zero_stock,
			LEAST(90, COALESCE(z.days_zero_stock_90d, 0) +
				CASE WHEN COALESCE(p.quantity, 0) <= 0 THEN 1 ELSE 0 END)::integer AS days_zero_stock_90d,
			COALESCE(t.quantity, 0)::numeric AS in_transit_qty,
			COALESCE(p."minStock", 0)::numeric AS min_stock,
			primary_supplier.supplier_id AS primary_supplier_id,
			COALESCE(primary_supplier.supplier_name, '') AS supplier_name,
			COALESCE(primary_supplier.lead_days, 7)::integer AS supplier_lead_days,
			COALESCE(primary_supplier.unit_cost, p."purchasePrice", 0)::numeric AS unit_cost,
			primary_supplier.visit_days AS primary_visit_days,
			primary_supplier.delivery_days AS primary_delivery_days,
			primary_supplier.legacy_visit_day AS primary_legacy_visit_day,
			primary_supplier.legacy_delivery_day AS primary_legacy_delivery_day,
			primary_supplier.explicit_lead_time_days AS primary_explicit_lead_time_days,
			COALESCE(primary_supplier.visit_frequency_days, 0)::integer AS primary_visit_frequency_days,
			primary_supplier.learned_visit_days AS primary_learned_visit_days,
			primary_supplier.learned_delivery_days AS primary_learned_delivery_days,
			primary_supplier.learned_lead_time_days AS primary_learned_lead_time_days,
			COALESCE(primary_supplier.learned_sample_count, 0)::integer AS primary_learned_sample_count,
			ur.last_reception_at,
			COALESCE(cp.sold_since_reception, 0)::numeric AS sold_since_reception
		FROM products p
		LEFT JOIN ventas_por_producto v ON v.product_id = p.barcode
		LEFT JOIN zero_days z ON z.product_id = p.barcode
		LEFT JOIN transit t ON t.product_id = p.barcode
		LEFT JOIN ultima_recepcion ur ON ur.barcode = p.barcode
		LEFT JOIN consumo_posterior cp ON cp.barcode = p.barcode
		LEFT JOIN LATERAL (
			SELECT candidate.supplier_id, candidate.supplier_name,
			       candidate.lead_days, candidate.unit_cost,
			       candidate.visit_days, candidate.delivery_days,
			       candidate.legacy_visit_day, candidate.legacy_delivery_day,
			       candidate.explicit_lead_time_days, candidate.visit_frequency_days,
			       candidate.learned_visit_days, candidate.learned_delivery_days,
			       candidate.learned_lead_time_days, candidate.learned_sample_count
			FROM (
				SELECT 0 AS priority, s.id AS supplier_id, s.name AS supplier_name,
				       COALESCE(NULLIF(s.lead_time_days, 0), NULLIF(s.visit_frequency_days, 0), 7) AS lead_days,
				       COALESCE(NULLIF(ps."purchasePrice", 0), NULLIF(p."purchasePrice", 0), 0) AS unit_cost,
				       s.visit_days, s.delivery_days,
				       s."visitDay" AS legacy_visit_day,
				       s."deliveryDay" AS legacy_delivery_day,
				       s.lead_time_days AS explicit_lead_time_days,
				       s.visit_frequency_days,
				       s.learned_visit_days, s.learned_delivery_days,
				       s.learned_lead_time_days, s.learned_sample_count
				FROM suppliers s
				LEFT JOIN product_suppliers ps
				  ON ps.supplier_id = s.id AND ps.product_barcode = p.barcode
				WHERE p."supplierId" IS NOT NULL
				  AND s.id = p."supplierId"
				  AND s.deleted_at IS NULL
				UNION ALL
				SELECT 1 AS priority, s.id AS supplier_id, s.name AS supplier_name,
				       COALESCE(NULLIF(s.lead_time_days, 0), NULLIF(s.visit_frequency_days, 0), 7) AS lead_days,
				       COALESCE(NULLIF(ps."purchasePrice", 0), NULLIF(p."purchasePrice", 0), 0) AS unit_cost,
				       s.visit_days, s.delivery_days,
				       s."visitDay" AS legacy_visit_day,
				       s."deliveryDay" AS legacy_delivery_day,
				       s.lead_time_days AS explicit_lead_time_days,
				       s.visit_frequency_days,
				       s.learned_visit_days, s.learned_delivery_days,
				       s.learned_lead_time_days, s.learned_sample_count
				FROM product_suppliers ps
				JOIN suppliers s ON s.id = ps.supplier_id
				WHERE ps.product_barcode = p.barcode
				  AND (p."supplierId" IS NULL OR ps.supplier_id <> p."supplierId")
				  AND s.deleted_at IS NULL
			) candidate
			ORDER BY candidate.priority ASC, candidate.unit_cost ASC, candidate.supplier_id ASC
			LIMIT 1
		) primary_supplier ON TRUE
		WHERE p.deleted_at IS NULL AND COALESCE(p."isActive", TRUE) = TRUE
		ORDER BY p.barcode
	`, since14, since, since90, since14, since, since90, asOf).Scan(&inputs).Error
	return inputs, err
}

// SaveNightlyBatch atomically replaces the daily snapshots and latest metrics.
func (r *RestockMetricsRepository) SaveNightlyBatch(
	ctx context.Context,
	snapshots []models.DailyStockSnapshot,
	metrics []models.ProductRestockMetric,
) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if len(snapshots) > 0 {
			if err := tx.Clauses(clause.OnConflict{
				Columns: []clause.Column{{Name: "product_id"}, {Name: "snapshot_date"}},
				DoUpdates: clause.AssignmentColumns([]string{
					"closing_stock", "was_zero",
				}),
			}).CreateInBatches(&snapshots, restockBatchSize).Error; err != nil {
				return err
			}
		}

		if len(metrics) > 0 {
			if err := tx.Clauses(clause.OnConflict{
				Columns: []clause.Column{{Name: "product_id"}},
				DoUpdates: clause.AssignmentColumns([]string{
					"product_name", "total_sold_30d", "days_with_stock", "days_zero_stock",
					"avg_daily_sales", "abc_category", "current_stock", "in_transit_qty",
					"ideal_stock", "suggested_order_qty", "primary_supplier_id", "supplier_name",
					"supplier_lead_days", "unit_cost", "calculated_at",
					// Arreglo 4: columnas nuevas persistidas por el batch nocturno.
					"last_reception_at", "sold_since_reception",
				}),
			}).CreateInBatches(&metrics, restockBatchSize).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

type restockSuggestionRow struct {
	models.ProductRestockMetric
	CheaperSupplierID   *uint   `gorm:"column:cheaper_supplier_id"`
	CheaperSupplierName *string `gorm:"column:cheaper_supplier_name"`
	CheaperUnitPrice    float64 `gorm:"column:cheaper_unit_price"`
	Savings             float64 `gorm:"column:savings"`
	TotalSavings        float64 `gorm:"column:total_savings"`
	// last_reception_at y sold_since_reception se leen embebidos vía
	// ProductRestockMetric (columnas persistidas por el batch nocturno,
	// migración 013). Ver GetSuggestions para el detalle.
	DaysSinceReception *int    `gorm:"column:days_since_reception"`
	MinStock           float64 `gorm:"column:min_stock"`
	LiveStock          float64 `gorm:"column:live_stock"`
	LiveInTransitQty   float64 `gorm:"column:live_in_transit_qty"`

	// ========================================================================
	// PROVEEDOR EFECTIVO
	// ========================================================================
	// El proveedor "efectivo" es el que se le va a comprar al producto:
	//   - Sin filtro (supplier_id = 0): coincide con el primario que ya vive
	//     en m.primary_supplier_id / m.supplier_name / m.unit_cost.
	//   - Con filtro activo: es el proveedor seleccionado. Los siguientes
	//     campos traen sus datos y se usan para SOBREESCRIBIR los del
	//     primario antes de responder al frontend.
	// Si el proveedor no existe (borrado) los punteros quedan en nil y se
	// deja el primario tal cual.
	EffectiveSupplierID        *uint              `gorm:"column:effective_supplier_id"`
	EffectiveSupplierName      *string            `gorm:"column:effective_supplier_name"`
	EffectiveUnitCost          *float64           `gorm:"column:effective_unit_cost"`
	EffectiveVisitDays         models.StringArray `gorm:"column:effective_visit_days;type:jsonb"`
	EffectiveDeliveryDays      models.StringArray `gorm:"column:effective_delivery_days;type:jsonb"`
	EffectiveLegacyVisitDay    *string            `gorm:"column:effective_legacy_visit_day"`
	EffectiveLegacyDeliveryDay *string            `gorm:"column:effective_legacy_delivery_day"`
	EffectiveLeadTimeDays      *int               `gorm:"column:effective_lead_time_days"`
	EffectiveVisitFrequency    int                `gorm:"column:effective_visit_frequency_days"`

	// Agenda APRENDIDA por el batch nocturno (migracion 014). Vive en
	// columnas separadas de las manuales; el frontend las muestra por
	// separado ("tu configuraste esto / el sistema observo esto otro").
	// Antes de que la migracion se aplique, todas estas quedan NULL / 0 y
	// la respuesta degrada limpio (sin fechas aprendidas y sin exponer un
	// SampleCount que sugiera confianza).
	EffectiveLearnedVisitDays    models.StringArray `gorm:"column:effective_learned_visit_days;type:jsonb"`
	EffectiveLearnedDeliveryDays models.StringArray `gorm:"column:effective_learned_delivery_days;type:jsonb"`
	EffectiveLearnedLeadTimeDays *int               `gorm:"column:effective_learned_lead_time_days"`
	EffectiveLearnedSampleCount  int                `gorm:"column:effective_learned_sample_count"`
	EffectiveLearnedAt           *time.Time         `gorm:"column:effective_learned_at"`

	// Ventanas de venta 30d/90d en vivo (Fase 1, agosto 2026). Se
	// computan cada request desde sale_details + daily_stock_snapshots
	// porque no hay columnas persistidas para 90d en
	// product_restock_metrics. Los campos permiten exponer al frontend
	// avgDailySales30d/90d y totalSold90d sin depender del batch nocturno.
	LiveTotalSold14d float64 `gorm:"column:live_total_sold_14d"`
	LiveTotalSold30d float64 `gorm:"column:live_total_sold_30d"`
	LiveTotalSold90d float64 `gorm:"column:live_total_sold_90d"`
	LiveDaysZero14d  int     `gorm:"column:live_days_zero_14d"`
	LiveDaysZero30d  int     `gorm:"column:live_days_zero_30d"`
	LiveDaysZero90d  int     `gorm:"column:live_days_zero_90d"`
	// Historial de cantidades recibidas, agrupado en JSON: [{"q":12,"t":4},...].
	// Alimenta models.LearnPackSize para deducir el empaque.
	PackHistory string `gorm:"column:pack_history"`
}

// SuggestionQueryParams son los filtros que acepta /restock/suggestions-v2.
//
// Bajo Fase 1 (agosto 2026):
//   - SupplierID filtra por proveedor primario o via product_suppliers.
//   - Search filtra en el servidor por nombre de producto o barcode; se
//     trimmea y se limita a MaxSearchLength caracteres para evitar consultas
//     absurdas. Nunca se concatena: viaja como parametro SQL.
//   - IncludeAll gobierna si la respuesta lleva las filas VERDES/UNSET sin
//     pedido. Por defecto false: la pantalla muestra solo lo accionable
//     (ROJO, AMARILLO o suggestedOrderQty>0). El operador puede activar
//     "ver todo" desde la UI para revisar el catalogo completo.
//   - UnassignedOnly exige ausencia viva tanto de supplierId como de enlaces
//     en product_suppliers; es incompatible con SupplierID.
type SuggestionQueryParams struct {
	SupplierID     *uint
	Search         string
	IncludeAll     bool
	UnassignedOnly bool
}

const restockSuggestionsSQL = `
WITH candidatos AS (
	-- SE ARRANCA DESDE products, NO DESDE LAS METRICAS.
	--
	-- Antes era "FROM product_restock_metrics m JOIN products p", un JOIN
	-- INTERNO: un producto sin fila en la tabla de metricas simplemente NO
	-- EXISTIA para esta pantalla. Y esa tabla la llena el batch nocturno, que
	-- estuvo abortando por un error de SQL, asi que todo producto creado o
	-- reactivado despues de la ultima corrida buena quedaba invisible. El dueno
	-- lo reporto tres veces como "no me trae todos los productos del proveedor",
	-- y no habia filtro que lo explicara: la fila nunca llegaba.
	--
	-- Con LEFT JOIN el producto SIEMPRE aparece. Sin metricas su demanda es 0,
	-- pero sigue siendo pedible por su stock minimo (TargetShortfall solo
	-- necesita minimo, existencia y transito), asi que un batch caido degrada a
	-- "sin demanda calculada" en vez de esconder inventario.
	SELECT
		p.barcode AS product_id,
		COALESCE(m.product_name, p."productName") AS product_name,
		COALESCE(m.total_sold_30d, 0)::numeric AS total_sold_30d,
		COALESCE(m.days_with_stock, 0)::integer AS days_with_stock,
		COALESCE(m.days_zero_stock, 0)::integer AS days_zero_stock,
		COALESCE(m.avg_daily_sales, 0)::numeric AS avg_daily_sales,
		COALESCE(NULLIF(m.abc_category, ''), 'C') AS abc_category,
		COALESCE(p.quantity, m.current_stock, 0)::numeric AS current_stock,
		COALESCE(m.in_transit_qty, 0)::numeric AS in_transit_qty,
		COALESCE(m.ideal_stock, 0)::numeric AS ideal_stock,
		COALESCE(m.suggested_order_qty, 0)::numeric AS suggested_order_qty,
		COALESCE(m.primary_supplier_id, p."supplierId") AS primary_supplier_id,
		COALESCE(m.supplier_name, '') AS supplier_name,
		COALESCE(m.supplier_lead_days, 0)::integer AS supplier_lead_days,
		COALESCE(m.unit_cost, p."purchasePrice", 0)::numeric AS unit_cost,
		m.calculated_at,
		m.last_reception_at,
		COALESCE(m.sold_since_reception, 0)::numeric AS sold_since_reception,
		COALESCE(p."minStock", 0)::numeric AS min_stock,
		COALESCE(p.quantity, 0)::numeric AS live_stock,
		COALESCE(p."purchasePrice", 0)::numeric AS product_purchase_price
	FROM products p
	LEFT JOIN product_restock_metrics m ON m.product_id = p.barcode
	WHERE p.deleted_at IS NULL
	  AND COALESCE(p."isActive", TRUE) = TRUE
	  AND (
		(@unassigned_only = TRUE
		 AND p."supplierId" IS NULL
		 AND NOT EXISTS (
			SELECT 1 FROM product_suppliers orphan_links
			WHERE orphan_links.product_barcode = p.barcode
		 ))
		OR
		(@unassigned_only = FALSE AND (
			@supplier_id = 0
			OR p."supplierId" = @supplier_id
			OR EXISTS (
				SELECT 1 FROM product_suppliers supplier_links
				WHERE supplier_links.product_barcode = p.barcode
				  AND supplier_links.supplier_id = @supplier_id
			)
		))
	  )
	  AND (
		@search = ''
		OR p."productName" ILIKE '%' || @search || '%'
		OR p.barcode ILIKE '%' || @search || '%'
	  )
), transito_vivo AS (
	SELECT product_id, SUM(quantity)::numeric AS quantity
	FROM (
		SELECT coi.product_id, SUM(coi.quantity)::numeric AS quantity
		FROM confirmed_order_items coi
		JOIN candidatos c ON c.product_id = coi.product_id
		JOIN confirmed_orders co ON co.id = coi.confirmed_order_id
		WHERE co.status IN ('pending', 'in_transit')
		GROUP BY coi.product_id
		UNION ALL
		SELECT poi."productBarcode" AS product_id, SUM(poi.quantity)::numeric AS quantity
		FROM purchase_order_items poi
		JOIN candidatos c ON c.product_id = poi."productBarcode"
		JOIN purchase_orders po ON po.id = poi."orderId"
		WHERE po.status IN ('PENDING', 'IN_TRANSIT')
		  AND po.deleted_at IS NULL
		  AND poi.deleted_at IS NULL
		GROUP BY poi."productBarcode"
	) pendientes
	GROUP BY product_id
), ventas_vivas AS (
	SELECT sd.barcode AS product_id,
	       SUM(CASE WHEN sa."saleDate" >= NOW() - INTERVAL '14 days' THEN sd.quantity ELSE 0 END)::numeric AS total_sold_14d,
	       SUM(CASE WHEN sa."saleDate" >= NOW() - INTERVAL '30 days' THEN sd.quantity ELSE 0 END)::numeric AS total_sold_30d,
	       SUM(sd.quantity)::numeric AS total_sold_90d
	FROM sale_details sd
	JOIN candidatos c ON c.product_id = sd.barcode
	JOIN sales sa ON sa."saleId" = sd."saleId"
	WHERE sa."saleDate" >= NOW() - INTERVAL '90 days'
	  AND sa.deleted_at IS NULL
	  AND sd.deleted_at IS NULL
	  AND COALESCE(UPPER(sa.status), '') NOT IN ('CANCELED', 'CANCELLED')
	GROUP BY sd.barcode
), empaque_aprendido AS (
	-- EMPAQUE APRENDIDO DE LAS RECEPCIONES (2026-09-05).
	--
	-- Se agrupan las cantidades recibidas por producto, se cuenta cuantas veces
	-- se repitio cada una, y se entrega el resumen como JSON: una fila por
	-- producto. La decision de cual es el empaque la toma models.LearnPackSize en
	-- Go, que exige REPETICION (no divisor comun) para no inventar cajas donde
	-- solo hubo pedidos sueltos.
	--
	-- Se agrupa en la base y no se trae el historial completo para no mover miles
	-- de filas en cada consulta de sugerencias.
	SELECT product_id,
	       json_agg(json_build_object('q', quantity, 't', times))::text AS historial
	FROM (
		SELECT sm.barcode AS product_id,
		       sm.quantity::numeric AS quantity,
		       COUNT(*)::integer AS times
		FROM stock_movements sm
		JOIN candidatos c ON c.product_id = sm.barcode
		WHERE sm.reason = 'RECEPTION'
		  AND sm.quantity > 1
		GROUP BY sm.barcode, sm.quantity
	) recepciones_agrupadas
	GROUP BY product_id
), dias_cero AS (
	SELECT dss.product_id,
	       COUNT(DISTINCT dss.snapshot_date) FILTER (WHERE dss.snapshot_date >= CURRENT_DATE - 14) AS days_zero_14d,
	       COUNT(DISTINCT dss.snapshot_date) FILTER (WHERE dss.snapshot_date >= CURRENT_DATE - 30) AS days_zero_30d,
	       COUNT(DISTINCT dss.snapshot_date) AS days_zero_90d
	FROM daily_stock_snapshots dss
	JOIN candidatos c ON c.product_id = dss.product_id
	WHERE dss.snapshot_date >= CURRENT_DATE - 90
	  AND dss.snapshot_date < CURRENT_DATE
	  AND dss.was_zero = TRUE
	GROUP BY dss.product_id
)
SELECT
	c.*,
	alternative.supplier_id AS cheaper_supplier_id,
	alternative.supplier_name AS cheaper_supplier_name,
	COALESCE(alternative.unit_price, 0)::numeric AS cheaper_unit_price,
	COALESCE(effective.unit_cost - alternative.unit_price, 0)::numeric AS savings,
	COALESCE((effective.unit_cost - alternative.unit_price) * c.suggested_order_qty, 0)::numeric AS total_savings,
	CASE
		WHEN c.last_reception_at IS NULL THEN NULL
		ELSE FLOOR(EXTRACT(EPOCH FROM (NOW() - c.last_reception_at)) / 86400)::int
	END AS days_since_reception,
	COALESCE(tv.quantity, 0)::numeric AS live_in_transit_qty,
	effective.supplier_id AS effective_supplier_id,
	effective.supplier_name AS effective_supplier_name,
	effective.unit_cost AS effective_unit_cost,
	effective.visit_days AS effective_visit_days,
	effective.delivery_days AS effective_delivery_days,
	effective."visitDay" AS effective_legacy_visit_day,
	effective."deliveryDay" AS effective_legacy_delivery_day,
	effective.lead_time_days AS effective_lead_time_days,
	COALESCE(effective.visit_frequency_days, 0) AS effective_visit_frequency_days,
	effective.learned_visit_days AS effective_learned_visit_days,
	effective.learned_delivery_days AS effective_learned_delivery_days,
	effective.learned_lead_time_days AS effective_learned_lead_time_days,
	COALESCE(effective.learned_sample_count, 0) AS effective_learned_sample_count,
	effective.learned_at AS effective_learned_at,
	COALESCE(vv.total_sold_14d, 0)::numeric AS live_total_sold_14d,
	COALESCE(vv.total_sold_30d, 0)::numeric AS live_total_sold_30d,
	COALESCE(vv.total_sold_90d, 0)::numeric AS live_total_sold_90d,
	COALESCE(dc.days_zero_14d, 0)::integer AS live_days_zero_14d,
	COALESCE(dc.days_zero_30d, 0)::integer AS live_days_zero_30d,
	COALESCE(dc.days_zero_90d, 0)::integer AS live_days_zero_90d,
	COALESCE(ea.historial, '[]') AS pack_history
FROM candidatos c
LEFT JOIN transito_vivo tv ON tv.product_id = c.product_id
LEFT JOIN ventas_vivas vv ON vv.product_id = c.product_id
LEFT JOIN dias_cero dc ON dc.product_id = c.product_id
LEFT JOIN empaque_aprendido ea ON ea.product_id = c.product_id
LEFT JOIN LATERAL (
	SELECT s.id AS supplier_id,
	       s.name AS supplier_name,
	       s.visit_days,
	       s.delivery_days,
	       s."visitDay",
	       s."deliveryDay",
	       s.lead_time_days,
	       s.visit_frequency_days,
	       s.learned_visit_days,
	       s.learned_delivery_days,
	       s.learned_lead_time_days,
	       s.learned_sample_count,
	       s.learned_at,
	       COALESCE(
	           NULLIF(ps."purchasePrice", 0),
	           NULLIF(c.product_purchase_price, 0),
	           NULLIF(c.unit_cost, 0),
	           0
	       )::numeric AS unit_cost
	FROM suppliers s
	LEFT JOIN product_suppliers ps
	  ON ps.supplier_id = s.id AND ps.product_barcode = c.product_id
	WHERE s.deleted_at IS NULL
	  AND @unassigned_only = FALSE
	  AND (
	    (@supplier_id != 0 AND s.id = @supplier_id)
	    OR (@supplier_id = 0 AND s.id = c.primary_supplier_id)
	  )
	LIMIT 1
) effective ON TRUE
LEFT JOIN LATERAL (
	SELECT ps.supplier_id, s.name AS supplier_name,
	       ps."purchasePrice"::numeric AS unit_price
	FROM product_suppliers ps
	JOIN suppliers s ON s.id = ps.supplier_id
	WHERE ps.product_barcode = c.product_id
	  AND (effective.supplier_id IS NULL OR ps.supplier_id <> effective.supplier_id)
	  AND ps."purchasePrice" > 0
	  AND effective.unit_cost > 0
	  AND ps."purchasePrice" < effective.unit_cost
	  AND s.deleted_at IS NULL
	ORDER BY ps."purchasePrice" ASC, ps.supplier_id ASC
	LIMIT 1
) alternative ON TRUE
`

// MaxSuggestionSearchLength limita el largo de search para evitar tanto un
// abuso de recursos como un patron ILIKE absurdamente costoso.
const MaxSuggestionSearchLength = 100

// GetSuggestions loads metrics and the cheapest alternative supplier.
//
// ================================================================================
// CONTRATO JSON DEVUELTO POR /restock/suggestions-v2 (Fase 1, agosto 2026)
// ================================================================================
// Query params:
//
//	supplier_id  int (opcional). 0 o ausente -> sin filtro.
//	search       string (opcional). Trimmea y filtra por producto/barcode.
//	include_all  bool (opcional). Default false. Si false, retorna solo las
//	             filas accionables (RED, YELLOW o suggestedOrderQty>0). Si
//	             true, retorna todo lo que cumpla proveedor+search.
//
// Estructura de cada elemento del array (RestockSuggestionResponse):
//
//	id                       uint      métrica persistida (interno)
//	productId                string    barcode del producto
//	productName              string    nombre del producto
//	totalSold30d             float64   ventas ultimos 30 dias (netas)
//	totalSold90d             float64   ventas ultimos 90 dias (netas)
//	daysWithStock            int       dias con stock en los 30 dias
//	daysZeroStock            int       dias sin stock en los 30 dias
//	daysZeroStock90d         int       dias sin stock en los 90 dias
//	avgDailySales            float64   demanda EFECTIVA (max entre 30d y 90d)
//	avgDailySales30d         float64   demanda ventana 30d
//	avgDailySales90d         float64   demanda ventana 90d
//	abcCategory              "A"|"B"|"C"
//	currentStock             float64   existencia de la ultima corrida
//	inTransitQty             float64   en camino en vivo
//	idealStock               float64   objetivo por demanda (con colchon ABC)
//	suggestedOrderQty        float64   cantidad sugerida HOY (max de objetivo/demanda)
//	primarySupplierId        uint|null id del proveedor a atribuir
//	supplierName             string    nombre del proveedor a atribuir
//	supplierLeadDays         int       lead time efectivo aplicado
//	unitCost                 float64   costo unitario que aplica al pedido
//	calculatedAt             string    ISO datetime del ultimo batch
//	lastReceptionAt          string?   ISO datetime, null si no hay dato
//	soldSinceReception       float64   vendidas desde la ultima recepcion
//	inTransit                bool      true si liveInTransitQty > 0
//	cheaperSupplier          object?   (informativo)
//	daysSinceReception       int|null  derivado de lastReceptionAt
//	recommendation           string    texto listo para pintar
//	recommendationLevel      "urgent"|"order"|"wait"|"skip"
//	minStock                 float64   minimo configurado (leido en vivo)
//	liveStock                float64   existencia AHORA (no de la corrida)
//
// ---- SEMAFORO Y SUGERENCIAS (Fase 1) ----
//
//	stockBand                "RED" ratio<0.25 | "YELLOW" 0.25<=ratio<0.75
//	                          "GREEN" ratio>=0.75 | "UNSET" minStock<=0 y stock>0
//	suggestedMinStock        float64  minimo sugerido (0 = sin sugerencia)
//	suggestedMinStockReason  "increase" | "decrease" | ""
//	orderReason              "target" | "demand" | "none"
//
// La cantidad a pedir sale del MAX de:
//
//	(a) POR OBJETIVO: ceil(max(0, minStock*0.75 - available)). Aplica a
//	    ROJO y AMARILLO; en VERDE naturalmente da 0.
//	(b) POR DEMANDA:  max(0, idealStock - available). Aplica a TODAS las
//	    clases (incluida C).
//
// donde available = liveStock + liveInTransitQty.
//
// La clase ABC ya no bloquea pedidos. La agenda manual sigue siendo
// propiedad exclusiva del dueno; ningun proceso automatico la escribe.
//
// ---- AGENDA Y FECHAS ----
//
//	visitDays, deliveryDays, scheduleHasConfigured -> configuracion manual
//	learnedVisitDays, learnedDeliveryDays, learnedLeadTimeDays,
//	learnedSampleCount, learnedAt -> agenda aprendida por el batch nocturno
//	nextVisitDate, nextDeliveryDate, daysUntilNextVisit -> fechas efectivas
//	agendaSource: "manual" | "learned" | "none"
//	leadTimeSource: "configured_days" | "learned_days" | "explicit_lead_time"
//	               | "visit_frequency_learned" | "default"
//
// ---- ORDEN AUTORITATIVO ----
// Se ordena en Go tras construir las respuestas (los criterios dependen
// de valores calculados en vivo):
//  1. Banda: RED > YELLOW > GREEN > UNSET.
//  2. Dentro de cada banda: suggestedOrderQty > 0 primero.
//  3. Menor coverageDays (available / avgDailySales).
//  4. Mayor avgDailySales.
//  5. Nombre del producto ascendente.
//
// ================================================================================
func normalizeSuggestionSearch(search string) string {
	search = strings.TrimSpace(search)
	runes := []rune(search)
	if len(runes) > MaxSuggestionSearchLength {
		search = string(runes[:MaxSuggestionSearchLength])
	}
	return search
}

func restockSuggestionQueryArgs(filterSupplierID uint, unassignedOnly bool, search string) []any {
	return []any{
		sql.Named("supplier_id", filterSupplierID),
		sql.Named("unassigned_only", unassignedOnly),
		sql.Named("search", normalizeSuggestionSearch(search)),
	}
}

func (r *RestockMetricsRepository) GetSuggestions(
	ctx context.Context,
	params SuggestionQueryParams,
) ([]models.RestockSuggestionResponse, error) {
	if params.UnassignedOnly && params.SupplierID != nil {
		return nil, errors.New("unassigned_only no se puede combinar con supplier_id")
	}

	filterSupplierID := uint(0)
	if params.SupplierID != nil {
		filterSupplierID = *params.SupplierID
	}

	var rows []restockSuggestionRow
	err := r.db.WithContext(ctx).Raw(
		restockSuggestionsSQL,
		restockSuggestionQueryArgs(filterSupplierID, params.UnassignedOnly, params.Search)...,
	).Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	// Zona horaria del proyecto: America/Bogota. Igual que en el resto de
	// jobs y servicios. Se resuelve una sola vez.
	loc, err := time.LoadLocation("America/Bogota")
	if err != nil {
		// En Windows sin tzdata LoadLocation puede fallar; caemos al mismo
		// offset fijo que el resto del proyecto usa.
		loc = time.FixedZone("America/Bogota", -5*60*60)
	}
	nowInBogota := time.Now().In(loc)

	response := make([]models.RestockSuggestionResponse, 0, len(rows))
	for _, row := range rows {
		// En modo huérfanos la vinculación viva manda sobre cualquier métrica
		// nocturna obsoleta: nunca se atribuye el producto a ese proveedor viejo.
		if params.UnassignedOnly {
			row.ProductRestockMetric.PrimarySupplierID = nil
			row.ProductRestockMetric.SupplierName = ""
		}
		// Filtro activo pero el proveedor seleccionado no se pudo resolver
		// (borrado logico posterior a la creacion del product_suppliers).
		if filterSupplierID != 0 && row.EffectiveSupplierID == nil {
			continue
		}
		item := buildRestockSuggestion(row, nowInBogota)

		// CON UN PROVEEDOR ELEGIDO SE MUESTRAN TODOS SUS PRODUCTOS.
		//
		// El dueño lo reclamó TRES veces: "no me esta trayendo todos los
		// productos que tiene un proveedor". El filtro de "solo prioridades"
		// tiene sentido en la vista GLOBAL —evita mandar miles de tarjetas al
		// celular— pero no cuando ya elegiste proveedor: si estás armando el
		// pedido de JORDANIA querés ver el catálogo de JORDANIA y decidir vos,
		// no solo lo que está en rojo.
		//
		// Es el mismo criterio que ya se aplicaba al modo huérfanos, que fuerza
		// include_all porque ahí el objetivo es revisar todo lo pendiente.
		mostrarTodo := params.IncludeAll || filterSupplierID != 0
		if !mostrarTodo {
			if item.StockBand == models.StockBandGreen || item.StockBand == models.StockBandUnset {
				if item.SuggestedOrderQty <= 0 {
					continue
				}
			}
		}
		response = append(response, item)
	}

	sortSuggestionsByBandAndUrgency(response)
	return response, nil
}

// sortSuggestionsByBandAndUrgency aplica el orden autoritativo de Fase 1:
//  1. Banda RED > YELLOW > GREEN > UNSET.
//  2. suggestedOrderQty > 0 primero dentro de cada banda.
//  3. Menor coverageDays (existencia / demanda diaria).
//  4. Mayor avgDailySales.
//  5. Nombre del producto ascendente.
//
// coverageDays se define como (liveStock + liveInTransitQty) / avgDailySales
// cuando avgDailySales > 0; para productos sin demanda el orden por
// coverage no aplica y quedan resueltos por los siguientes desempates.
func sortSuggestionsByBandAndUrgency(items []models.RestockSuggestionResponse) {
	bandOrder := func(band string) int {
		switch band {
		case models.StockBandRed:
			return 0
		case models.StockBandYellow:
			return 1
		case models.StockBandGreen:
			return 2
		default:
			return 3
		}
	}
	coverageDays := func(item models.RestockSuggestionResponse) float64 {
		if item.AvgDailySales <= 0 {
			return math.MaxFloat64
		}
		return (item.LiveStock + item.InTransitQty) / item.AvgDailySales
	}
	sort.SliceStable(items, func(i, j int) bool {
		bi := bandOrder(items[i].StockBand)
		bj := bandOrder(items[j].StockBand)
		if bi != bj {
			return bi < bj
		}
		// Con pedido primero.
		pi := items[i].SuggestedOrderQty > 0
		pj := items[j].SuggestedOrderQty > 0
		if pi != pj {
			return pi
		}
		// Menor cobertura.
		ci := coverageDays(items[i])
		cj := coverageDays(items[j])
		if ci != cj {
			return ci < cj
		}
		// Mayor demanda diaria.
		if items[i].AvgDailySales != items[j].AvgDailySales {
			return items[i].AvgDailySales > items[j].AvgDailySales
		}
		// Nombre ascendente.
		return items[i].ProductName < items[j].ProductName
	})
}

// buildRestockSuggestion es la parte PURA de GetSuggestions: dado un row
// devuelto por el SQL y la referencia temporal de "ahora" en Bogota, arma el
// item de respuesta. Vive aparte del handler de SQL para poder ser cubierto
// con tests unitarios sin PostgreSQL.
//
// Implementa las reglas de atribucion documentadas en el contrato JSON de
// GetSuggestions:
//   - Si el row trae EffectiveSupplierID no-nil, sobreescribe los campos de
//     proveedor del metric (primary_supplier_id / supplier_name / unit_cost)
//     con los del proveedor efectivo. Esto es lo que fija el bug de la
//     pantalla de Pedidos Inteligentes cuando el operador filtra por un
//     proveedor concreto: el frontend agrupa por primary_supplier_id, asi
//     que el group termina siendo el del filtro.
//   - Deriva el lead time con scheduling.ResolveSupplierLeadTime en el
//     orden: dias configurados > learned_lead_time_days (si confiable) >
//     lead_time_days explicito > visit_frequency_days > 7.
//   - Expone AGENDA MANUAL y AGENDA APRENDIDA por separado. La UI puede
//     comparar las dos y mostrarle al dueno "tu dijiste X, el sistema
//     observo Y". Nunca se mezclan en un solo campo.
//   - Cuando el proveedor NO tiene agenda configurada pero SI tiene
//     aprendida con evidencia suficiente (learnedSampleCount >=
//     scheduling.LearnMinSamples), usa la aprendida para calcular las
//     fechas de proxima visita/entrega y marca agendaSource="learned".
//   - Recalcula la sugerencia con LiveStock + LiveInTransitQty para que un
//     pedido recien confirmado descuente inmediato.
//   - Recalcula TotalSavings con la sugerencia viva.
//
// learnPackSizeFromHistory traduce el JSON agrupado de recepciones que devuelve
// la consulta y delega la decision en models.LearnPackSize.
//
// Un JSON invalido o vacio devuelve 0 = "se pide por unidad". Nunca falla hacia
// arriba: un empaque mal deducido obligaria al dueño a pedir de mas, asi que ante
// cualquier duda se prefiere no aplicar empaque.
func learnPackSizeFromHistory(raw string) float64 {
	if raw == "" || raw == "[]" {
		return 0
	}
	var entries []struct {
		Q float64 `json:"q"`
		T int     `json:"t"`
	}
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		return 0
	}
	history := make([]models.ReceptionQuantityCount, 0, len(entries))
	for _, e := range entries {
		history = append(history, models.ReceptionQuantityCount{Quantity: e.Q, Times: e.T})
	}
	return models.LearnPackSize(history)
}

func buildRestockSuggestion(row restockSuggestionRow, nowInBogota time.Time) models.RestockSuggestionResponse {
	metric := row.ProductRestockMetric
	if row.EffectiveSupplierID != nil {
		metric.PrimarySupplierID = row.EffectiveSupplierID
	}
	if row.EffectiveSupplierName != nil {
		metric.SupplierName = *row.EffectiveSupplierName
	}
	if row.EffectiveUnitCost != nil && *row.EffectiveUnitCost > 0 {
		metric.UnitCost = *row.EffectiveUnitCost
	}

	// -----------------------------------------------------------------
	// AGENDA MANUAL (lo que el dueno configuro).
	// -----------------------------------------------------------------
	visitDays := collectSupplierDays(row.EffectiveVisitDays, row.EffectiveLegacyVisitDay)
	deliveryDays := collectSupplierDays(row.EffectiveDeliveryDays, row.EffectiveLegacyDeliveryDay)
	manualSchedule := scheduling.PlanSupplierOrderSchedule(visitDays, deliveryDays, nowInBogota)

	// -----------------------------------------------------------------
	// AGENDA APRENDIDA (lo que el sistema observo). Se considera confiable
	// solo si hay al menos LearnMinSamples pedidos que la respalden. Si el
	// batch de la migracion 014 todavia no ha corrido, learned_sample_count
	// = 0 y aca no se toca: la respuesta degrada limpio.
	// -----------------------------------------------------------------
	learnedConfident := row.EffectiveLearnedSampleCount >= scheduling.LearnMinSamples
	var learnedSchedule scheduling.SupplierSchedule
	if learnedConfident {
		learnedSchedule = scheduling.PlanSupplierOrderSchedule(
			row.EffectiveLearnedVisitDays,
			row.EffectiveLearnedDeliveryDays,
			nowInBogota,
		)
	}

	// -----------------------------------------------------------------
	// PRECEDENCIA para el lead time efectivo.
	// -----------------------------------------------------------------
	var learnedLead *int
	if learnedConfident && row.EffectiveLearnedLeadTimeDays != nil && *row.EffectiveLearnedLeadTimeDays > 0 {
		learnedLead = row.EffectiveLearnedLeadTimeDays
	}
	leadDays, leadSource := scheduling.ResolveSupplierLeadTime(
		manualSchedule,
		learnedLead,
		row.EffectiveLeadTimeDays,
		row.EffectiveVisitFrequency,
	)
	metric.SupplierLeadDays = leadDays

	// Sugerencia recalculada con los datos DEL MOMENTO: existencia viva,
	// transito vivo y minimo vivo. El minimo se lee del producto en la misma
	// consulta (row.MinStock), asi que si el dueño lo edito hoy se respeta sin
	// esperar al batch de la noche.
	//
	// IdealStock viene del batch y bajo Fase 1 (agosto 2026) sale SOLO de
	// la demanda — no lleva piso por minimo. SuggestedOrderQty combina el
	// objetivo por 75% del minimo y la demanda; ninguno usa el minimo entero.
	liveSuggestion := models.SuggestedOrderQty(
		metric.IdealStock,
		row.LiveStock,
		row.LiveInTransitQty,
		row.MinStock,
		metric.ABCCategory,
	)
	// EMPAQUE APRENDIDO: si el producto siempre llega en cajas de N, se pide UNA
	// CAJA COMPLETA, pero SOLO cuando el stock cae a la banda ROJA.
	//
	// REGLA DEL DUEÑO (2026-09-05), textual:
	//
	//	"no me gusta porque quedariamos con mucho producto de uno y faltando el
	//	 otro, entonces es mejor que si llega a 3 o menos ahi si pedir porque los
	//	 productos normalmente llegan entre 1 y 2 dias entonces esos 3 aguantan y
	//	 ya cuando lleguen quedamos en 15"
	//
	// EL RAZONAMIENTO ES DE CAJA, NO DE INVENTARIO: comprar por caja siempre
	// termina por encima del minimo, asi que el objetivo del 75% no ahorra nada en
	// productos empacados — solo adelanta el gasto. Si el proveedor repone en 1-2
	// dias, 3 unidades aguantan, y la plata que no se inmoviliza en este producto
	// alcanza para otro que si esta faltando.
	//
	// Por eso el disparador es el umbral ROJO (25% del minimo), no el objetivo del
	// 75%. Con minimo 12 dispara en 3 y queda en 15, exactamente como lo describio.
	//
	// El 75% se conserva para los productos que se piden POR UNIDAD, donde pedir
	// menos si ahorra plata.
	packSize := learnPackSizeFromHistory(row.PackHistory)
	if packSize > 1 {
		liveSuggestion = models.PackOrderQuantity(
			metric.IdealStock,
			row.LiveStock,
			row.LiveInTransitQty,
			row.MinStock,
			packSize,
		)
	}

	metric.SuggestedOrderQty = liveSuggestion
	metric.InTransitQty = row.LiveInTransitQty

	// Semaforo del negocio: banda calculada EN VIVO con la existencia y el
	// minimo actuales. No se calcula con el transito: la tarjeta pinta lo
	// que hay HOY en gondola, no lo que viene.
	stockBand := models.ClassifyStockBand(row.LiveStock, row.MinStock)

	// Motivo del pedido: Fase 1 usa "target" (objetivo 75%) o "demand"
	// (demanda hasta la proxima visita). "red_floor" se conserva solo como
	// alias historico y no se emite.
	orderReason := models.OrderReasonNone
	if liveSuggestion > 0 {
		target := models.TargetShortfall(row.MinStock, row.LiveStock, row.LiveInTransitQty)
		demand := 0.0
		if missing := metric.IdealStock - (row.LiveStock + row.LiveInTransitQty); missing > 0 {
			demand = missing
		}
		if demand > target {
			orderReason = models.OrderReasonDemand
		} else {
			orderReason = models.OrderReasonTarget
		}
	}

	// La sugerencia de minimo se calcula MAS ABAJO, con el ideal de LARGO PLAZO
	// (ventana de 90 dias). No usar metric.IdealStock aca: ese sale de los
	// ultimos 14 dias y haria que dos semanas flojas propongan bajar el minimo.

	// -----------------------------------------------------------------
	// Ventanas 30d/90d en vivo (Fase 1). Se computan aca para exponer
	// avgDailySales30d y avgDailySales90d al frontend sin persistir
	// columnas nuevas. El denominador NO se infla con dias sin snapshot
	// (regla del dueno: los dias sin dato no cuentan como agotados).
	// -----------------------------------------------------------------
	days30 := 30 - row.LiveDaysZero30d
	if days30 < 1 {
		days30 = 1
	}
	if days30 > 30 {
		days30 = 30
	}
	days90 := 90 - row.LiveDaysZero90d
	if days90 < 1 {
		days90 = 1
	}
	if days90 > 90 {
		days90 = 90
	}
	demand30 := 0.0
	if row.LiveTotalSold30d > 0 {
		demand30 = row.LiveTotalSold30d / float64(days30)
	}
	demand90 := 0.0
	if row.LiveTotalSold90d > 0 {
		demand90 = row.LiveTotalSold90d / float64(days90)
	}
	demand30 = math.Round(demand30*10000) / 10000
	demand90 = math.Round(demand90*10000) / 10000

	// Ventana corta de 14 dias: es la señal PRINCIPAL de la demanda de pedidos.
	// Se expone para que la tarjeta pueda etiquetar bien el numero que muestra.
	days14 := 14 - row.LiveDaysZero14d
	if days14 < 1 {
		days14 = 1
	}
	if days14 > 14 {
		days14 = 14
	}
	demand14 := 0.0
	if row.LiveTotalSold14d > 0 {
		demand14 = row.LiveTotalSold14d / float64(days14)
	}
	demand14 = math.Round(demand14*10000) / 10000

	// -----------------------------------------------------------------
	// IDEAL DE LARGO PLAZO, solo para la sugerencia de stock minimo.
	//
	// El ideal que usa el PEDIDO sale de la ventana de 14 dias, porque el
	// proveedor vuelve en ~8 y hay que reaccionar rapido. Pero cambiar el
	// minimo es estructural: el dueno pidio que solo se sugiera para
	// productos que "lleven mucho mucho tiempo sin vender lo que dice el
	// stock minimo". Con el ideal reciente, dos semanas flojas alcanzarian
	// para proponer bajar un minimo bien puesto.
	//
	// Por eso se recalcula un ideal con la tasa de 90 dias y ESE es el que
	// alimenta la sugerencia. Si no hay evidencia larga (90d en cero), no se
	// sugiere nada: no se toca un minimo por falta de datos.
	// -----------------------------------------------------------------
	leadForMinStock := metric.SupplierLeadDays
	if leadForMinStock <= 0 {
		leadForMinStock = 7
	}
	longTermIdeal := math.Ceil(demand90 * float64(leadForMinStock))

	suggestedMin := 0.0
	suggestedMinReason := models.MinStockSuggestionNone
	if demand90 > 0 || row.MinStock <= 0 {
		suggestedMin, suggestedMinReason = models.SuggestMinStockChange(longTermIdeal, row.MinStock)
	}

	item := models.RestockSuggestionResponse{
		ProductRestockMetric:    metric,
		InTransit:               row.LiveInTransitQty > 0,
		LastReceptionAt:         metric.LastReceptionAt,
		DaysSinceReception:      row.DaysSinceReception,
		SoldSinceReception:      metric.SoldSinceReception,
		MinStock:                row.MinStock,
		LiveStock:               row.LiveStock,
		StockBand:               stockBand,
		SuggestedMinStock:       suggestedMin,
		SuggestedMinStockReason: suggestedMinReason,
		OrderReason:             orderReason,
		LeadTimeSource:          leadSource,
		// Ventanas 30d/90d en vivo.
		TotalSold90d:     row.LiveTotalSold90d,
		AvgDailySales30d: demand30,
		AvgDailySales90d: demand90,
		DaysZeroStock90d: row.LiveDaysZero90d,
		// Ventana corta: la señal que realmente decide el pedido.
		TotalSold14d:     row.LiveTotalSold14d,
		AvgDailySales14d: demand14,
		DaysZeroStock14d: row.LiveDaysZero14d,
		// Bloque MANUAL. Se preservan los dias tal como el dueno los
		// escribio para que la UI pueda compararlos con los aprendidos.
		VisitDays:             row.EffectiveVisitDays,
		DeliveryDays:          row.EffectiveDeliveryDays,
		ScheduleHasConfigured: manualSchedule.HasSchedule,
	}

	// Bloque APRENDIDO. Se expone SIEMPRE que haya evidencia, incluso si
	// aca no se usa para las fechas efectivas — la UI las quiere ver para
	// mostrar la comparacion.
	if row.EffectiveLearnedSampleCount > 0 {
		item.LearnedVisitDays = row.EffectiveLearnedVisitDays
		item.LearnedDeliveryDays = row.EffectiveLearnedDeliveryDays
		item.LearnedSampleCount = row.EffectiveLearnedSampleCount
		item.LearnedAt = row.EffectiveLearnedAt
		if row.EffectiveLearnedLeadTimeDays != nil && *row.EffectiveLearnedLeadTimeDays > 0 {
			ll := *row.EffectiveLearnedLeadTimeDays
			item.LearnedLeadTimeDays = &ll
		}
	}

	// Fechas efectivas: preferir manual; si no hay manual pero si aprendida
	// confiable, usar la aprendida y marcar agendaSource="learned".
	switch {
	case manualSchedule.HasSchedule:
		nextVisit := manualSchedule.NextVisitDate.Format("2006-01-02")
		nextDelivery := manualSchedule.NextDeliveryDate.Format("2006-01-02")
		daysUntil := manualSchedule.DaysUntilNextVisit
		item.NextVisitDate = &nextVisit
		item.NextDeliveryDate = &nextDelivery
		item.DaysUntilNextVisit = &daysUntil
		item.AgendaSource = "manual"
	case learnedConfident && learnedSchedule.HasSchedule:
		nextVisit := learnedSchedule.NextVisitDate.Format("2006-01-02")
		nextDelivery := learnedSchedule.NextDeliveryDate.Format("2006-01-02")
		daysUntil := learnedSchedule.DaysUntilNextVisit
		item.NextVisitDate = &nextVisit
		item.NextDeliveryDate = &nextDelivery
		item.DaysUntilNextVisit = &daysUntil
		item.AgendaSource = "learned"
	default:
		item.AgendaSource = "none"
	}

	item.Recommendation, item.RecommendationLevel = models.BuildRestockRecommendation(models.RestockDecisionInput{
		ABCCategory:        metric.ABCCategory,
		CurrentStock:       row.LiveStock,
		InTransitQty:       row.LiveInTransitQty,
		SuggestedOrderQty:  liveSuggestion,
		AvgDailySales:      metric.AvgDailySales,
		DaysSinceReception: row.DaysSinceReception,
		SoldSinceReception: metric.SoldSinceReception,
		// Bajo la regla nueva del dueno (agosto 2026) el minimo es una alarma,
		// no una meta: la sugerencia por si sola ya trae el piso rojo cuando
		// aplica. Aca pasamos el minimo vivo para que el texto pueda mencionar
		// "salir del rojo" o "bajo el mínimo" sin que la banda contradiga a
		// la tarjeta.
		MinStock: row.MinStock,
	})
	if row.CheaperSupplierID != nil && row.CheaperSupplierName != nil {
		item.CheaperSupplier = &models.CheaperSupplierAlert{
			SupplierID:   *row.CheaperSupplierID,
			SupplierName: *row.CheaperSupplierName,
			UnitPrice:    row.CheaperUnitPrice,
			Savings:      row.Savings,
			// TotalSavings se recomputa con la SUGERENCIA VIVA (ya
			// descontado el transito del momento) para reflejar el ahorro
			// real del pedido de hoy. Savings por unidad ya viene calculado
			// contra el proveedor efectivo (el que se le va a comprar).
			TotalSavings: row.Savings * liveSuggestion,
		}
	}
	return item
}

// collectSupplierDays reune todos los orígenes de nombres de dia del
// proveedor: primero el nuevo campo JSONB (visit_days / delivery_days), y si
// esta vacio, el campo legacy en formato texto/CSV (visitDay / deliveryDay).
// Devuelve la union sin normalizar — la normalizacion la hace parseWeekdaySet
// dentro del paquete scheduling.
func collectSupplierDays(jsonbDays models.StringArray, legacyCSV *string) []string {
	out := make([]string, 0, len(jsonbDays)+1)
	for _, day := range jsonbDays {
		out = append(out, day)
	}
	if legacyCSV != nil {
		if trimmed := *legacyCSV; trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// ============================================================================
// APRENDIZAJE DE AGENDA (Sprint 9, migracion 014).
// ============================================================================
//
// Este bloque expone tres operaciones que consume el batch nocturno:
//
//   - LoadSupplierVisitObservations: trae confirmed_at por proveedor (dia
//     en que vino el preventista y se cerro el pedido).
//   - LoadSupplierDeliveryObservations: trae expenses.date por proveedor,
//     filtrando category='Proveedores', supplier_id NOT NULL y no borrado
//     logicamente. Segun la regla del dueno (agosto 2026), el egreso se
//     hace el mismo dia que llega la mercancia, asi que es la fuente
//     confiable del dia de entrega — a diferencia de received_at, que se
//     registra tarde.
//   - SaveSupplierLearnedSchedules: escribe el resultado del aprendizaje
//     en las columnas learned_* de suppliers. Es la UNICA ruta autorizada
//     para tocar esas columnas. Nunca escribe visit_days ni delivery_days:
//     esa es propiedad exclusiva del dueno.
//
// Estas operaciones son I/O puro. La logica de aprendizaje vive en el
// paquete scheduling y no depende de esto.

// SupplierVisitObservationRow es lo que el batch carga de confirmed_orders:
// (supplier_id, confirmed_at). No importa el received_at, que la regla del
// dueno declaro no confiable como dia de llegada.
type SupplierVisitObservationRow struct {
	SupplierID  uint      `gorm:"column:supplier_id"`
	ConfirmedAt time.Time `gorm:"column:confirmed_at"`
}

// SupplierDeliveryObservationRow es lo que el batch carga de expenses. La
// unica categoria valida es 'Proveedores': es la unica que representa un
// pago por mercancia recibida (postgres_product_inventory.go crea el egreso
// con Date=time.Now() al momento de la recepcion). Otras categorias como
// 'Logística' (flete) tambien traen supplier_id pero representan
// transporte, no la llegada de la mercancia — se descartan.
type SupplierDeliveryObservationRow struct {
	SupplierID uint      `gorm:"column:supplier_id"`
	PaidAt     time.Time `gorm:"column:paid_at"`
}

// SupplierLearnedScheduleUpdate es lo que el batch persiste. Cuando
// HasLearned=false, el batch SIGUE llamando a Save para dejar constancia del
// intento (learned_at se actualiza) y para dejar en null las columnas de
// datos. Eso es intencional: no queremos que un dato aprendido viejo siga
// vigente si ahora los datos ya no soportan una conclusion.
type SupplierLearnedScheduleUpdate struct {
	SupplierID   uint
	HasLearned   bool
	VisitDays    []string
	DeliveryDays []string
	LeadTimeDays int
	SampleCount  int
	LearnedAt    time.Time
}

// LoadSupplierVisitObservations carga los pares (supplier_id, confirmed_at)
// de confirmed_orders desde el piso 'since'. El caller aplica la ventana
// LearnLookbackDays sobre esta salida — este metodo devuelve todo lo que
// cae dentro del piso.
func (r *RestockMetricsRepository) LoadSupplierVisitObservations(
	ctx context.Context,
	since time.Time,
) ([]SupplierVisitObservationRow, error) {
	var rows []SupplierVisitObservationRow
	err := r.db.WithContext(ctx).Raw(`
		SELECT supplier_id, confirmed_at
		FROM confirmed_orders
		WHERE supplier_id IS NOT NULL
		  AND confirmed_at IS NOT NULL
		  AND confirmed_at >= ?
		ORDER BY supplier_id, confirmed_at
	`, since).Scan(&rows).Error
	return rows, err
}

// LoadSupplierDeliveryObservations carga los pares (supplier_id, date) de
// expenses filtrando por la categoria de pago a proveedor por mercancia.
//
// Categorias incluidas: SOLO 'Proveedores'.
//
//	Es la unica categoria que el flujo de recepcion asigna cuando se paga
//	la mercancia recibida (ver postgres_product_inventory.go, tanto el
//	camino "mixed" como el "normal"), y es la unica que el formulario
//	manual del frontend usa para vincular el egreso a un proveedor
//	(ExpenseFormModal.tsx: CATEGORIES y expenses/page.tsx envian
//	supplierId solo cuando category === 'Proveedores'). Los egresos
//	Category='Logística' con supplier_id representan flete/transporte, no
//	la llegada de la mercancia; y aunque el flete se crea el mismo dia que
//	la recepcion, ya hay otra fila con Category='Proveedores' que aporta
//	ese dia — incluir 'Logística' duplicaria la muestra.
//
// El filtro deleted_at IS NULL descarta soft-deletes (GORM aplica esto por
// defecto en el modelo, pero como usamos SQL crudo lo pedimos explicito).
func (r *RestockMetricsRepository) LoadSupplierDeliveryObservations(
	ctx context.Context,
	since time.Time,
) ([]SupplierDeliveryObservationRow, error) {
	var rows []SupplierDeliveryObservationRow
	err := r.db.WithContext(ctx).Raw(`
		SELECT supplier_id, date AS paid_at
		FROM expenses
		WHERE deleted_at IS NULL
		  AND supplier_id IS NOT NULL
		  AND category = 'Proveedores'
		  AND date IS NOT NULL
		  AND date >= ?
		ORDER BY supplier_id, date
	`, since).Scan(&rows).Error
	return rows, err
}

// SaveSupplierLearnedSchedules escribe en la fila del proveedor las columnas
// learned_visit_days / learned_delivery_days / learned_lead_time_days /
// learned_sample_count / learned_at. Nunca toca visit_days ni delivery_days.
//
// CONTRATO:
//   - Cuando HasLearned=true: se guardan visit/delivery/lead/sample con los
//     valores computados, y learned_at con el timestamp de la corrida.
//   - Cuando HasLearned=false: se ponen las tres columnas de datos en NULL
//     y sample_count en 0. Esto es intencional: si antes teniamos un dato
//     aprendido y hoy los datos ya no lo respaldan, mejor limpiar que
//     mantener una conclusion caduca.
//   - Nunca se hace INSERT: la fila del proveedor tiene que existir antes.
//   - Se usa un UPDATE por proveedor en lugar de un CASE masivo: el numero
//     de proveedores en un negocio de barrio es del orden de decenas, no
//     miles, asi que la simplicidad gana.
func (r *RestockMetricsRepository) SaveSupplierLearnedSchedules(
	ctx context.Context,
	updates []SupplierLearnedScheduleUpdate,
) error {
	if len(updates) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, upd := range updates {
			fields := map[string]interface{}{
				"learned_at": upd.LearnedAt,
			}
			if upd.HasLearned {
				fields["learned_visit_days"] = models.StringArray(upd.VisitDays)
				fields["learned_delivery_days"] = models.StringArray(upd.DeliveryDays)
				fields["learned_lead_time_days"] = upd.LeadTimeDays
				fields["learned_sample_count"] = upd.SampleCount
			} else {
				// Limpio: nada de arrastrar una conclusion vieja si los
				// datos actuales ya no la sostienen.
				fields["learned_visit_days"] = gorm.Expr("NULL")
				fields["learned_delivery_days"] = gorm.Expr("NULL")
				fields["learned_lead_time_days"] = gorm.Expr("NULL")
				fields["learned_sample_count"] = 0
			}
			if err := tx.Model(&models.Supplier{}).
				Where("id = ?", upd.SupplierID).
				Updates(fields).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// FindInTransitProducts returns pending quantities from both order systems.
// The order being edited can be excluded so it does not block itself.
func (r *RestockMetricsRepository) FindInTransitProducts(
	ctx context.Context,
	productIDs []string,
	excludeConfirmedOrderID string,
) ([]models.InTransitProduct, error) {
	if len(productIDs) == 0 {
		return []models.InTransitProduct{}, nil
	}

	var conflicts []models.InTransitProduct
	err := r.db.WithContext(ctx).Raw(`
		WITH pending AS (
			SELECT coi.product_id, SUM(coi.quantity)::numeric AS quantity
			FROM confirmed_order_items coi
			JOIN confirmed_orders co ON co.id = coi.confirmed_order_id
			WHERE coi.product_id IN ?
			  AND UPPER(co.status) IN ('PENDING', 'IN_TRANSIT')
			  AND (? = '' OR co.id::text <> ?)
			GROUP BY coi.product_id
			UNION ALL
			SELECT poi."productBarcode" AS product_id, SUM(poi.quantity)::numeric AS quantity
			FROM purchase_order_items poi
			JOIN purchase_orders po ON po.id = poi."orderId"
			WHERE poi."productBarcode" IN ?
			  AND UPPER(po.status) IN ('PENDING', 'IN_TRANSIT')
			  AND po.deleted_at IS NULL
			  AND poi.deleted_at IS NULL
			GROUP BY poi."productBarcode"
		)
		SELECT pending.product_id,
		       COALESCE(p."productName", pending.product_id) AS product_name,
		       SUM(pending.quantity)::numeric AS quantity
		FROM pending
		LEFT JOIN products p ON p.barcode = pending.product_id
		GROUP BY pending.product_id, p."productName"
		HAVING SUM(pending.quantity) > 0
		ORDER BY product_name
	`, productIDs, excludeConfirmedOrderID, excludeConfirmedOrderID, productIDs).
		Scan(&conflicts).Error
	return conflicts, err
}
