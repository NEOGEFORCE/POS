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
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Mayúsculas y Metadatos
	client.Name = strings.ToUpper(client.Name)
	client.Address = strings.ToUpper(client.Address)
	dni, _ := c.Get("dni")
	client.CreatedByDNI = dni.(string)
	client.UpdatedByDNI = dni.(string)

	if err := h.service.CreateClient(&client); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, client)
}

func (h *ClientHandler) GetAll(c *gin.Context) {
	clients, err := h.service.GetAllClients()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, clients)
}

func (h *ClientHandler) GetByDNI(c *gin.Context) {
	dni := c.Param("dni")
	client, err := h.service.GetClient(dni)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Cliente no encontrado"})
		return
	}
	c.JSON(http.StatusOK, client)
}

func (h *ClientHandler) Update(c *gin.Context) {
	dni := c.Param("dni")
	var client models.Client
	if err := c.ShouldBindJSON(&client); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.service.UpdateClient(dni, &client); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Cliente actualizado correctamente"})
}

func (h *ClientHandler) Delete(c *gin.Context) {
	dni := c.Param("dni")
	if err := h.service.DeleteClient(dni); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Cliente eliminado correctamente"})
}

func (h *ClientHandler) PayCredit(c *gin.Context) {
	var payment models.CreditPayment
	if err := c.ShouldBindJSON(&payment); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	dni, _ := c.Get("dni")
	payment.EmployeeDNI = dni.(string)

	if err := h.service.PayCredit(&payment); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Abono registrado correctamente", "clientDni": payment.ClientDNI})
}
