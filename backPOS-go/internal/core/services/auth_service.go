package services

import (
	"errors"
	"os"
	"strings"
	"time"

	"backPOS-go/internal/core/ports"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

type AuthService struct {
	repo ports.AdminRepository
}

func NewAuthService(repo ports.AdminRepository) *AuthService {
	return &AuthService{repo: repo}
}

func (s *AuthService) Login(identifier string, password string) (string, interface{}, error) {
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

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"dni":  user.DNI,
		"role": user.Role,
		"exp":  time.Now().Add(time.Hour * 72).Unix(),
	})

	tokenString, err := token.SignedString([]byte(os.Getenv("SECRET_KEY")))
	if err != nil {
		return "", nil, err
	}

	return tokenString, user, nil
}

func (s *AuthService) ForgotPassword(email string) error {
	_, err := s.repo.FindByEmail(email)
	if err != nil {
		return errors.New("si el correo existe, recibirás instrucciones")
	}

	// Simulación de envío de correo
	// En un entorno real, aquí se generaría un token de reset y se enviaría un email
	// models.LogActivity("Password reset requested for: " + user.Email)
	return nil
}
