package repositories

import (
	"context"
	"strings"
	"testing"
)

// =============================================================================
// Guardarraíl POSINT en PackageBarcodeAliasRepository.EnsureAlias.
//
// La migración 024 añade un CHECK constraint que bloquea POSINT- en
// package_code. El repositorio aborta ANTES de llegar al INSERT para dar
// un error legible sin pasar por el 23514 crudo de Postgres.
// =============================================================================

func TestPackageAliasRepo_EnsureRechazaNamespacePOSINT(t *testing.T) {
	t.Parallel()
	// repo nil es seguro: el guardia valida antes de tocar la BD.
	r := &PackageBarcodeAliasRepository{}
	_, _, err := r.EnsureAlias(context.Background(),
		"UNITABCD",        // product base real
		"posint-abcd1234", // intento de usar el namespace interno
		12,
		nil,
		"EMP-01")
	if err == nil {
		t.Fatal("EnsureAlias debe rechazar package_code con namespace POSINT-")
	}
	if !strings.Contains(err.Error(), "POSINT") {
		t.Errorf("el error debe mencionar POSINT para que el handler lo mapee a 400 claro; got %q", err.Error())
	}
}

// Guardián estático: el repo DEBE referenciar models.IsInternalBarcode
// en el guardia, no inlinearse "POSINT-" como literal.
func TestPackageAliasRepo_UsaHelperIsInternalBarcode(t *testing.T) {
	src := leerArchivoAlias(t, "package_barcode_alias_repository.go")
	if !strings.Contains(src, "models.IsInternalBarcode(pc)") {
		t.Error("package_barcode_alias_repository.go debe usar models.IsInternalBarcode(pc) para el guardia POSINT")
	}
}
