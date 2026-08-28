package repositories

import (
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

func TestNormalizeAlternateCodes(t *testing.T) {
	got, codes, err := normalizeAlternateCodes("MAIN", " ALT-1,ALT-2, ALT-1 ,, ")
	if err != nil {
		t.Fatalf("normalizeAlternateCodes returned error: %v", err)
	}
	if got != "ALT-1,ALT-2" {
		t.Fatalf("normalized codes = %q, want ALT-1,ALT-2", got)
	}
	if len(codes) != 2 || codes[0] != "ALT-1" || codes[1] != "ALT-2" {
		t.Fatalf("unexpected codes: %#v", codes)
	}
}

func TestNormalizeAlternateCodesRejectsPrimary(t *testing.T) {
	if _, _, err := normalizeAlternateCodes("MAIN", "ALT, MAIN"); err == nil {
		t.Fatal("expected primary/alternate collision to be rejected")
	}
}

func TestCloneProductDoesNotShareSupplierSlices(t *testing.T) {
	original := &models.Product{
		Barcode:          "MAIN",
		Suppliers:        []models.Supplier{{ID: 1, Name: "Proveedor A"}},
		ProductSuppliers: []models.ProductSupplier{{ProductID: "MAIN", SupplierID: 1, PurchasePrice: 100}},
	}
	clone := cloneProduct(original)
	clone.Suppliers[0].Name = "Modificado"
	clone.ProductSuppliers[0].PurchasePrice = 200
	if original.Suppliers[0].Name != "Proveedor A" {
		t.Fatal("supplier slice still shares cached backing storage")
	}
	if original.ProductSuppliers[0].PurchasePrice != 100 {
		t.Fatal("product supplier slice still shares cached backing storage")
	}
}

func TestDatabasePoolConfigDefaults(t *testing.T) {
	for _, name := range []string{
		"DB_MAX_OPEN_CONNS", "DB_MAX_IDLE_CONNS", "DB_CONN_MAX_LIFETIME_MINUTES",
		"DB_CONN_MAX_IDLE_MINUTES", "DB_PING_TIMEOUT_SECONDS",
	} {
		t.Setenv(name, "")
	}
	config := databasePoolConfigFromEnv()
	if config.MaxOpenConns != 25 || config.MaxIdleConns != 5 {
		t.Fatalf("unexpected pool defaults: open=%d idle=%d", config.MaxOpenConns, config.MaxIdleConns)
	}
	if config.ConnMaxLifetime != 30*time.Minute || config.ConnMaxIdleTime != 5*time.Minute || config.PingTimeout != 5*time.Second {
		t.Fatalf("unexpected duration defaults: %#v", config)
	}
}

func TestDatabasePoolConfigClampsIdleAndRejectsInvalidValues(t *testing.T) {
	t.Setenv("DB_MAX_OPEN_CONNS", "8")
	t.Setenv("DB_MAX_IDLE_CONNS", "20")
	t.Setenv("DB_CONN_MAX_LIFETIME_MINUTES", "invalid")
	t.Setenv("DB_CONN_MAX_IDLE_MINUTES", "7")
	t.Setenv("DB_PING_TIMEOUT_SECONDS", "9")

	config := databasePoolConfigFromEnv()
	if config.MaxOpenConns != 8 || config.MaxIdleConns != 8 {
		t.Fatalf("idle connections were not clamped: open=%d idle=%d", config.MaxOpenConns, config.MaxIdleConns)
	}
	if config.ConnMaxLifetime != 30*time.Minute {
		t.Fatalf("invalid lifetime should use default, got %s", config.ConnMaxLifetime)
	}
	if config.ConnMaxIdleTime != 7*time.Minute || config.PingTimeout != 9*time.Second {
		t.Fatalf("valid duration overrides were not applied: %#v", config)
	}
}
