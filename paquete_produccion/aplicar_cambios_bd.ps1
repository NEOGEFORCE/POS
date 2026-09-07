[CmdletBinding()]
param(
    [switch]$ConfirmApply,
    [switch]$BackupOnly,
    [switch]$StatusOnly,
    [switch]$AllowLegacyMigrations,
    [string]$PosFolder = 'C:\Users\surti\Desktop\POS',
    [string]$ServiceName = 'POS_Server',
    [string]$BackupRoot = 'C:\Users\surti\Desktop\Respaldo_BD',
    [ValidateRange(1, 240)]
    [int]$TimeoutMinutes = 30,
    [ValidateRange(1, 365)]
    [int]$Keep = 14
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }

# Los ejecutables nativos escriben avisos en stderr. Con ErrorActionPreference=Stop
# eso aborta el script, asi que se captura de forma controlada y se decide por el
# codigo de salida real.
function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments = @())
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = & $FilePath @Arguments 2>&1
        $code = $LASTEXITCODE
        $lines = @($raw | ForEach-Object { [string]$_ })
        return [pscustomobject]@{ Output = $lines; ExitCode = $code }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Get-EnvValue {
    param([string[]]$Lines, [string]$Key)
    $line = $Lines | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
    if (-not $line) { return '' }
    $value = ($line -replace "^\s*$Key\s*=", '').Trim()
    return $value.Trim('"').Trim("'")
}

function Resolve-Tool {
    param([string]$CommandName)
    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $roots = @('C:\Program Files\PostgreSQL', 'S:\Program Files\PostgreSQL', 'D:\Program Files\PostgreSQL')
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $found = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "bin\$CommandName.exe" } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
        if ($found) { return $found }
    }
    throw "$CommandName no fue encontrado. Instale las herramientas de PostgreSQL o agreguelas al PATH."
}

function Get-PendingMigrations {
    param([string[]]$StatusOutput)
    # OJO: nada de "return ,$pending". Ese prefijo de coma envuelve el arreglo
    # para evitar que PowerShell lo desenrolle, pero rompe el caso VACIO: con
    # cero pendientes el llamador recibia un arreglo de 1 elemento (el arreglo
    # vacio adentro), asi que .Count daba 1 y el script concluia "todavia hay
    # migraciones pendientes" aunque estuvieran todas aplicadas. Se devuelve
    # el conteo, que no tiene ambiguedad posible.
    $pending = @($StatusOutput | Where-Object { $_ -match '^\s*PENDIENTE\s+' } | ForEach-Object { $_.Trim() })
    return [pscustomobject]@{ Count = $pending.Count; Lines = $pending }
}

if (-not $ConfirmApply -and -not $BackupOnly -and -not $StatusOnly) {
    Write-Host ''
    Write-Host 'Opciones disponibles:' -ForegroundColor Yellow
    Write-Host '  -StatusOnly     Solo muestra que migraciones faltan. No cambia nada.' -ForegroundColor Yellow
    Write-Host '  -BackupOnly     Solo respaldo verificado. No migra.' -ForegroundColor Yellow
    Write-Host '  -ConfirmApply   Respaldo + aplica migraciones (requiere POS detenido).' -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

$migrateExe = Join-Path $PSScriptRoot 'migrate.exe'
if (-not (Test-Path -LiteralPath $migrateExe)) { throw "No se encontro migrate.exe junto a este script: $migrateExe" }
if (-not (Test-Path -LiteralPath $PosFolder)) { throw "No se encontro la carpeta del POS: $PosFolder" }

$envFile = Join-Path $PosFolder '.env'
if (-not (Test-Path -LiteralPath $envFile)) { throw "No se encontro el archivo .env en: $PosFolder" }

$service = Get-Service $ServiceName -ErrorAction SilentlyContinue
if (-not $BackupOnly -and -not $StatusOnly -and $service -and $service.Status -ne 'Stopped') {
    throw "El servicio $ServiceName esta en estado $($service.Status). Detengalo antes de migrar."
}

$envLines = Get-Content -LiteralPath $envFile
$dbHost = Get-EnvValue -Lines $envLines -Key 'DB_HOST'
$dbPort = Get-EnvValue -Lines $envLines -Key 'DB_PORT'
$dbUser = Get-EnvValue -Lines $envLines -Key 'DB_USER'
$dbName = Get-EnvValue -Lines $envLines -Key 'DB_NAME'
$dbPassword = Get-EnvValue -Lines $envLines -Key 'DB_PASSWORD'
if ([string]::IsNullOrWhiteSpace($dbPort)) { $dbPort = '5432' }

foreach ($pair in @(@('DB_HOST', $dbHost), @('DB_USER', $dbUser), @('DB_NAME', $dbName), @('DB_PASSWORD', $dbPassword))) {
    if ([string]::IsNullOrWhiteSpace($pair[1])) { throw "Falta $($pair[0]) en el archivo .env de produccion." }
}

Write-Host ''
Write-Host "Base de datos : ${dbHost}:${dbPort}/${dbName} (usuario $dbUser)" -ForegroundColor Cyan
Write-Host "Servicio      : $ServiceName ($(if($service){$service.Status}else{'no instalado'}))" -ForegroundColor Cyan

if ($StatusOnly) {
    Write-Host 'Modo consulta : no se modifica nada' -ForegroundColor Cyan
    Write-Host ''
    Push-Location $PosFolder
    try {
        $status = Invoke-Native -FilePath $migrateExe -Arguments @('status')
        $status.Output | ForEach-Object { Write-Host "    $_" }
        if ($status.ExitCode -ne 0) { throw "migrate status fallo con codigo $($status.ExitCode)" }
        $pending = Get-PendingMigrations -StatusOutput $status.Output
        Write-Host ''
        if ($pending.Count -eq 0) {
            Write-Host 'No hay migraciones pendientes.' -ForegroundColor Green
        } else {
            Write-Host ("Pendientes: " + $pending.Count) -ForegroundColor Yellow
        }
    } finally {
        Pop-Location
    }
    exit 0
}

$pgDump = Resolve-Tool -CommandName 'pg_dump'
$pgRestore = Resolve-Tool -CommandName 'pg_restore'

$timestamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
$safeName = $dbName -replace '[^a-zA-Z0-9_.-]', '_'
$destination = Join-Path $BackupRoot "$safeName-$timestamp"
$partial = Join-Path $destination "$safeName-$timestamp.dump.partial"
$dumpFile = Join-Path $destination "$safeName-$timestamp.dump"
$logFile = Join-Path $destination 'migracion.log'

Write-Host "Respaldo en   : $destination" -ForegroundColor Cyan
Write-Host ''

New-Item -ItemType Directory -Path $destination -Force | Out-Null
$previousPassword = $env:PGPASSWORD

try {
    $env:PGPASSWORD = $dbPassword

    Write-Step '1/5 Generando respaldo de la base de datos'
    $dump = Invoke-Native -FilePath $pgDump -Arguments @(
        "--host=$dbHost", "--port=$dbPort", "--username=$dbUser", "--dbname=$dbName",
        '--format=custom', '--compress=6', '--no-owner', '--no-privileges', "--file=$partial"
    )
    if ($dump.ExitCode -ne 0) {
        $dump.Output | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
        throw "pg_dump termino con codigo $($dump.ExitCode)"
    }
    if (-not (Test-Path -LiteralPath $partial) -or (Get-Item -LiteralPath $partial).Length -le 0) {
        throw 'El respaldo quedo vacio.'
    }

    Write-Step '2/5 Verificando que el respaldo se puede leer'
    $catalog = Invoke-Native -FilePath $pgRestore -Arguments @('--list', $partial)
    if ($catalog.ExitCode -ne 0) {
        $catalog.Output | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
        throw "pg_restore --list termino con codigo $($catalog.ExitCode)"
    }
    if ($catalog.Output.Count -eq 0) { throw 'El respaldo no devolvio catalogo.' }
    $catalog.Output | Set-Content -LiteralPath (Join-Path $destination 'restore-list.txt') -Encoding UTF8

    Move-Item -LiteralPath $partial -Destination $dumpFile -Force
    $dumpInfo = Get-Item -LiteralPath $dumpFile
    $dumpHash = (Get-FileHash -LiteralPath $dumpFile -Algorithm SHA256).Hash

    [ordered]@{
        createdAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        database     = "${dbHost}:${dbPort}/${dbName}"
        user         = $dbUser
        dumpFile     = $dumpInfo.Name
        bytes        = $dumpInfo.Length
        sha256       = $dumpHash
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $destination 'manifest.json') -Encoding UTF8

    Write-Host ("    Respaldo OK: {0} MB" -f [math]::Round($dumpInfo.Length / 1MB, 2)) -ForegroundColor Green

    "Destino: ${dbHost}:${dbPort}/${dbName}" | Set-Content -LiteralPath $logFile -Encoding UTF8
    "Respaldo: $($dumpInfo.Name) ($dumpHash)" | Add-Content -LiteralPath $logFile -Encoding UTF8

    if ($BackupOnly) {
        'Resultado: SOLO RESPALDO' | Add-Content -LiteralPath $logFile -Encoding UTF8
        Write-Host ''
        Write-Host 'LISTO. Respaldo creado y verificado. No se aplico ninguna migracion.' -ForegroundColor Green
        Write-Host "Carpeta: $destination" -ForegroundColor Green
        Write-Host "SHA-256: $dumpHash" -ForegroundColor Green
        return
    }

    Push-Location $PosFolder
    try {
        Write-Step '3/5 Estado actual de las migraciones'
        $before = Invoke-Native -FilePath $migrateExe -Arguments @('status')
        $before.Output | Add-Content -LiteralPath $logFile -Encoding UTF8
        $before.Output | ForEach-Object { Write-Host "    $_" }
        if ($before.ExitCode -ne 0) { throw "migrate status fallo con codigo $($before.ExitCode)" }

        $pending = Get-PendingMigrations -StatusOutput $before.Output
        if ($pending.Count -eq 0) {
            Write-Host '    No hay migraciones pendientes. Solo se hizo el respaldo.' -ForegroundColor Green
            'Resultado: SIN PENDIENTES' | Add-Content -LiteralPath $logFile -Encoding UTF8
            return
        }

        # Detecta migraciones antiguas (001-009) pendientes, que son las que
        # normalizan datos historicos.
        #
        # Se usa [regex]::Match en lugar de el operador -match con $Matches:
        # con Set-StrictMode -Version Latest, leer $Matches[1] dentro de la
        # misma expresion -and revienta con "La variable '$Matches' no se
        # puede recuperar porque no se ha establecido", y el script abortaba
        # despues del respaldo sin aplicar nada. Con [regex]::Match el grupo
        # se lee del objeto devuelto y no depende de ninguna variable global.
        $legacy = @()
        foreach ($line in $pending.Lines) {
            $m = [regex]::Match($line, '^\s*PENDIENTE\s+(\d{3})_')
            if (-not $m.Success) { continue }
            if ([int]$m.Groups[1].Value -le 9) {
                $legacy += $line
            }
        }
        if ($legacy.Count -gt 0 -and -not $AllowLegacyMigrations) {
            Write-Host ''
            Write-Host 'ABORTADO POR SEGURIDAD.' -ForegroundColor Red
            Write-Host 'Hay migraciones antiguas pendientes que normalizan datos historicos' -ForegroundColor Yellow
            Write-Host '(cierres, egresos o costos de venta):' -ForegroundColor Yellow
            $legacy | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
            Write-Host ''
            Write-Host 'El respaldo ya quedo hecho. Revise antes de continuar.' -ForegroundColor Yellow
            ('Resultado: ABORTADO - legacy pendientes: ' + ($legacy -join '; ')) | Add-Content -LiteralPath $logFile -Encoding UTF8
            return
        }

        Write-Step '4/5 Aplicando TODAS las migraciones pendientes'
        $up = Invoke-Native -FilePath $migrateExe -Arguments @('up', '--confirm', "--timeout=${TimeoutMinutes}m")
        $up.Output | Add-Content -LiteralPath $logFile -Encoding UTF8
        $up.Output | ForEach-Object { Write-Host "    $_" }
        if ($up.ExitCode -ne 0) { throw "migrate up fallo con codigo $($up.ExitCode)" }

        Write-Step '5/5 Verificando que no quedan pendientes'
        $after = Invoke-Native -FilePath $migrateExe -Arguments @('status')
        $after.Output | Add-Content -LiteralPath $logFile -Encoding UTF8
        $after.Output | ForEach-Object { Write-Host "    $_" }
        if ($after.ExitCode -ne 0) { throw "migrate status final fallo con codigo $($after.ExitCode)" }
        if ((Get-PendingMigrations -StatusOutput $after.Output).Count -gt 0) {
            throw 'Todavia hay migraciones pendientes.'
        }
    } finally {
        Pop-Location
    }

    $backups = @(Get-ChildItem -LiteralPath $BackupRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$safeName-*" } |
        Sort-Object Name -Descending)
    if ($backups.Count -gt $Keep) {
        $backups | Select-Object -Skip $Keep | ForEach-Object {
            try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop }
            catch { Write-Warning "No se pudo borrar respaldo antiguo: $($_.FullName)" }
        }
    }

    'Resultado: OK' | Add-Content -LiteralPath $logFile -Encoding UTF8
    Write-Host ''
    Write-Host 'LISTO. Base respaldada y migraciones aplicadas.' -ForegroundColor Green
    Write-Host "Respaldo: $destination" -ForegroundColor Green
    Write-Host 'Avise para continuar con el despliegue. NO inicie el servicio todavia.' -ForegroundColor Yellow
} catch {
    if (Test-Path -LiteralPath $logFile) {
        ("Resultado: ERROR - " + $_.Exception.Message) | Add-Content -LiteralPath $logFile -Encoding UTF8
    }
    Write-Host ''
    Write-Host 'FALLO. No se completo la operacion.' -ForegroundColor Red
    Write-Host "Revise: $destination" -ForegroundColor Yellow
    throw
} finally {
    if ([string]::IsNullOrEmpty($previousPassword)) {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $null, 'Process')
    } else {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $previousPassword, 'Process')
    }
}
