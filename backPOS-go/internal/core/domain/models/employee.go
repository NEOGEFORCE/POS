package models

import (
	"gorm.io/gorm"
)

type Employee struct {
	DNI         string         `gorm:"primaryKey;unique;not null;column:dni" json:"dni"`
	Name        string         `gorm:"not null;column:name" json:"name"`
	Email       string         `gorm:"column:email" json:"email"`
	Password    string         `gorm:"not null;column:password" json:"-"`
	Role        string         `gorm:"type:string;default:empleado;not null;column:role" json:"role"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"`
}

func (Employee) TableName() string {
	return "employees"
}
