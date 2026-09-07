package handlers

import (
	"strconv"

	"github.com/gin-gonic/gin"
)

// MaxPageSize es el techo duro de cualquier página que devuelva el backend.
//
// Fuente ÚNICA de verdad: los cinco endpoints paginados (ventas, egresos,
// historial de restock, historial de reportes, historial de jobs) aceptaban
// pageSize sin techo, así que `?pageSize=999999` obligaba a materializar la
// tabla completa con sus preloads. Con el número repetido en cada handler el
// tope se desincroniza en la primera refactorización, por eso vive aquí.
//
// 200 filas cubre con holgura la página más grande que pinta el frontend
// (inventario usa 100) y mantiene la respuesta en un tamaño razonable.
const MaxPageSize = 200

// NormalizePageSize recorta el tamaño de página al tope y repara los valores
// basura. Deliberadamente NO devuelve error: si una pantalla vieja pide 1000
// filas preferimos servirle 200 antes que romperla con un 400.
//
//	valor <= 0 (incluye texto no numérico, que Atoi deja en 0) -> def
//	valor > MaxPageSize                                       -> MaxPageSize
func NormalizePageSize(pageSize, def int) int {
	if def <= 0 || def > MaxPageSize {
		def = MaxPageSize
	}
	if pageSize <= 0 {
		return def
	}
	if pageSize > MaxPageSize {
		return MaxPageSize
	}
	return pageSize
}

// NormalizePage devuelve un número de página válido (1-based).
func NormalizePage(page int) int {
	if page <= 0 {
		return 1
	}
	return page
}

// QueryPageSize lee un parámetro de tamaño de página y lo normaliza en un paso.
// Un valor no numérico cae en el default porque strconv.Atoi devuelve 0.
func QueryPageSize(c *gin.Context, param string, def int) int {
	raw, _ := strconv.Atoi(c.Query(param))
	return NormalizePageSize(raw, def)
}

// QueryPage lee el número de página desde la query string.
func QueryPage(c *gin.Context, param string) int {
	raw, _ := strconv.Atoi(c.Query(param))
	return NormalizePage(raw)
}

// QueryOffset lee un offset desde la query string; negativo se colapsa a 0.
func QueryOffset(c *gin.Context, param string) int {
	raw, _ := strconv.Atoi(c.Query(param))
	if raw < 0 {
		return 0
	}
	return raw
}
