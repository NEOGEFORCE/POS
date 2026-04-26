package cache

import (
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

// InvalidateAllMasterData purga todos los catálogos maestros y sus conteos
func InvalidateAllMasterData() {
	CacheManager.Delete(CacheKeyProducts)
	CacheManager.Delete(CacheKeyCategories)
	CacheManager.Delete(CacheKeyClients)
	CacheManager.Delete(CacheKeyProductCount)
	CacheManager.Delete(CacheKeyCategoryCount)
	CacheManager.Delete(CacheKeyClientCount)
}
