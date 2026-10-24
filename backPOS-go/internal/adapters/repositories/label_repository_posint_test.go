package repositories

import (
	"context"
	"database/sql/driver"
	"errors"
	"regexp"
	"strings"
	"testing"
)

// =============================================================================
// Pruebas de la rama POSINT- de EnsureCodeForProduct (migración 024 +
// flujo audit-first de LabelPrintSheet para productos internos).
//
// Invariantes que fijan:
//
//   - Para productBarcode en el namespace POSINT-, el `label_codes.code`
//     persistido es LITERALMENTE el mismo POSINT-<hex> normalizado. No
//     se genera LC-<hex>.
//   - La idempotencia por producto se mantiene: segunda llamada reusa la
//     fila existente con created=false.
//   - La rama POSINT valida que el producto exista en `products.barcode`
//     ANTES del INSERT: la etiqueta sólo tiene sentido si el consumo de
//     la reserva ya ocurrió.
//   - La rama POSINT NO llama a `generateUniqueCodeTx`: no se tocan las
//     cuatro fuentes de colisión del generador comercial.
//   - Un unique violation (23505) sobre el INSERT se traduce en error
//     legible: "un POSINT no puede mapearse a otro product_barcode".
//   - Formatos POSINT inválidos se rechazan antes de abrir la tx.
//   - Minúsculas en el barcode (ej. "posint-abcdef12") se normalizan a
//     mayúsculas antes de persistir, para empatar la normalización
//     canónica de `product_handler.Create` sobre products.barcode.
//   - Los productos comerciales siguen usando LC-<hex> (la rama comercial
//     no se tocó).
//   - ResolveLabelCode mapea una fila POSINT- al producto sin cambios de
//     SQL: `code = product_barcode` → el JOIN con `products.barcode`
//     resuelve.
//   - RecordPrintJob puede referenciar un code=POSINT-<hex> como
//     cualquier otro: el INSERT en label_print_jobs y el UPDATE de
//     print_count/last_printed_at usan `code` por igual.
// =============================================================================

// --- Rama POSINT: persistir code literal ------------------------------------

// TestLabelRepo_EnsureCode_POSINT_PersistCodeIgualAlBarcode: primera llamada
// con un barcode POSINT- válido crea una fila cuyo `code` ES el barcode
// normalizado, nunca un LC-<hex>, y `created` es true.
func TestLabelRepo_EnsureCode_POSINT_PersistCodeIgualAlBarcode(t *testing.T) {
	const posint = "POSINT-ABCDEF123456"

	f := &fakeSQL{respond: func(q string, args []interface{}) fakeResult {
		switch {
		case strings.Contains(q, "pg_advisory_xact_lock"):
			return one("exists", true)
		case strings.Contains(q, `FROM "label_codes"`) && strings.Contains(q, "product_barcode"):
			// Lookup idempotente: sin fila activa.
			return fakeResult{Columns: []string{"code", "product_barcode"}}
		case strings.Contains(q, `FROM "products"`) && strings.Contains(q, "barcode"):
			// Validación "producto existe": 1 fila.
			return one("count", int64(1))
		}
		// INSERT INTO "label_codes" ... RETURNING vacío (GORM lo tolera).
		return fakeResult{Columns: []string{"code"}}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	code, created, err := repo.EnsureCodeForProduct(context.Background(), posint, nil, "nota interna", "ADMIN-1")
	if err != nil {
		t.Fatalf("EnsureCodeForProduct POSINT: %v", err)
	}
	if !created {
		t.Fatalf("primera llamada POSINT debe reportar created=true; got false")
	}
	if code == nil || code.Code != posint {
		t.Fatalf("code persistido debe ser literalmente %q (no LC-...); got %+v", posint, code)
	}
	if code.ProductBarcode == nil || *code.ProductBarcode != posint {
		t.Fatalf("product_barcode debe ser %q para cumplir ck_label_codes_posint_matches_product_barcode; got %+v",
			posint, code.ProductBarcode)
	}
	if strings.HasPrefix(code.Code, "LC-") {
		t.Fatalf("rama POSINT NO debe emitir LC-<hex>; got code=%q", code.Code)
	}

	// Comprobar la secuencia emitida:
	//   lock → lookup label_codes → count products → insert label_codes
	// SIN consultas de colisión del generador comercial (alternate_codes,
	// label_codes.code match contra candidato, package_barcode_aliases).
	stmts := f.statements()
	var order []string
	for _, st := range stmts {
		switch {
		case strings.Contains(st.SQL, "pg_advisory_xact_lock"):
			order = append(order, "lock")
		case strings.Contains(st.SQL, `FROM "label_codes"`) && strings.Contains(st.SQL, "product_barcode"):
			order = append(order, "lookup")
		case strings.Contains(st.SQL, `FROM "products"`) && strings.Contains(st.SQL, "barcode"):
			order = append(order, "product_exists")
		case strings.Contains(strings.ToUpper(st.SQL), `INSERT INTO "LABEL_CODES"`):
			order = append(order, "insert")
		}
		// Ninguna consulta del generador comercial debe aparecer.
		if strings.Contains(st.SQL, "alternate_codes") {
			t.Errorf("rama POSINT no debe consultar alternate_codes: %s", st.SQL)
		}
		if strings.Contains(st.SQL, "package_barcode_aliases") {
			t.Errorf("rama POSINT no debe consultar package_barcode_aliases: %s", st.SQL)
		}
	}
	got := strings.Join(order, ",")
	if got != "lock,lookup,product_exists,insert" {
		t.Fatalf("orden esperado lock → lookup → product_exists → insert; got %q (%+v)", got, stmts)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("debe correr en una sola tx confirmada; eventos=%v", f.txEvents)
	}

	// El INSERT debe llevar el code y el product_barcode con el mismo
	// valor POSINT-<HEX>.
	for _, st := range stmts {
		if !strings.Contains(strings.ToUpper(st.SQL), `INSERT INTO "LABEL_CODES"`) {
			continue
		}
		// GORM emite todos los campos como parámetros bind; comprobamos
		// que el valor POSINT-<HEX> aparezca al menos dos veces en el
		// vector de parámetros, bien como string literal (campo `code`)
		// o como *string (campo `product_barcode`, por ser *string en
		// el modelo). Un pointer a nuestro valor cuenta igual.
		hits := 0
		for _, v := range st.Vars {
			if s, ok := v.(string); ok && s == posint {
				hits++
				continue
			}
			if sp, ok := v.(*string); ok && sp != nil && *sp == posint {
				hits++
			}
		}
		if hits < 2 {
			t.Errorf("el INSERT debe llevar POSINT-<HEX>=%q en code Y product_barcode (bind, no concatenación); vars=%v",
				posint, st.Vars)
		}
	}
}

// TestLabelRepo_EnsureCode_POSINT_SegundaLlamadaReusaExistente: cuando ya
// hay una fila activa (voided_at NULL) con product_barcode=POSINT-X, la
// segunda llamada devuelve esa fila con created=false y no emite INSERT.
func TestLabelRepo_EnsureCode_POSINT_SegundaLlamadaReusaExistente(t *testing.T) {
	const posint = "POSINT-ABCDEF123456"

	f := &fakeSQL{respond: func(q string, args []interface{}) fakeResult {
		switch {
		case strings.Contains(q, "pg_advisory_xact_lock"):
			return one("exists", true)
		case strings.Contains(q, `FROM "label_codes"`) && strings.Contains(q, "product_barcode"):
			return fakeResult{
				Columns: []string{"code", "product_barcode"},
				Rows:    [][]driver.Value{{posint, posint}},
			}
		}
		return fakeResult{Columns: []string{"code"}}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	code, created, err := repo.EnsureCodeForProduct(context.Background(), posint, nil, "", "ADMIN-1")
	if err != nil {
		t.Fatalf("EnsureCodeForProduct POSINT (2ª llamada): %v", err)
	}
	if created {
		t.Fatalf("segunda llamada POSINT debe ser idempotente (created=false); got true")
	}
	if code == nil || code.Code != posint {
		t.Fatalf("segunda llamada debe devolver el code existente %q; got %+v", posint, code)
	}
	for _, st := range f.statements() {
		if strings.HasPrefix(strings.TrimSpace(strings.ToUpper(st.SQL)), "INSERT") {
			t.Errorf("NO debe insertar cuando ya existe un code POSINT activo: %s", st.SQL)
		}
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("debe cerrar la tx aun en el camino idempotente; eventos=%v", f.txEvents)
	}
}

// TestLabelRepo_EnsureCode_POSINT_FormatoInvalidoRechazadoAntesDeLaTx: un
// barcode POSINT- con cuerpo fuera del shape ([0-9A-F]{8,24}) se rechaza
// sin abrir transacción y sin consultar la BD.
func TestLabelRepo_EnsureCode_POSINT_FormatoInvalidoRechazadoAntesDeLaTx(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		return fakeResult{Err: errors.New("respond no debería ejecutarse: el shape se valida antes de abrir la tx")}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	cases := []string{
		"POSINT-",                           // sin cuerpo
		"POSINT-ZZZZ",                       // caracter no hex
		"POSINT-1234",                       // cuerpo menor al mínimo (8)
		"POSINT-" + strings.Repeat("A", 25), // cuerpo mayor al máximo (24)
	}
	for _, in := range cases {
		_, _, err := repo.EnsureCodeForProduct(context.Background(), in, nil, "", "ADMIN-1")
		if err == nil {
			t.Errorf("POSINT inválido %q debe fallar early sin tocar la BD", in)
		}
	}
	if len(f.statements()) != 0 {
		t.Errorf("no debe emitirse ninguna sentencia para POSINT inválido; stmts=%+v", f.statements())
	}
	if len(f.txEvents) != 0 {
		t.Errorf("no debe abrirse transacción para POSINT inválido; eventos=%v", f.txEvents)
	}
}

// TestLabelRepo_EnsureCode_POSINT_NormalizaMinusculas: un POSINT escrito
// en minúsculas (o con espacios) debe normalizarse a mayúsculas +
// TrimSpace antes de persistirse. Es la misma normalización canónica que
// `product_handler.Create` aplica a `products.barcode`.
func TestLabelRepo_EnsureCode_POSINT_NormalizaMinusculas(t *testing.T) {
	const raw = "  posint-abcdef123456  "
	const canonical = "POSINT-ABCDEF123456"

	f := &fakeSQL{respond: func(q string, args []interface{}) fakeResult {
		switch {
		case strings.Contains(q, "pg_advisory_xact_lock"):
			return one("exists", true)
		case strings.Contains(q, `FROM "label_codes"`) && strings.Contains(q, "product_barcode"):
			return fakeResult{Columns: []string{"code"}}
		case strings.Contains(q, `FROM "products"`) && strings.Contains(q, "barcode"):
			return one("count", int64(1))
		}
		return fakeResult{Columns: []string{"code"}}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	code, created, err := repo.EnsureCodeForProduct(context.Background(), raw, nil, "", "ADMIN-1")
	if err != nil {
		t.Fatalf("EnsureCodeForProduct POSINT (lowercase): %v", err)
	}
	if !created || code == nil || code.Code != canonical {
		t.Fatalf("entrada %q debe persistir como %q; got code=%+v created=%v", raw, canonical, code, created)
	}

	// La clave del advisory lock debe usar el valor canonical.
	stmts := f.statements()
	if len(stmts) == 0 || !strings.Contains(stmts[0].SQL, "pg_advisory_xact_lock") {
		t.Fatalf("la primera sentencia debe ser el advisory lock; stmts=%+v", stmts)
	}
	if stmts[0].Vars[0] != "label_codes:product_barcode:"+canonical {
		t.Errorf("la clave del lock debe usar el barcode canonical %q; vars=%v", canonical, stmts[0].Vars)
	}
}

// TestLabelRepo_EnsureCode_POSINT_RequiereProductoExistente: si no hay un
// producto en `products.barcode = POSINT-X`, la reserva no fue consumida
// o el producto se purgó. La etiqueta no tiene sentido y se rechaza sin
// INSERT.
func TestLabelRepo_EnsureCode_POSINT_RequiereProductoExistente(t *testing.T) {
	const posint = "POSINT-DEADBEEF1234"

	f := &fakeSQL{respond: func(q string, args []interface{}) fakeResult {
		switch {
		case strings.Contains(q, "pg_advisory_xact_lock"):
			return one("exists", true)
		case strings.Contains(q, `FROM "label_codes"`) && strings.Contains(q, "product_barcode"):
			return fakeResult{Columns: []string{"code"}}
		case strings.Contains(q, `FROM "products"`) && strings.Contains(q, "barcode"):
			return one("count", int64(0)) // producto ausente
		}
		return fakeResult{Err: errors.New("INSERT no debería dispararse si el producto no existe")}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	_, _, err := repo.EnsureCodeForProduct(context.Background(), posint, nil, "", "ADMIN-1")
	if err == nil {
		t.Fatalf("POSINT sin producto en BD debe fallar; got err=nil")
	}
	if !strings.Contains(err.Error(), "no existe producto") {
		t.Errorf("el error debe mencionar la falta del producto; got %q", err.Error())
	}
	for _, st := range f.statements() {
		if strings.HasPrefix(strings.TrimSpace(strings.ToUpper(st.SQL)), "INSERT") {
			t.Errorf("NO debe insertar cuando falta el producto POSINT: %s", st.SQL)
		}
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("la tx debe revertirse si el producto no existe; eventos=%v", f.txEvents)
	}
}

// TestLabelRepo_EnsureCode_POSINT_UniqueViolationDaErrorLegible: cuando
// existe otra fila con code=POSINT-X que no pasó el lookup idempotente
// (voided o incoherente), el INSERT choca por PK (23505). El repo debe
// traducir ese choque en un error claro de "colisión POSINT" sin
// resucitar la fila ni silenciar el conflicto.
func TestLabelRepo_EnsureCode_POSINT_UniqueViolationDaErrorLegible(t *testing.T) {
	const posint = "POSINT-ABCDEF123456"

	f := &fakeSQL{respond: func(q string, args []interface{}) fakeResult {
		switch {
		case strings.Contains(q, "pg_advisory_xact_lock"):
			return one("exists", true)
		case strings.Contains(q, `FROM "label_codes"`) && strings.Contains(q, "product_barcode"):
			// Lookup idempotente filtra por voided_at IS NULL — vacío.
			return fakeResult{Columns: []string{"code"}}
		case strings.Contains(q, `FROM "products"`) && strings.Contains(q, "barcode"):
			return one("count", int64(1))
		case strings.Contains(strings.ToUpper(q), `INSERT INTO "LABEL_CODES"`):
			return fakeResult{Err: errors.New(`pq: duplicate key value violates unique constraint "label_codes_pkey" (SQLSTATE 23505)`)}
		}
		return fakeResult{Columns: []string{"code"}}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	_, _, err := repo.EnsureCodeForProduct(context.Background(), posint, nil, "", "ADMIN-1")
	if err == nil {
		t.Fatal("un unique violation sobre POSINT debe propagarse como error legible")
	}
	msg := err.Error()
	if !strings.Contains(msg, posint) {
		t.Errorf("el error debe mencionar el code POSINT en conflicto; got %q", msg)
	}
	if !strings.Contains(strings.ToLower(msg), "posint") {
		t.Errorf("el error debe nombrar al namespace POSINT; got %q", msg)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("la tx debe revertirse ante PK violation; eventos=%v", f.txEvents)
	}
}

// TestLabelRepo_EnsureCode_POSINT_CoherenciaExistingDetectada: aun con
// una fila "activa" (voided_at IS NULL) en el lookup, si por alguna ruta
// la coherencia intra-fila está rota (code != product_barcode), el repo
// aborta en Go con error claro en vez de devolver un code POSINT que no
// se puede resolver al escanear.
func TestLabelRepo_EnsureCode_POSINT_CoherenciaExistingDetectada(t *testing.T) {
	const posint = "POSINT-ABCDEF123456"

	f := &fakeSQL{respond: func(q string, args []interface{}) fakeResult {
		switch {
		case strings.Contains(q, "pg_advisory_xact_lock"):
			return one("exists", true)
		case strings.Contains(q, `FROM "label_codes"`) && strings.Contains(q, "product_barcode"):
			// Fila incoherente: code=LC-xxxx pero product_barcode=POSINT-X.
			// Nunca debería existir por el CHECK, pero verificamos la
			// defensa en profundidad en Go.
			return fakeResult{
				Columns: []string{"code", "product_barcode"},
				Rows:    [][]driver.Value{{"LC-aaaaaa", posint}},
			}
		}
		return fakeResult{Err: errors.New("no debería tocar nada más")}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	_, _, err := repo.EnsureCodeForProduct(context.Background(), posint, nil, "", "ADMIN-1")
	if err == nil {
		t.Fatal("una fila existente POSINT con code != product_barcode debe reportarse como colisión")
	}
	if !strings.Contains(err.Error(), "colisión POSINT") && !strings.Contains(err.Error(), "colision POSINT") {
		t.Errorf("el error debe mencionar la colisión POSINT; got %q", err.Error())
	}
}

// TestLabelRepo_EnsureCode_Comercial_SigueGenerandoLC: para un barcode
// NO POSINT la rama comercial sigue generando LC-<hex> y consultando las
// cuatro fuentes de colisión. Garantiza que la introducción de la rama
// POSINT no cambió el comportamiento previo para productos reales.
func TestLabelRepo_EnsureCode_Comercial_SigueGenerandoLC(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(q, "count(") || strings.Contains(q, "COUNT(") {
			return one("count", int64(0))
		}
		return fakeResult{Columns: []string{"code"}}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	code, created, err := repo.EnsureCodeForProduct(context.Background(), "7701234567890", nil, "", "ADMIN-1")
	if err != nil {
		t.Fatalf("EnsureCodeForProduct comercial: %v", err)
	}
	if !created {
		t.Fatal("primera llamada comercial debe ser created=true")
	}
	if !strings.HasPrefix(code.Code, "LC-") {
		t.Fatalf("código comercial debe comenzar con LC-; got %q", code.Code)
	}
	if strings.HasPrefix(code.Code, "POSINT-") {
		t.Fatalf("código comercial NUNCA debe caer en POSINT-; got %q", code.Code)
	}
	// Verificamos que la rama comercial sí consultó alternate_codes y
	// package_barcode_aliases (las dos fuentes extra del generador LC-).
	var sawAlt, sawPackage bool
	for _, st := range f.statements() {
		if strings.Contains(st.SQL, "alternate_codes") {
			sawAlt = true
		}
		if strings.Contains(st.SQL, "package_barcode_aliases") {
			sawPackage = true
		}
	}
	if !sawAlt {
		t.Error("rama comercial debe consultar alternate_codes en el generador LC-")
	}
	if !sawPackage {
		t.Error("rama comercial debe consultar package_barcode_aliases en el generador LC-")
	}
}

// --- Rama POSINT: ResolveLabelCode mapea la etiqueta impresa -----------------

// TestLabelRepo_ResolveLabelCode_PosintMapea: una fila con
// code=product_barcode=POSINT-X resuelve a `match=label_code` con el
// producto POSINT-X detrás. Es el flujo "escaneo normal del catálogo
// también lo resuelve" para productos internos.
func TestLabelRepo_ResolveLabelCode_PosintMapea(t *testing.T) {
	const posint = "POSINT-ABCDEF123456"
	payload := `{"code":"` + posint + `","product_barcode":"` + posint + `",` +
		`"product_name":"GRANEL ARROZ 500G","sale_price":2500,"purchase_price":2000,` +
		`"quantity":10,"is_weighted":false,"is_pack":false}`

	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(q, "to_regclass") {
			return one("exists", true)
		}
		return one("payload", payload)
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	res, err := repo.ResolveLabelCode(context.Background(), posint)
	if err != nil {
		t.Fatalf("ResolveLabelCode(POSINT): %v", err)
	}
	if res == nil || res.Match != "label_code" {
		t.Fatalf("POSINT debe resolver match=label_code; got %+v", res)
	}
	if res.ProductBarcode != posint || res.Code != posint {
		t.Fatalf("POSINT: code y product_barcode deben coincidir con %q; got %+v", posint, res)
	}
	if res.Product == nil || res.Product.ProductName != "GRANEL ARROZ 500G" {
		t.Fatalf("ResolveLabelCode(POSINT) debe incluir el ProductBrief; got %+v", res.Product)
	}

	// Reglas del SQL de resolución: match exacto por PK y
	// parametrización. Sin cambios por POSINT.
	stmts := f.statements()
	if len(stmts) != 2 {
		t.Fatalf("se esperaban existencia + lookup; stmts=%d", len(stmts))
	}
	lookup := stmts[1]
	if !containsAll(lookup.SQL, "lc.code = $1", "voided_at IS NULL", "product_barcode IS NOT NULL") {
		t.Errorf("el lookup debe ser exacto y excluir anulados/libres: %s", lookup.SQL)
	}
	if len(lookup.Vars) != 1 || lookup.Vars[0] != posint {
		t.Errorf("el POSINT debe pasar como único parámetro bind sin modificar; vars=%v", lookup.Vars)
	}
}

// --- Rama POSINT: RecordPrintJob referencia el code sin discriminar ---------

// TestLabelRepo_RecordPrintJob_PuedeReferenciarPOSINT: el ciclo
// audit-first exige poder emitir un print job que apunte a un code=
// POSINT-X. El INSERT en label_print_jobs y el UPDATE de
// print_count/last_printed_at del code deben emitirse normalmente, sin
// discriminar por prefijo.
func TestLabelRepo_RecordPrintJob_PuedeReferenciarPOSINT(t *testing.T) {
	const posint = "POSINT-ABCDEF123456"

	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		// Permitir INSERT y UPDATE sin error. RETURNING vacío.
		return fakeResult{Columns: []string{"id"}}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	_, err := repo.RecordPrintJob(
		context.Background(),
		"ADMIN-1",
		nil, nil,
		"new",
		[]PrintJobLine{{Code: posint, Quantity: 1}},
		`{"items":[{"code":"`+posint+`","quantity":1}]}`,
	)
	if err != nil {
		t.Fatalf("RecordPrintJob(POSINT): %v", err)
	}

	var sawInsertJob, sawUpdateCode bool
	for _, st := range f.statements() {
		sql := strings.ToUpper(st.SQL)
		if strings.Contains(sql, `INSERT INTO "LABEL_PRINT_JOBS"`) {
			sawInsertJob = true
		}
		if strings.Contains(sql, `UPDATE "LABEL_CODES"`) {
			sawUpdateCode = true
			// El UPDATE debe filtrar por el code POSINT exacto.
			bound := false
			for _, v := range st.Vars {
				if s, ok := v.(string); ok && s == posint {
					bound = true
					break
				}
			}
			if !bound {
				t.Errorf("el UPDATE de print_count debe parametrizar el code POSINT=%q; vars=%v", posint, st.Vars)
			}
		}
	}
	if !sawInsertJob {
		t.Error("RecordPrintJob debe insertar en label_print_jobs aunque el code sea POSINT-")
	}
	if !sawUpdateCode {
		t.Error("RecordPrintJob debe actualizar print_count del label_code POSINT referenciado")
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("RecordPrintJob debe cerrar la tx; eventos=%v", f.txEvents)
	}
}

// =============================================================================
// Guardianes estáticos de la rama POSINT.
//
// Fijan en el código fuente que:
//
//   - EnsureCodeForProduct consulta models.IsInternalBarcode(...) antes
//     de generar.
//   - La rama POSINT persiste `code = product_barcode = normalized` sin
//     invocar generateUniqueCodeTx.
//   - El error de PK violation se traduce a algo con "POSINT" para que
//     la auditoría pueda filtrarlo.
// =============================================================================

func TestLabelRepo_EnsureCode_UsaHelperIsInternalBarcode(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")
	if !strings.Contains(src, "models.IsInternalBarcode(") {
		t.Error("label_repository.go debe invocar models.IsInternalBarcode(...) para detectar el namespace POSINT-")
	}
	if !strings.Contains(src, "models.NormalizeInternalBarcode(") {
		t.Error("label_repository.go debe normalizar con models.NormalizeInternalBarcode(...) para empatar la normalización canónica de products.barcode")
	}
	if !strings.Contains(src, "models.IsValidInternalBarcode(") {
		t.Error("label_repository.go debe validar el shape POSINT con models.IsValidInternalBarcode(...) antes de abrir la tx")
	}
}

func TestLabelRepo_EnsureCode_RamaPOSINT_NoLlamaGenerador(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")

	// Delimitar el cuerpo de EnsureCodeForProduct.
	patron := regexp.MustCompile(`(?s)func\s+\(r\s+\*LabelRepository\)\s+EnsureCodeForProduct\s*\(.*?\n\}\s*\n`)
	body := patron.FindString(src)
	if body == "" {
		t.Fatal("no se pudo delimitar el cuerpo de EnsureCodeForProduct")
	}

	// Dentro del cuerpo, aislar la rama POSINT que vive DENTRO de la
	// transacción. Hay dos `if isInternal {` en la función: el primero,
	// top-level, valida el shape antes de abrir la tx y termina con
	// `return nil, false, fmt.Errorf(...)`. El segundo, dentro de la
	// Transaction(func), es el que persiste el label_code. Anclamos en
	// el comentario "Rama POSINT:" que precede al segundo bloque para
	// evitar capturar el primero.
	internalBranch := regexp.MustCompile(`(?s)//\s*Rama POSINT:.*?if\s+isInternal\s*\{(.*?)\n\t\t\}\s*\n`)
	m := internalBranch.FindStringSubmatch(body)
	if m == nil {
		t.Fatal("EnsureCodeForProduct debe tener un comentario `// Rama POSINT:` seguido de una rama `if isInternal { ... }` dentro de la Transaction")
	}
	branch := m[1]
	if strings.Contains(branch, "generateUniqueCodeTx(") {
		t.Error("la rama POSINT NO debe invocar generateUniqueCodeTx (eso emitiría LC-<hex>); debe persistir el barcode normalizado como code")
	}
	if !regexp.MustCompile(`Code:\s+normalized`).MatchString(branch) {
		t.Error("la rama POSINT debe asignar `Code: normalized` al nuevo LabelCode (el barcode canonical ES el code impreso)")
	}
	// Debe también quedar explícito que product_barcode se setea con el
	// mismo valor normalized (para cumplir ck_label_codes_posint_matches_product_barcode).
	if !strings.Contains(branch, "ProductBarcode: &bc") {
		t.Error("la rama POSINT debe asignar ProductBarcode = normalized (como alias &bc) para cumplir la coherencia intra-fila del CHECK ck_label_codes_posint_matches_product_barcode")
	}
	// Y debe validar la existencia del producto antes del INSERT.
	if !strings.Contains(branch, `Table("products")`) {
		t.Error("la rama POSINT debe consultar products.barcode antes del INSERT (reserva/producto validados)")
	}
	// Y traducir unique_violation a un error legible mencionando POSINT.
	if !strings.Contains(branch, "isUniqueViolationErr(err)") {
		t.Error("la rama POSINT debe detectar unique_violation con isUniqueViolationErr y traducir el error")
	}
}

func TestLabelRepo_EnsureCode_RamaComercial_SigueUsandoGenerador(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")
	patron := regexp.MustCompile(`(?s)func\s+\(r\s+\*LabelRepository\)\s+EnsureCodeForProduct\s*\(.*?\n\}\s*\n`)
	body := patron.FindString(src)
	if body == "" {
		t.Fatal("no se pudo delimitar EnsureCodeForProduct")
	}
	// La rama comercial sigue invocando generateUniqueCodeTx. Si alguien
	// lo quita por accidente, los productos comerciales perderían la
	// biyección (code != product_barcode) y los LC-<hex> dejarían de
	// generarse.
	if !strings.Contains(body, "r.generateUniqueCodeTx(ctx, tx, normalized)") {
		t.Error("la rama comercial de EnsureCodeForProduct debe seguir invocando generateUniqueCodeTx(ctx, tx, normalized) para emitir LC-<hex>")
	}
}
