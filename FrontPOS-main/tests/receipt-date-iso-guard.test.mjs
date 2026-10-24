// =============================================================================
// tests/receipt-date-iso-guard.test.mjs
//
// GUARDIÁN de ISO 8601 para `lastReceipt.date`.
//
// Antes `useNewSale.ts` guardaba `lastReceipt.date` con
// `new Date().toLocaleString()`. El consumidor (`saleToTicket` en
// `thermal-ticket.ts`) lo reparseaba con `new Date(string)` y según el
// locale del sistema producía un `Invalid Date` — en caja real la
// tirilla térmica acababa imprimiendo literalmente
// `NaN/NaN/NaN NaN:NaN NaN`.
//
// La fuente de la verdad para el flujo de impresión es `Date` nativo o
// un string ISO 8601 inequívocamente parseable. Este test estático
// asegura que la fuente respeta ese contrato: ningún futuro refactor
// puede volver a guardar `toLocaleString()` en `lastReceipt.date` sin
// que se rompa esta suite y bloquee el merge.
//
// Son tests ESTÁTICOS (lectura de código fuente, no React en runtime)
// porque toda la lógica reactiva de `useNewSale.ts` requiere un árbol
// montado — demasiada infraestructura para una invariante tan concreta.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const useNewSalePath = join(
    here,
    "..",
    "src",
    "app",
    "(app)",
    "sales",
    "new",
    "hooks",
    "useNewSale.ts",
);

async function readSource() {
    return readFile(useNewSalePath, "utf8");
}

/**
 * Devuelve el bloque `setLastReceipt({ ... })` completo (balanceando llaves)
 * para hacer aserciones precisas dentro de ese contexto en vez de contra
 * todo el archivo. Si el bloque no existe falla el test con un mensaje
 * claro para que el próximo autor sepa qué buscar.
 */
function extractSetLastReceiptBlock(source) {
    const marker = "setLastReceipt({";
    const start = source.indexOf(marker);
    assert.ok(start !== -1,
        "Se esperaba una llamada a setLastReceipt({ ... }) en useNewSale.ts");

    // Posición del `{` abriendo el objeto literal.
    const openBrace = source.indexOf("{", start + "setLastReceipt(".length);
    assert.ok(openBrace !== -1, "setLastReceipt debería recibir un objeto literal");

    let depth = 0;
    let i = openBrace;
    for (; i < source.length; i++) {
        const ch = source[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) {
                return source.slice(openBrace, i + 1);
            }
        }
    }
    throw new Error("No se encontró el cierre del objeto literal en setLastReceipt");
}

test("useNewSale.setLastReceipt guarda `date` como ISO 8601 (toISOString)", async () => {
    const src = await readSource();
    const block = extractSetLastReceiptBlock(src);

    assert.match(
        block,
        /date:\s*new\s+Date\(\)\.toISOString\(\)/,
        "El campo `date` dentro de setLastReceipt({ ... }) debe inicializarse "
        + "con `new Date().toISOString()` para que `saleToTicket → new Date(rawDate)` "
        + "produzca siempre un Date válido, sin importar el locale del SO.",
    );
});

test("useNewSale.setLastReceipt NO guarda `date` con toLocaleString (regresión bloqueada)", async () => {
    const src = await readSource();
    const block = extractSetLastReceiptBlock(src);

    assert.ok(
        !/date:\s*new\s+Date\(\)\.toLocaleString\(/.test(block),
        "`date` dentro de setLastReceipt NO puede volver a toLocaleString(): "
        + "`new Date(toLocaleString())` produce Invalid Date según locale y "
        + "la tirilla térmica terminaba imprimiendo 'NaN/NaN/NaN NaN:NaN NaN'.",
    );
});

test("useNewSale: no hay otros `toLocaleString()` sobre `new Date()` persistidos en estado del hook", async () => {
    const src = await readSource();
    // Solo guardamos valores PERSISTIBLES (lastReceipt, carts, cartCustomers,
    // selectedCustomerDni, selectedItemId) con shapes que luego se reparsean.
    // Para evitar que vuelva a colarse un `new Date().toLocaleString()` en
    // cualquiera de ellos, el guardián es a nivel de archivo.
    //
    // Importante: el archivo DOCUMENTA el bug histórico en un comentario,
    // así que primero quitamos los comentarios (línea y bloque) antes de
    // buscar, para no fallar por una referencia textual al patrón prohibido.
    //
    // La restricción es estricta sobre `new Date()` encadenado directamente
    // con `toLocaleString(`: usos legítimos sobre un Date YA construido
    // (p.ej. `date.toLocaleString('es-CO')` en una vista de UI que renderiza
    // texto efímero) siguen permitidos.
    const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "") // comentarios de bloque
        .replace(/\/\/[^\n]*/g, "");       // comentarios de línea

    assert.ok(
        !/new\s+Date\(\s*\)\s*\.toLocaleString\s*\(/.test(stripped),
        "Ningún `new Date().toLocaleString()` nuevo puede entrar al hook: "
        + "si necesita una fecha persistible usar `toISOString()`; si es "
        + "sólo UI efímera, construir primero el Date y formatearlo aparte.",
    );
});
