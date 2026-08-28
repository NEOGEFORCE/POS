package repositories

import (
	"context"
	"time"

	"backPOS-go/internal/core/domain/models"
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

// LoadCalculationInputs loads sales, zero-stock days, transit and the current supplier
// for every active product with one parameterized query.
func (r *RestockMetricsRepository) LoadCalculationInputs(
	ctx context.Context,
	since time.Time,
	asOf time.Time,
) ([]models.RestockCalculationInput, error) {
	var inputs []models.RestockCalculationInput
	err := r.db.WithContext(ctx).Raw(`
		WITH sales_30d AS (
			SELECT sd.barcode AS product_id, COALESCE(SUM(sd.quantity), 0)::numeric AS total_sold_30d
			FROM sale_details sd
			JOIN sales sa ON sa."saleId" = sd."saleId"
			WHERE sa."saleDate" >= ?
			  AND sa.deleted_at IS NULL
			  AND sd.deleted_at IS NULL
			  AND COALESCE(UPPER(sa.status), '') NOT IN ('CANCELED', 'CANCELLED')
			GROUP BY sd.barcode
		), zero_days AS (
			SELECT product_id, COUNT(DISTINCT snapshot_date)::integer AS days_zero_stock
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
				WHERE UPPER(co.status) IN ('PENDING', 'IN_TRANSIT')
				GROUP BY coi.product_id
				UNION ALL
				SELECT poi."productBarcode" AS product_id, SUM(poi.quantity)::numeric AS quantity
				FROM purchase_order_items poi
				JOIN purchase_orders po ON po.id = poi."orderId"
				WHERE UPPER(po.status) IN ('PENDING', 'IN_TRANSIT')
				  AND po.deleted_at IS NULL
				  AND poi.deleted_at IS NULL
				GROUP BY poi."productBarcode"
			) pending
			GROUP BY product_id
		)
		SELECT
			p.barcode AS product_id,
			p."productName" AS product_name,
			COALESCE(p.quantity, 0)::numeric AS current_stock,
			COALESCE(v.total_sold_30d, 0)::numeric AS total_sold_30d,
			LEAST(30, COALESCE(z.days_zero_stock, 0) +
				CASE WHEN COALESCE(p.quantity, 0) <= 0 THEN 1 ELSE 0 END)::integer AS days_zero_stock,
			COALESCE(t.quantity, 0)::numeric AS in_transit_qty,
			primary_supplier.supplier_id AS primary_supplier_id,
			COALESCE(primary_supplier.supplier_name, '') AS supplier_name,
			COALESCE(primary_supplier.lead_days, 7)::integer AS supplier_lead_days,
			COALESCE(primary_supplier.unit_cost, p."purchasePrice", 0)::numeric AS unit_cost
		FROM products p
		LEFT JOIN sales_30d v ON v.product_id = p.barcode
		LEFT JOIN zero_days z ON z.product_id = p.barcode
		LEFT JOIN transit t ON t.product_id = p.barcode
		LEFT JOIN LATERAL (
			SELECT candidate.supplier_id, candidate.supplier_name,
			       candidate.lead_days, candidate.unit_cost
			FROM (
				SELECT 0 AS priority, s.id AS supplier_id, s.name AS supplier_name,
				       COALESCE(NULLIF(s.lead_time_days, 0), NULLIF(s.visit_frequency_days, 0), 7) AS lead_days,
				       COALESCE(NULLIF(ps."purchasePrice", 0), NULLIF(p."purchasePrice", 0), 0) AS unit_cost
				FROM suppliers s
				LEFT JOIN product_suppliers ps
				  ON ps.supplier_id = s.id AND ps.product_barcode = p.barcode
				WHERE p."supplierId" IS NOT NULL
				  AND s.id = p."supplierId"
				  AND s.deleted_at IS NULL
				UNION ALL
				SELECT 1 AS priority, s.id AS supplier_id, s.name AS supplier_name,
				       COALESCE(NULLIF(s.lead_time_days, 0), NULLIF(s.visit_frequency_days, 0), 7) AS lead_days,
				       COALESCE(NULLIF(ps."purchasePrice", 0), NULLIF(p."purchasePrice", 0), 0) AS unit_cost
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
	`, since, since, asOf).Scan(&inputs).Error
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
	CheaperSupplierID   *uint      `gorm:"column:cheaper_supplier_id"`
	CheaperSupplierName *string    `gorm:"column:cheaper_supplier_name"`
	CheaperUnitPrice    float64    `gorm:"column:cheaper_unit_price"`
	Savings             float64    `gorm:"column:savings"`
	TotalSavings        float64    `gorm:"column:total_savings"`
	LastReceptionAt     *time.Time `gorm:"column:last_reception_at"`
	DaysSinceReception  *int       `gorm:"column:days_since_reception"`
	SoldSinceReception  float64    `gorm:"column:sold_since_reception"`
}

// GetSuggestions loads metrics and the cheapest alternative supplier in one query.
func (r *RestockMetricsRepository) GetSuggestions(
	ctx context.Context,
	supplierID *uint,
) ([]models.RestockSuggestionResponse, error) {
	filterSupplierID := uint(0)
	if supplierID != nil {
		filterSupplierID = *supplierID
	}

	var rows []restockSuggestionRow
	err := r.db.WithContext(ctx).Raw(`
		WITH ultima_recepcion AS (
			SELECT barcode, MAX(date) AS last_reception_at
			FROM stock_movements
			WHERE reason = 'RECEPTION'
			GROUP BY barcode
		),
		consumo_posterior AS (
			SELECT sd.barcode, SUM(sd.quantity) AS sold_since_reception
			FROM sale_details sd
			JOIN sales s ON s."saleId" = sd."saleId"
			JOIN ultima_recepcion ur ON ur.barcode = sd.barcode
			WHERE s.deleted_at IS NULL
			  AND UPPER(s.status) IN ('PAID', 'CREDIT')
			  AND s."saleDate" >= ur.last_reception_at
			GROUP BY sd.barcode
		)
		SELECT
			m.*,
			alternative.supplier_id AS cheaper_supplier_id,
			alternative.supplier_name AS cheaper_supplier_name,
			COALESCE(alternative.unit_price, 0)::numeric AS cheaper_unit_price,
			COALESCE(m.unit_cost - alternative.unit_price, 0)::numeric AS savings,
			COALESCE((m.unit_cost - alternative.unit_price) * m.suggested_order_qty, 0)::numeric AS total_savings,
			ur.last_reception_at,
			CASE
				WHEN ur.last_reception_at IS NULL THEN NULL
				ELSE FLOOR(EXTRACT(EPOCH FROM (NOW() - ur.last_reception_at)) / 86400)::int
			END AS days_since_reception,
			COALESCE(cp.sold_since_reception, 0)::numeric AS sold_since_reception
		FROM product_restock_metrics m
		LEFT JOIN ultima_recepcion ur ON ur.barcode = m.product_id
		LEFT JOIN consumo_posterior cp ON cp.barcode = m.product_id
		LEFT JOIN LATERAL (
			SELECT ps.supplier_id, s.name AS supplier_name,
			       ps."purchasePrice"::numeric AS unit_price
			FROM product_suppliers ps
			JOIN suppliers s ON s.id = ps.supplier_id
			WHERE ps.product_barcode = m.product_id
			  AND (m.primary_supplier_id IS NULL OR ps.supplier_id <> m.primary_supplier_id)
			  AND ps."purchasePrice" > 0
			  AND m.unit_cost > 0
			  AND ps."purchasePrice" < m.unit_cost
			  AND s.deleted_at IS NULL
			ORDER BY ps."purchasePrice" ASC, ps.supplier_id ASC
			LIMIT 1
		) alternative ON TRUE
		WHERE (
			? = 0
			OR m.primary_supplier_id = ?
			OR EXISTS (
				SELECT 1 FROM product_suppliers ps2
				WHERE ps2.product_barcode = m.product_id
				  AND ps2.supplier_id = ?
			)
		)
		ORDER BY m.abc_category ASC, m.avg_daily_sales DESC, m.product_name ASC
	`, filterSupplierID, filterSupplierID, filterSupplierID).Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	response := make([]models.RestockSuggestionResponse, 0, len(rows))
	for _, row := range rows {
		item := models.RestockSuggestionResponse{
			ProductRestockMetric: row.ProductRestockMetric,
			InTransit:            row.InTransitQty > 0,
			LastReceptionAt:      row.LastReceptionAt,
			DaysSinceReception:   row.DaysSinceReception,
			SoldSinceReception:   row.SoldSinceReception,
		}
		item.Recommendation, item.RecommendationLevel = models.BuildRestockRecommendation(models.RestockDecisionInput{
			ABCCategory:        row.ABCCategory,
			CurrentStock:       row.CurrentStock,
			InTransitQty:       row.InTransitQty,
			SuggestedOrderQty:  row.SuggestedOrderQty,
			AvgDailySales:      row.AvgDailySales,
			DaysSinceReception: row.DaysSinceReception,
			SoldSinceReception: row.SoldSinceReception,
		})
		if row.CheaperSupplierID != nil && row.CheaperSupplierName != nil {
			item.CheaperSupplier = &models.CheaperSupplierAlert{
				SupplierID:   *row.CheaperSupplierID,
				SupplierName: *row.CheaperSupplierName,
				UnitPrice:    row.CheaperUnitPrice,
				Savings:      row.Savings,
				TotalSavings: row.TotalSavings,
			}
		}
		response = append(response, item)
	}
	return response, nil
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
