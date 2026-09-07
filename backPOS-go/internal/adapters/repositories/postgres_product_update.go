package repositories

import (
	"fmt"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func normalizeAlternateCodes(primary, raw string) (string, []string, error) {
	seen := make(map[string]struct{})
	codes := make([]string, 0)
	for _, value := range strings.Split(raw, ",") {
		code := strings.TrimSpace(value)
		if code == "" {
			continue
		}
		if code == primary {
			return "", nil, fmt.Errorf("el código alterno %s coincide con el código principal", code)
		}
		if _, exists := seen[code]; exists {
			continue
		}
		seen[code] = struct{}{}
		codes = append(codes, code)
	}
	return strings.Join(codes, ","), codes, nil
}

func (r *PostgresProductRepository) UpdateWithTx(tx interface{}, barcode string, product *models.Product, options ports.ProductUpdateOptions) error {
	gormDB, ok := tx.(*gorm.DB)
	if !ok || gormDB == nil {
		return fmt.Errorf("transacción de producto inválida")
	}
	if product == nil {
		return fmt.Errorf("producto requerido")
	}

	var persisted models.Product
	if err := gormDB.Clauses(clause.Locking{Strength: "UPDATE"}).
		Unscoped().Where("barcode = ?", barcode).First(&persisted).Error; err != nil {
		return fmt.Errorf("producto %s no encontrado: %w", barcode, err)
	}
	if !product.UpdatedAt.IsZero() && !persisted.UpdatedAt.Equal(product.UpdatedAt) {
		return fmt.Errorf("el producto cambió mientras estaba abierto; recargue antes de guardar")
	}

	targetBarcode := strings.TrimSpace(product.Barcode)
	if targetBarcode == "" {
		targetBarcode = barcode
	}
	alternateCodes, alternates, err := normalizeAlternateCodes(targetBarcode, product.AlternateCodes)
	if err != nil {
		return err
	}

	if targetBarcode != barcode {
		var collision models.Product
		err := gormDB.Unscoped().
			Where("barcode = ? OR ? = ANY(string_to_array(COALESCE(alternate_codes, ''), ','))", targetBarcode, targetBarcode).
			First(&collision).Error
		if err == nil {
			// Arreglo 5(a): cuando el código destino está retenido por un
			// producto marcador '[HISTORICO] ...' creado en su día por
			// paquete_produccion\corregir_referencias.ps1 para tapar FKs
			// huérfanas, devolvemos un error tipado (dominio) para que el
			// handler responda 409 estructurado y el frontend pueda ofrecer
			// la fusión previa confirmación explícita del admin. El mensaje
			// visible al usuario y las instrucciones NO viajan aquí: se
			// arman en la capa HTTP a partir de la metadata.
			//
			// La semántica del contrato con /admin/products/merge-historical:
			//   RealBarcode   = código ACTUAL del producto real (X). Es el
			//                   'barcode' de la URL, el que el operador está
			//                   editando antes de intentar renombrarlo.
			//   MarkerBarcode = código que hoy ocupa el marcador '[HISTORICO]'
			//                   (B), i.e. el destino al que el operador quiere
			//                   mover al producto real.
			//
			// Enviar ambos con el mismo valor rompía la fusión: el endpoint
			// admin rechaza real==marker con "no pueden ser iguales" y el
			// helper buildMergeRequest del frontend descarta ese payload.
			if isHistoricalMarker(collision) {
				return &models.HistoricalMarkerReservedError{
					RealBarcode:   barcode,
					MarkerBarcode: targetBarcode,
					MarkerName:    collision.ProductName,
				}
			}
			return fmt.Errorf("el código de barras %s ya pertenece a %s", targetBarcode, collision.ProductName)
		}
		if err != nil && err != gorm.ErrRecordNotFound {
			return fmt.Errorf("error verificando el nuevo código: %w", err)
		}
	}

	for _, alternate := range alternates {
		var count int64
		if err := gormDB.Unscoped().Model(&models.Product{}).
			Where("barcode <> ? AND (barcode = ? OR ? = ANY(string_to_array(COALESCE(alternate_codes, ''), ',')))", barcode, alternate, alternate).
			Count(&count).Error; err != nil {
			return fmt.Errorf("error verificando código alterno %s: %w", alternate, err)
		}
		if count > 0 {
			return fmt.Errorf("el código alterno %s ya está asociado a otro producto", alternate)
		}
	}

	var previousLinks []models.ProductSupplier
	if err := gormDB.Where("product_barcode = ?", barcode).Find(&previousLinks).Error; err != nil {
		return fmt.Errorf("error cargando proveedores del producto: %w", err)
	}
	if targetBarcode != barcode || options.ReplaceSuppliers {
		if err := gormDB.Where("product_barcode = ?", barcode).Delete(&models.ProductSupplier{}).Error; err != nil {
			return fmt.Errorf("error preparando proveedores del producto: %w", err)
		}
	}

	var categoryID interface{}
	if product.CategoryID > 0 {
		categoryID = product.CategoryID
	}
	var supplierID interface{}
	if product.SupplierID != nil && *product.SupplierID > 0 {
		supplierID = *product.SupplierID
	}
	var baseBarcode interface{}
	if product.BaseProductBarcode != nil && strings.TrimSpace(*product.BaseProductBarcode) != "" {
		baseBarcode = strings.TrimSpace(*product.BaseProductBarcode)
		if baseBarcode == targetBarcode {
			return fmt.Errorf("un producto no puede ser su propio producto base")
		}
	}

	now := time.Now()
	result := gormDB.Model(&models.Product{}).Unscoped().Where("barcode = ?", barcode).Updates(map[string]interface{}{
		"barcode":            targetBarcode,
		"productName":        product.ProductName,
		"quantity":           product.Quantity,
		"isWeighted":         product.IsWeighted,
		"purchasePrice":      product.PurchasePrice,
		"salePrice":          product.SalePrice,
		"categoryId":         categoryID,
		"supplierId":         supplierID,
		"iva":                product.Iva,
		"icui":               product.Icui,
		"ibua":               product.Ibua,
		"discount":           product.Discount,
		"marginPercentage":   product.MarginPercentage,
		"imageUrl":           product.ImageUrl,
		"minStock":           product.MinStock,
		"isActive":           product.IsActive,
		"isPack":             product.IsPack,
		"packMultiplier":     product.PackMultiplier,
		"baseProductBarcode": baseBarcode,
		"alternate_codes":    alternateCodes,
		"updatedByDni":       product.UpdatedByDNI,
		"updatedByName":      product.UpdatedByName,
		"order_multiple":     product.OrderMultiple,
		"updated_at":         now,
	})
	if result.Error != nil {
		return fmt.Errorf("error actualizando producto: %w", result.Error)
	}
	if result.RowsAffected != 1 {
		return fmt.Errorf("actualización concurrente detectada para el producto %s", barcode)
	}

	if targetBarcode != barcode {
		updates := []struct {
			query string
			name  string
		}{
			{`UPDATE confirmed_order_items SET product_id = ? WHERE product_id = ?`, "pedidos confirmados"},
			{`UPDATE active_purchase_list SET product_id = ? WHERE product_id = ?`, "lista de compras"},
			{`UPDATE price_logs SET product_barcode = ? WHERE product_barcode = ?`, "historial de precios"},
			{`UPDATE supplier_product_aliases SET product_barcode = ? WHERE product_barcode = ?`, "alias de facturas"},
			{`UPDATE expected_order_items SET barcode = ? WHERE barcode = ?`, "pedidos esperados"},
			{`UPDATE daily_stock_snapshots SET product_id = ? WHERE product_id = ?`, "fotos de inventario"},
			{`UPDATE product_restock_metrics SET product_id = ? WHERE product_id = ?`, "métricas de reposición"},
			{`UPDATE shrinkages SET product_id = ? WHERE product_id = ?`, "mermas"},
			{`UPDATE sale_details SET barcode = ? WHERE barcode = ?`, "detalles de venta"},
			{`UPDATE return_details SET barcode = ? WHERE barcode = ?`, "detalles de devolución"},
			{`UPDATE stock_movements SET barcode = ? WHERE barcode = ?`, "kárdex"},
			{`UPDATE purchase_order_items SET "productBarcode" = ? WHERE "productBarcode" = ?`, "órdenes de compra"},
			{`UPDATE products SET "baseProductBarcode" = ? WHERE "baseProductBarcode" = ?`, "productos dependientes"},
		}
		for _, update := range updates {
			if err := gormDB.Exec(update.query, targetBarcode, barcode).Error; err != nil {
				return fmt.Errorf("error actualizando %s al cambiar el código: %w", update.name, err)
			}
		}
	}

	linksBySupplier := make(map[uint]models.ProductSupplier)
	for _, link := range previousLinks {
		link.ProductID = targetBarcode
		linksBySupplier[link.SupplierID] = link
	}
	if options.ReplaceSuppliers {
		selected := make(map[uint]models.ProductSupplier)
		for _, id := range options.SupplierIDs {
			if id == 0 {
				continue
			}
			link := linksBySupplier[id]
			link.ProductID = targetBarcode
			link.SupplierID = id
			selected[id] = link
		}
		linksBySupplier = selected
	}
	if options.SupplierPrice != nil {
		if link, exists := linksBySupplier[options.SupplierPrice.SupplierID]; exists || !options.ReplaceSuppliers {
			link.ProductID = targetBarcode
			link.SupplierID = options.SupplierPrice.SupplierID
			link.PurchasePrice = options.SupplierPrice.Price
			linksBySupplier[options.SupplierPrice.SupplierID] = link
		}
	}

	if targetBarcode != barcode || options.ReplaceSuppliers {
		links := make([]models.ProductSupplier, 0, len(linksBySupplier))
		for _, link := range linksBySupplier {
			links = append(links, link)
		}
		if len(links) > 0 {
			if err := gormDB.Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "product_barcode"}, {Name: "supplier_id"}},
				DoUpdates: clause.AssignmentColumns([]string{"purchasePrice", "updated_at"}),
			}).Create(&links).Error; err != nil {
				return fmt.Errorf("error guardando proveedores del producto: %w", err)
			}
		}
	} else if options.SupplierPrice != nil {
		link := models.ProductSupplier{
			ProductID:     targetBarcode,
			SupplierID:    options.SupplierPrice.SupplierID,
			PurchasePrice: options.SupplierPrice.Price,
		}
		if err := gormDB.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "product_barcode"}, {Name: "supplier_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"purchasePrice", "updated_at"}),
		}).Create(&link).Error; err != nil {
			return fmt.Errorf("error actualizando precio del proveedor: %w", err)
		}
	}

	product.Barcode = targetBarcode
	product.AlternateCodes = alternateCodes
	product.UpdatedAt = now
	return nil
}

func (r *PostgresProductRepository) AfterCommitUpdate(barcodes ...string) {
	cache.InvalidateCache(cache.CacheKeyProducts)
	cache.InvalidateCache(cache.CacheKeyProductCount)
	for key := range cache.CacheManager.Items() {
		if strings.HasPrefix(key, "product_barcode_") {
			cache.InvalidateCache(key)
		}
	}
	r.invalidateDashboardCache()
}
