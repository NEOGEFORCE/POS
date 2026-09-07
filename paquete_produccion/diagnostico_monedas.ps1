[CmdletBinding()]
param(
    [string]$PsqlDir = "C:\Program Files\PostgreSQL\18\bin",
    [string]$DbName  = "sistemapos",
    [string]$DbUser  = "postgres",
    [string]$DbHost  = "localhost",
    [int]$DbPort     = 5432
)

# SOLO LECTURA. Este script no modifica nada: unicamente muestra como quedaron
# guardados los egresos pagados con alcancia, para saber si el problema esta en
# el codigo o en los datos.

$ErrorActionPreference = "Stop"
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

$psql = Join-Path $PsqlDir "psql.exe"
if (-not (Test-Path $psql)) { throw "No se encontro psql.exe en $PsqlDir" }

$envFile = Join-Path $PSScriptRoot "..\backPOS-go\.env"
$password = $null
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*DB_PASSWORD\s*=\s*(.+)\s*$') {
            $password = $Matches[1].Trim('"').Trim("'")
            break
        }
    }
}
if (-not $password) { $password = Read-Host "Contrasena de PostgreSQL" -AsSecureString | ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) } }

$env:PGPASSWORD = $password
try {
    $consultas = [ordered]@{
        "1. Egresos con texto de ALCANCIA y su columna coins_amount" = @"
SELECT id,
       LEFT(COALESCE(description,''), 28) AS concepto,
       date::date AS fecha,
       (amount + COALESCE(tax_amount,0))::numeric(12,0) AS total,
       COALESCE(cash_amount,0)::numeric(12,0)  AS caja,
       COALESCE(fondo_amount,0)::numeric(12,0) AS fondo,
       COALESCE(coins_amount,0)::numeric(12,0) AS monedas,
       ((amount + COALESCE(tax_amount,0))
         - (COALESCE(cash_amount,0)+COALESCE(nequi_amount,0)
            +COALESCE(daviplata_amount,0)+COALESCE(fondo_amount,0)
            +COALESCE(coins_amount,0)))::numeric(12,0) AS sin_asignar,
       LEFT(COALESCE("paymentSource",''), 60) AS canal_texto
FROM expenses
WHERE deleted_at IS NULL
  AND UPPER(status) = 'PAID'
  AND (UPPER(COALESCE("paymentSource",'')) LIKE '%ALCANCIA%'
    OR UPPER(COALESCE("paymentSource",'')) LIKE '%ALCANC_A%'
    OR UPPER(COALESCE("paymentSource",'')) LIKE '%MONEDA%'
    OR COALESCE(coins_amount,0) > 0)
ORDER BY date DESC
LIMIT 30;
"@
        "2. Resumen del problema" = @"
SELECT COUNT(*) AS filas_con_texto_alcancia,
       SUM(CASE WHEN COALESCE(coins_amount,0) > 0 THEN 1 ELSE 0 END) AS con_columna_correcta,
       SUM(CASE WHEN COALESCE(coins_amount,0) = 0 THEN 1 ELSE 0 END) AS con_columna_en_cero,
       COALESCE(SUM(
         (amount + COALESCE(tax_amount,0))
         - (COALESCE(cash_amount,0)+COALESCE(nequi_amount,0)
            +COALESCE(daviplata_amount,0)+COALESCE(fondo_amount,0)
            +COALESCE(coins_amount,0))
       ), 0)::numeric(12,0) AS plata_sin_asignar
FROM expenses
WHERE deleted_at IS NULL
  AND UPPER(status) = 'PAID'
  AND (UPPER(COALESCE("paymentSource",'')) LIKE '%ALCANCIA%'
    OR UPPER(COALESCE("paymentSource",'')) LIKE '%ALCANC_A%'
    OR UPPER(COALESCE("paymentSource",'')) LIKE '%MONEDA%');
"@
        "3. Total de monedas gastado segun las columnas" = @"
SELECT COALESCE(SUM(coins_amount), 0)::numeric(12,0) AS total_columna_monedas,
       COUNT(*) FILTER (WHERE COALESCE(coins_amount,0) > 0) AS egresos_con_monedas
FROM expenses
WHERE deleted_at IS NULL AND UPPER(status) = 'PAID';
"@
    }

    foreach ($titulo in $consultas.Keys) {
        Write-Host ""
        Write-Host "=== $titulo ===" -ForegroundColor Cyan
        $res = Invoke-Native -FilePath $psql -Arguments @(
            "-h", $DbHost, "-p", "$DbPort", "-U", $DbUser, "-d", $DbName,
            "-P", "pager=off", "-c", $consultas[$titulo]
        )
        $res.Output | ForEach-Object { Write-Host $_ }
        if ($res.ExitCode -ne 0) { Write-Warning "La consulta termino con codigo $($res.ExitCode)" }
    }

    Write-Host ""
    Write-Host "Listo. Nada fue modificado." -ForegroundColor Green
    Write-Host "Si 'con_columna_en_cero' es mayor que 0, el problema esta en los datos" -ForegroundColor Yellow
    Write-Host "y 'plata_sin_asignar' es el monto de alcancia que nunca se descontaba." -ForegroundColor Yellow
} finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
