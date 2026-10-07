package handlers

import (
	"log"
	"net/http"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
	"strings"
)

type AuthHandler struct {
	service *services.AuthService
}

func NewAuthHandler(s *services.AuthService) *AuthHandler {
	return &AuthHandler{service: s}
}

type LoginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

type ForgotPasswordRequest struct {
	Email string `json:"email" binding:"required,email"`
}

type ResetPasswordRequest struct {
	Token       string `json:"token" binding:"required"`
	NewPassword string `json:"newPassword" binding:"required,min=6"`
}

type SetupRequest struct {
	DNI      string `json:"dni" binding:"required"`
	Name     string `json:"name" binding:"required"`
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=6"`
}

// VerifyAdminRequest es el payload para el endpoint
// POST /api/auth/verify-admin. Fija el contrato con el frontend del modal
// de autorización de faltantes.
type VerifyAdminRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

func (h *AuthHandler) Login(c *gin.Context) {
	var req LoginRequest
	log.Printf("Iniciando intento de login...")
	if err := c.ShouldBindJSON(&req); err != nil {
		log.Printf("ERROR: JSON inválido recibido: %v", err)
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	// Limpiar espacios en blanco de teclados móviles
	username := strings.TrimSpace(req.Username)
	password := req.Password

	log.Printf("INFO: Intentando login para: '%s'", username)
	device := c.Request.UserAgent()
	token, user, err := h.service.Login(username, password, c.ClientIP(), device)
	if err != nil {
		log.Printf("Login failed for %s: %v", req.Username, err)
		SendError(c, http.StatusUnauthorized, ErrUnauthorized, err.Error(), err)
		return
	}

	log.Printf("¡ÉXITO! Login concedido para: %s", req.Username)
	employee := user.(*models.Employee)
	c.JSON(http.StatusOK, gin.H{
		"token": token,
		"user": gin.H{
			"name": employee.Name,
			"role": employee.Role,
			"dni":  employee.DNI,
		},
	})
}

func (h *AuthHandler) ForgotPassword(c *gin.Context) {
	var req ForgotPasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Email inválido", err)
		return
	}

	err := h.service.ForgotPassword(req.Email)
	if err != nil {
		log.Printf("ForgotPassword failed for %s: %v", req.Email, err)
		// Por seguridad, mantenemos el mensaje genérico incluso si falla la validación de rol
		c.JSON(http.StatusOK, gin.H{"message": "Si el correo corresponde a una cuenta administrativa, recibirás instrucciones pronto."})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Enlace de recuperación enviado con éxito."})
}

func (h *AuthHandler) ResetPassword(c *gin.Context) {
	var req ResetPasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Datos inválidos: "+err.Error(), err)
		return
	}

	if err := h.service.ResetPassword(req.Token, req.NewPassword); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, err.Error(), err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Contraseña actualizada correctamente."})
}

func (h *AuthHandler) Setup(c *gin.Context) {
	var req SetupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Datos inválidos: "+err.Error(), err)
		return
	}

	emp := &models.Employee{
		DNI:      req.DNI,
		Name:     req.Name,
		Email:    req.Email,
		Password: req.Password,
	}

	if err := h.service.Setup(emp); err != nil {
		SendError(c, http.StatusForbidden, ErrForbidden, err.Error(), err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Superadministrador creado correctamente. Ya puedes iniciar sesión."})
}

func (h *AuthHandler) CheckSetup(c *gin.Context) {
	needsSetup, err := h.service.CheckSetup()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Error verificando estado del sistema", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"needsSetup": needsSetup})
}

// VerifyAdmin emite un token corto de autorización de faltante en cierre
// de caja. El frontend lo consume desde el modal "autorizar faltante" y
// adjunta el token al payload del POST /dashboard/cashier-closure/close.
//
// Reemplaza al patrón anterior de "re-login con /auth/login y mandar el
// nombre del admin como string libre": aquel permitía spoof trivial del
// autorizador. Ahora el autorizador se deriva del claim descifrado
// server-side (fix P0 — 2026-10-04).
//
// Respuestas:
//
//   - 200 { token, name, dni, expiresAt } — credenciales válidas y rol admin.
//   - 400 — payload inválido o incompleto.
//   - 401 — credenciales incorrectas o rol insuficiente. Mensaje genérico
//     para no filtrar si el usuario existe.
func (h *AuthHandler) VerifyAdmin(c *gin.Context) {
	var req VerifyAdminRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}
	username := strings.TrimSpace(req.Username)
	password := req.Password
	token, claims, err := h.service.IssueClosureAuthorization(username, password)
	if err != nil {
		log.Printf("[AUTH] verify-admin rechazado para %q desde %s: %v", username, c.ClientIP(), err)
		SendError(c, http.StatusUnauthorized, ErrUnauthorized, "Credenciales inválidas o rol insuficiente para autorizar", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"token":     token,
		"name":      claims.AdminName,
		"dni":       claims.AdminDNI,
		"expiresAt": claims.ExpiresAt.UTC().Format(time.RFC3339),
	})
}
