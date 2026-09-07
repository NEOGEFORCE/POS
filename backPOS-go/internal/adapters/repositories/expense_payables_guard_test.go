package repositories

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// ============================================================================
// GUARDIÁN: LAS CUENTAS POR PAGAR NO PUEDEN TRUNCARSE
// ============================================================================
//
// Bug reportado por el dueño el 2026-09-04: las cuentas por pagar "iban en
// 8 millones 900 y ahora sale 7 millones algo", con facturas fiadas que él
// había registrado y ya no aparecían.
//
// CAUSA: GetAll y GetAllFiltered devolvían sólo las 1000 filas más recientes
// por fecha (Limit(1000)). La pantalla de Egresos suma la tarjeta "Cuentas por
// Pagar" sobre las filas que recibe, así que toda factura fiada más vieja que
// la fila 1000 quedaba fuera del total aunque siguiera viva en la base. Con el
// ritmo de egresos diarios la ventana avanza sola y las deudas viejas se caen
// por atrás: la cifra baja día a día sin que nadie toque esas facturas.
//
// La ventana de 1000 filas se conserva para la tabla (el historial crece sin
// techo), pero las deudas vivas se traen aparte SIN LÍMITE.
//
// Estos tests son estáticos: leen el código fuente. No necesitan Postgres, que
// es la convención de tests del proyecto (ver test-sin-postgres).

func readExpenseRepoSource(t *testing.T) string {
	t.Helper()
	path := filepath.Join("postgres_expense_repository.go")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no se pudo leer %s: %v", path, err)
	}
	return string(b)
}

// extractFunc devuelve el cuerpo de una función a partir de su firma hasta la
// siguiente declaración de función de nivel superior.
func extractFunc(t *testing.T, src, signature string) string {
	t.Helper()
	start := strings.Index(src, signature)
	if start < 0 {
		t.Fatalf("no se encontró la firma %q", signature)
	}
	rest := src[start+len(signature):]
	if end := strings.Index(rest, "\nfunc "); end >= 0 {
		return rest[:end]
	}
	return rest
}

func TestGetAllFilteredTraeLasDeudasVivasSinLimite(t *testing.T) {
	src := readExpenseRepoSource(t)
	body := extractFunc(t, src, "func (r *PostgresExpenseRepository) GetAllFiltered(")

	// Debe consultar explícitamente el universo de deudas vivas.
	if !strings.Contains(body, "pendingDebtCondition") {
		t.Fatal("GetAllFiltered debe traer las deudas vivas usando pendingDebtCondition; sin eso las cuentas por pagar viejas se truncan")
	}

	// La consulta de deudas NO puede llevar Limit. Se verifica que después de
	// aplicar pendingDebtCondition no aparezca un Limit antes del Find.
	idx := strings.Index(body, "pendingDebtCondition")
	tail := body[idx:]
	findIdx := strings.Index(tail, "Find(")
	if findIdx < 0 {
		t.Fatal("la consulta de deudas vivas debe terminar en Find(...)")
	}
	if strings.Contains(tail[:findIdx], "Limit(") {
		t.Fatal("la consulta de deudas vivas NO puede llevar Limit: es exactamente el bug que hacía desaparecer facturas fiadas")
	}
}

func TestGetAllNoTieneSuPropioLimite(t *testing.T) {
	src := readExpenseRepoSource(t)
	body := extractFunc(t, src, "func (r *PostgresExpenseRepository) GetAll(")

	// GetAll es la ruta que sirve la carga inicial de la pantalla (el servicio
	// llama a GetAll cuando no hay filtros). Si vuelve a tener su propia
	// consulta con Limit, el bug regresa por esa puerta.
	if strings.Contains(body, "Limit(") {
		t.Fatal("GetAll no debe tener su propia consulta con Limit: debe delegar en GetAllFiltered para que exista una sola implementación")
	}
	if !strings.Contains(body, "GetAllFiltered") {
		t.Fatal("GetAll debe delegar en GetAllFiltered")
	}
}

// La condición de "deuda viva" debe ser LA MISMA en las tres puertas al mismo
// universo. Si una divergiera, dos pantallas mostrarían cifras distintas de la
// misma plata, que es el patrón de bug más repetido de este proyecto.
func TestCondicionDeDeudaVivaEsUnaSola(t *testing.T) {
	src := readExpenseRepoSource(t)

	// La constante canónica debe existir y cubrir los tres criterios.
	if !strings.Contains(src, "pendingDebtCondition") {
		t.Fatal("debe existir la constante pendingDebtCondition como fuente única")
	}
	constIdx := strings.Index(src, "pendingDebtCondition = ")
	if constIdx < 0 {
		t.Fatal("pendingDebtCondition debe declararse como constante")
	}
	constLine := src[constIdx:]
	if nl := strings.Index(constLine, "\n"); nl > 0 {
		constLine = constLine[:nl]
	}
	for _, needed := range []string{"PENDING", "PRESTAMO", "PREST.", "PAID", "SETTLED"} {
		if !strings.Contains(constLine, needed) {
			t.Errorf("pendingDebtCondition debe mencionar %q; línea: %s", needed, constLine)
		}
	}

	// GetPendingDebtsSummary es la fórmula que alimenta el dashboard y debe
	// seguir sumando el impuesto: la factura del proveedor se debe completa.
	summary := extractFunc(t, src, "func (r *PostgresExpenseRepository) GetPendingDebtsSummary(")
	if !strings.Contains(summary, "tax_amount") {
		t.Error("GetPendingDebtsSummary debe sumar tax_amount: la deuda con el proveedor incluye el impuesto")
	}
	if !strings.Contains(summary, "remaining_amount") {
		t.Error("GetPendingDebtsSummary debe usar remaining_amount para respetar los abonos parciales")
	}
}

// Ninguna consulta que responda "cuánto se debe" puede quedar acotada por un
// LIMIT numérico: un total parcial es peor que un error, porque parece correcto.
func TestNingunaConsultaDeDeudaUsaLimiteNumerico(t *testing.T) {
	src := readExpenseRepoSource(t)
	summary := extractFunc(t, src, "func (r *PostgresExpenseRepository) GetPendingDebtsSummary(")
	if regexp.MustCompile(`Limit\(\s*\d+\s*\)`).MatchString(summary) {
		t.Fatal("GetPendingDebtsSummary no puede llevar Limit: debe agregar sobre toda la tabla")
	}

	byStatus := extractFunc(t, src, "func (r *PostgresExpenseRepository) GetExpensesByStatus(")
	if regexp.MustCompile(`Limit\(\s*\d+\s*\)`).MatchString(byStatus) {
		t.Fatal("GetExpensesByStatus no puede llevar Limit cuando lista deudas pendientes")
	}
}
