package handlers

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func ginParam(key, value string) gin.Param { return gin.Param{Key: key, Value: value} }

func TestPosQrHandler_VentasCandidatas_CajeroRecibe403(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/pagos-sin-asignar/38/ventas", "")
	c.Set("userDni", "EMP-1")
	c.Set("role", "empleado")
	c.Params = append(c.Params, ginParam("eventId", "38"))
	h.VentasCandidatas(c)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cajero debe 403, got %d (%s)", rec.Code, rec.Body.String())
	}
}

func TestPosQrHandler_VentasCandidatas_EventoInvalido400(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/pagos-sin-asignar/abc/ventas", "")
	c.Set("userDni", "ADMIN-1")
	c.Params = append(c.Params, ginParam("eventId", "abc"))
	h.VentasCandidatas(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("eventId inválido debe 400, got %d", rec.Code)
	}
}

func TestPosQrHandler_EnlazarVenta_Validaciones(t *testing.T) {
	h := &PosQrHandler{}
	// Sin sesión.
	c, rec := newQrTestContext(http.MethodPost, "/api/pos/pagos-qr/enlazar-venta", `{"event_id":38,"sale_id":33376}`)
	h.EnlazarVenta(c)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("sin sesión debe 401, got %d", rec.Code)
	}
	// Faltan campos.
	c, rec = newQrTestContext(http.MethodPost, "/api/pos/pagos-qr/enlazar-venta", `{"event_id":38}`)
	c.Set("userDni", "ADMIN-1")
	h.EnlazarVenta(c)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("sin sale_id debe 400, got %d", rec.Code)
	}
	// Cajero.
	c, rec = newQrTestContext(http.MethodPost, "/api/pos/pagos-qr/enlazar-venta", `{"event_id":38,"sale_id":33376}`)
	c.Set("userDni", "EMP-1")
	c.Set("role", "empleado")
	h.EnlazarVenta(c)
	if rec.Code != http.StatusForbidden {
		t.Errorf("cajero debe 403, got %d", rec.Code)
	}
}

func TestPosQrHandler_RutasEnlaceSoloAdmin(t *testing.T) {
	bts, err := os.ReadFile(filepath.Join("..", "..", "..", "cmd", "api", "main.go"))
	if err != nil {
		t.Skipf("no se pudo leer main.go: %v", err)
	}
	src := string(bts)
	for _, p := range []string{
		`posQrAdmin.GET("/pagos-sin-asignar/:eventId/ventas", posQrHandler.VentasCandidatas)`,
		`posQrAdmin.POST("/enlazar-venta", posQrHandler.EnlazarVenta)`,
	} {
		if !strings.Contains(src, p) {
			t.Errorf("main.go debe registrar %s en el grupo admin", p)
		}
	}
}
