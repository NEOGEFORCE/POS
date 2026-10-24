// Pruebas del PosQrHandler para los endpoints de asignación manual y
// bandeja de conciliación (sprint SMS).
//
//   - PagosSinAsignar: validaciones (sesión, minutos fuera de rango).
//   - Asignar: validaciones (sesión, payload, DNI del contexto).
//   - El contrato camelCase y los códigos estables QR_EVENT_NOT_FOUND /
//     QR_EVENT_ALREADY_ASSIGNED / QR_AMOUNT_MISMATCH están registrados
//     en el source.

package handlers

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// -----------------------------------------------------------------------------
// PagosSinAsignar
// -----------------------------------------------------------------------------

func TestPosQrHandler_PagosSinAsignar_SinSesion_401(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/pagos-sin-asignar?minutos=30", "")
	h.PagosSinAsignar(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe 401, got %d", rec.Code)
	}
}

func TestPosQrHandler_PagosSinAsignar_MinutosFueraDeRango_400(t *testing.T) {
	h := &PosQrHandler{}
	for _, minutos := range []string{"0", "-5", "121", "999", "abc"} {
		c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/pagos-sin-asignar?minutos="+minutos, "")
		c.Set("userDni", "EMP-1")
		h.PagosSinAsignar(c)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("minutos=%q debe 400, got %d (body=%s)", minutos, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "QR_BAD_REQUEST") {
			t.Errorf("minutos=%q debe exponer QR_BAD_REQUEST: %s", minutos, rec.Body.String())
		}
	}
}

// -----------------------------------------------------------------------------
// Asignar
// -----------------------------------------------------------------------------

func TestPosQrHandler_Asignar_SinSesion_401(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodPost, "/api/pos/pagos-qr/asignar",
		`{"venta_temp_id":"temp-x","event_id":42}`)
	h.Asignar(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe 401, got %d", rec.Code)
	}
}

func TestPosQrHandler_Asignar_PayloadMalformado_400(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodPost, "/api/pos/pagos-qr/asignar", `no es json`)
	c.Set("userDni", "EMP-1")
	h.Asignar(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("payload malformado debe 400, got %d", rec.Code)
	}
}

func TestPosQrHandler_Asignar_FaltanCampos_400(t *testing.T) {
	h := &PosQrHandler{}
	for _, body := range []string{
		`{}`,
		`{"venta_temp_id":"","event_id":1}`,
		`{"venta_temp_id":"temp-x","event_id":0}`,
	} {
		c, rec := newQrTestContext(http.MethodPost, "/api/pos/pagos-qr/asignar", body)
		c.Set("userDni", "EMP-1")
		h.Asignar(c)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body=%s debe 400, got %d", body, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "QR_BAD_REQUEST") {
			t.Errorf("body=%s debe exponer QR_BAD_REQUEST: %s", body, rec.Body.String())
		}
	}
}

// -----------------------------------------------------------------------------
// Guardianes estáticos del source: códigos estables y rutas en main.go
// -----------------------------------------------------------------------------

func TestPosQrHandler_CodigosEstables_Asignacion(t *testing.T) {
	src := handlerQrSource(t)
	for _, code := range []string{
		"ErrCodeQREventNotFound",
		"ErrCodeQREventAlreadyAssigned",
		"ErrCodeQRAmountMismatch",
	} {
		if !strings.Contains(src, code) {
			t.Errorf("handler debe referenciar la constante %s", code)
		}
	}
}

func TestPosQrHandler_RutasAsignacionEnMain(t *testing.T) {
	root := filepath.Join("..", "..", "..", "cmd", "api", "main.go")
	bts, err := os.ReadFile(root)
	if err != nil {
		t.Skipf("No se pudo leer %s: %v", root, err)
	}
	src := string(bts)
	for _, pattern := range []string{
		`posQr.GET("/pagos-sin-asignar"`,
		`posQr.POST("/asignar"`,
		`posQrHandler.PagosSinAsignar`,
		`posQrHandler.Asignar`,
	} {
		if !strings.Contains(src, pattern) {
			t.Errorf("main.go debe registrar %q", pattern)
		}
	}
}

// TestPosQrHandler_Asignar_NoLeeDniDelBody: el handler NUNCA debe
// aceptar un DNI/empleado como campo del body de asignar. El DNI
// auditor sale sólo del contexto JWT.
func TestPosQrHandler_Asignar_NoLeeDniDelBody(t *testing.T) {
	src := handlerQrSource(t)
	// Buscar bloque de Asignar.
	idx := strings.Index(src, "func (h *PosQrHandler) Asignar(c *gin.Context)")
	if idx < 0 {
		t.Fatal("no se encontró Asignar")
	}
	end := idx + 4000
	if end > len(src) {
		end = len(src)
	}
	block := src[idx:end]
	for _, forbidden := range []string{
		"body.Dni", "body.DNI", "body.ActorDni",
		"body.AuthorizedByDNI", "body.EmployeeDni",
	} {
		if strings.Contains(block, forbidden) {
			t.Errorf("Asignar NO debe usar %q como DNI auditor", forbidden)
		}
	}
}

// TestPosQrHandler_Iniciar_ExponeSameAmountPending verifica que el
// contrato camelCase del response de /iniciar incluye el nuevo campo.
func TestPosQrHandler_Iniciar_ExponeSameAmountPending(t *testing.T) {
	src := handlerQrSource(t)
	if !strings.Contains(src, `json:"sameAmountPending"`) {
		t.Error(`iniciarResponse debe exponer json:"sameAmountPending"`)
	}
	if !strings.Contains(src, `"sameAmountPending":`) {
		t.Error(`la respuesta de /encolar debe incluir "sameAmountPending"`)
	}
}

// TestPosQrHandler_PagosSinAsignar_ContratoCamelCase: el shape del
// response es el contrato con la bandeja frontend.
func TestPosQrHandler_PagosSinAsignar_ContratoCamelCase(t *testing.T) {
	src := handlerQrSource(t)
	for _, needed := range []string{
		`json:"eventId"`,
		`json:"amountCop"`,
		`json:"receivedAt"`,
		`json:"status"`,
		`json:"resumen,omitempty"`,
	} {
		if !strings.Contains(src, needed) {
			t.Errorf("pagosSinAsignarItem debe incluir %s", needed)
		}
	}
}
