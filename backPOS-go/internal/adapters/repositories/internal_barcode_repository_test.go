package repositories

import (
	"context"
	"database/sql/driver"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================================
// Guardianes estáticos del InternalBarcodeRepository.
//
// Fijan invariantes críticas a nivel código, sin levantar Postgres:
//
//   - Reserve corre dentro de una transacción explícita (serializa el
//     generador y evita doble emisión).
//   - CreateProductConsumingReservation usa SELECT FOR UPDATE sobre la
//     reserva antes de insertar el producto.
//   - El generador usa crypto/rand (nunca cae a time.Now()).
//   - candidateCollidesTx consulta las cinco fuentes de colisión
//     documentadas por el contrato.
// =============================================================================

func leerArchivoInternal(t *testing.T, name string) string {
	t.Helper()
	path, err := filepath.Abs(name)
	if err != nil {
		t.Fatalf("abs(%s): %v", name, err)
	}
	bts, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read(%s): %v", path, err)
	}
	return string(bts)
}

func TestInternalRepo_Reserve_UsaTransaccionYRetry(t *testing.T) {
	src := leerArchivoInternal(t, "internal_barcode_repository.go")
	if !strings.Contains(src, "r.db.WithContext(ctx).Transaction") {
		t.Error("Reserve debe correr dentro de Transaction(...) para serializar el generador")
	}
	if !strings.Contains(src, "internalBarcodeMaxReserveAttempts") {
		t.Error("Reserve debe tener techo de reintentos declarado")
	}
	// crypto/rand es la ÚNICA fuente. Nunca time.Now() como semilla de
	// aleatoriedad (eso introduciría colisiones milisegundo-a-milisegundo).
	if !strings.Contains(src, "crypto/rand") || !strings.Contains(src, "rand.Read(buf)") {
		t.Error("Reserve debe usar crypto/rand (rand.Read) como fuente de entropía")
	}
	if regexp.MustCompile(`time\.Now\(\)\.UnixNano\(\)\s*%`).MatchString(src) {
		t.Error("Reserve NO debe usar time.Now().UnixNano() como aleatoriedad del generador")
	}
}

func TestInternalRepo_CreateProductConsumingReservation_SELECTForUpdate(t *testing.T) {
	src := leerArchivoInternal(t, "internal_barcode_repository.go")
	// La reserva se bloquea con clause.Locking{Strength:"UPDATE"} antes
	// de insertar el producto. Si alguien lo cambia a First sin Locking,
	// dos tx podrían consumir la misma reserva en carrera.
	if !strings.Contains(src, `clause.Locking{Strength: "UPDATE"}`) {
		t.Error("CreateProductConsumingReservation debe tomar un SELECT FOR UPDATE sobre la reserva")
	}
	if !regexp.MustCompile(`Where\(\s*"reserved_code\s*=\s*\?"\s*,\s*normalized\s*\)`).MatchString(src) {
		t.Error("El lock debe ser por reserved_code = ? con el valor normalizado")
	}
}

func TestInternalRepo_CandidateCollidesTx_ConsultaCincoFuentes(t *testing.T) {
	src := leerArchivoInternal(t, "internal_barcode_repository.go")
	// Las cinco fuentes de colisión (products.barcode, alternate_codes,
	// label_codes, package_barcode_aliases, internal_barcode_reservations).
	for _, token := range []string{
		`Table("products")`,
		`internalBarcodeAlternateCodesContainsSQL`,
		`Table("label_codes")`,
		`Table("package_barcode_aliases")`,
		`Table("internal_barcode_reservations")`,
	} {
		if !strings.Contains(src, token) {
			t.Errorf("candidateCollidesTx debe consultar %q", token)
		}
	}
	// Las tablas opcionales se consultan DESPUÉS de verificar su
	// existencia con to_regclass en sentencia aparte (misma política que
	// labelCodesTableExists).
	for _, probe := range []string{
		"labelCodesTableExists(tx)",
		"packageBarcodeAliasesTableExists(tx)",
		"internalBarcodeReservationsTableExists(tx)",
	} {
		if !strings.Contains(src, probe) {
			t.Errorf("candidateCollidesTx debe verificar existencia con %s", probe)
		}
	}
}

func TestInternalRepo_GenerateInternalBarcode_FormatoCODE128YMayusculas(t *testing.T) {
	t.Parallel()
	for _, hexLen := range []int{models.InternalBarcodeHexMin, 12, models.InternalBarcodeHexMax} {
		got, err := generateInternalBarcode(hexLen)
		if err != nil {
			t.Fatalf("hexLen=%d: %v", hexLen, err)
		}
		if !strings.HasPrefix(got, models.InternalBarcodePrefix) {
			t.Errorf("hexLen=%d: candidato %q no empieza por %q", hexLen, got, models.InternalBarcodePrefix)
		}
		body := strings.TrimPrefix(got, models.InternalBarcodePrefix)
		if len(body) != hexLen {
			t.Errorf("hexLen=%d: cuerpo %q longitud %d, want %d", hexLen, body, len(body), hexLen)
		}
		if body != strings.ToUpper(body) {
			t.Errorf("hexLen=%d: cuerpo %q no está en MAYÚSCULAS (empatar con ToUpper del handler)", hexLen, body)
		}
		if !regexp.MustCompile(`^[0-9A-F]+$`).MatchString(body) {
			t.Errorf("hexLen=%d: cuerpo %q contiene caracteres fuera del alfabeto hex", hexLen, body)
		}
		if !models.IsValidInternalBarcode(got) {
			t.Errorf("hexLen=%d: %q no pasa IsValidInternalBarcode (CHECK de la BD)", hexLen, got)
		}
	}
}

func TestInternalRepo_GenerateInternalBarcode_RangoAleatorio(t *testing.T) {
	t.Parallel()
	// 100 candidatos deben ser todos distintos entre sí con alta
	// probabilidad (p ~ 1 - 100²/2·2^48 ≈ 1 - 1.8e-11). Si alguno repite,
	// crypto/rand o la longitud por defecto cambiaron y la propiedad
	// de unicidad del generador quedó rota.
	seen := make(map[string]struct{}, 100)
	for i := 0; i < 100; i++ {
		code, err := generateInternalBarcode(models.InternalBarcodeDefaultHexLen)
		if err != nil {
			t.Fatalf("generateInternalBarcode: %v", err)
		}
		if _, dup := seen[code]; dup {
			t.Fatalf("duplicado inesperado en %d intentos: %q", i, code)
		}
		seen[code] = struct{}{}
	}
}

func TestInternalRepo_IsUniqueViolation(t *testing.T) {
	t.Parallel()
	cases := map[string]bool{
		"duplicate key value violates unique constraint": true,
		"SQLSTATE 23505": true,
		"ERROR: duplicate key value (SQLSTATE 23505)": true,
		"pq: duplicate key value violates ...":        true,
		"unique constraint foo":                       true,
		"relation does not exist":                     false,
		"":                                            false,
	}
	for s, want := range cases {
		got := isUniqueViolationErr(errors.New(s))
		if got != want {
			t.Errorf("isUniqueViolationErr(%q) = %v, want %v", s, got, want)
		}
	}
	if isUniqueViolationErr(nil) {
		t.Error("isUniqueViolationErr(nil) debe ser false")
	}
}

// =============================================================================
// Pruebas de SQL real emitido (dry-run + fakeSQL).
// =============================================================================

func TestInternalRepo_CandidateCollidesTx_SQLEmitido(t *testing.T) {
	// Usamos fakeSQL para controlar qué devuelve cada probe de to_regclass
	// y qué devuelven los counts. Simulamos que las tres tablas opcionales
	// EXISTEN (migraciones 016, 017 y 024 aplicadas).
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(q, "to_regclass") {
			return one("exists", true)
		}
		if strings.Contains(q, "count(") || strings.Contains(q, "COUNT(") {
			return one("count", int64(0))
		}
		return fakeResult{}
	}}
	db := newFakeGormDB(t, f)

	const candidate = "POSINT-ABCDEF01"
	colisiona, err := candidateCollidesTx(context.Background(), db, candidate)
	if err != nil {
		t.Fatalf("candidateCollidesTx: %v", err)
	}
	if colisiona {
		t.Fatal("sin filas en ninguna fuente, no debería reportar colisión")
	}

	// Debe emitirse: products.barcode, alternate_codes, probe label_codes,
	// label_codes.code, probe package_barcode_aliases, package_barcode_aliases.code,
	// probe internal_barcode_reservations, internal_barcode_reservations.
	stmts := f.statements()
	var countsAgainst []string
	for _, st := range stmts {
		switch {
		case strings.Contains(st.SQL, `"products"`) && strings.Contains(st.SQL, "alternate_codes"):
			countsAgainst = append(countsAgainst, "alternate_codes")
		case strings.Contains(st.SQL, `"products"`) && strings.Contains(st.SQL, "barcode = $"):
			countsAgainst = append(countsAgainst, "barcode")
		case strings.Contains(st.SQL, `"label_codes"`) && strings.Contains(st.SQL, "code = $"):
			countsAgainst = append(countsAgainst, "label_codes")
		case strings.Contains(st.SQL, `"package_barcode_aliases"`) && strings.Contains(st.SQL, "package_code = $"):
			countsAgainst = append(countsAgainst, "package_barcode_aliases")
		case strings.Contains(st.SQL, `"internal_barcode_reservations"`) && strings.Contains(st.SQL, "reserved_code = $"):
			countsAgainst = append(countsAgainst, "internal_barcode_reservations")
		}
	}
	// Cada fuente aparece al menos una vez. El orden es parte del contrato
	// (products → alternate_codes → label_codes → package → internal).
	esperado := []string{"barcode", "alternate_codes", "label_codes", "package_barcode_aliases", "internal_barcode_reservations"}
	if strings.Join(countsAgainst, ",") != strings.Join(esperado, ",") {
		t.Fatalf("orden/presencia de counts inesperado: got=%v want=%v (stmts=%d)", countsAgainst, esperado, len(stmts))
	}
	for _, st := range stmts {
		if strings.Contains(st.SQL, candidate) {
			t.Errorf("el candidato NO debe concatenarse en el SQL: %s", st.SQL)
		}
	}
}

func TestInternalRepo_CandidateCollidesTx_ToleraTablasOpcionalesAusentes(t *testing.T) {
	// Las tres probes to_regclass devuelven false (migraciones 016, 017,
	// 024 no aplicadas). Las dos fuentes "primarias" (products.barcode y
	// alternate_codes) siguen consultándose. El candidato se devuelve
	// como no-colisión si no hay hits.
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(q, "to_regclass") {
			return one("exists", false)
		}
		if strings.Contains(q, "count(") || strings.Contains(q, "COUNT(") {
			return one("count", int64(0))
		}
		return fakeResult{}
	}}
	db := newFakeGormDB(t, f)

	colisiona, err := candidateCollidesTx(context.Background(), db, "POSINT-00000000")
	if err != nil {
		t.Fatalf("candidateCollidesTx: %v", err)
	}
	if colisiona {
		t.Fatal("sin hits en products, no debería reportar colisión")
	}
	stmts := f.statements()
	// Verificamos que NINGUNA consulta real contra las tablas opcionales se
	// emitió (sólo las probes de existencia).
	for _, st := range stmts {
		if strings.Contains(st.SQL, "FROM \"label_codes\"") {
			t.Errorf("no debe consultar label_codes cuando to_regclass dice que no existe: %s", st.SQL)
		}
		if strings.Contains(st.SQL, "FROM \"package_barcode_aliases\"") {
			t.Errorf("no debe consultar package_barcode_aliases cuando to_regclass dice que no existe: %s", st.SQL)
		}
		if strings.Contains(st.SQL, "FROM \"internal_barcode_reservations\"") {
			t.Errorf("no debe consultar internal_barcode_reservations cuando to_regclass dice que no existe: %s", st.SQL)
		}
	}
}

func TestInternalRepo_CandidateCollidesTx_DetectaCadaFuente(t *testing.T) {
	// Para cada fuente, forzamos un count=1 en esa fuente y verificamos
	// que la función short-circuit a true.
	fuentes := []struct {
		name   string
		marker string
	}{
		{"products.barcode", `"products" WHERE barcode = $1`},
		{"alternate_codes", `string_to_array`},
		{"label_codes", `"label_codes"`},
		{"package_barcode_aliases", `"package_barcode_aliases"`},
		{"internal_barcode_reservations", `"internal_barcode_reservations"`},
	}
	for _, fuente := range fuentes {
		t.Run(fuente.name, func(t *testing.T) {
			f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
				if strings.Contains(q, "to_regclass") {
					return one("exists", true)
				}
				if strings.Contains(q, "count(") || strings.Contains(q, "COUNT(") {
					if strings.Contains(q, fuente.marker) {
						return one("count", int64(1))
					}
					return one("count", int64(0))
				}
				return fakeResult{}
			}}
			db := newFakeGormDB(t, f)
			colisiona, err := candidateCollidesTx(context.Background(), db, "POSINT-ABCDEF01")
			if err != nil {
				t.Fatalf("candidateCollidesTx: %v", err)
			}
			if !colisiona {
				t.Fatalf("colisión en %s no se detectó", fuente.name)
			}
		})
	}
}

func TestInternalRepo_Reserve_InsertaReservaValida(t *testing.T) {
	// Flujo completo del happy path: generador produce candidato, probe
	// de las 3 tablas opcionales dice "existen", counts devuelven 0,
	// INSERT devuelve 1 fila.
	f := &fakeSQL{
		respond: func(q string, _ []interface{}) fakeResult {
			if strings.Contains(q, "to_regclass") {
				return one("exists", true)
			}
			if strings.Contains(q, "count(") || strings.Contains(q, "COUNT(") {
				return one("count", int64(0))
			}
			if strings.Contains(strings.ToUpper(q), "INSERT INTO \"INTERNAL_BARCODE_RESERVATIONS\"") {
				// GORM Postgres emite INSERT ... RETURNING ..., así que el
				// INSERT pasa por QueryContext. Devolvemos una fila vacía
				// (sin "RETURNING clause doesn't produce rows" porque la
				// migración no tiene columnas con DEFAULT que GORM necesite
				// re-leer).
				return fakeResult{}
			}
			return fakeResult{}
		},
	}
	repo := NewInternalBarcodeRepository(newFakeGormDB(t, f))

	res, err := repo.Reserve(context.Background(), ReserveOptions{
		Source:   models.InternalBarcodeSourceProductForm,
		ActorDNI: "EMP-01",
		Note:     "test desde modal",
	})
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	if !models.IsValidInternalBarcode(res.ReservedCode) {
		t.Errorf("ReservedCode=%q no cumple shape POSINT-<hex>", res.ReservedCode)
	}
	if res.Status != models.InternalBarcodeStatusReserved {
		t.Errorf("Status=%q, want RESERVED", res.Status)
	}
	if res.Source != models.InternalBarcodeSourceProductForm {
		t.Errorf("Source=%q, want product_form", res.Source)
	}
	if res.ReservedByDNI != "EMP-01" {
		t.Errorf("ReservedByDNI=%q, want EMP-01", res.ReservedByDNI)
	}
	// Verificamos que INSERT se haya intentado via las sentencias
	// capturadas (puede ir por QueryContext si hay RETURNING).
	var insertSeen int
	for _, st := range f.statements() {
		if strings.Contains(strings.ToUpper(st.SQL), "INSERT INTO \"INTERNAL_BARCODE_RESERVATIONS\"") {
			insertSeen++
		}
	}
	if insertSeen != 1 {
		t.Errorf("se esperaba 1 INSERT en internal_barcode_reservations, hubo %d", insertSeen)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("Reserve debe correr en una sola tx confirmada; eventos=%v", f.txEvents)
	}
}

func TestInternalRepo_Reserve_RechazaSourceDesconocido(t *testing.T) {
	t.Parallel()
	repo := NewInternalBarcodeRepository(nil) // no debe tocar la BD
	for _, source := range []string{"foo", "bar", "SCAN", "scan"} {
		_, err := repo.Reserve(context.Background(), ReserveOptions{
			Source:   source,
			ActorDNI: "EMP-01",
		})
		if !errors.Is(err, ErrInternalBarcodeInvalidSource) {
			t.Errorf("source=%q debería devolver ErrInternalBarcodeInvalidSource, got %v", source, err)
		}
	}
}

func TestInternalRepo_Reserve_RechazaActorVacio(t *testing.T) {
	t.Parallel()
	repo := NewInternalBarcodeRepository(nil)
	_, err := repo.Reserve(context.Background(), ReserveOptions{
		Source:   models.InternalBarcodeSourceProductForm,
		ActorDNI: "   \t\n",
	})
	if !errors.Is(err, ErrInternalBarcodeInvalidActor) {
		t.Errorf("ActorDNI vacío debería devolver ErrInternalBarcodeInvalidActor, got %v", err)
	}
}

func TestInternalRepo_Reserve_RechazaHexLenFueraDeRango(t *testing.T) {
	t.Parallel()
	repo := NewInternalBarcodeRepository(nil)
	for _, hexLen := range []int{1, 7, 25, 100} {
		_, err := repo.Reserve(context.Background(), ReserveOptions{
			Source:   models.InternalBarcodeSourceProductForm,
			ActorDNI: "EMP-01",
			HexLen:   hexLen,
		})
		if err == nil || !strings.Contains(err.Error(), "hexLen=") {
			t.Errorf("hexLen=%d debería rechazarse con mensaje de rango; got %v", hexLen, err)
		}
	}
}

func TestInternalRepo_Reserve_RetryTrasColision(t *testing.T) {
	// La primera iteración ve una colisión en products.barcode, la
	// segunda no. Reserve debe retornar el segundo candidato.
	var countSeen int32
	f := &fakeSQL{
		respond: func(q string, _ []interface{}) fakeResult {
			if strings.Contains(q, "to_regclass") {
				return one("exists", true)
			}
			if strings.Contains(q, `"products" WHERE barcode = $1`) {
				// Primera llamada → colisión. Resto → libre.
				n := atomic.AddInt32(&countSeen, 1)
				if n == 1 {
					return one("count", int64(1))
				}
				return one("count", int64(0))
			}
			if strings.Contains(q, "count(") || strings.Contains(q, "COUNT(") {
				return one("count", int64(0))
			}
			return fakeResult{}
		},
	}
	repo := NewInternalBarcodeRepository(newFakeGormDB(t, f))

	res, err := repo.Reserve(context.Background(), ReserveOptions{
		Source:   models.InternalBarcodeSourceProductForm,
		ActorDNI: "EMP-01",
	})
	if err != nil {
		t.Fatalf("Reserve tras un reintento: %v", err)
	}
	if res == nil || !models.IsValidInternalBarcode(res.ReservedCode) {
		t.Fatalf("Reserve tras un reintento devolvió payload inválido: %+v", res)
	}
	// Debe haber al menos 2 lookups por barcode (uno por candidato).
	if atomic.LoadInt32(&countSeen) < 2 {
		t.Errorf("se esperaban >= 2 counts de products.barcode (uno por candidato); got %d", countSeen)
	}
}

func TestInternalRepo_Reserve_PropagaErrorNoUnique(t *testing.T) {
	// Un error no-unique del INSERT (p.ej. BD caída) debe propagar y
	// causar ROLLBACK.
	f := &fakeSQL{
		respond: func(q string, _ []interface{}) fakeResult {
			if strings.Contains(q, "to_regclass") {
				return one("exists", true)
			}
			if strings.Contains(q, "count(") || strings.Contains(q, "COUNT(") {
				return one("count", int64(0))
			}
			if strings.Contains(strings.ToUpper(q), "INSERT INTO \"INTERNAL_BARCODE_RESERVATIONS\"") {
				return fakeResult{Err: errors.New("ERROR: connection to server lost (SQLSTATE 08006)")}
			}
			return fakeResult{}
		},
	}
	repo := NewInternalBarcodeRepository(newFakeGormDB(t, f))

	_, err := repo.Reserve(context.Background(), ReserveOptions{
		Source:   models.InternalBarcodeSourceProductForm,
		ActorDNI: "EMP-01",
	})
	if err == nil {
		t.Fatal("Reserve debe propagar errores no-unique del INSERT")
	}
	// Y la tx se debe revertir.
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("la tx debe revertirse; eventos=%v", f.txEvents)
	}
}

func TestInternalRepo_GetByCode_NormalizaYRechazaVacio(t *testing.T) {
	repo := NewInternalBarcodeRepository(nil)
	_, err := repo.GetByCode(context.Background(), "   \t ")
	if !errors.Is(err, ErrInternalBarcodeReservationNotFound) {
		t.Errorf("GetByCode con vacío debe devolver ErrInternalBarcodeReservationNotFound, got %v", err)
	}
}

func TestInternalRepo_GetByCode_UsaBindParametrizado(t *testing.T) {
	// Simulamos que la fila existe. Verificamos que el SELECT va
	// parametrizado y que el valor binded se normaliza a mayúsculas.
	f := &fakeSQL{respond: func(q string, args []interface{}) fakeResult {
		if strings.Contains(q, "reserved_code = $1") {
			return fakeResult{
				Columns: []string{"reserved_code", "status", "source", "reserved_at", "reserved_by_dni", "expires_at", "consumed_at", "consumed_product_barcode", "consumed_by_dni", "note"},
				Rows: [][]driver.Value{{
					args[0], "RESERVED", "product_form", nil, "EMP-01", nil, nil, nil, nil, nil,
				}},
			}
		}
		return fakeResult{}
	}}
	repo := NewInternalBarcodeRepository(newFakeGormDB(t, f))

	// Entrada con whitespace y minúsculas; la normalización canonicaliza
	// a MAYÚSCULAS trim antes del lookup.
	res, err := repo.GetByCode(context.Background(), "  posint-abcdef01\t")
	if err != nil {
		t.Fatalf("GetByCode: %v", err)
	}
	if res == nil || res.ReservedCode != "POSINT-ABCDEF01" {
		t.Fatalf("GetByCode debe normalizar y devolver mayúsculas; got %+v", res)
	}
	stmts := f.statements()
	if len(stmts) == 0 {
		t.Fatal("se esperaba al menos una consulta")
	}
	if !strings.Contains(stmts[0].SQL, "$1") {
		t.Errorf("GetByCode debe usar bind parametrizado ($1); SQL=%s", stmts[0].SQL)
	}
	// GORM añade el LIMIT 1 como segundo bind; el PRIMER bind debe ser el
	// código normalizado.
	if len(stmts[0].Vars) < 1 || stmts[0].Vars[0] != "POSINT-ABCDEF01" {
		t.Errorf("el primer bind debe ser el código normalizado; vars=%v", stmts[0].Vars)
	}
}

// =============================================================================
// Rutas registradas en main.go
// =============================================================================

func TestInternalRepo_RutasRegistradasEnMain(t *testing.T) {
	root := filepath.Join("..", "..", "..", "cmd", "api", "main.go")
	bts, err := os.ReadFile(root)
	if err != nil {
		t.Skipf("No se pudo leer %s: %v", root, err)
	}
	src := string(bts)
	if !regexp.MustCompile(`labels\.POST\("\s*/internal-codes/reserve\s*",\s*internalBarcodeHandler\.Reserve\)`).MatchString(src) {
		t.Error("La ruta POST /internal-codes/reserve → internalBarcodeHandler.Reserve debe estar registrada dentro del grupo labels en main.go")
	}
	if !regexp.MustCompile(`labels\.GET\("\s*/internal-codes/:code\s*",\s*internalBarcodeHandler\.GetByCode\)`).MatchString(src) {
		t.Error("La ruta GET /internal-codes/:code → internalBarcodeHandler.GetByCode debe estar registrada dentro del grupo labels en main.go")
	}
	// El handler debe estar inyectado al handler de productos para que
	// la ruta POST /products/create-products pueda consumir reservas.
	if !strings.Contains(src, "WithInternalBarcodeRepo(internalBarcodeRepo)") {
		t.Error("ProductHandler debe recibir internalBarcodeRepo vía WithInternalBarcodeRepo en el wiring de main.go")
	}
}
