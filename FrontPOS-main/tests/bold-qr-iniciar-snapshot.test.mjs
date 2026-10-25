// =============================================================================
// tests/bold-qr-iniciar-snapshot.test.mjs
//
// Guardianes del flujo "snapshot DURABLE al abrir el QR" (migración 027,
// patch de reconciliación segura MacroDroid):
//
//   HELPER (pruebas puras sobre `buildIniciarPayload`):
//     IH1. Modo mínimo (sólo caja_id/monto/venta_temp_id) sigue viviendo
//          — compatibilidad hacia atrás para el /iniciar que ejecuta el
//          propio `ModalPagoBoldQR` al montar.
//     IH2. Acepta client_tx_id (8..64 chars), client_dni, cashier_name
//          y sale_payload como OPCIONALES; cuando están todos presentes
//          el payload resultante los emite en snake_case.
//     IH3. client_tx_id fuera de 8..64 → null (contrato duro con backend).
//     IH4. sale_payload sin details, details vacío, o detalles mal
//          tipados → null (no inventar).
//     IH5. Omitir todos los opcionales devuelve un payload "ligero"
//          sin esos campos (reflecta la llamada del modal al montar
//          que el backend reusa idempotentemente).
//     IH6. Campos opcionales como string vacío son ignorados (equivalentes
//          a undefined), para que la llamada del modal al montar no se
//          vea obligada a pasar strings vacíos para pasar la validación.
//
//   WIRE / ORDER (lectura estática de /sales/new/page.tsx y UPM):
//     IO1. `UniversalPaymentModal` tipa `onBoldQrRequested` como
//          `(amount, ventaTempId) => void | Promise<void>` (callback
//          puede ser async).
//     IO2. `handleOpenBoldQr` await al `onBoldQrRequested` ANTES de
//          `setIsBoldQrOpen(true)`: el modal hijo no se abre si la
//          preparación falla.
//     IO3. En caso de error, `handleOpenBoldQr` muestra toast y NO toca
//          `boldSessionIdRef.current` (el carrito queda intacto).
//     IO4. `sales/new/page.tsx` define `prepareBoldQrIntent` que POSTea
//          `/pos/pagos-qr/iniciar` y guarda la preparación en un
//          `useRef<Map<...>>` keyed por `ventaTempId`.
//     IO5. `onBoldQrRequested` en el JSX del padre apunta a
//          `prepareBoldQrIntent` (no a un stub vacío de telemetría).
//
//   IDEMPOTENCY (lectura estática del enqueue):
//     II1. `handleBoldQrEnqueueRequested` consulta el map
//          `qrPreparationsRef.current.get(trimmedTemp)` y reusa el
//          `clientTxId` guardado — nunca lo regenera si existe prep.
//     II2. Tras el 200 de /encolar, la entrada del map se borra
//          (`qrPreparationsRef.current.delete(...)`) para no retener
//          snapshots obsoletos.
//     II3. El mismo `clientTxId` que se envió a /iniciar es el que
//          se envía a /encolar; el frontend NO regenera el identificador
//          entre endpoints.
//
// Tests por LECTURA DE FUENTE: no montan React.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIniciarPayload } from "../src/lib/bold-qr-helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const upmPath = join(repoRoot, "src", "components", "shared", "UniversalPaymentModal.tsx");
const salesNewPagePath = join(repoRoot, "src", "app", "(app)", "sales", "new", "page.tsx");

const readSrc = (path) => readFile(path, "utf8");

async function readWithoutComments(path) {
    const raw = await readFile(path, "utf8");
    return raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// IH1 — modo mínimo (compat con la llamada del modal al montar)
// ---------------------------------------------------------------------------

test("IH1 buildIniciarPayload: modo mínimo (sólo caja_id/monto/venta_temp_id) sigue siendo válido", () => {
    const out = buildIniciarPayload({
        caja_id: "CAJA-1",
        monto: 45800,
        venta_temp_id: "temp-abc-123",
    });
    assert.deepEqual(out, { caja_id: "CAJA-1", monto: 45800, venta_temp_id: "temp-abc-123" });
    // No deben aparecer campos opcionales inventados.
    for (const key of ["client_tx_id", "client_dni", "cashier_name", "sale_payload"]) {
        assert.ok(!(key in out), `No debe aparecer ${key} si no se envió`);
    }
});

// ---------------------------------------------------------------------------
// IH2 — modo completo (snapshot durable)
// ---------------------------------------------------------------------------

test("IH2 buildIniciarPayload: con client_tx_id/client_dni/cashier_name/sale_payload emite todos en snake_case", () => {
    const salePayload = {
        details: [
            { barcode: "7702001001001", quantity: 2, unitPrice: 2500 },
            { barcode: "7702001002002", quantity: 1, unitPrice: 7500 },
        ],
        totalAmount: 12500,
        amountPaid: 12500,
        change: 0,
        transferAmount: 12500,
        transferSource: "BOLD_QR",
        paymentMethod: "BOLD_QR",
        employeeDni: "1193594720",
        clientDni: "900123456",
        clientName: "AlmacenCanal",
    };
    const out = buildIniciarPayload({
        caja_id: "CAJA-1",
        monto: 12500,
        venta_temp_id: "vt_abcdef12345",
        client_tx_id: "qrtx_17299999999_abcdef12345",
        client_dni: "900123456",
        cashier_name: "Yulis",
        sale_payload: salePayload,
    });
    assert.ok(out, "El payload no debería ser null con un input válido completo");
    assert.equal(out.caja_id, "CAJA-1");
    assert.equal(out.monto, 12500);
    assert.equal(out.venta_temp_id, "vt_abcdef12345");
    assert.equal(out.client_tx_id, "qrtx_17299999999_abcdef12345");
    assert.equal(out.client_dni, "900123456");
    assert.equal(out.cashier_name, "Yulis");
    assert.deepEqual(out.sale_payload, salePayload);
});

test("IH2b buildIniciarPayload: trimea los opcionales string", () => {
    const out = buildIniciarPayload({
        caja_id: "CAJA-1",
        monto: 100,
        venta_temp_id: "temp-id-123",
        client_tx_id: "   qrtx_1234567890   ",
        client_dni: "  900123456 ",
        cashier_name: "  Yulis  ",
    });
    assert.ok(out);
    assert.equal(out.client_tx_id, "qrtx_1234567890");
    assert.equal(out.client_dni, "900123456");
    assert.equal(out.cashier_name, "Yulis");
});

// ---------------------------------------------------------------------------
// IH3 — client_tx_id length guard
// ---------------------------------------------------------------------------

test("IH3 buildIniciarPayload: client_tx_id fuera de 8..64 chars → null", () => {
    // Muy corto
    assert.equal(
        buildIniciarPayload({
            caja_id: "C",
            monto: 100,
            venta_temp_id: "t-abc-123",
            client_tx_id: "short",
        }),
        null,
    );
    // Muy largo
    assert.equal(
        buildIniciarPayload({
            caja_id: "C",
            monto: 100,
            venta_temp_id: "t-abc-123",
            client_tx_id: "x".repeat(65),
        }),
        null,
    );
    // 8 chars: válido (frontera inclusiva)
    const minOk = buildIniciarPayload({
        caja_id: "C",
        monto: 100,
        venta_temp_id: "t-abc-123",
        client_tx_id: "x".repeat(8),
    });
    assert.ok(minOk, "8 chars debe ser válido (frontera inclusiva)");
    assert.equal(minOk.client_tx_id.length, 8);
    // 64 chars: válido
    const maxOk = buildIniciarPayload({
        caja_id: "C",
        monto: 100,
        venta_temp_id: "t-abc-123",
        client_tx_id: "x".repeat(64),
    });
    assert.ok(maxOk, "64 chars debe ser válido (frontera inclusiva)");
    assert.equal(maxOk.client_tx_id.length, 64);
});

// ---------------------------------------------------------------------------
// IH4 — sale_payload validation
// ---------------------------------------------------------------------------

test("IH4 buildIniciarPayload: sale_payload sin details, vacío o malformado → null", () => {
    const base = { caja_id: "C", monto: 100, venta_temp_id: "t-abc-123" };
    // sin details
    assert.equal(
        buildIniciarPayload({ ...base, sale_payload: {} }),
        null,
    );
    // details vacío
    assert.equal(
        buildIniciarPayload({ ...base, sale_payload: { details: [] } }),
        null,
    );
    // detail sin barcode
    assert.equal(
        buildIniciarPayload({
            ...base,
            sale_payload: { details: [{ barcode: "", quantity: 1, unitPrice: 100 }] },
        }),
        null,
    );
    // detail con quantity 0
    assert.equal(
        buildIniciarPayload({
            ...base,
            sale_payload: {
                details: [{ barcode: "7702001001001", quantity: 0, unitPrice: 100 }],
            },
        }),
        null,
    );
    // detail con unitPrice negativo
    assert.equal(
        buildIniciarPayload({
            ...base,
            sale_payload: {
                details: [{ barcode: "7702001001001", quantity: 1, unitPrice: -1 }],
            },
        }),
        null,
    );
    // detail con unitPrice=0 (obsequio) → VÁLIDO
    const giftOk = buildIniciarPayload({
        ...base,
        sale_payload: {
            details: [{ barcode: "7702001001001", quantity: 1, unitPrice: 0 }],
        },
    });
    assert.ok(giftOk, "unitPrice=0 (gift) debe aceptarse");
});

test("IH4b buildIniciarPayload: sale_payload no-objeto o array → null", () => {
    const base = { caja_id: "C", monto: 100, venta_temp_id: "t-abc-123" };
    assert.equal(buildIniciarPayload({ ...base, sale_payload: "foo" }), null);
    assert.equal(buildIniciarPayload({ ...base, sale_payload: 42 }), null);
    assert.equal(buildIniciarPayload({ ...base, sale_payload: [] }), null);
});

// ---------------------------------------------------------------------------
// IH5 — Omitir opcionales devuelve payload ligero
// ---------------------------------------------------------------------------

test("IH5 buildIniciarPayload: omitir opcionales no inventa campos (payload ligero)", () => {
    const out = buildIniciarPayload({
        caja_id: 1,
        monto: 100,
        venta_temp_id: "t-abc-123",
    });
    assert.deepEqual(Object.keys(out).sort(), ["caja_id", "monto", "venta_temp_id"]);
});

// ---------------------------------------------------------------------------
// IH6 — String vacío equivale a omisión
// ---------------------------------------------------------------------------

test("IH6 buildIniciarPayload: string vacío en opcionales = omisión (no genera null)", () => {
    const out = buildIniciarPayload({
        caja_id: "C",
        monto: 100,
        venta_temp_id: "t-abc-123",
        client_tx_id: "",
        client_dni: "",
        cashier_name: "",
    });
    assert.ok(out, "Omitir opcionales via string vacío no debe forzar null");
    for (const key of ["client_tx_id", "client_dni", "cashier_name"]) {
        assert.ok(!(key in out), `${key} vacío debe omitirse del output`);
    }
});

// ---------------------------------------------------------------------------
// IO1 — UPM onBoldQrRequested firma async
// ---------------------------------------------------------------------------

test("IO1 UPM: onBoldQrRequested tipa (amount, ventaTempId) => void | Promise<void>", async () => {
    const src = await readSrc(upmPath);
    assert.match(
        src,
        /onBoldQrRequested\?\s*:\s*\(\s*amount:\s*number,\s*ventaTempId:\s*string,\s*breakdown:\s*\{[\s\S]*?\}\s*,?\s*\)\s*=>\s*void\s*\|\s*Promise<void>/,
        "La prop debe tipar explícitamente (amount, ventaTempId, breakdown) y permitir Promise<void>.",
    );
});

// ---------------------------------------------------------------------------
// IO2 — await al preparar ANTES de abrir el modal hijo
// ---------------------------------------------------------------------------

test("IO2 UPM.handleOpenBoldQr: await onBoldQrRequested antes de setIsBoldQrOpen(true)", async () => {
    const src = await readSrc(upmPath);
    const start = src.indexOf("const handleOpenBoldQr = useCallback");
    assert.ok(start > 0, "handleOpenBoldQr debe existir en el UPM");
    const end = src.indexOf("}, [", start);
    const body = src.slice(start, end);
    // Debe ser async
    assert.match(body, /useCallback\(async\s*\(\s*\)\s*=>/,
        "handleOpenBoldQr debe ser async para poder await al callback.");
    // Debe hacer await al callback
    assert.match(body, /await\s+onBoldQrRequested\(amount,\s*uuid,\s*breakdown\)/,
        "Debe hacer `await onBoldQrRequested(amount, uuid, breakdown)` antes de abrir el modal.");
    // El await debe ocurrir ANTES del setIsBoldQrOpen(true)
    const awaitIdx = body.indexOf("await onBoldQrRequested");
    const openIdx = body.indexOf("setIsBoldQrOpen(true)");
    assert.ok(awaitIdx > 0 && openIdx > awaitIdx,
        "El `await` debe venir ANTES de `setIsBoldQrOpen(true)` (no se abre el modal si falla).");
});

// ---------------------------------------------------------------------------
// IO3 — error handling: toast + no abrir modal
// ---------------------------------------------------------------------------

test("IO3 UPM.handleOpenBoldQr: en error muestra toast destructive y NO abre modal", async () => {
    const src = await readSrc(upmPath);
    const start = src.indexOf("const handleOpenBoldQr = useCallback");
    const end = src.indexOf("}, [", start);
    const body = src.slice(start, end);
    // Debe tener un try/catch
    assert.match(body, /try\s*\{/, "handleOpenBoldQr debe envolver el await en try/catch.");
    assert.match(body, /catch\s*\(\s*err\b/, "El catch debe capturar el error.");
    // Debe emitir un toast destructive
    assert.match(
        body,
        /toast\(\s*\{\s*[\s\S]*?variant:\s*["']destructive["'][\s\S]*?NO SE PUDO PREPARAR EL QR/,
        "Debe mostrar toast destructive con título 'NO SE PUDO PREPARAR EL QR'.",
    );
    // Debe hacer `return` en el catch (no abrir modal). Acotamos
    // el catch por el `}` de cierre que coincide con su `{`.
    const catchStart = body.indexOf("catch");
    assert.ok(catchStart > 0, "El cuerpo debe tener un catch.");
    const openBrace = body.indexOf("{", catchStart);
    // Buscar el `}` que cierra el catch via balanceo simple.
    let depth = 0;
    let closeBrace = -1;
    for (let i = openBrace; i < body.length; i++) {
        const ch = body[i];
        if (ch === "{") depth += 1;
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0) { closeBrace = i; break; }
        }
    }
    assert.ok(closeBrace > openBrace, "El bloque catch debe estar bien balanceado.");
    const catchBody = body.slice(openBrace, closeBrace);
    assert.match(catchBody, /\breturn\b/,
        "El catch debe hacer return temprano para no abrir el modal.");
});

test("IO3b UPM.handleOpenBoldQr: boldSessionIdRef.current sólo se setea tras preparación exitosa", async () => {
    const src = await readSrc(upmPath);
    const start = src.indexOf("const handleOpenBoldQr = useCallback");
    const end = src.indexOf("}, [", start);
    const body = src.slice(start, end);
    // La asignación a boldSessionIdRef.current DEBE venir después del await.
    const awaitIdx = body.indexOf("await onBoldQrRequested");
    const setRefIdx = body.indexOf("boldSessionIdRef.current = uuid");
    assert.ok(setRefIdx > awaitIdx,
        "boldSessionIdRef.current = uuid debe ir DESPUÉS del await (nunca antes).");
});

// ---------------------------------------------------------------------------
// IO4 — página: prepareBoldQrIntent + qrPreparationsRef
// ---------------------------------------------------------------------------

test("IO4 sales/new/page.tsx: define prepareBoldQrIntent que POSTea /iniciar", async () => {
    const src = await readSrc(salesNewPagePath);
    assert.match(src, /const\s+prepareBoldQrIntent\s*=\s*useCallback\(/,
        "Debe existir prepareBoldQrIntent como useCallback.");
    // Firma (amount, ventaTempId)
    assert.match(
        src,
        /prepareBoldQrIntent\s*=\s*useCallback\(\s*async\s*\(\s*amount:\s*number,\s*ventaTempId:\s*string,\s*breakdown:/,
        "La firma debe ser async (amount: number, ventaTempId: string, breakdown).",
    );
    const start = src.indexOf("const prepareBoldQrIntent = useCallback");
    const end = src.indexOf("}, [", start);
    const body = src.slice(start, end);
    // Debe POST /iniciar
    assert.match(
        body,
        /apiFetch\(\s*['"]\/pos\/pagos-qr\/iniciar['"]/,
        "prepareBoldQrIntent debe POST /pos/pagos-qr/iniciar.",
    );
    // Debe hacer await al POST
    const postIdx = body.indexOf("/pos/pagos-qr/iniciar");
    const awaitIdx = body.lastIndexOf("await", postIdx);
    assert.ok(awaitIdx > 0 && awaitIdx < postIdx,
        "El POST /iniciar debe ser await (no fire-and-forget).");
    // Debe usar buildIniciarPayload
    assert.match(body, /buildIniciarPayload\(/,
        "Debe construir el body via buildIniciarPayload (defensa snake_case).");
    // Debe guardar en el Map tras éxito
    assert.match(
        body,
        /qrPreparationsRef\.current\.set\(/,
        "Tras POST exitoso debe guardar la preparación en el Map.",
    );
});

test("IO4b sales/new/page.tsx: qrPreparationsRef es useRef<Map<...>>", async () => {
    const src = await readSrc(salesNewPagePath);
    assert.match(
        src,
        /const\s+qrPreparationsRef\s*=\s*useRef<Map<string,\s*QrPreparedSnapshot>>/,
        "El map de preparaciones debe ser useRef<Map<string, QrPreparedSnapshot>> para persistir entre renders sin disparar re-renders.",
    );
});

test("IO4c sales/new/page.tsx: prepareBoldQrIntent lanza si el carrito está vacío (bloquea apertura modal)", async () => {
    const src = await readSrc(salesNewPagePath);
    const start = src.indexOf("const prepareBoldQrIntent = useCallback");
    const end = src.indexOf("}, [", start);
    const body = src.slice(start, end);
    assert.match(body, /El carrito está vacío/,
        "Debe lanzar 'El carrito está vacío' si no hay items.");
    assert.match(body, /throw\s+new\s+Error/,
        "Debe usar throw new Error — el UPM pinta toast + no abre modal.");
});

// ---------------------------------------------------------------------------
// IO5 — JSX wiring en la página
// ---------------------------------------------------------------------------

test("IO5 sales/new/page.tsx: UniversalPaymentModal recibe onBoldQrRequested=prepareBoldQrIntent", async () => {
    const src = await readSrc(salesNewPagePath);
    assert.match(
        src,
        // QR habilitado también en edición (Factura EDIT-<id>): el
        // snapshot lleva editSaleId y la aprobación actualiza esa venta.
        /onBoldQrRequested=\{prepareBoldQrIntent\}/,
        "El UPM debe recibir prepareBoldQrIntent (snapshot durable), no un stub de telemetría.",
    );
    // El stub viejo (telemetry hook — intencionalmente vacío) no debe sobrevivir
    const runtime = await readWithoutComments(salesNewPagePath);
    assert.doesNotMatch(
        runtime,
        /onBoldQrRequested=\{[^}]*\(_amount\)\s*=>\s*\{[^}]*\}/,
        "El stub viejo `(_amount) => { }` debe quedar eliminado del runtime.",
    );
});

// ---------------------------------------------------------------------------
// II1 — enqueue reusa el clientTxId guardado
// ---------------------------------------------------------------------------

test("II1 sales/new/page.tsx: handleBoldQrEnqueueRequested reusa clientTxId del Map", async () => {
    const src = await readSrc(salesNewPagePath);
    const start = src.indexOf("const handleBoldQrEnqueueRequested = useCallback");
    const end = src.indexOf("}, [", start);
    const body = src.slice(start, end);
    // Debe consultar el map
    assert.match(
        body,
        /qrPreparationsRef\.current\.get\(trimmedTemp\)/,
        "El enqueue debe consultar la preparación guardada por ventaTempId.",
    );
    // Si hay stored: debe reusar clientTxId
    assert.match(
        body,
        /clientTxId\s*=\s*stored\.clientTxId/,
        "Si existe prep, se reusa `stored.clientTxId` (nunca regenera).",
    );
    // Debe también reusar snapshot
    assert.match(
        body,
        /salePayload\s*=\s*stored\.salePayload/,
        "Si existe prep, se reusa `stored.salePayload`.",
    );
});

// ---------------------------------------------------------------------------
// II2 — Tras éxito, el map se limpia
// ---------------------------------------------------------------------------

test("II2 sales/new/page.tsx: tras 200 de /encolar, delete del map local", async () => {
    const src = await readSrc(salesNewPagePath);
    const start = src.indexOf("const handleBoldQrEnqueueRequested = useCallback");
    const end = src.indexOf("}, [", start);
    const body = src.slice(start, end);
    // delete debe aparecer DESPUÉS del await /encolar
    const postIdx = body.indexOf("/pos/pagos-qr/encolar");
    const deleteIdx = body.indexOf("qrPreparationsRef.current.delete(");
    assert.ok(deleteIdx > postIdx,
        "El delete del map debe hacerse DESPUÉS del await /encolar (si éste falla, mantenemos la prep).");
});

// ---------------------------------------------------------------------------
// II3 — Idempotency end-to-end: NO regenerar clientTxId entre endpoints
// ---------------------------------------------------------------------------

test("II3 sales/new/page.tsx: enqueue NO regenera clientTxId cuando hay prep guardada", async () => {
    const src = await readSrc(salesNewPagePath);
    const start = src.indexOf("const handleBoldQrEnqueueRequested = useCallback");
    const end = src.indexOf("}, [", start);
    const body = src.slice(start, end);
    // Buscamos el bloque dentro del `if (stored)` — ahí NO debe haber
    // generateQrClientTxId.
    const storedIfIdx = body.indexOf("if (stored)");
    assert.ok(storedIfIdx > 0, "Debe existir la rama `if (stored)`.");
    const elseIdx = body.indexOf("} else {", storedIfIdx);
    assert.ok(elseIdx > storedIfIdx, "Debe existir la rama `else` para el fallback.");
    const storedBranch = body.slice(storedIfIdx, elseIdx);
    assert.doesNotMatch(
        storedBranch,
        /generateQrClientTxId\(/,
        "Dentro de `if (stored)` NO se puede regenerar clientTxId (contrato de idempotencia).",
    );
});

// ---------------------------------------------------------------------------
// Hidden check: fallback branch is defensive but documented
// ---------------------------------------------------------------------------

test("sales/new/page.tsx: la rama fallback del enqueue construye snapshot desde el carrito (defensa tray-reopen)", async () => {
    const src = await readSrc(salesNewPagePath);
    const start = src.indexOf("const handleBoldQrEnqueueRequested = useCallback");
    const end = src.indexOf("}, [", start);
    const body = src.slice(start, end);
    assert.match(
        body,
        /buildQrSalePayloadSnapshot\(\{\s*qrAmount:\s*normalizedMonto/,
        "La rama fallback debe construir el snapshot desde el carrito actual.",
    );
});
