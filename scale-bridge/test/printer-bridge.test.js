// =============================================================================
// test/printer-bridge.test.js
//
// Suite `node --test` para la lógica pura de `printer-bridge.js`. No abre
// sockets reales ni spawnea procesos: todos los transportes se inyectan
// como stubs y se verifica que:
//   - Se construyen los bytes esperados para recibos / etiquetas.
//   - Las validaciones devuelven códigos accionables ante inputs rotos.
//   - El drawer command parsea literales \xHH y rechaza basura.
//   - La codificación CP850 preserva ñ y acentos en español.
//   - El routing TCP vs SYSTEM es correcto según connection.interface.
//   - printTestPage / print({type:test-page}) convergen al mismo flujo.
//
// Para correrlos:  npm test   (o node --test test/)
// =============================================================================

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    LIMITS,
    ERR,
    encodeCP850,
    transliterate,
    parseDrawerCommand,
    validateConnectionForPrint,
    pickTransport,
    buildReceiptBytes,
    buildTestPageReceipt,
    buildTestPageLabel,
    normalizeLabelItems,
    buildLabelBytes,
    buildTsplBatch,
    encodeBarcode128,
    validatePrinterRequest,
    isLocalOrigin,
    handlePrinterRequest,
} = require("../printer-bridge");

// -----------------------------------------------------------------------------
// Helpers de test
// -----------------------------------------------------------------------------

function makeStubDeps(overrides = {}) {
    const calls = { tcp: [], system: [] };
    return {
        calls,
        deps: {
            sendTcp: async (host, port, buf, opts) => {
                calls.tcp.push({ host, port, bytes: buf.length, buf: Buffer.from(buf), opts });
                return { host, port, bytes: buf.length };
            },
            sendSystem: async (printerName, buf, opts) => {
                calls.system.push({ printerName, bytes: buf.length, buf: Buffer.from(buf), opts });
                return { printerName, bytes: buf.length };
            },
            ...overrides,
        },
    };
}

// -----------------------------------------------------------------------------
// CP850 encoding
// -----------------------------------------------------------------------------

test("encodeCP850: preserva ASCII imprimible y controles canónicos", () => {
    const buf = encodeCP850("Hola\nMundo\t!");
    // H=0x48, o=0x6F, l=0x6C, a=0x61, LF=0x0A, M=0x4D, u=0x75, n=0x6E, d=0x64, o=0x6F, TAB=0x09, !=0x21
    assert.deepEqual(Array.from(buf), [0x48, 0x6F, 0x6C, 0x61, 0x0A, 0x4D, 0x75, 0x6E, 0x64, 0x6F, 0x09, 0x21]);
});

test("encodeCP850: mapea acentos y ñ al byte correcto de CP850", () => {
    const buf = encodeCP850("ñáéíóúÑ¿¡Ü");
    // ñ=0xA4, á=0xA0, é=0x82, í=0xA1, ó=0xA2, ú=0xA3, Ñ=0xA5, ¿=0xA8, ¡=0xAD, Ü=0x9A
    assert.deepEqual(Array.from(buf), [0xA4, 0xA0, 0x82, 0xA1, 0xA2, 0xA3, 0xA5, 0xA8, 0xAD, 0x9A]);
});

test("encodeCP850: translitera símbolos tipográficos y chars sin encoding", () => {
    const buf = encodeCP850("“Hola” — mundo…");
    // Esperamos: "Hola" - mundo...   (comillas y guion largo convertidos a ASCII seguros)
    assert.equal(buf.toString("ascii"), '"Hola" - mundo...');
});

test("encodeCP850: nbsp y zero-width se eliminan/transforman", () => {
    const buf = encodeCP850("A\u00A0B\u200BC");
    // nbsp → espacio, zero-width → nada
    assert.equal(buf.toString("ascii"), "A BC");
});

test("transliterate: idempotente para texto ya ASCII", () => {
    assert.equal(transliterate("abc 123"), "abc 123");
});

// -----------------------------------------------------------------------------
// Drawer command parser
// -----------------------------------------------------------------------------

test("parseDrawerCommand: decodifica el literal ESC/POS estándar", () => {
    const buf = parseDrawerCommand("\\x1B\\x70\\x00\\x19\\xFA");
    assert.deepEqual(Array.from(buf), [0x1B, 0x70, 0x00, 0x19, 0xFA]);
});

test("parseDrawerCommand: soporta hex en minúscula y mezcla de escapes", () => {
    const buf = parseDrawerCommand("\\x1b\\n\\t\\\\");
    assert.deepEqual(Array.from(buf), [0x1B, 0x0A, 0x09, 0x5C]);
});

test("parseDrawerCommand: rechaza \\xH incompleto con DRAWER_COMMAND_INVALID", () => {
    assert.throws(
        () => parseDrawerCommand("\\x1"),
        (err) => err.code === ERR.DRAWER_COMMAND_INVALID,
    );
});

test("parseDrawerCommand: rechaza bytes UTF-8 multibyte", () => {
    assert.throws(
        () => parseDrawerCommand("ñ"),
        (err) => err.code === ERR.DRAWER_COMMAND_INVALID,
    );
});

test("parseDrawerCommand: rechaza cadena vacía", () => {
    assert.throws(
        () => parseDrawerCommand(""),
        (err) => err.code === ERR.DRAWER_COMMAND_EMPTY,
    );
});

test("parseDrawerCommand: rechaza payload que excede maxDrawerBytes", () => {
    const giant = "\\x00".repeat(LIMITS.maxDrawerBytes + 1);
    assert.throws(
        () => parseDrawerCommand(giant),
        (err) => err.code === ERR.DRAWER_COMMAND_TOO_LARGE,
    );
});

// -----------------------------------------------------------------------------
// Validación de connection + routing a transporte
// -----------------------------------------------------------------------------

test("validateConnectionForPrint: NETWORK requiere host y puerto válido", () => {
    assert.equal(validateConnectionForPrint({ interface: "NETWORK", network: { port: 9100 } }).code, ERR.MISSING_HOST);
    assert.equal(
        validateConnectionForPrint({ interface: "NETWORK", network: { host: "x", port: 0 } }).code,
        ERR.INVALID_PORT,
    );
    assert.deepEqual(
        validateConnectionForPrint({ interface: "NETWORK", network: { host: "10.0.0.5", port: 9100 } }),
        { ok: true },
    );
});

test("validateConnectionForPrint: SYSTEM requiere printerName", () => {
    assert.equal(
        validateConnectionForPrint({ interface: "SYSTEM", system: {} }).code,
        ERR.MISSING_PRINTER_NAME,
    );
    assert.deepEqual(
        validateConnectionForPrint({ interface: "SYSTEM", system: { printerName: "POS58" } }),
        { ok: true },
    );
});

test("validateConnectionForPrint: USB sin devicePath devuelve error accionable", () => {
    const r = validateConnectionForPrint({ interface: "USB", usb: {} });
    assert.equal(r.code, ERR.MISSING_USB_DEVICE_PATH);
    assert.match(r.message, /SYSTEM/);
});

test("pickTransport: USB con devicePath rutea por SYSTEM (compatibilidad documentada)", () => {
    const t = pickTransport({ interface: "USB", usb: { devicePath: "Impresora USB" } });
    assert.deepEqual(t, { kind: "system", printerName: "Impresora USB" });
});

test("pickTransport: NETWORK devuelve host/port saneados", () => {
    const t = pickTransport({ interface: "NETWORK", network: { host: "192.168.1.50", port: 9100 } });
    assert.deepEqual(t, { kind: "tcp", host: "192.168.1.50", port: 9100 });
});

// -----------------------------------------------------------------------------
// Receipt builder
// -----------------------------------------------------------------------------

test("buildReceiptBytes: siempre inicia con ESC @ + ESC t 2 (CP850)", () => {
    const buf = buildReceiptBytes({ ticketText: "hola\n", cut: "NONE", feedLines: 0 });
    assert.equal(buf[0], 0x1B);
    assert.equal(buf[1], 0x40); // ESC @
    assert.equal(buf[2], 0x1B);
    assert.equal(buf[3], 0x74); // ESC t
    assert.equal(buf[4], 0x02); // CP850
});

test("buildReceiptBytes: respeta cut=AUTO (añade GS V 0) y lo omite en MANUAL/NONE", () => {
    const auto = buildReceiptBytes({ ticketText: "x", cut: "AUTO", feedLines: 1 });
    const manual = buildReceiptBytes({ ticketText: "x", cut: "MANUAL", feedLines: 1 });
    const none = buildReceiptBytes({ ticketText: "x", cut: "NONE", feedLines: 1 });

    const hasFullCut = (b) => {
        for (let i = 0; i < b.length - 2; i++) {
            if (b[i] === 0x1D && b[i + 1] === 0x56 && b[i + 2] === 0x00) return true;
        }
        return false;
    };
    assert.equal(hasFullCut(auto), true, "AUTO debe emitir GS V 0");
    assert.equal(hasFullCut(manual), false, "MANUAL no debe cortar");
    assert.equal(hasFullCut(none), false, "NONE no debe cortar");
});

test("buildReceiptBytes: ticketText con ñ sobrevive hasta el byte 0xA4", () => {
    const buf = buildReceiptBytes({ ticketText: "Compró 2 kilos de ñame", cut: "NONE", feedLines: 0 });
    const ascii = Array.from(buf);
    assert.ok(ascii.includes(0xA4), "ñ debe aparecer como 0xA4 CP850");
    assert.ok(ascii.includes(0xA2), "ó debe aparecer como 0xA2 CP850");
});

// -----------------------------------------------------------------------------
// Label items normalization + batch builders
// -----------------------------------------------------------------------------

test("normalizeLabelItems: acepta payload unitario {code, productName, quantity}", () => {
    const items = normalizeLabelItems({ code: "ABC123", productName: "Leche", quantity: 3 });
    assert.equal(items.length, 1);
    assert.equal(items[0].code, "ABC123");
    assert.equal(items[0].productName, "Leche");
    assert.equal(items[0].quantity, 3);
});

test("normalizeLabelItems: acepta items[] y filtra códigos vacíos", () => {
    const items = normalizeLabelItems({ items: [
        { code: "", quantity: 2 },
        { code: "X1", quantity: 1 },
        { code: "X2", productName: " Producto\n ", quantity: 2 },
    ] });
    assert.equal(items.length, 2);
    assert.equal(items[1].productName, "Producto"); // control chars y trim
});

test("normalizeLabelItems: prefiere labelItems enriquecido sobre items de auditoría", () => {
    const items = normalizeLabelItems({
        items: [{ code: "X1", quantity: 2 }],
        labelItems: [{ code: "X1", productName: "ARROZ PREMIUM", salePrice: 12500, quantity: 2 }],
    });
    assert.deepEqual(items, [{
        code: "X1",
        productName: "ARROZ PREMIUM",
        salePrice: 12500,
        quantity: 2,
    }]);
});

test("normalizeLabelItems: rechaza payload con 0 items o estructura inválida", () => {
    assert.throws(() => normalizeLabelItems({ items: [] }), (e) => e.code === ERR.NO_LABELS);
    assert.throws(() => normalizeLabelItems({}), (e) => e.code === ERR.INVALID_REQUEST);
});

test("normalizeLabelItems: tope duro TOO_MANY_LABELS al superar maxLabelItems", () => {
    const items = new Array(LIMITS.maxLabelItems + 1).fill(null).map((_, i) => ({ code: `C${i}`, quantity: 1 }));
    assert.throws(() => normalizeLabelItems({ items }), (e) => e.code === ERR.TOO_MANY_LABELS);
});

test("buildLabelBytes: protocol=escpos emite CODE128 + feed y respeta quantity", () => {
    const buf = buildLabelBytes({
        protocol: "escpos",
        items: [{ code: "ABC123", productName: "ARROZ", salePrice: 2500, quantity: 2 }],
        labels: { barcode: { heightMm: 10 } },
    });
    // Debe contener GS k 73 (CODE128 long-form) al menos dos veces (una por tirada).
    let hits = 0;
    for (let i = 0; i < buf.length - 3; i++) {
        if (buf[i] === 0x1D && buf[i + 1] === 0x6B && buf[i + 2] === 73) hits++;
    }
    assert.equal(hits, 2, "ESC/POS batch debe generar un GS k por repetición");
});

test("buildLabelBytes: protocol=tspl emite SIZE/GAP/CLS/PRINT por fila (cantidades aplanadas)", () => {
    const buf = buildTsplBatch(
        [{ code: "X1\"inject", productName: 'A"B\\C', salePrice: 1000, quantity: 4 }],
        { widthMm: 50, heightMm: 30, sensor: { gapMm: 3 } },
    );
    const text = buf.toString("ascii");
    // SIZE sigue siendo el ancho del medio: 1 columna + margen 0 = 50mm.
    assert.match(text, /SIZE 50 mm, 30 mm/);
    assert.match(text, /GAP 3 mm, 0 mm/);
    // El nuevo contrato aplana cantidades: una fila por copia, PRINT 1,1 cada vez.
    const clsHits = text.match(/CLS/g) || [];
    const printHits = text.match(/PRINT 1,1/g) || [];
    assert.equal(clsHits.length, 4, "4 copias → 4 CLS");
    assert.equal(printHits.length, 4, "4 copias → 4 PRINT 1,1");
    // Escape: no deben aparecer comillas ni backslashes del texto arbitrario
    // en los campos embebidos.
    assert.ok(!text.includes("X1\"inject"), "El código no debe entrar sin escapar.");
    assert.ok(text.includes("X1inject"), "El código escapado debe seguir presente.");
    assert.ok(!/A"B/.test(text), "El nombre no debe filtrar comillas al TSPL.");
});

test("encodeBarcode128: filtra no-ASCII y antepone el selector obligatorio {B", () => {
    const buf = encodeBarcode128("CÓDIGO✓OK", 80);
    const commandIndex = buf.indexOf(Buffer.from([0x1D, 0x6B, 73]));
    assert.ok(commandIndex >= 0, "debe incluir el comando GS k 73");
    const declaredLength = buf[commandIndex + 3];
    const data = buf.subarray(commandIndex + 4);
    assert.equal(data.toString("ascii"), "{BCDIGOOK");
    assert.equal(declaredLength, data.length, "n debe incluir los bytes del selector {B");
    for (const byte of data) {
        assert.ok(byte >= 0x20 && byte <= 0x7E, `byte ${byte} fuera de ASCII imprimible`);
    }
});

test("encodeBarcode128: nunca corta a la mitad el escape de una llave literal", () => {
    const buf = encodeBarcode128("A".repeat(45) + "{" + "Z", 80);
    const commandIndex = buf.indexOf(Buffer.from([0x1D, 0x6B, 73]));
    const data = buf.subarray(commandIndex + 4).toString("ascii");
    assert.equal(data, `{B${"A".repeat(45)}`,
        "la llave que necesita dos bytes se omite si no cabe completa");
    assert.ok(!data.endsWith("{"), "nunca debe quedar un escape CODE128 incompleto");
});

// -----------------------------------------------------------------------------
// Test-page builders
// -----------------------------------------------------------------------------

test("buildTestPageReceipt: respeta columnas configuradas y usa CP850", () => {
    const buf = buildTestPageReceipt({ receipt: { columns: 32, cut: "AUTO" } });
    assert.equal(buf[0], 0x1B);
    assert.equal(buf[1], 0x40);
    // Debe contener "PAGINA DE PRUEBA" en ASCII dentro del cuerpo.
    assert.ok(buf.includes(Buffer.from("PAGINA DE PRUEBA", "ascii")));
});

test("buildTestPageLabel: devuelve TSPL si connection.protocol=tspl", () => {
    const buf = buildTestPageLabel({
        connection: { protocol: "tspl" },
        labels: { widthMm: 50, heightMm: 30, sensor: { gapMm: 3 } },
    });
    const text = buf.toString("ascii");
    assert.match(text, /SIZE 50 mm, 30 mm/);
    assert.match(text, /TESTBRIDGE/);
});

// -----------------------------------------------------------------------------
// Validación del request + handlePrinterRequest con transportes stubs
// -----------------------------------------------------------------------------

test("validatePrinterRequest: rechaza type incorrecto", () => {
    const r = validatePrinterRequest({ type: "other", requestId: "1", action: "print" });
    assert.equal(r.ok, false);
    assert.equal(r.code, ERR.INVALID_REQUEST);
});

test("validatePrinterRequest: exige requestId y acción conocida", () => {
    const r1 = validatePrinterRequest({ type: "printer.request", action: "print" });
    assert.equal(r1.code, ERR.INVALID_REQUEST);
    const r2 = validatePrinterRequest({ type: "printer.request", requestId: "x", action: "launch_missile" });
    assert.equal(r2.code, ERR.UNSUPPORTED_ACTION);
});

test("handlePrinterRequest: thermal-receipt → sendTcp con bytes ESC/POS", async () => {
    const { deps, calls } = makeStubDeps();
    const result = await handlePrinterRequest({
        requestId: "r1",
        action: "print",
        payload: {
            type: "thermal-receipt",
            ticketText: "Factura #42\nTotal: $1.000\n",
            cut: "AUTO",
            connection: { interface: "NETWORK", protocol: "escpos", network: { host: "10.0.0.5", port: 9100 } },
        },
    }, deps);
    assert.equal(result.ok, true);
    assert.equal(calls.tcp.length, 1);
    assert.equal(calls.system.length, 0);
    assert.equal(calls.tcp[0].host, "10.0.0.5");
    assert.equal(calls.tcp[0].port, 9100);
    // Debe empezar con ESC @ + ESC t 2
    assert.deepEqual(Array.from(calls.tcp[0].buf.subarray(0, 5)), [0x1B, 0x40, 0x1B, 0x74, 0x02]);
});

test("handlePrinterRequest: etiquetas → ruta SYSTEM si connection.interface=SYSTEM", async () => {
    const { deps, calls } = makeStubDeps();
    const result = await handlePrinterRequest({
        requestId: "r2",
        action: "print",
        payload: {
            items: [{ code: "P1", productName: "Producto", quantity: 1 }],
            connection: { interface: "SYSTEM", protocol: "escpos", system: { printerName: "POS80" } },
            labels: { widthMm: 50, heightMm: 30, barcode: { heightMm: 10 } },
        },
    }, deps);
    assert.equal(result.ok, true, result.error);
    assert.equal(calls.system.length, 1);
    assert.equal(calls.system[0].printerName, "POS80");
});

test("handlePrinterRequest: USB sin devicePath devuelve MISSING_USB_DEVICE_PATH sin tocar transportes", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "r3",
        action: "print",
        payload: {
            type: "thermal-receipt",
            ticketText: "x",
            connection: { interface: "USB", protocol: "escpos", usb: {} },
        },
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, ERR.MISSING_USB_DEVICE_PATH);
    assert.equal(calls.tcp.length, 0);
    assert.equal(calls.system.length, 0);
});

test("handlePrinterRequest: test-page delega a dispatchTestPage incluso por action='print'", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "r4",
        action: "print",
        payload: {
            type: "test-page",
            target: "receipt",
            config: {
                connection: { interface: "NETWORK", protocol: "escpos", network: { host: "127.0.0.1", port: 9100 } },
                receipt: { columns: 32, cut: "AUTO" },
            },
        },
    }, deps);
    assert.equal(r.ok, true, r.error);
    assert.equal(calls.tcp.length, 1);
    // El resultado debe informar la clasificación test-receipt.
    assert.equal(r.result.kind, "test-receipt");
});

test("handlePrinterRequest: kickDrawer parsea command literal y manda bytes por transporte configurado", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "r5",
        action: "kickDrawer",
        payload: {
            command: "\\x1B\\x70\\x00\\x19\\xFA",
            event: "MANUAL",
            connection: { interface: "SYSTEM", protocol: "escpos", system: { printerName: "POS58" } },
        },
    }, deps);
    assert.equal(r.ok, true);
    assert.equal(calls.system.length, 1);
    assert.deepEqual(Array.from(calls.system[0].buf), [0x1B, 0x70, 0x00, 0x19, 0xFA]);
});

test("handlePrinterRequest: kickDrawer con command inválido devuelve DRAWER_COMMAND_INVALID", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "r6",
        action: "kickDrawer",
        payload: {
            command: "ñ no printable",
            connection: { interface: "SYSTEM", protocol: "escpos", system: { printerName: "POS58" } },
        },
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, ERR.DRAWER_COMMAND_INVALID);
    assert.equal(calls.tcp.length, 0);
    assert.equal(calls.system.length, 0);
});

test("handlePrinterRequest: ticketText > maxTicketTextBytes es rechazado", async () => {
    const { deps, calls } = makeStubDeps();
    const big = "x".repeat(LIMITS.maxTicketTextBytes + 1);
    const r = await handlePrinterRequest({
        requestId: "r7",
        action: "print",
        payload: {
            type: "thermal-receipt",
            ticketText: big,
            connection: { interface: "NETWORK", protocol: "escpos", network: { host: "10.0.0.5", port: 9100 } },
        },
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, ERR.PAYLOAD_TOO_LARGE);
    assert.equal(calls.tcp.length, 0);
});

test("handlePrinterRequest: propaga errores TCP como errorCode TCP_TIMEOUT/TCP_ERROR", async () => {
    const { deps } = makeStubDeps({
        sendTcp: async () => {
            const err = new Error("TCP_TIMEOUT: 10.0.0.5:9100 no respondió");
            err.code = "TCP_TIMEOUT";
            throw err;
        },
    });
    const r = await handlePrinterRequest({
        requestId: "r8",
        action: "print",
        payload: {
            type: "thermal-receipt",
            ticketText: "hola",
            connection: { interface: "NETWORK", protocol: "escpos", network: { host: "10.0.0.5", port: 9100 } },
        },
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "TCP_TIMEOUT");
});

// -----------------------------------------------------------------------------
// isLocalOrigin
// -----------------------------------------------------------------------------

test("isLocalOrigin: acepta localhost, 127.0.0.1, LAN privada y file://", () => {
    assert.equal(isLocalOrigin(""), true);
    assert.equal(isLocalOrigin("null"), true);
    assert.equal(isLocalOrigin("http://localhost:3000"), true);
    assert.equal(isLocalOrigin("http://127.0.0.1"), true);
    assert.equal(isLocalOrigin("http://192.168.1.20:3000"), true);
    assert.equal(isLocalOrigin("http://10.0.0.4"), true);
    assert.equal(isLocalOrigin("http://172.16.5.5"), true);
    assert.equal(isLocalOrigin("file:///C:/pos/index.html"), true);
});

test("isLocalOrigin: rechaza orígenes públicos y protocolos extraños", () => {
    assert.equal(isLocalOrigin("https://evil.example.com"), false);
    assert.equal(isLocalOrigin("http://8.8.8.8"), false);
    assert.equal(isLocalOrigin("http://172.32.0.1"), false); // fuera de 172.16-31
    assert.equal(isLocalOrigin("gopher://1"), false);
});


// =============================================================================
// bridge-printing-v2 — tests nuevos: mmToDots, 2 columnas, EAN13, drawer events.
// =============================================================================

const {
    DRAWER_EVENTS,
    mmToDots,
    computeColumnOffsets,
    flattenLabelItems,
    buildRows,
    LABEL_PRESETS,
    DPI_203,
    PHYSICAL_MAX_MM,
    sanitizeEan13,
    computeEan13CheckDigit,
    encodeBarcodeEAN13,
    resolveAutoDrawerBytes,
} = require("../printer-bridge");

// --- mmToDots (203 dpi: 203/25.4 ≈ 8) ---------------------------------------

test("mmToDots(1, 203) = 8 (203/25.4 redondeado)", () => {
    assert.equal(mmToDots(1), 8);
    assert.equal(mmToDots(1, 203), 8);
});

test("mmToDots preserva 25.4mm = 203 dots exacto", () => {
    assert.equal(mmToDots(25.4), 203);
});

test("mmToDots: valores canónicos de etiquetas", () => {
    assert.equal(mmToDots(10), 80);   // alto típico de barcode
    assert.equal(mmToDots(30), 240);  // alto 30mm
    assert.equal(mmToDots(50), 400);  // ancho 50mm
    // 76 * 203 / 25.4 = 607.40 → redondea a 607 (no 608). Es la frontera
    // de 76mm imprimibles de la Jaltech JAL-838L.
    assert.equal(mmToDots(76), 607);
    // 82 * 203 / 25.4 = 655.35 → 655. Ancho físico de la JAL-838L.
    assert.equal(mmToDots(82), 655);
});

test("mmToDots: dpi override funciona (300 dpi)", () => {
    // 1 mm a 300 dpi = 300/25.4 = 11.81 → 12
    assert.equal(mmToDots(1, 300), 12);
    assert.equal(mmToDots(25.4, 300), 300);
});

test("mmToDots: entradas no numéricas devuelven 0", () => {
    assert.equal(mmToDots(null), 0);
    assert.equal(mmToDots(undefined), 0);
    assert.equal(mmToDots(NaN), 0);
    assert.equal(mmToDots("foo"), 0);
});

// --- Presets de etiqueta ----------------------------------------------------

test("LABEL_PRESETS: 50x30 es 1 columna con margen y gap razonables", () => {
    const p = LABEL_PRESETS["50x30"];
    assert.equal(p.widthMm, 50);
    assert.equal(p.heightMm, 30);
    assert.equal(p.columns, 1);
    assert.ok(p.marginLeftMm >= 0);
});

test("LABEL_PRESETS: 30x20-2col es 2 columnas con horizontalGap > 0", () => {
    const p = LABEL_PRESETS["30x20-2col"];
    assert.equal(p.columns, 2);
    assert.ok(p.horizontalGapMm > 0);
});

test("LABEL_PRESETS: todos los presets caben en 82mm físicos", () => {
    for (const [name, p] of Object.entries(LABEL_PRESETS)) {
        const totalMm = p.marginLeftMm + p.columns * p.widthMm + (p.columns - 1) * p.horizontalGapMm;
        assert.ok(totalMm <= PHYSICAL_MAX_MM + 0.5,
            `preset ${name} ocupa ${totalMm}mm > ${PHYSICAL_MAX_MM}mm`);
    }
});

// --- computeColumnOffsets ---------------------------------------------------

test("computeColumnOffsets: 1 columna con margen 2mm → offset 16 dots", () => {
    const r = computeColumnOffsets({ marginLeftMm: 2, labelWidthMm: 50, columns: 1 });
    assert.deepEqual(r.offsets, [16]);
    assert.equal(r.totalMm, 52);
    assert.ok(r.fits);
});

test("computeColumnOffsets: 2 columnas con margen 2 + ancho 30 + gap 2 → [16, 272]", () => {
    const r = computeColumnOffsets({
        marginLeftMm: 2,
        labelWidthMm: 30,
        horizontalGapMm: 2,
        columns: 2,
    });
    // Dots: margen 2*8=16, label 30*8=240, gap 2*8=16, offset col 2 = 16+240+16=272.
    assert.deepEqual(r.offsets, [16, 272]);
    // Total = 2 + 30 + 2 + 30 = 64 mm.
    assert.equal(r.totalMm, 64);
    assert.ok(r.fits);
});

test("computeColumnOffsets: 2 col que excede 82mm devuelve fits=false", () => {
    const r = computeColumnOffsets({
        marginLeftMm: 5,
        labelWidthMm: 50,
        horizontalGapMm: 5,
        columns: 2,
        // Sin printableWidthMm: cae a PHYSICAL_MAX_MM = 82mm.
    });
    // Total = 5 + 50 + 5 + 50 = 110 mm.
    assert.equal(r.totalMm, 110);
    assert.equal(r.fits, false);
    assert.equal(r.limitMm, PHYSICAL_MAX_MM);
});

test("computeColumnOffsets: 2 col que cabe en 76mm imprimible explícito", () => {
    const r = computeColumnOffsets({
        marginLeftMm: 2,
        labelWidthMm: 30,
        horizontalGapMm: 2,
        columns: 2,
        printableWidthMm: 76,
    });
    assert.equal(r.totalMm, 64);
    assert.equal(r.limitMm, 76);
    assert.ok(r.fits);
});

test("computeColumnOffsets: un valor exactamente en el límite sí cabe", () => {
    const r = computeColumnOffsets({
        marginLeftMm: 0,
        labelWidthMm: 76,
        columns: 1,
        printableWidthMm: 76,
    });
    assert.equal(r.totalMm, 76);
    assert.ok(r.fits);
});

// --- flattenLabelItems ------------------------------------------------------

test("flattenLabelItems: 3 copias de 2 items = 6 entradas con quantity=1", () => {
    const flat = flattenLabelItems([
        { code: "A", quantity: 3 },
        { code: "B", quantity: 3 },
    ]);
    assert.equal(flat.length, 6);
    assert.deepEqual(flat.map((it) => it.code), ["A", "A", "A", "B", "B", "B"]);
    for (const it of flat) assert.equal(it.quantity, 1);
});

test("buildRows: 5 items en 2 columnas = 3 filas (última de 1)", () => {
    const flat = [1, 2, 3, 4, 5].map((n) => ({ code: `C${n}`, quantity: 1 }));
    const rows = buildRows(flat, 2);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].length, 2);
    assert.equal(rows[2].length, 1);
});

// --- TSPL 2 columnas / aplanado + nombre y precio en ambas columnas --------

test("buildTsplBatch: 2 columnas → SIZE = ancho total del medio (no sólo etiqueta)", () => {
    const buf = buildTsplBatch(
        [
            { code: "A1", productName: "LECHE", salePrice: 3500, quantity: 1 },
            { code: "B2", productName: "PAN", salePrice: 2000, quantity: 1 },
        ],
        {
            widthMm: 30,
            heightMm: 20,
            columns: 2,
            horizontalGapMm: 2,
            marginLeftMm: 2,
            sensor: { gapMm: 2 },
            barcode: { symbology: "CODE128", heightMm: 8 },
        },
    );
    const text = buf.toString("ascii");
    // SIZE del medio = 2 + 30 + 2 + 30 = 64 mm (NO 30mm).
    assert.match(text, /SIZE 64 mm, 20 mm/);
    // GAP vertical sigue siendo el sensor.gapMm.
    assert.match(text, /GAP 2 mm, 0 mm/);
    // Dos items caben en UNA fila (2 col) → un CLS, un PRINT 1,1.
    const clsHits = text.match(/CLS/g) || [];
    const printHits = text.match(/PRINT 1,1/g) || [];
    assert.equal(clsHits.length, 1);
    assert.equal(printHits.length, 1);
    // Nombre y precio preservados en ambas columnas.
    assert.ok(text.includes("LECHE"), "nombre de col 1 presente");
    assert.ok(text.includes("PAN"), "nombre de col 2 presente");
    assert.ok(text.includes("$ 3.500"), "precio col 1 presente");
    assert.ok(text.includes("$ 2.000"), "precio col 2 presente");
});

test("buildTsplBatch: 2 columnas con cantidades aplanadas (qty=4 en 2 col = 2 filas)", () => {
    const buf = buildTsplBatch(
        [{ code: "A1", productName: "LECHE", salePrice: 3500, quantity: 4 }],
        {
            widthMm: 30,
            heightMm: 20,
            columns: 2,
            horizontalGapMm: 2,
            marginLeftMm: 2,
            sensor: { gapMm: 2 },
            barcode: { symbology: "CODE128", heightMm: 8 },
        },
    );
    const text = buf.toString("ascii");
    const printHits = text.match(/PRINT 1,1/g) || [];
    assert.equal(printHits.length, 2, "4 copias en 2 col → 2 filas × PRINT 1,1");
    // Cada fila lleva DOS items (ambas columnas), así que debe haber 4 TEXT con "LECHE"
    // (2 columnas × 2 filas).
    const nameHits = text.match(/"LECHE"/g) || [];
    assert.equal(nameHits.length, 4);
});

test("buildTsplBatch: offsets de columna respetan marginLeftDots + colIdx*(w+gap)", () => {
    const buf = buildTsplBatch(
        [
            { code: "A", productName: "X", quantity: 1 },
            { code: "B", productName: "Y", quantity: 1 },
        ],
        {
            widthMm: 30,
            heightMm: 20,
            columns: 2,
            horizontalGapMm: 2,
            marginLeftMm: 2,
            sensor: { gapMm: 2 },
            barcode: { symbology: "CODE128", heightMm: 8 },
        },
    );
    const text = buf.toString("ascii");
    // Dots: margen 16, col 2 base = 16 + 240 + 16 = 272.
    // El TEXT del nombre col 1 usa x=16+8=24 (1mm offset dentro de la etiqueta).
    assert.match(text, /TEXT 24,8,"3",0,1,1,"X"/);
    // El TEXT del nombre col 2 usa x=272+8=280.
    assert.match(text, /TEXT 280,8,"3",0,1,1,"Y"/);
});

test("buildTsplBatch: 1 columna con marginLeftMm > 0 corre todos los campos", () => {
    const buf = buildTsplBatch(
        [{ code: "ABC", productName: "ARROZ", quantity: 1 }],
        {
            widthMm: 50,
            heightMm: 30,
            columns: 1,
            marginLeftMm: 3,
            sensor: { gapMm: 3 },
            barcode: { symbology: "CODE128", heightMm: 10 },
        },
    );
    const text = buf.toString("ascii");
    // margen 3mm = 24 dots. El nombre tiene offset 1mm (8 dots) adentro.
    assert.match(text, /TEXT 32,8,"3",0,1,1,"ARROZ"/);
});

test("buildTsplBatch: layout.* del payload override los campos default", () => {
    const buf = buildTsplBatch(
        [{ code: "COD", productName: "PRD", salePrice: 1500, quantity: 1 }],
        {
            widthMm: 50,
            heightMm: 30,
            columns: 1,
            marginLeftMm: 0,
            sensor: { gapMm: 3 },
            layout: {
                productName: { xMm: 5, yMm: 2, font: "2", scaleX: 2, scaleY: 2 },
                salePrice:   { xMm: 5, yMm: 15, font: "3", scaleX: 1, scaleY: 1 },
                barcode:     { xMm: 2, yMm: 22, symbology: "CODE128", heightMm: 6, moduleWidth: 3, hri: false },
            },
        },
    );
    const text = buf.toString("ascii");
    // Nombre: x=5mm=40 dots, y=2mm=16, font=2, scale 2x2.
    assert.match(text, /TEXT 40,16,"2",0,2,2,"PRD"/);
    // Precio: x=5mm=40, y=15mm=120, font=3, scale 1x1.
    assert.match(text, /TEXT 40,120,"3",0,1,1,"\$ 1\.500"/);
    // Barcode: x=2mm=16, y=22mm=176, type 128, heightDots=48, hri=0, moduleWidth=3.
    assert.match(text, /BARCODE 16,176,"128",48,0,0,3,3,"COD"/);
});

test("buildTsplBatch: lanza LAYOUT_OUT_OF_BOUNDS cuando 2 col excede printableWidthMm", () => {
    assert.throws(
        () => buildTsplBatch(
            [{ code: "A", quantity: 1 }, { code: "B", quantity: 1 }],
            {
                widthMm: 50,
                heightMm: 30,
                columns: 2,
                horizontalGapMm: 5,
                marginLeftMm: 2,
                printableWidthMm: 76,
                sensor: { gapMm: 3 },
                barcode: { symbology: "CODE128", heightMm: 8 },
            },
        ),
        (err) => err.code === "LAYOUT_OUT_OF_BOUNDS",
    );
});

// --- EAN13 ------------------------------------------------------------------

test("computeEan13CheckDigit: calcula check de 7501000673209 (base 750100067320 → 9)", () => {
    assert.equal(computeEan13CheckDigit("750100067320"), 9);
});

test("sanitizeEan13: acepta 12 dígitos (el firmware calcula check)", () => {
    assert.equal(sanitizeEan13("750100067320"), "750100067320");
});

test("sanitizeEan13: acepta 13 dígitos cuando el check es correcto", () => {
    assert.equal(sanitizeEan13("7501000673209"), "7501000673209");
});

test("sanitizeEan13: rechaza 13 dígitos con check incorrecto", () => {
    // Última cifra errónea.
    assert.equal(sanitizeEan13("7501000673201"), null);
});

test("sanitizeEan13: rechaza longitudes distintas de 12/13", () => {
    assert.equal(sanitizeEan13("123"), null);
    assert.equal(sanitizeEan13("12345678901234"), null);
    assert.equal(sanitizeEan13(""), null);
});

test("sanitizeEan13: ignora caracteres no numéricos antes de validar", () => {
    // "750-100 067320" → "750100067320" (12 dígitos → ok).
    assert.equal(sanitizeEan13("750-100 067320"), "750100067320");
});

test("buildTsplBatch: BARCODE EAN13 cuando labels.barcode.symbology = EAN13", () => {
    const buf = buildTsplBatch(
        [{ code: "7501000673209", productName: "COLA", salePrice: 4500, quantity: 1 }],
        {
            widthMm: 50,
            heightMm: 30,
            columns: 1,
            marginLeftMm: 2,
            sensor: { gapMm: 3 },
            barcode: { symbology: "EAN13", heightMm: 10 },
        },
    );
    const text = buf.toString("ascii");
    assert.match(text, /BARCODE \d+,\d+,"EAN13",80,1,0,2,2,"7501000673209"/);
});

test("buildTsplBatch: EAN13 inválido lanza INVALID_BARCODE_EAN13", () => {
    assert.throws(
        () => buildTsplBatch(
            [{ code: "NO-DIGITS", quantity: 1 }],
            {
                widthMm: 50, heightMm: 30, columns: 1,
                marginLeftMm: 2, sensor: { gapMm: 3 },
                barcode: { symbology: "EAN13", heightMm: 10 },
            },
        ),
        (err) => err.code === "INVALID_BARCODE_EAN13",
    );
});

test("encodeBarcodeEAN13 (ESC/POS): genera GS k 67 con 12 ó 13 dígitos", () => {
    const buf = encodeBarcodeEAN13("7501000673209", 80);
    // Debe contener GS(0x1D) k(0x6B) m(67)
    const commandIndex = buf.indexOf(Buffer.from([0x1D, 0x6B, 67]));
    assert.ok(commandIndex >= 0, "debe incluir el comando GS k 67");
    const declaredLength = buf[commandIndex + 3];
    assert.equal(declaredLength, 13);
    const data = buf.subarray(commandIndex + 4, commandIndex + 4 + 13).toString("ascii");
    assert.equal(data, "7501000673209");
});

test("encodeBarcodeEAN13 (ESC/POS): código inválido devuelve buffer vacío", () => {
    const buf = encodeBarcodeEAN13("NO-DIGITS", 80);
    assert.equal(buf.length, 0);
});

// --- Recibo 80mm (48 cols) y 58mm (32 cols) --------------------------------

test("buildTestPageReceipt: 48 columnas (recibo 80mm) imprime encabezado centrado y CP850", () => {
    const buf = buildTestPageReceipt({ receipt: { columns: 48, cut: "AUTO", widthMm: 80 } });
    assert.equal(buf[0], 0x1B); // ESC
    assert.equal(buf[1], 0x40); // @
    assert.equal(buf[2], 0x1B);
    assert.equal(buf[3], 0x74); // t
    assert.equal(buf[4], 0x02); // CP850
    assert.ok(buf.includes(Buffer.from("PAGINA DE PRUEBA", "ascii")));
});

test("buildTestPageReceipt: 32 columnas (recibo 58mm) emite GS V 0 cuando cut=AUTO", () => {
    const buf = buildTestPageReceipt({ receipt: { columns: 32, cut: "AUTO", widthMm: 58 } });
    // GS V 0 (full cut) debe aparecer.
    let hasFullCut = false;
    for (let i = 0; i < buf.length - 2; i++) {
        if (buf[i] === 0x1D && buf[i + 1] === 0x56 && buf[i + 2] === 0x00) {
            hasFullCut = true; break;
        }
    }
    assert.ok(hasFullCut, "AUTO debe emitir GS V 0 incluso en 58mm");
});

test("buildTestPageReceipt: ancho CUSTOM se refleja en el header literal", () => {
    const buf = buildTestPageReceipt({ receipt: { columns: 32, cut: "AUTO", widthMm: 58 } });
    assert.ok(buf.includes(Buffer.from("58 mm", "ascii")));
    const buf80 = buildTestPageReceipt({ receipt: { columns: 48, cut: "AUTO", widthMm: 80 } });
    assert.ok(buf80.includes(Buffer.from("80 mm", "ascii")));
});

// --- buildTestPageLabel con presets y 2 columnas ---------------------------

test("buildTestPageLabel: preset 30x20-2col emite dos items con offsets de 2 columnas", () => {
    const buf = buildTestPageLabel({
        connection: { protocol: "tspl" },
        labels: {
            sizePreset: "30x20-2col",
            // Sin columns/widthMm/etc.: el preset los completa.
        },
    });
    const text = buf.toString("ascii");
    // SIZE del medio = 2 + 30 + 2 + 30 = 64 mm.
    assert.match(text, /SIZE 64 mm, 20 mm/);
    assert.match(text, /GAP 2 mm, 0 mm/);
    // Dos items distintos lado a lado en una sola fila.
    const printHits = text.match(/PRINT 1,1/g) || [];
    assert.equal(printHits.length, 1);
    assert.ok(text.includes("TEST-L"));
    assert.ok(text.includes("TEST-R"));
    assert.ok(text.includes("ETIQUETA IZQ"));
    assert.ok(text.includes("ETIQUETA DER"));
});

test("buildTestPageLabel: preset 50x30 (1 col) emite un solo item TESTBRIDGE", () => {
    const buf = buildTestPageLabel({
        connection: { protocol: "tspl" },
        labels: { sizePreset: "50x30" },
    });
    const text = buf.toString("ascii");
    assert.match(text, /SIZE 52 mm, 30 mm/); // margen 2 + 50mm label
    assert.ok(text.includes("TESTBRIDGE"));
    assert.ok(text.includes("ETIQUETA DE PRUEBA"));
    const printHits = text.match(/PRINT 1,1/g) || [];
    assert.equal(printHits.length, 1);
});

test("buildTestPageLabel: preset 76x50 cabe en el límite físico (82mm)", () => {
    const buf = buildTestPageLabel({
        connection: { protocol: "tspl" },
        labels: { sizePreset: "76x50" },
    });
    const text = buf.toString("ascii");
    // margen 3 + ancho 76 = 79mm total.
    assert.match(text, /SIZE 79 mm, 50 mm/);
});

// --- Drawer BEFORE/AFTER + openDrawerOnSale + MANUAL -----------------------

test("resolveAutoDrawerBytes: openDrawerOnSale=true + enabled + BEFORE_PRINT devuelve bytes", () => {
    const r = resolveAutoDrawerBytes({
        drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "BEFORE_PRINT" },
        openDrawerOnSale: true,
    });
    assert.ok(r);
    assert.equal(r.event, "BEFORE_PRINT");
    assert.deepEqual(Array.from(r.buf), [0x1B, 0x70, 0x00, 0x19, 0xFA]);
});

test("resolveAutoDrawerBytes: openDrawerOnSale=false NUNCA abre (reimpresión)", () => {
    const r = resolveAutoDrawerBytes({
        drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "AFTER_PRINT" },
        openDrawerOnSale: false,
    });
    assert.equal(r, null);
});

test("resolveAutoDrawerBytes: drawer.event=MANUAL nunca dispara automático", () => {
    const r = resolveAutoDrawerBytes({
        drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "MANUAL" },
        openDrawerOnSale: true,
    });
    assert.equal(r, null);
});

test("resolveAutoDrawerBytes: drawer.enabled=false nunca abre", () => {
    const r = resolveAutoDrawerBytes({
        drawer: { enabled: false, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "AFTER_PRINT" },
        openDrawerOnSale: true,
    });
    assert.equal(r, null);
});

test("resolveAutoDrawerBytes: command inválido se traga silencioso (recibo sale sin cajón)", () => {
    const r = resolveAutoDrawerBytes({
        // `\xZZ` no es hex válido → DRAWER_COMMAND_INVALID, debería suprimir
        // la apertura automática en vez de propagar el error al recibo.
        drawer: { enabled: true, command: "\\xZZ", event: "AFTER_PRINT" },
        openDrawerOnSale: true,
    });
    assert.equal(r, null);
});

test("resolveAutoDrawerBytes: payload.event ON_SALE_COMPLETE dispara coincidente con BEFORE_PRINT", () => {
    const r = resolveAutoDrawerBytes({
        drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "BEFORE_PRINT" },
        openDrawerOnSale: true,
        event: "ON_SALE_COMPLETE",
    });
    assert.ok(r);
    assert.equal(r.event, "BEFORE_PRINT");
});

test("resolveAutoDrawerBytes: payload.event desconocido no dispara", () => {
    const r = resolveAutoDrawerBytes({
        drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "AFTER_PRINT" },
        openDrawerOnSale: true,
        event: "QUIEN_SABE",
    });
    assert.equal(r, null);
});

// --- Recibo con drawer embebido ---------------------------------------------

test("buildReceiptBytes: BEFORE_PRINT embebe cajón ANTES del init ESC @", () => {
    const buf = buildReceiptBytes({
        ticketText: "VENTA 42\n",
        cut: "AUTO",
        openDrawerOnSale: true,
        drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "BEFORE_PRINT" },
    });
    // Primeros 5 bytes = pulso del cajón.
    assert.deepEqual(Array.from(buf.subarray(0, 5)), [0x1B, 0x70, 0x00, 0x19, 0xFA]);
    // Luego viene ESC @.
    assert.equal(buf[5], 0x1B);
    assert.equal(buf[6], 0x40);
});

test("buildReceiptBytes: AFTER_PRINT embebe cajón DESPUÉS del corte", () => {
    const buf = buildReceiptBytes({
        ticketText: "VENTA 42\n",
        cut: "AUTO",
        openDrawerOnSale: true,
        drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "AFTER_PRINT" },
    });
    // Debe terminar con los bytes del cajón.
    assert.deepEqual(Array.from(buf.subarray(buf.length - 5)), [0x1B, 0x70, 0x00, 0x19, 0xFA]);
    // Antes de los últimos 5 bytes debe estar GS V 0 (corte).
    assert.deepEqual(Array.from(buf.subarray(buf.length - 8, buf.length - 5)), [0x1D, 0x56, 0x00]);
});

test("buildReceiptBytes: SIN openDrawerOnSale no embebe cajón (reimpresión)", () => {
    const buf = buildReceiptBytes({
        ticketText: "VENTA 42\n",
        cut: "AUTO",
        drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "AFTER_PRINT" },
    });
    // No debe contener el pulso del cajón en ningún lado.
    const hex = Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.ok(!hex.includes("1b700019fa"),
        "una reimpresión (sin openDrawerOnSale) no abre el cajón");
});

test("buildReceiptBytes: drawer.event=MANUAL nunca abre automático aunque openDrawerOnSale=true", () => {
    const buf = buildReceiptBytes({
        ticketText: "VENTA 42\n",
        cut: "AUTO",
        openDrawerOnSale: true,
        drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "MANUAL" },
    });
    const hex = Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.ok(!hex.includes("1b700019fa"),
        "MANUAL nunca dispara automático desde el recibo");
});

// --- handlePrinterRequest: ruta thermal-receipt con drawer ------------------

test("handlePrinterRequest: thermal-receipt + openDrawerOnSale manda bytes de cajón", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "rd1",
        action: "print",
        payload: {
            type: "thermal-receipt",
            ticketText: "Total: $1.000\n",
            cut: "AUTO",
            openDrawerOnSale: true,
            drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "AFTER_PRINT" },
            connection: { interface: "NETWORK", protocol: "escpos", network: { host: "10.0.0.5", port: 9100 } },
        },
    }, deps);
    assert.equal(r.ok, true);
    assert.equal(calls.tcp.length, 1);
    const hex = Array.from(calls.tcp[0].buf).map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.ok(hex.includes("1b700019fa"));
});

test("handlePrinterRequest: reimpresión (sin openDrawerOnSale) nunca abre cajón", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "rd2",
        action: "print",
        payload: {
            type: "thermal-receipt",
            ticketText: "REIMPRESIÓN\n",
            cut: "AUTO",
            // No openDrawerOnSale.
            drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "AFTER_PRINT" },
            connection: { interface: "NETWORK", protocol: "escpos", network: { host: "10.0.0.5", port: 9100 } },
        },
    }, deps);
    assert.equal(r.ok, true);
    const hex = Array.from(calls.tcp[0].buf).map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.ok(!hex.includes("1b700019fa"), "reimpresión no debe disparar cajón");
});

// --- DRAWER_EVENTS constante ------------------------------------------------

test("DRAWER_EVENTS: expone los tres estados canónicos del frontend", () => {
    assert.equal(DRAWER_EVENTS.BEFORE_PRINT, "BEFORE_PRINT");
    assert.equal(DRAWER_EVENTS.AFTER_PRINT, "AFTER_PRINT");
    assert.equal(DRAWER_EVENTS.MANUAL, "MANUAL");
});

// --- Sanity: DPI y techo físico -------------------------------------------

test("DPI_203 y PHYSICAL_MAX_MM exponen las constantes físicas", () => {
    assert.equal(DPI_203, 203);
    assert.equal(PHYSICAL_MAX_MM, 82);
});


// --- dispatchKickDrawer: ruta automática aplica resolveAutoDrawerBytes -------

test("handlePrinterRequest kickDrawer automático BEFORE envía exactamente un pulso", async () => {
    const { deps, calls } = makeStubDeps();
    const result = await handlePrinterRequest({
        requestId: "kick-auto-before",
        action: "kickDrawer",
        payload: {
            connection: { interface: "NETWORK", network: { host: "10.0.0.5", port: 9100 } },
            drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "BEFORE_PRINT" },
            event: "BEFORE_PRINT",
            openDrawerOnSale: true,
        },
    }, deps);
    assert.equal(result.ok, true);
    assert.equal(calls.tcp.length, 1, "una venta debe producir exactamente un envío físico");
    assert.deepEqual(Array.from(calls.tcp[0].buf), [0x1B, 0x70, 0x00, 0x19, 0xFA]);
});

test("handlePrinterRequest kickDrawer automático MANUAL se omite sin enviar bytes", async () => {
    const { deps, calls } = makeStubDeps();
    const result = await handlePrinterRequest({
        requestId: "kick-auto-manual",
        action: "kickDrawer",
        payload: {
            connection: { interface: "NETWORK", network: { host: "10.0.0.5", port: 9100 } },
            drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "MANUAL" },
            event: "MANUAL",
            openDrawerOnSale: true,
        },
    }, deps);
    assert.equal(result.ok, true);
    assert.equal(result.result.skipped, true);
    assert.equal(calls.tcp.length, 0, "MANUAL nunca debe producir un pulso automático");
});

test("handlePrinterRequest kickDrawer manual de admin sigue enviando sin flag de venta", async () => {
    const { deps, calls } = makeStubDeps();
    const result = await handlePrinterRequest({
        requestId: "kick-admin-manual",
        action: "kickDrawer",
        payload: {
            connection: { interface: "NETWORK", network: { host: "10.0.0.5", port: 9100 } },
            command: "\\x1B\\x70\\x00\\x19\\xFA",
            drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: "MANUAL" },
        },
    }, deps);
    assert.equal(result.ok, true);
    assert.equal(calls.tcp.length, 1, "el botón admin explícito conserva la apertura manual");
});


// =============================================================================
// bridge-printing-v3 — shelf-labels (hoja térmica de góndola)
//
// Cubre el routing nuevo en `dispatchPrint` (type:"shelf-labels") y en
// `dispatchTestPage` (target:"shelf"), incluyendo:
//   * UNSUPPORTED_PROTOCOL para protocolos distintos a TSPL.
//   * NO_LABELS cuando items está vacío.
//   * LAYOUT_OUT_OF_BOUNDS con widthMm > 82.
//   * INVALID_SHELF_CONFIG en test-page cuando gondola.thermal falta.
//   * GARANTÍA DURA: aunque el payload traiga drawer + openDrawerOnSale,
//     el output es BYTE-IDÉNTICO al mismo payload sin drawer.
// =============================================================================

const {
    buildTsplShelfLabelsDocument,
    SHELF_THERMAL_DEFAULTS,
} = require("../printer-bridge");

function shelfPayload(overrides = {}) {
    return {
        type: "shelf-labels",
        connection: {
            interface: "NETWORK",
            protocol: "tspl",
            network: { host: "10.0.0.5", port: 9100 },
        },
        thermal: SHELF_THERMAL_DEFAULTS,
        items: [{ code: "LBL-001", productName: "AZUCAR", salePrice: 3500, quantity: 2 }],
        nowIso: "2026-10-19T14:16:00",
        ...overrides,
    };
}

// --- OK path: TSPL + items válidos → sendTcp con bytes de shelf-labels ----

test("dispatchPrint shelf-labels: protocol=tspl + items válidos → sendTcp con TSPL", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "sh-ok",
        action: "print",
        payload: shelfPayload(),
    }, deps);
    assert.equal(r.ok, true, r.error);
    assert.equal(calls.tcp.length, 1);
    assert.equal(calls.system.length, 0);
    assert.equal(r.result.kind, "shelf-labels");
    const text = calls.tcp[0].buf.toString("ascii");
    assert.match(text, /SIZE 80 mm, 40 mm/);
    assert.match(text, /GAP 0 mm, 0 mm/);
    assert.match(text, /DIRECTION 0,0/);
    // 2 copias (quantity 2) = 2 PRINT 1,1.
    assert.equal((text.match(/PRINT 1,1/g) || []).length, 2);
    // Y nunca inicia con ESC @ (no es ESC/POS).
    assert.ok(!(calls.tcp[0].buf[0] === 0x1B && calls.tcp[0].buf[1] === 0x40));
});

test("dispatchPrint shelf-labels: SYSTEM + TSPL → sendSystem", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "sh-sys",
        action: "print",
        payload: shelfPayload({
            connection: {
                interface: "SYSTEM",
                protocol: "tspl",
                system: { printerName: "POS-SHELF" },
            },
        }),
    }, deps);
    assert.equal(r.ok, true, r.error);
    assert.equal(calls.tcp.length, 0);
    assert.equal(calls.system.length, 1);
    assert.equal(calls.system[0].printerName, "POS-SHELF");
});

// --- Protocolo distinto a TSPL → UNSUPPORTED_PROTOCOL ----------------------

test("dispatchPrint shelf-labels: protocol=escpos → UNSUPPORTED_PROTOCOL sin tocar transporte", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "sh-escpos",
        action: "print",
        payload: shelfPayload({
            connection: {
                interface: "NETWORK",
                protocol: "escpos",
                network: { host: "10.0.0.5", port: 9100 },
            },
        }),
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, ERR.UNSUPPORTED_PROTOCOL);
    assert.equal(calls.tcp.length, 0);
    assert.equal(calls.system.length, 0);
});

test("dispatchPrint shelf-labels: protocol=zpl → UNSUPPORTED_PROTOCOL", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "sh-zpl",
        action: "print",
        payload: shelfPayload({
            connection: {
                interface: "NETWORK",
                protocol: "zpl",
                network: { host: "10.0.0.5", port: 9100 },
            },
        }),
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, ERR.UNSUPPORTED_PROTOCOL);
    assert.equal(calls.tcp.length, 0);
});

// --- NO_LABELS cuando items vacío ------------------------------------------

test("dispatchPrint shelf-labels: items vacío → NO_LABELS", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "sh-empty",
        action: "print",
        payload: shelfPayload({ items: [] }),
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, ERR.NO_LABELS);
    assert.equal(calls.tcp.length, 0);
});

// --- LAYOUT_OUT_OF_BOUNDS cuando widthMm > 82 ------------------------------

test("dispatchPrint shelf-labels: thermal.widthMm=100 → LAYOUT_OUT_OF_BOUNDS", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "sh-oob",
        action: "print",
        payload: shelfPayload({
            thermal: { ...SHELF_THERMAL_DEFAULTS, widthMm: 100 },
        }),
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "LAYOUT_OUT_OF_BOUNDS");
    assert.equal(calls.tcp.length, 0);
});

// --- GARANTÍA DURA: ningún pulso de cajón en shelf-labels ------------------

test("dispatchPrint shelf-labels: drawer+openDrawerOnSale produce output IDÉNTICO al sin drawer", async () => {
    // Payload base sin drawer.
    const basePayload = shelfPayload();
    const sinDrawer = makeStubDeps();
    const rNoDrawer = await handlePrinterRequest({
        requestId: "sh-nodrawer",
        action: "print",
        payload: basePayload,
    }, sinDrawer.deps);
    assert.equal(rNoDrawer.ok, true);
    const bufNo = sinDrawer.calls.tcp[0].buf;

    // Mismo payload PERO con drawer + openDrawerOnSale.
    const conDrawer = makeStubDeps();
    const rWithDrawer = await handlePrinterRequest({
        requestId: "sh-withdrawer",
        action: "print",
        payload: {
            ...basePayload,
            openDrawerOnSale: true,
            drawer: {
                enabled: true,
                command: "\\x1B\\x70\\x00\\x19\\xFA",
                event: "AFTER_PRINT",
            },
        },
    }, conDrawer.deps);
    assert.equal(rWithDrawer.ok, true);
    const bufWith = conDrawer.calls.tcp[0].buf;

    // GARANTÍA DURA: los bytes son exactamente idénticos.
    assert.ok(bufNo.equals(bufWith),
        "shelf-labels NUNCA debe variar los bytes por drawer/openDrawerOnSale");
    // Y jamás contiene los bytes del pulso del cajón.
    const hex = Array.from(bufWith).map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.ok(!hex.includes("1b700019fa"),
        "shelf-labels nunca debe incluir ESC p 0 (abrir cajón)");
});

// --- Error TCP se propaga -------------------------------------------------

test("dispatchPrint shelf-labels: TCP_TIMEOUT se propaga como errorCode accionable", async () => {
    const { deps } = makeStubDeps({
        sendTcp: async () => {
            const err = new Error("TCP_TIMEOUT: 10.0.0.5:9100 no respondió");
            err.code = "TCP_TIMEOUT";
            throw err;
        },
    });
    const r = await handlePrinterRequest({
        requestId: "sh-timeout",
        action: "print",
        payload: shelfPayload(),
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "TCP_TIMEOUT");
});

// --- test-page target=shelf ------------------------------------------------

test("dispatchTestPage target=shelf: protocol=tspl + gondola.thermal → TSPL con TEST-SHELF", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "ts-shelf",
        action: "printTestPage",
        payload: {
            target: "shelf",
            config: {
                connection: {
                    interface: "NETWORK",
                    protocol: "tspl",
                    network: { host: "10.0.0.5", port: 9100 },
                },
                gondola: {
                    format: "THERMAL_80",
                    thermal: SHELF_THERMAL_DEFAULTS,
                },
            },
        },
    }, deps);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.result.kind, "test-shelf");
    assert.equal(calls.tcp.length, 1);
    const text = calls.tcp[0].buf.toString("ascii");
    assert.match(text, /SIZE 80 mm, 40 mm/);
    assert.ok(text.includes("TEST-SHELF"), "la etiqueta de prueba lleva el código TEST-SHELF");
});

test("dispatchTestPage target=shelf: sin gondola.thermal → INVALID_SHELF_CONFIG", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "ts-no-thermal",
        action: "printTestPage",
        payload: {
            target: "shelf",
            config: {
                connection: {
                    interface: "NETWORK",
                    protocol: "tspl",
                    network: { host: "10.0.0.5", port: 9100 },
                },
                // Sin gondola.thermal.
            },
        },
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, ERR.INVALID_SHELF_CONFIG);
    assert.equal(calls.tcp.length, 0);
});

test("dispatchTestPage target=shelf: protocol=escpos → UNSUPPORTED_PROTOCOL", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "ts-shelf-escpos",
        action: "printTestPage",
        payload: {
            target: "shelf",
            config: {
                connection: {
                    interface: "NETWORK",
                    protocol: "escpos",
                    network: { host: "10.0.0.5", port: 9100 },
                },
                gondola: { format: "THERMAL_80", thermal: SHELF_THERMAL_DEFAULTS },
            },
        },
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, ERR.UNSUPPORTED_PROTOCOL);
    assert.equal(calls.tcp.length, 0);
});

test("dispatchTestPage target=shelf: thermal con widthMm fuera de rango propaga LAYOUT_OUT_OF_BOUNDS", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "ts-shelf-oob",
        action: "printTestPage",
        payload: {
            target: "shelf",
            config: {
                connection: {
                    interface: "NETWORK",
                    protocol: "tspl",
                    network: { host: "10.0.0.5", port: 9100 },
                },
                gondola: {
                    format: "THERMAL_80",
                    thermal: { ...SHELF_THERMAL_DEFAULTS, widthMm: 150 },
                },
            },
        },
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "LAYOUT_OUT_OF_BOUNDS");
    assert.equal(calls.tcp.length, 0);
});

// --- Reexport del renderer para integración directa ------------------------

test("printer-bridge reexporta buildTsplShelfLabelsDocument y SHELF_THERMAL_DEFAULTS", () => {
    assert.equal(typeof buildTsplShelfLabelsDocument, "function");
    assert.ok(SHELF_THERMAL_DEFAULTS && typeof SHELF_THERMAL_DEFAULTS === "object");
    assert.equal(SHELF_THERMAL_DEFAULTS.widthMm, 80);
});

// --- Payload compat: labelItems preferido sobre items ----------------------

test("dispatchPrint shelf-labels: labelItems enriquecido gana sobre items reducido", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "sh-labelitems",
        action: "print",
        payload: shelfPayload({
            items: [{ code: "C1", quantity: 2 }],
            labelItems: [{ code: "C1", productName: "ARROZ PREMIUM", salePrice: 12500, quantity: 2 }],
        }),
    }, deps);
    assert.equal(r.ok, true, r.error);
    const text = calls.tcp[0].buf.toString("ascii");
    assert.ok(text.includes("ARROZ PREMIUM"), "el nombre debe venir del labelItems enriquecido");
    assert.ok(text.includes("12.500"), "el precio debe venir del labelItems enriquecido");
});

// --- Reimpresión / audit: no se mezcla con otros kinds ---------------------

test("dispatchPrint shelf-labels: kind del resultado es 'shelf-labels' (nunca 'labels' ni 'receipt')", async () => {
    const { deps } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "sh-kind",
        action: "print",
        payload: shelfPayload(),
    }, deps);
    assert.equal(r.ok, true);
    assert.equal(r.result.kind, "shelf-labels");
});
