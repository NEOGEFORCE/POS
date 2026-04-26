package models

import (
	"time"
	"gorm.io/gorm"
)

type Employee struct {
	DNI         string         `gorm:"primaryKey;unique;not null;column:dni" json:"dni"`
	Name        string         `gorm:"not null;column:name" json:"name"`
	Email       string         `gorm:"column:email" json:"email"`
	Password    string         `gorm:"not null;column:password" json:"-"`
	Role        string         `gorm:"type:string;default:empleado;not null;column:role" json:"role"`
	IsActive    bool           `gorm:"type:boolean;default:true;not null;column:is_active" json:"is_active"`
	CreatedAt   time.Time      `gorm:"column:created_at" json:"created_at"`
	LastLogin   *time.Time     `gorm:"column:last_login" json:"last_login"`
	UpdatedAt   time.Time      `gorm:"column:updatedat" json:"updatedat"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"`
}

func (Employee) TableName() string {
	return "employees"
}
