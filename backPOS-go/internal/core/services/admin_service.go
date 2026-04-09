package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"golang.org/x/crypto/bcrypt"
)

type AdminService struct {
	repo ports.AdminRepository
}

func NewAdminService(repo ports.AdminRepository) *AdminService {
	return &AdminService{repo: repo}
}

func (s *AdminService) CreateEmployee(employee *models.Employee) error {
	hashedPassword, _ := bcrypt.GenerateFromPassword([]byte(employee.Password), bcrypt.DefaultCost)
	employee.Password = string(hashedPassword)
	return s.repo.Save(employee)
}

func (s *AdminService) GetAllEmployees() ([]models.Employee, error) {
	return s.repo.GetAll()
}

func (s *AdminService) UpdateEmployee(dni string, employee *models.Employee) error {
	if employee.Password != "" {
		hashedPassword, _ := bcrypt.GenerateFromPassword([]byte(employee.Password), bcrypt.DefaultCost)
		employee.Password = string(hashedPassword)
	}
	return s.repo.Update(dni, employee)
}

func (s *AdminService) DeleteEmployee(dni string) error {
	return s.repo.Delete(dni)
}
