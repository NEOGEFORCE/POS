package handlers

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// =============================================================================
// Guardianes estáticos del handler para la rama POSINT de /labels/codes.
//
// El handler no discrimina por namespace: delega en el repo. Verificamos
// que la decodificación del request mantenga el barcode intacto (sólo
// TrimSpace) y que las rutas registradas en main.go NO introduzcan
// filtros que pudieran bloquear un POSINT-<hex> antes de llegar al repo.
// =============================================================================

func TestEnsureCode_HandlerPropagaBarcodeSinNormalizarAntesDelRepo(t *testing.T) {
	src := readFile(t, "label_handler.go")

	// El handler de EnsureCode debe pasar el barcode al repo con sólo
	// TrimSpace: la normalización POSINT (ToUpper) corre dentro del repo
	// vía models.NormalizeInternalBarcode para empatar con el
	// strings.ToUpper de product_handler.Create.
	patron := regexp.MustCompile(`(?s)func\s+\(h\s+\*LabelHandler\)\s+EnsureCode\s*\(c\s+\*gin\.Context\)\s*\{.*?\n\}\s*\n`)
	body := patron.FindString(src)
	if body == "" {
		t.Fatal("no se pudo delimitar EnsureCode en label_handler.go")
	}

	// La llamada debe pasar strings.TrimSpace(req.ProductBarcode); no
	// ToUpper, no ToLower, no regex de rechazo. Si alguien filtra POSINT
	// aquí, el flujo audit-first para productos internos se rompe.
	if !regexp.MustCompile(`EnsureCodeForProduct\(\s*c\.Request\.Context\(\),\s*strings\.TrimSpace\(req\.ProductBarcode\)`).MatchString(body) {
		t.Error("EnsureCode debe delegar en repo.EnsureCodeForProduct(ctx, strings.TrimSpace(req.ProductBarcode), ...) sin filtrar el namespace POSINT-")
	}
	// Rechazo defensivo: el handler NO debe convertir a mayúsculas antes
	// de llamar al repo (eso duplicaría lo que ya hace el repo para
	// POSINT y potencialmente alteraría barcodes comerciales case-
	// sensitive).
	if strings.Contains(body, "strings.ToUpper(req.ProductBarcode)") {
		t.Error("EnsureCode NO debe aplicar ToUpper al barcode: la normalización POSINT la hace el repo; alterar un barcode comercial case-sensitive rompería el lookup")
	}
}

func TestEnsureCode_RutaRegistradaEnMain(t *testing.T) {
	root := filepath.Join("..", "..", "..", "cmd", "api", "main.go")
	bts, err := os.ReadFile(root)
	if err != nil {
		t.Skipf("no se pudo leer %s: %v", root, err)
	}
	src := string(bts)
	// POST /labels/codes está en el grupo general (empleado+admin): un
	// cajero puede pedir la etiqueta de un producto interno POSINT desde
	// LabelPrintSheet sin pasar por admin.
	if !regexp.MustCompile(`labels\.POST\("\s*/codes\s*",\s*labelHandler\.EnsureCode\)`).MatchString(src) {
		t.Error(`main.go debe registrar POST /labels/codes → labelHandler.EnsureCode dentro del grupo labels (empleado+admin)`)
	}
	// POST /labels/print-jobs debe seguir disponible: el audit-first
	// requiere que tras recibir el label_code (sea LC- o POSINT-) el
	// front pueda emitir el print job.
	if !regexp.MustCompile(`labels\.POST\("\s*/print-jobs\s*",\s*labelHandler\.RecordPrint\)`).MatchString(src) {
		t.Error(`main.go debe registrar POST /labels/print-jobs → labelHandler.RecordPrint`)
	}
	// GET /labels/codes/resolve también se usa al escanear la etiqueta
	// POSINT impresa: ResolveLabelCode hace el JOIN products.barcode =
	// label_codes.product_barcode. La ruta general cubre ambos
	// namespaces (LC- y POSINT-).
	if !regexp.MustCompile(`labels\.GET\("\s*/codes/resolve\s*",\s*labelHandler\.ResolveCode\)`).MatchString(src) {
		t.Error(`main.go debe registrar GET /labels/codes/resolve → labelHandler.ResolveCode`)
	}
}
