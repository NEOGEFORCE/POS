package main

import (
	"fmt"
	"time"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		panic(err)
	}
	now := time.Now()
	from := now.AddDate(0, 0, -6)
	var results []map[string]interface{}
	db.Table("sales").
		Select("TO_CHAR(\"saleDate\" AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') as day, COALESCE(SUM(\"cashAmount\" - \"change\" + \"transferAmount\"), 0) as total").
		Where("\"saleDate\" >= ? AND \"saleDate\" <= ? AND status IN ('PAID', 'CREDIT') AND deleted_at IS NULL", from, now).
		Group("day").
		Find(&results)
	fmt.Printf("%+v\n", results)
}
