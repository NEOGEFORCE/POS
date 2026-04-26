package handlers

import (
	"net/http"
	"strings"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
)

type ClientHandler struct {
	service *services.ClientService
}

func NewClientHandler(s *services.ClientService) *ClientHandler {
	return &ClientHandler{service: s}
}

func (h *ClientHandler) Create(c *gin.Context) {
	var client models.Client
	if err := c.ShouldBindJSON(&client); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	// Mayúsculas y Metadatos
	client.Name = strings.ToUpper(client.Name)
	client.Address = strings.ToUpper(client.Address)
	dni, _ := c.Get("dni")
	client.CreatedByDNI = dni.(string)
	client.UpdatedByDNI = dni.(string)

	if err := h.service.CreateClient(&client); err != nil {
		errStr := strings.ToLower(err.Error())
		if strings.Contains(errStr, "1062") || strings.Contains(errStr, "unique") || 
		   strings.Contains(errStr, "duplicate") || strings.Contains(errStr, "duplicada") {
			SendError(c, http.StatusConflict, ErrDuplicateEntry, "El DNI del cliente ya existe", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al registrar cliente", err)
		return
	}
	c.JSON(http.StatusCreated, client)
}

func (h *ClientHandler) GetAll(c *gin.Context) {
	clients, err := h.service.GetAllClients()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener clientes", err)
		return
	}
	c.JSON(http.StatusOK, clients)
}

func (h *ClientHandler) GetByDNI(c *gin.Context) {
	dni := c.Param("dni")
	client, err := h.service.GetClient(dni)
	if err != nil {
		SendError(c, http.StatusNotFound, ErrNotFound, "Cliente no encontrado", err)
		return
	}
	c.JSON(http.StatusOK, client)
}

func (h *ClientHandler) Update(c *gin.Context) {
	dni := c.Param("dni")
	var client models.Client
	if err := c.ShouldBindJSON(&client); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos de cliente inválido", err)
		return
	}
	if err := h.service.UpdateClient(dni, &client); err != nil {
		errStr := strings.ToLower(err.Error())
		if strings.Contains(errStr, "not found") {
			SendError(c, http.StatusNotFound, ErrNotFound, "Cliente no encontrado", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al actualizar cliente", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Cliente actualizado correctamente"})
}

func (h *ClientHandler) Delete(c *gin.Context) {
	dni := c.Param("dni")
	if err := h.service.DeleteClient(dni); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			SendError(c, http.StatusNotFound, ErrNotFound, "Cliente no encontrado", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al eliminar cliente", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Cliente eliminado correctamente"})
}

func (h *ClientHandler) PayCredit(c *gin.Context) {
	var payment models.CreditPayment
	if err := c.ShouldBindJSON(&payment); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de pago inválido", err)
		return
	}

	// Recuperación segura del DNI del empleado
	dniVal, exists := c.Get("dni")
	if !exists {
		SendError(c, http.StatusUnauthorized, ErrUnauthorized, "Usuario no autenticado", nil)
		return
	}
	dniStr, ok := dniVal.(string)
	if !ok {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Error interno de autenticación", nil)
		return
	}
	payment.EmployeeDNI = dniStr

	updatedClient, err := h.service.PayCredit(&payment)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al registrar pago de crédito", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "Abono registrado correctamente",
		"client":  updatedClient,
	})
}
