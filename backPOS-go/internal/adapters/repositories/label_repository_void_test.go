package repositories

import (
	"regexp"
	"strings"
	"testing"
)

// ============================================================================
// Guardianes de las nuevas puertas del label repository (fix 2026-10-04):
//
//   - VoidCode escribe `voided_at` y `voided_by_dni` ATÓMICAMENTE para
//     respetar el CHECK ck_label_codes_void_dni de la migración 016.
//     Es idempotente y se cierra en una transacción.
//
//   - EnsureCodeForProduct corre el lookup y el INSERT dentro de la
//     MISMA transacción con lock (SHARE), para que dos pestañas abiertas
//     en el mismo barcode no generen dos label_codes distintos. Mitiga
//     la ausencia de un UNIQUE parcial sobre product_barcode.
//
//   - IsSaleOwnedByCashier filtra por (id, employeeDni) y existe para
//     que /cash-drawer/open no acepte saleId de otros cajeros.
// ============================================================================

func TestLabelRepo_VoidCode_EsIdempotenteYEstaTransaccional(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")

	// Delimitamos el cuerpo de VoidCode para fijar sus invariantes sin
	// que las coincidencias se escapen a otros métodos.
	patron := regexp.MustCompile(`(?s)func\s+\(r\s+\*LabelRepository\)\s+VoidCode\s*\([^)]*\)\s*\([^)]*\)\s*\{`)
	loc := patron.FindStringIndex(src)
	if loc == nil {
		t.Fatal("VoidCode debe existir en label_repository.go (fix 2026-10-04)")
	}
	// Capturamos hasta el próximo "func " del paquete.
	rest := src[loc[0]:]
	nextFunc := strings.Index(rest[1:], "\nfunc ")
	if nextFunc < 0 {
		t.Fatal("no se pudo delimitar el final de VoidCode")
	}
	body := rest[:nextFunc+1]

	// La operación debe ser transaccional: una sola llamada a Transaction
	// alrededor del SELECT y el UPDATE.
	if !strings.Contains(body, "r.db.WithContext(ctx).Transaction") {
		t.Error("VoidCode debe correr dentro de r.db.WithContext(ctx).Transaction para que el UPDATE no viole el CHECK ck_label_codes_void_dni")
	}
	// Debe actualizar ambas columnas (CHECK ck_label_codes_void_dni
	// exige que si voided_at NOT NULL entonces voided_by_dni NOT NULL).
	if !strings.Contains(body, `"voided_at"`) || !strings.Contains(body, `"voided_by_dni"`) {
		t.Error("VoidCode debe escribir voided_at Y voided_by_dni en el mismo UPDATE")
	}
	// Y debe filtrar por `voided_at IS NULL` en el UPDATE para que la
	// segunda invocación no toque la fila (idempotencia).
	if !strings.Contains(body, `voided_at IS NULL`) {
		t.Error("VoidCode debe filtrar `voided_at IS NULL` en el UPDATE para ser idempotente")
	}
	// Fail-fast si falta code o actor.
	if !strings.Contains(body, "code requerido") {
		t.Error("VoidCode debe validar `code` requerido")
	}
	if !strings.Contains(body, "actorDNI requerido") {
		t.Error("VoidCode debe validar `actorDNI` requerido")
	}
}

func TestLabelRepo_EnsureCode_LookupBajoLockEnLaMismaTransaccion(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")
	// Delimitamos el cuerpo de EnsureCodeForProduct.
	patron := regexp.MustCompile(`(?s)func\s+\(r\s+\*LabelRepository\)\s+EnsureCodeForProduct\s*\(`)
	loc := patron.FindStringIndex(src)
	if loc == nil {
		t.Fatal("EnsureCodeForProduct no encontrado")
	}
	rest := src[loc[0]:]
	nextFunc := strings.Index(rest[1:], "\nfunc ")
	if nextFunc < 0 {
		t.Fatal("no se pudo delimitar el final de EnsureCodeForProduct")
	}
	body := rest[:nextFunc+1]

	// La transacción debe envolver el SELECT previo + el INSERT.
	txIdx := strings.Index(body, "r.db.WithContext(ctx).Transaction")
	if txIdx < 0 {
		t.Fatal("EnsureCodeForProduct debe correr dentro de Transaction")
	}
	// El advisory lock por barcode debe tomarse dentro de la tx y ANTES
	// del lookup: FOR SHARE no serializa cuando aún no existe fila.
	lockIdx := strings.Index(body, "lockProductBarcodeTx(tx, normalized)")
	lookupIdx := strings.Index(body, `"product_barcode = ? AND voided_at IS NULL"`)
	if lockIdx < 0 || lockIdx < txIdx {
		t.Error("EnsureCodeForProduct debe tomar lockProductBarcodeTx(tx, normalized) dentro de la transacción")
	} else if lookupIdx >= 0 && lockIdx > lookupIdx {
		t.Error("el advisory lock debe tomarse ANTES de buscar el label_code existente")
	}
	// Y el filtro mínimo del lookup previo debe seguir presente.
	if !regexp.MustCompile(`Where\(\s*"product_barcode\s*=\s*\?\s*AND\s*voided_at\s*IS\s*NULL"`).MatchString(body) {
		t.Error("EnsureCodeForProduct debe filtrar por product_barcode + voided_at IS NULL en el lookup previo")
	}
	// Y debe terminar con el Create del label_code (que invoca
	// generateUniqueCodeTx + tx.Create).
	if !strings.Contains(body, "generateUniqueCodeTx(ctx, tx, normalized)") {
		t.Error("EnsureCodeForProduct debe generar el código único dentro de la MISMA transacción (`generateUniqueCodeTx(ctx, tx, ...)`)")
	}
}

func TestLabelRepo_IsSaleOwnedByCashier_FiltraPorEmpleadoDni(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")
	patron := regexp.MustCompile(`(?s)func\s+\(r\s+\*LabelRepository\)\s+IsSaleOwnedByCashier\s*\(`)
	loc := patron.FindStringIndex(src)
	if loc == nil {
		t.Fatal("IsSaleOwnedByCashier no encontrado (fix 2026-10-04 brecha cash_drawer_opens.sale_id)")
	}
	rest := src[loc[0]:]
	// IsSaleOwnedByCashier puede ser el último método del archivo. Si no
	// hay próximo `\nfunc `, tomamos hasta el `var _ = clause.OnConflict`
	// (sentinela de fin del paquete) o hasta el EOF.
	nextFunc := strings.Index(rest[1:], "\nfunc ")
	var body string
	if nextFunc >= 0 {
		body = rest[:nextFunc+1]
	} else if sentinel := strings.Index(rest, "\nvar _ = clause"); sentinel >= 0 {
		body = rest[:sentinel]
	} else {
		body = rest
	}
	// Debe filtrar simultáneamente por id (venta) Y por employeeDni
	// (cajero actor), no sólo por id.
	if !strings.Contains(body, `"employeeDni"`) {
		t.Error("IsSaleOwnedByCashier debe filtrar por `\"employeeDni\"` para que un cajero no pueda citar la venta de otro")
	}
	if !strings.Contains(body, "deleted_at IS NULL") {
		t.Error("IsSaleOwnedByCashier debe excluir ventas borradas (deleted_at IS NULL) para no legitimar aperturas sobre ventas canceladas")
	}

	// La tabla `sales` tiene su clave primaria en la columna quoted
	// `"saleId"` (ver models.Sale.SaleID con tag `column:saleId`). Un
	// `WHERE id = ?` NO filtra: `id` no existe en esta tabla y la
	// consulta rompería en runtime, dejando el cross-check inútil.
	// El guardián falla si alguien vuelve a introducir `id =` sin la
	// comilla doble.
	if !strings.Contains(body, `"saleId" = ?`) {
		t.Error(`IsSaleOwnedByCashier debe filtrar por la columna real "saleId" (quoted camelCase); la columna id no existe en sales y la consulta devolvería un error de Postgres`)
	}
	// Rechazo explícito del patrón incorrecto que ya existió. Evita
	// regresiones silenciosas: cualquier fragmento `id = ?` sin comilla
	// doble en el cuerpo del método rompe este guardián.
	if regexp.MustCompile(`[^"]id\s*=\s*\?`).MatchString(body) {
		t.Error(`IsSaleOwnedByCashier NO debe filtrar por una columna "id" cruda; la clave primaria de sales se llama "saleId" (quoted)`)
	}
}

// --- Guardianes de rutas y handlers reciénes agregados ---

func TestLabelHandler_RutasVoidYMarkPrintJobRegistradas(t *testing.T) {
	// Confirmación estática de que main.go registra las nuevas rutas:
	// POST /labels/codes/:code/void (admin) y PATCH
	// /labels/print-jobs/:id/status (empleado+admin). Si alguien renombra
	// o quita el handler, el test se rompe antes del deploy.
	bts := readMainGo(t)
	src := string(bts)
	if !regexp.MustCompile(`labelsAdmin\.POST\("\s*/codes/:code/void\s*",\s*labelHandler\.VoidCode\)`).MatchString(src) {
		t.Error("main.go debe registrar POST /labels/codes/:code/void (admin) con labelHandler.VoidCode")
	}
	if !regexp.MustCompile(`labels\.PATCH\("\s*/print-jobs/:id/status\s*",\s*labelHandler\.MarkPrintJobStatus\)`).MatchString(src) {
		t.Error("main.go debe registrar PATCH /labels/print-jobs/:id/status con labelHandler.MarkPrintJobStatus")
	}
}

func readMainGo(t *testing.T) []byte {
	t.Helper()
	// El test corre desde internal/adapters/repositories, así que subimos
	// 3 niveles para llegar a cmd/api/main.go.
	path := "../../../cmd/api/main.go"
	return []byte(leerArchivoDePaquete(t, path))
}
