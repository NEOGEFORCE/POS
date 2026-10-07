package repositories

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// =============================================================================
// Guardianes estáticos del PackageBarcodeAliasRepository.
//
// Comprueban invariantes críticas de seguridad semántica sin levantar BD:
//
//   - La lógica de colisión consulta las cuatro fuentes requeridas por
//     el contrato del sprint: products.barcode, products.alternateCodes,
//     label_codes.code y package_barcode_aliases.package_code de otro
//     producto.
//
//   - El código del paquete NUNCA se escribe a products.alternateCodes.
//     Si alguien agrega una ruta que mezcle los dos espacios, el
//     repositorio dejaría de garantizar que un paquete no pueda
//     escanearse en caja.
//
//   - EnsureAlias usa una transacción explícita.
//
//   - La precondición units_per_pack >= 1 queda codificada en el
//     repositorio además del CHECK de la BD.
// =============================================================================

func leerArchivoAlias(t *testing.T, name string) string {
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

func TestPackageAliasRepo_EnsureConsultaCuatroFuentesDeColision(t *testing.T) {
	src := leerArchivoAlias(t, "package_barcode_alias_repository.go")

	// 1) products.barcode
	if !strings.Contains(src, `FROM products WHERE barcode = ? AND barcode <> ?`) {
		t.Error("EnsureAlias debe consultar products.barcode para detectar colisión con otro producto.")
	}
	// 2) products.alternateCodes (token exacto con string_to_array o
	//    fallback ILIKE para esquemas legacy)
	if !strings.Contains(src, `string_to_array(upper("alternate_codes")`) &&
		!strings.Contains(src, `string_to_array(upper("alternateCodes")`) {
		t.Error("EnsureAlias debe consultar products.alternateCodes con token exacto (string_to_array).")
	}
	// 3) label_codes.code tolerante a migración 016 ausente: chequeo de
	//    existencia en sentencia aparte (labelCodesTableExists).
	if !strings.Contains(src, "labelCodesTableExists(tx)") {
		t.Error("EnsureAlias debe verificar label_codes con labelCodesTableExists antes de consultarla (tolerancia a 016 ausente).")
	}
	if !strings.Contains(src, "FROM label_codes") {
		t.Error("EnsureAlias debe consultar label_codes.code.")
	}
	// 4) package_barcode_aliases para otro producto.
	if !strings.Contains(src, `Where("package_code = ?", pc)`) {
		t.Error("EnsureAlias debe consultar package_barcode_aliases por package_code.")
	}
}

func TestPackageAliasRepo_EnsureUsaTransaccionExplicita(t *testing.T) {
	src := leerArchivoAlias(t, "package_barcode_alias_repository.go")
	if !strings.Contains(src, "r.db.WithContext(ctx).Transaction") {
		t.Error("EnsureAlias debe envolver la validación de colisión y el INSERT/UPDATE en Transaction().")
	}
}

func TestPackageAliasRepo_NuncaEscribeAAlternateCodes(t *testing.T) {
	src := leerArchivoAlias(t, "package_barcode_alias_repository.go")
	// Buscamos UPDATE/INSERT contra products con alternateCodes/alternate_codes.
	forbidden := regexp.MustCompile(`(?i)(UPDATE\s+products|INSERT\s+INTO\s+products)[^;]*(alternate_codes|alternateCodes)`)
	if forbidden.MatchString(src) {
		t.Fatal("El repositorio de package_barcode_aliases NUNCA debe escribir a products.alternateCodes: eso haría escaneable el código en caja.")
	}
	// También prohibimos cualquier UPDATE/INSERT contra la tabla products
	// directamente — el repositorio solo lee del catálogo.
	anyProductWrite := regexp.MustCompile(`(?i)(UPDATE\s+products|INSERT\s+INTO\s+products)`)
	if anyProductWrite.MatchString(src) {
		t.Fatal("El repositorio de package_barcode_aliases es READ-ONLY sobre products; sólo escribe en su propia tabla.")
	}
}

func TestPackageAliasRepo_EnsureValidaUnitsPerPackMinimo(t *testing.T) {
	src := leerArchivoAlias(t, "package_barcode_alias_repository.go")
	if !strings.Contains(src, "unitsPerPack debe ser >= 1") {
		t.Error("EnsureAlias debe rechazar unitsPerPack < 1 con error claro.")
	}
}

func TestPackageAliasRepo_ResolveNoMutaEstado(t *testing.T) {
	src := leerArchivoAlias(t, "package_barcode_alias_repository.go")
	// Resolve es puro: localizamos la función y descartamos cualquier
	// llamada de mutación. Como el cuerpo contiene llaves anidadas,
	// usamos como heurística el rango desde "func (r *PackageBarcodeAliasRepository) Resolve"
	// hasta el siguiente "func (" (que marca el inicio de EnsureAlias).
	start := strings.Index(src, "func (r *PackageBarcodeAliasRepository) Resolve(")
	if start < 0 {
		t.Fatal("No se pudo localizar la declaración de Resolve().")
	}
	rest := src[start+1:]
	nextFunc := strings.Index(rest, "\nfunc (")
	if nextFunc < 0 {
		t.Fatal("No se pudo delimitar el final del cuerpo de Resolve().")
	}
	body := rest[:nextFunc]
	for _, mutador := range []string{".Updates(", ".Create(", ".Save(", ".Delete("} {
		if strings.Contains(body, mutador) {
			t.Errorf("Resolve() es un GET puro: no debe llamar a %s.", mutador)
		}
	}
}

func TestPackageAliasRepo_MarkSeenIncrementaConExpr(t *testing.T) {
	src := leerArchivoAlias(t, "package_barcode_alias_repository.go")
	if !strings.Contains(src, "gorm.Expr(\"seen_count + 1\")") {
		t.Error("MarkSeen debe incrementar seen_count atómicamente con gorm.Expr.")
	}
	if !strings.Contains(src, "last_seen_at") {
		t.Error("MarkSeen debe sellar last_seen_at.")
	}
}

func TestPackageAliasRepo_UpsertEnMismoProductoEsIdempotente(t *testing.T) {
	src := leerArchivoAlias(t, "package_barcode_alias_repository.go")
	// Buscamos la rama "mismo producto → UPDATE idempotente" en EnsureAlias.
	if !strings.Contains(src, "existing.ProductBarcode != pb") {
		t.Error("EnsureAlias debe comparar el ProductBarcode del alias existente contra el del request antes de aceptar el upsert.")
	}
	if !strings.Contains(src, "created = false") {
		t.Error("Un UPDATE idempotente debe devolver created=false al handler.")
	}
}
