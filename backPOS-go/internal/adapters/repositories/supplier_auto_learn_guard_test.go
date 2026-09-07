package repositories

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestNoAutoWriteToVisitDaysOrDeliveryDays es un test de regresión
// estático que amarra la regla del dueño: NADA en el backend puede
// escribir automáticamente a suppliers.visit_days ni a
// suppliers.delivery_days. Toda la agenda manual queda intocada por
// flujos automáticos; el aprendizaje real vive en columnas learned_*.
//
// Estrategia: escanear todos los .go de producción (excluyendo
// *_test.go) bajo internal/ en busca de dos patrones peligrosos:
//
//	.Update("visit_days"    ...   -> UPDATE de GORM apuntando a la columna
//	.Update("delivery_days" ...
//	UPDATE suppliers ... SET ... visit_days|delivery_days
//
// Excepciones explícitas (positivas): archivos donde la referencia
// existe pero NO como escritura automática, o donde la referencia es
// solo un identificador dentro de un Select() del CRUD manual del
// dueño (postgres_supplier_repository.Update). Se documentan más
// abajo con contexto.
//
// Si alguien agrega en el futuro un UPDATE automático a estas
// columnas, este test falla y protege la regla.
func TestNoAutoWriteToVisitDaysOrDeliveryDays(t *testing.T) {
	// Localiza la raíz del árbol internal/ subiendo dos niveles desde
	// el directorio de este paquete (internal/adapters/repositories).
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("no se pudo resolver la ruta base de internal/: %v", err)
	}

	// Patrones prohibidos: cualquier forma de escritura automática a
	// las columnas sagradas. El CRUD manual del dueño se hace vía
	// gorm .Select(...).Updates(supplier), que NO matchea ninguno de
	// estos patrones porque referencia los nombres en un Select, no
	// como target de Update() individual.
	updateColumnCall := regexp.MustCompile(`\.Update\(\s*"(?:visit_days|delivery_days)"\s*,`)
	updatesMultiCall := regexp.MustCompile(`\.Updates\(\s*map\[string\]interface\{\}\{[^}]*"(?:visit_days|delivery_days)"`)
	manualMapAssignment := regexp.MustCompile(`fields\["(?:visit_days|delivery_days)"\]\s*=`)
	manualMethod := regexp.MustCompile(`(?s)func \(r \*PostgresSupplierRepository\) UpdateManualSchedule\(.*?return &updated, nil\n}`)
	rawUpdateSQL := regexp.MustCompile(`(?is)UPDATE\s+suppliers[^;]*SET[^;]*(?:visit_days|delivery_days)`)

	// No hay allowlist a propósito: cualquier archivo de producción
	// que introduzca uno de los patrones prohibidos hace fallar el
	// test. Si alguna vez hace falta un caso legítimo (ej: un
	// endpoint administrativo explícito de superadmin que reciba una
	// nueva lista de visit_days del dueño), ese endpoint debe pasar
	// por el .Select("visit_days","delivery_days").Updates(supplier)
	// del CRUD principal — que no matchea ninguno de estos patrones.

	var violations []string

	walkErr := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		name := info.Name()
		if !strings.HasSuffix(name, ".go") {
			return nil
		}
		if strings.HasSuffix(name, "_test.go") {
			return nil
		}

		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			rel = path
		}
		rel = filepath.ToSlash(rel)
		full := "internal/" + rel

		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		body := string(data)
		bodyWithoutManualAction := body
		if full == "internal/adapters/repositories/postgres_supplier_repository.go" &&
			strings.Contains(body, `const manualScheduleWriteMarker = "MANUAL_SUPPLIER_SCHEDULE_WRITE"`) {
			if !manualMethod.MatchString(body) {
				violations = append(violations, full+": marcador manual presente pero UpdateManualSchedule no tiene la forma esperada")
			} else {
				bodyWithoutManualAction = manualMethod.ReplaceAllString(body, "")
			}
		}

		if updateColumnCall.MatchString(bodyWithoutManualAction) {
			violations = append(violations, full+": .Update(\"visit_days\"|\"delivery_days\", ...) detectado")
		}
		if updatesMultiCall.MatchString(bodyWithoutManualAction) {
			violations = append(violations, full+": .Updates(map con visit_days|delivery_days) detectado")
		}
		if manualMapAssignment.MatchString(bodyWithoutManualAction) {
			violations = append(violations, full+": asignación a visit_days|delivery_days fuera de UpdateManualSchedule explícito")
		}
		if rawUpdateSQL.MatchString(bodyWithoutManualAction) {
			violations = append(violations, full+": UPDATE suppliers ... SET visit_days|delivery_days detectado en SQL crudo")
		}
		return nil
	})

	if walkErr != nil {
		t.Fatalf("error al escanear internal/: %v", walkErr)
	}

	if len(violations) > 0 {
		t.Fatalf("Se detectaron escrituras automáticas prohibidas a suppliers.visit_days / suppliers.delivery_days.\n"+
			"La agenda manual del dueño es SAGRADA. El aprendizaje real vive en columnas learned_*.\n"+
			"Violaciones:\n  - %s", strings.Join(violations, "\n  - "))
	}
}

// TestLearnDayIsNoOp valida que la firma pública LearnDay se conserva
// pero devuelve nil sin efectos. Es una salvaguarda contra revertir
// el no-op por accidente.
func TestLearnDayIsNoOp(t *testing.T) {
	// No podemos inyectar un DB real aquí (es lógica pura ahora); la
	// prueba se limita a invocar el método con nil interno y verificar
	// que no panic-ea ni retorna error. Como el cuerpo actual no toca
	// r.db, esto es seguro.
	r := &PostgresSupplierRepository{db: nil}
	if err := r.LearnDay(123, "visit_days"); err != nil {
		t.Fatalf("LearnDay debe ser un no-op y retornar nil, got: %v", err)
	}
	if err := r.LearnDay(0, "delivery_days"); err != nil {
		t.Fatalf("LearnDay debe ser un no-op y retornar nil, got: %v", err)
	}
	if err := r.LearnDay(1, "cualquier_otra_cosa"); err != nil {
		t.Fatalf("LearnDay debe ignorar el targetColumn, got: %v", err)
	}
}

// TestUpdateSupplierDeliveryDaysIsNoOp valida que la firma del
// repositorio expected_order queda como no-op. Blinda contra
// revertir el fix.
func TestUpdateSupplierDeliveryDaysIsNoOp(t *testing.T) {
	r := &PostgresExpectedOrderRepository{db: nil}
	if err := r.UpdateSupplierDeliveryDays(1, nil); err != nil {
		t.Fatalf("UpdateSupplierDeliveryDays debe ser un no-op, got: %v", err)
	}
}
