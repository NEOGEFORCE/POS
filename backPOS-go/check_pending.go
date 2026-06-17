package main

import (
	"fmt"
	"log"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable TimeZone=America/Bogota"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	query := `
		SELECT barcode, SUM(qty) as total_qty, MAX(supplier_name) as supplier_name
		FROM (
			SELECT i.barcode as barcode, i.expected_quantity as qty, s.name as supplier_name
			FROM expected_order_items i
			JOIN expected_orders o ON o.id = i.expected_order_id
			LEFT JOIN suppliers s ON s.id = o."supplierId"
			WHERE UPPER(o.status) = 'PENDING'
			
			UNION ALL
			
			SELECT i.product_id as barcode, i.quantity as qty, s.name as supplier_name
			FROM confirmed_order_items i
			JOIN confirmed_orders o ON o.id = i.confirmed_order_id
			LEFT JOIN suppliers s ON s.id = o.supplier_id
			WHERE UPPER(o.status) = 'PENDING'
		) t
		WHERE barcode IN ('7702032120338', '7702032120390', '7702025148110')
		GROUP BY barcode
	`

	type Result struct {
		Barcode      string
		TotalQty     float64
		SupplierName string
	}

	var results []Result
	err = db.Raw(query).Scan(&results).Error
	if err != nil {
		log.Fatal(err)
	}
	
	fmt.Printf("Results count: %v\n", len(results))
	for _, r := range results {
		fmt.Printf("Barcode: %s, TotalQty: %v\n", r.Barcode, r.TotalQty)
	}
}
