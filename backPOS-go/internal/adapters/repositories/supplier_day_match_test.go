package repositories

import (
	"strings"
	"testing"

	"backPOS-go/internal/core/services/scheduling"
)

// TestBuildDayMatchWhere_UsaUnaccentEnAmbosLados es el test guardian del bug
// verificado: el formulario del frontend guarda los dias SIN tilde
// ("Miercoles", "Sabado") y el cron antes buscaba CON tilde ("Miércoles",
// "Sábado") con comparacion exacta. Resultado: esos dos dias nunca disparaban
// la alerta.
//
// El fix es que la LECTURA tolere las dos formas (no se pueden reescribir los
// datos guardados, regla del dueno). Se verifica aca que el WHERE generado
// aplica unaccent+lower a AMBOS lados y desarma el arreglo jsonb con
// jsonb_array_elements_text en vez de usar el operador @> (que compara
// byte-a-byte).
func TestBuildDayMatchWhere_UsaUnaccentEnAmbosLados(t *testing.T) {
	sql, args := BuildDayMatchWhere("visit_days", `"visitDay"`, "Miércoles")

	// El WHERE debe aplicar unaccent Y lower a los dos lados (columna y
	// parametro). Sin unaccent, "Miercoles" nunca hace match con
	// "Miércoles" — que es el bug.
	if !strings.Contains(sql, "unaccent(") {
		t.Fatalf("SQL no invoca unaccent(); WHERE=%s", sql)
	}
	if !strings.Contains(sql, "lower(") {
		t.Fatalf("SQL no invoca lower(); WHERE=%s", sql)
	}

	// Debe desarmar el arreglo jsonb en vez de usar @>::jsonb (que compara
	// byte-a-byte). El operador @> era la otra mitad del bug.
	if !strings.Contains(sql, "jsonb_array_elements_text(") {
		t.Fatalf("SQL sigue comparando el jsonb como bloque; WHERE=%s", sql)
	}
	if strings.Contains(sql, "@>") {
		t.Fatalf("SQL usa @> (comparacion exacta byte-a-byte); WHERE=%s", sql)
	}

	// Debe cubrir el campo legacy (columna "visitDay") con split por coma,
	// para tolerar CSV historico como "Lunes, Miercoles".
	if !strings.Contains(sql, `"visitDay"`) {
		t.Fatalf("SQL no cubre el campo legacy; WHERE=%s", sql)
	}
	if !strings.Contains(sql, "regexp_split_to_table") {
		t.Fatalf("SQL no divide el CSV del campo legacy; WHERE=%s", sql)
	}

	// El parametro se debe repetir tantas veces como placeholders (?) tiene
	// el SQL. Contar '?' y comparar con len(args).
	placeholders := strings.Count(sql, "?")
	if placeholders != len(args) {
		t.Fatalf("mismatch placeholders/args: %d vs %d; sql=%s args=%v",
			placeholders, len(args), sql, args)
	}
	for _, a := range args {
		if a != "Miércoles" {
			t.Fatalf("argument = %v, want 'Miércoles' (crudo, sin normalizar)", a)
		}
	}
}

// TestBuildDayMatchWhere_SoloJSONB verifica el caso de que se le pase solo la
// columna jsonb (util para consultas que ya migraron por completo).
func TestBuildDayMatchWhere_SoloJSONB(t *testing.T) {
	sql, args := BuildDayMatchWhere("delivery_days", "", "Sabado")
	if strings.Contains(sql, `"visitDay"`) || strings.Contains(sql, `"deliveryDay"`) {
		t.Fatalf("no debe haber referencia a columna legacy; sql=%s", sql)
	}
	if !strings.Contains(sql, "jsonb_array_elements_text(") {
		t.Fatalf("falta jsonb_array_elements_text; sql=%s", sql)
	}
	if len(args) != 1 || args[0] != "Sabado" {
		t.Fatalf("args = %v, want [Sabado]", args)
	}
}

// TestBuildDayMatchWhere_NormalizacionEsSimetrica valida a nivel Go que la
// funcion de normalizacion (usada en el resto del sistema para colapsar
// tildes/mayusculas antes de comparar) resuelve la version SIN tilde y la
// version CON tilde al mismo canonico. Como la SQL usa unaccent(lower(...))
// que tiene la misma semantica, este test es un proxy determinista del
// comportamiento de la base sin necesitar un cluster real.
func TestBuildDayMatchWhere_NormalizacionEsSimetrica(t *testing.T) {
	pairs := [][2]string{
		{"Miercoles", "Miércoles"},
		{"MIERCOLES", "miércoles"},
		{"Sabado", "Sábado"},
		{" sabado ", "SÁBADO"},
	}
	for _, pair := range pairs {
		a := scheduling.NormalizeWeekdayName(pair[0])
		b := scheduling.NormalizeWeekdayName(pair[1])
		if a != b {
			t.Fatalf("normalizacion no coincide entre %q y %q (%q vs %q)",
				pair[0], pair[1], a, b)
		}
		// Adicionalmente, ambos deben resolver al mismo weekday canonico.
		wdA, okA := scheduling.ParseWeekdayName(pair[0])
		wdB, okB := scheduling.ParseWeekdayName(pair[1])
		if !okA || !okB || wdA != wdB {
			t.Fatalf("ParseWeekdayName no resuelve simetrico: %q=%v(ok=%v) vs %q=%v(ok=%v)",
				pair[0], wdA, okA, pair[1], wdB, okB)
		}
	}
}
