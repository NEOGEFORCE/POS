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

	var shift map[string]interface{}
	db.Table("active_shifts").Order("id desc").Take(&shift)
	fmt.Printf("Active Shift: %+v\n", shift)

	var count int64
	var total float64
	db.Table("sales").Where("created_at >= '2026-07-30 00:00:00'").Count(&count)
	db.Table("sales").Where("created_at >= '2026-07-30 00:00:00'").Select("COALESCE(SUM(total), 0)").Row().Scan(&total)
	fmt.Printf("Today Sales (since 00:00): %d sales, Total = $%.2f\n", count, total)
}
