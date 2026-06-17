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
	var cols []string
	db.Raw("SELECT column_name FROM information_schema.columns WHERE table_name='cashier_closures'").Scan(&cols)
	fmt.Printf("%+v\n", cols)
}
