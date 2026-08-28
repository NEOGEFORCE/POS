package services

import "testing"

func TestValidateBotReadOnlyQuery(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		query   string
		wantErr bool
	}{
		{name: "simple select", query: `SELECT barcode, "productName" FROM products WHERE quantity > 0`, wantErr: false},
		{name: "select with updated_at column", query: `SELECT updated_at FROM product_suppliers`, wantErr: false},
		{name: "empty", query: ` `, wantErr: true},
		{name: "cte not allowed", query: `WITH data AS (SELECT 1) SELECT * FROM data`, wantErr: true},
		{name: "multiple statements", query: `SELECT 1; DELETE FROM products`, wantErr: true},
		{name: "line comment", query: "SELECT 1 -- comment", wantErr: true},
		{name: "block comment", query: `SELECT /* comment */ 1`, wantErr: true},
		{name: "mutation token", query: `SELECT 1 FROM products WHERE barcode IN (DELETE FROM products RETURNING barcode)`, wantErr: true},
		{name: "locking select", query: `SELECT * FROM products FOR UPDATE`, wantErr: true},
		{name: "select into", query: `SELECT * INTO temporary_products FROM products`, wantErr: true},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := validateBotReadOnlyQuery(test.query)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateBotReadOnlyQuery() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}
