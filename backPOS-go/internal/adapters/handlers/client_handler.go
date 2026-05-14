package handlers

import (
	"fmt"
	"net/http"
	"strings"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/core/services"
	"backPOS-go/internal/infrastructure/sse"
	"github.com/gin-gonic/gin"
)

type ClientHandler struct {
	service      *services.ClientService
	saleRepo     ports.SaleRepository
	auditService *services.AuditService
}

func NewClientHandler(s *services.ClientService, sr ports.SaleRepository, a *services.AuditService) *ClientHandler {
	return &ClientHandler{service: s, saleRepo: sr, auditService: a}
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

	// AVISO GLOBAL: Nuevo cliente
	go sse.GetSSEService().BroadcastCustomerUpdate(client)

	// Auditoría de Creación
	name, _ := c.Get("userName")
	h.auditService.Log(client.CreatedByDNI, fmt.Sprintf("%v", name), "CREATE_CLIENT", "DIRECTORY", 
		fmt.Sprintf("Nuevo cliente: %s (DNI: %s)", client.Name, client.DNI),
		fmt.Sprintf("Se registró el cliente: %s", client.Name),
		"", c.ClientIP(), c.Request.UserAgent(), false)
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

	// AVISO GLOBAL: Cliente actualizado
	go sse.GetSSEService().BroadcastCustomerUpdate(dni)

	// Auditoría de Actualización
	dniEmployee, _ := c.Get("dni")
	name, _ := c.Get("userName")
	h.auditService.Log(fmt.Sprintf("%v", dniEmployee), fmt.Sprintf("%v", name), "UPDATE_CLIENT", "DIRECTORY", 
		fmt.Sprintf("Actualizado cliente DNI: %s", dni),
		fmt.Sprintf("Se modificó la información del cliente con DNI %s", dni),
		"", c.ClientIP(), c.Request.UserAgent(), false)
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

	// AVISO GLOBAL: Cliente eliminado
	go sse.GetSSEService().BroadcastCustomerUpdate(dni)

	// Auditoría de Eliminación
	dniEmployee, _ := c.Get("dni")
	name, _ := c.Get("userName")
	h.auditService.Log(dniEmployee.(string), name.(string), "DELETE_CLIENT", "DIRECTORY", 
		fmt.Sprintf("Eliminado cliente DNI: %s", dni),
		fmt.Sprintf("Se eliminó permanentemente el cliente con DNI %s", dni),
		"", c.ClientIP(), c.Request.UserAgent(), true)
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

	// AVISO GLOBAL: Abono recibido (Actualiza Dashboard y Cartera)
	go func() {
		sse.GetSSEService().BroadcastCustomerUpdate(updatedClient)
		sse.GetSSEService().BroadcastDashboardUpdate()
	}()

	// Auditoría de Pago de Crédito
	name, _ := c.Get("userName")
	h.auditService.Log(dniStr, fmt.Sprintf("%v", name), "PAY_CREDIT", "FINANCES", 
		fmt.Sprintf("Abono crédito: %s ($%.2f)", payment.ClientDNI, payment.TotalPaid),
		fmt.Sprintf("Se registró un abono de $%s para el cliente %s", fmt.Sprintf("%.2f", payment.TotalPaid), payment.ClientDNI),
		"", c.ClientIP(), c.Request.UserAgent(), true)
}

func (h *ClientHandler) GetStatement(c *gin.Context) {
	dni := c.Param("dni")
	statement, err := h.service.GetClientStatement(dni, h.saleRepo)
	if err != nil {
		SendError(c, http.StatusNotFound, ErrNotFound, "Cliente no encontrado para el estado de cuenta", err)
		return
	}

	c.JSON(http.StatusOK, statement)

	// Auditoría de Consulta de Estado de Cuenta
	dniEmployee, _ := c.Get("dni")
	name, _ := c.Get("userName")
	h.auditService.Log(fmt.Sprintf("%v", dniEmployee), fmt.Sprintf("%v", name), "VIEW_STATEMENT", "DIRECTORY", 
		fmt.Sprintf("Estado de cuenta consultado: %s", dni),
		fmt.Sprintf("Se generó reporte de deuda para el cliente con DNI %s", dni),
		"", c.ClientIP(), c.Request.UserAgent(), false)
}
