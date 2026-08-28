[CmdletBinding()]
param(
    [switch]$ConfirmBackup,
    [string]$DestinationRoot = $(if ($env:POS_DB_BACKUP_ROOT) { $env:POS_DB_BACKUP_ROOT } else { Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'POS-Backups\Database' }),
    [string]$PgDumpPath = $env:POS_PG_DUMP,
    [string]$PgRestorePath = $env:POS_PG_RESTORE,
    [string]$DbHost = $env:DB_HOST,
    [ValidateRange(1, 65535)]
    [int]$DbPort = $(if ($env:DB_PORT) { [int]$env:DB_PORT } else { 5432 }),
    [string]$DbUser = $env:DB_USER,
    [string]$DbName = $env:DB_NAME,
    [ValidateRange(1, 365)]
    [int]$Keep = 14
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-PostgresTool {
    param(
        [string]$ConfiguredPath,
        [string]$CommandName,
        [string]$SiblingDirectory
    )

    if (-not [string]::IsNullOrWhiteSpace($ConfiguredPath)) {
        if (-not (Test-Path -LiteralPath $ConfiguredPath -PathType Leaf)) {
            throw "$CommandName no existe en la ruta configurada: $ConfiguredPath"
        }
        return (Resolve-Path -LiteralPath $ConfiguredPath).Path
    }

    if (-not [string]::IsNullOrWhiteSpace($SiblingDirectory)) {
        $candidate = Join-Path $SiblingDirectory "$CommandName.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw "$CommandName no fue encontrado. Configure POS_PG_DUMP/POS_PG_RESTORE o agregue PostgreSQL bin al PATH."
}

if (-not $ConfirmBackup) {
    throw 'Respaldo cancelado: vuelva a ejecutar con -ConfirmBackup después de revisar el destino mostrado.'
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

$PgDumpPath = Resolve-PostgresTool -ConfiguredPath $PgDumpPath -CommandName 'pg_dump' -SiblingDirectory $null
$PgRestorePath = Resolve-PostgresTool -ConfiguredPath $PgRestorePath -CommandName 'pg_restore' -SiblingDirectory (Split-Path -Parent $PgDumpPath)

$timestamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
$safeDbName = $DbName -replace '[^a-zA-Z0-9_.-]', '_'
$destination = Join-Path $DestinationRoot "$safeDbName-$timestamp"
$partialDump = Join-Path $destination "$safeDbName-$timestamp.dump.partial"
$dumpFile = Join-Path $destination "$safeDbName-$timestamp.dump"
$restoreListFile = Join-Path $destination 'restore-list.txt'
$manifestFile = Join-Path $destination 'manifest.json'

Write-Host "Destino PostgreSQL: ${DbHost}:${DbPort}/${DbName} (usuario $DbUser)" -ForegroundColor Cyan
Write-Host "Carpeta de respaldo: $destination" -ForegroundColor Cyan

New-Item -ItemType Directory -Path $destination -Force | Out-Null
$previousPgPassword = $env:PGPASSWORD

try {
    $env:PGPASSWORD = $env:POS_DB_PASSWORD
    Write-Host '[1/3] Generando dump PostgreSQL en formato custom...' -ForegroundColor Yellow
    & $PgDumpPath --host=$DbHost --port=$DbPort --username=$DbUser --dbname=$DbName --format=custom --compress=6 --no-owner --no-privileges --file=$partialDump
    if ($LASTEXITCODE -ne 0) { throw "pg_dump terminó con código $LASTEXITCODE" }

    if (-not (Test-Path -LiteralPath $partialDump -PathType Leaf)) { throw 'pg_dump no creó el archivo esperado.' }
    $dumpInfo = Get-Item -LiteralPath $partialDump
    if ($dumpInfo.Length -le 0) { throw 'El dump generado está vacío.' }

    Write-Host '[2/3] Verificando que pg_restore pueda leer el catálogo...' -ForegroundColor Yellow
    $restoreList = @(& $PgRestorePath --list $partialDump 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "pg_restore --list terminó con código $LASTEXITCODE" }
    if ($restoreList.Count -eq 0) { throw 'pg_restore no devolvió el catálogo del respaldo.' }
    $restoreList | Set-Content -LiteralPath $restoreListFile -Encoding UTF8

    Move-Item -LiteralPath $partialDump -Destination $dumpFile -Force
    $dumpInfo = Get-Item -LiteralPath $dumpFile
    $dumpHash = (Get-FileHash -LiteralPath $dumpFile -Algorithm SHA256).Hash
    $pgDumpVersion = (& $PgDumpPath --version | Out-String).Trim()

    Write-Host '[3/3] Generando manifest y aplicando retención...' -ForegroundColor Yellow
    $manifest = [ordered]@{
        createdAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        database = [ordered]@{
            host = $DbHost
            port = $DbPort
            name = $DbName
            user = $DbUser
        }
        dump = [ordered]@{
            file = $dumpInfo.Name
            format = 'PostgreSQL custom'
            bytes = $dumpInfo.Length
            sha256 = $dumpHash
            restoreCatalog = (Split-Path -Leaf $restoreListFile)
        }
        pgDumpVersion = $pgDumpVersion
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestFile -Encoding UTF8

    $backups = @(Get-ChildItem -LiteralPath $DestinationRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$safeDbName-*" } |
        Sort-Object Name -Descending)
    if ($backups.Count -gt $Keep) {
        $backups | Select-Object -Skip $Keep | ForEach-Object {
            try {
                Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
            } catch {
                Write-Warning "No se pudo eliminar el respaldo antiguo '$($_.FullName)': $($_.Exception.Message)"
            }
        }
    }

    Write-Host "Respaldo verificado: $dumpFile" -ForegroundColor Green
    Write-Host "SHA-256: $dumpHash" -ForegroundColor Green
    Write-Output $destination
} catch {
    Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
    throw
} finally {
    if ($null -eq $previousPgPassword) {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    } else {
        $env:PGPASSWORD = $previousPgPassword
    }
}
