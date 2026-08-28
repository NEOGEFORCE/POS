[CmdletBinding()]
param(
    [string]$PosFolder = 'C:\Users\surti\Desktop\POS'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments = @())
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = & $FilePath @Arguments 2>&1
        $code = $LASTEXITCODE
        return [pscustomobject]@{ Output = @($raw | ForEach-Object { [string]$_ }); ExitCode = $code }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Get-EnvValue {
    param([string[]]$Lines, [string]$Key)
    $line = $Lines | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
    if (-not $line) { return '' }
    return (($line -replace "^\s*$Key\s*=", '').Trim()).Trim('"').Trim("'")
}

function Resolve-Tool {
    param([string]$CommandName)
    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($root in @('C:\Program Files\PostgreSQL', 'S:\Program Files\PostgreSQL', 'D:\Program Files\PostgreSQL')) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $found = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "bin\$CommandName.exe" } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
        if ($found) { return $found }
    }
    throw "$CommandName no fue encontrado."
}

$envFile = Join-Path $PosFolder '.env'
if (-not (Test-Path -LiteralPath $envFile)) { throw "No se encontro .env en $PosFolder" }
$envLines = Get-Content -LiteralPath $envFile
$dbHost = Get-EnvValue -Lines $envLines -Key 'DB_HOST'
$dbPort = Get-EnvValue -Lines $envLines -Key 'DB_PORT'
$dbUser = Get-EnvValue -Lines $envLines -Key 'DB_USER'
$dbName = Get-EnvValue -Lines $envLines -Key 'DB_NAME'
$dbPassword = Get-EnvValue -Lines $envLines -Key 'DB_PASSWORD'
if ([string]::IsNullOrWhiteSpace($dbPort)) { $dbPort = '5432' }

$psql = Resolve-Tool -CommandName 'psql'

$sql = @'
\timing on
\echo === TAMANOS DE TABLA ===
SELECT c.relname AS tabla, pg_size_pretty(pg_total_relation_size(c.oid)) AS tamano, t.n_live_tup AS filas
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables t ON t.relid = c.oid
WHERE n.nspname='public' AND c.relkind='r'
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 10;

\echo
\echo === CATALOGO DE PRODUCTOS (lo carga ventas) ===
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT * FROM products WHERE COALESCE("isActive", true) = true ORDER BY "productName" ASC;

\echo
\echo === SUGERENCIAS V2 ===
EXPLAIN (ANALYZE, BUFFERS, TIMING)
WITH ultima_recepcion AS (
    SELECT barcode, MAX(date) AS last_reception_at
    FROM stock_movements WHERE reason='RECEPTION' GROUP BY barcode
),
consumo_posterior AS (
    SELECT sd.barcode, SUM(sd.quantity) AS sold_since_reception
    FROM sale_details sd
    JOIN sales s ON s."saleId" = sd."saleId"
    JOIN ultima_recepcion ur ON ur.barcode = sd.barcode
    WHERE s.deleted_at IS NULL AND UPPER(s.status) IN ('PAID','CREDIT')
      AND s."saleDate" >= ur.last_reception_at
    GROUP BY sd.barcode
)
SELECT m.*, ur.last_reception_at, COALESCE(cp.sold_since_reception,0)
FROM product_restock_metrics m
LEFT JOIN ultima_recepcion ur ON ur.barcode = m.product_id
LEFT JOIN consumo_posterior cp ON cp.barcode = m.product_id;

\echo
\echo === RESUMEN DEL DASHBOARD ===
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT COALESCE(SUM("totalAmount"),0) FROM sales
WHERE deleted_at IS NULL AND UPPER(status) IN ('PAID','CREDIT')
  AND "saleDate" >= NOW() - INTERVAL '30 days';

\echo
\echo === COBERTURA DE PROVEEDORES Y METRICAS ===
SELECT 'productos_activos' AS dato, COUNT(*)::text AS valor FROM products WHERE COALESCE("isActive",true)=true AND deleted_at IS NULL
UNION ALL SELECT 'con_proveedor_principal', COUNT(*)::text FROM products WHERE "supplierId" IS NOT NULL AND COALESCE("isActive",true)=true AND deleted_at IS NULL
UNION ALL SELECT 'con_proveedor_asociado', COUNT(DISTINCT product_barcode)::text FROM product_suppliers
UNION ALL SELECT 'metricas_calculadas', COUNT(*)::text FROM product_restock_metrics
UNION ALL SELECT 'metricas_con_proveedor', COUNT(*)::text FROM product_restock_metrics WHERE primary_supplier_id IS NOT NULL
UNION ALL SELECT 'metricas_con_sugerencia', COUNT(*)::text FROM product_restock_metrics WHERE suggested_order_qty > 0;

\echo
\echo === TOP PROVEEDORES CON PRODUCTOS ASOCIADOS ===
SELECT s.name AS proveedor, COUNT(DISTINCT ps.product_barcode) AS productos
FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
GROUP BY s.name ORDER BY 2 DESC LIMIT 10;

\echo
\echo === CONEXIONES ACTIVAS ===
SELECT count(*) AS conexiones, state FROM pg_stat_activity
WHERE datname = current_database() GROUP BY state;
'@

$sqlFile = Join-Path $env:TEMP ("pos-perf-{0}.sql" -f (Get-Date -Format 'HHmmss'))
$sql | Set-Content -LiteralPath $sqlFile -Encoding UTF8

$previousPassword = $env:PGPASSWORD
try {
    $env:PGPASSWORD = $dbPassword
    Write-Host ''
    Write-Host "Medicion de solo lectura sobre ${dbHost}:${dbPort}/${dbName}" -ForegroundColor Cyan
    Write-Host ''
    $result = Invoke-Native -FilePath $psql -Arguments @(
        "--host=$dbHost", "--port=$dbPort", "--username=$dbUser", "--dbname=$dbName",
        '--no-password', "--file=$sqlFile"
    )
    $result.Output | ForEach-Object { Write-Host $_ }
    if ($result.ExitCode -ne 0) { throw "psql termino con codigo $($result.ExitCode)" }
    Write-Host ''
    Write-Host 'Listo. Comparta la salida completa.' -ForegroundColor Green
} finally {
    Remove-Item -LiteralPath $sqlFile -Force -ErrorAction SilentlyContinue
    if ([string]::IsNullOrEmpty($previousPassword)) {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $null, 'Process')
    } else {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $previousPassword, 'Process')
    }
}
