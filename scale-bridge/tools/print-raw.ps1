# ==============================================================================
# tools/print-raw.ps1 — versión 1.0.0
#
# Helper mínimo para enviar bytes RAW a una cola Windows por nombre, usado
# por `print-transports.js#sendSystemWindows`. Pensado para impresoras
# ESC/POS/TSPL donde el driver fabricante actúa como simple spooler RAW.
#
# Contrato con Node:
#   * Argumento `-PrinterName <string>` obligatorio.
#   * Lee de stdin un BLOQUE DE BASE64 con los bytes crudos.
#   * Exit 0 e imprime `OK:<bytes>` → éxito.
#   * Exit != 0 e imprime en stderr un mensaje con prefijo `CODE:detail` →
#     el llamador lo propaga al frontend como `SYSTEM_PRINT_FAILED`.
#
# Seguridad:
#   * Sin descarga, sin eval, sin interpolación: solo P/Invoke a winspool.drv.
#   * El nombre de cola se valida contra caracteres de control y comillas.
#   * El helper NO instala impresoras ni toca el registro: solo escribe en
#     la cola existente que ya se instaló aparte (driver USB fabricante u
#     "Generic / Text Only" apuntando al IP RAW).
#
# No depender de módulos externos: solo Add-Type con Interop estándar.
# ==============================================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PrinterName,

    [string]$DocumentName = "scale-bridge-raw",

    [int]$MaxBytes = 2097152  # 2 MiB — cota de seguridad frente a payload roto
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

try {
    if ([string]::IsNullOrWhiteSpace($PrinterName)) {
        Write-Error "INVALID_PRINTER_NAME:nombre vacio"
        exit 2
    }
    if ($PrinterName -match '[\x00-\x1F"<>|]') {
        Write-Error "INVALID_PRINTER_NAME:caracteres no permitidos"
        exit 2
    }

    # Leemos TODO stdin de una vez. El llamador cierra stdin tras escribir.
    $base64 = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($base64)) {
        Write-Error "EMPTY_PAYLOAD:stdin vacio"
        exit 3
    }
    $base64 = $base64.Trim()
    try {
        $bytes = [Convert]::FromBase64String($base64)
    } catch {
        Write-Error "DECODE_FAILED:$($_.Exception.Message)"
        exit 3
    }
    if ($bytes.Length -eq 0) {
        Write-Error "EMPTY_PAYLOAD:0 bytes tras decodificar"
        exit 3
    }
    if ($bytes.Length -gt $MaxBytes) {
        Write-Error "PAYLOAD_TOO_LARGE:$($bytes.Length) > $MaxBytes"
        exit 3
    }

    # Carga P/Invoke de winspool.drv solo una vez por invocación.
    if (-not ([System.Management.Automation.PSTypeName]'ScaleBridge.RawPrinterHelper').Type) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace ScaleBridge {
    public static class RawPrinterHelper {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct DOCINFO {
            [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
            [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
            [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
        }
        [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
        [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
        public static extern bool ClosePrinter(IntPtr hPrinter);
        [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, ref DOCINFO di);
        [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
        public static extern bool EndDocPrinter(IntPtr hPrinter);
        [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
        public static extern bool StartPagePrinter(IntPtr hPrinter);
        [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
        public static extern bool EndPagePrinter(IntPtr hPrinter);
        [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
        public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);
    }
}
"@
    }

    $hPrinter = [IntPtr]::Zero
    if (-not [ScaleBridge.RawPrinterHelper]::OpenPrinter($PrinterName, [ref]$hPrinter, [IntPtr]::Zero)) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Error "OPEN_PRINTER_FAILED:win32=$err"
        exit 4
    }

    try {
        $di = New-Object ScaleBridge.RawPrinterHelper+DOCINFO
        $di.pDocName = $DocumentName
        $di.pOutputFile = $null
        $di.pDataType = "RAW"
        if (-not [ScaleBridge.RawPrinterHelper]::StartDocPrinter($hPrinter, 1, [ref]$di)) {
            $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            Write-Error "START_DOC_FAILED:win32=$err"
            exit 5
        }
        try {
            if (-not [ScaleBridge.RawPrinterHelper]::StartPagePrinter($hPrinter)) {
                $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
                Write-Error "START_PAGE_FAILED:win32=$err"
                exit 6
            }
            try {
                $pBytes = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
                try {
                    [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pBytes, $bytes.Length)
                    [int]$written = 0
                    if (-not [ScaleBridge.RawPrinterHelper]::WritePrinter($hPrinter, $pBytes, $bytes.Length, [ref]$written)) {
                        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
                        Write-Error "WRITE_PRINTER_FAILED:win32=$err"
                        exit 7
                    }
                    if ($written -ne $bytes.Length) {
                        Write-Error "SHORT_WRITE:$written/$($bytes.Length)"
                        exit 8
                    }
                } finally {
                    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pBytes) | Out-Null
                }
            } finally {
                [ScaleBridge.RawPrinterHelper]::EndPagePrinter($hPrinter) | Out-Null
            }
        } finally {
            [ScaleBridge.RawPrinterHelper]::EndDocPrinter($hPrinter) | Out-Null
        }
    } finally {
        [ScaleBridge.RawPrinterHelper]::ClosePrinter($hPrinter) | Out-Null
    }

    Write-Output ("OK:" + $bytes.Length)
    exit 0
}
catch {
    Write-Error ("UNEXPECTED:" + $_.Exception.Message)
    exit 1
}
