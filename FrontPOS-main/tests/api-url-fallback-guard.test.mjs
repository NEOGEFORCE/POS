// tests/api-url-fallback-guard.test.mjs
//
// Guarda estática para la dockerización del frontend. Garantiza que ningún
// archivo bajo src/ construya URLs del backend con fallbacks tontos que
// rompan la operación detrás de nginx:
//
//   - "http://localhost:8080" / "http://localhost:3000" como default: en
//     producción el frontend se sirve desde nginx y debe caer a "/api"
//     relativo. Un fallback hardcoded a un host revela que el autor olvidó
//     el caso contenedor.
//   - `${process.env.NEXT_PUBLIC_API_URL}/...` sin fallback: si la var no
//     está definida en build time, resulta en `undefined/...` y el fetch
//     falla con 404 en runtime.
//
// La excepción legítima es `src/lib/constants.ts`, cuyo helper usa
// `window.location.hostname:3000` SÓLO cuando `window.location.port === '9002'`
// (el dev server de Next). Ese fallback no corre en Docker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));

function listFiles(root) {
    const out = [];
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (/\.(ts|tsx|mjs|js|jsx)$/.test(entry.name)) {
                out.push(full);
            }
        }
    }
    return out;
}

test("ningún archivo bajo src/ hardcodea http://localhost:8080 como fallback", () => {
    const files = listFiles(SRC_ROOT);
    const offenders = [];
    for (const file of files) {
        const txt = readFileSync(file, "utf8");
        if (txt.includes("http://localhost:8080")) {
            offenders.push(file);
        }
    }
    assert.deepEqual(
        offenders,
        [],
        `Archivos con fallback a localhost:8080 (prohibido en producción Docker):\n${offenders.join("\n")}`
    );
});

test("ningún uso de NEXT_PUBLIC_API_URL carece de fallback a /api", () => {
    const files = listFiles(SRC_ROOT);
    const BAD_PATTERN = /\$\{process\.env\.NEXT_PUBLIC_API_URL\}/g;
    // Permitimos este patrón sólo si en la MISMA línea aparece también un
    // fallback explícito a '/api'. Esto deja intactos los casos canónicos
    // `${process.env.NEXT_PUBLIC_API_URL || '/api'}/...` y los ternarios
    // `${process.env.NEXT_PUBLIC_API_URL && ... !== 'undefined' ? ... : '/api'}/...`.
    const offenders = [];
    for (const file of files) {
        // src/lib/constants.ts es el único lugar donde se construye el
        // fallback (con rama dev 9002). No puede dispararnos el pattern.
        if (file.endsWith("constants.ts")) continue;
        const txt = readFileSync(file, "utf8");
        const lines = txt.split(/\r?\n/);
        lines.forEach((line, idx) => {
            if (!BAD_PATTERN.test(line)) return;
            BAD_PATTERN.lastIndex = 0;
            // ok si la línea trae un fallback literal
            if (line.includes("'/api'") || line.includes('"/api"')) return;
            offenders.push(`${file}:${idx + 1} → ${line.trim()}`);
        });
    }
    assert.deepEqual(
        offenders,
        [],
        `Usos sin fallback de NEXT_PUBLIC_API_URL:\n${offenders.join("\n")}`
    );
});
