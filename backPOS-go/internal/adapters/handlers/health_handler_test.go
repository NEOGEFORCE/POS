package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// healthPublico ejecuta el handler público sin base de datos. Con h.db == nil el
// ping falla y dbStatus devuelve "DOWN (...)", que es exactamente el camino que
// queremos poder inspeccionar sin Postgres.
func healthPublico(t *testing.T) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodGet, "/health", nil)

	(&HealthHandler{}).Check(c)

	var parsed map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("el healthcheck no devolvió JSON: %v (%s)", err, rec.Body.String())
	}
	return parsed
}

// TestHealthPublico_ConservaDatabaseStatus fija el contrato con el despliegue.
//
// desplegar_a_produccion.ps1 lee "database.status" para decidir si promueve el
// release o hace rollback. Renombrar ese campo rompería el deploy en el peor
// momento posible: justo cuando ya se copió el binario nuevo.
func TestHealthPublico_ConservaDatabaseStatus(t *testing.T) {
	parsed := healthPublico(t)

	database, ok := parsed["database"].(map[string]any)
	if !ok {
		t.Fatalf(`falta el objeto "database"; el deploy lo necesita. Respuesta: %+v`, parsed)
	}
	if _, ok := database["status"].(string); !ok {
		t.Fatalf(`falta "database.status" (string); es el campo que lee el procedimiento de despliegue. Respuesta: %+v`, parsed)
	}
	if _, ok := parsed["status"].(string); !ok {
		t.Fatalf(`falta el "status" general. Respuesta: %+v`, parsed)
	}
}

// TestHealthPublico_NoExponeInternos: el endpoint es público, sin token. Antes
// publicaba hostname, versión de Go, sistema operativo, memoria y goroutines a
// cualquiera que llegara al puerto — reconocimiento gratis para un atacante.
func TestHealthPublico_NoExponeInternos(t *testing.T) {
	parsed := healthPublico(t)

	prohibidas := []string{"system", "resources", "hostname", "goVersion", "os", "uptime", "serverTime"}
	for _, clave := range prohibidas {
		if _, presente := parsed[clave]; presente {
			t.Errorf("el /health público expone %q; eso va detrás de admin en /api/admin/health/details", clave)
		}
	}

	// Nada de claves inesperadas: la superficie pública es exactamente esta.
	for clave := range parsed {
		switch clave {
		case "status", "database":
		default:
			t.Errorf("clave inesperada %q en el /health público", clave)
		}
	}
}

// TestHealthDetallado_MantieneLaFormaCompleta: el endpoint admin conserva la
// respuesta vieja íntegra, así que una herramienta interna que la consumía sólo
// necesita agregar credenciales.
func TestHealthDetallado_MantieneLaFormaCompleta(t *testing.T) {
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/admin/health/details", nil)

	(&HealthHandler{}).CheckDetailed(c)

	var parsed map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("no devolvió JSON: %v (%s)", err, rec.Body.String())
	}

	for _, clave := range []string{"status", "system", "database", "resources"} {
		if _, presente := parsed[clave]; !presente {
			t.Errorf("el health detallado perdió la clave %q", clave)
		}
	}

	system, ok := parsed["system"].(map[string]any)
	if !ok {
		t.Fatal(`"system" debe ser objeto`)
	}
	for _, clave := range []string{"version", "uptime", "serverTime", "hostname", "goVersion", "os"} {
		if _, presente := system[clave]; !presente {
			t.Errorf("system.%s desapareció del health detallado", clave)
		}
	}

	database, ok := parsed["database"].(map[string]any)
	if !ok {
		t.Fatal(`"database" debe ser objeto`)
	}
	if _, ok := database["status"].(string); !ok {
		t.Error(`el health detallado también conserva "database.status"`)
	}
}
