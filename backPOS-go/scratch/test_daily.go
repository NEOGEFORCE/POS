package main

import (
	"fmt"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		panic(err)
	}
	var results []map[string]interface{}
	db.Table("sales").Select("COALESCE(SUM(\"cashAmount\" + \"transferAmount\"), 0) as total, COALESCE(SUM(\"totalAmount\"), 0) as total_bruto").Where("DATE(\"saleDate\" AT TIME ZONE 'America/Bogota') = '2026-06-06' AND deleted_at IS NULL").Find(&results)
	fmt.Printf("%+v\n", results)
}
