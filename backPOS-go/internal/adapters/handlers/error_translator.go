package handlers

import (
	"strings"
)

// TranslateDBError intercepta errores comunes de la base de datos y Go y los traduce a espaol claro para el usuario.
func TranslateDBError(rawError string) (string, string) {
	lower := strings.ToLower(rawError)

	// Errores de MySQL / PostgreSQL (Unique Constraints, Duplicados)
	if strings.Contains(lower, "1062") || strings.Contains(lower, "unique constraint") || strings.Contains(lower, "duplicate key") || strings.Contains(lower, "llave duplicada") || strings.Contains(lower, "restricción de unicidad") {
		return "Registro Duplicado", "Ya existe un elemento con este código, nombre o identificador."
	}
	// Llaves foráneas
	if strings.Contains(lower, "foreign key constraint") || strings.Contains(lower, "violates foreign key") || strings.Contains(lower, "llave foránea") || strings.Contains(lower, "clave foránea") {
		if strings.Contains(lower, "delete") || strings.Contains(lower, "update") || strings.Contains(lower, "eliminar") || strings.Contains(lower, "actualizar") {
			return "Conflicto de Vínculos", "No se puede eliminar o modificar porque hay información asociada (ej. ventas o compras) a este registro."
		}
		return "Dato Inválido", "Estás intentando vincular un registro con un dato que no existe (ej. un proveedor o categoría eliminada)."
	}
	// Restricciones de nulos
	if strings.Contains(lower, "not-null constraint") || strings.Contains(lower, "cannot be null") || strings.Contains(lower, "valor nulo") {
		return "Dato Incompleto", "Falta llenar un campo obligatorio en el formulario."
	}
	// Longitud de datos
	if strings.Contains(lower, "data too long") || strings.Contains(lower, "value too long") || strings.Contains(lower, "demasiado largo") {
		return "Texto Demasiado Largo", "Uno de los textos ingresados supera el lmite permitido por el sistema. Por favor, redcelo."
	}
	// Errores numricos / fuera de rango
	if strings.Contains(lower, "out of range") {
		return "Nmero Fuera de Rango", "Uno de los nmeros ingresados es demasiado grande o pequeo para el sistema."
	}
	if strings.Contains(lower, "invalid syntax") || strings.Contains(lower, "unmarshal") {
		return "Formato Incorrecto", "El sistema esperaba un nmero pero recibi texto, o viceversa."
	}
	// Errores de red
	if strings.Contains(lower, "connection refused") || strings.Contains(lower, "dial tcp") {
		return "Fallo de Conexin", "No hay comunicacin interna con la base de datos del servidor."
	}
	
	// Si no coincide con nada, se retorna el original (se puede usar el mensaje genrico provisto originalmente)
	return "", rawError
}
