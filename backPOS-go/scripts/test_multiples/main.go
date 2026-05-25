package main

import (
	"fmt"
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	// Actualizar PANELISTA a múltiplo de 12 y JABÓN a 24 para ver el efecto visual
	fmt.Println("Actualizando múltiplos de prueba...")
	
	db.Exec("UPDATE products SET order_multiple = 12 WHERE \"productName\" ILIKE '%PANELISTA%'")
	db.Exec("UPDATE products SET order_multiple = 24 WHERE \"productName\" ILIKE '%JABÓN SUPER RIEL%'")

	fmt.Println("✅ Múltiplos actualizados. Refresca el navegador ahora.")
}
