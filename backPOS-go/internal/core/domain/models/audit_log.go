package models

import "time"

type AuditLog struct {
	ID          uint      `json:"id" gorm:"primaryKey"`
	EmployeeDNI string    `json:"employee_dni"`
	Action      string    `json:"action"`
	Module      string    `json:"module"`
	Details     string    `json:"details"`
	IPAddress   string    `json:"ip_address"`
	CreatedAt   time.Time `json:"created_at"`
}
