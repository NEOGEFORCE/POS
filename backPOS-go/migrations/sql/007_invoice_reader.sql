ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS margin_percentage DECIMAL(5,2) DEFAULT 0;

CREATE TABLE IF NOT EXISTS supplier_product_aliases (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
    invoice_name VARCHAR(255) NOT NULL,
    product_barcode VARCHAR(255) REFERENCES products(barcode) ON DELETE CASCADE,
    uses_count INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(supplier_id, invoice_name)
);

CREATE TABLE IF NOT EXISTS supplier_invoice_params (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE CASCADE UNIQUE,
    price_includes_iva BOOLEAN DEFAULT false,
    price_includes_icui BOOLEAN DEFAULT false,
    price_includes_ibua BOOLEAN DEFAULT false,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
