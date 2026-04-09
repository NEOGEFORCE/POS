package services

import (
	"backPOS-go/internal/core/domain/models"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
)

type PrintService struct{}

func NewPrintService() *PrintService {
	return &PrintService{}
}

func (s *PrintService) PrintReceipt(sale *models.Sale) error {
	// 1. Generar el contenido del ticket (Puro texto para compatibilidad 80mm)
	content := s.formatReceipt(sale)

	// 2. Guardar en un archivo temporal
	tempFile := filepath.Join(os.TempDir(), fmt.Sprintf("receipt_%d.txt", sale.SaleID))
	err := os.WriteFile(tempFile, []byte(content), 0644)
	if err != nil {
		return fmt.Errorf("error al crear archivo temporal: %v", err)
	}
	defer os.Remove(tempFile)

	// 3. Enviar a la impresora usando el comando de Windows (Debe estar compartida como XP-80)
	// Comando: cmd /c copy /b <archivo> \\localhost\XP-80
	cmd := exec.Command("cmd", "/C", "copy", "/b", tempFile, `\\localhost\XP-80`)
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("⚠️ Error imprimiendo ticket: %v | Output: %s", err, string(output))
		return fmt.Errorf("error al enviar a impresora: %v", err)
	}

	log.Printf("✅ Ticket de venta #%d impreso correctamente en XP-80", sale.SaleID)
	return nil
}

func (s *PrintService) formatReceipt(sale *models.Sale) string {
	separator := "--------------------------------\n" // 32 chars for 80mm approx in raw font
	
	t := "\n      SISTEMA POS PRO V4\n"
	t += "      Terminal de Ventas\n"
	t += separator
	t += fmt.Sprintf("TICKET:  #%d\n", sale.SaleID)
	t += fmt.Sprintf("FECHA:   %s\n", sale.SaleDate.Format("02/01/2006 15:04:05"))
	t += fmt.Sprintf("CLIENTE: %s\n", sale.Client.Name)
	if sale.Client.DNI != "0" {
		t += fmt.Sprintf("DNI:     %s\n", sale.Client.DNI)
	}
	t += separator
	t += fmt.Sprintf("%-18s %4s %6s\n", "ARTICULO", "CANT", "SUB")
	
	for _, d := range sale.SaleDetails {
		name := d.Product.ProductName
		if name == "" {
			name = "Producto" // Fallback si no está cargado
		}
		if len(name) > 17 {
			name = name[:17]
		}
		t += fmt.Sprintf("%-18s %4.1f %6.0f\n", name, d.Quantity, d.Subtotal)
	}
	
	t += separator
	t += fmt.Sprintf("IVA (19%%):       $%10.0f\n", sale.TotalAmount - (sale.TotalAmount/1.19))
	t += fmt.Sprintf("TOTAL:           $%10.0f\n", sale.TotalAmount)
	t += separator
	
	if sale.CashAmount > 0 {
		t += fmt.Sprintf("EFECTIVO:        $%10.0f\n", sale.CashAmount)
	}
	if sale.TransferAmount > 0 {
		t += fmt.Sprintf("TRANSF (%s): $%10.0f\n", sale.TransferSource, sale.TransferAmount)
	}
	if sale.CreditAmount > 0 {
		t += fmt.Sprintf("FIADO:           $%10.0f\n", sale.CreditAmount)
	}
	
	t += fmt.Sprintf("CAMBIO:          $%10.0f\n", sale.Change)
	t += separator
	t += "\n   ¡GRACIAS POR SU COMPRA!\n\n\n\n\n" // Extra newlines for cutting

	return t
}
