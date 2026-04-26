package models

import (
	"gorm.io/gorm"
)

type Category struct {
	ID            uint           `gorm:"primaryKey;autoIncrement;column:id" json:"id"`
	Name          string         `gorm:"not null;column:name" json:"name"`
	CreatedByDNI  string         `gorm:"index;column:createdByDni" json:"createdByDni"`
	CreatedByName string         `gorm:"column:createdByName" json:"createdByName"`
	UpdatedByDNI  string         `gorm:"index;column:updatedByDni" json:"updatedByDni"`
	UpdatedByName string         `gorm:"column:updatedByName" json:"updatedByName"`
	Creator       Employee       `gorm:"foreignKey:CreatedByDNI;references:DNI" json:"creator,omitempty"`
	Updater       Employee       `gorm:"foreignKey:UpdatedByDNI;references:DNI" json:"updater,omitempty"`
	ProductCount  int64          `gorm:"->;column:product_count" json:"productCount"`
	DeletedAt     gorm.DeletedAt `gorm:"index" json:"-"`
}

func (Category) TableName() string {
	return "categories"
}
