package repositories

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// =============================================================================
// Guardianes estáticos del label_repository.
//
// Comprueban que la lógica de colisión del generador de códigos sea
// EXHAUSTIVA (producto.barcode + alternateCodes + label_codes) y que la
// operación sea transaccional. Levantar Postgres en CI es caro; aquí
// garantizamos las invariantes a nivel código.
// =============================================================================

func leerArchivoDePaquete(t *testing.T, name string) string {
	t.Helper()
	path, err := filepath.Abs(name)
	if err != nil {
		t.Fatalf("abs(%s): %v", name, err)
	}
	bts, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read(%s): %v", path, err)
	}
	return string(bts)
}

func TestLabelRepo_GenerateUniqueCode_ConsultaLasTresFuentes(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")

	// Las tres fuentes de colisión deben consultarse en la misma función
	// (codeExistsAnywhereTx). Buscamos las tres tablas:
	for _, token := range []string{
		"Table(\"products\")",
		"alternateCodesContainsSQL",
		"Table(\"label_codes\")",
	} {
		if !strings.Contains(src, token) {
			t.Errorf("codeExistsAnywhereTx debe consultar %q; sin él, puede generarse un código que ya existe en otra tabla.", token)
		}
	}

	// Verificar que la función de generación corre dentro de una
	// transacción explícita (Transaction(func(tx ...))) para evitar race
	// conditions.
	if !strings.Contains(src, "r.db.WithContext(ctx).Transaction") {
		t.Error("EnsureCodeForProduct debe envolver la generación en Transaction(...) para evitar colisiones concurrentes.")
	}
}

func TestLabelRepo_EnsureCodeForProduct_IsIdempotent(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")

	// La idempotencia por producto está en la rama que busca un
	// LabelCode preexistente antes de generar uno nuevo.
	patron := regexp.MustCompile(`Where\(\s*"product_barcode\s*=\s*\?\s*AND\s*voided_at\s*IS\s*NULL"`)
	if !patron.MatchString(src) {
		t.Error("EnsureCodeForProduct debe buscar un LabelCode activo del producto antes de generar uno nuevo; sin esto, reimprimir genera códigos duplicados.")
	}
}

func TestLabelRepo_RecordCashDrawerOpen_ValidaConstraintsAntesDeInsertar(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")

	// El CHECK ck_cash_drawer_opens_sale_or_admin dice: debe haber
	// override_admin OR sale_id OR return_id. Antes del INSERT, el repo
	// debe fallar temprano con error legible si ninguno aplica.
	patron := regexp.MustCompile(`!open\.OverrideAdmin\s*&&\s*open\.SaleID\s*==\s*nil\s*&&\s*open\.ReturnID\s*==\s*nil`)
	if !patron.MatchString(src) {
		t.Error("RecordCashDrawerOpen debe rechazar la apertura sin venta/devolución/override ANTES del INSERT (precondición del CHECK).")
	}
	// Y el segundo CHECK: override implica authorized_by_dni.
	patron2 := regexp.MustCompile(`OverrideAdmin\s*&&\s*strings\.TrimSpace\(open\.AuthorizedByDNI\)\s*==\s*""`)
	if !patron2.MatchString(src) {
		t.Error("RecordCashDrawerOpen debe exigir authorized_by_dni cuando override_admin es TRUE.")
	}
}

func TestLabelRepo_PrintJobLines_ActualizaPrintCountEnTransaccion(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")
	// Al crear el job, deben incrementarse print_count y last_printed_at
	// de cada LabelCode en la misma transacción. Usamos gorm.Expr para el
	// incremento atómico.
	if !strings.Contains(src, "print_count + ?") {
		t.Error("RecordPrintJob debe incrementar print_count atómicamente con gorm.Expr.")
	}
	if !strings.Contains(src, "last_printed_at") {
		t.Error("RecordPrintJob debe sellar last_printed_at al imprimir.")
	}
}

// =============================================================================
// Guardianes de ResolveLabelCode.
//
// Fijan las invariantes de resolución exacta de códigos impresos en caja:
//
//   - Match exacto (NO ILIKE, NO substring).
//   - Respeta voided_at para no resolver etiquetas anuladas.
//   - Excluye códigos "libre" (sin product_barcode).
//   - Es tolerante a la migración 016 no aplicada (to_regclass).
//   - NUNCA toca package_barcode_aliases (invariante crítica: el alias
//     de paquete es exclusivo de recepción).
//   - Es lectura pura: no muta estado dentro del método.
// =============================================================================

// extraerCuerpoResolveLabelCode delimita el cuerpo del método para que
// los grep se apliquen al método específico y no a cualquier otro
// fragmento del archivo.
func extraerCuerpoResolveLabelCode(t *testing.T, src string) string {
	t.Helper()
	patron := regexp.MustCompile(`(?s)func\s+\(r\s+\*LabelRepository\)\s+ResolveLabelCode\s*\([^)]*\)\s*\(\*ResolveLabelResult,\s*error\)\s*\{.*?\n\}\s*\n`)
	match := patron.FindString(src)
	if match == "" {
		t.Fatal("No se pudo delimitar el cuerpo de ResolveLabelCode: ¿se renombró o se removió la función?")
	}
	return match
}

func TestLabelRepo_ResolveLabelCode_UsaMatchExacto(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")
	body := extraerCuerpoResolveLabelCode(t, src)

	// Match exacto: WHERE lc.code = ?. Nada de ILIKE/LIKE dentro del
	// cuerpo del resolver (SearchCodes sí usa ILIKE, pero ese es otro
	// método y queda fuera de este cuerpo).
	if !regexp.MustCompile(`WHERE\s+lc\.code\s*=\s*\?`).MatchString(body) {
		t.Error("ResolveLabelCode debe usar WHERE lc.code = ? (match exacto por PK); sin esto podría resolver múltiples códigos o substrings.")
	}
	if strings.Contains(body, "ILIKE") || regexp.MustCompile(`\bLIKE\b`).MatchString(body) {
		t.Error("ResolveLabelCode NO debe usar ILIKE/LIKE: la caja requiere coincidencia exacta normalizada, no substring.")
	}
}

func TestLabelRepo_ResolveLabelCode_RespetaVoidedAt(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")
	body := extraerCuerpoResolveLabelCode(t, src)
	if !strings.Contains(body, "voided_at IS NULL") {
		t.Error("ResolveLabelCode debe filtrar por voided_at IS NULL: los códigos anulados no deben resolver en caja.")
	}
}

func TestLabelRepo_ResolveLabelCode_ExcluyeCodigosLibre(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")
	body := extraerCuerpoResolveLabelCode(t, src)
	// Códigos "libre" (sin product_barcode) existen para granel/lote
	// interno y no tienen semántica en caja. Deben filtrarse.
	if !strings.Contains(body, "product_barcode IS NOT NULL") {
		t.Error("ResolveLabelCode debe exigir product_barcode IS NOT NULL: los códigos 'libre' no tienen semántica en caja.")
	}
}

func TestLabelRepo_ResolveLabelCode_ToleranteAMigracionAusente(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")
	body := extraerCuerpoResolveLabelCode(t, src)
	// Si la 016 no se aplicó, label_codes no existe. El resolver debe
	// devolver "unknown" sin romper, igual que el resolver de package
	// barcode usa el mismo patrón.
	if !strings.Contains(body, "labelCodesTableExists(") {
		t.Error("ResolveLabelCode debe verificar con labelCodesTableExists (sentencia aparte) para tolerar la migración 016 no aplicada.")
	}
	if !strings.Contains(src, "to_regclass('public.label_codes')") {
		t.Error("labelCodesExistsSQL debe usar to_regclass('public.label_codes').")
	}
}

func TestLabelRepo_ResolveLabelCode_NuncaConsultaPackageAliases(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")
	body := extraerCuerpoResolveLabelCode(t, src)
	// INVARIANTE CRÍTICA: el alias de paquete es exclusivo de recepción
	// y jamás puede resolver en caja. El cuerpo del resolver no debe
	// referenciar la tabla ni variantes del nombre.
	for _, forbidden := range []string{
		"package_barcode_aliases",
		"PackageBarcodeAlias",
		"packageCode",
		"package_code",
	} {
		if strings.Contains(body, forbidden) {
			t.Errorf("ResolveLabelCode NO debe referenciar %q: el alias de paquete es exclusivo de recepción.", forbidden)
		}
	}
}

func TestLabelRepo_ResolveLabelCode_NoMutaEstado(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")
	body := extraerCuerpoResolveLabelCode(t, src)
	// Lectura pura: ningún Create/Updates/Save/Delete dentro del cuerpo.
	// Si en el futuro alguien quiere actualizar last_scanned_at al
	// resolver, debe ser otra tabla/endpoint, no este método.
	for _, forbidden := range []string{
		".Create(",
		".Updates(",
		".Save(",
		".Delete(",
		"INSERT",
		"UPDATE ",
		"DELETE FROM",
	} {
		if strings.Contains(body, forbidden) {
			t.Errorf("ResolveLabelCode debe ser lectura pura; detectado %q en el cuerpo.", forbidden)
		}
	}
}

func TestLabelRepo_ResolveLabelCode_ParametrizaCodigo(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")
	body := extraerCuerpoResolveLabelCode(t, src)
	// SQL parametrizado: el único `?` de la query es el code; el input
	// jamás se concatena. Prevención de SQL injection.
	if !strings.Contains(body, "Raw(sql, normalized)") {
		t.Error("ResolveLabelCode debe pasar `normalized` como parámetro bind (Raw(sql, normalized)); nunca concatenarlo.")
	}
	if strings.Contains(body, "fmt.Sprintf(") {
		t.Error("ResolveLabelCode NO debe usar fmt.Sprintf para construir el SQL: eso abriría inyección.")
	}
}

func TestLabelRepo_ResolveLabelCode_NormalizaConTrimSpace(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")
	body := extraerCuerpoResolveLabelCode(t, src)
	// Normalización mínima: TrimSpace. NO ToUpper (el generador emite
	// minúsculas y el PK es case-sensitive).
	if !strings.Contains(body, "strings.TrimSpace(raw)") {
		t.Error("ResolveLabelCode debe normalizar con strings.TrimSpace(raw) antes de consultar.")
	}
	if strings.Contains(body, "strings.ToUpper(") {
		t.Error("ResolveLabelCode NO debe convertir a mayúsculas: el PK de label_codes es case-sensitive y el generador emite minúsculas.")
	}
}

func TestLabelRepo_ResolveLabelCode_ContratoDeMatchLiterales(t *testing.T) {
	src := leerArchivoDePaquete(t, "label_repository.go")
	body := extraerCuerpoResolveLabelCode(t, src)
	// El frontend condiciona por los literales exactos "label_code" y
	// "unknown". Son parte del contrato.
	if !strings.Contains(body, `"label_code"`) {
		t.Error(`ResolveLabelCode debe emitir Match="label_code" cuando resuelve. El frontend condiciona por este literal.`)
	}
	if !strings.Contains(body, `"unknown"`) {
		t.Error(`ResolveLabelCode debe emitir Match="unknown" cuando no resuelve. El frontend condiciona por este literal.`)
	}
}
