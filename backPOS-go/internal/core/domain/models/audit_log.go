package models

import "time"

type AuditLog struct {
	ID            uint      `json:"id" gorm:"primaryKey"`
	EmployeeDNI   string    `json:"employee_dni"`
	EmployeeName  string    `json:"employee_name"`
	Action        string    `json:"action"` // e.g., "CREATE", "UPDATE", "DELETE", "LOGIN", "VOID_SALE"
	Module        string    `json:"module"` // e.g., "SALES", "INVENTORY", "CASH_REGISTER"
	Details       string    `json:"details"`
	HumanReadable string    `json:"human_readable"` // e.g., "Eliminó el producto OREO del carrito"
	Changes       string    `json:"changes" gorm:"type:jsonb"` // JSON string con {before: {}, after: {}}
	IsCritical    bool      `json:"is_critical"`
	IPAddress     string    `json:"ip_address"`
	Device        string    `json:"device"`
	CreatedAt     time.Time `json:"created_at"`
}
