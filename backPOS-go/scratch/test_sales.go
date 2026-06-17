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
	db.Table("sales").
		Select("DATE(\"saleDate\" AT TIME ZONE 'America/Bogota') as day, SUM(\"cashAmount\" + \"transferAmount\") as total").
		Where("status IN ('COMPLETED', 'CREDIT')").
		Group("day").
		Order("day DESC").
		Limit(5).
		Find(&results)
	fmt.Printf("%+v\n", results)
}
