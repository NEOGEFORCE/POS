package models

import (
	"strings"
	"testing"
	"time"
)

// =============================================================================
// Tests del modelo InternalBarcodeReservation.
//
// Validan:
//
//   - Formato del namespace (regex coincide con el CHECK de la BD).
//   - Normalización (TrimSpace + ToUpper) empata con product_handler.Create.
//   - Enums de status y source.
//   - IsLive: lógica de "¿aún se puede consumir?" en el handler.
// =============================================================================

func TestIsInternalBarcode_ReconoceNamespace(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"canónico", "POSINT-ABCD1234", true},
		{"minúsculas", "posint-abcd1234", true},
		{"con espacios", "  POSINT-ABCD1234  ", true},
		{"solo prefijo", "POSINT-", true},
		{"EAN13", "7709999999999", false},
		{"LC-", "LC-abcd12345678", false},
		{"vacío", "", false},
		{"PACKX-", "PACKX-ABCD1234", false},
		{"casi POSINT con tilde", "PÓSINT-ABCD", false},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			if got := IsInternalBarcode(c.in); got != c.want {
				t.Errorf("IsInternalBarcode(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

func TestIsValidInternalBarcode_ExigeShapeExacto(t *testing.T) {
	t.Parallel()
	// Mínimo 8 nibbles, máximo 24, SOLO 0-9A-F uppercase (la normalización
	// hace ToUpper, pero el regex se aplica tras ToUpper igual).
	ok := []string{
		"POSINT-ABCDEF01",                 // 8
		"POSINT-ABCDEF0123",               // 10
		"POSINT-ABCDEF0123456789ABCDEF01", // 24 (máximo)
		"posint-abcdef01",                 // minúsculas → se normalizan
		"  POSINT-ABCDEF01\t",             // con whitespace
		"POSINT-00000000",                 // bordes
		"POSINT-FFFFFFFF",
	}
	for _, v := range ok {
		if !IsValidInternalBarcode(v) {
			t.Errorf("IsValidInternalBarcode(%q) = false, want true", v)
		}
	}

	bad := []string{
		"POSINT-ABCDEF0",                   // 7 (menos del mínimo)
		"POSINT-ABCDEF0123456789ABCDEF012", // 25 (más del máximo)
		"POSINT-ABCDEFG0",                  // 'G' fuera del hex
		"POSINT-abcd-1234",                 // guión interno
		"POSINT_ABCDEF01",                  // underscore en lugar de guión
		"POSNT-ABCDEF01",                   // prefijo mal escrito
		"POSINT-" + strings.Repeat("Z", 10),
		"",
		"POSINT",
		"POSINT-",
	}
	for _, v := range bad {
		if IsValidInternalBarcode(v) {
			t.Errorf("IsValidInternalBarcode(%q) = true, want false", v)
		}
	}
}

func TestNormalizeInternalBarcode(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"posint-abcd1234":      "POSINT-ABCD1234",
		"   POSINT-ABCD1234  ": "POSINT-ABCD1234",
		"\tposint-abcd1234\n":  "POSINT-ABCD1234",
		"":                     "",
		"  \t  ":               "",
	}
	for in, want := range cases {
		if got := NormalizeInternalBarcode(in); got != want {
			t.Errorf("NormalizeInternalBarcode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsValidInternalSource_EnumContract(t *testing.T) {
	t.Parallel()
	for _, ok := range []string{
		InternalBarcodeSourceProductForm,
		InternalBarcodeSourceReception,
		InternalBarcodeSourceOther,
	} {
		if !IsValidInternalSource(ok) {
			t.Errorf("source %q debe ser válido", ok)
		}
	}
	for _, bad := range []string{
		"", "PRODUCT_FORM", "scanner", "cli", "receipt",
	} {
		if IsValidInternalSource(bad) {
			t.Errorf("source %q NO debe ser válido", bad)
		}
	}
}

func TestInternalBarcodeReservation_IsLive(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	past := now.Add(-time.Minute)
	future := now.Add(time.Minute)

	cases := []struct {
		name string
		res  *InternalBarcodeReservation
		want bool
	}{
		{"nil", nil, false},
		{"consumed", &InternalBarcodeReservation{Status: InternalBarcodeStatusConsumed}, false},
		{"expired flag", &InternalBarcodeReservation{Status: InternalBarcodeStatusExpired}, false},
		{"reserved sin expiry", &InternalBarcodeReservation{Status: InternalBarcodeStatusReserved}, true},
		{"reserved futuro", &InternalBarcodeReservation{Status: InternalBarcodeStatusReserved, ExpiresAt: &future}, true},
		{"reserved vencido en segundos", &InternalBarcodeReservation{Status: InternalBarcodeStatusReserved, ExpiresAt: &past}, false},
		{"reserved exactamente al borde", &InternalBarcodeReservation{Status: InternalBarcodeStatusReserved, ExpiresAt: &now}, false},
	}
	for _, c := range cases {
		if got := c.res.IsLive(now); got != c.want {
			t.Errorf("%s: IsLive(now=%v) = %v, want %v", c.name, now, got, c.want)
		}
	}
}

func TestInternalBarcodeReservation_TableNameEstable(t *testing.T) {
	t.Parallel()
	if got := (InternalBarcodeReservation{}).TableName(); got != "internal_barcode_reservations" {
		t.Fatalf("TableName() = %q; la migración 024 crea 'internal_barcode_reservations' y GORM debe emparejarla", got)
	}
}

// Blindaje contra reintroducir constantes contradictorias con la BD.
func TestInternalBarcodePrefix_YConstantesCoherentes(t *testing.T) {
	t.Parallel()
	if InternalBarcodePrefix != "POSINT-" {
		t.Fatal("InternalBarcodePrefix debe ser 'POSINT-' para empatar con el CHECK de la migración 024")
	}
	if InternalBarcodeHexMin != 8 || InternalBarcodeHexMax != 24 {
		t.Fatalf("rango de hex permitido debe ser [8..24], got [%d..%d]", InternalBarcodeHexMin, InternalBarcodeHexMax)
	}
	// El default no puede estar fuera del rango permitido.
	if InternalBarcodeDefaultHexLen < InternalBarcodeHexMin || InternalBarcodeDefaultHexLen > InternalBarcodeHexMax {
		t.Fatalf("InternalBarcodeDefaultHexLen=%d fuera del rango permitido [%d..%d]",
			InternalBarcodeDefaultHexLen, InternalBarcodeHexMin, InternalBarcodeHexMax)
	}
}
