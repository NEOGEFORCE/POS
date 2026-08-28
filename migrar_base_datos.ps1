[CmdletBinding()]
param(
    [switch]$ConfirmMigrate,
    [switch]$ConfirmServiceStopped,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedTarget,
    [string]$BackendPath = (Join-Path $PSScriptRoot 'backPOS-go'),
    [string]$BackupScript = (Join-Path $PSScriptRoot 'respaldar_base_datos.ps1'),
    [string]$BackupRoot = $(if ($env:POS_DB_BACKUP_ROOT) { $env:POS_DB_BACKUP_ROOT } else { Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'POS-Backups\Database' }),
    [string]$PgDumpPath = $env:POS_PG_DUMP,
    [string]$PgRestorePath = $env:POS_PG_RESTORE,
    [string]$GoPath = $env:POS_GO,
    [string]$DbHost = $env:DB_HOST,
    [ValidateRange(1, 65535)]
    [int]$DbPort = $(if ($env:DB_PORT) { [int]$env:DB_PORT } else { 5432 }),
    [string]$DbUser = $env:DB_USER,
    [string]$DbName = $env:DB_NAME,
    [ValidateRange(1, 240)]
    [int]$TimeoutMinutes = 30,
    [ValidateRange(1, 365)]
    [int]$KeepBackups = 14
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-RequiredCommand {
    param([string]$ConfiguredPath, [string]$CommandName)
    if (-not [string]::IsNullOrWhiteSpace($ConfiguredPath)) {
        if (-not (Test-Path -LiteralPath $ConfiguredPath -PathType Leaf)) {
            throw "$CommandName no existe en la ruta configurada: $ConfiguredPath"
        }
        return (Resolve-Path -LiteralPath $ConfiguredPath).Path
    }
    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw "$CommandName no fue encontrado. Configure POS_GO o agregue Go al PATH."
}

function Restore-EnvironmentValue {
    param([string]$Name, [AllowNull()][string]$Value)
    if ([string]::IsNullOrEmpty($Value)) {
        [Environment]::SetEnvironmentVariable($Name, $null, [EnvironmentVariableTarget]::Process)
    } else {
        [Environment]::SetEnvironmentVariable($Name, $Value, [EnvironmentVariableTarget]::Process)
    }
}

if (-not $ConfirmMigrate) {
    throw 'Migración cancelada: use -ConfirmMigrate después de revisar respaldo, destino y ventana.'
}
if (-not $ConfirmServiceStopped) {
    throw 'Migración cancelada: detenga el API que escribe en la base y confirme con -ConfirmServiceStopped.'
}

$required = @{
    DB_HOST = $DbHost
    DB_USER = $DbUser
    DB_NAME = $DbName
    POS_DB_PASSWORD = $env:POS_DB_PASSWORD
}
foreach ($entry in $required.GetEnumerator()) {
    if ([string]::IsNullOrWhiteSpace([string]$entry.Value)) {
        throw "Falta la variable/parámetro obligatorio $($entry.Key)."
    }
}

$actualTarget = "${DbHost}:${DbPort}/${DbName}"
if (-not [string]::Equals($ExpectedTarget.Trim(), $actualTarget, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Destino rechazado. ExpectedTarget='$ExpectedTarget', destino configurado='$actualTarget'."
}
if (-not (Test-Path -LiteralPath $BackendPath -PathType Container)) { throw "Backend no encontrado: $BackendPath" }
if (-not (Test-Path -LiteralPath (Join-Path $BackendPath 'go.mod') -PathType Leaf)) { throw "go.mod no encontrado en: $BackendPath" }
if (-not (Test-Path -LiteralPath (Join-Path $BackendPath 'cmd\migrate\main.go') -PathType Leaf)) { throw 'No se encontró el runner cmd/migrate soportado.' }
if (-not (Test-Path -LiteralPath $BackupScript -PathType Leaf)) { throw "Script de respaldo no encontrado: $BackupScript" }

if (-not [string]::IsNullOrWhiteSpace($env:DB_PASSWORD) -and $env:DB_PASSWORD -ne $env:POS_DB_PASSWORD) {
    throw 'DB_PASSWORD y POS_DB_PASSWORD no coinciden; se cancela para evitar respaldar y migrar bases distintas.'
}

$GoPath = Resolve-RequiredCommand -ConfiguredPath $GoPath -CommandName 'go'
$previousEnvironment = @{
    DB_HOST = $env:DB_HOST
    DB_PORT = $env:DB_PORT
    DB_USER = $env:DB_USER
    DB_NAME = $env:DB_NAME
    DB_PASSWORD = $env:DB_PASSWORD
}

$env:DB_HOST = $DbHost
$env:DB_PORT = [string]$DbPort
$env:DB_USER = $DbUser
$env:DB_NAME = $DbName
$env:DB_PASSWORD = $env:POS_DB_PASSWORD

Write-Host "Destino confirmado: $actualTarget (usuario $DbUser)" -ForegroundColor Cyan
Write-Host 'El runner aplicará todas las migraciones pendientes del catálogo 001–011.' -ForegroundColor Cyan

$backupPath = $null
$logFile = $null

try {
    Push-Location $BackendPath
    try {
        Write-Host '[1/4] Validando catálogo y runner local...' -ForegroundColor Yellow
        $testOutput = @(& $GoPath test ./migrations -count=1 2>&1)
        $testExitCode = $LASTEXITCODE
        if ($testExitCode -ne 0) {
            $testOutput | ForEach-Object { Write-Host $_ }
            throw "Las pruebas de migraciones fallaron con código $testExitCode."
        }
    } finally {
        Pop-Location
    }

    Write-Host '[2/4] Creando respaldo obligatorio y verificable...' -ForegroundColor Yellow
    $backupOutput = @(& $BackupScript -ConfirmBackup -DestinationRoot $BackupRoot -PgDumpPath $PgDumpPath -PgRestorePath $PgRestorePath -DbHost $DbHost -DbPort $DbPort -DbUser $DbUser -DbName $DbName -Keep $KeepBackups)
    if ($backupOutput.Count -eq 0) { throw 'El script de respaldo no devolvió la carpeta verificada.' }
    $backupPath = [string]$backupOutput[-1]
    if (-not (Test-Path -LiteralPath (Join-Path $backupPath 'manifest.json') -PathType Leaf)) {
        throw "El respaldo no contiene manifest.json: $backupPath"
    }

    $logFile = Join-Path $backupPath ("migration-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'))
    "Target: $actualTarget`nStartedAtUtc: $((Get-Date).ToUniversalTime().ToString('o'))" | Set-Content -LiteralPath $logFile -Encoding UTF8

    Push-Location $BackendPath
    try {
        Write-Host '[3/4] Consultando estado y aplicando todas las pendientes...' -ForegroundColor Yellow
        $before = @(& $GoPath run ./cmd/migrate status 2>&1)
        $beforeExitCode = $LASTEXITCODE
        $before | Add-Content -LiteralPath $logFile -Encoding UTF8
        $before | ForEach-Object { Write-Host $_ }
        if ($beforeExitCode -ne 0) { throw "migrate status falló con código $beforeExitCode." }

        $timeoutArg = "--timeout=${TimeoutMinutes}m"
        $up = @(& $GoPath run ./cmd/migrate up --confirm $timeoutArg 2>&1)
        $upExitCode = $LASTEXITCODE
        $up | Add-Content -LiteralPath $logFile -Encoding UTF8
        $up | ForEach-Object { Write-Host $_ }
        if ($upExitCode -ne 0) { throw "migrate up falló con código $upExitCode." }

        Write-Host '[4/4] Verificando que el catálogo completo quedó aplicado...' -ForegroundColor Yellow
        $after = @(& $GoPath run ./cmd/migrate status 2>&1)
        $afterExitCode = $LASTEXITCODE
        $after | Add-Content -LiteralPath $logFile -Encoding UTF8
        $after | ForEach-Object { Write-Host $_ }
        if ($afterExitCode -ne 0) { throw "migrate status final falló con código $afterExitCode." }
        if (($after -join "`n") -match '(?m)^\s*PENDIENTE\s+') {
            throw 'La verificación final todavía reporta migraciones pendientes.'
        }
    } finally {
        Pop-Location
    }

    "CompletedAtUtc: $((Get-Date).ToUniversalTime().ToString('o'))`nResult: OK" | Add-Content -LiteralPath $logFile -Encoding UTF8
    Write-Host 'Migraciones aplicadas y verificadas correctamente.' -ForegroundColor Green
    Write-Host "Respaldo: $backupPath" -ForegroundColor Green
    Write-Host "Log: $logFile" -ForegroundColor Green
} catch {
    if ($logFile -and (Test-Path -LiteralPath $logFile)) {
        "FailedAtUtc: $((Get-Date).ToUniversalTime().ToString('o'))`nResult: ERROR`nMessage: $($_.Exception.Message)" | Add-Content -LiteralPath $logFile -Encoding UTF8
    }
    if ($backupPath) {
        Write-Warning "Migración abortada. El respaldo verificado se conserva en: $backupPath"
    }
    throw
} finally {
    Restore-EnvironmentValue -Name 'DB_HOST' -Value $previousEnvironment.DB_HOST
    Restore-EnvironmentValue -Name 'DB_PORT' -Value $previousEnvironment.DB_PORT
    Restore-EnvironmentValue -Name 'DB_USER' -Value $previousEnvironment.DB_USER
    Restore-EnvironmentValue -Name 'DB_NAME' -Value $previousEnvironment.DB_NAME
    Restore-EnvironmentValue -Name 'DB_PASSWORD' -Value $previousEnvironment.DB_PASSWORD
}
