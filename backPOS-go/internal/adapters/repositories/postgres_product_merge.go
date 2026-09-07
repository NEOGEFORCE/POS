package repositories

import (
	"fmt"
	"strings"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/cache"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// historicalMarkerNamePrefix es la firma que dejó el script
// paquete_produccion\corregir_referencias.ps1 al crear productos-marcador para
// que las referencias huérfanas (kárdex, sale_details, etc.) no violaran las
// FKs nuevas. Esos marcadores tienen isActive=false y su productName empieza
// con este prefijo.
const historicalMarkerNamePrefix = "[HISTORICO]"

// isHistoricalMarker distingue un producto-marcador (isActive=false + nombre
// que empieza con "[HISTORICO]") de un producto real que quedó desactivado.
// La combinación es intencional: sólo aquellos creados por el script llevan
// esa firma; un producto real desactivado desde UI conserva su nombre real.
func isHistoricalMarker(p models.Product) bool {
	if p.IsActive {
		return false
	}
	return strings.HasPrefix(strings.TrimSpace(p.ProductName), historicalMarkerNamePrefix)
}

// MergeHistoricalMarker fusiona un producto marcador '[HISTORICO] B' con un
// producto real cuyo código actual es X, para dejar al producto real con el
// código B (que hoy está ocupado por el marcador).
//
// Flujo:
//  1. Valida que el marcador exista, sea inactivo y su nombre empiece por
//     '[HISTORICO]'. Valida que el producto real exista y que X != B.
//  2. Mueve TODAS las referencias que hoy apuntan a B → X:
//     stock_movements.barcode, sale_details.barcode, return_details.barcode,
//     purchase_order_items."productBarcode", product_suppliers.product_barcode
//     (con manejo de conflicto de unicidad), products."baseProductBarcode",
//     y las otras tablas que llevan la barcode del producto (aliases,
//     snapshots, métricas de restock, mermas, pedidos esperados/confirmados,
//     price_logs, active_purchase_list). Ver detalle en cada UPDATE.
//  3. Borra el marcador B — ya nada lo referencia, así que el RESTRICT del
//     FK fk_stock_movements_product se satisface.
//  4. Renombra el producto real X → B. El ON UPDATE CASCADE arrastra a todos
//     los hijos de X a B. Para tablas SIN cascade (supplier_product_aliases,
//     que sólo tiene ON DELETE CASCADE), extraemos y reinsertamos.
//  5. Registra la operación en auditoría (acción crítica).
//
// Todo va en una sola transacción. Si algo falla, la BD queda como antes.
func (r *PostgresProductRepository) MergeHistoricalMarker(
	realBarcode, markerBarcode, authorDNI, authorName string,
) error {
	realBarcode = strings.TrimSpace(realBarcode)
	markerBarcode = strings.TrimSpace(markerBarcode)

	if realBarcode == "" || markerBarcode == "" {
		return fmt.Errorf("códigos requeridos: real=%q marcador=%q", realBarcode, markerBarcode)
	}
	if realBarcode == markerBarcode {
		return fmt.Errorf("el código real y el del marcador no pueden ser iguales (%s)", realBarcode)
	}

	return r.db.Transaction(func(tx *gorm.DB) error {
		// --- Paso 1: validaciones antes de tocar nada -----------------------

		var marker models.Product
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Unscoped().
			Where("barcode = ?", markerBarcode).First(&marker).Error; err != nil {
			return fmt.Errorf("el marcador %s no existe en products: %w", markerBarcode, err)
		}
		if !isHistoricalMarker(marker) {
			return fmt.Errorf(
				"el código %s no es un marcador '[HISTORICO]': pertenece a \"%s\" (activo=%v). "+
					"Este endpoint sólo puede liberar códigos ocupados por marcadores creados por corregir_referencias.ps1",
				markerBarcode, marker.ProductName, marker.IsActive,
			)
		}

		var real models.Product
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Unscoped().
			Where("barcode = ?", realBarcode).First(&real).Error; err != nil {
			return fmt.Errorf("el producto real %s no existe en products: %w", realBarcode, err)
		}
		// Protección extra: si el "real" también parece un marcador, algo va
		// mal y hay que revisar manualmente.
		if isHistoricalMarker(real) {
			return fmt.Errorf(
				"el supuesto producto real %s también es un marcador '[HISTORICO]'. "+
					"Corrige el catálogo antes de intentar fusionar",
				realBarcode,
			)
		}

		// --- Paso 2: mover TODAS las referencias del marcador al producto real
		// El objetivo: cuando renombremos X → B en el paso 4, el ON UPDATE
		// CASCADE lleve todo (historial fusionado) a B.
		//
		// Para tablas con FK ON UPDATE CASCADE es indistinto hacerlo aquí o
		// dejar que el CASCADE del paso 4 lo haga; para tablas con FK sin
		// cascade (supplier_product_aliases) es imprescindible mover ahora
		// porque el rename del paso 4 fallaría si quedaran filas con
		// product_barcode = X orfanas.
		//
		// Nota: product_suppliers tiene UNIQUE (product_barcode, supplier_id).
		// Si el marcador y el real comparten proveedor, un UPDATE directo
		// choca con esa restricción. Lo tratamos aparte.

		// stock_movements.barcode
		if err := tx.Exec(
			`UPDATE stock_movements SET barcode = ? WHERE barcode = ?`,
			realBarcode, markerBarcode,
		).Error; err != nil {
			return fmt.Errorf("error moviendo stock_movements: %w", err)
		}

		// sale_details.barcode
		if err := tx.Exec(
			`UPDATE sale_details SET barcode = ? WHERE barcode = ?`,
			realBarcode, markerBarcode,
		).Error; err != nil {
			return fmt.Errorf("error moviendo sale_details: %w", err)
		}

		// return_details.barcode
		if err := tx.Exec(
			`UPDATE return_details SET barcode = ? WHERE barcode = ?`,
			realBarcode, markerBarcode,
		).Error; err != nil {
			return fmt.Errorf("error moviendo return_details: %w", err)
		}

		// purchase_order_items."productBarcode"
		if err := tx.Exec(
			`UPDATE purchase_order_items SET "productBarcode" = ? WHERE "productBarcode" = ?`,
			realBarcode, markerBarcode,
		).Error; err != nil {
			return fmt.Errorf("error moviendo purchase_order_items: %w", err)
		}

		// product_suppliers: UPDATE puede violar UNIQUE(product_barcode,
		// supplier_id). Estrategia:
		//   1. Para cada fila del marcador cuya supplier_id ya existe en el
		//      producto real, la del marcador se descarta (el real ya tiene
		//      su propio vínculo con ese proveedor y su precio).
		//   2. Las que no chocan, se re-apuntan al real.
		if err := tx.Exec(
			`DELETE FROM product_suppliers ps
			 WHERE ps.product_barcode = ?
			   AND ps.supplier_id IN (
			       SELECT supplier_id FROM product_suppliers WHERE product_barcode = ?
			   )`,
			markerBarcode, realBarcode,
		).Error; err != nil {
			return fmt.Errorf("error resolviendo duplicados de product_suppliers: %w", err)
		}
		if err := tx.Exec(
			`UPDATE product_suppliers SET product_barcode = ? WHERE product_barcode = ?`,
			realBarcode, markerBarcode,
		).Error; err != nil {
			return fmt.Errorf("error moviendo product_suppliers: %w", err)
		}

		// products."baseProductBarcode": productos que apuntan al marcador
		// como su producto base (raro pero posible).
		if err := tx.Exec(
			`UPDATE products SET "baseProductBarcode" = ? WHERE "baseProductBarcode" = ?`,
			realBarcode, markerBarcode,
		).Error; err != nil {
			return fmt.Errorf("error moviendo baseProductBarcode: %w", err)
		}

		// Tablas adicionales que también guardan barcode de producto (sin FK
		// estricto en la BD o con FK ON DELETE CASCADE únicamente). Las
		// tratamos igual para que el historial quede consolidado.
		auxTables := []struct {
			query string
			label string
		}{
			{`UPDATE confirmed_order_items SET product_id = ? WHERE product_id = ?`, "confirmed_order_items"},
			{`UPDATE active_purchase_list SET product_id = ? WHERE product_id = ?`, "active_purchase_list"},
			{`UPDATE price_logs SET product_barcode = ? WHERE product_barcode = ?`, "price_logs"},
			{`UPDATE expected_order_items SET barcode = ? WHERE barcode = ?`, "expected_order_items"},
			{`UPDATE daily_stock_snapshots SET product_id = ? WHERE product_id = ?`, "daily_stock_snapshots"},
			{`UPDATE product_restock_metrics SET product_id = ? WHERE product_id = ?`, "product_restock_metrics"},
			{`UPDATE shrinkages SET product_id = ? WHERE product_id = ?`, "shrinkages"},
		}
		for _, t := range auxTables {
			if err := tx.Exec(t.query, realBarcode, markerBarcode).Error; err != nil {
				return fmt.Errorf("error moviendo %s: %w", t.label, err)
			}
		}

		// supplier_product_aliases (FK ON DELETE CASCADE, sin ON UPDATE
		// CASCADE). Movemos las filas del marcador al real evitando conflicto
		// con la UNIQUE (supplier_id, invoice_name).
		if err := tx.Exec(
			`DELETE FROM supplier_product_aliases spa
			 WHERE spa.product_barcode = ?
			   AND EXISTS (
			       SELECT 1 FROM supplier_product_aliases spa2
			       WHERE spa2.product_barcode = ?
			         AND spa2.supplier_id = spa.supplier_id
			         AND spa2.invoice_name = spa.invoice_name
			   )`,
			markerBarcode, realBarcode,
		).Error; err != nil {
			return fmt.Errorf("error resolviendo duplicados de supplier_product_aliases: %w", err)
		}
		if err := tx.Exec(
			`UPDATE supplier_product_aliases SET product_barcode = ? WHERE product_barcode = ?`,
			realBarcode, markerBarcode,
		).Error; err != nil {
			return fmt.Errorf("error moviendo supplier_product_aliases: %w", err)
		}

		// --- Paso 3: eliminar el marcador -----------------------------------
		// A esta altura NADA referencia B. El FK ON DELETE RESTRICT del
		// stock_movements y sale_details/return_details se satisface. Si algo
		// quedó apuntando a B por descuido, PostgreSQL abortará la
		// transacción y no se aplican cambios.
		//
		// Usamos DELETE físico (Unscoped) porque los marcadores tienen
		// isActive=false y deleted_at NULL: un Delete lógico sólo agregaría
		// deleted_at pero dejaría el barcode ocupado.
		if err := tx.Unscoped().
			Where("barcode = ?", markerBarcode).
			Delete(&models.Product{}).Error; err != nil {
			return fmt.Errorf("error eliminando marcador %s: %w", markerBarcode, err)
		}

		// --- Paso 4: renombrar producto real X → B --------------------------
		// Con las FKs cascade definidas en migración 003/009, este UPDATE
		// arrastra a los hijos de X en:
		//   stock_movements, sale_details, return_details,
		//   purchase_order_items, product_suppliers, products.baseProductBarcode.
		// Las tablas auxiliares ya fueron re-apuntadas manualmente arriba
		// para que la fusión sea idempotente respecto a las tablas sin FK.
		//
		// Renombramos vía UPDATE directo en lugar de tx.Model().Update() para
		// no disparar hooks o retrieval de asociaciones.
		res := tx.Exec(
			`UPDATE products SET barcode = ?, updated_at = NOW() WHERE barcode = ?`,
			markerBarcode, realBarcode,
		)
		if res.Error != nil {
			return fmt.Errorf("error renombrando %s → %s: %w", realBarcode, markerBarcode, res.Error)
		}
		if res.RowsAffected != 1 {
			return fmt.Errorf(
				"se esperaba renombrar 1 producto (%s → %s) pero se afectaron %d filas",
				realBarcode, markerBarcode, res.RowsAffected,
			)
		}

		// Un último UPDATE para las tablas auxiliares: al renombrar productos
		// arriba, las tablas SIN FK cascade (que ya fueron movidas al real X
		// en el paso 2) siguen apuntando a X. El CASCADE de products no las
		// alcanza. Las re-apuntamos ahora al nuevo barcode (que es
		// markerBarcode, ex-marker).
		//
		// Nota: para las tablas que YA tienen ON UPDATE CASCADE
		// (stock_movements, sale_details, return_details, purchase_order_items,
		// product_suppliers, products.baseProductBarcode) el CASCADE del
		// UPDATE de products ya movió sus filas a markerBarcode. No hace
		// falta un segundo update.
		auxSecond := []struct {
			query string
			label string
		}{
			{`UPDATE confirmed_order_items SET product_id = ? WHERE product_id = ?`, "confirmed_order_items"},
			{`UPDATE active_purchase_list SET product_id = ? WHERE product_id = ?`, "active_purchase_list"},
			{`UPDATE price_logs SET product_barcode = ? WHERE product_barcode = ?`, "price_logs"},
			{`UPDATE expected_order_items SET barcode = ? WHERE barcode = ?`, "expected_order_items"},
			{`UPDATE daily_stock_snapshots SET product_id = ? WHERE product_id = ?`, "daily_stock_snapshots"},
			{`UPDATE product_restock_metrics SET product_id = ? WHERE product_id = ?`, "product_restock_metrics"},
			{`UPDATE shrinkages SET product_id = ? WHERE product_id = ?`, "shrinkages"},
			// supplier_product_aliases NO tiene ON UPDATE CASCADE, así que
			// también hay que actualizarla explícitamente. Su FK apunta a
			// products(barcode); al haber renombrado el producto real, el
			// alias sigue con product_barcode = realBarcode (viejo) y
			// quedaría huérfano si no lo movemos.
			{`UPDATE supplier_product_aliases SET product_barcode = ? WHERE product_barcode = ?`, "supplier_product_aliases"},
		}
		for _, t := range auxSecond {
			if err := tx.Exec(t.query, markerBarcode, realBarcode).Error; err != nil {
				return fmt.Errorf("error consolidando %s en el nuevo código: %w", t.label, err)
			}
		}

		// --- Paso 5: auditoría dentro de la misma transacción ---------------
		// Se registra como acción crítica. Si más adelante falla algo (poco
		// probable a esta altura), la transacción también revierte el log.
		audit := &models.AuditLog{
			EmployeeDNI:  strings.TrimSpace(authorDNI),
			EmployeeName: strings.TrimSpace(authorName),
			Action:       "MERGE_HISTORICAL_MARKER",
			Module:       "INVENTORY",
			Details: fmt.Sprintf(
				"Fusión de marcador %s con producto real %s → nuevo código %s",
				markerBarcode, realBarcode, markerBarcode,
			),
			HumanReadable: fmt.Sprintf(
				"%s liberó el código de barras %s: fusionó el marcador histórico con el producto \"%s\" (código anterior %s), consolidando historial de kárdex, ventas y devoluciones",
				strings.TrimSpace(authorName), markerBarcode, real.ProductName, realBarcode,
			),
			Changes: fmt.Sprintf(
				`{"before":{"real":"%s","marker":"%s","markerName":"%s"},"after":{"barcode":"%s","productName":"%s"}}`,
				realBarcode, markerBarcode, escapeAuditString(marker.ProductName),
				markerBarcode, escapeAuditString(real.ProductName),
			),
			IsCritical: true,
		}
		if err := tx.Create(audit).Error; err != nil {
			return fmt.Errorf("error registrando auditoría de la fusión: %w", err)
		}

		return nil
	})
}

// escapeAuditString hace un escape mínimo para embutir un nombre de producto
// dentro del JSON que se guarda en AuditLog.Changes. No usamos json.Marshal
// para preservar el formato compacto y no complicar el diff en la revisión de
// auditoría; el frontend consume Changes como texto.
func escapeAuditString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return s
}

// InvalidateCatalogAfterMerge purga los cachés que sí quedan obsoletos por la
// fusión: la fusión cambia el barcode principal de un producto real y elimina
// un producto (el marcador), es decir cambia la forma del catálogo. Se
// exporta con nombre explícito para que el handler la llame después del
// commit exitoso.
func (r *PostgresProductRepository) InvalidateCatalogAfterMerge(barcodes ...string) {
	cache.InvalidateCache(cache.CacheKeyProducts)
	cache.InvalidateCache(cache.CacheKeyProductCount)
	cache.InvalidateCache(cache.CacheKeyProductCount + "_active")
	for _, bc := range barcodes {
		cache.InvalidateCache(fmt.Sprintf("product_barcode_%s", bc))
	}
	r.invalidateDashboardCache()
}
