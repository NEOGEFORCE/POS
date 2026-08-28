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
\echo === RESUMEN DE CODIGOS HUERFANOS EN KARDEX ===
SELECT sm.barcode AS codigo,
       COUNT(*) AS movimientos,
       MIN(sm.date)::date AS primero,
       MAX(sm.date)::date AS ultimo,
       string_agg(DISTINCT sm.reason, ', ') AS motivos
FROM stock_movements sm
LEFT JOIN products p ON p.barcode = sm.barcode
WHERE p.barcode IS NULL
GROUP BY sm.barcode
ORDER BY COUNT(*) DESC;

\echo
\echo === CLASIFICACION ===
SELECT CASE
         WHEN sm.barcode IS NULL OR sm.barcode = '' THEN 'vacio'
         WHEN sm.barcode ILIKE 'MISC%' THEN 'venta rapida (MISC)'
         WHEN sm.barcode = '0000' THEN 'venta rapida (0000)'
         WHEN sm.barcode ~ '^[0-9]+$' THEN 'codigo numerico (producto borrado)'
         ELSE 'otro'
       END AS tipo,
       COUNT(*) AS movimientos,
       COUNT(DISTINCT sm.barcode) AS codigos_distintos
FROM stock_movements sm
LEFT JOIN products p ON p.barcode = sm.barcode
WHERE p.barcode IS NULL
GROUP BY 1
ORDER BY 2 DESC;

\echo
\echo === APARECEN ESOS CODIGOS EN VENTAS? ===
SELECT COUNT(DISTINCT sd.barcode) AS codigos_en_ventas
FROM sale_details sd
LEFT JOIN products p ON p.barcode = sd.barcode
WHERE p.barcode IS NULL;
'@

$sqlFile = Join-Path $env:TEMP ("pos-kardex-{0}.sql" -f (Get-Date -Format 'HHmmss'))
$sql | Set-Content -LiteralPath $sqlFile -Encoding UTF8

$previousPassword = $env:PGPASSWORD
try {
    $env:PGPASSWORD = $dbPassword
    Write-Host ''
    Write-Host "Diagnostico de kardex sobre ${dbHost}:${dbPort}/${dbName} (solo lectura)" -ForegroundColor Cyan
    Write-Host ''
    $result = Invoke-Native -FilePath $psql -Arguments @(
        "--host=$dbHost", "--port=$dbPort", "--username=$dbUser", "--dbname=$dbName",
        '--no-password', "--file=$sqlFile"
    )
    $result.Output | ForEach-Object { Write-Host $_ }
    if ($result.ExitCode -ne 0) { throw "psql termino con codigo $($result.ExitCode)" }
    Write-Host ''
    Write-Host 'Listo. Comparta esta salida.' -ForegroundColor Green
} finally {
    Remove-Item -LiteralPath $sqlFile -Force -ErrorAction SilentlyContinue
    if ([string]::IsNullOrEmpty($previousPassword)) {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $null, 'Process')
    } else {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $previousPassword, 'Process')
    }
}
