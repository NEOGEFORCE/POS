package repositories

import (
	"fmt"
	"testing"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"pos/internal/core/models"
)

func TestPrintClosures(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("../../../pos.db"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}

	var closures []models.CashierClosure
	db.Order("id desc").Limit(1).Find(&closures)

	for _, c := range closures {
		fmt.Printf("ID: %d\n", c.ID)
		fmt.Printf("TotalSales: %f\n", c.TotalSales)
		fmt.Printf("TotalExpenses: %f\n", c.TotalExpenses)
		fmt.Printf("PhysicalCash: %f\n", c.PhysicalCash)
		fmt.Printf("ExpensesDetail: %s\n\n", c.ExpensesDetail)
	}
}
