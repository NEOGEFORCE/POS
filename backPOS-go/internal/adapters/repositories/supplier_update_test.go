package repositories

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// TestSupplierUpdateSelectExcludeIsActive es un guardian estatico: escanea
// el codigo fuente de postgres_supplier_repository.go y verifica que el
// Select(...) de Update NO contenga "is_active".
//
// La razon: GORM con Select(...) escribe la columna aunque el struct traiga
// el zero-value. Si is_active queda en la lista, cualquier llamador que
// olvide setear IsActive DESACTIVARIA el proveedor por omision (GetAll
// filtra is_active = true, asi que desaparece de la lista). La activacion
// y desactivacion se hacen ahora por la ruta EXPLICITA SetActive.
func TestSupplierUpdateSelectExcludeIsActive(t *testing.T) {
	path := filepath.Join(".", "postgres_supplier_repository.go")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no se pudo leer %s: %v", path, err)
	}
	src := string(data)

	// Localizar el metodo Update y su bloque Select(...).
	// La expresion busca desde "func (r *PostgresSupplierRepository) Update("
	// hasta el ".Updates(supplier).Error" que cierra la sentencia.
	re := regexp.MustCompile(`func \(r \*PostgresSupplierRepository\) Update\([^)]*\)[^{]*\{[\s\S]*?\.Select\((?P<sel>[\s\S]*?)\)\.Updates`)
	m := re.FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("no se encontro el bloque Select(...) dentro de Update() en %s", path)
	}
	selectBlock := m[re.SubexpIndex("sel")]
	if strings.Contains(selectBlock, `"is_active"`) {
		t.Fatalf("Update.Select contiene 'is_active'; es una trampa: cualquier caller que olvide setear IsActive lo desactiva. Select actual:\n%s",
			selectBlock)
	}

	// Sanidad: al menos debe contener los campos obviamente necesarios para
	// el CRUD del dueno.
	for _, must := range []string{`"name"`, `"visit_days"`, `"delivery_days"`, `"updatedByDni"`} {
		if !strings.Contains(selectBlock, must) {
			t.Fatalf("Update.Select no contiene %s; el CRUD manual queda incompleto. Select actual:\n%s",
				must, selectBlock)
		}
	}

	// Adicionalmente: NUNCA debe incluir columnas learned_*. El aprendizaje
	// automatico vive solo en las columnas learned_* y solo puede escribirse
	// desde el batch nocturno (SaveSupplierLearnedSchedules).
	for _, forbidden := range []string{
		`learned_visit_days`, `learned_delivery_days`,
		`learned_lead_time_days`, `learned_sample_count`, `learned_at`,
	} {
		if strings.Contains(selectBlock, forbidden) {
			t.Fatalf("Update.Select contiene %s; el CRUD manual no puede tocar aprendizaje automatico. Select actual:\n%s",
				forbidden, selectBlock)
		}
	}
}

// TestStringArrayValueSlicesVaciosVsNil garantiza el comportamiento pedido
// para el caso "el dueno borra todos los dias de un proveedor a proposito":
//
//   - StringArray nil        -> DB NULL (columna sin dato).
//   - StringArray{}   (vacio) -> DB "[]"::jsonb (arreglo vacio explicito).
//
// La distincion importa: el flujo del CRUD llega con un slice vacio cuando
// el dueno destildo todos los botones de dias, y ese caso debe grabarse
// como "no hay dias" — NO debe quedarse con lo anterior. Sin esta garantia
// StringArray.Value() podria devolver NULL para el slice vacio, dejando
// abierta la posibilidad de que el driver interprete la falta de valor
// como "no cambiar la columna".
func TestStringArrayValueSlicesVaciosVsNil(t *testing.T) {
	// Nil -> NULL.
	var nilSA models.StringArray
	v, err := nilSA.Value()
	if err != nil {
		t.Fatalf("nil.Value() err = %v", err)
	}
	if v != nil {
		t.Fatalf("nil.Value() = %v, want nil (NULL)", v)
	}

	// Empty non-nil -> "[]" jsonb.
	empty := models.StringArray{}
	v, err = empty.Value()
	if err != nil {
		t.Fatalf("empty.Value() err = %v", err)
	}
	if v == nil {
		t.Fatalf("empty.Value() = nil; want []byte(\"[]\") — nil colapsaria con el caso nil y el driver podria no actualizar la columna")
	}
	raw, ok := v.([]byte)
	if !ok {
		t.Fatalf("empty.Value() tipo = %T, want []byte", v)
	}
	if string(raw) != "[]" {
		t.Fatalf("empty.Value() = %q, want \"[]\"", string(raw))
	}
	// Sanidad: se re-parsea correctamente a un slice vacio.
	var parsed []string
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("no se pudo re-parsear: %v", err)
	}
	if len(parsed) != 0 || parsed == nil {
		// Nota: json.Unmarshal("[]") deja un slice no-nil vacio, no nil.
		// Verificamos ambos: longitud 0 y no-nil.
		t.Fatalf("re-parsed = %v (len=%d, nil=%v); want [] no-nil",
			parsed, len(parsed), parsed == nil)
	}

	// Con contenido -> serializacion normal.
	con := models.StringArray{"Lunes", "Miércoles"}
	v, err = con.Value()
	if err != nil {
		t.Fatalf("con.Value() err = %v", err)
	}
	raw, ok = v.([]byte)
	if !ok {
		t.Fatalf("con.Value() tipo = %T, want []byte", v)
	}
	if !strings.Contains(string(raw), "Lunes") || !strings.Contains(string(raw), "Miércoles") {
		t.Fatalf("con.Value() = %q; want array JSON con los dias", string(raw))
	}
}

func TestUpdateManualScheduleSoloTocaColumnasAutorizadas(t *testing.T) {
	path := filepath.Join(".", "postgres_supplier_repository.go")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no se pudo leer %s: %v", path, err)
	}

	re := regexp.MustCompile(`func \(r \*PostgresSupplierRepository\) UpdateManualSchedule\([\s\S]*?return &updated, nil\n}`)
	method := re.FindString(string(data))
	if method == "" {
		t.Fatal("no se encontró UpdateManualSchedule")
	}
	for _, required := range []string{
		`fields["visit_days"]`, `fields["visitDay"]`,
		`fields["delivery_days"]`, `fields["deliveryDay"]`,
		`fields["lead_time_days"]`, `.Transaction(`, `tx.First(&updated, id)`,
	} {
		if !strings.Contains(method, required) {
			t.Errorf("UpdateManualSchedule no contiene %q", required)
		}
	}
	for _, forbidden := range []string{
		`learned_visit_days`, `learned_delivery_days`, `learned_lead_time_days`,
		`learned_sample_count`, `learned_at`, `is_active`, `name`, `phone`, `vendorName`,
	} {
		if strings.Contains(method, `fields["`+forbidden+`"]`) {
			t.Errorf("UpdateManualSchedule intenta escribir campo prohibido %q", forbidden)
		}
	}
}
