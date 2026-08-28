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

// InvalidateCache elimina una entrada de la caché por su clave
func InvalidateCache(key string) {
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
