package main

import (
	"fmt"
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	// Reemplaza los datos si es necesario (tomado de check_employees.go)
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("❌ Error conectando a la base de datos: %v", err)
	}

	fmt.Println("⚠️  INICIANDO LIMPIEZA DE BASE DE DATOS (FRESH START)...")
	fmt.Println("=========================================================")

	// 1. Eliminar todos los detalles de ventas y devoluciones que ya no son deudas ni están pendientes
	exec(db, `DELETE FROM return_details;`)
	exec(db, `DELETE FROM returns;`)
	exec(db, `DELETE FROM sale_details WHERE "saleId" IN (
		SELECT "saleId" FROM sales 
		WHERE "debtPending" <= 0 AND UPPER(status) != 'PENDING'
	);`)

	// 2. Eliminar todas las ventas que no sean deudas ni pendientes (Fiados se mantienen)
	exec(db, `DELETE FROM sales WHERE "debtPending" <= 0 AND UPPER(status) != 'PENDING';`)

	// 3. Eliminar egresos (mantener solo las cuentas por pagar / deudas a proveedores)
	exec(db, `DELETE FROM expenses WHERE UPPER(status) != 'PENDING' AND UPPER("paymentSource") NOT IN ('PRESTAMO', 'PREST.');`)

	// 4. Eliminar abonos históricos (los saldos actuales de fiados ya están guardados en debtPending de las ventas conservadas)
	exec(db, `DELETE FROM credit_payments;`)

	// 5. Eliminar Cierres y Turnos Activos
	exec(db, `DELETE FROM cashier_closures;`)
	exec(db, `DELETE FROM active_shifts;`)

	// 6. Eliminar historiales auxiliares (Mermas, Movimientos de Stock, Auditoría, Reportes)
	exec(db, `DELETE FROM shrinkages;`)
	exec(db, `DELETE FROM stock_movements;`)
	exec(db, `DELETE FROM audit_logs;`)
	exec(db, `DELETE FROM report_histories;`)

	// 7. Refrescar la vista materializada para que el dashboard también quede en cero
	exec(db, `REFRESH MATERIALIZED VIEW mv_dashboard_stats_monthly;`)

	fmt.Println("=========================================================")
	fmt.Println("✅ LIMPIEZA COMPLETADA CON ÉXITO.")
	fmt.Println("Todos los datos de ventas (no fiados), gastos, cierres y caja han sido eliminados.")
	fmt.Println("Los productos, clientes, inventario, precios y DEUDAS (fiados) se mantienen intactos.")
}

func exec(db *gorm.DB, query string) {
	fmt.Printf("Ejecutando: %s\n", query)
	if err := db.Exec(query).Error; err != nil {
		fmt.Printf("❌ Error: %v\n", err)
	}
}
