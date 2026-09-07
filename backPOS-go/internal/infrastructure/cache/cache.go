package cache

import (
	"strings"
	"time"

	"github.com/patrickmn/go-cache"
)

// CacheManager gestiona la caché en memoria L1 para el sistema
var CacheManager *cache.Cache

func init() {
	// Inicializar caché con TTL por defecto de 24 horas y limpieza cada 1 hora
	CacheManager = cache.New(24*time.Hour, 1*time.Hour)
}

// Claves de caché estandarizadas
const (
	CacheKeyProducts          = "all_products"
	CacheKeyCategories        = "all_categories"
	CacheKeyClients           = "all_clients"
	CacheKeySuppliers         = "all_suppliers"
	CacheKeyDashboardOverview = "dashboard_overview"
	CacheKeyProductCount      = "product_count"
	CacheKeyCategoryCount     = "category_count"
	CacheKeyClientCount       = "client_count"
	CacheKeySavingsOpportunities = "savings_opportunities"
)

// SavingsOpportunitiesTTL acota la vida del cálculo de ahorros.
//
// Es corto a propósito: sirve de red por si alguna ruta de escritura de precios
// olvida invalidar. La invalidación explícita
// (InvalidateSavingsOpportunities) sigue siendo el mecanismo principal.
const SavingsOpportunitiesTTL = 10 * time.Minute

// DashboardOverviewKey construye la clave real con la que se cachea un overview.
//
// Existe para que la escritura y la invalidación no puedan divergir: quien
// escribe usa esta función y InvalidateDashboard borra por el prefijo
// CacheKeyDashboardOverview, que es justamente lo que esta función anteponen.
func DashboardOverviewKey(startDate, endDate string) string {
	return CacheKeyDashboardOverview + "_" + startDate + "_" + endDate
}

// InvalidateCache elimina una entrada de la caché por su clave.
//
// Guardia: la clave del dashboard NUNCA se escribe tal cual (siempre lleva el
// sufijo del rango de fechas), así que un Delete literal sobre ella no borraba
// nada y el dashboard quedaba mostrando cifras viejas. Ese fue un bug real
// repetido en 9 lugares. Redirigir aquí hace imposible reintroducirlo.
func InvalidateCache(key string) {
	if key == CacheKeyDashboardOverview {
		InvalidateDashboard()
		return
	}
	CacheManager.Delete(key)
}

// InvalidateDashboard purga TODAS las variantes del overview.
//
// El dashboard se cachea con una entrada por rango de fechas
// ("dashboard_overview_2026-08-01_2026-08-26", etc.), así que un Delete sobre la
// clave base dejaría vivas las demás y el usuario seguiría viendo cifras viejas
// después de registrar una venta o guardar un cierre.
func InvalidateDashboard() {
	for key := range CacheManager.Items() {
		if strings.HasPrefix(key, CacheKeyDashboardOverview) {
			CacheManager.Delete(key)
		}
	}
}

// InvalidateSavingsOpportunities purga el cálculo de "podrías ahorrar comprándole
// a otro proveedor".
//
// Depende de precios de compra y de las recepciones de mercancía, así que
// cualquier escritura sobre productos o inventario lo deja obsoleto. Antes nunca
// se invalidaba: sólo se escribía con TTL de 1 hora, y durante esa hora el
// dashboard recomendaba comprarle al proveedor que ya había subido el precio.
func InvalidateSavingsOpportunities() {
	CacheManager.Delete(CacheKeySavingsOpportunities)
}

// InvalidateAllMasterData purga todos los catálogos maestros y sus conteos
func InvalidateAllMasterData() {
	CacheManager.Delete(CacheKeyProducts)
	CacheManager.Delete(CacheKeyCategories)
	CacheManager.Delete(CacheKeyClients)
	CacheManager.Delete(CacheKeySuppliers)
	CacheManager.Delete(CacheKeyProductCount)
	CacheManager.Delete(CacheKeyCategoryCount)
	CacheManager.Delete(CacheKeyClientCount)
}
