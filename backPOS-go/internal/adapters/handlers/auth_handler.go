package handlers

import (
	"log"
	"net/http"

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

func (h *AuthHandler) Login(c *gin.Context) {
	var req LoginRequest
	log.Printf("Iniciando intento de login...")
	if err := c.ShouldBindJSON(&req); err != nil {
		log.Printf("ERROR: JSON inválido recibido: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Formato de datos inválido"})
		return
	}

	// Limpiar espacios en blanco de teclados móviles
	username := strings.TrimSpace(req.Username)
	password := req.Password

	log.Printf("INFO: Intentando login para: '%s'", username)
	token, user, err := h.service.Login(username, password)
	if err != nil {
		log.Printf("Login failed for %s: %v", req.Username, err)
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
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
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	err := h.service.ForgotPassword(req.Email)
	if err != nil {
		// Por seguridad, no revelamos si el correo existe
		c.JSON(http.StatusOK, gin.H{"message": "Si el correo está registrado, recibirás instrucciones pronto."})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Si el correo está registrado, recibirás instrucciones pronto."})
}
