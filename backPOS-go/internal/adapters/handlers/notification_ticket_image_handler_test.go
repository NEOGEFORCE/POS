package handlers

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// VALIDACION DE PNG POR FIRMA
// ============================================================================
//
// La proteccion mas importante del endpoint /telegram/ticket-image: aceptar
// SOLO PNG, por firma binaria y no por extension/MIME. El MIME se falsifica
// trivialmente; la firma no.

func TestValidateTicketImageBytes_AceptaPNGMinimo(t *testing.T) {
	t.Parallel()
	// Un PNG valido en bytes: firma + 4 bytes extra. No tiene que ser una
	// imagen renderizable, el objetivo es validar la firma.
	data := append([]byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}, 0x00, 0x00, 0x00, 0x00)
	if err := validateTicketImageBytes(data); err != nil {
		t.Fatalf("PNG valido rechazado: %v", err)
	}
}

func TestValidateTicketImageBytes_RechazaOtrosFormatos(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		data []byte
	}{
		{"JPEG", []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46}},
		{"GIF87", []byte("GIF87a1234")},
		{"BMP", []byte{0x42, 0x4D, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}},
		{"PDF", []byte("%PDF-1.4\n")},
		{"HTML", []byte("<html><body>x</body></html>")},
		{"Zip", []byte{0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00}},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if err := validateTicketImageBytes(tt.data); err == nil {
				t.Fatalf("se esperaba rechazo de %s", tt.name)
			}
		})
	}
}

func TestValidateTicketImageBytes_RechazaVacioOCorto(t *testing.T) {
	t.Parallel()
	if err := validateTicketImageBytes(nil); err == nil {
		t.Fatal("se esperaba rechazo de slice nil")
	}
	if err := validateTicketImageBytes([]byte{}); err == nil {
		t.Fatal("se esperaba rechazo de slice vacio")
	}
	// Buffer con menos bytes que la firma completa.
	if err := validateTicketImageBytes([]byte{0x89, 0x50, 0x4E}); err == nil {
		t.Fatal("se esperaba rechazo de buffer mas corto que la firma")
	}
}

func TestValidateTicketImageBytes_RechazaMayoresAlLimite(t *testing.T) {
	t.Parallel()
	// Un buffer que supera el limite por 1 byte, pero empieza con firma PNG:
	// la validacion de tamano gana sobre la de firma.
	big := make([]byte, maxTicketImageBytes+1)
	copy(big, pngFileSignature)
	if err := validateTicketImageBytes(big); err == nil {
		t.Fatal("se esperaba rechazo por tamano")
	}
}

func TestLooksLikePNGExtension(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"recibo.png", "recibo.PNG", "mi.recibo.PNG"} {
		if !looksLikePNGExtension(name) {
			t.Errorf("%q deberia aceptarse como PNG", name)
		}
	}
	for _, name := range []string{"recibo.jpg", "recibo", "recibo.pdf"} {
		if looksLikePNGExtension(name) {
			t.Errorf("%q no deberia aceptarse como PNG", name)
		}
	}
}

func TestLooksLikePNGContentType(t *testing.T) {
	t.Parallel()
	ok := []string{
		"image/png",
		"IMAGE/PNG",
		"image/png; name=recibo.png",
		"", // ausente: la firma final valida.
	}
	for _, ct := range ok {
		if !looksLikePNGContentType(ct) {
			t.Errorf("ct=%q deberia aceptarse", ct)
		}
	}
	rechazar := []string{"image/jpeg", "application/pdf", "text/html"}
	for _, ct := range rechazar {
		if looksLikePNGContentType(ct) {
			t.Errorf("ct=%q no deberia aceptarse", ct)
		}
	}
}

// ============================================================================
// HANDLER /telegram/ticket-image - CONTRATO MULTIPART
// ============================================================================
//
// Estos tests arrancan el handler con un NotificationHandler SIN
// TelegramService — la respuesta esperada en ese caso es 503. El objetivo es
// cubrir todas las ramas de validacion previas al envio.

func buildPNGMultipart(t *testing.T, filename string, contentType string, body []byte, caption string) (*bytes.Buffer, string) {
	t.Helper()
	buf := &bytes.Buffer{}
	w := multipart.NewWriter(buf)
	if filename != "" {
		h := make(map[string][]string)
		if contentType != "" {
			h["Content-Type"] = []string{contentType}
		}
		part, err := w.CreatePart(map[string][]string{
			"Content-Disposition": {`form-data; name="image"; filename="` + filename + `"`},
			"Content-Type":        {contentType},
		})
		if err != nil {
			t.Fatalf("CreatePart: %v", err)
		}
		if _, err := part.Write(body); err != nil {
			t.Fatalf("Write body: %v", err)
		}
	}
	if caption != "" {
		if err := w.WriteField("caption", caption); err != nil {
			t.Fatalf("WriteField: %v", err)
		}
	}
	w.Close()
	return buf, w.FormDataContentType()
}

func newTicketImageRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	// Pasamos nil al TelegramService: la validacion debe ocurrir ANTES de
	// consultarlo, asi que todos los errores de payload responden como se
	// espera sin tocar el servicio.
	h := &NotificationHandler{telegramService: nil}
	r.POST("/telegram/ticket-image", h.SendTicketImageToTelegram)
	return r
}

func TestSendTicketImageToTelegram_RechazaSinArchivo(t *testing.T) {
	// Multipart sin el campo image.
	buf := &bytes.Buffer{}
	w := multipart.NewWriter(buf)
	w.WriteField("caption", "test")
	w.Close()

	req := httptest.NewRequest(http.MethodPost, "/telegram/ticket-image", buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rr := httptest.NewRecorder()
	newTicketImageRouter().ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rr.Code, rr.Body.String())
	}
}

func TestSendTicketImageToTelegram_RechazaExtensionNoPNG(t *testing.T) {
	png := append([]byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}, 0x00, 0x00, 0x00, 0x00)
	buf, ct := buildPNGMultipart(t, "recibo.jpg", "image/jpeg", png, "")
	req := httptest.NewRequest(http.MethodPost, "/telegram/ticket-image", buf)
	req.Header.Set("Content-Type", ct)
	rr := httptest.NewRecorder()
	newTicketImageRouter().ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "PNG") {
		t.Errorf("body deberia mencionar PNG; got %s", rr.Body.String())
	}
}

func TestSendTicketImageToTelegram_RechazaFirmaInvalida(t *testing.T) {
	// Extension y content-type correctos, pero el contenido es JPEG.
	jpg := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46}
	buf, ct := buildPNGMultipart(t, "recibo.png", "image/png", jpg, "")
	req := httptest.NewRequest(http.MethodPost, "/telegram/ticket-image", buf)
	req.Header.Set("Content-Type", ct)
	rr := httptest.NewRecorder()
	newTicketImageRouter().ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rr.Code, rr.Body.String())
	}
}

func TestSendTicketImageToTelegram_PNGValidoLlegaAlServicio(t *testing.T) {
	// Un PNG valido con bytes de firma + minimo chunk IHDR falso. No se
	// renderiza, solo se valida.
	png := append([]byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}, 0x00, 0x00, 0x00, 0x00)
	buf, ct := buildPNGMultipart(t, "recibo.png", "image/png", png, "venta #99")
	req := httptest.NewRequest(http.MethodPost, "/telegram/ticket-image", buf)
	req.Header.Set("Content-Type", ct)
	rr := httptest.NewRecorder()
	newTicketImageRouter().ServeHTTP(rr, req)

	// Con TelegramService nil -> 503. El PNG valido pasa todas las
	// validaciones y llega a la rama donde falta el servicio.
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (sin telegram configurado); body=%s", rr.Code, rr.Body.String())
	}
}

func TestSendTicketImageToTelegram_RechazaCuerpoDemasiadoGrande(t *testing.T) {
	// Un PNG con cuerpo >= limite + 1. No se escanea completamente, el
	// handler lee hasta +1 y aborta.
	huge := make([]byte, maxTicketImageBytes+1024)
	copy(huge, pngFileSignature)
	buf, ct := buildPNGMultipart(t, "recibo.png", "image/png", huge, "")
	req := httptest.NewRequest(http.MethodPost, "/telegram/ticket-image", buf)
	req.Header.Set("Content-Type", ct)
	rr := httptest.NewRecorder()
	newTicketImageRouter().ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 por tamano; body=%s", rr.Code, rr.Body.String())
	}
}
