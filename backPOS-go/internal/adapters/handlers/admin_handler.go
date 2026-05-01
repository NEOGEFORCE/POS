package handlers

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
)

type AdminHandler struct {
	service      *services.AdminService
	auditService *services.AuditService
}

func NewAdminHandler(s *services.AdminService, a *services.AuditService) *AdminHandler {
	return &AdminHandler{
		service:      s,
		auditService: a,
	}
}

func (h *AdminHandler) getAuditInfo(c *gin.Context) (dni string, name string, ip string, device string) {
	dniVal, _ := c.Get("dni")
	if s, ok := dniVal.(string); ok {
		dni = s
	} else {
		dni = "SYSTEM"
	}
	nameVal, _ := c.Get("userName")
	if s, ok := nameVal.(string); ok {
		name = s
	} else {
		name = "ADMIN_SYS"
	}
	ip = c.ClientIP()
	device = c.Request.UserAgent()
	return
}

// Estructura para recibir datos del frontend (incluyendo password que el modelo base ignora)
type RegisterEmployeeRequest struct {
	DNI      string `json:"dni" binding:"required"`
	Name     string `json:"name" binding:"required"`
	Email    string `json:"email"`
	Password string `json:"password"`
	Role     string `json:"role" binding:"required"`
	IsActive *bool  `json:"is_active"`
}

func (h *AdminHandler) CreateEmployee(c *gin.Context) {
	var req RegisterEmployeeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	roleNormalized := strings.ToLower(req.Role)
	if roleNormalized == "superadmin" {
		SendError(c, http.StatusForbidden, ErrForbidden, "No se permite crear más de un Superadmin.", nil)
		return
	}

	if (roleNormalized == "admin") && strings.TrimSpace(req.Email) == "" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "El correo electrónico es obligatorio para administradores", nil)
		return
	}

	isActive := true
	if req.IsActive != nil {
		isActive = *req.IsActive
	}

	emp := models.Employee{
		DNI:      strings.ToUpper(strings.TrimSpace(req.DNI)),
		Name:     strings.ToUpper(strings.TrimSpace(req.Name)),
		Email:    strings.ToUpper(strings.TrimSpace(req.Email)),
		Password: req.Password,
		Role:     strings.ToUpper(strings.TrimSpace(req.Role)),
		IsActive: isActive,
	}

	if emp.DNI == "" {
		emp.DNI = fmt.Sprintf("EMP-%d", time.Now().Unix())
	} else {
		emp.DNI = strings.ToUpper(emp.DNI)
	}

	if err := h.service.CreateEmployee(&emp); err != nil {
		log.Printf("ERROR: Fallo al crear empleado %s: %v", emp.DNI, err)
		errStr := strings.ToLower(err.Error())
		// Detección mejorada de duplicados (PostgreSQL / MySQL)
		if strings.Contains(errStr, "1062") || strings.Contains(errStr, "unique") || 
		   strings.Contains(errStr, "duplicate") || strings.Contains(errStr, "duplicada") || 
		   strings.Contains(errStr, "ya existe") {
			SendError(c, http.StatusConflict, ErrDuplicateEntry, "El DNI o el nombre de usuario ya está registrado en el núcleo", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al crear empleado en base de datos", err)
		return
	}

	authorDNI, authorName, ip, device := h.getAuditInfo(c)
	h.auditService.Log(authorDNI, authorName, "CREATE_EMPLOYEE", "ADMIN", fmt.Sprintf("Creado usuario %s con rol %s", emp.Name, emp.Role), fmt.Sprintf("Se registró un nuevo usuario: %s (%s) con rol %s", emp.Name, emp.DNI, emp.Role), "{}", ip, device, true)

	c.JSON(http.StatusCreated, emp)
}

func (h *AdminHandler) GetAllEmployees(c *gin.Context) {
	requesterRole, _ := c.Get("role")
	roleStr := ""
	if r, ok := requesterRole.(string); ok {
		roleStr = r
	}

	emps, err := h.service.GetAllEmployees(roleStr)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener empleados", err)
		return
	}
	c.JSON(http.StatusOK, emps)
}

func (h *AdminHandler) UpdateEmployee(c *gin.Context) {
	dni := c.Param("dni")
	var req RegisterEmployeeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}
	
	roleNormalized := strings.ToLower(req.Role)
	
	// Verificar el rol actual del empleado antes de actualizar
	currentEmp, err := h.service.GetEmployee(dni)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			SendError(c, http.StatusNotFound, ErrNotFound, "Empleado no encontrado", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al verificar empleado actual", err)
		return
	}

	isCurrentlySuperAdmin := strings.ToLower(currentEmp.Role) == "superadmin"

	// Bloquear promoción a Superadmin si el usuario no lo es ya
	if roleNormalized == "superadmin" && !isCurrentlySuperAdmin {
		SendError(c, http.StatusForbidden, ErrForbidden, "No se permite promover usuarios al nivel de Superadmin.", nil)
		return
	}

	// Si es Superadmin, impedir que le cambien el rol a otra cosa (Degradación)
	if isCurrentlySuperAdmin && roleNormalized != "superadmin" {
		SendError(c, http.StatusForbidden, ErrForbidden, "No se permite degradar el rango de un Superadmin por seguridad del núcleo.", nil)
		return
	}

	if (roleNormalized == "admin") && strings.TrimSpace(req.Email) == "" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "El correo electrónico es obligatorio para administradores", nil)
		return
	}
	isActive := currentEmp.IsActive
	if req.IsActive != nil {
		isActive = *req.IsActive
	}

	// Mapeo manual para asegurar normalización
	emp := models.Employee{
		DNI:      dni,
		Name:     strings.ToUpper(strings.TrimSpace(req.Name)),
		Email:    strings.ToUpper(strings.TrimSpace(req.Email)),
		Password: req.Password, // Si viene vacía, el service/repo no la tocará
		Role:     strings.ToUpper(strings.TrimSpace(req.Role)),
		IsActive: isActive,
	}

	if err := h.service.UpdateEmployee(dni, &emp); err != nil {
		if strings.Contains(err.Error(), "not found") {
			SendError(c, http.StatusNotFound, ErrNotFound, "Empleado no encontrado", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al actualizar empleado", err)
		return
	}

	requesterDNI, requesterName, ip, device := h.getAuditInfo(c)
	h.auditService.Log(requesterDNI, requesterName, "UPDATE_EMPLOYEE", "ADMIN", fmt.Sprintf("Actualizado usuario DNI: %s", dni), fmt.Sprintf("Se modificaron los datos del usuario: %s (%s)", emp.Name, dni), "{}", ip, device, true)

	c.JSON(http.StatusOK, gin.H{"message": "Empleado actualizado correctamente"})
}

func (h *AdminHandler) DeleteEmployee(c *gin.Context) {
	dni := c.Param("dni")

	// Protección: No se puede eliminar a un Superadmin
	emp, err := h.service.GetEmployee(dni)
	if err == nil && strings.ToLower(emp.Role) == "superadmin" {
		SendError(c, http.StatusForbidden, ErrForbidden, "El perfil de Superadmin es inmutable y no puede ser eliminado.", nil)
		return
	}

	// Al eliminar (borrado lógico), también marcamos IsActive como false
	emp.IsActive = false
	h.service.UpdateEmployee(dni, emp)

	if err := h.service.DeleteEmployee(dni); err != nil {
		if strings.Contains(err.Error(), "not found") {
			SendError(c, http.StatusNotFound, ErrNotFound, "Empleado no encontrado", err)
			return
		}

		// Fase 2: Detectar conflictos de integridad relacional (ForeignKey)
		errStr := strings.ToLower(err.Error())
		if strings.Contains(errStr, "foreign key") || strings.Contains(errStr, "violat") || strings.Contains(errStr, "relaci") {
			SendError(c, http.StatusConflict, ErrConflict, "No se puede eliminar: El usuario tiene historial de movimientos (ventas/gastos) vinculado.", err)
			return
		}

		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al eliminar empleado", err)
		return
	}

	requesterDNI, requesterName, ip, device := h.getAuditInfo(c)
	h.auditService.Log(requesterDNI, requesterName, "DELETE_EMPLOYEE", "ADMIN", fmt.Sprintf("Desactivado usuario DNI: %s", dni), fmt.Sprintf("Se desactivó el acceso para el usuario con DNI: %s", dni), "{}", ip, device, true)

	c.JSON(http.StatusOK, gin.H{"message": "Empleado eliminado correctamente"})
}

func (h *AdminHandler) ResetEmployeePassword(c *gin.Context) {
	dni := c.Param("dni")

	// 1. Verificar si el usuario objetivo es Superadmin
	targetEmp, err := h.service.GetEmployee(dni)
	if err == nil && strings.ToLower(targetEmp.Role) == "superadmin" {
		SendError(c, http.StatusForbidden, ErrForbidden, "Operación denegada: El rol superadmin es inmutable", nil)
		return
	}

	var req struct {
		Password string `json:"password" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "La nueva contraseña es obligatoria", err)
		return
	}

	emp := models.Employee{
		Password: req.Password,
	}

	if err := h.service.UpdateEmployee(dni, &emp); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al resetear contraseña", err)
		return
	}

	requesterDNI, requesterName, ip, device := h.getAuditInfo(c)
	h.auditService.Log(requesterDNI, requesterName, "FORCE_RESET_PASSWORD", "ADMIN", fmt.Sprintf("Admin forzó cambio de contraseña para DNI: %s", dni), fmt.Sprintf("Se forzó el restablecimiento de contraseña para el usuario %s (%s)", targetEmp.Name, dni), "{}", ip, device, true)

	c.JSON(http.StatusOK, gin.H{"message": "Contraseña de empleado actualizada correctamente"})
}

func (h *AdminHandler) GetEmployee(c *gin.Context) {
	dni := c.Param("dni")
	emp, err := h.service.GetEmployee(dni)
	if err != nil {
		SendError(c, http.StatusNotFound, ErrNotFound, "Empleado no encontrado", err)
		return
	}
	c.JSON(http.StatusOK, emp)
}

func (h *AdminHandler) GetAuditLogs(c *gin.Context) {
	logs, err := h.auditService.GetLogs()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener logs de auditoría", err)
		return
	}
	c.JSON(http.StatusOK, logs)
}

// --- Faltantes Handlers ---

func (h *AdminHandler) CreateMissingItem(c *gin.Context) {
	var req struct {
		ProductName string `json:"product_name" binding:"required"`
		Note        string `json:"note"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "El nombre del producto es obligatorio", err)
		return
	}

	dni, _ := c.Get("dni")
	authorDNI := ""
	if s, ok := dni.(string); ok {
		authorDNI = s
	}

	item := models.MissingItem{
		ProductName: req.ProductName,
		Note:        req.Note,
		ReportedBy:  authorDNI,
	}

	if err := h.service.CreateMissingItem(&item); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al reportar faltante", err)
		return
	}

	c.JSON(http.StatusCreated, item)
}

func (h *AdminHandler) GetAllMissingItems(c *gin.Context) {
	items, err := h.service.GetMissingItems()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener faltantes", err)
		return
	}
	c.JSON(http.StatusOK, items)
}

func (h *AdminHandler) UpdateMissingItemStatus(c *gin.Context) {
	var req struct {
		ID     uint   `json:"id" binding:"required"`
		Status string `json:"status" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "ID y Estado son obligatorios", err)
		return
	}

	if err := h.service.UpdateMissingItemStatus(req.ID, req.Status); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al actualizar estado del faltante", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Estado de faltante actualizado"})
}

// --- Mantenimiento BD (V7.0) ---

func (h *AdminHandler) GenerateDatabaseBackup(c *gin.Context) {
	// 1. Validar que tengamos los binarios de pg_dump
	// En Windows esto asume que pg_dump está en el PATH, o usará variables de entorno
	host := os.Getenv("DB_HOST")
	port := os.Getenv("DB_PORT")
	user := os.Getenv("DB_USER")
	dbname := os.Getenv("DB_NAME")
	pass := os.Getenv("DB_PASSWORD")

	if host == "" { host = "localhost" }
	if port == "" { port = "5432" }
	if user == "" { user = "postgres" }
	if dbname == "" { dbname = "pos_db" }

	fileName := fmt.Sprintf("pos_backup_%s.sql", time.Now().Format("20060102_150405"))
	filePath := "./" + fileName

	// Comando pg_dump
	cmd := exec.Command("pg_dump", "-h", host, "-p", port, "-U", user, "-d", dbname, "-F", "p", "-f", filePath)
	// Setear la contraseña temporalmente en el entorno
	cmd.Env = append(os.Environ(), "PGPASSWORD="+pass)

	if err := cmd.Run(); err != nil {
		log.Printf("Error ejecutando pg_dump: %v", err)
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudo generar el respaldo. Verifique que pg_dump esté instalado.", err)
		return
	}

	// 2. Registrar auditoría
	requesterDNI, requesterName, ip, device := h.getAuditInfo(c)
	h.auditService.Log(requesterDNI, requesterName, "DB_BACKUP", "ADMIN", "Generación de Respaldo SQL", "El administrador descargó un respaldo completo de la base de datos.", "{}", ip, device, true)

	// 3. Enviar archivo y limpiarlo
	c.Header("Content-Disposition", "attachment; filename="+fileName)
	c.Header("Content-Type", "application/octet-stream")
	c.File(filePath)
	
	// Eliminar el archivo después de enviarlo (usando un goroutine corto)
	go func() {
		time.Sleep(5 * time.Second)
		os.Remove(filePath)
	}()
}

func (h *AdminHandler) PurgeOldData(c *gin.Context) {
	var req struct {
		Date string `json:"date" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "La fecha de corte es obligatoria (YYYY-MM-DD)", err)
		return
	}

	// Ejecutar purga en el servicio
	rowsAffected, err := h.service.PurgeDataBefore(req.Date)
	if err != nil {
		log.Printf("Error purgando base de datos: %v", err)
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudo realizar la purga.", err)
		return
	}

	// Auditoría
	requesterDNI, requesterName, ip, device := h.getAuditInfo(c)
	h.auditService.Log(requesterDNI, requesterName, "DB_PURGE", "ADMIN", fmt.Sprintf("Purga de historial anterior a %s", req.Date), fmt.Sprintf("Se eliminaron %d registros transaccionales obsoletos.", rowsAffected), "{}", ip, device, true)

	c.JSON(http.StatusOK, gin.H{
		"message": "Purga completada exitosamente",
		"records_deleted": rowsAffected,
	})
}
