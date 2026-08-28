//go:build tools_legacy
// +build tools_legacy


package main

import (
	"fmt"
	"log"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type CashierClosure struct {
	ID           uint    `gorm:"primaryKey"`
	PhysicalCash float64 `gorm:"column:physical_cash"`
	TotalSales   float64 `gorm:"column:total_sales"`
	ExpectedCash float64 `gorm:"column:expected_cash"`
	Difference   float64 `gorm:"column:difference"`
	Expenses     string  `gorm:"column:expenses"`
}

func check(host string) {
	dsn := "host=invalid.invalid user=disabled dbname=disabled port=1 sslmode=disable connect_timeout=1"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Printf("[%s] Connect err: %v\n", host, err)
		return
	}
	var c CashierClosure
	err = db.Table("cashier_closures").Where("id = ?", 141).First(&c).Error
	if err != nil {
		log.Printf("[%s] Query err: %v\n", host, err)
		return
	}
	fmt.Printf("[%s] ID: %d, physical_cash: %.2f, total_sales: %.2f, expected_cash: %.2f, difference: %.2f\n", host, c.ID, c.PhysicalCash, c.TotalSales, c.ExpectedCash, c.Difference)
}

func main() {
	check("127.0.0.1")
	check("192.168.1.6")
}
