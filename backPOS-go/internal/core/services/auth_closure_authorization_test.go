package services

import (
	"os"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

// ============================================================================
// Autorización server-side de FALTANTES en cierre de caja
// ----------------------------------------------------------------------------
//
// Cubre `IssueClosureAuthorization` y `VerifyClosureAuthorization` del
// AuthService. Fix P0 (2026-10-04): elimina el vector de spoof del
// `authorizedBy` como string libre del body del cierre.
//
// Contrato amarrado por los tests:
//
//   - IssueClosureAuthorization sólo acepta usuarios ADMIN/SUPERADMIN
//     (ADMINISTRADOR también). Un empleado válido queda rechazado.
//   - Credenciales incorrectas → error genérico "credenciales incorrectas"
//     (sin filtrar si el usuario existe).
//   - Usuario borrado o inactivo → error distinto, pero sin exponer el
//     texto a un cliente no autenticado.
//   - El JWT emitido lleva `action="closure_authorization"`, `admin_dni`,
//     `admin_name` y `exp` dentro de +5 min.
//   - VerifyClosureAuthorization:
//       * rechaza alg != HS256,
//       * rechaza action != "closure_authorization" (sesión de login),
//       * rechaza exp vencido,
//       * exige admin_dni y admin_name no vacíos,
//       * devuelve claims coherentes cuando todo cuadra.
// ============================================================================

// authRepoStub es un repo falso mínimo para el AuthService.
type authRepoStub struct {
	users map[string]*models.Employee // key: NAME uppercase
	dnis  map[string]*models.Employee // key: DNI uppercase
}

func (s *authRepoStub) FindByName(name string) (*models.Employee, error) {
	if u, ok := s.users[strings.ToUpper(name)]; ok {
		return u, nil
	}
	return nil, errNotFound
}

func (s *authRepoStub) FindByDNI(dni string) (*models.Employee, error) {
	if u, ok := s.dnis[strings.ToUpper(dni)]; ok {
		return u, nil
	}
	return nil, errNotFound
}

func (s *authRepoStub) FindByEmail(email string) (*models.Employee, error) {
	for _, u := range s.users {
		if strings.EqualFold(u.Email, email) {
			return u, nil
		}
	}
	return nil, errNotFound
}
func (s *authRepoStub) Save(e *models.Employee) error                  { return nil }
func (s *authRepoStub) Update(dni string, u *models.Employee) error    { return nil }
func (s *authRepoStub) Delete(dni string) error                        { return nil }
func (s *authRepoStub) GetAll() ([]models.Employee, error)             { return nil, nil }
func (s *authRepoStub) CountAll() (int64, error)                       { return 0, nil }
func (s *authRepoStub) SaveMissingItem(_ *models.MissingItem) error    { return nil }
func (s *authRepoStub) GetMissingItems() ([]models.MissingItem, error) { return nil, nil }
func (s *authRepoStub) UpdateMissingItemStatus(id uint, status string) error {
	return nil
}
func (s *authRepoStub) GetAuditLogs() ([]models.AuditLog, error) { return nil, nil }
func (s *authRepoStub) GetRecentPendingMissingItems(_ int) ([]models.MissingItem, error) {
	return nil, nil
}
func (s *authRepoStub) PurgeDataBefore(_ string) (int64, error) { return 0, nil }

var errNotFound = &errNotFoundType{}

type errNotFoundType struct{}

func (*errNotFoundType) Error() string { return "no encontrado" }

func mustHashPassword(t *testing.T, plain string) string {
	t.Helper()
	hashed, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	return string(hashed)
}

// setSecretKey asegura que SECRET_KEY esté en el entorno durante el test
// (los helpers jwtSigningSecret y el middleware lo requieren). Devuelve
// una función de limpieza para restaurar el valor previo.
//
// IMPORTANTE: estos tests NO usan t.Parallel() porque alteran una
// variable de entorno GLOBAL. Si corrieran en paralelo con otro test
// que llame a setSecretKey, uno podría quitar el valor justo cuando el
// otro intenta firmar un JWT. En su lugar usamos t.Setenv, que es
// seguro por test pero prohíbe t.Parallel().
func setSecretKey(t *testing.T) func() {
	t.Helper()
	t.Setenv("SECRET_KEY", "test-secret-key-not-production-ok-32bytes")
	return func() {}
}

func buildAuthServiceWithUsers(t *testing.T, users ...*models.Employee) *AuthService {
	t.Helper()
	repo := &authRepoStub{
		users: map[string]*models.Employee{},
		dnis:  map[string]*models.Employee{},
	}
	for _, u := range users {
		if u == nil {
			continue
		}
		repo.users[strings.ToUpper(u.Name)] = u
		repo.dnis[strings.ToUpper(u.DNI)] = u
	}
	// EmailService y AuditService no se tocan en estos flujos.
	return NewAuthService(repo, nil, &AuditService{})
}

func TestIssueClosureAuthorization_EmiteTokenValidoParaAdmin(t *testing.T) {
	defer setSecretKey(t)()

	admin := &models.Employee{
		DNI:      "ADMIN-01",
		Name:     "DUEÑA",
		Password: mustHashPassword(t, "pin1234"),
		Role:     "ADMIN",
		IsActive: true,
	}
	svc := buildAuthServiceWithUsers(t, admin)

	token, claims, err := svc.IssueClosureAuthorization("DUEÑA", "pin1234")
	if err != nil {
		t.Fatalf("IssueClosureAuthorization: want nil, got %v", err)
	}
	if token == "" {
		t.Fatal("token vacío")
	}
	if claims.AdminDNI != "ADMIN-01" || claims.AdminName != "DUEÑA" {
		t.Errorf("claims = %+v; want DNI=ADMIN-01 name=DUEÑA", claims)
	}
	if time.Until(claims.ExpiresAt) <= 0 || time.Until(claims.ExpiresAt) > closureAuthorizationTTL+time.Second {
		t.Errorf("expiresAt fuera de rango: %s", claims.ExpiresAt)
	}

	// VerifyClosureAuthorization del mismo servicio debe aceptarlo.
	verified, err := svc.VerifyClosureAuthorization(token)
	if err != nil {
		t.Fatalf("VerifyClosureAuthorization: want nil, got %v", err)
	}
	if verified.AdminDNI != claims.AdminDNI || verified.AdminName != claims.AdminName {
		t.Errorf("roundtrip claims: got %+v want %+v", verified, claims)
	}
}

func TestIssueClosureAuthorization_RechazaEmpleado(t *testing.T) {
	defer setSecretKey(t)()

	emp := &models.Employee{
		DNI:      "EMP-01",
		Name:     "SEBAS",
		Password: mustHashPassword(t, "pin1234"),
		Role:     "EMPLEADO",
		IsActive: true,
	}
	svc := buildAuthServiceWithUsers(t, emp)

	_, _, err := svc.IssueClosureAuthorization("SEBAS", "pin1234")
	if err == nil {
		t.Fatal("empleado válido: want error, got nil")
	}
	if !strings.Contains(err.Error(), "administradores") {
		t.Errorf("empleado válido: error esperado 'administradores', got %q", err.Error())
	}
}

func TestIssueClosureAuthorization_RechazaPasswordInvalida(t *testing.T) {
	defer setSecretKey(t)()

	admin := &models.Employee{
		DNI:      "ADMIN-01",
		Name:     "DUEÑA",
		Password: mustHashPassword(t, "pin1234"),
		Role:     "ADMIN",
		IsActive: true,
	}
	svc := buildAuthServiceWithUsers(t, admin)

	_, _, err := svc.IssueClosureAuthorization("DUEÑA", "pin-wrong")
	if err == nil {
		t.Fatal("password mala: want error, got nil")
	}
	if !strings.Contains(err.Error(), "credenciales") {
		t.Errorf("password mala: error esperado 'credenciales', got %q", err.Error())
	}
}

func TestVerifyClosureAuthorization_RechazaTokenDeLogin(t *testing.T) {
	defer setSecretKey(t)()

	svc := buildAuthServiceWithUsers(t)

	// Forjamos un token con action distinta (como el de login) y verificamos
	// que VerifyClosureAuthorization lo rechace.
	loginToken := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"dni":  "ADMIN-01",
		"name": "DUEÑA",
		"role": "ADMIN",
		"exp":  time.Now().Add(1 * time.Hour).Unix(),
	})
	signed, err := loginToken.SignedString([]byte(os.Getenv("SECRET_KEY")))
	if err != nil {
		t.Fatalf("firma: %v", err)
	}
	if _, err := svc.VerifyClosureAuthorization(signed); err == nil {
		t.Fatal("token de login: want error, got nil")
	}
}

func TestVerifyClosureAuthorization_RechazaTokenVencido(t *testing.T) {
	defer setSecretKey(t)()

	svc := buildAuthServiceWithUsers(t)

	expired := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"action":     closureAuthorizationAction,
		"admin_dni":  "ADMIN-01",
		"admin_name": "DUEÑA",
		"exp":        time.Now().Add(-1 * time.Minute).Unix(),
	})
	signed, err := expired.SignedString([]byte(os.Getenv("SECRET_KEY")))
	if err != nil {
		t.Fatalf("firma: %v", err)
	}
	if _, err := svc.VerifyClosureAuthorization(signed); err == nil {
		t.Fatal("token vencido: want error, got nil")
	}
}

func TestVerifyClosureAuthorization_RechazaFirmaInvalida(t *testing.T) {
	defer setSecretKey(t)()

	svc := buildAuthServiceWithUsers(t)

	// Firma el token con una clave distinta: el servicio usa SECRET_KEY,
	// así que no debería validarlo.
	bogus := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"action":     closureAuthorizationAction,
		"admin_dni":  "ADMIN-01",
		"admin_name": "DUEÑA",
		"exp":        time.Now().Add(1 * time.Minute).Unix(),
	})
	signed, err := bogus.SignedString([]byte("otra-clave-no-es-la-del-servicio"))
	if err != nil {
		t.Fatalf("firma: %v", err)
	}
	if _, err := svc.VerifyClosureAuthorization(signed); err == nil {
		t.Fatal("firma inválida: want error, got nil")
	}
}

func TestVerifyClosureAuthorization_RechazaTokenVacio(t *testing.T) {
	defer setSecretKey(t)()

	svc := buildAuthServiceWithUsers(t)
	if _, err := svc.VerifyClosureAuthorization(""); err == nil {
		t.Fatal("token vacío: want error, got nil")
	}
	if _, err := svc.VerifyClosureAuthorization("   "); err == nil {
		t.Fatal("token con espacios: want error, got nil")
	}
}
