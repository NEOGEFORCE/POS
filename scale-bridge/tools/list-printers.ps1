# ==============================================================================
# tools/list-printers.ps1 — versión 1.0.0
#
# Helper mínimo para enumerar colas de impresión Windows disponibles. Usado
# por `print-transports.js#listSystemPrintersWindows`.
#
# Contrato con Node:
#   * SIN parámetros variables: `[CmdletBinding()] param()` vacío. Esto
#     elimina cualquier superficie de inyección — el llamador no pasa
#     nada que PowerShell pueda interpretar como código o nombre dinámico.
#   * Imprime en stdout un JSON compacto con la forma:
#         { "platform": "win32",
#           "defaultName": "<cola-por-defecto>",
#           "printers": [ { name, driver, port, status, online, isDefault,
#                           shared, jobs, attributes } ] }
#   * Exit 0 → éxito. Exit != 0 e imprime en stderr `PRINTER_LIST_FAILED:<detalle>`
#     para que el llamador lo propague como errorCode.
#
# Seguridad:
#   * Sin descarga, sin eval, sin interpolación: usa CIM / Get-CimInstance
#     con `-ClassName` literal.
#   * No modifica el sistema: solo lectura de `Win32_Printer` y filtrado
#     en memoria de `Win32_PrintJob` para contar trabajos pendientes.
#   * Timeout del lado del helper no existe: el proceso Node lo mata con
#     SIGKILL si tarda más de `timeoutMs` (default 10 s).
#
# Compatibilidad: PowerShell 5.1+ (Windows 10/11, Server 2016+). No usa
# cmdlets de PowerShell Core-only.
# ==============================================================================

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

try {
    # Lectura única — la consulta WMI puede ser lenta cuando hay drivers
    # defectuosos, pero es idempotente y nunca escribe.
    $printers = Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop

    # Snapshot de trabajos pendientes (opcional). Si WMI falla al enumerar
    # (por ejemplo, servicio Spooler detenido), seguimos adelante con 0.
    $allJobs = @()
    try {
        $allJobs = @(Get-CimInstance -ClassName Win32_PrintJob -ErrorAction Stop)
    } catch {
        $allJobs = @()
    }

    $defaultName = ""
    foreach ($p in $printers) {
        if ($p.Default) { $defaultName = [string]$p.Name; break }
    }

    $out = New-Object System.Collections.ArrayList
    foreach ($p in $printers) {
        # -- Status -----------------------------------------------------
        # WMI PrinterStatus: 1=Other, 2=Unknown, 3=Idle, 4=Printing,
        # 5=Warming Up, 6=Stopped Printing, 7=Offline.
        $status = "unknown"
        switch ($p.PrinterStatus) {
            3 { $status = "online" }
            4 { $status = "online" }
            5 { $status = "online" }
            6 { $status = "offline" }
            7 { $status = "offline" }
        }
        # DetectedErrorState: 3=NoError, 5=NoPaper, 8=DoorOpen, 9=Jammed,
        # 10=ServiceRequired. Prioriza sobre PrinterStatus.
        switch ($p.DetectedErrorState) {
            5  { $status = "paper-out" }
            8  { $status = "error" }
            9  { $status = "error" }
            10 { $status = "error" }
        }
        # Overrides: WorkOffline y PrinterState bit 0x1 = Paused.
        if ($p.WorkOffline) { $status = "offline" }
        if (($p.PrinterState -band 1) -eq 1) { $status = "paused" }

        # -- Attributes bitmap → tags humanos ---------------------------
        # Fuente: MS-WIN32_PRINTER. Mantenemos solo los relevantes para
        # diagnóstico desde el POS.
        $attrs = New-Object System.Collections.ArrayList
        $a = [int]$p.Attributes
        if (($a -band 0x40)   -eq 0x40)   { [void]$attrs.Add("LOCAL") }
        if (($a -band 0x10)   -eq 0x10)   { [void]$attrs.Add("NETWORK") }
        if (($a -band 0x8)    -eq 0x8)    { [void]$attrs.Add("SHARED") }
        if (($a -band 0x200)  -eq 0x200)  { [void]$attrs.Add("RAW_ONLY") }
        if (($a -band 0x4000) -eq 0x4000) { [void]$attrs.Add("DIRECT") }
        if (($a -band 0x400)  -eq 0x400)  { [void]$attrs.Add("DEFAULT") }

        # -- Jobs pendientes (filtro en memoria) ------------------------
        # Nombre canónico de Win32_PrintJob: "<PrinterName>, <JobId>".
        $jobs = 0
        if ($allJobs.Count -gt 0) {
            $printerName = [string]$p.Name
            foreach ($job in $allJobs) {
                if ($job.Name -like ($printerName + ",*")) { $jobs++ }
            }
        }

        [void]$out.Add([PSCustomObject]@{
            name       = [string]$p.Name
            driver     = [string]$p.DriverName
            port       = [string]$p.PortName
            status     = $status
            online     = ($status -eq "online")
            isDefault  = [bool]$p.Default
            shared     = [bool]$p.Shared
            jobs       = $jobs
            attributes = @($attrs)
        })
    }

    $payload = [PSCustomObject]@{
        platform    = "win32"
        defaultName = $defaultName
        printers    = @($out)
    }

    # `ConvertTo-Json -AsArray` no existe en 5.1; forzamos array con `@()`
    # arriba. Depth 4 cubre arrays anidados (`attributes`).
    $payload | ConvertTo-Json -Compress -Depth 4
    exit 0
}
catch {
    Write-Error ("PRINTER_LIST_FAILED:" + $_.Exception.Message)
    exit 1
}
