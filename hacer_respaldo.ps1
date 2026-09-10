[CmdletBinding()]
param(
    [string]$ProductionShare = "\\DESKTOP-VK2U90S\Users\surti\Desktop\POS",
    [string]$DestinationRoot = $(if ($env:POS_BACKUP_ROOT) { $env:POS_BACKUP_ROOT } else { "C:\Users\jaide\OneDrive\Desktop\Respaldo" }),
    [string]$PgDumpPath = $(if ($env:POS_PG_DUMP) { $env:POS_PG_DUMP } else { "S:\Program Files\PostgreSQL\18\bin\pg_dump.exe" }),
    [string]$DbHost = $(if ($env:DB_HOST) { $env:DB_HOST } else { "192.168.1.6" }),
    [string]$DbUser = $(if ($env:DB_USER) { $env:DB_USER } else { "postgres" }),
    [string]$DbName = $(if ($env:DB_NAME) { $env:DB_NAME } else { "sistemapos" }),
    # Host que se espera para un respaldo de PRODUCCION.
    [string]$ExpectedDbHost = "192.168.1.6",
    # PC donde corre PostgreSQL de produccion. Si su puerto no es alcanzable
    # desde aqui (firewall), el dump se ejecuta ALLA y se trae el archivo.
    [string]$RemoteComputer = "DESKTOP-VK2U90S",
    [string]$RemotePgBin = "C:\Program Files\PostgreSQL\18\bin",
    # Escape deliberado para respaldar otra base (por ejemplo la de desarrollo).
    # Sin este switch el script se niega y explica por que.
    [switch]$AllowUnexpectedDatabase,
    [int]$Keep = 10
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$destination = Join-Path $DestinationRoot $timestamp
$dbPassword = $env:POS_DB_PASSWORD
$DbPortEfectivo = $(if ($env:DB_PORT) { [int]$env:DB_PORT } else { 5432 })
$dumpRemoto = $false

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

# ---------------------------------------------------------------------------
# GUARDA DE DESTINO
#
# El default de DbHost es el host de produccion, pero una variable de entorno
# DB_HOST lo sobreescribe. Eso ya paso: con DB_HOST=localhost en la sesion este
# script respaldo la base de DESARROLLO de la maquina del programador y reporto
# "Respaldo verificado" igual. El respaldo existia, pesaba, tenia manifest y
# checksum, y no contenia los datos de la tienda.
#
# Un respaldo que miente es peor que no tener respaldo, porque se confia en el
# justo antes de una migracion. De ahi estas dos verificaciones.
# ---------------------------------------------------------------------------
$hostsLocales = @('localhost', '127.0.0.1', '::1', '.', $env:COMPUTERNAME)
if ($DbHost -ne $ExpectedDbHost) {
    $motivo = "El host de base de datos resuelto es [$DbHost] y se esperaba [$ExpectedDbHost]."
    if ($hostsLocales -contains $DbHost) {
        $motivo += " Ese host apunta a ESTA maquina, no al PC de la tienda."
    }
    if (-not $AllowUnexpectedDatabase) {
        throw ($motivo + " Revise la variable de entorno DB_HOST (valor actual: [" + $env:DB_HOST + "]). " +
               "Para respaldar esta base a proposito use -AllowUnexpectedDatabase; " +
               "para respaldar produccion pase -DbHost " + $ExpectedDbHost + " o limpie DB_HOST.")
    }
    Write-Warning ($motivo + " Continuando por -AllowUnexpectedDatabase.")
}

# El puerto de produccion suele estar cerrado por firewall desde la red. Si no
# es alcanzable, tanto la verificacion como el dump se hacen EN el PC de la
# tienda por WinRM, de modo que nunca se mire una base distinta de la que se
# respalda.
if ($DbHost -eq $ExpectedDbHost) {
    $puertoLocal = Test-NetConnection -ComputerName $DbHost -Port $DbPortEfectivo -InformationLevel Quiet -WarningAction SilentlyContinue
    if (-not $puertoLocal) {
        Write-Host "El puerto $DbPortEfectivo de $DbHost no es alcanzable desde aqui; el dump se hara en $RemoteComputer." -ForegroundColor Yellow
        $dumpRemoto = $true
    }
}

$sondeoSql = "SELECT (SELECT count(*) FROM schema_migrations) || '/' || (SELECT count(*) FROM sales);"
$sondeoTexto = ''
if ($dumpRemoto) {
    $sondeoTexto = Invoke-Command -ComputerName $RemoteComputer -ArgumentList $RemotePgBin, $DbUser, $DbName, $dbPassword, $sondeoSql -ScriptBlock {
        param($bin, $usr, $db, $pass, $sql)
        $psql = Join-Path $bin 'psql.exe'
        if (-not (Test-Path $psql)) { return 'ERROR:psql no existe en ' + $bin }
        $env:PGPASSWORD = $pass
        try {
            $r = & $psql -h localhost -U $usr -d $db -t -A -c $sql 2>&1
            if ($LASTEXITCODE -ne 0) { return 'ERROR:' + $r }
            return ([string]$r).Trim()
        } finally { $env:PGPASSWORD = '' }
    }
} else {
    $psqlPath = Join-Path (Split-Path -Parent $PgDumpPath) 'psql.exe'
    if (Test-Path $psqlPath) {
        $previo = $env:PGPASSWORD
        try {
            $env:PGPASSWORD = $dbPassword
            $r = & $psqlPath -h $DbHost -U $DbUser -d $DbName -t -A -c $sondeoSql 2>&1
            if ($LASTEXITCODE -ne 0) { $sondeoTexto = 'ERROR:' + $r } else { $sondeoTexto = ([string]$r).Trim() }
        } finally { $env:PGPASSWORD = $previo }
    } else {
        Write-Warning "psql no esta junto a pg_dump: se omite la verificacion de que la base sea la de produccion."
    }
}

if ($sondeoTexto -like 'ERROR:*') { throw ("No se pudo verificar la base " + $DbHost + "/" + $DbName + ": " + $sondeoTexto.Substring(6)) }
if (-not [string]::IsNullOrWhiteSpace($sondeoTexto)) {
    $partes = ($sondeoTexto -split '/')
    $migraciones = 0
    $ventas = 0
    if ($partes.Count -eq 2) {
        [void][int]::TryParse($partes[0], [ref]$migraciones)
        [void][int]::TryParse($partes[1], [ref]$ventas)
    }
    Write-Host ("Destino: " + $DbHost + "/" + $DbName + " -> " + $migraciones + " migraciones aplicadas, " + $ventas + " ventas") -ForegroundColor Cyan
    if (($migraciones -eq 0 -or $ventas -eq 0) -and -not $AllowUnexpectedDatabase) {
        throw ("La base " + $DbHost + "/" + $DbName + " tiene " + $migraciones + " migraciones y " + $ventas + " ventas: no parece la de la tienda. Si es correcto, repita con -AllowUnexpectedDatabase.")
    }
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
    if ($dumpRemoto) {
        # pg_dump corre EN el PC de la tienda y el archivo se trae por el share
        # administrativo. Sin esto, desde esta maquina el dump de produccion es
        # imposible: el 5432 esta cerrado por firewall.
        $rutaRemota = Invoke-Command -ComputerName $RemoteComputer -ArgumentList $RemotePgBin, $DbUser, $DbName, $dbPassword, $timestamp -ScriptBlock {
            param($bin, $usr, $db, $pass, $ts)
            $pgdump = Join-Path $bin 'pg_dump.exe'
            if (-not (Test-Path $pgdump)) { throw ('pg_dump no existe en ' + $bin) }
            $dir = Join-Path $env:TEMP 'pos-backup'
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            $archivo = Join-Path $dir ('base_de_datos_' + $ts + '.sql')
            $env:PGPASSWORD = $pass
            try {
                & $pgdump -h localhost -U $usr -d $db -F plain -f $archivo 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) { throw ('pg_dump remoto termino con codigo ' + $LASTEXITCODE) }
            } finally { $env:PGPASSWORD = '' }
            if (-not (Test-Path $archivo) -or (Get-Item $archivo).Length -le 0) { throw 'El dump remoto no existe o esta vacio' }
            return $archivo
        }
        # Ruta local del remoto (C:\...) a UNC administrativa (\\PC\C$\...).
        # Se arma con -f para no dejar un backslash pegado a la comilla de cierre.
        $rutaDollar = $rutaRemota -replace '^([A-Za-z]):', '$1$'
        $origenUnc = '\\{0}\{1}' -f $RemoteComputer, $rutaDollar
        Copy-Item -LiteralPath $origenUnc -Destination $dumpFile -Force
        Invoke-Command -ComputerName $RemoteComputer -ArgumentList $rutaRemota -ScriptBlock {
            param($f)
            Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
        }
    } else {
        $previousPassword = $env:PGPASSWORD
        try {
            $env:PGPASSWORD = $dbPassword
            & $PgDumpPath -h $DbHost -U $DbUser -d $DbName -F plain -f $dumpFile
            if ($LASTEXITCODE -ne 0) { throw "pg_dump termino con codigo $LASTEXITCODE" }
        } finally {
            $env:PGPASSWORD = $previousPassword
        }
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
