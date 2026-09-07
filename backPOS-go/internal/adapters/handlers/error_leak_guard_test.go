package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// Marcas que jamás pueden aparecer en el cuerpo de una respuesta de error.
// Cada una revela algo del motor: el código SQLSTATE, el prefijo del driver
// lib/pq, el nombre del ORM o los nombres reales de columnas del esquema.
var leakMarkers = []string{"SQLSTATE", "pq:", "gorm", "column"}

func init() {
	gin.SetMode(gin.TestMode)
}

func invokeSendError(t *testing.T, status int, code, message string, errOrMeta any) (int, string) {
	t.Helper()
	// El detalle técnico SÍ debe ir al log del servidor; sólo lo silenciamos
	// aquí para no ensuciar la salida del test.
	log.SetOutput(io.Discard)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/x", nil)
	SendError(c, status, code, message, errOrMeta)
	return rec.Code, rec.Body.String()
}

func assertNoLeak(t *testing.T, body string) {
	t.Helper()
	lower := strings.ToLower(body)
	for _, marker := range leakMarkers {
		if strings.Contains(lower, strings.ToLower(marker)) {
			t.Errorf("la respuesta filtró la marca técnica %q: %s", marker, body)
		}
	}
}

// TestSendError_NoFiltraTextoCrudoDelDriver es el guardián del bug: el handler
// de productos devolvía err.Error() crudo "temporalmente para diagnóstico" y el
// frontend terminaba mostrando el SQL de Postgres al cajero.
func TestSendError_NoFiltraTextoCrudoDelDriver(t *testing.T) {
	rawErrors := []string{
		`ERROR: column "minStock" of relation "products" does not exist (SQLSTATE 42703)`,
		`pq: null value in column "saleId" violates not-null constraint`,
		`gorm: Error 1054: Unknown column 'foo' in 'field list'`,
		`failed to update: SELECT * FROM products WHERE barcode = $1: SQLSTATE 08006`,
		`dial tcp 127.0.0.1:5432: connect: connection refused`,
		`sql: no rows in result set`,
	}

	for _, raw := range rawErrors {
		status, body := invokeSendError(t, http.StatusInternalServerError,
			ErrInternalServer, "Fallo al actualizar producto", errors.New(raw))

		if status != http.StatusInternalServerError {
			t.Fatalf("status inesperado %d", status)
		}
		assertNoLeak(t, body)

		var parsed ErrorResponse
		if err := json.Unmarshal([]byte(body), &parsed); err != nil {
			t.Fatalf("respuesta no es JSON válido: %v", err)
		}
		if parsed.Success {
			t.Error("una respuesta de error debe traer success=false")
		}
		if parsed.Message == "" {
			t.Error("el usuario siempre debe recibir un mensaje")
		}
		if strings.Contains(parsed.Error.Details, raw) {
			t.Errorf("details repitió el error crudo: %s", parsed.Error.Details)
		}
	}
}

// TestSendError_ConservaMensajesDeNegocio: no basta con censurar todo. Las
// validaciones de dominio son el texto que le explica al operador qué hizo mal,
// y tienen que seguir llegando.
func TestSendError_ConservaMensajesDeNegocio(t *testing.T) {
	businessErrors := []string{
		"el monto del abono debe ser mayor que cero",
		"esta venta no tiene saldo pendiente",
		"el proveedor del egreso no coincide con el de la orden",
		"debe indicar el método del abono",
	}

	for _, msg := range businessErrors {
		_, body := invokeSendError(t, http.StatusBadRequest,
			ErrBadRequest, "Datos inválidos", errors.New(msg))

		var parsed ErrorResponse
		if err := json.Unmarshal([]byte(body), &parsed); err != nil {
			t.Fatalf("respuesta no es JSON válido: %v", err)
		}
		if parsed.Error.Details != msg {
			t.Errorf("se perdió el mensaje de negocio %q; details = %q", msg, parsed.Error.Details)
		}
		assertNoLeak(t, body)
	}
}

// TestSendError_TraduccionAmigablePrevalece: cuando TranslateDBError reconoce el
// error, el usuario debe ver la explicación en español, no el texto de Postgres.
func TestSendError_TraduccionAmigablePrevalece(t *testing.T) {
	err := errors.New(`pq: duplicate key value violates unique constraint "products_pkey" (SQLSTATE 23505)`)
	_, body := invokeSendError(t, http.StatusConflict, ErrDuplicateEntry, "Fallo al guardar", err)

	assertNoLeak(t, body)

	var parsed ErrorResponse
	if e := json.Unmarshal([]byte(body), &parsed); e != nil {
		t.Fatalf("respuesta no es JSON válido: %v", e)
	}
	if parsed.Message != "Registro Duplicado" {
		t.Errorf("se esperaba el título traducido, se obtuvo %q", parsed.Message)
	}
	if parsed.Error.Details == "" {
		t.Error("la traducción debe dejar una explicación para el usuario")
	}
}

// TestSendError_MensajeContaminadoSeReemplaza cubre el caso de un handler que
// construye el message concatenando err.Error(): la fuga entraría por el campo
// message en vez de por details.
func TestSendError_MensajeContaminadoSeReemplaza(t *testing.T) {
	_, body := invokeSendError(t, http.StatusInternalServerError, ErrInternalServer,
		`Fallo al actualizar: pq: column "minStock" does not exist`, nil)

	assertNoLeak(t, body)
}

// TestSendError_MetadataSobrevive: el segundo uso de SendError es pasar metadata
// estructurada (no un error). Ese camino no debe alterarse.
func TestSendError_MetadataSobrevive(t *testing.T) {
	_, body := invokeSendError(t, http.StatusBadRequest, ErrBadRequest,
		"Datos inválidos", map[string]string{"barcode": "es obligatorio"})

	if !strings.Contains(body, "es obligatorio") {
		t.Errorf("se perdió la metadata de validación: %s", body)
	}
	assertNoLeak(t, body)
}
