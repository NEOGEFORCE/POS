// Pruebas estáticas y de contrato del handler para el guardia
// AlreadyPaid introducido tras el bug productivo:
//
//   - iniciarResponse incluye json:"alreadyPaid", json:"saleId",
//     json:"amountCop" (camelCase, contrato con el modal).
//
//   - El handler usa models.ErrCodeQRIntentAlreadyPaid en /encolar y
//     /asignar.
//
//   - En /encolar y /asignar, el flujo errors.As(err, &paidErr) debe
//     existir en el source (patrón de propagación del saleId).
//
//   - El código estable QR_INTENT_ALREADY_PAID aparece en el fuente
//     (contrato con FrontPOS-main/src/lib/bold-qr-helpers.mjs).
//
// Las pruebas E2E con hub real viven en pos_qr_handler_test.go o en
// una batería de integración futura.

package handlers

import (
	"strings"
	"testing"
)

// TestPosQrHandler_IniciarResponse_IncluyeAlreadyPaid: el contrato
// camelCase del response de /iniciar debe exponer alreadyPaid,
// saleId y amountCop (omitempty permitido). Un rename rompería el
// modal del frontend.
func TestPosQrHandler_IniciarResponse_IncluyeAlreadyPaid(t *testing.T) {
	src := handlerQrSource(t)
	for _, needed := range []string{
		`json:"alreadyPaid,omitempty"`,
		`json:"saleId,omitempty"`,
		`json:"amountCop,omitempty"`,
	} {
		if !strings.Contains(src, needed) {
			t.Errorf("iniciarResponse debe exponer %s (contrato con el modal frontend)", needed)
		}
	}
}

// TestPosQrHandler_CodigoAlreadyPaidReferenciado: el handler debe
// referenciar models.ErrCodeQRIntentAlreadyPaid (constante del
// dominio) en al menos dos rutas: /encolar y /asignar.
func TestPosQrHandler_CodigoAlreadyPaidReferenciado(t *testing.T) {
	src := handlerQrSource(t)
	// Debe aparecer al menos dos veces: una en /encolar, otra en /asignar.
	count := strings.Count(src, "models.ErrCodeQRIntentAlreadyPaid")
	if count < 2 {
		t.Errorf("el handler debe referenciar models.ErrCodeQRIntentAlreadyPaid en /encolar y /asignar; apariciones=%d", count)
	}
}

// TestPosQrHandler_UsaErrorsAsParaExtraerSaleId: el patrón
// `errors.As(err, &paidErr)` debe existir en los dos endpoints que
// bloquean AlreadyPaid.
func TestPosQrHandler_UsaErrorsAsParaExtraerSaleId(t *testing.T) {
	src := handlerQrSource(t)
	// `var paidErr *services.IntentAlreadyPaidError` + `errors.As(err, &paidErr)`
	// deben aparecer al menos dos veces (uno en Encolar, otro en Asignar).
	countDecl := strings.Count(src, "*services.IntentAlreadyPaidError")
	if countDecl < 2 {
		t.Errorf("el handler debe declarar *services.IntentAlreadyPaidError en /encolar y /asignar; apariciones=%d", countDecl)
	}
	countAs := strings.Count(src, "errors.As(err, &paidErr)")
	if countAs < 2 {
		t.Errorf("el handler debe usar errors.As para extraer el saleId; apariciones=%d", countAs)
	}
}

// TestPosQrHandler_EncolarResponsePaidIncluyeSaleId: el response 409
// de /encolar debe exponer `saleId` cuando SaleID > 0. Guardián
// estático sobre la plantilla gin.H.
func TestPosQrHandler_EncolarResponsePaidIncluyeSaleId(t *testing.T) {
	src := handlerQrSource(t)
	// Buscamos la rama paidErr dentro del handler. Debe asignar saleId.
	if !strings.Contains(src, `resp["saleId"] = paidErr.SaleID`) {
		t.Error("el handler debe asignar saleId al response cuando paidErr.SaleID > 0")
	}
	if !strings.Contains(src, `"amountCop": paidErr.AmountCOP`) {
		t.Error("el handler debe incluir amountCop en el response de AlreadyPaid")
	}
}

// TestPosQrHandler_ConstantsAlreadyPaidExiste: la constante del
// dominio tiene el valor estable esperado por el frontend.
func TestPosQrHandler_ConstantsAlreadyPaidExiste(t *testing.T) {
	// Esta prueba vive aquí (handlers) para alertar al revisor que
	// cualquier cambio del valor literal rompe el UX. La verificación
	// de IGUALDAD del valor literal vive en el paquete models.
	src := handlerQrSource(t)
	if !strings.Contains(src, "models.ErrCodeQRIntentAlreadyPaid") {
		t.Error("el handler debe referenciar la constante models.ErrCodeQRIntentAlreadyPaid")
	}
}
