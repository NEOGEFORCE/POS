[CmdletBinding()]
param(
    [switch]$ConfirmInstall,
    [string]$InstallDirectory = "C:\Users\surti\Desktop\POS",
    [string]$ServiceName = "POS_Server"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if (-not $ConfirmInstall) { throw "Instalacion cancelada. Use -ConfirmInstall en el equipo de produccion." }

$nssm = Join-Path $InstallDirectory "nssm.exe"
$server = Join-Path $InstallDirectory "server.exe"
$logs = Join-Path $InstallDirectory "logs"
if (-not (Test-Path $nssm)) { throw "No se encontro $nssm" }
if (-not (Test-Path $server)) { throw "No se encontro $server" }
New-Item -ItemType Directory -Path $logs -Force | Out-Null

& $nssm status $ServiceName *> $null
if ($LASTEXITCODE -ne 0) {
    & $nssm install $ServiceName $server
    if ($LASTEXITCODE -ne 0) { throw "No se pudo instalar $ServiceName" }
}

$settings = @(
    @("Application", $server),
    @("AppDirectory", $InstallDirectory),
    @("AppStdout", (Join-Path $logs "server-out.log")),
    @("AppStderr", (Join-Path $logs "server-err.log")),
    @("AppRotateFiles", "1"),
    @("AppRotateOnline", "1"),
    @("AppRotateBytes", "10485760"),
    @("AppExit", "Default", "Restart"),
    @("AppRestartDelay", "5000"),
    @("Start", "SERVICE_AUTO_START")
)
foreach ($setting in $settings) {
    & $nssm set $ServiceName @setting
    if ($LASTEXITCODE -ne 0) { throw "NSSM set fallo: $($setting -join ' ')" }
}

& $nssm status $ServiceName
if ($LASTEXITCODE -ne 0) { throw "No se pudo consultar el estado de $ServiceName" }
Write-Host "$ServiceName configurado. Revise logs y ejecute una prueba controlada de reinicio." -ForegroundColor Green
