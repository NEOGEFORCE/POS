package cache

import (
	"testing"
	"time"
)

// TestInvalidateDashboard_BorraLaFormaRealDeLaClave es el guardián del bug.
//
// El dashboard se ESCRIBE con "dashboard_overview_<inicio>_<fin>" pero durante
// mucho tiempo se INVALIDABA con Delete("dashboard_overview") en 9 lugares del
// código. Ese Delete no borraba nada: el operador registraba una venta, el
// dashboard decía que no había pasado nada, y el diagnóstico se iba por la rama
// equivocada (¿la venta se guardó?, ¿la vista materializada?).
//
// Este test fija que lo que se invalida tiene la misma forma que lo que se
// escribe.
func TestInvalidateDashboard_BorraLaFormaRealDeLaClave(t *testing.T) {
	CacheManager.Flush()

	claves := []string{
		DashboardOverviewKey("2026-08-01", "2026-08-31"),
		DashboardOverviewKey("2026-09-01", "2026-09-07"),
		DashboardOverviewKey("", ""),
	}
	for _, k := range claves {
		CacheManager.Set(k, "cifras-viejas", 24*time.Hour)
	}
	// Ruido que NO debe desaparecer: purgar el dashboard no puede tumbar el
	// catálogo maestro de productos.
	CacheManager.Set(CacheKeyProducts, "catalogo", 24*time.Hour)

	InvalidateDashboard()

	for _, k := range claves {
		if _, found := CacheManager.Get(k); found {
			t.Errorf("la clave %q sobrevivió a InvalidateDashboard: el dashboard mostraría cifras viejas", k)
		}
	}
	if _, found := CacheManager.Get(CacheKeyProducts); !found {
		t.Error("InvalidateDashboard no debe purgar el catálogo de productos")
	}
}

// TestDashboardOverviewKey_TienePrefijoInvalidable ata las dos mitades del
// contrato: la función que construye la clave y el prefijo por el que se borra.
// Si alguien cambia el separador o mete el rango de fechas ADELANTE del nombre,
// este test falla en vez de dejar una caché fantasma.
func TestDashboardOverviewKey_TienePrefijoInvalidable(t *testing.T) {
	key := DashboardOverviewKey("2026-01-01", "2026-01-31")

	if len(key) <= len(CacheKeyDashboardOverview) {
		t.Fatalf("la clave %q debe extender el prefijo, no reemplazarlo", key)
	}
	if key[:len(CacheKeyDashboardOverview)] != CacheKeyDashboardOverview {
		t.Fatalf("la clave %q no empieza con el prefijo %q que usa InvalidateDashboard",
			key, CacheKeyDashboardOverview)
	}
	if key == CacheKeyDashboardOverview {
		t.Fatal("la clave escrita nunca es la clave base; ese fue el origen del bug")
	}
}

// TestInvalidateCache_RedirigeLaClaveDelDashboard: los 9 llamadores originales
// usaban InvalidateCache(CacheKeyDashboardOverview). Aunque ya se migraron a
// InvalidateDashboard(), la redirección impide que el bug vuelva si alguien
// escribe el llamado viejo por costumbre.
func TestInvalidateCache_RedirigeLaClaveDelDashboard(t *testing.T) {
	CacheManager.Flush()
	key := DashboardOverviewKey("2026-03-01", "2026-03-31")
	CacheManager.Set(key, "cifras-viejas", 24*time.Hour)

	InvalidateCache(CacheKeyDashboardOverview)

	if _, found := CacheManager.Get(key); found {
		t.Errorf("InvalidateCache(CacheKeyDashboardOverview) debe purgar %q por prefijo", key)
	}
}

// TestInvalidateSavingsOpportunities_UsaLaMismaClaveQueSeEscribe: la caché de
// ahorros se escribía en dashboard_service.go y jamás se invalidaba.
func TestInvalidateSavingsOpportunities_UsaLaMismaClaveQueSeEscribe(t *testing.T) {
	CacheManager.Flush()
	CacheManager.Set(CacheKeySavingsOpportunities, []string{"oportunidad-vieja"}, SavingsOpportunitiesTTL)

	InvalidateSavingsOpportunities()

	if _, found := CacheManager.Get(CacheKeySavingsOpportunities); found {
		t.Error("la caché de savings_opportunities no se invalidó")
	}
}

// TestSavingsOpportunitiesTTL_EsCorto: mientras la invalidación explícita sea la
// red principal, el TTL es el respaldo. Una hora era demasiado para un dato que
// decide a qué proveedor comprarle.
func TestSavingsOpportunitiesTTL_EsCorto(t *testing.T) {
	if SavingsOpportunitiesTTL > 15*time.Minute {
		t.Errorf("SavingsOpportunitiesTTL = %v; un TTL largo sin invalidar fue el bug original", SavingsOpportunitiesTTL)
	}
	if SavingsOpportunitiesTTL <= 0 {
		t.Error("un TTL <= 0 en go-cache significa 'usar el default de 24h', justo lo que queremos evitar")
	}
}
