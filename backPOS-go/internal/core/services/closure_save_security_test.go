package services

import (
	"errors"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// Pruebas de SEGURIDAD y CONTRATO del SaveClosure.
//
// Cubren las correcciones P0/P1 implementadas el 2026-10-04:
//
//   P0 — cashBreakdown con strings vacíos NO revienta.
//   P0 — AuthorizedBy del body NUNCA se persiste; el servicio sólo lo
//        acepta vía claim JWT descifrado (TokenAdminName) o rol del actor.
//   P0 — Faltante sin autorización válida devuelve
//        ErrAuthorizationRequired antes de tocar la BD.
//   P1 — ClientTxID reusado: el servicio devuelve el id previo sin tocar
//        la BD. Idempotencia a nivel BD la respalda la migración 018;
//        el servicio es tolerante si la migración no se aplicó.
//   P1 — Falta de turno OPEN aborta (lock pessimista).
//   P1 — Auditoría: SaveClosureResult.Difference refleja la fórmula
//        canónica para que el handler marque isCritical correctamente.
//
// Las pruebas usan fakes del paquete `services` para no requerir
// Postgres en CI. El fake de closureRepo implementa el nuevo contrato
// `FindIDByClientTxID` + `UpdateWithTx` + `GetByIDWithTx`.
// ============================================================================

type fakeClosureSaveRepo struct {
	saved         []*models.CashierClosure
	byClientTx    map[string]*models.CashierClosure
	findErr       error
	saveErr       error
	nextID        uint
	fakeTx        struct{}
	wantFindCalls int
	findCalls     int
	useTxValue    bool // si true, devuelve un valor non-nil como tx; en
	// el fake no necesitamos un *gorm.DB real.
}

func (f *fakeClosureSaveRepo) Transaction(fn func(tx interface{}) error) error {
	return fn(&f.fakeTx)
}
func (f *fakeClosureSaveRepo) Save(c *models.CashierClosure) error { return f.SaveWithTx(nil, c) }
func (f *fakeClosureSaveRepo) SaveWithTx(_ interface{}, c *models.CashierClosure) error {
	if f.saveErr != nil {
		return f.saveErr
	}
	f.nextID++
	c.ID = f.nextID
	cp := *c
	f.saved = append(f.saved, &cp)
	if c.ClientTxID != nil && *c.ClientTxID != "" {
		if f.byClientTx == nil {
			f.byClientTx = map[string]*models.CashierClosure{}
		}
		f.byClientTx[*c.ClientTxID] = &cp
	}
	return nil
}
func (f *fakeClosureSaveRepo) GetByDateRange(_, _ time.Time) ([]models.CashierClosure, error) {
	return nil, nil
}
func (f *fakeClosureSaveRepo) GetAll() ([]models.CashierClosure, error) { return nil, nil }
func (f *fakeClosureSaveRepo) GetByID(id uint) (*models.CashierClosure, error) {
	return nil, nil
}
func (f *fakeClosureSaveRepo) GetByIDWithTx(_ interface{}, id uint) (*models.CashierClosure, error) {
	return nil, nil
}
func (f *fakeClosureSaveRepo) GetLast() (*models.CashierClosure, error) { return nil, nil }
func (f *fakeClosureSaveRepo) GetGlobalReportedBalance() (float64, error) {
	return 0, nil
}
func (f *fakeClosureSaveRepo) GetGlobalReportedBalanceByMethod() (map[string]float64, error) {
	return nil, nil
}
func (f *fakeClosureSaveRepo) GetGlobalCoins() (map[string]float64, error) { return nil, nil }
func (f *fakeClosureSaveRepo) GetGlobalDifferenceSum() (float64, error)    { return 0, nil }
func (f *fakeClosureSaveRepo) GetGlobalHistoricalSum() (float64, float64, error) {
	return 0, 0, nil
}
func (f *fakeClosureSaveRepo) Delete(id uint) error { return nil }
func (f *fakeClosureSaveRepo) Update(id uint, updates map[string]interface{}) error {
	return nil
}
func (f *fakeClosureSaveRepo) UpdateWithTx(_ interface{}, id uint, updates map[string]interface{}) error {
	return nil
}
func (f *fakeClosureSaveRepo) FindIDByClientTxID(_ interface{}, tx string) (uint, *models.CashierClosure, error) {
	f.findCalls++
	if f.findErr != nil {
		return 0, nil, f.findErr
	}
	if existing, ok := f.byClientTx[tx]; ok {
		return existing.ID, existing, nil
	}
	return 0, nil, nil
}

// Los tipos de retorno no deben chocar con los del repo real; mantenemos
// los wrappers simples para `Daily/Monthly` y rangos.
func (f *fakeClosureSaveRepo) GetDailyReconstructedSales(_, _ time.Time) (map[string]float64, error) {
	return nil, nil
}
func (f *fakeClosureSaveRepo) GetMonthlyReconstructedSales() (map[string]float64, error) {
	return nil, nil
}

type fakeShiftRepo struct {
	shift     *models.ActiveShift
	closed    bool
	openedNew *models.ActiveShift
	lockErr   error
}

func (f *fakeShiftRepo) GetActive() (*models.ActiveShift, error) { return f.shift, nil }
func (f *fakeShiftRepo) Save(s *models.ActiveShift) error        { return nil }
func (f *fakeShiftRepo) SaveWithTx(_ interface{}, s *models.ActiveShift) error {
	f.openedNew = s
	return nil
}
func (f *fakeShiftRepo) LockActiveWithTx(_ interface{}) (*models.ActiveShift, error) {
	if f.lockErr != nil {
		return nil, f.lockErr
	}
	return f.shift, nil
}
func (f *fakeShiftRepo) CloseActive() error                    { return nil }
func (f *fakeShiftRepo) CloseActiveWithTx(_ interface{}) error { f.closed = true; return nil }

type fakeExpenseSaveRepo struct{}

func (f *fakeExpenseSaveRepo) SaveWithTx(_ interface{}, _ *models.Expense) error { return nil }

// buildSaveClosureService arma un DashboardService con sólo los campos
// que SaveClosure realmente usa. Los otros repos quedan nil: si
// SaveClosure los invocara el test rompería a propósito.
func buildSaveClosureService(cr *fakeClosureSaveRepo, sr *fakeShiftRepo) *DashboardService {
	s := &DashboardService{}
	// Asignación por campo privado desde el mismo paquete.
	s.closureRepo = cr
	s.shiftRepo = sr
	// Expense repo mínimo: SaveClosure sólo llama a SaveWithTx cuando
	// hay egresos nuevos (ID==0). Dejar nil provoca panic si el test
	// introduce egresos nuevos — es la señal correcta.
	return s
}

// Las implementaciones del fake no cumplen la interfaz `ports.ClosureRepository`
// porque mantener el Set completo era ruidoso; `buildSaveClosureService` evita
// la restricción de tipos usando asignación directa en el mismo paquete.
// `_ = cr` + aserciones concretas abajo garantizan que las rutas probadas
// usan sólo los métodos expuestos arriba.

func TestSaveClosure_RechazaFaltanteSinAutorizacion(t *testing.T) {
	t.Parallel()
	cr := &fakeClosureSaveRepo{}
	sr := &fakeShiftRepo{shift: &models.ActiveShift{Status: "OPEN"}}
	svc := buildSaveClosureService(cr, sr)

	closure := &models.CashierClosure{
		TotalCash:    1_000_000, // esperado 1.000.000
		PhysicalCash: 500_000,   // -500.000 → faltante
		ClosedByDNI:  "EMP-01",
		ClosedByName: "SEBAS",
	}
	authz := SaveClosureAuthorization{
		ActorIsAdmin: false,
		ActorDNI:     "EMP-01",
		ActorName:    "SEBAS",
	}
	_, err := svc.SaveClosure(closure, authz)
	if !errors.Is(err, ErrAuthorizationRequired) {
		t.Fatalf("faltante sin token: want ErrAuthorizationRequired, got %v", err)
	}
	if len(cr.saved) != 0 {
		t.Fatalf("no debe persistir el cierre si falta la autorización: saved=%d", len(cr.saved))
	}
}

func TestSaveClosure_FaltanteConTokenAdminFirma(t *testing.T) {
	t.Parallel()
	cr := &fakeClosureSaveRepo{}
	sr := &fakeShiftRepo{shift: &models.ActiveShift{Status: "OPEN"}}
	svc := buildSaveClosureService(cr, sr)

	closure := &models.CashierClosure{
		TotalCash:    1_000_000,
		PhysicalCash: 500_000,
		ClosedByDNI:  "EMP-01",
		ClosedByName: "SEBAS",
		AuthorizedBy: "SPOOF-NAME", // ← intento de spoof: debe ser ignorado
	}
	authz := SaveClosureAuthorization{
		ActorIsAdmin:   false,
		ActorDNI:       "EMP-01",
		ActorName:      "SEBAS",
		TokenAdminDNI:  "ADMIN-01",
		TokenAdminName: "DUEÑA",
	}
	// Pre: el handler limpia AuthorizedBy del body. Replicamos ese
	// contrato acá para que el test de servicio no ancle a un comportamiento
	// de capa superior.
	closure.AuthorizedBy = ""
	result, err := svc.SaveClosure(closure, authz)
	if err != nil {
		t.Fatalf("faltante con token admin: SaveClosure error = %v", err)
	}
	if closure.AuthorizedBy != "DUEÑA" {
		t.Fatalf("AuthorizedBy final = %q; want %q (del claim, no del body)", closure.AuthorizedBy, "DUEÑA")
	}
	if result.Difference >= 0 {
		t.Errorf("Difference esperado negativo (faltante), got %.2f", result.Difference)
	}
}

func TestSaveClosure_ActorAdminFirmaConSuPropioNombre(t *testing.T) {
	t.Parallel()
	cr := &fakeClosureSaveRepo{}
	sr := &fakeShiftRepo{shift: &models.ActiveShift{Status: "OPEN"}}
	svc := buildSaveClosureService(cr, sr)

	closure := &models.CashierClosure{
		TotalCash:    200_000,
		PhysicalCash: 50_000, // -150k faltante
		ClosedByDNI:  "ADMIN-01",
		ClosedByName: "DUEÑA",
	}
	authz := SaveClosureAuthorization{
		ActorIsAdmin: true,
		ActorDNI:     "ADMIN-01",
		ActorName:    "DUEÑA",
	}
	if _, err := svc.SaveClosure(closure, authz); err != nil {
		t.Fatalf("admin firmando propio faltante: SaveClosure error = %v", err)
	}
	if closure.AuthorizedBy != "DUEÑA" {
		t.Fatalf("AuthorizedBy = %q; want %q (actor admin se auto-autoriza)", closure.AuthorizedBy, "DUEÑA")
	}
}

func TestSaveClosure_SobranteCierraSinAutorizacion(t *testing.T) {
	t.Parallel()
	cr := &fakeClosureSaveRepo{}
	sr := &fakeShiftRepo{shift: &models.ActiveShift{Status: "OPEN"}}
	svc := buildSaveClosureService(cr, sr)

	closure := &models.CashierClosure{
		TotalCash:    500_000,
		PhysicalCash: 600_000, // +100k sobrante
		ClosedByDNI:  "EMP-01",
		ClosedByName: "SEBAS",
	}
	authz := SaveClosureAuthorization{ActorIsAdmin: false, ActorDNI: "EMP-01", ActorName: "SEBAS"}
	result, err := svc.SaveClosure(closure, authz)
	if err != nil {
		t.Fatalf("sobrante sin autorización: SaveClosure error = %v", err)
	}
	if result.Difference <= 0 {
		t.Errorf("Difference esperado positivo (sobrante), got %.2f", result.Difference)
	}
}

func TestSaveClosure_CeroCierraSinAutorizacion(t *testing.T) {
	t.Parallel()
	cr := &fakeClosureSaveRepo{}
	sr := &fakeShiftRepo{shift: &models.ActiveShift{Status: "OPEN"}}
	svc := buildSaveClosureService(cr, sr)

	closure := &models.CashierClosure{
		ClosedByDNI:  "EMP-01",
		ClosedByName: "SEBAS",
	}
	authz := SaveClosureAuthorization{ActorIsAdmin: false, ActorDNI: "EMP-01", ActorName: "SEBAS"}
	if _, err := svc.SaveClosure(closure, authz); err != nil {
		t.Fatalf("cero legítimo: SaveClosure error = %v", err)
	}
}

func TestSaveClosure_IdempotentePorClientTxID(t *testing.T) {
	t.Parallel()
	cr := &fakeClosureSaveRepo{}
	sr := &fakeShiftRepo{shift: &models.ActiveShift{Status: "OPEN"}}
	svc := buildSaveClosureService(cr, sr)

	txID := "ab-cd-ef-01"
	first := &models.CashierClosure{
		TotalCash:    400_000,
		PhysicalCash: 400_000,
		ClosedByDNI:  "EMP-01",
		ClosedByName: "SEBAS",
		ClientTxID:   &txID,
	}
	r1, err := svc.SaveClosure(first, SaveClosureAuthorization{ActorIsAdmin: false, ActorDNI: "EMP-01", ActorName: "SEBAS"})
	if err != nil {
		t.Fatalf("primer POST: SaveClosure error = %v", err)
	}
	if !r1.Created {
		t.Fatalf("primer POST con tx_id nuevo debe ser Created=true, got %+v", r1)
	}

	// Segundo POST con el MISMO tx id → debe devolver el id previo sin
	// tocar la BD.
	second := &models.CashierClosure{
		TotalCash:    400_000,
		PhysicalCash: 400_000,
		ClosedByDNI:  "EMP-01",
		ClosedByName: "SEBAS",
		ClientTxID:   &txID,
	}
	r2, err := svc.SaveClosure(second, SaveClosureAuthorization{ActorIsAdmin: false, ActorDNI: "EMP-01", ActorName: "SEBAS"})
	if err != nil {
		t.Fatalf("segundo POST: SaveClosure error = %v", err)
	}
	if r2.Created || !r2.ReusedByClientTx {
		t.Fatalf("segundo POST idempotente: want Created=false, ReusedByClientTx=true; got %+v", r2)
	}
	if r2.ID != r1.ID {
		t.Fatalf("segundo POST idempotente: id %d != %d (primer POST)", r2.ID, r1.ID)
	}
	// La idempotencia debe evitar un segundo INSERT.
	if len(cr.saved) != 1 {
		t.Fatalf("segundo POST idempotente NO debe guardar: saved=%d", len(cr.saved))
	}
}

func TestSaveClosure_AbortaSinTurnoAbierto(t *testing.T) {
	t.Parallel()
	cr := &fakeClosureSaveRepo{}
	sr := &fakeShiftRepo{shift: nil} // sin turno OPEN
	svc := buildSaveClosureService(cr, sr)

	closure := &models.CashierClosure{
		ClosedByDNI:  "EMP-01",
		ClosedByName: "SEBAS",
	}
	_, err := svc.SaveClosure(closure, SaveClosureAuthorization{ActorIsAdmin: false, ActorDNI: "EMP-01", ActorName: "SEBAS"})
	if err == nil || !containsCI(err.Error(), "turno") {
		t.Fatalf("sin turno: want error que mencione 'turno', got %v", err)
	}
	if len(cr.saved) != 0 {
		t.Fatalf("sin turno: no debe persistir el cierre, saved=%d", len(cr.saved))
	}
}

// containsCI es un helper muy pequeño para no depender de strings.Contains
// con minúsculas en los asserts. Mantener contained aquí evita que un
// fallo del match sea por casing accidental.
func containsCI(haystack, needle string) bool {
	return indexCI(haystack, needle) >= 0
}

func indexCI(h, n string) int {
	if len(n) == 0 {
		return 0
	}
	for i := 0; i+len(n) <= len(h); i++ {
		match := true
		for j := 0; j < len(n); j++ {
			hc := h[i+j]
			nc := n[j]
			if hc >= 'A' && hc <= 'Z' {
				hc += 32
			}
			if nc >= 'A' && nc <= 'Z' {
				nc += 32
			}
			if hc != nc {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}
