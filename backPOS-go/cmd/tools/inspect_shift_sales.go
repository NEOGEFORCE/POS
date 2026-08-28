//go:build tools_legacy
// +build tools_legacy


﻿package main

import (
	"fmt"
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=invalid.invalid user=disabled dbname=disabled port=1 sslmode=disable connect_timeout=1"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error connecting to db: %v", err)
	}

	var activeShift struct {
		ID        uint
		StartDate string
	}
	db.Table("active_shifts").Order("id desc").First(&activeShift)
	fmt.Printf("Active Shift ID: %d, StartDate: %s\n", activeShift.ID, activeShift.StartDate)

	var count int64
	var total float64
	db.Table("sales").Where("created_at >= ?", activeShift.StartDate).Count(&count)
	db.Table("sales").Where("created_at >= ?", activeShift.StartDate).Select("COALESCE(SUM(total), 0)").Row().Scan(&total)
	fmt.Printf("Sales in active shift: %d sales, Total = $%.2f\n", count, total)
}
