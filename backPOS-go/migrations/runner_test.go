package migrations

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCatalogIsCompleteOrderedAndChecksummed(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	if len(catalog) != 11 {
		t.Fatalf("len(Catalog()) = %d, want 11", len(catalog))
	}
	for i, migration := range catalog {
		wantVersion := int64(i + 1)
		if migration.Version != wantVersion {
			t.Fatalf("catalog[%d].Version = %d, want %d", i, migration.Version, wantVersion)
		}
		if len(migration.Checksum) != 64 {
			t.Errorf("migration %03d checksum length = %d, want 64", migration.Version, len(migration.Checksum))
		}
		if migration.Version == 2 && migration.Apply == nil {
			t.Error("model schema migration must use explicit Go callback")
		}
		wantTransactional := migration.Version != 8 && migration.Version != 9 && migration.Version != 11
		if migration.Transactional != wantTransactional {
			t.Errorf("migration %03d transactional = %t, want %t", migration.Version, migration.Transactional, wantTransactional)
		}
	}
}

func TestMigrationChecksumDetectsContentChanges(t *testing.T) {
	original := migrationChecksum(1, "example", "SELECT 1;", true)
	changed := migrationChecksum(1, "example", "SELECT 2;", true)
	windowsLineEndings := migrationChecksum(1, "example", "SELECT 1;\r\n", true)
	unixLineEndings := migrationChecksum(1, "example", "SELECT 1;\n", true)
	if original == changed {
		t.Fatal("checksum did not change with migration content")
	}
	if windowsLineEndings != unixLineEndings {
		t.Fatal("checksum must normalize CRLF to LF")
	}
}

func TestSplitSQLStatementsPreservesPostgresBlocks(t *testing.T) {
	source := `
-- preflight
DO $$
BEGIN
    PERFORM 1;
    RAISE NOTICE 'semicolon; inside';
END $$;
CREATE INDEX CONCURRENTLY idx_example ON example(id);
/* final comment */
SELECT "semi;colon" FROM example;
`
	statements := splitSQLStatements(source)
	if len(statements) != 3 {
		t.Fatalf("len(splitSQLStatements()) = %d, want 3: %#v", len(statements), statements)
	}
	if !strings.Contains(statements[0], "PERFORM 1;") || !strings.Contains(statements[0], "END $$") {
		t.Fatalf("DO block was split incorrectly: %q", statements[0])
	}
	if !strings.Contains(statements[1], "CREATE INDEX CONCURRENTLY") {
		t.Fatalf("second statement = %q", statements[1])
	}
}

func TestValidateAppliedRejectsDriftAndUnknownVersions(t *testing.T) {
	catalog := []Migration{{Version: 1, Name: "one", Checksum: "abc"}}
	valid := []AppliedMigration{{Version: 1, Name: "one", Checksum: "abc", AppliedAt: time.Now()}}
	if err := validateApplied(catalog, valid); err != nil {
		t.Fatalf("validateApplied(valid) error = %v", err)
	}
	if err := validateApplied(catalog, []AppliedMigration{{Version: 1, Name: "one", Checksum: "changed"}}); err == nil {
		t.Fatal("validateApplied accepted checksum drift")
	}
	if err := validateApplied(catalog, []AppliedMigration{{Version: 2, Name: "future", Checksum: "abc"}}); err == nil {
		t.Fatal("validateApplied accepted unknown migration")
	}
}

func TestConcurrentIndexPattern(t *testing.T) {
	matches := concurrentIndexPattern.FindStringSubmatch(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_tx ON sales("clientTxId")`)
	if len(matches) != 2 || matches[1] != "idx_sales_tx" {
		t.Fatalf("concurrent index match = %#v", matches)
	}
	if concurrentIndexPattern.MatchString(`CREATE INDEX idx_normal ON sales(id)`) {
		t.Fatal("normal index must not match concurrent retry pattern")
	}
}

func TestNormalStartupContainsNoSchemaOrSeedMutations(t *testing.T) {
	checks := []struct {
		path      string
		forbidden []string
	}{
		{
			path: filepath.Join("..", "internal", "adapters", "repositories", "db.go"),
			forbidden: []string{
				"AutoMigrate(", "CREATE DATABASE", "CREATE EXTENSION", "ALTER TABLE", "DROP TABLE", "SeedAdmin(", "SeedProducts(",
			},
		},
		{
			path: filepath.Join("..", "cmd", "api", "main.go"),
			forbidden: []string{
				"InitMaterializedViews(", "REFRESH MATERIALIZED VIEW", "AutoMigrate(",
			},
		},
		{
			path: filepath.Join("..", "cmd", "seed", "main.go"),
			forbidden: []string{
				"DROP SCHEMA", "CASCADE; CREATE SCHEMA", "AutoMigrate(",
			},
		},
	}
	for _, check := range checks {
		body, err := os.ReadFile(check.path)
		if err != nil {
			t.Fatalf("ReadFile(%s) error = %v", check.path, err)
		}
		for _, forbidden := range check.forbidden {
			if strings.Contains(string(body), forbidden) {
				t.Errorf("%s still contains forbidden startup mutation %q", check.path, forbidden)
			}
		}
	}
}

func TestOperationalIndexesMigrationUsesPhysicalColumnsConcurrently(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	migration := catalog[10]
	if migration.Version != 11 || migration.Transactional {
		t.Fatalf("migration 011 = version %d transactional=%t", migration.Version, migration.Transactional)
	}
	for _, expected := range []string{
		"stock_movements(reference_id, reason)",
		"stock_movements(barcode, reason, date DESC)",
		"expenses(category, supplier_id, date DESC)",
		"audit_logs(module, employee_dni, created_at DESC)",
	} {
		if !strings.Contains(migration.Source, expected) {
			t.Errorf("migration 011 missing %q", expected)
		}
	}
	if count := strings.Count(migration.Source, "CREATE INDEX CONCURRENTLY IF NOT EXISTS"); count != 4 {
		t.Errorf("migration 011 concurrent index count = %d, want 4", count)
	}
}
