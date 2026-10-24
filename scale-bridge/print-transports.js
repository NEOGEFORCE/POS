// =============================================================================
// print-transports.js
//
// Capa "sucia" del backend de impresión: TCP (RAW 9100) y spool Windows via
// un helper PowerShell versionado. Es la contraparte de printer-bridge.js:
// nada aquí intenta decidir si un payload es válido, solo se ocupa de
// moverlo al dispositivo.
//
// Diseño:
//   * `sendTcp(host, port, buf, {timeoutMs})` abre un socket, escribe el
//     buffer, le hace FIN y espera cierre. Timeout real por reloj. Nunca
//     reusa sockets (RAW print queues no son multiplexables).
//   * `sendSystemWindows(printerName, buf, {timeoutMs, scriptPath})`
//     ejecuta `tools/print-raw.ps1 -PrinterName "<name>"`, le pasa los
//     bytes en base64 por stdin. El script es un archivo fijo que vive
//     dentro del repo; nunca se construye PowerShell dinámico a partir
//     de input del navegador.
//   * Logs mínimos: solo prefijo "[print-tcp]" / "[print-sys]" + bytes +
//     resultado. Nunca dumpeamos el buffer (puede contener ESC/POS raro).
// =============================================================================

"use strict";

const net = require("node:net");
const { spawn } = require("node:child_process");
const path = require("node:path");

/**
 * Envía `buf` crudo por TCP al puerto RAW (típicamente 9100). Timeout vía
 * `net.Socket#setTimeout` y una guardia por `setTimeout` global para
 * cerrar sockets zombie si el peer no responde al FIN.
 *
 * @param {string} host
 * @param {number} port
 * @param {Buffer} buf
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{host:string, port:number, bytes:number}>}
 */
function sendTcp(host, port, buf, opts) {
    return new Promise((resolve, reject) => {
        const timeoutMs = opts?.timeoutMs ?? 7000;
        if (!host || typeof host !== "string") {
            const err = new Error("TCP_ERROR: host inválido");
            err.code = "TCP_ERROR";
            return reject(err);
        }
        const safePort = Number(port) || 9100;
        if (!Number.isInteger(safePort) || safePort < 1 || safePort > 65535) {
            const err = new Error("TCP_ERROR: puerto fuera de rango");
            err.code = "TCP_ERROR";
            return reject(err);
        }
        if (!Buffer.isBuffer(buf) || buf.length === 0) {
            const err = new Error("TCP_ERROR: payload vacío");
            err.code = "TCP_ERROR";
            return reject(err);
        }

        let settled = false;
        const socket = new net.Socket();
        const settle = (fn, val) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (_) { /* already destroyed */ }
            fn(val);
        };

        const hardTimer = setTimeout(() => {
            const err = new Error(`TCP_TIMEOUT: ${host}:${safePort} no respondió en ${timeoutMs}ms`);
            err.code = "TCP_TIMEOUT";
            settle(reject, err);
        }, timeoutMs);

        socket.setTimeout(timeoutMs);
        socket.once("timeout", () => {
            const err = new Error(`TCP_TIMEOUT: ${host}:${safePort} inactivo ${timeoutMs}ms`);
            err.code = "TCP_TIMEOUT";
            clearTimeout(hardTimer);
            settle(reject, err);
        });
        socket.once("error", (e) => {
            const code = e.code ? `TCP_ERROR:${e.code}` : "TCP_ERROR";
            const err = new Error(`${code}: ${e.message}`);
            err.code = "TCP_ERROR";
            clearTimeout(hardTimer);
            settle(reject, err);
        });
        socket.once("close", () => {
            clearTimeout(hardTimer);
            if (!settled) settle(resolve, { host, port: safePort, bytes: buf.length });
        });

        socket.connect(safePort, host, () => {
            socket.write(buf, (writeErr) => {
                if (writeErr) {
                    const err = new Error(`TCP_ERROR: write ${writeErr.message}`);
                    err.code = "TCP_ERROR";
                    clearTimeout(hardTimer);
                    settle(reject, err);
                    return;
                }
                // FIN para que la impresora sepa que terminó el job.
                socket.end();
            });
        });
    });
}

/**
 * Imprime RAW a una cola Windows por nombre usando un script PowerShell
 * versionado. El script vive en `tools/print-raw.ps1` dentro del repo.
 *
 * NUNCA se interpola `printerName` dentro de un string PowerShell: se pasa
 * como argumento tipado `-PrinterName <name>`; PowerShell lo recibe como
 * `[string]` y lo usa como literal. Los bytes se envían en base64 por
 * stdin para evitar cualquier re-encoding de la terminal.
 *
 * @param {string} printerName
 * @param {Buffer} buf
 * @param {{timeoutMs?: number, scriptPath?: string}} [opts]
 * @returns {Promise<{printerName:string, bytes:number, stdout:string}>}
 */
function sendSystemWindows(printerName, buf, opts) {
    return new Promise((resolve, reject) => {
        const timeoutMs = opts?.timeoutMs ?? 15000;
        const scriptPath = opts?.scriptPath || path.join(__dirname, "tools", "print-raw.ps1");
        if (!printerName || typeof printerName !== "string") {
            const err = new Error("SYSTEM_PRINT_FAILED: printerName vacío");
            err.code = "SYSTEM_PRINT_FAILED";
            return reject(err);
        }
        // Rechazamos nombres con bytes raros antes de llegar a PowerShell —
        // el helper .ps1 también lo rechaza, defensa en profundidad.
        if (/[\x00-\x1F"<>|]/.test(printerName)) {
            const err = new Error("SYSTEM_PRINT_FAILED: nombre de impresora inválido");
            err.code = "SYSTEM_PRINT_FAILED";
            return reject(err);
        }
        if (!Buffer.isBuffer(buf) || buf.length === 0) {
            const err = new Error("SYSTEM_PRINT_FAILED: payload vacío");
            err.code = "SYSTEM_PRINT_FAILED";
            return reject(err);
        }

        // Elegimos powershell.exe clásico por compatibilidad universal con
        // Windows 10/11 LTSC donde pwsh (Core) puede no estar instalado.
        const args = [
            "-NoProfile",
            "-NoLogo",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-File", scriptPath,
            "-PrinterName", printerName,
        ];
        const child = spawn("powershell.exe", args, { stdio: ["pipe", "pipe", "pipe"] });

        let stdout = "";
        let stderr = "";
        let settled = false;

        const killer = setTimeout(() => {
            if (!settled) {
                try { child.kill("SIGKILL"); } catch (_) { /* already dead */ }
                settled = true;
                const err = new Error(`SYSTEM_PRINT_FAILED: timeout ${timeoutMs}ms`);
                err.code = "SYSTEM_PRINT_FAILED";
                reject(err);
            }
        }, timeoutMs);

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });

        child.on("error", (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(killer);
            const err = new Error(`SYSTEM_PRINT_FAILED: ${e.message}`);
            err.code = "SYSTEM_PRINT_FAILED";
            reject(err);
        });

        child.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(killer);
            if (code === 0) {
                resolve({ printerName, bytes: buf.length, stdout: stdout.trim() });
            } else {
                const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
                const err = new Error(`SYSTEM_PRINT_FAILED: ${detail}`);
                err.code = "SYSTEM_PRINT_FAILED";
                reject(err);
            }
        });

        // Base64 para evitar problemas de encoding de la terminal (Windows
        // usa UTF-16 por defecto en stdin de pwsh, y los bytes ESC/POS no
        // son texto). PowerShell decodifica adentro.
        try {
            child.stdin.end(buf.toString("base64"));
        } catch (e) {
            if (settled) return;
            settled = true;
            clearTimeout(killer);
            try { child.kill("SIGKILL"); } catch (_) { /* already dead */ }
            const err = new Error(`SYSTEM_PRINT_FAILED: no se pudo escribir a stdin (${e.message})`);
            err.code = "SYSTEM_PRINT_FAILED";
            reject(err);
        }
    });
}

/**
 * Enumera las colas de impresión Windows disponibles. Es la contraparte
 * de `sendSystemWindows`: usa el mismo mecanismo (spawn + PowerShell
 * `-File` + script versionado) pero el script `list-printers.ps1` tiene
 * `param()` vacío → no se pasan argumentos variables ni interpolaciones.
 *
 * Diseño:
 *   - Argumentos de PowerShell CONSTANTES (no vienen del navegador).
 *   - El script escribe un JSON compacto en stdout:
 *       { platform, defaultName, printers: [{name, driver, port, ...}] }
 *   - Timeout del lado Node (SIGKILL al cumplirse `timeoutMs`).
 *   - En error (exit != 0, JSON inválido, timeout) rechaza con `Error`
 *     cuyo `.code === "PRINTER_LIST_FAILED"` para que `printer-bridge.js`
 *     lo propague tal cual al frontend.
 *
 * @param {{timeoutMs?: number, scriptPath?: string, refresh?: boolean}} [opts]
 *        `refresh` se acepta por interfaz pero el helper actual no cachea;
 *        se preserva para evolución futura sin romper el contrato WS.
 * @returns {Promise<{platform:string, defaultName:string, printers:Array}>}
 */
function listSystemPrintersWindows(opts) {
    return new Promise((resolve, reject) => {
        const timeoutMs = opts?.timeoutMs ?? 10000;
        const scriptPath = opts?.scriptPath || path.join(__dirname, "tools", "list-printers.ps1");

        // Argumentos FIJOS. No incluimos nada que venga del navegador.
        const args = [
            "-NoProfile",
            "-NoLogo",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-File", scriptPath,
        ];
        const child = spawn("powershell.exe", args, { stdio: ["ignore", "pipe", "pipe"] });

        let stdout = "";
        let stderr = "";
        let settled = false;

        const killer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill("SIGKILL"); } catch (_) { /* already dead */ }
            const err = new Error(`PRINTER_LIST_FAILED: timeout ${timeoutMs}ms`);
            err.code = "PRINTER_LIST_FAILED";
            reject(err);
        }, timeoutMs);

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });

        child.on("error", (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(killer);
            const err = new Error(`PRINTER_LIST_FAILED: ${e.message}`);
            err.code = "PRINTER_LIST_FAILED";
            reject(err);
        });

        child.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(killer);
            if (code !== 0) {
                const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
                const err = new Error(`PRINTER_LIST_FAILED: ${detail}`);
                err.code = "PRINTER_LIST_FAILED";
                reject(err);
                return;
            }
            const text = stdout.trim();
            if (text.length === 0) {
                // El script siempre debe emitir JSON; stdout vacío es un bug.
                resolve({ platform: "win32", defaultName: "", printers: [] });
                return;
            }
            try {
                const parsed = JSON.parse(text);
                resolve(parsed);
            } catch (e) {
                const err = new Error(`PRINTER_LIST_FAILED: JSON inválido (${e.message})`);
                err.code = "PRINTER_LIST_FAILED";
                reject(err);
            }
        });
    });
}

module.exports = { sendTcp, sendSystemWindows, listSystemPrintersWindows };
