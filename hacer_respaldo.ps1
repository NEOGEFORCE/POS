[CmdletBinding()]
param(
    [string]$ProductionShare = "\\DESKTOP-VK2U90S\Users\surti\Desktop\POS",
    [string]$DestinationRoot = $(if ($env:POS_BACKUP_ROOT) { $env:POS_BACKUP_ROOT } else { "C:\Users\jaide\OneDrive\Desktop\Respaldo" }),
    [string]$PgDumpPath = $(if ($env:POS_PG_DUMP) { $env:POS_PG_DUMP } else { "S:\Program Files\PostgreSQL\18\bin\pg_dump.exe" }),
    [string]$DbHost = $(if ($env:DB_HOST) { $env:DB_HOST } else { "192.168.1.6" }),
    [string]$DbUser = $(if ($env:DB_USER) { $env:DB_USER } else { "postgres" }),
    [string]$DbName = $(if ($env:DB_NAME) { $env:DB_NAME } else { "sistemapos" }),
    [int]$Keep = 10
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$destination = Join-Path $DestinationRoot $timestamp
$dbPassword = $env:POS_DB_PASSWORD

function Invoke-RobocopyChecked {
    param([string]$Source, [string]$Destination, [string[]]$ExtraArgs = @())
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    & robocopy $Source $Destination /E /R:1 /W:1 /NFL /NDL /NP @ExtraArgs
    if ($LASTEXITCODE -ge 8) { throw "Robocopy fallo con codigo ${LASTEXITCODE}: $Source -> $Destination" }
}

if ([string]::IsNullOrWhiteSpace($dbPassword)) { throw "Falta POS_DB_PASSWORD para generar el respaldo restaurable." }
if (-not (Test-Path $ProductionShare)) { throw "No se puede acceder al destino de produccion: $ProductionShare" }
if (-not (Test-Path $PgDumpPath)) {
    $command = Get-Command pg_dump -ErrorAction SilentlyContinue
    if ($command) { $PgDumpPath = $command.Source } else { throw "pg_dump no encontrado: $PgDumpPath" }
}

New-Item -ItemType Directory -Path $destination -Force | Out-Null
Write-Host "Respaldo POS: $destination" -ForegroundColor Cyan

try {
    Write-Host "[1/3] Codigo fuente sin secretos..." -ForegroundColor Yellow
    Invoke-RobocopyChecked -Source $PSScriptRoot -Destination (Join-Path $destination "codigo_fuente") -ExtraArgs @(
        "/XD", ".next", "node_modules", ".git", "out", "Respaldo", ".deploy",
        "/XF", ".env", ".env.*", "*.key", "*.pem", "*.pfx"
    )

    Write-Host "[2/3] Artefactos de produccion sin secretos..." -ForegroundColor Yellow
    Invoke-RobocopyChecked -Source $ProductionShare -Destination (Join-Path $destination "produccion") -ExtraArgs @(
        "/XD", ".deploy-staging",
        "/XF", ".env", ".env.*", "*.key", "*.pem", "*.pfx"
    )

    Write-Host "[3/3] Dump PostgreSQL..." -ForegroundColor Yellow
    $dumpFile = Join-Path $destination "base_de_datos_$timestamp.sql"
    $previousPassword = $env:PGPASSWORD
    try {
        $env:PGPASSWORD = $dbPassword
        & $PgDumpPath -h $DbHost -U $DbUser -d $DbName -F plain -f $dumpFile
        if ($LASTEXITCODE -ne 0) { throw "pg_dump termino con codigo $LASTEXITCODE" }
    } finally {
        $env:PGPASSWORD = $previousPassword
    }
    if (-not (Test-Path $dumpFile) -or (Get-Item $dumpFile).Length -le 0) { throw "El dump no existe o esta vacio" }

    $manifest = @{
        createdAt = (Get-Date).ToString("o")
        productionShare = $ProductionShare
        database = "$DbHost/$DbName"
        dumpSha256 = (Get-FileHash $dumpFile -Algorithm SHA256).Hash
        serverSha256 = if (Test-Path (Join-Path $ProductionShare "server.exe")) { (Get-FileHash (Join-Path $ProductionShare "server.exe") -Algorithm SHA256).Hash } else { $null }
    }
    $manifest | ConvertTo-Json | Set-Content (Join-Path $destination "manifest.json") -Encoding UTF8

    $backups = @(Get-ChildItem $DestinationRoot -Directory | Sort-Object Name)
    if ($backups.Count -gt $Keep) {
        $backups | Select-Object -First ($backups.Count - $Keep) | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
    }
    Write-Host "Respaldo verificado. Dump: $([math]::Round((Get-Item $dumpFile).Length / 1MB, 2)) MB" -ForegroundColor Green
} catch {
    Remove-Item $destination -Recurse -Force -ErrorAction SilentlyContinue
    throw
}
