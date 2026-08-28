[CmdletBinding()]
param(
    [switch]$ConfirmFix,
    [string]$PosFolder = 'C:\Users\surti\Desktop\POS',
    [string]$ServiceName = 'POS_Server'
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

if ($ConfirmFix) {
    $service = Get-Service $ServiceName -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped') {
        throw "Detenga $ServiceName antes de aplicar la correccion (estado actual: $($service.Status))."
    }
}

$psql = Resolve-Tool -CommandName 'psql'
$closing = if ($ConfirmFix) { 'COMMIT;' } else { 'ROLLBACK;' }

$sql = @"
BEGIN;

CREATE TEMP VIEW codigos_faltantes AS
SELECT DISTINCT codigo FROM (
    SELECT sd.barcode AS codigo FROM sale_details sd
      LEFT JOIN products p ON p.barcode = sd.barcode
     WHERE sd.barcode IS NOT NULL AND sd.barcode <> '' AND p.barcode IS NULL
    UNION
    SELECT rd.barcode FROM return_details rd
      LEFT JOIN products p ON p.barcode = rd.barcode
     WHERE rd.barcode IS NOT NULL AND rd.barcode <> '' AND p.barcode IS NULL
    UNION
    SELECT sm.barcode FROM stock_movements sm
      LEFT JOIN products p ON p.barcode = sm.barcode
     WHERE sm.barcode IS NOT NULL AND sm.barcode <> '' AND p.barcode IS NULL
    UNION
    SELECT poi."productBarcode" FROM purchase_order_items poi
      LEFT JOIN products p ON p.barcode = poi."productBarcode"
     WHERE poi."productBarcode" IS NOT NULL AND poi."productBarcode" <> '' AND p.barcode IS NULL
    UNION
    SELECT ps.product_barcode FROM product_suppliers ps
      LEFT JOIN products p ON p.barcode = ps.product_barcode
     WHERE ps.product_barcode IS NOT NULL AND ps.product_barcode <> '' AND p.barcode IS NULL
    UNION
    SELECT pr."baseProductBarcode" FROM products pr
      LEFT JOIN products p ON p.barcode = pr."baseProductBarcode"
     WHERE pr."baseProductBarcode" IS NOT NULL AND pr."baseProductBarcode" <> '' AND p.barcode IS NULL
) fuente;

\echo === CODIGOS SIN PRODUCTO (ANTES) ===
SELECT codigo FROM codigos_faltantes ORDER BY codigo;

\echo
\echo === DETALLE POR TABLA (ANTES) ===
SELECT 'sale_details' AS tabla, COUNT(*) AS filas_afectadas FROM sale_details sd
  LEFT JOIN products p ON p.barcode = sd.barcode
 WHERE sd.barcode IS NOT NULL AND sd.barcode <> '' AND p.barcode IS NULL
UNION ALL
SELECT 'return_details', COUNT(*) FROM return_details rd
  LEFT JOIN products p ON p.barcode = rd.barcode
 WHERE rd.barcode IS NOT NULL AND rd.barcode <> '' AND p.barcode IS NULL
UNION ALL
SELECT 'stock_movements', COUNT(*) FROM stock_movements sm
  LEFT JOIN products p ON p.barcode = sm.barcode
 WHERE sm.barcode IS NOT NULL AND sm.barcode <> '' AND p.barcode IS NULL
UNION ALL
SELECT 'purchase_order_items', COUNT(*) FROM purchase_order_items poi
  LEFT JOIN products p ON p.barcode = poi."productBarcode"
 WHERE poi."productBarcode" IS NOT NULL AND poi."productBarcode" <> '' AND p.barcode IS NULL
UNION ALL
SELECT 'product_suppliers', COUNT(*) FROM product_suppliers ps
  LEFT JOIN products p ON p.barcode = ps.product_barcode
 WHERE ps.product_barcode IS NOT NULL AND ps.product_barcode <> '' AND p.barcode IS NULL
UNION ALL
SELECT 'products.baseProductBarcode', COUNT(*) FROM products pr
  LEFT JOIN products p ON p.barcode = pr."baseProductBarcode"
 WHERE pr."baseProductBarcode" IS NOT NULL AND pr."baseProductBarcode" <> '' AND p.barcode IS NULL;

\echo
\echo === CREANDO PRODUCTOS MARCADORES INACTIVOS ===
INSERT INTO products (barcode, "productName", quantity, "purchasePrice", "salePrice", "isActive")
SELECT codigo, '[HISTORICO] ' || codigo, 0, 0, 0, false
FROM codigos_faltantes
ON CONFLICT (barcode) DO NOTHING;

\echo
\echo === VERIFICACION FINAL (TODO DEBE QUEDAR EN 0) ===
SELECT 'sale_details' AS tabla, COUNT(*) AS huerfanos FROM sale_details sd
  LEFT JOIN products p ON p.barcode = sd.barcode
 WHERE sd.barcode IS NOT NULL AND sd.barcode <> '' AND p.barcode IS NULL
UNION ALL
SELECT 'return_details', COUNT(*) FROM return_details rd
  LEFT JOIN products p ON p.barcode = rd.barcode
 WHERE rd.barcode IS NOT NULL AND rd.barcode <> '' AND p.barcode IS NULL
UNION ALL
SELECT 'stock_movements', COUNT(*) FROM stock_movements sm
  LEFT JOIN products p ON p.barcode = sm.barcode
 WHERE sm.barcode IS NOT NULL AND sm.barcode <> '' AND p.barcode IS NULL
UNION ALL
SELECT 'purchase_order_items', COUNT(*) FROM purchase_order_items poi
  LEFT JOIN products p ON p.barcode = poi."productBarcode"
 WHERE poi."productBarcode" IS NOT NULL AND poi."productBarcode" <> '' AND p.barcode IS NULL
UNION ALL
SELECT 'product_suppliers', COUNT(*) FROM product_suppliers ps
  LEFT JOIN products p ON p.barcode = ps.product_barcode
 WHERE ps.product_barcode IS NOT NULL AND ps.product_barcode <> '' AND p.barcode IS NULL
UNION ALL
SELECT 'products.baseProductBarcode', COUNT(*) FROM products pr
  LEFT JOIN products p ON p.barcode = pr."baseProductBarcode"
 WHERE pr."baseProductBarcode" IS NOT NULL AND pr."baseProductBarcode" <> '' AND p.barcode IS NULL;

\echo
\echo === TOTALES DE CONTROL ===
SELECT 'total_ventas' AS chequeo, COUNT(*)::text AS valor FROM sales
UNION ALL SELECT 'total_cierres', COUNT(*)::text FROM cashier_closures
UNION ALL SELECT 'total_egresos', COUNT(*)::text FROM expenses
UNION ALL SELECT 'total_productos', COUNT(*)::text FROM products
UNION ALL SELECT 'marcadores_historicos', COUNT(*)::text FROM products WHERE "productName" LIKE '[HISTORICO]%'
UNION ALL SELECT 'suma_ventas_pagadas', COALESCE(SUM("totalAmount"),0)::text FROM sales
   WHERE deleted_at IS NULL AND UPPER(status) IN ('PAID','CREDIT');

$closing
"@

$sqlFile = Join-Path $env:TEMP ("pos-fix-ref-{0}.sql" -f (Get-Date -Format 'HHmmss'))
$sql | Set-Content -LiteralPath $sqlFile -Encoding UTF8

$previousPassword = $env:PGPASSWORD
try {
    $env:PGPASSWORD = $dbPassword
    Write-Host ''
    if ($ConfirmFix) {
        Write-Host "APLICANDO CORRECCION sobre ${dbHost}:${dbPort}/${dbName}" -ForegroundColor Yellow
    } else {
        Write-Host "PRUEBA EN SECO sobre ${dbHost}:${dbPort}/${dbName}" -ForegroundColor Cyan
        Write-Host 'Todo se ejecuta y se revierte. No se guarda nada.' -ForegroundColor Cyan
    }
    Write-Host ''

    $result = Invoke-Native -FilePath $psql -Arguments @(
        "--host=$dbHost", "--port=$dbPort", "--username=$dbUser", "--dbname=$dbName",
        '--no-password', '--set=ON_ERROR_STOP=1', "--file=$sqlFile"
    )
    $result.Output | ForEach-Object { Write-Host $_ }
    if ($result.ExitCode -ne 0) { throw "psql termino con codigo $($result.ExitCode)" }

    Write-Host ''
    if ($ConfirmFix) {
        Write-Host 'CORRECCION APLICADA.' -ForegroundColor Green
    } else {
        Write-Host 'PRUEBA OK. Nada fue guardado. Para aplicar: agregue -ConfirmFix' -ForegroundColor Green
    }
} finally {
    Remove-Item -LiteralPath $sqlFile -Force -ErrorAction SilentlyContinue
    if ([string]::IsNullOrEmpty($previousPassword)) {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $null, 'Process')
    } else {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $previousPassword, 'Process')
    }
}
