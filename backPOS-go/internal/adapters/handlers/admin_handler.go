package handlers

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
)

type AdminHandler struct {
	service *services.AdminService
}

func NewAdminHandler(s *services.AdminService) *AdminHandler {
	return &AdminHandler{service: s}
}

// Estructura para recibir datos del frontend (incluyendo password que el modelo base ignora)
type RegisterEmployeeRequest struct {
	DNI      string `json:"dni"`
	Name     string `json:"name" binding:"required"`
	Email    string `json:"email"`
	Password string `json:"password"`
	Role     string `json:"role" binding:"required"`
}

func (h *AdminHandler) CreateEmployee(c *gin.Context) {
	var req RegisterEmployeeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Formato de datos inválido"})
		return
	}

	emp := models.Employee{
		DNI:      req.DNI,
		Name:     strings.ToUpper(req.Name),
		Email:    strings.ToUpper(req.Email),
		Password: req.Password,
		Role:     strings.ToUpper(req.Role),
	}

	if emp.DNI == "" {
		emp.DNI = fmt.Sprintf("EMP-%d", time.Now().Unix())
	} else {
		emp.DNI = strings.ToUpper(emp.DNI)
	}

	if err := h.service.CreateEmployee(&emp); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, emp)
}

func (h *AdminHandler) GetAllEmployees(c *gin.Context) {
	emps, err := h.service.GetAllEmployees()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, emps)
}

func (h *AdminHandler) UpdateEmployee(c *gin.Context) {
	dni := c.Param("dni")
	var req RegisterEmployeeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Formato de datos inválido"})
		return
	}
	
	// Mapeo manual para asegurar normalización
	emp := models.Employee{
		DNI:      dni,
		Name:     strings.ToUpper(req.Name),
		Email:    strings.ToUpper(req.Email),
		Password: req.Password, // Si viene vacía, el service/repo no la tocará
		Role:     strings.ToUpper(req.Role),
	}

	if err := h.service.UpdateEmployee(dni, &emp); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Empleado actualizado correctamente"})
}

func (h *AdminHandler) DeleteEmployee(c *gin.Context) {
	dni := c.Param("dni")
	if err := h.service.DeleteEmployee(dni); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Empleado eliminado correctamente"})
}
