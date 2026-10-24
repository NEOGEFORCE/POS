// =============================================================================
// test/list-printers.test.js
//
// Suite `node --test` para la acción WebSocket `listPrinters` (bridge-printing-v2).
// Cubre:
//
//   1. `validatePrinterRequest` acepta la acción nueva y rechaza payloads
//      malformados (sin requestId / sin type correcto).
//   2. `handlePrinterRequest` enruta a `dispatchListPrinters` cuando
//      action="listPrinters" y propaga el stub `deps.listSystemPrinters`.
//   3. El dispatch NO llama a `deps.sendTcp` ni `deps.sendSystem` — es
//      una acción de solo lectura (defensa en profundidad contra regresiones).
//   4. Errores del helper se propagan como `errorCode: "PRINTER_LIST_FAILED"`.
//   5. `normalizePrinterListResult` sanea campos: control chars, status
//      fuera del enum → "unknown", `online` derivado de status, jobs clamp,
//      duplicados por nombre eliminados.
//   6. `payload.refresh === true` se reenvía al stub.
//
// No abre PowerShell real: los transportes se inyectan como stubs.
// =============================================================================

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    ERR,
    PRINTER_STATUSES,
    validatePrinterRequest,
    handlePrinterRequest,
    normalizePrinterListResult,
    dispatchListPrinters,
} = require("../printer-bridge");

// -----------------------------------------------------------------------------
// Helpers de test
// -----------------------------------------------------------------------------

function makeStubDeps(overrides = {}) {
    const calls = { tcp: [], system: [], listPrinters: [] };
    return {
        calls,
        deps: {
            sendTcp: async (host, port, buf, opts) => {
                calls.tcp.push({ host, port, bytes: buf.length, opts });
                return { host, port, bytes: buf.length };
            },
            sendSystem: async (printerName, buf, opts) => {
                calls.system.push({ printerName, bytes: buf.length, opts });
                return { printerName, bytes: buf.length };
            },
            listSystemPrinters: async (opts) => {
                calls.listPrinters.push({ opts });
                return {
                    platform: "win32",
                    defaultName: "POS80",
                    printers: [
                        {
                            name: "POS80",
                            driver: "Generic / Text Only",
                            port: "USB002",
                            status: "online",
                            online: true,
                            isDefault: true,
                            shared: false,
                            jobs: 0,
                            attributes: ["LOCAL", "RAW_ONLY"],
                        },
                    ],
                };
            },
            ...overrides,
        },
    };
}

// -----------------------------------------------------------------------------
// validatePrinterRequest: acepta listPrinters, exige requestId.
// -----------------------------------------------------------------------------

test("validatePrinterRequest: acepta action=listPrinters con requestId", () => {
    const r = validatePrinterRequest({
        type: "printer.request",
        requestId: "pos-list-1",
        action: "listPrinters",
        payload: { refresh: true },
    });
    assert.equal(r.ok, true);
    assert.equal(r.request.action, "listPrinters");
    assert.deepEqual(r.request.payload, { refresh: true });
});

test("validatePrinterRequest: listPrinters sin requestId se rechaza con INVALID_REQUEST", () => {
    const r = validatePrinterRequest({
        type: "printer.request",
        action: "listPrinters",
        payload: {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, ERR.INVALID_REQUEST);
});

test("validatePrinterRequest: listPrinters sin payload acepta {} default", () => {
    const r = validatePrinterRequest({
        type: "printer.request",
        requestId: "x",
        action: "listPrinters",
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.request.payload, {});
});

test("validatePrinterRequest: rechaza type != printer.request aunque action sea listPrinters", () => {
    const r = validatePrinterRequest({
        type: "wrong",
        requestId: "x",
        action: "listPrinters",
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, ERR.INVALID_REQUEST);
});

test("validatePrinterRequest: aún rechaza acciones desconocidas (p.ej. kickRocket)", () => {
    const r = validatePrinterRequest({
        type: "printer.request",
        requestId: "x",
        action: "kickRocket",
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, ERR.UNSUPPORTED_ACTION);
});

// -----------------------------------------------------------------------------
// handlePrinterRequest + listPrinters: delega al stub y NO toca transportes.
// -----------------------------------------------------------------------------

test("handlePrinterRequest listPrinters: delega al stub y devuelve printer-list", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "list-1",
        action: "listPrinters",
        payload: {},
    }, deps);

    assert.equal(r.ok, true, r.error);
    assert.equal(r.result.kind, "printer-list");
    assert.equal(r.result.platform, "win32");
    assert.equal(r.result.defaultName, "POS80");
    assert.ok(Array.isArray(r.result.printers));
    assert.equal(r.result.printers.length, 1);
    assert.equal(r.result.printers[0].name, "POS80");
    assert.equal(r.result.printers[0].driver, "Generic / Text Only");
    assert.equal(r.result.printers[0].port, "USB002");
    assert.equal(r.result.printers[0].status, "online");
    assert.equal(r.result.printers[0].online, true);
    assert.equal(r.result.printers[0].isDefault, true);
    // El stub se llamó exactamente una vez.
    assert.equal(calls.listPrinters.length, 1);
    // Y NUNCA se tocó un transporte de impresión.
    assert.equal(calls.tcp.length, 0, "listPrinters no debe hacer sendTcp");
    assert.equal(calls.system.length, 0, "listPrinters no debe hacer sendSystem");
});

test("handlePrinterRequest listPrinters: payload.refresh=true llega al stub", async () => {
    const { deps, calls } = makeStubDeps();
    await handlePrinterRequest({
        requestId: "list-refresh",
        action: "listPrinters",
        payload: { refresh: true },
    }, deps);
    assert.equal(calls.listPrinters.length, 1);
    assert.equal(calls.listPrinters[0].opts.refresh, true);
    // Timeout default = 10s se le pasa.
    assert.equal(calls.listPrinters[0].opts.timeoutMs, 10000);
});

test("handlePrinterRequest listPrinters: payload.refresh != true no fuerza refresh", async () => {
    const { deps, calls } = makeStubDeps();
    await handlePrinterRequest({
        requestId: "list-norefresh",
        action: "listPrinters",
        payload: { refresh: "yes" },
    }, deps);
    assert.equal(calls.listPrinters[0].opts.refresh, false);
});

test("handlePrinterRequest listPrinters: helper que lanza propaga PRINTER_LIST_FAILED", async () => {
    const { deps, calls } = makeStubDeps({
        listSystemPrinters: async () => {
            const err = new Error("PRINTER_LIST_FAILED: timeout 10000ms");
            err.code = "PRINTER_LIST_FAILED";
            throw err;
        },
    });
    const r = await handlePrinterRequest({
        requestId: "list-err",
        action: "listPrinters",
        payload: {},
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, ERR.PRINTER_LIST_FAILED);
    assert.match(r.error, /PRINTER_LIST_FAILED/);
    assert.equal(calls.tcp.length, 0);
    assert.equal(calls.system.length, 0);
});

test("handlePrinterRequest listPrinters: helper que lanza sin .code sigue siendo PRINTER_LIST_FAILED", async () => {
    const { deps } = makeStubDeps({
        listSystemPrinters: async () => {
            throw new Error("boom");
        },
    });
    const r = await handlePrinterRequest({
        requestId: "list-boom",
        action: "listPrinters",
        payload: {},
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, ERR.PRINTER_LIST_FAILED);
});

test("handlePrinterRequest listPrinters: sin deps.listSystemPrinters devuelve PRINTER_LIST_FAILED accionable", async () => {
    const r = await handlePrinterRequest({
        requestId: "list-noplatform",
        action: "listPrinters",
        payload: {},
    }, { sendTcp: async () => {}, sendSystem: async () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, ERR.PRINTER_LIST_FAILED);
    assert.match(r.error, /no disponible/i);
});

test("dispatchListPrinters: expuesto a los tests para integración directa", async () => {
    const { deps } = makeStubDeps();
    const r = await dispatchListPrinters({ refresh: false }, deps);
    assert.equal(r.ok, true);
    assert.equal(r.result.kind, "printer-list");
});

// -----------------------------------------------------------------------------
// normalizePrinterListResult: saneado de la salida del helper nativo.
// -----------------------------------------------------------------------------

test("normalizePrinterListResult: filtra filas sin nombre y recorta control chars", () => {
    const r = normalizePrinterListResult({
        platform: "win32",
        defaultName: "POS80",
        printers: [
            { name: "POS80", driver: "Driver\u0007raro", port: "USB002", status: "online" },
            { name: "", driver: "sin nombre", status: "online" }, // filtrada
            { name: "   ", status: "online" }, // filtrada tras trim
            { driver: "sin name", status: "online" }, // filtrada
        ],
    });
    assert.equal(r.printers.length, 1);
    assert.equal(r.printers[0].name, "POS80");
    // Control char eliminado por `cleanField`.
    assert.equal(r.printers[0].driver, "Driverraro");
});

test("normalizePrinterListResult: status fuera del enum cae a 'unknown' y online se recalcula", () => {
    const r = normalizePrinterListResult({
        printers: [
            { name: "A", status: "turbo", online: true },           // → unknown + online:false
            { name: "B", status: "online", online: false },         // → online + online:true (derivado)
            { name: "C", status: "ONLINE" },                        // case insensitive
            { name: "D", status: "paper-out" },                     // válido
            { name: "E", status: "paused" },
            { name: "F" },                                          // sin status → unknown
        ],
    });
    assert.equal(r.printers[0].status, "unknown");
    assert.equal(r.printers[0].online, false, "online debe derivarse de status");
    assert.equal(r.printers[1].status, "online");
    assert.equal(r.printers[1].online, true);
    assert.equal(r.printers[2].status, "online");
    assert.equal(r.printers[3].status, "paper-out");
    assert.equal(r.printers[3].online, false);
    assert.equal(r.printers[4].status, "paused");
    assert.equal(r.printers[5].status, "unknown");
    assert.equal(r.printers[5].online, false);
});

test("normalizePrinterListResult: isDefault se infiere del name === defaultName", () => {
    const r = normalizePrinterListResult({
        defaultName: "POS80",
        printers: [
            { name: "POS80", status: "online" },               // isDefault derivado
            { name: "POS58", status: "online", isDefault: false },
            { name: "POS-EXTRA", status: "online", isDefault: true },
        ],
    });
    assert.equal(r.printers[0].isDefault, true);
    assert.equal(r.printers[1].isDefault, false);
    // isDefault:true explícito se respeta.
    assert.equal(r.printers[2].isDefault, true);
});

test("normalizePrinterListResult: jobs se clamp a [0, 99999] e ignora valores no numéricos", () => {
    const r = normalizePrinterListResult({
        printers: [
            { name: "A", status: "online", jobs: -5 },
            { name: "B", status: "online", jobs: 123 },
            { name: "C", status: "online", jobs: 1e9 },
            { name: "D", status: "online", jobs: "veinte" },
        ],
    });
    assert.equal(r.printers[0].jobs, 0);
    assert.equal(r.printers[1].jobs, 123);
    assert.equal(r.printers[2].jobs, 99999);
    assert.equal(r.printers[3].jobs, 0);
});

test("normalizePrinterListResult: deduplica por nombre canónico", () => {
    const r = normalizePrinterListResult({
        printers: [
            { name: "POS80", driver: "A", status: "online" },
            { name: "POS80", driver: "B", status: "offline" },
            { name: "POS80", driver: "C", status: "online" },
        ],
    });
    assert.equal(r.printers.length, 1);
    assert.equal(r.printers[0].driver, "A", "gana la primera ocurrencia");
});

test("normalizePrinterListResult: attributes se filtran y recortan (máx 16, strings limpios)", () => {
    const r = normalizePrinterListResult({
        printers: [
            {
                name: "A",
                status: "online",
                attributes: ["LOCAL", "", null, "RAW_ONLY", "a".repeat(50), ...Array(20).fill("X")],
            },
        ],
    });
    const a = r.printers[0].attributes;
    assert.ok(a.length <= 16);
    assert.ok(a.includes("LOCAL"));
    assert.ok(a.includes("RAW_ONLY"));
    // String largo recortado a 32.
    assert.ok(a.some((v) => v.length <= 32));
});

test("normalizePrinterListResult: entrada no-objeto devuelve lista vacía", () => {
    assert.deepEqual(normalizePrinterListResult(null), {
        kind: "printer-list", platform: "win32", defaultName: "", printers: [],
    });
    assert.deepEqual(normalizePrinterListResult({}).printers, []);
    assert.deepEqual(normalizePrinterListResult({ printers: "no es array" }).printers, []);
});

test("normalizePrinterListResult: acepta arreglo top-level (helper que omite el envoltorio)", () => {
    const r = normalizePrinterListResult([
        { name: "POS80", status: "online" },
    ]);
    assert.equal(r.printers.length, 1);
    assert.equal(r.platform, "win32"); // default
});

test("PRINTER_STATUSES incluye los 6 estados documentados", () => {
    for (const s of ["online", "offline", "paper-out", "error", "paused", "unknown"]) {
        assert.ok(PRINTER_STATUSES.includes(s), `${s} debe estar expuesto`);
    }
});
