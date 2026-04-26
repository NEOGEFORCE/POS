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
	s.repo.Update(user.DNI, user)

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"dni":  user.DNI,
		"name": user.Name,
		"role": user.Role,
		"exp":  time.Now().Add(time.Hour * 12).Unix(),
	})

	tokenString, err := token.SignedString([]byte(os.Getenv("SECRET_KEY")))
	if err != nil {
		return "", nil, err
	}

	return tokenString, user, nil
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
		"dni":   user.DNI,
		"action": "password_reset",
		"exp":    time.Now().Add(time.Hour * 1).Unix(),
	})

	tokenString, err := token.SignedString([]byte(os.Getenv("SECRET_KEY")))
	if err != nil {
		return err
	}

	// 2. Construir enlace de recuperación
	// El frontend manejará esta ruta
	resetLink := fmt.Sprintf("%s/reset-password?token=%s", os.Getenv("FRONTEND_URL"), tokenString)

	// 3. Enviar correo real
	return s.emailService.SendResetPasswordEmail(user.Email, user.Name, resetLink)
}

func (s *AuthService) ResetPassword(tokenString, newPassword string) error {
	// 1. Validar token
	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		return []byte(os.Getenv("SECRET_KEY")), nil
	})

	if err != nil || !token.Valid {
		return errors.New("token inválido o expirado")
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok || claims["action"] != "password_reset" {
		return errors.New("token inválido")
	}

	dni := claims["dni"].(string)

	// 2. Buscar usuario
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
