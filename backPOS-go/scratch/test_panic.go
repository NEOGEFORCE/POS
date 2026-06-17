package main
import (
	"fmt"
	"backPOS-go/internal/core/services"
)
func main() {
	svc := &services.ExportService{}
	p := services.ReportPayload{
		Title: "Test",
		Headers: []string{"A", "B", "C", "D", "E", "F", "G", "H"},
		Rows: [][]string{{"1", "2", "3", "4", "5", "6", "7", "8"}},
		Totals: []string{"1", "2", "3", "4", "5", "6", "7", "8"},
	}
	_, err := svc.RenderPDF(p)
	if err != nil {
		fmt.Println("Error:", err)
	} else {
		fmt.Println("Success")
	}
}
