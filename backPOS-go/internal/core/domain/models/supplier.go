package models

import (
	"database/sql/driver"
	"encoding/json"
	"errors"

	"gorm.io/gorm"
)

// StringArray para almacenar arrays de strings en PostgreSQL (JSONB)
type StringArray []string

// Value serializa el array a JSON para guardar en BD
func (a StringArray) Value() (driver.Value, error) {
	if a == nil {
		return nil, nil
	}
	return json.Marshal(a)
}

// Scan deserializa JSON desde BD al array
func (a *StringArray) Scan(value interface{}) error {
	if value == nil {
		*a = nil
		return nil
	}

	var bytes []byte
	switch v := value.(type) {
	case []byte:
		bytes = v
	case string:
		bytes = []byte(v)
	default:
		return errors.New("tipo no soportado para StringArray")
	}

	return json.Unmarshal(bytes, a)
}

type Supplier struct {
	ID            uint     `gorm:"primaryKey;autoIncrement;column:id" json:"id"`
	Name          string   `gorm:"not null;column:name" json:"name"`
	Phone         string   `gorm:"column:phone" json:"phone"`
	VendorName    string   `gorm:"column:vendorName" json:"vendorName"`
	CreatedByDNI  string   `gorm:"index;column:createdByDni" json:"createdByDni"`
	CreatedByName string   `gorm:"column:createdByName" json:"createdByName"`
	UpdatedByDNI  string   `gorm:"index;column:updatedByDni" json:"updatedByDni"`
	UpdatedByName string   `gorm:"column:updatedByName" json:"updatedByName"`
	Creator       Employee `gorm:"foreignKey:CreatedByDNI;references:DNI" json:"creator,omitempty"`
	Updater       Employee `gorm:"foreignKey:UpdatedByDNI;references:DNI" json:"updater,omitempty"`
	ImageUrl      string   `gorm:"type:text;column:imageUrl" json:"imageUrl"`

	// Campos legacy (mantener compatibilidad temporal)
	VisitDay    string `gorm:"column:visitDay" json:"visitDay,omitempty"`
	DeliveryDay string `gorm:"column:deliveryDay" json:"deliveryDay,omitempty"`

	// Nuevos campos multi-días (formato JSONB en BD)
	VisitDays     StringArray `gorm:"type:jsonb;column:visit_days" json:"visitDays"`
	DeliveryDays  StringArray `gorm:"type:jsonb;column:delivery_days" json:"deliveryDays"`
	RestockMethod string      `gorm:"column:restock_method" json:"restockMethod"`

	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
	// Relaciones
	OrderMethods []SupplierOrderMethod `gorm:"foreignKey:SupplierID" json:"orderMethods,omitempty"`
}

func (Supplier) TableName() string {
	return "suppliers"
}
