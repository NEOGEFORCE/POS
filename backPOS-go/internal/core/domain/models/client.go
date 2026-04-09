package models

import (
	"time"

	"gorm.io/gorm"
)

type Client struct {
	DNI           string         `gorm:"primaryKey;unique;not null;column:dni" json:"dni"`
	Name          string         `gorm:"not null;column:name" json:"name"`
	Phone         string         `gorm:"column:phone" json:"phone"`
	Address       string         `gorm:"column:address" json:"address"`
	CreatedByDNI  string         `gorm:"index;column:createdByDni" json:"createdByDni"`
	CreatedByName string         `gorm:"column:createdByName" json:"createdByName"`
	UpdatedByDNI  string         `gorm:"index;column:updatedByDni" json:"updatedByDni"`
	UpdatedByName string         `gorm:"column:updatedByName" json:"updatedByName"`
	Creator       Employee       `gorm:"foreignKey:CreatedByDNI;references:DNI" json:"creator,omitempty"`
	Updater       Employee       `gorm:"foreignKey:UpdatedByDNI;references:DNI" json:"updater,omitempty"`
	TotalSpent    float64        `gorm:"->" json:"totalSpent"`
	LastPurchaseDate *time.Time `gorm:"->" json:"lastPurchaseDate"`
	CreditLimit   float64        `gorm:"type:decimal(10,2);default:0;column:creditLimit" json:"creditLimit"`
	CurrentCredit float64        `gorm:"type:decimal(10,2);default:0;column:currentCredit" json:"currentCredit"`
	DeletedAt     gorm.DeletedAt `gorm:"index" json:"-"`
}

func (Client) TableName() string {
	return "clients"
}
