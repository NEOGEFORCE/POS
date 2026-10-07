package services

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

func jwtSigningSecret() ([]byte, error) {
	secret := strings.TrimSpace(os.Getenv("SECRET_KEY"))
	if secret == "" {
		return nil, errors.New("SECRET_KEY no está configurada")
	}
	return []byte(secret), nil
}

type AuthService struct {
	repo         ports.AdminRepository
	emailService *EmailService
	auditService *AuditService
}

func NewAuthService(repo ports.AdminRepository, emailService *EmailService, auditService *AuditService) *AuthService {
	return &AuthService{
		repo:         repo,
		emailService: emailService,
		auditService: auditService,
	}
}

func (s *AuthService) Login(identifier string, password string, ip string, device string) (string, interface{}, error) {
	// Normalizar identificador para búsqueda (El sistema guarda nombres y DNI en mayúsculas)
	identifier = strings.ToUpper(strings.TrimSpace(identifier))

	// 1. Intentar buscar por Nombre
	user, err := s.repo.FindByName(identifier)
	if err != nil {
		// 2. Si no lo encuentra por nombre, intentar buscar por DNI
		user, err = s.repo.FindByDNI(identifier)
		if err != nil {
			return "", nil, errors.New("credenciales incorrectas")
		}
	}

	err = bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(password))
	if err != nil {
		return "", nil, errors.New("credenciales incorrectas")
	}

	// 3. Verificar si el usuario ha sido borrado (Soft Delete)
	if user.DeletedAt.Valid {
		s.auditService.Log(user.DNI, user.Name, "LOGIN_BLOCKED", "AUTH", "Intento de acceso en cuenta eliminada", "Intento de inicio de sesión en una cuenta que ha sido eliminada del sistema.", "{}", ip, device, true)
		return "", nil, errors.New("tu cuenta ha sido removida del sistema. contacta al administrador")
	}

	// 4. Verificar si el usuario está activo
	if !user.IsActive {
		s.auditService.Log(user.DNI, user.Name, "LOGIN_BLOCKED", "AUTH", "Intento de acceso en cuenta inactiva", "Intento de inicio de sesión en una cuenta desactivada.", "{}", ip, device, true)
		return "", nil, errors.New("tu cuenta ha sido desactivada. contacta al administrador")
	}

	s.auditService.Log(user.DNI, user.Name, "LOGIN_SUCCESS", "AUTH", fmt.Sprintf("Acceso exitoso como %s", user.Role), fmt.Sprintf("Inicio de sesión exitoso desde %s", device), "{}", ip, device, false)

	// Actualizar fecha de última conexión
	now := time.Now()
	user.LastLogin = &now
	if err := s.repo.Update(user.DNI, user); err != nil {
		return "", nil, err
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"dni":  user.DNI,
		"name": user.Name,
		"role": user.Role,
		"exp":  time.Now().Add(time.Hour * 12).Unix(),
	})

	secret, err := jwtSigningSecret()
	if err != nil {
		return "", nil, err
	}
	tokenString, err := token.SignedString(secret)
	if err != nil {
		return "", nil, err
	}

	return tokenString, user, nil
}

func (s *AuthService) VerifyPIN(dni, pin string) error {
	user, err := s.repo.FindByDNI(dni)
	if err != nil {
		return errors.New("usuario no encontrado")
	}
	err = bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(pin))
	if err != nil {
		return errors.New("PIN incorrecto")
	}
	return nil
}

func (s *AuthService) ForgotPassword(email string) error {
	user, err := s.repo.FindByEmail(email)
	if err != nil {
		return err
	}

	// VALIDACIÓN DE SEGURIDAD: Solo Administradores pueden recuperar por correo.
	// Superadmins y Empleados están bloqueados.
	role := strings.ToUpper(user.Role)
	if role != "ADMINISTRADOR" && role != "ADMIN" {
		return fmt.Errorf("recuperación no permitida para el rol: %s", role)
	}

	// 1. Generar token de recuperación (JWT de corta duración)
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"dni":    user.DNI,
		"action": "password_reset",
		"exp":    time.Now().Add(time.Hour * 1).Unix(),
	})

	secret, err := jwtSigningSecret()
	if err != nil {
		return err
	}
	tokenString, err := token.SignedString(secret)
	if err != nil {
		return err
	}

	// 2. Construir enlace de recuperación
	// El frontend manejará esta ruta
	resetLink := fmt.Sprintf("%s/reset-password?token=%s", os.Getenv("FRONTEND_URL"), tokenString)

	// 3. Enviar correo real en segundo plano
	go func() {
		defer func() { recover() }()
		_ = s.emailService.SendResetPasswordEmail(user.Email, user.Name, resetLink)
	}()

	return nil
}

func (s *AuthService) ResetPassword(tokenString, newPassword string) error {
	secret, err := jwtSigningSecret()
	if err != nil {
		return err
	}
	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		if token.Method.Alg() != jwt.SigningMethodHS256.Alg() {
			return nil, fmt.Errorf("algoritmo JWT no permitido: %s", token.Method.Alg())
		}
		return secret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	if err != nil || !token.Valid {
		return errors.New("token inválido o expirado")
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return errors.New("token inválido")
	}
	action, actionOK := claims["action"].(string)
	dni, dniOK := claims["dni"].(string)
	if !actionOK || action != "password_reset" || !dniOK || strings.TrimSpace(dni) == "" {
		return errors.New("token inválido")
	}

	user, err := s.repo.FindByDNI(dni)
	if err != nil {
		return err
	}

	// 3. Hashear nueva contraseña
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	// 4. Actualizar usuario
	user.Password = string(hashedPassword)
	err = s.repo.Update(user.DNI, user)
	if err == nil {
		s.auditService.Log(dni, user.Name, "PASSWORD_RESET_SELF", "AUTH", "El usuario cambió su propia contraseña vía email", "Cambio de contraseña exitoso mediante enlace de recuperación.", "{}", "N/A", "N/A", true)
	}
	return err
}

func (s *AuthService) Setup(employee *models.Employee) error {
	// 1. Validar que la BD esté vacía
	count, err := s.repo.CountAll()
	if err != nil {
		return err
	}
	if count > 0 {
		return errors.New("el sistema ya ha sido configurado")
	}

	// 2. Hashear contraseña
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(employee.Password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	employee.Password = string(hashedPassword)
	employee.Role = "SUPERADMIN" // Forzar rol superadmin en el primer registro

	// 3. Guardar Superadmin
	if err := s.repo.Save(employee); err != nil {
		return err
	}

	// 4. Seed base data (Consumer Final)
	repositories.SeedClient(repositories.DB, employee.DNI)

	return nil
}

func (s *AuthService) CheckSetup() (bool, error) {
	count, err := s.repo.CountAll()
	if err != nil {
		// Si hay un error (ej. DB no lista o error de conexión),
		// devolvemos falso para evitar redirecciones erróneas a /setup.
		// El frontend caerá por defecto en /login.
		return false, nil
	}
	// Solo necesita setup si confirmamos exitosamente que el conteo es 0
	return count == 0, nil
}
func (s *AuthService) VerifyAdminPIN(pin string) error {
	allUsers, err := s.repo.GetAll()
	if err != nil {
		return err
	}
	for _, user := range allUsers {
		role := strings.ToUpper(user.Role)
		if role == "ADMIN" || role == "SUPERADMIN" || role == "ADMINISTRADOR" {
			if err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(pin)); err == nil {
				return nil
			}
		}
	}
	return errors.New("PIN de administrador incorrecto")
}

// ============================================================================
// Autorización server-side de FALTANTES en cierre de caja (fix P0 — 2026-10-04)
// ============================================================================
//
// Antes el frontend validaba las credenciales del admin con un `/auth/login`
// local y luego mandaba el nombre del autorizador como string libre en el
// payload del cierre. El backend lo copiaba a `AuthorizedBy` sin verificar
// nada, así que un empleado podía:
//
//     POST /dashboard/cashier-closure/close
//     {"authorizedBy": "ADMIN", ...difference: -500000...}
//
// y cerrar un faltante grande sin que ningún admin firmara nunca. La
// autenticación del modal era puramente estética.
//
// Nueva arquitectura:
//
//  1. El frontend llama `POST /api/auth/verify-admin` con usuario y contraseña
//     del admin que autoriza. El endpoint valida credenciales, exige rol
//     admin/superadmin y devuelve un JWT corto (5 min) con
//     `action="closure_authorization"`, `admin_dni` y `admin_name`.
//
//  2. El payload del cierre incluye `authorizationToken: "<jwt>"`.
//
//  3. `SaveClosure`, tras recalcular `metrics.Difference`, exige el token si
//     hay faltante y el actor NO es admin. El autorizador queda derivado del
//     claim descifrado — jamás del string libre del body.
//
// Mismo contrato de firma que el resto del sistema: HS256 con SECRET_KEY, para
// que un token forjado sin la clave real sea invalidable por el validador JWT
// del middleware. El claim NO sustituye la sesión del actor: el middleware
// `AuthMiddleware` sigue aplicando antes de que `SaveClosure` corra.

const (
	closureAuthorizationAction = "closure_authorization"
	closureAuthorizationTTL    = 5 * time.Minute
)

// ClosureAuthorizationClaims es el resultado de verificar un token de
// autorización de faltante.
type ClosureAuthorizationClaims struct {
	AdminDNI  string
	AdminName string
	ExpiresAt time.Time
}

// IssueClosureAuthorization valida identificador+contraseña, exige rol
// admin/superadmin y devuelve un JWT corto que firma la autorización de
// faltante. Devuelve también el nombre del admin para que el frontend lo
// muestre en pantalla; el servidor no persistirá ese nombre: el autorizador
// final sale del claim descifrado en `SaveClosure`.
func (s *AuthService) IssueClosureAuthorization(identifier, password string) (token string, claims ClosureAuthorizationClaims, err error) {
	identifier = strings.ToUpper(strings.TrimSpace(identifier))
	if identifier == "" || password == "" {
		return "", ClosureAuthorizationClaims{}, errors.New("credenciales incorrectas")
	}

	user, lookupErr := s.repo.FindByName(identifier)
	if lookupErr != nil {
		user, lookupErr = s.repo.FindByDNI(identifier)
		if lookupErr != nil {
			return "", ClosureAuthorizationClaims{}, errors.New("credenciales incorrectas")
		}
	}

	if bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(password)) != nil {
		return "", ClosureAuthorizationClaims{}, errors.New("credenciales incorrectas")
	}
	if user.DeletedAt.Valid {
		return "", ClosureAuthorizationClaims{}, errors.New("usuario removido")
	}
	if !user.IsActive {
		return "", ClosureAuthorizationClaims{}, errors.New("usuario desactivado")
	}

	role := strings.ToUpper(strings.TrimSpace(user.Role))
	if role != "ADMIN" && role != "SUPERADMIN" && role != "ADMINISTRADOR" {
		return "", ClosureAuthorizationClaims{}, errors.New("sólo administradores pueden autorizar faltantes")
	}

	expiresAt := time.Now().Add(closureAuthorizationTTL)
	jwtToken := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"action":     closureAuthorizationAction,
		"admin_dni":  user.DNI,
		"admin_name": user.Name,
		"exp":        expiresAt.Unix(),
	})

	secret, err := jwtSigningSecret()
	if err != nil {
		return "", ClosureAuthorizationClaims{}, err
	}
	tokenString, err := jwtToken.SignedString(secret)
	if err != nil {
		return "", ClosureAuthorizationClaims{}, err
	}
	return tokenString, ClosureAuthorizationClaims{
		AdminDNI:  user.DNI,
		AdminName: user.Name,
		ExpiresAt: expiresAt,
	}, nil
}

// VerifyClosureAuthorization descifra el token emitido por
// IssueClosureAuthorization y verifica que:
//
//   - HS256 con la SECRET_KEY del sistema.
//   - action == "closure_authorization" (no se acepta un token general de
//     sesión disfrazado de autorizador).
//   - exp vigente (TTL 5 min).
//   - admin_dni y admin_name presentes.
//
// Devuelve el DNI y nombre del admin que firmó la autorización. Ese nombre
// es el único que `SaveClosure` persiste en `AuthorizedBy`.
func (s *AuthService) VerifyClosureAuthorization(tokenString string) (ClosureAuthorizationClaims, error) {
	tokenString = strings.TrimSpace(tokenString)
	if tokenString == "" {
		return ClosureAuthorizationClaims{}, errors.New("token de autorización vacío")
	}
	secret, err := jwtSigningSecret()
	if err != nil {
		return ClosureAuthorizationClaims{}, err
	}
	parsed, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		if token.Method.Alg() != jwt.SigningMethodHS256.Alg() {
			return nil, fmt.Errorf("algoritmo JWT no permitido: %s", token.Method.Alg())
		}
		return secret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	if err != nil || !parsed.Valid {
		return ClosureAuthorizationClaims{}, errors.New("token de autorización inválido o expirado")
	}
	mapClaims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return ClosureAuthorizationClaims{}, errors.New("token de autorización inválido")
	}
	action, _ := mapClaims["action"].(string)
	if action != closureAuthorizationAction {
		return ClosureAuthorizationClaims{}, errors.New("token no autoriza cierre")
	}
	adminDNI, _ := mapClaims["admin_dni"].(string)
	adminName, _ := mapClaims["admin_name"].(string)
	if strings.TrimSpace(adminDNI) == "" || strings.TrimSpace(adminName) == "" {
		return ClosureAuthorizationClaims{}, errors.New("token sin identidad de administrador")
	}
	var expAt time.Time
	switch v := mapClaims["exp"].(type) {
	case float64:
		expAt = time.Unix(int64(v), 0)
	case int64:
		expAt = time.Unix(v, 0)
	}
	return ClosureAuthorizationClaims{
		AdminDNI:  adminDNI,
		AdminName: adminName,
		ExpiresAt: expAt,
	}, nil
}
