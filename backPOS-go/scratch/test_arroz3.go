package main

import (
	"database/sql"
	"fmt"
	"log"

	_ "github.com/mattn/go-sqlite3"
)

func main() {
	db, err := sql.Open("sqlite3", "pos_prod.db") // Or whatever DB file is used
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	// List tables to be sure
	rows, err := db.Query("SELECT name FROM sqlite_master WHERE type='table';")
	if err == nil {
		for rows.Next() {
			var name string
			rows.Scan(&name)
			fmt.Println("Table:", name)
		}
		rows.Close()
	}

	rows, err = db.Query("SELECT barcode, name, supplier_id FROM products WHERE name LIKE '%ARROZ%' LIMIT 10")
	if err != nil {
		log.Fatal(err)
	}
	defer rows.Close()

	for rows.Next() {
		var barcode, name sql.NullString
		var supplierId sql.NullInt64
		rows.Scan(&barcode, &name, &supplierId)
		fmt.Printf("Barcode: %s, Name: %s, Supplier: %d\n", barcode.String, name.String, supplierId.Int64)
	}
}
