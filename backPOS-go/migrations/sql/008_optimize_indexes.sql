CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_date ON sales("saleDate" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_client ON sales("clientDni");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_employee ON sales("employeeDni");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_payment_method ON sales("paymentMethod");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_dashboard ON sales("saleDate" DESC, status, deleted_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sale_details_id ON sale_details("saleId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sale_details_barcode ON sale_details(barcode);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sale_details_sale_deleted ON sale_details("saleId", deleted_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expenses_date ON expenses(date DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expenses_dashboard ON expenses(date DESC, status, deleted_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_critical ON audit_logs(is_critical) WHERE is_critical = true;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_employee ON audit_logs(employee_dni);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_module ON audit_logs(module);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_movements_barcode ON stock_movements(barcode);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_movements_date ON stock_movements(date DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_category ON products("categoryId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_supplier ON products("supplierId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_active_deleted ON products("isActive", deleted_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_name_trgm ON products USING gin("productName" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_suppliers_supplier_id ON product_suppliers(supplier_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cashier_closures_date ON cashier_closures(date DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_pending_debts ON sales("clientDni", status, "debtPending", "saleDate");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_credit_payments_date ON credit_payments("paymentDate" DESC, deleted_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_quantity ON products("isActive", quantity);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_returns_sale_id ON returns("saleId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_returns_date ON returns(date DESC);
