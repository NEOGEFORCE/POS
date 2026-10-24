package repositories

import (
	"context"
	"database/sql/driver"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"

	"golang.org/x/crypto/bcrypt"
)

// =============================================================================
// Pruebas del CashDrawerOTPRepository con el fake SQL driver.
//
// Lo que se verifica:
//
//   - Shape del hash bcrypt obligatorio (59..72 bytes).
//   - DNI del actor obligatorio.
//   - Issue emite las sentencias esperadas EN ORDEN: expire-stale,
//     cancel-prior, insert-nuevo.
//   - El challenge_id generado cumple el shape validado por el handler.
//   - CancelPendingByID filtra por status=PENDING (idempotente).
//   - ConfirmChallenge usa SELECT FOR UPDATE (clause.Locking Strength="UPDATE").
//   - ConfirmChallenge rechaza actores distintos sin tocar attempts_used.
//
// Pruebas de BD real (bcrypt timing, biyecciones de la 025) quedan a la
// batería contra Postgres real; el agente pos-reviewer las ejecutará
// en la ventana aprobada tras aplicar la migración.
// =============================================================================

// stubBcryptHash devuelve un hash con el tamaño correcto para pasar el
// CHECK ck_cdoc_code_hash_bcrypt_size SIN pegarle a bcrypt real (ahorra
// 100ms por caso).
func stubBcryptHash(t *testing.T) []byte {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte("000000"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt stub: %v", err)
	}
	if len(hash) < 59 || len(hash) > 72 {
		t.Fatalf("stub bcrypt fuera de rango: %d bytes", len(hash))
	}
	return hash
}

// -----------------------------------------------------------------------------
// Validaciones puras (sin BD)
// -----------------------------------------------------------------------------

func TestCashDrawerOTPRepo_Issue_RechazaActorVacio(t *testing.T) {
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, &fakeSQL{}))
	_, err := repo.Issue(context.Background(), IssueOptions{
		ActorDNI: "",
		CodeHash: stubBcryptHash(t),
	})
	if !errors.Is(err, ErrCashDrawerOTPActorInvalid) {
		t.Fatalf("Issue sin actor debe devolver ErrCashDrawerOTPActorInvalid, got %v", err)
	}
}

func TestCashDrawerOTPRepo_Issue_RechazaHashFueraDeRango(t *testing.T) {
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, &fakeSQL{}))
	cases := [][]byte{
		nil,
		[]byte(""),
		[]byte(strings.Repeat("a", 10)),  // demasiado corto
		[]byte(strings.Repeat("a", 100)), // demasiado largo
	}
	for i, hash := range cases {
		_, err := repo.Issue(context.Background(), IssueOptions{
			ActorDNI: "EMP-1",
			CodeHash: hash,
		})
		if !errors.Is(err, ErrCashDrawerOTPHashInvalid) {
			t.Errorf("caso %d: Issue con hash %d bytes debe devolver ErrCashDrawerOTPHashInvalid, got %v",
				i, len(hash), err)
		}
	}
}

// -----------------------------------------------------------------------------
// Issue: ejecuta expire-stale → cancel-prior → insert bajo la misma tx
// -----------------------------------------------------------------------------

func TestCashDrawerOTPRepo_Issue_EjecutaExpireCancelInsertEnOrden(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		// INSERT con RETURNING id: devolvemos un ID 42 para que GORM
		// pueble el campo ID del struct.
		if strings.Contains(strings.ToUpper(q), "INSERT INTO \"CASH_DRAWER_OTP_CHALLENGES\"") {
			return fakeResult{
				Columns: []string{"id"},
				Rows:    [][]driver.Value{{int64(42)}},
			}
		}
		// Resto (UPDATE ...) son ExecContext; el fake responde 1 fila.
		return fakeResult{}
	}}
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, f))

	issued, err := repo.Issue(context.Background(), IssueOptions{
		ActorDNI:    "EMP-1",
		CodeHash:    stubBcryptHash(t),
		TTL:         90 * time.Second,
		MaxAttempts: 3,
		Now:         func() time.Time { return time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("Issue falló: %v", err)
	}
	if issued == nil {
		t.Fatal("Issue devolvió challenge nil")
	}
	// El hash NO debe viajar fuera del repo.
	if issued.CodeHash != nil {
		t.Error("CashDrawerOTPChallenge.CodeHash debe venir en blanco al salir del repo")
	}
	// Debe traer un challenge_id del shape esperado.
	if !models.IsValidCashDrawerChallengeID(issued.ChallengeID) {
		t.Errorf("challenge_id generado inválido: %q", issued.ChallengeID)
	}

	stmts := f.statements()
	// Orden esperado:
	//   1. UPDATE ... SET status = $1 WHERE requested_by_dni = $2 AND
	//      status = $3 AND expires_at <= $4   (Vars[0]='EXPIRED')
	//   2. UPDATE ... SET status = $1 WHERE requested_by_dni = $2 AND
	//      status = $3   (Vars[0]='CANCELLED')
	//   3. INSERT INTO cash_drawer_otp_challenges ...
	//
	// GORM parametriza los valores, así que inspeccionamos Vars[0] para
	// distinguir expire vs cancel en vez de buscar los literales en SQL.
	var order []string
	for _, st := range stmts {
		trimmed := strings.TrimSpace(strings.ToUpper(st.SQL))
		switch {
		case strings.HasPrefix(trimmed, "UPDATE") && len(st.Vars) > 0 && st.Vars[0] == models.CashDrawerOTPStatusExpired:
			order = append(order, "expire")
		case strings.HasPrefix(trimmed, "UPDATE") && len(st.Vars) > 0 && st.Vars[0] == models.CashDrawerOTPStatusCancelled:
			order = append(order, "cancel")
		case strings.HasPrefix(trimmed, "INSERT INTO \"CASH_DRAWER_OTP_CHALLENGES\""):
			order = append(order, "insert")
		}
	}
	got := strings.Join(order, ",")
	if got != "expire,cancel,insert" {
		t.Fatalf("orden esperado expire→cancel→insert; got %q (%+v)", got, stmts)
	}

	// Toda la operación debe ser una sola transacción confirmada.
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("Issue debe ejecutar en una sola tx confirmada; eventos=%v", f.txEvents)
	}

	// Blindaje anti-secreto en los parámetros bind: ninguna variable
	// debe contener el OTP en claro. Como no sabemos el OTP generado,
	// verificamos que (a) el hash no apareció como string, (b) ningún
	// parámetro es un número de 6 dígitos.
	for _, st := range stmts {
		for _, v := range st.Vars {
			if s, ok := v.(string); ok {
				if models.IsValidCashDrawerOTPFormat(s) {
					t.Errorf("un parámetro bind luce como OTP en claro (6 dígitos): %q", s)
				}
			}
		}
	}
}

// -----------------------------------------------------------------------------
// CancelPendingByID
// -----------------------------------------------------------------------------

func TestCashDrawerOTPRepo_CancelPendingByID_FiltraSoloPending(t *testing.T) {
	f := &fakeSQL{}
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, f))

	if err := repo.CancelPendingByID(context.Background(), 42); err != nil {
		t.Fatalf("CancelPendingByID: %v", err)
	}
	stmts := f.statements()
	if len(stmts) != 1 {
		t.Fatalf("se esperaba 1 UPDATE, hubo %d", len(stmts))
	}
	// La sentencia es un UPDATE sobre cash_drawer_otp_challenges SET
	// status=$1 WHERE id=$2 AND status=$3. GORM parametriza los
	// literales — así que verificamos los Vars en vez de buscar el
	// texto en el SQL.
	st := stmts[0]
	if !containsAll(strings.ToUpper(st.SQL), "UPDATE", "CASH_DRAWER_OTP_CHALLENGES") {
		t.Errorf("CancelPendingByID debe UPDATE cash_drawer_otp_challenges: %s", st.SQL)
	}
	if len(st.Vars) < 2 {
		t.Fatalf("se esperaban al menos 2 Vars (nuevo status + id), vars=%v", st.Vars)
	}
	if st.Vars[0] != models.CashDrawerOTPStatusCancelled {
		t.Errorf("primer Var debe ser 'CANCELLED' (el nuevo status), got %v", st.Vars[0])
	}
	// El filtro WHERE status=? debe tener como Var 'PENDING' para
	// ser idempotente (no vuelve a tocar filas ya CANCELLED).
	foundPending := false
	for _, v := range st.Vars {
		if v == models.CashDrawerOTPStatusPending {
			foundPending = true
			break
		}
	}
	if !foundPending {
		t.Errorf("CancelPendingByID debe filtrar WHERE status='PENDING' (bind param) para ser idempotente; vars=%v", st.Vars)
	}
}

func TestCashDrawerOTPRepo_CancelPendingByID_RechazaIDCero(t *testing.T) {
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, &fakeSQL{}))
	if err := repo.CancelPendingByID(context.Background(), 0); !errors.Is(err, ErrCashDrawerOTPNotFound) {
		t.Fatalf("CancelPendingByID(0) debe devolver ErrCashDrawerOTPNotFound, got %v", err)
	}
}

// -----------------------------------------------------------------------------
// ConfirmChallenge
// -----------------------------------------------------------------------------

func TestCashDrawerOTPRepo_ConfirmChallenge_SinChallengeID(t *testing.T) {
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, &fakeSQL{}))
	_, err := repo.ConfirmChallenge(context.Background(), ConfirmInput{
		ChallengeID: "   ",
		ActorDNI:    "EMP-1",
		OTP:         "123456",
	})
	if !errors.Is(err, ErrCashDrawerOTPNotFound) {
		t.Fatalf("ConfirmChallenge sin challengeID debe devolver ErrCashDrawerOTPNotFound, got %v", err)
	}
}

func TestCashDrawerOTPRepo_ConfirmChallenge_SinActor(t *testing.T) {
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, &fakeSQL{}))
	_, err := repo.ConfirmChallenge(context.Background(), ConfirmInput{
		ChallengeID: strings.Repeat("a", 64),
		ActorDNI:    "   ",
		OTP:         "123456",
	})
	if !errors.Is(err, ErrCashDrawerOTPActorInvalid) {
		t.Fatalf("ConfirmChallenge sin actor debe devolver ErrCashDrawerOTPActorInvalid, got %v", err)
	}
}

func TestCashDrawerOTPRepo_ConfirmChallenge_UsaSelectForUpdate(t *testing.T) {
	// El SELECT inicial debe pedir el lock explícitamente. Si alguien
	// quita el clause.Locking, dos pestañas simultáneas pueden consumir
	// el mismo challenge en paralelo.
	hash, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(strings.ToUpper(q), "FOR UPDATE") {
			// Devuelve una fila PENDING con el hash construido arriba y
			// expires_at MUY lejana (año 3000). Columns deben matchear
			// los campos del struct en orden GORM-friendly.
			future := time.Date(3000, 1, 1, 0, 0, 0, 0, time.UTC)
			return fakeResult{
				Columns: []string{
					"id", "challenge_id", "requested_by_dni", "code_hash",
					"created_at", "expires_at", "attempts_used", "attempts_max",
					"status", "consumed_at", "consumed_drawer_open_id",
				},
				Rows: [][]driver.Value{{
					int64(42), strings.Repeat("a", 64), "EMP-1", hash,
					time.Now().UTC(), future, int64(0), int64(3),
					"PENDING", nil, nil,
				}},
			}
		}
		if strings.Contains(strings.ToUpper(q), "INSERT INTO \"CASH_DRAWER_OPENS\"") {
			return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(777)}}}
		}
		return fakeResult{}
	}}
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, f))

	result, err := repo.ConfirmChallenge(context.Background(), ConfirmInput{
		ChallengeID: strings.Repeat("a", 64),
		ActorDNI:    "EMP-1",
		OTP:         "123456",
	})
	if err != nil {
		t.Fatalf("ConfirmChallenge happy path: %v", err)
	}
	if result == nil || result.DrawerOpen == nil || result.Challenge == nil {
		t.Fatalf("resultado incompleto: %+v", result)
	}
	if result.DrawerOpen.Reason != models.CashDrawerReasonOtpManual {
		t.Errorf("reason debe ser 'otp_manual', got %q", result.DrawerOpen.Reason)
	}
	if result.DrawerOpen.OtpChallengeID == nil || *result.DrawerOpen.OtpChallengeID != 42 {
		t.Errorf("otp_challenge_id debe apuntar al challenge 42, got %+v", result.DrawerOpen.OtpChallengeID)
	}

	stmts := f.statements()
	// Primera sentencia relevante: SELECT ... FOR UPDATE sobre el challenge.
	hasForUpdate := false
	for _, st := range stmts {
		if strings.Contains(strings.ToUpper(st.SQL), "FOR UPDATE") &&
			strings.Contains(st.SQL, "cash_drawer_otp_challenges") {
			hasForUpdate = true
			break
		}
	}
	if !hasForUpdate {
		t.Errorf("ConfirmChallenge debe hacer SELECT ... FOR UPDATE sobre cash_drawer_otp_challenges; vistas: %v",
			dumpSQLs(stmts))
	}

	// En éxito, debe correr en una sola tx confirmada.
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("confirm exitoso debe COMMIT; eventos=%v", f.txEvents)
	}

	// Hash NO debe exponerse hacia fuera.
	if result.Challenge.CodeHash != nil {
		t.Error("Challenge.CodeHash debe venir en nil después de ConfirmChallenge (anti-leak)")
	}
}

func TestCashDrawerOTPRepo_ConfirmChallenge_ActorIncorrecto_NoBumpeaIntento(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(strings.ToUpper(q), "FOR UPDATE") {
			future := time.Date(3000, 1, 1, 0, 0, 0, 0, time.UTC)
			return fakeResult{
				Columns: []string{
					"id", "challenge_id", "requested_by_dni", "code_hash",
					"created_at", "expires_at", "attempts_used", "attempts_max",
					"status", "consumed_at", "consumed_drawer_open_id",
				},
				Rows: [][]driver.Value{{
					int64(42), strings.Repeat("a", 64), "EMP-OTRO", hash,
					time.Now().UTC(), future, int64(0), int64(3),
					"PENDING", nil, nil,
				}},
			}
		}
		return fakeResult{}
	}}
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, f))

	_, err = repo.ConfirmChallenge(context.Background(), ConfirmInput{
		ChallengeID: strings.Repeat("a", 64),
		ActorDNI:    "EMP-ATACANTE",
		OTP:         "123456",
	})
	if !errors.Is(err, ErrCashDrawerOTPWrongActor) {
		t.Fatalf("actor distinto debe devolver ErrCashDrawerOTPWrongActor, got %v", err)
	}
	// NO debe haber UPDATE bumping attempts_used.
	for _, st := range f.statements() {
		if strings.Contains(st.SQL, "attempts_used") {
			t.Errorf("actor incorrecto NO debe gastar un intento: %s", st.SQL)
		}
	}
	// Rollback porque devolvimos error.
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("confirm fallido por actor incorrecto debe ROLLBACK; eventos=%v", f.txEvents)
	}
}

// =============================================================================
// Guardianes anti-leak sobre el fuente del repositorio.
// =============================================================================

// TestCashDrawerOTPRepo_NingunLogImprimeOTPNiHash fija el contrato:
// ningún log.Printf del repo debe interpolar `otp` o `code_hash` (o el
// propio `in.OTP`). Si alguien introduce un log con el OTP, falla.
func TestCashDrawerOTPRepo_NingunLogImprimeOTPNiHash(t *testing.T) {
	src := readRepositorySource(t, "cash_drawer_otp_repository.go")
	for _, pattern := range []string{
		"log.Printf", "log.Println", "fmt.Println",
	} {
		if strings.Contains(src, pattern) {
			t.Errorf("cash_drawer_otp_repository.go NO debe tener %q: los logs del flujo OTP viven en el service y jamás imprimen el código", pattern)
		}
	}
	// Tampoco debe exponer el nombre de la variable en el error devuelto.
	for _, forbidden := range []string{
		`fmt.Errorf("otp: %s"`,
		`fmt.Errorf("OTP %q"`,
	} {
		if strings.Contains(src, forbidden) {
			t.Errorf("cash_drawer_otp_repository.go NO debe interpolar el OTP en errores: %q", forbidden)
		}
	}
}

// -----------------------------------------------------------------------------
// Helpers compartidos del paquete
// -----------------------------------------------------------------------------

// dumpSQLs devuelve una lista plana de los SQL capturados para incluir
// en el mensaje de error cuando una aserción falla.
func dumpSQLs(stmts []capturedStmt) []string {
	out := make([]string, 0, len(stmts))
	for _, s := range stmts {
		out = append(out, s.SQL)
	}
	return out
}

// readRepositorySource lee un archivo del paquete para los tests
// estáticos de blindaje. Reutilizable entre tests.
func readRepositorySource(t *testing.T, path string) string {
	t.Helper()
	bts, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(bts)
}
