package main

import (
	"fmt"

	"backPOS-go/internal/adapters/repositories"
	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()
	repositories.ConnectDB()
	db := repositories.DB

	var closureSales float64
	db.Table("cashier_closures").
		Where(`DATE(end_date AT TIME ZONE 'America/Bogota') BETWEEN '2026-07-01' AND '2026-07-31'`).
		Select(`COALESCE(SUM(physical_cash + total_card + total_transfer + total_expenses), 0)`).
		Scan(&closureSales)

	fmt.Printf("1. physical_cash + total_card + total_transfer + total_expenses: $%f\n", closureSales)

	var totalSalesCol float64
	db.Table("cashier_closures").
		Where(`DATE(end_date AT TIME ZONE 'America/Bogota') BETWEEN '2026-07-01' AND '2026-07-31'`).
		Select(`COALESCE(SUM(total_sales), 0)`).
		Scan(&totalSalesCol)

	fmt.Printf("2. SUM(total_sales) from closures: $%f\n", totalSalesCol)
}
