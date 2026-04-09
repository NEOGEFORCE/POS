package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

type CategoryService struct {
	repo ports.CategoryRepository
}

func NewCategoryService(r ports.CategoryRepository) *CategoryService {
	return &CategoryService{repo: r}
}

func (s *CategoryService) CreateCategory(category *models.Category) error {
	return s.repo.Save(category)
}

func (s *CategoryService) GetCategory(id uint) (*models.Category, error) {
	return s.repo.GetByID(id)
}

func (s *CategoryService) GetAllCategories() ([]models.Category, error) {
	return s.repo.GetAll()
}

func (s *CategoryService) UpdateCategory(id uint, category *models.Category) error {
	return s.repo.Update(id, category)
}

func (s *CategoryService) DeleteCategory(id uint) error {
	return s.repo.Delete(id)
}
