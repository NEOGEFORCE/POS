package handlers

import (
	"regexp"
	"strings"
	"testing"
)

// =============================================================================
// Guardianes del contrato de auditoría del cajón de dinero.
//
// La UI de ventas puede intentar abrir el cajón automáticamente aunque:
//   - `autoPrint` esté false (el usuario desactivó impresión),
//   - `receipt.deliveryMode` sea `browser` (sin bridge local),
//   - el bridge/driver de impresión esté desconectado.
//
// Esto exige que el handler `POST /api/cash-drawer/open`:
//
//  1. Audite SIEMPRE la apertura antes de responder 200 (vía
//     `RecordCashDrawerOpen`), sin depender de ninguna impresora.
//  2. Avise claramente al cliente que el pulso físico es independiente
//     y se envía por el bridge local, no por este endpoint.
//  3. Nunca referencie una impresora como precondición del éxito. Un
//     fallo lateral del bridge no bloquea ni revierte la venta: el
//     frontend decide si lo intenta o no.
//  4. Mantenga el cross-check de propiedad por `saleId` (ya cubierto
//     por el guardián existente); además, el chequeo debe correr ANTES
//     de intentar escribir la auditoría, para que una venta ajena
//     responda 403 sin generar ruido en `cash_drawer_opens`.
//
// Estos tests son estáticos sobre el fuente del handler para no requerir
// Postgres ni mocks del repo (el repo es concreto). Si se renombran los
// literales de respuesta o se cambia la secuencia, los guardianes avisan
// antes del deploy.
// =============================================================================

// openDrawerBody delimita el cuerpo de `OpenCashDrawer` para que los
// grep se apliquen al método específico. Devuelve el fragmento desde la
// firma hasta la primera `}\n` seguida de un salto a `// --- ` o fin de
// archivo. Es tolerante a formatos ligeramente distintos.
func openDrawerBody(t *testing.T) string {
	t.Helper()
	src := readFile(t, "label_handler.go")
	patron := regexp.MustCompile(`(?s)func\s+\(h\s+\*LabelHandler\)\s+OpenCashDrawer\s*\(c\s+\*gin\.Context\)\s*\{.*?\n\}\s*\n`)
	body := patron.FindString(src)
	if body == "" {
		t.Fatal("no se pudo delimitar el cuerpo de OpenCashDrawer")
	}
	return body
}

// TestOpenCashDrawer_AuditaSiempreAntesDeResponder200: la respuesta 200
// debe venir SIEMPRE después de un `RecordCashDrawerOpen`. Un path que
// responda 200 sin pasar por la auditoría dejaría al cajón abriéndose
// sin trazabilidad, violando el contrato con el frontend que llama este
// endpoint "fire and forget" tras cada venta.
func TestOpenCashDrawer_AuditaSiempreAntesDeResponder200(t *testing.T) {
	body := openDrawerBody(t)

	// Debe haber exactamente un call site de RecordCashDrawerOpen.
	hits := strings.Count(body, "h.repo.RecordCashDrawerOpen(")
	if hits != 1 {
		t.Fatalf("OpenCashDrawer debe llamar h.repo.RecordCashDrawerOpen(...) exactamente una vez; got %d", hits)
	}

	// El único 200 (`http.StatusOK`) del método debe venir DESPUÉS del
	// RecordCashDrawerOpen. Validamos la posición textual.
	recIdx := strings.Index(body, "h.repo.RecordCashDrawerOpen(")
	okIdx := strings.Index(body, "http.StatusOK")
	if okIdx < 0 {
		t.Fatal("OpenCashDrawer debe responder http.StatusOK en el camino exitoso")
	}
	if okIdx < recIdx {
		t.Fatal("OpenCashDrawer debe llamar RecordCashDrawerOpen ANTES de responder 200 (auditoría explícita)")
	}

	// Si RecordCashDrawerOpen falla, debe responder 500 y NO 200.
	if !strings.Contains(body, "http.StatusInternalServerError") {
		t.Error("un fallo de RecordCashDrawerOpen debe responder 500 (no 200)")
	}
}

// TestOpenCashDrawer_NoDependeDeImpresoraOBridge: el endpoint no debe
// referenciar impresora/bridge/driver como precondición del éxito. El
// kickout físico lo manda el bridge local; aquí sólo se audita.
func TestOpenCashDrawer_NoDependeDeImpresoraOBridge(t *testing.T) {
	body := openDrawerBody(t)

	// `driverAvailable` aparece como campo del response para informar
	// al cliente, pero jamás como condición de un `if`. Buscamos
	// cualquier `if ... driverAvailable` / `if !driver...` dentro del
	// cuerpo que gated la auditoría.
	for _, pattern := range []string{
		"if h.printer",
		"if h.driver",
		"if !driverAvailable",
		"if driverAvailable",
		"if printer",
		"if bridge",
	} {
		if strings.Contains(body, pattern) {
			t.Errorf("OpenCashDrawer no debe condicionar el flujo por impresora/bridge; detectado %q", pattern)
		}
	}

	// El response debe seguir mencionando el bridge como canal del
	// pulso físico, para que el frontend sepa que debe invocar
	// `window.posBridge.kickDrawer` por su cuenta.
	if !strings.Contains(body, "driverAvailable") {
		t.Error(`el response debe incluir "driverAvailable" para informar al frontend que el pulso lo manda el bridge`)
	}
	if !strings.Contains(body, "bridge") {
		t.Error("el response debe explicar que el pulso físico requiere el bridge local, para que el frontend lo intente aun con impresión desactivada")
	}
}

// TestOpenCashDrawer_CrossCheckDePropiedadCorreAntesDelInsert: el 403
// `CASH_DRAWER_SALE_NOT_OWNED` debe emitirse ANTES de llegar a
// `RecordCashDrawerOpen`. Si no, un cajero que cite la venta de un
// compañero generaría una fila en `cash_drawer_opens` con la venta
// equivocada, haciendo ruido en la auditoría.
func TestOpenCashDrawer_CrossCheckDePropiedadCorreAntesDelInsert(t *testing.T) {
	body := openDrawerBody(t)

	ownIdx := strings.Index(body, "IsSaleOwnedByCashier(")
	notOwnedIdx := strings.Index(body, `"CASH_DRAWER_SALE_NOT_OWNED"`)
	recIdx := strings.Index(body, "h.repo.RecordCashDrawerOpen(")

	if ownIdx < 0 {
		t.Fatal("OpenCashDrawer debe invocar IsSaleOwnedByCashier (cross-check de propiedad)")
	}
	if notOwnedIdx < 0 {
		t.Fatal("OpenCashDrawer debe emitir CASH_DRAWER_SALE_NOT_OWNED cuando la venta no pertenece al cajero")
	}
	if recIdx < 0 {
		t.Fatal("OpenCashDrawer debe invocar RecordCashDrawerOpen en el camino exitoso")
	}

	if ownIdx > recIdx {
		t.Error("IsSaleOwnedByCashier debe correr ANTES de RecordCashDrawerOpen (fail-fast en 403)")
	}
	if notOwnedIdx > recIdx {
		t.Error("La respuesta CASH_DRAWER_SALE_NOT_OWNED debe emitirse ANTES del RecordCashDrawerOpen para no auditar aperturas espurias")
	}
}

// TestOpenCashDrawer_NoRevierteVenta: el handler jamás debe hacer
// rollback de una venta ni invocar servicios que puedan hacerlo. Es un
// side-channel de auditoría; una venta ya cerrada no debe tocarse por
// fallos aquí.
func TestOpenCashDrawer_NoRevierteVenta(t *testing.T) {
	body := openDrawerBody(t)
	for _, pattern := range []string{
		"saleService",
		"SaleService",
		"VoidSale",
		"CancelSale",
		"RollbackSale",
		"RevertSale",
		"DeleteSale",
	} {
		if strings.Contains(body, pattern) {
			t.Errorf("OpenCashDrawer NO debe tocar la venta (%q): un fallo aquí no debe revertirla", pattern)
		}
	}
}
