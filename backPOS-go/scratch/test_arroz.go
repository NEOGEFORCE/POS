package main

import (
	"database/sql"
	"fmt"
	"log"

	_ "github.com/lib/pq"
	_ "gorm.io/driver/postgres"
)

func main() {
	db, err := sql.Open("postgres", "host=localhost user=postgres password=postgres dbname=pos_pro port=5432 sslmode=disable")
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	rows, err := db.Query("SELECT barcode, name, supplier_id FROM products WHERE name ILIKE '%ARROZ%' LIMIT 10")
	if err != nil {
		log.Fatal(err)
	}
	defer rows.Close()

	for rows.Next() {
		var barcode, name string
		var supplierId int
		rows.Scan(&barcode, &name, &supplierId)
		fmt.Printf("Barcode: %s, Name: %s, Supplier: %d\n", barcode, name, supplierId)
	}
}
