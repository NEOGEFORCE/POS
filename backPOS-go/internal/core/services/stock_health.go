package services

import (
	"math"

	"backPOS-go/internal/core/domain/models"
)

// StockHealth es el semaforo historico de salud de inventario que consumen
// las pantallas de dashboard y stats. Los cortes viven ahora en el paquete
// models (StockBandRedRatio / StockBandGreenRatio) para que la recomendacion
// de pedido —que vive en models— pueda consumirlos sin crear un ciclo.
//
// Estos nombres se mantienen por compatibilidad con handlers y frontends que
// ya conocen "CRITICAL" / "WARNING" / "OPTIMAL". Los mapean a las bandas
// nuevas asi:
//
//	models.StockBandRed    -> StockHealthCritical
//	models.StockBandYellow -> StockHealthWarning
//	models.StockBandGreen  -> StockHealthOptimal
//	models.StockBandUnset  -> StockHealthOptimal (producto sin minimo con stock > 0)
const (
	StockHealthCritical = "CRITICAL"
	StockHealthWarning  = "WARNING"
	StockHealthOptimal  = "OPTIMAL"
)

// ClassifyStockHealth remapea la banda del semaforo (regla del dueno de
// agosto 2026: ROJO < 25%, AMARILLO 25%–75%, VERDE >= 75%) al vocabulario
// historico CRITICAL / WARNING / OPTIMAL.
//
// La clasificacion vive en models.ClassifyStockBand: es la unica fuente de
// verdad de los cortes. Si un dia cambian, se cambian ahi y este mapeo se
// mueve automaticamente. Las consultas SQL agregadas (postgres_product_stats
// y GetPaginated) usan las MISMAS constantes para que las cifras coincidan.
func ClassifyStockHealth(quantity, minStock float64) string {
	switch models.ClassifyStockBand(quantity, minStock) {
	case models.StockBandRed:
		return StockHealthCritical
	case models.StockBandYellow:
		return StockHealthWarning
	default:
		// StockBandGreen y StockBandUnset se pintan como Optimal.
		return StockHealthOptimal
	}
}

// ProductStatsAggregate es la respuesta agregada que hoy calcula la consulta
// SQL de GetProductStatsAggregate (sin bucle sobre 2000+ productos en Go).
//
// IMPORTANTE: como la regla nueva colapsa AMARILLO (25%–75%) y VERDE (>=75%)
// en solo dos columnas por compatibilidad con el frontend, el conteo de
// warning ES equivalente al conteo de la banda amarilla completa. El conteo
// de green se puede derivar en el frontend como (totalItems - criticalStock
// - warningStock). Documentado aca para que el proximo cambio no invente
// columnas nuevas sin necesidad.
type ProductStatsAggregate struct {
	TotalCost     float64 `json:"totalCost"`
	TotalRetail   float64 `json:"totalRetail"`
	CriticalStock int64   `json:"criticalStock"`
	WarningStock  int64   `json:"warningStock"`
	TotalItems    int64   `json:"totalItems"`
}

// AsMap devuelve la forma esperada por el handler (map[string]interface{}),
// preservando compatibilidad con la respuesta anterior.
func (a ProductStatsAggregate) AsMap() map[string]interface{} {
	return map[string]interface{}{
		"totalCost":     roundMoney(a.TotalCost),
		"totalRetail":   roundMoney(a.TotalRetail),
		"criticalStock": a.CriticalStock,
		"warningStock":  a.WarningStock,
		"totalItems":    a.TotalItems,
	}
}

// roundMoney redondea a 2 decimales para evitar exponer ruido de coma flotante.
func roundMoney(v float64) float64 {
	return math.Round(v*100) / 100
}
