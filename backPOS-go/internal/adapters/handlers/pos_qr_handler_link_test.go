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

func TestPosQrHandler_Editar_Validaciones(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodPost, "/api/pos/pagos-qr/editar", `{"venta_temp_id":"temp-x-123456"}`)
	h.Editar(c)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("sin sesión debe 401, got %d", rec.Code)
	}
	c, rec = newQrTestContext(http.MethodPost, "/api/pos/pagos-qr/editar", `{}`)
	c.Set("userDni", "EMP-1")
	h.Editar(c)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("sin venta_temp_id debe 400, got %d", rec.Code)
	}
}

func TestPosQrHandler_RutaEditarRegistrada(t *testing.T) {
	bts, err := os.ReadFile(filepath.Join("..", "..", "..", "cmd", "api", "main.go"))
	if err != nil {
		t.Skipf("no se pudo leer main.go: %v", err)
	}
	if !strings.Contains(string(bts), `posQr.POST("/editar", posQrHandler.Editar)`) {
		t.Error("main.go debe registrar POST /pos/pagos-qr/editar")
	}
}

func TestAbonoQR_HelpersDeValidacion(t *testing.T) {
	if got := extractAbonoClientDNIFromTotals([]byte(`{"abonoClientDni":"123"}`)); got != "123" {
		t.Errorf("dni = %q", got)
	}
	if got := extractAbonoClientDNIFromTotals([]byte(`{"abonoClientDni":"0"}`)); got != "" {
		t.Errorf("consumidor final no es abono: %q", got)
	}
	if extraChannelsInTotals([]byte(`{"totalAmount":20000,"transferAmount":20000}`)) {
		t.Error("solo QR no tiene canales extra")
	}
	if !extraChannelsInTotals([]byte(`{"totalAmount":20000,"cashAmount":5000,"transferAmount":15000}`)) {
		t.Error("efectivo + QR sí tiene canal extra")
	}
	// El sale_payload plano conserva abonoClientDni en el totals snapshot.
	raw := []byte(`{"details":[{"barcode":"ABONO","quantity":1,"unitPrice":20000,"subtotal":20000}],"totalAmount":20000,"transferAmount":20000,"transferSource":"DAVIPLATA","abonoClientDni":"123"}`)
	snaps, err := extractQRSnapshotsFromPayload(raw, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if extractAbonoClientDNIFromTotals(snaps.Totals) != "123" {
		t.Errorf("abonoClientDni perdido: %s", snaps.Totals)
	}
	if err := validateQRPaymentBreakdown(snaps.Totals, snaps.Cart, 20000); err != nil {
		t.Errorf("abono por QR completo debe validar: %v", err)
	}
}
