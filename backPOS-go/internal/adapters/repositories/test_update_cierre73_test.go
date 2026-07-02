package repositories_test

import (
	"testing"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"backPOS-go/internal/core/domain/models"
)

func TestUpdateCierre73Again(t *testing.T) {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable TimeZone=America/Bogota"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}

	var c models.CashierClosure
	err = db.Where("id = ?", 73).First(&c).Error
	if err != nil {
		t.Fatal(err)
	}

	c.Difference = 100890
	c.TotalNequiReal = 211000
	c.TotalDaviplataReal = 231100
	
	err = db.Save(&c).Error
	if err != nil {
		t.Fatal(err)
	}
}
