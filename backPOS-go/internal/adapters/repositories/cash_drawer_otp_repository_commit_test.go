package repositories

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"

	"golang.org/x/crypto/bcrypt"
)

// =============================================================================
// Regresiones del flujo de confirmación OTP.
//
// Antes, los paths de "fin de vida" del challenge (mismatch, tercer
// mismatch que llega al techo, expiración detectada tarde) hacían
// UPDATE dentro del callback de Transaction y luego devolvían un error
// de dominio desde el mismo callback. GORM interpretaba ese retorno
// como fallo y hacía ROLLBACK — exactamente lo contrario de lo que se
// pretendía: los intentos y las transiciones de estado quedaban SIN
// persistir, permitiendo un brute-force transparente.
//
// Estas pruebas FIJAN el contrato nuevo:
//
//   • Mismatch con intento disponible          → BEGIN,COMMIT + UPDATE attempts_used
//   • Tercer mismatch (bump al techo)          → BEGIN,COMMIT + UPDATE attempts_used + status=FAILED
//   • Expiración detectada dentro de Confirm   → BEGIN,COMMIT + UPDATE status=EXPIRED
//   • Actor incorrecto                         → BEGIN,ROLLBACK + sin UPDATE (ya existente, extendemos)
//
// También verifican la invariante anti-leak: ningún parámetro bind al
// UPDATE puede contener el OTP en claro.
// =============================================================================

// otpChallengeRowColumns es el conjunto de columnas que el fake SQL
// devuelve al emular el SELECT FOR UPDATE sobre
// cash_drawer_otp_challenges. Centralizarlo evita que un cambio en el
// orden de los campos de la struct haga ilegibles las filas emuladas.
var otpChallengeRowColumns = []string{
	"id", "challenge_id", "requested_by_dni", "code_hash",
	"created_at", "expires_at", "attempts_used", "attempts_max",
	"status", "consumed_at", "consumed_drawer_open_id",
}

// buildPendingOTPRow arma una fila PENDING con los parámetros clave que
// cada test ajusta: el hash, los intentos ya consumidos y la ventana de
// expiración. El actor se fija aquí a "EMP-1" para que los tests pasen
// la validación de actor matching; quienes quieran otro actor pueden
// sobrescribir Rows[0][2].
func buildPendingOTPRow(hash []byte, attemptsUsed, attemptsMax int, expiresAt time.Time) fakeResult {
	return fakeResult{
		Columns: otpChallengeRowColumns,
		Rows: [][]driver.Value{{
			int64(42), strings.Repeat("a", 64), "EMP-1", hash,
			time.Date(2026, 10, 13, 11, 0, 0, 0, time.UTC), expiresAt,
			int64(attemptsUsed), int64(attemptsMax),
			models.CashDrawerOTPStatusPending, nil, nil,
		}},
	}
}

// countUpdates cuenta cuántas sentencias UPDATE se enviaron a la BD.
// Útil para asegurar que un path "sin cambios" no emitió ninguna.
func countUpdates(stmts []capturedStmt) int {
	n := 0
	for _, st := range stmts {
		if strings.HasPrefix(strings.TrimSpace(strings.ToUpper(st.SQL)), "UPDATE") {
			n++
		}
	}
	return n
}

// updateHasVar reporta si alguna sentencia UPDATE lleva en su vector
// de parámetros el valor esperado. Lo usamos para confirmar que una
// transición de estado (p.ej. a FAILED) viajó por bind y no por
// concatenación.
func updateHasVar(stmts []capturedStmt, want interface{}) bool {
	for _, st := range stmts {
		if !strings.HasPrefix(strings.TrimSpace(strings.ToUpper(st.SQL)), "UPDATE") {
			continue
		}
		for _, v := range st.Vars {
			if v == want {
				return true
			}
		}
	}
	return false
}

// -----------------------------------------------------------------------------
// Mismatch con intento disponible
// -----------------------------------------------------------------------------

// Fija el contrato "mismatch reintentable → BEGIN,COMMIT con bump de
// attempts_used durable". Antes de la corrección, el repo retornaba
// `ErrCashDrawerOTPMismatch` desde el callback de Transaction, lo que
// gatillaba ROLLBACK y descartaba el UPDATE del intento.
func TestCashDrawerOTPRepo_ConfirmChallenge_MismatchReintentable_CommitBumpDurable(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	future := time.Date(3000, 1, 1, 0, 0, 0, 0, time.UTC)

	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(strings.ToUpper(q), "FOR UPDATE") {
			// 0/3 intentos: el bump deja 1/3, el challenge sigue vivo.
			return buildPendingOTPRow(hash, 0, 3, future)
		}
		return fakeResult{}
	}}
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, f))

	_, err = repo.ConfirmChallenge(context.Background(), ConfirmInput{
		ChallengeID: strings.Repeat("a", 64),
		ActorDNI:    "EMP-1",
		OTP:         "999999", // ≠ 123456
	})
	if !errors.Is(err, ErrCashDrawerOTPMismatch) {
		t.Fatalf("mismatch reintentable debe devolver ErrCashDrawerOTPMismatch, got %v", err)
	}

	stmts := f.statements()
	// Un UPDATE con `attempts_used` entre los parámetros bind.
	foundBump := false
	for _, st := range stmts {
		if !strings.HasPrefix(strings.TrimSpace(strings.ToUpper(st.SQL)), "UPDATE") {
			continue
		}
		if !strings.Contains(st.SQL, "attempts_used") {
			continue
		}
		foundBump = true
		for _, v := range st.Vars {
			// Blindaje: el bump jamás puede llevar el OTP tecleado.
			if s, ok := v.(string); ok && models.IsValidCashDrawerOTPFormat(s) {
				t.Errorf("UPDATE del bump incluye un valor que parece OTP en claro: %q", s)
			}
		}
	}
	if !foundBump {
		t.Errorf("mismatch reintentable debe bumpear attempts_used; stmts=%v", dumpSQLs(stmts))
	}
	// Secuencia de tx debe terminar en COMMIT.
	if got := strings.Join(f.txEvents, ","); got != "BEGIN,COMMIT" {
		t.Errorf("mismatch reintentable debe BEGIN,COMMIT (bump durable); eventos=%v", f.txEvents)
	}
	// Y status=FAILED NO debe aparecer: aún queda intento.
	if updateHasVar(stmts, models.CashDrawerOTPStatusFailed) {
		t.Error("mismatch reintentable NO debe pasar a FAILED todavía")
	}
}

// -----------------------------------------------------------------------------
// Tercer mismatch → FAILED
// -----------------------------------------------------------------------------

// Fija el contrato "tercer mismatch → BEGIN,COMMIT con attempts_used
// bumpeado al techo Y status=FAILED durable". Con esto, el cliente no
// puede seguir reintentando al mismo challenge para disfrazar bursts
// de brute-force.
func TestCashDrawerOTPRepo_ConfirmChallenge_TercerMismatch_CommitFailed(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	future := time.Date(3000, 1, 1, 0, 0, 0, 0, time.UTC)

	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(strings.ToUpper(q), "FOR UPDATE") {
			// 2/3 intentos: este tercer fallo lo bumpea a 3/3 y pasa a FAILED.
			return buildPendingOTPRow(hash, 2, 3, future)
		}
		return fakeResult{}
	}}
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, f))

	_, err = repo.ConfirmChallenge(context.Background(), ConfirmInput{
		ChallengeID: strings.Repeat("a", 64),
		ActorDNI:    "EMP-1",
		OTP:         "999999", // ≠ 123456
	})
	if !errors.Is(err, ErrCashDrawerOTPExhaustedByThisAttempt) {
		t.Fatalf("tercer mismatch debe devolver ErrCashDrawerOTPExhaustedByThisAttempt, got %v", err)
	}

	stmts := f.statements()
	// El UPDATE debe llevar `attempts_used` y `status` como columnas.
	foundBumpAndFailed := false
	for _, st := range stmts {
		if !strings.HasPrefix(strings.TrimSpace(strings.ToUpper(st.SQL)), "UPDATE") {
			continue
		}
		if !(strings.Contains(st.SQL, "attempts_used") && strings.Contains(st.SQL, "status")) {
			continue
		}
		foundBumpAndFailed = true
	}
	if !foundBumpAndFailed {
		t.Errorf("tercer mismatch debe UPDATE con attempts_used Y status; stmts=%v", dumpSQLs(stmts))
	}
	if !updateHasVar(stmts, models.CashDrawerOTPStatusFailed) {
		t.Errorf("tercer mismatch debe transicionar a FAILED (bind var); stmts=%v", dumpSQLs(stmts))
	}
	if got := strings.Join(f.txEvents, ","); got != "BEGIN,COMMIT" {
		t.Errorf("tercer mismatch debe BEGIN,COMMIT (status=FAILED durable); eventos=%v", f.txEvents)
	}
}

// -----------------------------------------------------------------------------
// Expiración detectada tarde → EXPIRED durable
// -----------------------------------------------------------------------------

// Fija el contrato "expiración → BEGIN,COMMIT con UPDATE status=EXPIRED
// durable". Antes, aunque el UPDATE se emitía, la Transaction hacía
// rollback y la fila quedaba en PENDING, molestando al siguiente
// Request del mismo actor (que la encontraría viva).
func TestCashDrawerOTPRepo_ConfirmChallenge_Expirado_CommitStatusExpired(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	// expires_at = 2020-01-01 → claramente pasado.
	past := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)

	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(strings.ToUpper(q), "FOR UPDATE") {
			return buildPendingOTPRow(hash, 0, 3, past)
		}
		return fakeResult{}
	}}
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, f))

	// `now` se fuerza al año 2026 para que la fila sea claramente
	// expirada sin depender del reloj real.
	_, err = repo.ConfirmChallenge(context.Background(), ConfirmInput{
		ChallengeID: strings.Repeat("a", 64),
		ActorDNI:    "EMP-1",
		OTP:         "123456",
		Now:         func() time.Time { return time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC) },
	})
	if !errors.Is(err, ErrCashDrawerOTPExpired) {
		t.Fatalf("expirado debe devolver ErrCashDrawerOTPExpired, got %v", err)
	}

	stmts := f.statements()
	if !updateHasVar(stmts, models.CashDrawerOTPStatusExpired) {
		t.Errorf("expiración debe emitir UPDATE status=EXPIRED (bind); stmts=%v", dumpSQLs(stmts))
	}
	if got := strings.Join(f.txEvents, ","); got != "BEGIN,COMMIT" {
		t.Errorf("expiración debe BEGIN,COMMIT (status=EXPIRED durable); eventos=%v", f.txEvents)
	}
	// Y attempts_used NO debe tocarse: no es un intento, es una
	// expiración detectada al confirmar.
	for _, st := range stmts {
		if strings.Contains(st.SQL, "attempts_used") {
			t.Errorf("expiración NO debe bumpear attempts_used: %s", st.SQL)
		}
	}
}

// -----------------------------------------------------------------------------
// Actor incorrecto NO gasta intento (y hace ROLLBACK)
// -----------------------------------------------------------------------------

// Complementa `TestCashDrawerOTPRepo_ConfirmChallenge_ActorIncorrecto_NoBumpeaIntento`
// con una verificación más estricta: ningún UPDATE debe haberse emitido
// en absoluto (ni bump ni transición de estado). El cambio al patrón
// COMMIT-domain-error-outside no debe aflojar esta garantía.
func TestCashDrawerOTPRepo_ConfirmChallenge_ActorIncorrecto_RollbackSinUpdate(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	future := time.Date(3000, 1, 1, 0, 0, 0, 0, time.UTC)

	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(strings.ToUpper(q), "FOR UPDATE") {
			// Devolvemos el challenge con requested_by_dni=EMP-OTRO.
			return fakeResult{
				Columns: otpChallengeRowColumns,
				Rows: [][]driver.Value{{
					int64(42), strings.Repeat("a", 64), "EMP-OTRO", hash,
					time.Date(2026, 10, 13, 11, 0, 0, 0, time.UTC), future,
					int64(0), int64(3),
					models.CashDrawerOTPStatusPending, nil, nil,
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
	stmts := f.statements()
	if nupd := countUpdates(stmts); nupd != 0 {
		t.Errorf("actor incorrecto NO debe emitir UPDATE alguno; se emitieron %d (stmts=%v)",
			nupd, dumpSQLs(stmts))
	}
	if got := strings.Join(f.txEvents, ","); got != "BEGIN,ROLLBACK" {
		t.Errorf("actor incorrecto debe BEGIN,ROLLBACK; eventos=%v", f.txEvents)
	}
}

// =============================================================================
// Cooldown por actor + advisory lock
// =============================================================================

// Fija el contrato "Issue respeta cooldown por actor con pg_advisory_xact_lock".
// Cuando una emisión previa cae dentro de la ventana, la Issue aborta
// SIN insertar, con un error que transporta el remanente al handler.
func TestCashDrawerOTPRepo_Issue_CooldownActivo_RollbackSinInsert(t *testing.T) {
	now := func() time.Time { return time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC) }
	// Emisión previa 1 segundo atrás → cooldown de 12s claramente violado.
	lastCreated := now().Add(-1 * time.Second)

	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(q, "MAX(created_at)") {
			return fakeResult{
				Columns: []string{"max"},
				Rows:    [][]driver.Value{{lastCreated}},
			}
		}
		return fakeResult{}
	}}
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, f))

	_, err := repo.Issue(context.Background(), IssueOptions{
		ActorDNI:    "EMP-1",
		CodeHash:    stubBcryptHash(t),
		TTL:         90 * time.Second,
		MaxAttempts: 3,
		Cooldown:    12 * time.Second,
		Now:         now,
	})
	if !errors.Is(err, ErrCashDrawerOTPCooldown) {
		t.Fatalf("Issue dentro de cooldown debe devolver ErrCashDrawerOTPCooldown; got %v", err)
	}
	// Debe exponer el remanente para construir Retry-After.
	var cdErr *CashDrawerOTPCooldownError
	if !errors.As(err, &cdErr) {
		t.Fatalf("error debe envolver *CashDrawerOTPCooldownError para transportar RetryAfter; got %T", err)
	}
	if cdErr.RetryAfter <= 0 || cdErr.RetryAfter > 12*time.Second {
		t.Errorf("RetryAfter debe estar en (0, 12s]; got %v", cdErr.RetryAfter)
	}

	stmts := f.statements()
	for _, st := range stmts {
		if strings.Contains(strings.ToUpper(st.SQL), `INSERT INTO "CASH_DRAWER_OTP_CHALLENGES"`) {
			t.Errorf("cooldown activo NO debe insertar un challenge nuevo: %s", st.SQL)
		}
	}
	if got := strings.Join(f.txEvents, ","); got != "BEGIN,ROLLBACK" {
		t.Errorf("cooldown activo debe BEGIN,ROLLBACK (sin cambios); eventos=%v", f.txEvents)
	}
}

// Fija el ORDEN estricto: advisory lock PRIMERO, consulta de última
// emisión DESPUÉS. Si alguien reordena (SELECT MAX antes del lock), dos
// pestañas del mismo actor podrían ambas leer el mismo MAX viejo y
// burlar el cooldown.
func TestCashDrawerOTPRepo_Issue_AdvisoryLockAntesDeConsultarCooldown(t *testing.T) {
	now := func() time.Time { return time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC) }

	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(q, "MAX(created_at)") {
			// Sin emisión previa → MAX NULL.
			return fakeResult{
				Columns: []string{"max"},
				Rows:    [][]driver.Value{{nil}},
			}
		}
		// INSERT en cash_drawer_otp_challenges devuelve id=1.
		if strings.Contains(strings.ToUpper(q), `INSERT INTO "CASH_DRAWER_OTP_CHALLENGES"`) {
			return fakeResult{
				Columns: []string{"id"},
				Rows:    [][]driver.Value{{int64(1)}},
			}
		}
		return fakeResult{}
	}}
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, f))

	_, err := repo.Issue(context.Background(), IssueOptions{
		ActorDNI:    "EMP-1",
		CodeHash:    stubBcryptHash(t),
		TTL:         90 * time.Second,
		MaxAttempts: 3,
		Cooldown:    12 * time.Second,
		Now:         now,
	})
	if err != nil {
		t.Fatalf("Issue sin emisión previa debe tener éxito; got %v", err)
	}

	stmts := f.statements()
	var orderIdx = struct{ lock, max, insert int }{lock: -1, max: -1, insert: -1}
	for i, st := range stmts {
		switch {
		case strings.Contains(st.SQL, "pg_advisory_xact_lock") && orderIdx.lock < 0:
			orderIdx.lock = i
		case strings.Contains(st.SQL, "MAX(created_at)") && orderIdx.max < 0:
			orderIdx.max = i
		case strings.Contains(strings.ToUpper(st.SQL), `INSERT INTO "CASH_DRAWER_OTP_CHALLENGES"`) && orderIdx.insert < 0:
			orderIdx.insert = i
		}
	}
	if orderIdx.lock < 0 || orderIdx.max < 0 || orderIdx.insert < 0 {
		t.Fatalf("faltó alguna sentencia en el flujo (lock=%d max=%d insert=%d); stmts=%v",
			orderIdx.lock, orderIdx.max, orderIdx.insert, dumpSQLs(stmts))
	}
	if !(orderIdx.lock < orderIdx.max) {
		t.Errorf("advisory lock debe ir ANTES del SELECT MAX; lock=%d max=%d (stmts=%v)",
			orderIdx.lock, orderIdx.max, dumpSQLs(stmts))
	}
	if !(orderIdx.max < orderIdx.insert) {
		t.Errorf("SELECT MAX debe ir ANTES del INSERT; max=%d insert=%d",
			orderIdx.max, orderIdx.insert)
	}

	// La clave del advisory lock debe aislar el espacio por actor.
	lockStmt := stmts[orderIdx.lock]
	if len(lockStmt.Vars) == 0 {
		t.Fatalf("advisory lock debe parametrizar la clave; vars vacío")
	}
	wantKey := "cash_drawer_otp:actor:EMP-1"
	if lockStmt.Vars[0] != wantKey {
		t.Errorf("clave de lock esperada %q; got %v", wantKey, lockStmt.Vars[0])
	}

	if got := strings.Join(f.txEvents, ","); got != "BEGIN,COMMIT" {
		t.Errorf("Issue exitoso con cooldown respetado debe BEGIN,COMMIT; eventos=%v", f.txEvents)
	}
}

// Cooldown=0 mantiene compatibilidad con cualquier caller legado que
// aún no haya adoptado la constante del dominio: el flujo no toca el
// lock ni el SELECT MAX y se comporta como antes.
func TestCashDrawerOTPRepo_Issue_SinCooldown_NoAdvisoryLockNiMaxQuery(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(strings.ToUpper(q), `INSERT INTO "CASH_DRAWER_OTP_CHALLENGES"`) {
			return fakeResult{
				Columns: []string{"id"},
				Rows:    [][]driver.Value{{int64(1)}},
			}
		}
		return fakeResult{}
	}}
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, f))

	_, err := repo.Issue(context.Background(), IssueOptions{
		ActorDNI:    "EMP-1",
		CodeHash:    stubBcryptHash(t),
		TTL:         90 * time.Second,
		MaxAttempts: 3,
		// Cooldown: 0 (default) → sin verificación.
		Now: func() time.Time { return time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("Issue con Cooldown=0: %v", err)
	}
	for _, st := range f.statements() {
		if strings.Contains(st.SQL, "pg_advisory_xact_lock") {
			t.Errorf("Cooldown=0 no debe emitir advisory lock: %s", st.SQL)
		}
		if strings.Contains(st.SQL, "MAX(created_at)") {
			t.Errorf("Cooldown=0 no debe consultar la última emisión: %s", st.SQL)
		}
	}
}

// =============================================================================
// Guardianes anti-leak extendidos
// =============================================================================

// Asegura que la variable del OTP tecleado por el usuario NUNCA entre a
// un UPDATE: en el bump de intento, el único valor que viaja es
// `attempts_used` (y opcionalmente `status`), nunca `in.OTP`.
func TestCashDrawerOTPRepo_ConfirmChallenge_UpdateNoLlevaOTPEnClaro(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	future := time.Date(3000, 1, 1, 0, 0, 0, 0, time.UTC)

	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(strings.ToUpper(q), "FOR UPDATE") {
			return buildPendingOTPRow(hash, 0, 3, future)
		}
		return fakeResult{}
	}}
	repo := NewCashDrawerOTPRepository(newFakeGormDB(t, f))

	_, _ = repo.ConfirmChallenge(context.Background(), ConfirmInput{
		ChallengeID: strings.Repeat("a", 64),
		ActorDNI:    "EMP-1",
		OTP:         "654321", // valor sensible — no debe aparecer en los binds
	})
	for _, st := range f.statements() {
		for _, v := range st.Vars {
			if s, ok := v.(string); ok && s == "654321" {
				t.Errorf("un parámetro bind lleva el OTP en claro: SQL=%q", st.SQL)
			}
		}
	}
}
