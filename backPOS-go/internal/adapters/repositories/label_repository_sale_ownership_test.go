package repositories

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
)

// =============================================================================
// Pruebas de IsSaleOwnedByCashier y HasRecentSaleByCashier.
//
// Este bloque fija el SQL EMITIDO para el cross-check de propiedad de la
// venta cuando se abre el cajón:
//
//   - La columna real de la clave primaria de `sales` es `"saleId"`
//     (quoted camelCase, ver models.Sale.SaleID con tag `column:saleId`).
//     Un `WHERE id = ?` compilaba pero NO filtraba por la venta: `id` no
//     existe en esta tabla. El bug anterior volvía inútil al cross-check.
//
//   - El bind debe ir parametrizado (`$1`, `$2`, `$3`) y nunca concatenar
//     el saleID ni el DNI directamente al SQL.
//
//   - El filtro `deleted_at IS NULL` sigue vigente: una venta cancelada
//     no legitima una apertura.
//
//   - La ventana temporal de HasRecentSaleByCashier debe seguir usando
//     `"employeeDni"` + `"saleDate"` quoted camelCase.
//
// Las pruebas corren contra fakeSQL (database/sql driver en memoria),
// no requieren Postgres y no tocan ninguna base.
// =============================================================================

// TestIsSaleOwnedByCashier_UsaColumnaSaleIdQuotada verifica el SQL exacto
// que el repo emite. Un bug previo usaba `id = ?`, con lo que Postgres
// devolvía "column id does not exist" y el handler no podía detectar
// que un cajero citaba la venta de otro.
func TestIsSaleOwnedByCashier_UsaColumnaSaleIdQuotada(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		return fakeResult{Columns: []string{"count"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	owned, err := repo.IsSaleOwnedByCashier(context.Background(), 42, "EMP-001")
	if err != nil {
		t.Fatalf("IsSaleOwnedByCashier: %v", err)
	}
	if !owned {
		t.Fatalf("respuesta count=1 debe reportar owned=true; got %v", owned)
	}

	stmts := f.statements()
	if len(stmts) != 1 {
		t.Fatalf("se esperaba 1 sentencia (COUNT), hubo %d: %+v", len(stmts), stmts)
	}
	st := stmts[0]

	// La columna real debe ser "saleId" quoted. Prohibimos la forma
	// cruda `id = ?` sin comilla doble; permitimos `"saleId" = $1`.
	if !strings.Contains(st.SQL, `"saleId" = $1`) {
		t.Errorf(`debe filtrar por "saleId" = $1 (la columna real de la PK); SQL=%s`, st.SQL)
	}
	// Debe cruzar con "employeeDni" para evitar que un cajero cite la
	// venta de un compañero.
	if !strings.Contains(st.SQL, `"employeeDni" = $2`) {
		t.Errorf(`debe cruzar con "employeeDni" = $2; SQL=%s`, st.SQL)
	}
	// Y debe excluir ventas borradas.
	if !strings.Contains(st.SQL, "deleted_at IS NULL") {
		t.Errorf("debe filtrar deleted_at IS NULL; SQL=%s", st.SQL)
	}
	// Nunca `id = ?` cruda. Un `id =` sin comilla doble implica que la
	// consulta buscaría una columna que no existe en `sales` (saleId es
	// la real) y rompería o devolvería datos basura.
	if strings.Contains(st.SQL, "sales.id = ") || strings.Contains(st.SQL, " id = $") || strings.Contains(st.SQL, "WHERE id =") {
		t.Errorf(`no debe filtrar por una columna "id" cruda; SQL=%s`, st.SQL)
	}

	// Bind parametrizado: no concatenaciones del saleID ni del DNI.
	if len(st.Vars) < 2 {
		t.Fatalf("se esperaban al menos 2 bind vars; got %v", st.Vars)
	}
	// Primer bind debe ser el saleID; GORM puede propagarlo como int64/uint.
	switch v := st.Vars[0].(type) {
	case int64:
		if v != 42 {
			t.Errorf("bind[0] debe ser saleID=42; got %v", v)
		}
	case int32:
		if v != 42 {
			t.Errorf("bind[0] debe ser saleID=42; got %v", v)
		}
	case uint, uint64, uint32:
		if _, ok := v.(uint); ok {
			if v != uint(42) {
				t.Errorf("bind[0] debe ser saleID=42; got %v", v)
			}
		}
	default:
		// Toleramos cualquier numérico que serialice a 42.
		s := strings.TrimSpace(toStr(v))
		if s != "42" {
			t.Errorf("bind[0] debe ser saleID=42; got %T=%v", v, v)
		}
	}
	// Segundo bind debe ser el DNI.
	if s, ok := st.Vars[1].(string); !ok || s != "EMP-001" {
		t.Errorf("bind[1] debe ser dni=EMP-001; got %T=%v", st.Vars[1], st.Vars[1])
	}
	// No deben aparecer concatenaciones en el SQL (el saleID y el DNI
	// jamás viajan como literales dentro del texto).
	if strings.Contains(st.SQL, "42") || strings.Contains(st.SQL, "EMP-001") {
		t.Errorf("saleID o DNI aparecen embebidos en el SQL (debe ir como bind); SQL=%s", st.SQL)
	}
}

// TestIsSaleOwnedByCashier_InputVacioNoConsulta: inputs inválidos
// (saleID=0 o DNI vacío) deben rechazarse en Go sin tocar la BD, para
// no gastar un roundtrip y no exponer la columna real en logs si no es
// necesario.
func TestIsSaleOwnedByCashier_InputVacioNoConsulta(t *testing.T) {
	f := &fakeSQL{respond: func(_ string, _ []interface{}) fakeResult {
		return fakeResult{Err: errors.New("no debería ejecutarse: input inválido")}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	cases := []struct {
		name   string
		saleID uint
		dni    string
	}{
		{"saleID cero", 0, "EMP-001"},
		{"dni vacío", 7, ""},
		{"dni con solo espacios", 7, "   "},
		{"ambos vacíos", 0, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			owned, err := repo.IsSaleOwnedByCashier(context.Background(), tc.saleID, tc.dni)
			if err != nil {
				t.Fatalf("input inválido no debe producir error; got %v", err)
			}
			if owned {
				t.Fatalf("input inválido debe reportar owned=false; got true")
			}
		})
	}
	if len(f.statements()) != 0 {
		t.Errorf("no se esperaba ningún SQL con inputs inválidos; stmts=%+v", f.statements())
	}
}

// TestIsSaleOwnedByCashier_NoOwned: cuando `sales` no tiene fila que
// case `(saleId=X, employeeDni=Y)`, el repo responde owned=false. Es el
// caso defensivo que debe disparar el 403
// `CASH_DRAWER_SALE_NOT_OWNED` en el handler.
func TestIsSaleOwnedByCashier_NoOwned(t *testing.T) {
	f := &fakeSQL{respond: func(_ string, _ []interface{}) fakeResult {
		return fakeResult{Columns: []string{"count"}, Rows: [][]driver.Value{{int64(0)}}}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	owned, err := repo.IsSaleOwnedByCashier(context.Background(), 999, "OTRO-CAJERO")
	if err != nil {
		t.Fatalf("IsSaleOwnedByCashier: %v", err)
	}
	if owned {
		t.Fatalf("count=0 debe mapear a owned=false; got true")
	}
}

// TestIsSaleOwnedByCashier_ErrorDeBDBurbujea: si la BD devuelve error
// (ej. tabla inexistente), el repo lo propaga tal cual. El handler
// responde 500 y la auditoría no queda registrada.
func TestIsSaleOwnedByCashier_ErrorDeBDBurbujea(t *testing.T) {
	wantErr := errors.New(`relation "sales" does not exist`)
	f := &fakeSQL{respond: func(_ string, _ []interface{}) fakeResult {
		return fakeResult{Err: wantErr}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	owned, err := repo.IsSaleOwnedByCashier(context.Background(), 1, "EMP-001")
	if err == nil {
		t.Fatal("un error de BD debe propagarse")
	}
	if owned {
		t.Fatal("ante error, owned debe quedar en false")
	}
}

// TestHasRecentSaleByCashier_UsaColumnasQuoted verifica que la ventana
// temporal del cajero use las columnas reales `"employeeDni"` y
// `"saleDate"` (quoted camelCase, como en el resto del repo). Un error
// aquí deshabilitaría la ruta "cajero vendió hace <90s" y empujaría a
// pedir override admin innecesariamente.
func TestHasRecentSaleByCashier_UsaColumnasQuoted(t *testing.T) {
	f := &fakeSQL{respond: func(_ string, _ []interface{}) fakeResult {
		return fakeResult{Columns: []string{"count"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	ok, err := repo.HasRecentSaleByCashier(context.Background(), "EMP-001", 90e9)
	if err != nil {
		t.Fatalf("HasRecentSaleByCashier: %v", err)
	}
	if !ok {
		t.Fatalf("count=1 debe mapear a hasRecent=true; got false")
	}

	stmts := f.statements()
	if len(stmts) != 1 {
		t.Fatalf("se esperaba 1 COUNT; stmts=%d", len(stmts))
	}
	st := stmts[0]
	if !strings.Contains(st.SQL, `"employeeDni" = $1`) {
		t.Errorf(`debe filtrar por "employeeDni" = $1; SQL=%s`, st.SQL)
	}
	if !strings.Contains(st.SQL, `"saleDate" >= $2`) {
		t.Errorf(`debe filtrar por "saleDate" >= $2 (ventana temporal); SQL=%s`, st.SQL)
	}
	// Guard defensivo: nunca concatenar el DNI.
	if strings.Contains(st.SQL, "EMP-001") {
		t.Errorf("DNI debe viajar como bind, nunca embebido en SQL; SQL=%s", st.SQL)
	}
}

// TestHasRecentSaleByCashier_DniVacioNoConsulta confirma que no se
// emite SQL cuando el DNI es vacío/espacios. Es defensa en profundidad:
// el handler ya exige `userDni`, pero el repo no debe depender de ello.
func TestHasRecentSaleByCashier_DniVacioNoConsulta(t *testing.T) {
	f := &fakeSQL{respond: func(_ string, _ []interface{}) fakeResult {
		return fakeResult{Err: errors.New("no debería ejecutarse")}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	for _, dni := range []string{"", "   "} {
		ok, err := repo.HasRecentSaleByCashier(context.Background(), dni, 90e9)
		if err != nil {
			t.Fatalf("dni=%q no debe producir error; got %v", dni, err)
		}
		if ok {
			t.Fatalf("dni=%q debe mapear a hasRecent=false; got true", dni)
		}
	}
	if len(f.statements()) != 0 {
		t.Errorf("no se esperaba SQL con DNI vacío; stmts=%+v", f.statements())
	}
}

// toStr serializa cualquier valor a string de forma barata, sin
// importar strconv ni fmt. Lo usamos sólo para fallback de tipos en el
// test del bind numérico de saleID.
func toStr(v interface{}) string {
	switch x := v.(type) {
	case string:
		return x
	case int:
		return itoa(int64(x))
	case int32:
		return itoa(int64(x))
	case int64:
		return itoa(x)
	case uint:
		return itoa(int64(x))
	case uint32:
		return itoa(int64(x))
	case uint64:
		return itoa(int64(x))
	}
	return ""
}

func itoa(n int64) string {
	// Implementación minimalista para no importar strconv en este test.
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
