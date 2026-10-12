package aliasnorm

import "testing"

// =============================================================
// Pruebas del decisor puro DecideAliasUpsert.
//
// Garantía principal: el repositorio puede guardar aliases de proveedor
// de forma idempotente SIN migrar las filas antiguas no canonicalizadas,
// porque el decisor compara aplicando CanonicalInvoiceName a lo que ya
// hay en BD. Si el usuario cambia el barcode destino para un mismo
// nombre, el decisor pide Relink; si repite el mismo enlace, pide
// BumpUses; si es nombre nuevo, pide Create.
//
// Si el matcher cambia (por ejemplo, para ignorar casing/espacios por un
// mecanismo distinto), estos tests cambian con él. Deben seguir
// mostrando que un alias histórico con casing crudo sigue encontrándose.
// =============================================================

func mustCanonicalize(t *testing.T, invoiceName, barcode string) AliasFields {
	t.Helper()
	fields, err := ValidateAndCanonicalize(1, invoiceName, barcode)
	if err != nil {
		t.Fatalf("ValidateAndCanonicalize fallida en setup: %v", err)
	}
	return fields
}

func TestDecideAliasUpsert_CreateCuandoNoHayFilas(t *testing.T) {
	desired := mustCanonicalize(t, "COCA 400ML", "7701-A")
	dec := DecideAliasUpsert(desired, nil)
	if dec.Action != AliasUpsertCreate {
		t.Errorf("sin filas debe decidir Create, got %v", dec.Action)
	}
	if dec.TargetID != 0 {
		t.Errorf("Create no debe fijar TargetID, got %d", dec.TargetID)
	}
}

func TestDecideAliasUpsert_BumpUsesCuandoEsIdentico(t *testing.T) {
	desired := mustCanonicalize(t, "COCA 400ML", "7701-A")
	rows := []AliasRow{
		{ID: 10, InvoiceName: "COCA 400ML", ProductBarcode: "7701-A"},
	}
	dec := DecideAliasUpsert(desired, rows)
	if dec.Action != AliasUpsertBumpUses {
		t.Errorf("mismo barcode debe decidir BumpUses, got %v", dec.Action)
	}
	if dec.TargetID != 10 {
		t.Errorf("TargetID esperado 10, got %d", dec.TargetID)
	}
}

func TestDecideAliasUpsert_RelinkCorrigeBarcode(t *testing.T) {
	// El usuario corrigió el enlace: mismo nombre, barcode distinto.
	desired := mustCanonicalize(t, "COCA 400ML", "7701-B")
	rows := []AliasRow{
		{ID: 20, InvoiceName: "COCA 400ML", ProductBarcode: "7701-A"},
	}
	dec := DecideAliasUpsert(desired, rows)
	if dec.Action != AliasUpsertRelink {
		t.Errorf("barcode distinto debe decidir Relink, got %v", dec.Action)
	}
	if dec.TargetID != 20 {
		t.Errorf("Relink debe tocar la fila existente (ID=20), got %d", dec.TargetID)
	}
}

func TestDecideAliasUpsert_TolerantAHistoricoNoCanonicalizado(t *testing.T) {
	// La fila histórica entró con casing/espacios distintos. El decisor
	// debe reconocerla por su forma canónica sin exigir migración.
	desired := mustCanonicalize(t, "coca  400ml", "7701-A")
	rows := []AliasRow{
		{ID: 30, InvoiceName: "  Coca   400ML  ", ProductBarcode: "7701-A"},
	}
	dec := DecideAliasUpsert(desired, rows)
	if dec.Action != AliasUpsertBumpUses {
		t.Errorf("fila histórica no normalizada debe seguir emparejando, got %v", dec.Action)
	}
	if dec.TargetID != 30 {
		t.Errorf("TargetID esperado 30, got %d", dec.TargetID)
	}
}

func TestDecideAliasUpsert_TolerantConCorreccionDeBarcode(t *testing.T) {
	// Fila histórica con casing crudo + usuario cambia el barcode.
	desired := mustCanonicalize(t, "COCA 400ML", "7701-NUEVO")
	rows := []AliasRow{
		{ID: 31, InvoiceName: "coca 400ML", ProductBarcode: "7701-A"},
	}
	dec := DecideAliasUpsert(desired, rows)
	if dec.Action != AliasUpsertRelink {
		t.Errorf("histórico + barcode distinto debe decidir Relink, got %v", dec.Action)
	}
	if dec.TargetID != 31 {
		t.Errorf("TargetID esperado 31, got %d", dec.TargetID)
	}
}

func TestDecideAliasUpsert_EnDuplicadosEligeMasReciente(t *testing.T) {
	// Herencia sucia: dos filas colapsan al mismo canónico. El decisor
	// elige la de mayor ID (más reciente) para no congelar el enlace
	// viejo.
	desired := mustCanonicalize(t, "COCA 400ML", "7701-NUEVO")
	rows := []AliasRow{
		{ID: 1, InvoiceName: "COCA  400ML", ProductBarcode: "7701-VIEJO"},
		{ID: 50, InvoiceName: "COCA 400ML", ProductBarcode: "7701-NUEVO"},
	}
	dec := DecideAliasUpsert(desired, rows)
	if dec.Action != AliasUpsertBumpUses {
		t.Errorf("fila más reciente ya tenía el barcode nuevo: debe BumpUses sobre esa, got %v", dec.Action)
	}
	if dec.TargetID != 50 {
		t.Errorf("TargetID esperado 50 (más reciente), got %d", dec.TargetID)
	}
}

func TestDecideAliasUpsert_IgnoraFilasConCanonicoDistinto(t *testing.T) {
	desired := mustCanonicalize(t, "COCA 400ML", "7701-A")
	rows := []AliasRow{
		{ID: 1, InvoiceName: "PEPSI 400ML", ProductBarcode: "7702"},
		{ID: 2, InvoiceName: "AGUA CRISTAL", ProductBarcode: "7703"},
	}
	dec := DecideAliasUpsert(desired, rows)
	if dec.Action != AliasUpsertCreate {
		t.Errorf("sin coincidencia por canónico debe Create, got %v", dec.Action)
	}
}
