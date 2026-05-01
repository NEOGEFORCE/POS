package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"errors"
	"golang.org/x/crypto/bcrypt"
	"strings"
)

type AdminService struct {
	repo ports.AdminRepository
}

func NewAdminService(repo ports.AdminRepository) *AdminService {
	return &AdminService{repo: repo}
}

func (s *AdminService) CreateEmployee(employee *models.Employee) error {
	// Bloqueo estricto de creación de nuevos SuperAdmins
	if strings.ToLower(employee.Role) == "superadmin" {
		employee.Role = "administrador" // Forzar a administrador por defecto
	}

	hashedPassword, _ := bcrypt.GenerateFromPassword([]byte(employee.Password), bcrypt.DefaultCost)
	employee.Password = string(hashedPassword)
	return s.repo.Save(employee)
}

func (s *AdminService) GetAllEmployees(requesterRole string) ([]models.Employee, error) {
	emps, err := s.repo.GetAll()
	if err != nil {
		return nil, err
	}

	// Normalización: Asegurar que el Superadmin sea siempre Activo en la respuesta
	for i := range emps {
		if strings.ToLower(emps[i].Role) == "superadmin" {
			emps[i].IsActive = true
		}
	}

	return emps, nil
}

func (s *AdminService) UpdateEmployee(dni string, employee *models.Employee) error {
	// 1. Buscar el estado actual del usuario en la Base de Datos
	currentUser, err := s.repo.FindByDNI(dni)
	if err != nil {
		return err
	}

	// 2. Protecciones estrictas para el rol Superadmin
	if strings.ToLower(currentUser.Role) == "superadmin" {
		// El superadmin es inmutable en su rol y estado activo (NUNCA se le quita el superadmin ni se pone inactivo)
		employee.Role = "SUPERADMIN" 
		employee.IsActive = true
	} else {
		// Bloqueo: un usuario normal NO puede ser ascendido a SUPERADMIN
		if strings.ToLower(employee.Role) == "superadmin" {
			employee.Role = currentUser.Role 
		}
	}

	// 3. Hashear contraseña si se proporciona una nueva
	if employee.Password != "" {
		hashedPassword, _ := bcrypt.GenerateFromPassword([]byte(employee.Password), bcrypt.DefaultCost)
		employee.Password = string(hashedPassword)
	}

	return s.repo.Update(dni, employee)
}

func (s *AdminService) DeleteEmployee(dni string) error {
	user, err := s.repo.FindByDNI(dni)
	if err != nil {
		return err
	}

	if strings.ToLower(user.Role) == "superadmin" {
		return errors.New("el superadministrador no puede ser eliminado")
	}

	// 1. Desactivar explícitamente antes de borrar
	user.IsActive = false
	if err := s.repo.Update(dni, user); err != nil {
		return err
	}

	// 2. Ejecutar soft-delete
	return s.repo.Delete(dni)
}
func (s *AdminService) GetEmployee(dni string) (*models.Employee, error) {
	return s.repo.FindByDNI(dni)
}

// Faltantes Module

func (s *AdminService) CreateMissingItem(item *models.MissingItem) error {
	item.ProductName = strings.ToUpper(strings.TrimSpace(item.ProductName))
	if item.Status == "" {
		item.Status = "PENDIENTE"
	}
	return s.repo.SaveMissingItem(item)
}

func (s *AdminService) GetMissingItems() ([]models.MissingItem, error) {
	return s.repo.GetMissingItems()
}

func (s *AdminService) UpdateMissingItemStatus(id uint, status string) error {
	return s.repo.UpdateMissingItemStatus(id, strings.ToUpper(status))
}

// Maintenance (V7.0)
func (s *AdminService) PurgeDataBefore(date string) (int64, error) {
	return s.repo.PurgeDataBefore(date)
}
