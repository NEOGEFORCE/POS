package main

import (
	"fmt"
	"log"
	"strings"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func removeAccents(s string) string {
	replacements := map[string]string{
		"á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u",
		"Á": "A", "É": "E", "Í": "I", "Ó": "O", "Ú": "U",
	}
	for k, v := range replacements {
		s = strings.ReplaceAll(s, k, v)
	}
	return s
}

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable TimeZone=America/Bogota"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	// Update Categories
	type Category struct {
		ID   uint
		Name string
	}
	var cats []Category
	db.Find(&cats)
	for _, c := range cats {
		clean := removeAccents(c.Name)
		if clean != c.Name {
			db.Model(&c).Update("name", clean)
			fmt.Printf("Updated category: %s -> %s\n", c.Name, clean)
		}
	}

	// Update Products
	type Product struct {
		Barcode     string
		ProductName string
	}
	var prods []Product
	db.Find(&prods)
	for _, p := range prods {
		clean := removeAccents(p.ProductName)
		if clean != p.ProductName {
			db.Model(&p).Where("barcode = ?", p.Barcode).Update("product_name", clean)
			fmt.Printf("Updated product: %s -> %s\n", p.ProductName, clean)
		}
	}

	// Update Suppliers
	type Supplier struct {
		ID   uint
		Name string
	}
	var supps []Supplier
	db.Find(&supps)
	for _, s := range supps {
		clean := removeAccents(s.Name)
		if clean != s.Name {
			db.Model(&s).Update("name", clean)
			fmt.Printf("Updated supplier: %s -> %s\n", s.Name, clean)
		}
	}

	fmt.Println("Done")
}
