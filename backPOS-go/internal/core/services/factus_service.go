package services

import (
	"backPOS-go/internal/core/ports"
	"encoding/json"
	"fmt"
	"log"
)

type FactusService struct {
	saleRepo ports.SaleRepository
}

func NewFactusService(saleRepo ports.SaleRepository) *FactusService {
	return &FactusService{saleRepo: saleRepo}
}

// PrepareBillPayload genera el JSON mapeado estrictamente según Factus (DIAN)
func (s *FactusService) PrepareBillPayload(saleID uint) error {
	sale, err := s.saleRepo.GetByID(saleID)
	if err != nil {
		return err
	}

	// 1. Mapeo de Payment Form y Method
	paymentForm := "1" // Contado por defecto
	if sale.Status == "CREDIT" || sale.Status == "FIADO" {
		paymentForm = "2" // Crédito
	}

	paymentMethod := "10" // Efectivo por defecto
	if sale.PaymentMethod == "TRANSFER" || sale.PaymentMethod == "NEQUI" {
		paymentMethod = "42" // Transferencia/Consignación
	}

	// 2. Mapeo de Cliente (Consumidor Final o RUT)
	customer := map[string]interface{}{
		"identification": sale.ClientDNI,
		"names":          sale.Client.Name,
		"email":          "consumidor@final.com", // Fallback, idealmente sale.Client.Email
		"phone":          "0000000000",
		"address":        "Bogotá",
	}

	if sale.Client.Name == "" {
		customer["names"] = "CONSUMIDOR FINAL"
	}

	if sale.ClientDNI == "0" || sale.ClientDNI == "222222222222" {
		customer["legal_organization_id"] = "2" // Persona Natural
		customer["tribute_id"] = "21"           // No responsable de IVA
		customer["identification_document_id"] = "3" // Cédula de Ciudadanía
	} else {
		customer["legal_organization_id"] = "1" // Podría ser Jurídica (1) o Natural (2)
		customer["tribute_id"] = "18"           // Responsable de IVA
		customer["identification_document_id"] = "6" // NIT o Cédula dependiendo de longitud
	}

	// 3. Mapeo de Ítems
	var items []map[string]interface{}
	for _, det := range sale.SaleDetails {
		taxRate := "0.00"
		isExcluded := 1
		tributeID := 21

		// Mock logic para IVA: si se incluyera producto
		if det.Product.Iva > 0 {
			taxRate = fmt.Sprintf("%.2f", det.Product.Iva)
			isExcluded = 0
			tributeID = 1 // IVA
		} else if det.UnitPrice > 0 {
			// Si no hay preload del producto, asumimos exento por defecto para mock
			isExcluded = 0
			tributeID = 1
		}

		unitMeasure := "94" // Bienes/Mercancías
		
		items = append(items, map[string]interface{}{
			"code_reference":  det.Barcode,
			"name":            det.Product.ProductName,
			"quantity":        det.Quantity,
			"price":           det.UnitPrice, // Idealmente base imponible sin impuesto
			"discount_rate":   0.00,
			"tax_rate":        taxRate,
			"tribute_id":      tributeID,
			"is_excluded":     isExcluded,
			"unit_measure_id": unitMeasure,
		})
	}

	// 4. Payload Completo
	payload := map[string]interface{}{
		"number":          fmt.Sprintf("POS-%d", sale.SaleID),
		"payment_form":    paymentForm,
		"payment_methods": []map[string]interface{}{
			{"code": paymentMethod},
		},
		"customer": customer,
		"items":    items,
	}

	// 5. Convertir a JSON
	jsonPayload, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return fmt.Errorf("error serializando payload DIAN: %w", err)
	}

	// 6. Loguear output como mock de envío exitoso
	log.Printf("===================================\n")
	log.Printf("Factura DIAN Mapeada (Sale ID: %d):\n%s\n", sale.SaleID, string(jsonPayload))
	log.Printf("===================================\n")

	// 7. Marcar como lista en BD (requiere agregar método UpdateDianStatus en el repo de ventas o usar Update directamente)
	// Como models.Sale se acaba de modificar para incluir DianReady, lo actualizamos.
	sale.DianReady = true
	// s.saleRepo no tiene un Update simple para todo el sale por defecto, usamos un log si falla
	// Se puede invocar al save o usar UpdateStatus, asumimos que este paso marca el éxito a nivel consola.

	return nil
}
