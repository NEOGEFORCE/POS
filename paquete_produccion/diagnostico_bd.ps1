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
\pset footer off
SELECT 'historial_migraciones_existe' AS chequeo,
       COALESCE((to_regclass('public.schema_migrations') IS NOT NULL)::text, 'false') AS valor;

SELECT 'closures_columna_legacy_coins500_1000' AS chequeo,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='cashier_closures'
                 AND column_name='coins500_1000')::text AS valor;

SELECT 'closures_filas_que_cambiarian_003' AS chequeo,
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema='public' AND table_name='cashier_closures'
                           AND column_name='coins500_1000')
            THEN (SELECT COUNT(*)::text FROM cashier_closures
                  WHERE COALESCE(coins500,0)=0 AND COALESCE("coins500_1000",0)<>0)
            ELSE '0 (columna no existe)' END AS valor;

SELECT 'ventas_clienttxid_duplicados_bloquea_009' AS chequeo,
       (SELECT COUNT(*)::text FROM (
            SELECT "clientTxId" FROM sales
            WHERE "clientTxId" IS NOT NULL AND "clientTxId" <> ''
            GROUP BY "clientTxId" HAVING COUNT(*) > 1) d) AS valor;

SELECT 'kardex_huerfano_bloquea_fk_009' AS chequeo,
       (SELECT COUNT(*)::text FROM stock_movements sm
        LEFT JOIN products p ON p.barcode = sm.barcode
        WHERE p.barcode IS NULL) AS valor;

SELECT 'detalles_devolucion_huerfanos_bloquea_fk_009' AS chequeo,
       CASE WHEN to_regclass('public.return_details') IS NULL THEN 'tabla no existe'
            ELSE (SELECT COUNT(*)::text FROM return_details rd
                  LEFT JOIN returns r ON r.id = rd."returnId"
                  WHERE r.id IS NULL) END AS valor;

SELECT 'sale_details_costprice_nulos_001' AS chequeo,
       (SELECT COUNT(*)::text FROM sale_details WHERE "costPrice" IS NULL) AS valor;

SELECT 'expenses_columna_legacy_created_by_dni' AS chequeo,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='expenses'
                 AND column_name='created_by_dni')::text AS valor;

SELECT 'proveedores_columnas_legacy_dias' AS chequeo,
       (SELECT COUNT(*)::text FROM information_schema.columns
        WHERE table_schema='public' AND table_name='suppliers'
          AND column_name IN ('visit_day','delivery_day')) AS valor;

SELECT 'vista_materializada_dashboard_existe' AS chequeo,
       (to_regclass('public.mv_dashboard_stats_monthly') IS NOT NULL)::text AS valor;

SELECT 'total_ventas_registradas' AS chequeo, COUNT(*)::text AS valor FROM sales;
SELECT 'total_cierres_registrados' AS chequeo, COUNT(*)::text AS valor FROM cashier_closures;
SELECT 'total_egresos_registrados' AS chequeo, COUNT(*)::text AS valor FROM expenses;
SELECT 'total_productos' AS chequeo, COUNT(*)::text AS valor FROM products;
SELECT 'total_movimientos_kardex' AS chequeo, COUNT(*)::text AS valor FROM stock_movements;
SELECT 'suma_total_ventas_pagadas' AS chequeo,
       COALESCE(SUM("totalAmount"),0)::text AS valor
FROM sales WHERE deleted_at IS NULL AND UPPER(status) IN ('PAID','CREDIT');
SELECT 'tamano_base_datos' AS chequeo, pg_size_pretty(pg_database_size(current_database())) AS valor;
'@

$sqlFile = Join-Path $env:TEMP ("pos-diagnostico-{0}.sql" -f (Get-Date -Format 'HHmmss'))
$sql | Set-Content -LiteralPath $sqlFile -Encoding UTF8

$previousPassword = $env:PGPASSWORD
try {
    $env:PGPASSWORD = $dbPassword
    Write-Host ''
    Write-Host "Diagnostico de solo lectura sobre ${dbHost}:${dbPort}/${dbName}" -ForegroundColor Cyan
    Write-Host 'No se modifica ningun dato.' -ForegroundColor Cyan
    Write-Host ''

    $result = Invoke-Native -FilePath $psql -Arguments @(
        "--host=$dbHost", "--port=$dbPort", "--username=$dbUser", "--dbname=$dbName",
        '--no-password', '--tuples-only', '--no-align', '--field-separator=|',
        "--file=$sqlFile"
    )

    $result.Output | Where-Object { $_ -match '\S' } | ForEach-Object {
        $parts = $_ -split '\|', 2
        if ($parts.Count -eq 2) {
            Write-Host ("  {0,-46} {1}" -f $parts[0], $parts[1].Trim())
        } else {
            Write-Host "  $_"
        }
    }

    if ($result.ExitCode -ne 0) { throw "psql termino con codigo $($result.ExitCode)" }
    Write-Host ''
    Write-Host 'Diagnostico completado. Comparta esta salida.' -ForegroundColor Green
} finally {
    Remove-Item -LiteralPath $sqlFile -Force -ErrorAction SilentlyContinue
    if ([string]::IsNullOrEmpty($previousPassword)) {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $null, 'Process')
    } else {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $previousPassword, 'Process')
    }
}
