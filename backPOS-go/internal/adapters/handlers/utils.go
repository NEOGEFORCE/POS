package handlers

import (
	"fmt"
	"github.com/gin-gonic/gin"
)

// GetContextUser extrae de forma segura el DNI y el Nombre del usuario autenticado.
// Evita pánicos por conversiones de tipo inválidas si los datos no están en el contexto.
func GetContextUser(c *gin.Context) (dni string, name string) {
	dniVal, exists := c.Get("dni")
	if !exists || dniVal == nil {
		dni = "SISTEMA"
	} else {
		dni = fmt.Sprintf("%v", dniVal)
	}

	nameVal, exists := c.Get("userName")
	if !exists || nameVal == nil {
		name = "USUARIO"
	} else {
		name = fmt.Sprintf("%v", nameVal)
	}

	return dni, name
}

// GetContextRole extrae el rol de forma segura.
func GetContextRole(c *gin.Context) string {
	roleVal, exists := c.Get("role")
	if !exists || roleVal == nil {
		return ""
	}
	return fmt.Sprintf("%v", roleVal)
}
