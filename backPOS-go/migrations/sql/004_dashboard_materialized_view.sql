DROP MATERIALIZED VIEW IF EXISTS mv_dashboard_stats_monthly CASCADE;

CREATE MATERIALIZED VIEW mv_dashboard_stats_monthly AS
WITH sale_totals AS (
    SELECT
        TO_CHAR(s."saleDate" AT TIME ZONE 'America/Bogota', 'YYYY-MM') AS month_year,
        SUM(s."totalAmount") AS total_sales,
        COUNT(*) AS transaction_count,
        SUM(GREATEST(0, s."cashAmount" - s."change")) AS sales_cash,
        SUM(s."transferAmount") AS sales_transfer,
        SUM(s."creditAmount") AS sales_credit
    FROM sales s
    WHERE s.deleted_at IS NULL AND UPPER(s.status) = 'PAID'
    GROUP BY 1
),
sale_cogs AS (
    SELECT
        TO_CHAR(s."saleDate" AT TIME ZONE 'America/Bogota', 'YYYY-MM') AS month_year,
        SUM(sd.quantity * COALESCE(NULLIF(sd."costPrice", 0), p."purchasePrice", 0)) AS total_cogs,
        COALESCE(SUM(sd.quantity), 0) AS products_sold
    FROM sales s
    JOIN sale_details sd ON s."saleId" = sd."saleId"
    LEFT JOIN products p ON sd.barcode = p.barcode
    WHERE s.deleted_at IS NULL
      AND (UPPER(s.status) IN ('PAID', 'CREDIT', 'FIADO') OR s.status IS NULL OR s.status = '')
    GROUP BY 1
),
expense_stats AS (
    SELECT
        TO_CHAR(date AT TIME ZONE 'America/Bogota', 'YYYY-MM') AS month_year,
        SUM(amount + tax_amount) AS total_expenses
    FROM expenses
    WHERE deleted_at IS NULL AND UPPER(status) = 'PAID'
    GROUP BY 1
),
return_stats AS (
    SELECT
        TO_CHAR(r.date AT TIME ZONE 'America/Bogota', 'YYYY-MM') AS month_year,
        SUM(r."totalReturned") AS total_returned,
        COALESCE(SUM(CASE WHEN rd."isExchange" = false THEN rd.quantity ELSE 0 END), 0) AS products_returned
    FROM returns r
    LEFT JOIN return_details rd ON r.id = rd."returnId"
    WHERE r.deleted_at IS NULL
    GROUP BY 1
),
payment_stats AS (
    SELECT
        TO_CHAR("paymentDate" AT TIME ZONE 'America/Bogota', 'YYYY-MM') AS month_year,
        SUM("totalPaid") AS total_abonos,
        SUM("amountCash") AS abonos_cash,
        SUM("amountTransfer") AS abonos_transfer
    FROM credit_payments
    WHERE deleted_at IS NULL
    GROUP BY 1
),
closure_stats AS (
    SELECT
        TO_CHAR(start_date AT TIME ZONE 'America/Bogota', 'YYYY-MM') AS month_year,
        SUM(difference) AS total_difference,
        SUM(physical_cash + total_nequi + total_daviplata + total_card + total_bancolombia + total_other_transfer + total_expenses + total_returns) AS closure_cajero_sales
    FROM cashier_closures
    WHERE deleted_at IS NULL
    GROUP BY 1
),
all_months AS (
    SELECT month_year FROM sale_totals
    UNION SELECT month_year FROM expense_stats
    UNION SELECT month_year FROM payment_stats
    UNION SELECT month_year FROM return_stats
    UNION SELECT month_year FROM closure_stats
)
SELECT
    am.month_year,
    COALESCE(NULLIF(c.closure_cajero_sales, 0), COALESCE(st.total_sales, 0) + COALESCE(p.total_abonos, 0) - COALESCE(ret.total_returned, 0) + COALESCE(c.total_difference, 0)) AS total_sales,
    COALESCE(st.transaction_count, 0) AS transaction_count,
    COALESCE(st.sales_cash, 0) + COALESCE(p.abonos_cash, 0) - COALESCE(ret.total_returned, 0) + COALESCE(c.total_difference, 0) AS sales_cash,
    COALESCE(st.sales_transfer, 0) + COALESCE(p.abonos_transfer, 0) AS sales_transfer,
    COALESCE(st.sales_credit, 0) AS sales_credit,
    COALESCE(sc.products_sold, 0) - COALESCE(ret.products_returned, 0) AS products_sold,
    COALESCE(sc.total_cogs, 0) AS total_cogs,
    COALESCE(e.total_expenses, 0) AS total_expenses,
    COALESCE(p.total_abonos, 0) AS total_abonos
FROM all_months am
LEFT JOIN sale_totals st ON am.month_year = st.month_year
LEFT JOIN sale_cogs sc ON am.month_year = sc.month_year
LEFT JOIN expense_stats e ON am.month_year = e.month_year
LEFT JOIN payment_stats p ON am.month_year = p.month_year
LEFT JOIN return_stats ret ON am.month_year = ret.month_year
LEFT JOIN closure_stats c ON am.month_year = c.month_year;

CREATE UNIQUE INDEX idx_mv_dashboard_month_year
    ON mv_dashboard_stats_monthly(month_year);
