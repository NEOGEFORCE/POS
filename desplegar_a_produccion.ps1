[CmdletBinding()]
param(
    [switch]$ConfirmDeploy,
    [string]$ProductionShare = "\\DESKTOP-VK2U90S\Users\surti\Desktop\POS",
    [string]$ServiceComputer = "DESKTOP-VK2U90S",
    [string]$ServiceName = "POS_Server",
    [string]$HealthUrl = "http://192.168.1.6:8080/api/health"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $ConfirmDeploy) {
    throw "Despliegue cancelado. Use -ConfirmDeploy despues de verificar destino, respaldo y ventana operativa."
}

$root = $PSScriptRoot
$backend = Join-Path $root "backPOS-go"
$frontend = Join-Path $root "FrontPOS-main"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stagingRoot = Join-Path $ProductionShare ".deploy-staging\$timestamp"
$rollbackRoot = Join-Path $ProductionShare ".rollback\$timestamp"
$remoteNssm = "C:\Users\surti\Desktop\POS\nssm.exe"
$remoteServer = Join-Path $ProductionShare "server.exe"
$remoteOut = Join-Path $ProductionShare "out"
$stagedServer = Join-Path $stagingRoot "server.exe"
$stagedOut = Join-Path $stagingRoot "out"
$serviceStopped = $false
$activated = $false

function Invoke-RobocopyChecked {
    param([string]$Source, [string]$Destination, [string[]]$ExtraArgs = @())
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    & robocopy $Source $Destination /E /R:2 /W:2 /NFL /NDL /NP @ExtraArgs
    if ($LASTEXITCODE -ge 8) {
        throw "Robocopy fallo con codigo ${LASTEXITCODE}: $Source -> $Destination"
    }
}

function Invoke-RemoteNssm {
    param([ValidateSet("start", "stop", "status")][string]$Action)
    Invoke-Command -ComputerName $ServiceComputer -ScriptBlock {
        param($Nssm, $Command, $Name)
        & $Nssm $Command $Name
        if ($LASTEXITCODE -ne 0) { throw "NSSM $Command fallo para $Name" }
    } -ArgumentList $remoteNssm, $Action, $ServiceName
}

function Restore-PreviousRelease {
    Write-Warning "Restaurando release anterior..."
    try { Invoke-RemoteNssm -Action stop } catch { Write-Warning $_ }
    if (Test-Path $remoteServer) { Remove-Item $remoteServer -Force }
    if (Test-Path $remoteOut) { Remove-Item $remoteOut -Recurse -Force }
    $backupServer = Join-Path $rollbackRoot "server.exe"
    $backupOut = Join-Path $rollbackRoot "out"
    if (Test-Path $backupServer) { Move-Item $backupServer $remoteServer -Force }
    if (Test-Path $backupOut) { Move-Item $backupOut $remoteOut -Force }
    Invoke-RemoteNssm -Action start
}

try {
    foreach ($path in @($backend, $frontend, $ProductionShare)) {
        if (-not (Test-Path $path)) { throw "Ruta requerida no disponible: $path" }
    }
    if (-not (Test-Path (Join-Path $ProductionShare "nssm.exe"))) {
        throw "nssm.exe no existe en el destino $ProductionShare"
    }

    Write-Host "[1/8] Ejecutando respaldo verificable..." -ForegroundColor Cyan
    & (Join-Path $root "hacer_respaldo.ps1") -ProductionShare $ProductionShare
    if ($LASTEXITCODE -ne 0) { throw "El respaldo no termino correctamente" }

    Write-Host "[2/8] Validando tests y tipos..." -ForegroundColor Cyan
    Push-Location $backend
    try {
        & go test ./...
        if ($LASTEXITCODE -ne 0) { throw "go test fallo" }
        & go vet ./internal/... ./cmd/api ./migrations
        if ($LASTEXITCODE -ne 0) { throw "go vet fallo" }
        & go run ./cmd/migrate status
        if ($LASTEXITCODE -ne 0) { throw "migrate status fallo; no se aplico ninguna migracion" }
    } finally { Pop-Location }

    Push-Location $frontend
    try {
        & npm test
        if ($LASTEXITCODE -ne 0) { throw "npm test fallo" }
        & npm run typecheck
        if ($LASTEXITCODE -ne 0) { throw "typecheck fallo" }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "frontend build fallo" }
    } finally { Pop-Location }

    Write-Host "[3/8] Compilando backend..." -ForegroundColor Cyan
    $localDeploy = Join-Path $backend ".deploy"
    New-Item -ItemType Directory -Path $localDeploy -Force | Out-Null
    Push-Location $backend
    try {
        & go build -trimpath -o (Join-Path $localDeploy "server.exe") ./cmd/api
        if ($LASTEXITCODE -ne 0) { throw "go build fallo" }
    } finally { Pop-Location }

    Write-Host "[4/8] Copiando artefactos a staging remoto..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
    Copy-Item (Join-Path $localDeploy "server.exe") $stagedServer -Force
    Invoke-RobocopyChecked -Source (Join-Path $frontend "out") -Destination $stagedOut
    $localHash = (Get-FileHash (Join-Path $localDeploy "server.exe") -Algorithm SHA256).Hash
    $remoteHash = (Get-FileHash $stagedServer -Algorithm SHA256).Hash
    if ($localHash -ne $remoteHash) { throw "Checksum del servidor en staging no coincide" }

    Write-Host "[5/8] Deteniendo servicio NSSM..." -ForegroundColor Cyan
    Invoke-RemoteNssm -Action stop
    $serviceStopped = $true

    Write-Host "[6/8] Activando release y conservando rollback..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $rollbackRoot -Force | Out-Null
    if (Test-Path $remoteServer) { Move-Item $remoteServer (Join-Path $rollbackRoot "server.exe") -Force }
    if (Test-Path $remoteOut) { Move-Item $remoteOut (Join-Path $rollbackRoot "out") -Force }
    Move-Item $stagedServer $remoteServer -Force
    Move-Item $stagedOut $remoteOut -Force
    $activated = $true

    Write-Host "[7/8] Iniciando servicio..." -ForegroundColor Cyan
    Invoke-RemoteNssm -Action start
    $serviceStopped = $false

    Write-Host "[8/8] Ejecutando healthcheck..." -ForegroundColor Cyan
    $healthy = $false
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 15 -UseBasicParsing
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { $healthy = $true; break }
        } catch {
            Write-Warning "Healthcheck $attempt/5 fallo: $($_.Exception.Message)"
        }
        Start-Sleep -Seconds ([Math]::Min(10, $attempt * 2))
    }
    if (-not $healthy) { throw "El nuevo release no supero el healthcheck" }

    Remove-Item $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Deploy $timestamp completado. Rollback conservado en $rollbackRoot" -ForegroundColor Green
} catch {
    Write-Error $_
    if ($activated) {
        Restore-PreviousRelease
    } elseif ($serviceStopped) {
        try { Invoke-RemoteNssm -Action start } catch { Write-Warning $_ }
    }
    throw
}
