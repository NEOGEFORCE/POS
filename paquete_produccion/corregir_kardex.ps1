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

# El bloque corre completo dentro de una transaccion. En modo prueba termina en
# ROLLBACK, asi que se demuestra que las sentencias funcionan sin guardar nada.
$sql = @"
BEGIN;

\echo === CODIGOS HUERFANOS Y SI EXISTE EQUIVALENCIA EXACTA ===
SELECT o.barcode AS codigo_huerfano,
       o.movimientos,
       COALESCE(p.barcode, '-- sin equivalencia --') AS producto_actual,
       COALESCE(p."productName", '') AS nombre_actual
FROM (
    SELECT sm.barcode, COUNT(*) AS movimientos
    FROM stock_movements sm
    LEFT JOIN products pr ON pr.barcode = sm.barcode
    WHERE pr.barcode IS NULL
    GROUP BY sm.barcode
) o
LEFT JOIN products p
       ON o.barcode = ANY(string_to_array(COALESCE(p.alternate_codes, ''), ','))
ORDER BY o.movimientos DESC;

\echo
\echo === PASO 1: REASIGNAR MOVIMIENTOS CON EQUIVALENCIA EXACTA ===
WITH mapa AS (
    SELECT DISTINCT sm.barcode AS viejo, p.barcode AS nuevo
    FROM stock_movements sm
    LEFT JOIN products pr ON pr.barcode = sm.barcode
    JOIN products p ON sm.barcode = ANY(string_to_array(COALESCE(p.alternate_codes, ''), ','))
    WHERE pr.barcode IS NULL
)
UPDATE stock_movements sm
SET barcode = m.nuevo
FROM mapa m
WHERE sm.barcode = m.viejo;

\echo
\echo === PASO 2: CREAR PRODUCTOS MARCADORES PARA EL RESTO ===
INSERT INTO products (barcode, "productName", quantity, "purchasePrice", "salePrice", "isActive")
SELECT DISTINCT sm.barcode,
       '[HISTORICO] ' || sm.barcode,
       0, 0, 0, false
FROM stock_movements sm
LEFT JOIN products p ON p.barcode = sm.barcode
WHERE p.barcode IS NULL
  AND sm.barcode IS NOT NULL
  AND sm.barcode <> ''
ON CONFLICT (barcode) DO NOTHING;

\echo
\echo === VERIFICACION FINAL ===
SELECT 'kardex_huerfano_restante' AS chequeo,
       (SELECT COUNT(*) FROM stock_movements sm
        LEFT JOIN products p ON p.barcode = sm.barcode
        WHERE p.barcode IS NULL) AS valor
UNION ALL
SELECT 'productos_marcadores_historicos',
       (SELECT COUNT(*) FROM products WHERE "productName" LIKE '[HISTORICO]%')
UNION ALL
SELECT 'total_productos', (SELECT COUNT(*) FROM products)
UNION ALL
SELECT 'total_movimientos_kardex', (SELECT COUNT(*) FROM stock_movements)
UNION ALL
SELECT 'total_ventas', (SELECT COUNT(*) FROM sales)
UNION ALL
SELECT 'total_cierres', (SELECT COUNT(*) FROM cashier_closures);

$closing
"@

$sqlFile = Join-Path $env:TEMP ("pos-fix-kardex-{0}.sql" -f (Get-Date -Format 'HHmmss'))
$sql | Set-Content -LiteralPath $sqlFile -Encoding UTF8

$previousPassword = $env:PGPASSWORD
try {
    $env:PGPASSWORD = $dbPassword
    Write-Host ''
    if ($ConfirmFix) {
        Write-Host "APLICANDO CORRECCION sobre ${dbHost}:${dbPort}/${dbName}" -ForegroundColor Yellow
    } else {
        Write-Host "PRUEBA EN SECO sobre ${dbHost}:${dbPort}/${dbName}" -ForegroundColor Cyan
        Write-Host 'Todo se ejecuta y se revierte. No se guarda ningun cambio.' -ForegroundColor Cyan
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
        Write-Host 'CORRECCION APLICADA. El kardex ya no tiene huerfanos.' -ForegroundColor Green
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
