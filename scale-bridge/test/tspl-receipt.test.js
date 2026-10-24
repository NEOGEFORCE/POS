// =============================================================================
// test/tspl-receipt.test.js
//
// Suite `node --test` para `buildTsplReceiptDocument` y la integración con
// `handlePrinterRequest` (bridge-printing-v2 §D y §E).
//
// Cubre:
//
//   1. SIZE dinámico derivado de `receipt.widthMm` y de la cantidad de
//      líneas del texto. GAP 0 mm, 0 mm SIEMPRE (papel continuo).
//   2. Escape de `"`, `\`, chars de control y non-ASCII dentro del texto
//      embebido en `TEXT ...`.
//   3. Clamp y errores accionables: widthMm > 82 → LAYOUT_OUT_OF_BOUNDS;
//      widthMm < 20 → INVALID_RECEIPT_CONFIG.
//   4. Fuente dinámica por columnas: 32 cols → font "2"; 48 cols → font "3".
//   5. CUT final sólo cuando `receipt.cut === "AUTO"`.
//   6. Integración vía `handlePrinterRequest` con `connection.protocol`:
//        - `escpos`  → bytes ESC/POS (comportamiento histórico, no regresa).
//        - `tspl`    → bytes TSPL (sendTcp o sendSystem según interface).
//        - `pdf`     → UNSUPPORTED_PAYLOAD_TYPE sin tocar transportes.
//   7. test-page (target="receipt") sigue la MISMA rama de protocolo
//      que `thermal-receipt`.
//
// Todos los transportes se inyectan como stubs: ningún socket real.
// =============================================================================

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    ERR,
    buildTsplReceiptDocument,
    buildTsplReceiptBytes,
    buildTsplTestPageReceipt,
    handlePrinterRequest,
    escapeForTspl,
    tsplLineHeightMm,
    pickTsplReceiptFont,
    pickTsplReceiptColumns,
    RECEIPT_TSPL_LIMITS,
    PHYSICAL_MAX_MM,
    TSPL_FONT_METRICS,
    TSPL_RECEIPT_FONT_LADDER,
} = require("../printer-bridge");

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
// A. buildTsplReceiptDocument — puro
// -----------------------------------------------------------------------------

test("buildTsplReceiptDocument: emite SIZE con widthMm literal y heightMm > 0", () => {
    const buf = buildTsplReceiptDocument({
        ticketText: "Linea 1\nLinea 2\nLinea 3",
        receipt: { widthMm: 80, columns: 48, cut: "NONE" },
        escapeFn: escapeForTspl,
    });
    const text = buf.toString("ascii");
    // SIZE con widthMm 80 y heightMm numérico (varía por fuente/escala, pero > minHeightMm).
    const sizeMatch = text.match(/SIZE 80 mm, (\d+(?:\.\d+)?) mm/);
    assert.ok(sizeMatch, "debe aparecer 'SIZE 80 mm, <h> mm'");
    const heightMm = Number(sizeMatch[1]);
    assert.ok(heightMm >= RECEIPT_TSPL_LIMITS.minHeightMm,
        `heightMm (${heightMm}) debe ser >= ${RECEIPT_TSPL_LIMITS.minHeightMm}`);
    assert.ok(heightMm <= RECEIPT_TSPL_LIMITS.maxHeightMm);
});

test("buildTsplReceiptDocument: GAP 0 mm, 0 mm SIEMPRE (papel continuo)", () => {
    for (const w of [58, 80, 82]) {
        const buf = buildTsplReceiptDocument({
            ticketText: "x",
            receipt: { widthMm: w, columns: 32 },
            escapeFn: escapeForTspl,
        });
        const text = buf.toString("ascii");
        assert.match(text, /GAP 0 mm, 0 mm/,
            `GAP 0 mm,0 mm debe aparecer para widthMm=${w}`);
        // Y NO debe aparecer un GAP != 0 (sensor de etiquetas no aplica).
        assert.ok(!/GAP [1-9]\d* mm/.test(text),
            `no debe emitir GAP != 0 para recibos (widthMm=${w})`);
    }
});

test("buildTsplReceiptDocument: emite DIRECTION 0,0, REFERENCE 0,0, DENSITY 8, CLS", () => {
    const buf = buildTsplReceiptDocument({
        ticketText: "hola",
        receipt: { widthMm: 80, columns: 48 },
        escapeFn: escapeForTspl,
    });
    const text = buf.toString("ascii");
    assert.match(text, /DIRECTION 0,0/);
    assert.match(text, /REFERENCE 0,0/);
    assert.match(text, /DENSITY 8/);
    assert.match(text, /^.*\r\nGAP 0 mm, 0 mm\r\nDIRECTION 0,0\r\nREFERENCE 0,0\r\nDENSITY 8\r\nCLS\r\n/s);
});

test("buildTsplReceiptDocument: termina con PRINT 1,1 (y CUT sólo si cut=AUTO)", () => {
    const auto = buildTsplReceiptDocument({
        ticketText: "x",
        receipt: { widthMm: 80, columns: 48, cut: "AUTO" },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    const manual = buildTsplReceiptDocument({
        ticketText: "x",
        receipt: { widthMm: 80, columns: 48, cut: "MANUAL" },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    const none = buildTsplReceiptDocument({
        ticketText: "x",
        receipt: { widthMm: 80, columns: 48, cut: "NONE" },
        escapeFn: escapeForTspl,
    }).toString("ascii");

    assert.match(auto, /PRINT 1,1\r\nCUT\r\n$/, "AUTO debe emitir PRINT seguido de CUT");
    assert.match(manual, /PRINT 1,1\r\n$/, "MANUAL no emite CUT");
    assert.ok(!/CUT\r\n$/.test(manual));
    assert.match(none, /PRINT 1,1\r\n$/, "NONE no emite CUT");
});

test("buildTsplReceiptDocument: altura crece con el número de líneas", () => {
    const short = buildTsplReceiptDocument({
        ticketText: "una linea",
        receipt: { widthMm: 80, columns: 48 },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    const long = buildTsplReceiptDocument({
        ticketText: Array(50).fill("linea").join("\n"),
        receipt: { widthMm: 80, columns: 48 },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    const h1 = Number(short.match(/SIZE 80 mm, (\d+(?:\.\d+)?) mm/)[1]);
    const h2 = Number(long.match(/SIZE 80 mm, (\d+(?:\.\d+)?) mm/)[1]);
    assert.ok(h2 > h1, `50 líneas debe producir mayor alto (${h2}) que 1 línea (${h1})`);
});

test("buildTsplReceiptDocument: heightMm se tope a maxHeightMm con texto gigantesco", () => {
    const giant = Array(10000).fill("x").join("\n");
    const buf = buildTsplReceiptDocument({
        ticketText: giant,
        receipt: { widthMm: 80, columns: 48 },
        escapeFn: escapeForTspl,
    });
    const sizeMatch = buf.toString("ascii").match(/SIZE 80 mm, (\d+(?:\.\d+)?) mm/);
    const heightMm = Number(sizeMatch[1]);
    assert.equal(heightMm, RECEIPT_TSPL_LIMITS.maxHeightMm,
        "altura debe clamp a maxHeightMm, no debe explotar");
});

// -----------------------------------------------------------------------------
// B. Escape: inyección imposible
// -----------------------------------------------------------------------------

test('buildTsplReceiptDocument: elimina `"` del ticketText (TSPL rompería)', () => {
    const buf = buildTsplReceiptDocument({
        ticketText: 'HOLA " MUNDO "\nX',
        receipt: { widthMm: 80, columns: 48 },
        escapeFn: escapeForTspl,
    });
    const text = buf.toString("ascii");
    // La única comilla permitida es la que envuelve el campo del TEXT.
    // Por lo tanto, dentro de los pares de comillas del TEXT no debe haber comillas.
    // Extraemos TODAS las sub-cadenas tipo `TEXT ...,"..."` y verificamos su campo final.
    const textMatches = text.match(/TEXT [^\n\r]+/g) || [];
    assert.ok(textMatches.length > 0);
    for (const line of textMatches) {
        // Formato: TEXT x,y,"font",rot,sx,sy,"CONTENT"
        // El CONTENT va entre las ÚLTIMAS dos comillas, y adentro no debe haber `"`.
        const contentMatch = line.match(/TEXT \d+,\d+,"[^"]+",\d+,\d+,\d+,"([^"]*)"/);
        assert.ok(contentMatch, `TEXT mal formado: ${line}`);
        assert.ok(!contentMatch[1].includes('"'),
            `comilla dentro de TEXT content: ${contentMatch[1]}`);
    }
    // El carácter " nunca debe estar sin escapar fuera de los delimitadores TSPL.
    // Como aquí lo removimos del content, el ticketText original "HOLA MUNDO" aparece sin "s.
    assert.ok(text.includes("HOLA  MUNDO "), "contenido se preserva sin la comilla");
});

test("buildTsplReceiptDocument: elimina backslash del ticketText", () => {
    const buf = buildTsplReceiptDocument({
        ticketText: "C:\\path\\to\\file",
        receipt: { widthMm: 80, columns: 48 },
        escapeFn: escapeForTspl,
    });
    const text = buf.toString("ascii");
    const contentMatch = text.match(/TEXT \d+,\d+,"[^"]+",\d+,\d+,\d+,"([^"]*)"/);
    assert.ok(contentMatch);
    assert.ok(!contentMatch[1].includes("\\"),
        "backslash no debe aparecer dentro de TEXT content");
    assert.equal(contentMatch[1], "C:pathtofile");
});

test("buildTsplReceiptDocument: elimina chars de control (0x00-0x1F, 0x7F)", () => {
    const buf = buildTsplReceiptDocument({
        ticketText: "A\x00B\x07C\x1BD\x7FE",
        receipt: { widthMm: 80, columns: 48 },
        escapeFn: escapeForTspl,
    });
    const text = buf.toString("ascii");
    const contentMatch = text.match(/TEXT \d+,\d+,"[^"]+",\d+,\d+,\d+,"([^"]*)"/);
    assert.ok(contentMatch);
    assert.equal(contentMatch[1], "ABCDE", "control chars eliminados");
    // Y no debe haber bytes raros en el buffer final (puro ASCII imprimible + CRLF).
    for (const b of buf) {
        const ok = (b >= 0x20 && b <= 0x7E) || b === 0x0D || b === 0x0A;
        assert.ok(ok, `byte 0x${b.toString(16)} fuera del ASCII imprimible / CRLF`);
    }
});

test("buildTsplReceiptDocument: translitera non-ASCII (ñ → n, á → a) antes de embeber", () => {
    const buf = buildTsplReceiptDocument({
        ticketText: "José compró ñame — €",
        receipt: { widthMm: 80, columns: 48 },
        escapeFn: escapeForTspl,
    });
    const text = buf.toString("ascii");
    assert.match(text, /Jose compro name/);
    // Toda la salida es ASCII puro.
    for (const b of buf) {
        assert.ok(b <= 0x7E, `byte non-ASCII 0x${b.toString(16)} filtrado al TSPL`);
    }
});

test("buildTsplReceiptDocument: líneas vacías se saltan sin romper TSPL", () => {
    const buf = buildTsplReceiptDocument({
        ticketText: "A\n\n\nB",
        receipt: { widthMm: 80, columns: 48 },
        escapeFn: escapeForTspl,
    });
    const text = buf.toString("ascii");
    const texts = text.match(/TEXT [^\n\r]+/g) || [];
    // Solo "A" y "B" deben emitir TEXT.
    assert.equal(texts.length, 2);
    // Pero el `y` de "B" debe reflejar las 3 líneas vacías que avanzaron.
    const yA = Number(texts[0].match(/TEXT \d+,(\d+),/)[1]);
    const yB = Number(texts[1].match(/TEXT \d+,(\d+),/)[1]);
    assert.ok(yB > yA, "y de B debe estar debajo de y de A");
});

// -----------------------------------------------------------------------------
// C. Clamps y errores accionables
// -----------------------------------------------------------------------------

test("buildTsplReceiptDocument: widthMm > PHYSICAL_MAX_MM lanza LAYOUT_OUT_OF_BOUNDS", () => {
    assert.throws(
        () => buildTsplReceiptDocument({
            ticketText: "x",
            receipt: { widthMm: PHYSICAL_MAX_MM + 1, columns: 48 },
            escapeFn: escapeForTspl,
        }),
        (err) => err.code === "LAYOUT_OUT_OF_BOUNDS",
    );
});

test("buildTsplReceiptDocument: widthMm < 20 lanza INVALID_RECEIPT_CONFIG", () => {
    assert.throws(
        () => buildTsplReceiptDocument({
            ticketText: "x",
            receipt: { widthMm: 19, columns: 32 },
            escapeFn: escapeForTspl,
        }),
        (err) => err.code === "INVALID_RECEIPT_CONFIG",
    );
});

test("buildTsplReceiptDocument: columns < min lanza INVALID_RECEIPT_CONFIG", () => {
    assert.throws(
        () => buildTsplReceiptDocument({
            ticketText: "x",
            receipt: { widthMm: 80, columns: 5 },
            escapeFn: escapeForTspl,
        }),
        (err) => err.code === "INVALID_RECEIPT_CONFIG",
    );
});

test("buildTsplReceiptDocument: widthMm no numérico cae a default 80 (fallback robusto)", () => {
    // Un string no numérico NO rompe el renderer — cae al default (80 mm) para
    // que una entrada corrupta de localStorage no bloquee la impresión.
    // La validación estricta vive en el frontend (`validatePrintingConfig`),
    // aquí defendemos en profundidad.
    const buf = buildTsplReceiptDocument({
        ticketText: "x",
        receipt: { widthMm: "ocho", columns: 48 },
        escapeFn: escapeForTspl,
    });
    assert.match(buf.toString("ascii"), /SIZE 80 mm,/);
});

test("buildTsplReceiptDocument: escapeFn no función lanza INVALID_RECEIPT_CONFIG", () => {
    assert.throws(
        () => buildTsplReceiptDocument({
            ticketText: "x",
            receipt: { widthMm: 80, columns: 48 },
            // escapeFn omitido a propósito.
        }),
        (err) => err.code === "INVALID_RECEIPT_CONFIG",
    );
});

test("buildTsplReceiptDocument: widthMm exactamente 82 cabe (frontera)", () => {
    const buf = buildTsplReceiptDocument({
        ticketText: "x",
        receipt: { widthMm: 82, columns: 48, cut: "AUTO" },
        escapeFn: escapeForTspl,
    });
    assert.match(buf.toString("ascii"), /SIZE 82 mm/);
});

// -----------------------------------------------------------------------------
// D. Fuente derivada de columnas Y DEL ANCHO IMPRIMIBLE
//
// bridge-printing-v3: la selección automática mira el presupuesto en dots
// (printableWidthMm - leftMarginMm) * scaleX contra el ancho real del
// glifo de cada fuente built-in TSPL. Esto reemplaza el mapeo columns→font
// anterior (32→"2", 48→"3") que no consideraba el ancho real y producía
// recorte derecho visible en el ticket impreso.
// -----------------------------------------------------------------------------

test("pickTsplReceiptFont: elige la fuente más legible que quepa en printableWidthMm", () => {
    // 58 físico / 48 imprimible / 32 cols → font "1" (12*32=384 no cabe en
    // ~372 dots disponibles; solo font 1 con 8*32=256 pasa).
    assert.equal(
        pickTsplReceiptFont({ columns: 32, printableWidthMm: 48, leftMarginMm: 1.5, scaleX: 1 }),
        "1",
    );
    // 80 físico / 76 imprimible / 48 cols → font "2" (16*48=768 no cabe en
    // ~595 dots; font 2 con 12*48=576 sí cabe).
    assert.equal(
        pickTsplReceiptFont({ columns: 48, printableWidthMm: 76, leftMarginMm: 1.5, scaleX: 1 }),
        "2",
    );
    // 82 físico / 76 imprimible / 48 cols → igual que 80 (printable manda).
    assert.equal(
        pickTsplReceiptFont({ columns: 48, printableWidthMm: 76, leftMarginMm: 1.5, scaleX: 1 }),
        "2",
    );
    // scaleX=2 duplica el ancho del glifo → baja un escalón del ladder.
    assert.equal(
        pickTsplReceiptFont({ columns: 48, printableWidthMm: 76, leftMarginMm: 1.5, scaleX: 2 }),
        "1",
    );
    // leftMarginMm grande reduce el presupuesto → también baja.
    assert.equal(
        pickTsplReceiptFont({ columns: 32, printableWidthMm: 48, leftMarginMm: 10, scaleX: 1 }),
        "1",
    );
    // Firma BC con solo `columns`: se usa PHYSICAL_MAX_MM=82 como presupuesto
    // y leftMarginMm=0 (sin geometría conocida). Con 32 cols en 82 mm cabe
    // font "3" (16*32=512 ≤ 656), con 48 cols baja a "2" (12*48=576 ≤ 656,
    // 16*48=768 no).
    assert.equal(pickTsplReceiptFont(32), "3");
    assert.equal(pickTsplReceiptFont(48), "2");
});

test("buildTsplReceiptDocument: 58 físico / 48 imprimible / 32 cols → fuente \"1\"", () => {
    const text = buildTsplReceiptDocument({
        ticketText: "x",
        receipt: { widthMm: 58, printableWidthMm: 48, columns: 32 },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(text, /TEXT \d+,\d+,"1",0,\d+,\d+,"/);
});

test("buildTsplReceiptDocument: 80 físico / 76 imprimible / 48 cols → fuente \"2\"", () => {
    const text = buildTsplReceiptDocument({
        ticketText: "x",
        receipt: { widthMm: 80, printableWidthMm: 76, columns: 48 },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(text, /TEXT \d+,\d+,"2",0,\d+,\d+,"/);
});

test("buildTsplReceiptDocument: 82 físico / 76 imprimible / 48 cols → fuente \"2\"", () => {
    const text = buildTsplReceiptDocument({
        ticketText: "x",
        receipt: { widthMm: 82, printableWidthMm: 76, columns: 48 },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(text, /TEXT \d+,\d+,"2",0,\d+,\d+,"/);
});

test("buildTsplReceiptDocument: sin printableWidthMm cae a widthMm y aún así cabe", () => {
    // widthMm=58, printable default = 58 → available ~ (58-1.5)*8 ≈ 452 dots.
    // Ladder [4,3,8,2,1]: font 4 (768) y font 3 (512) NO caben; font 8
    // (14*32=448) sí cabe → debe elegir "8". narrow=false (58>50) ⇒ scaleY=1.
    const narrow = buildTsplReceiptDocument({
        ticketText: "x",
        receipt: { widthMm: 58, columns: 32 },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(narrow, /TEXT \d+,\d+,"8",0,\d+,\d+,"/);
    // widthMm=80, printable default = 80 → available ~ (80-1.5)*8 ≈ 628 dots.
    // Font 3 (16*48=768) NO cabe, font 8 (14*48=672) NO cabe (>628);
    // font 2 (12*48=576) sí → "2".
    const wide = buildTsplReceiptDocument({
        ticketText: "x",
        receipt: { widthMm: 80, columns: 48 },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(wide, /TEXT \d+,\d+,"2",0,\d+,\d+,"/);
});

test("buildTsplReceiptDocument: admin override vía receipt.tspl.font respeta el valor", () => {
    const buf = buildTsplReceiptDocument({
        ticketText: "x",
        receipt: { widthMm: 80, columns: 48, tspl: { font: "4" } },
        escapeFn: escapeForTspl,
    });
    assert.match(buf.toString("ascii"), /TEXT \d+,\d+,"4",0,\d+,\d+,"/);
});

test("tsplLineHeightMm: valores razonables para fuentes 1..8", () => {
    assert.ok(tsplLineHeightMm("1", 1) >= 1);
    assert.ok(tsplLineHeightMm("2", 1) < tsplLineHeightMm("4", 1));
    assert.ok(tsplLineHeightMm("4", 2) > tsplLineHeightMm("4", 1), "scaleY aumenta la altura");
});

test("pickTsplReceiptColumns: widthMm → columnas default razonables", () => {
    // 58 mm: midpoint oficial bridge-printing-v3.2 — 26 cols emparejan con
    // font 8 (14×25) a scaleY 1 (ver sección I). Antes era 32 cols que
    // caían en font 1 scaleY 2 y producían ticket muy alto.
    assert.equal(pickTsplReceiptColumns(58), 26);
    assert.equal(pickTsplReceiptColumns(80), 48);
    assert.equal(pickTsplReceiptColumns(82), 48);
    assert.equal(pickTsplReceiptColumns(45), 24);
});

// -----------------------------------------------------------------------------
// E. buildTsplReceiptBytes — wrapper del bridge
// -----------------------------------------------------------------------------

test("buildTsplReceiptBytes: merge payload.receipt con top-level widthMm", () => {
    const buf = buildTsplReceiptBytes({
        ticketText: "x",
        payload: {
            widthMm: 58,
            columns: 32,
            cut: "AUTO",
            // Sin receipt: debe usar los top-level.
        },
    });
    assert.match(buf.toString("ascii"), /SIZE 58 mm/);
});

test("buildTsplReceiptBytes: payload.receipt gana sobre top-level", () => {
    const buf = buildTsplReceiptBytes({
        ticketText: "x",
        payload: {
            widthMm: 58,
            receipt: { widthMm: 80, columns: 48 },
        },
    });
    assert.match(buf.toString("ascii"), /SIZE 80 mm/);
});

// -----------------------------------------------------------------------------
// F. Integración handlePrinterRequest
// -----------------------------------------------------------------------------

test("handlePrinterRequest thermal-receipt protocol=tspl → sendTcp con TSPL (SIZE/GAP/PRINT)", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "tr-tspl-1",
        action: "print",
        payload: {
            type: "thermal-receipt",
            ticketText: "Factura #42\nTotal: $1.000\n",
            widthMm: 80,
            columns: 48,
            cut: "AUTO",
            connection: {
                interface: "NETWORK",
                protocol: "tspl",
                network: { host: "10.0.0.5", port: 9100 },
            },
        },
    }, deps);
    assert.equal(r.ok, true, r.error);
    assert.equal(calls.tcp.length, 1);
    assert.equal(calls.system.length, 0);
    const text = calls.tcp[0].buf.toString("ascii");
    assert.match(text, /SIZE 80 mm,/);
    assert.match(text, /GAP 0 mm, 0 mm/);
    assert.match(text, /PRINT 1,1/);
    // Y DEFINITIVAMENTE no ESC/POS init.
    assert.ok(!(calls.tcp[0].buf[0] === 0x1B && calls.tcp[0].buf[1] === 0x40),
        "no debe empezar con ESC @ cuando protocol=tspl");
});

test("handlePrinterRequest thermal-receipt protocol=escpos → sigue siendo ESC/POS (regresión)", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "tr-escpos-1",
        action: "print",
        payload: {
            type: "thermal-receipt",
            ticketText: "Hola",
            widthMm: 58,
            columns: 32,
            cut: "AUTO",
            connection: {
                interface: "NETWORK",
                protocol: "escpos",
                network: { host: "10.0.0.5", port: 9100 },
            },
        },
    }, deps);
    assert.equal(r.ok, true);
    assert.equal(calls.tcp[0].buf[0], 0x1B, "ESC @ al inicio");
    assert.equal(calls.tcp[0].buf[1], 0x40);
    assert.equal(calls.tcp[0].buf[2], 0x1B, "ESC t ...");
    assert.equal(calls.tcp[0].buf[3], 0x74);
    assert.equal(calls.tcp[0].buf[4], 0x02, "CP850 code table");
});

test("handlePrinterRequest thermal-receipt protocol=pdf → UNSUPPORTED_PAYLOAD_TYPE y NO toca transporte", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "tr-pdf",
        action: "print",
        payload: {
            type: "thermal-receipt",
            ticketText: "Hola",
            widthMm: 80,
            columns: 48,
            connection: {
                interface: "SYSTEM",
                protocol: "pdf",
                system: { printerName: "PDFCreator" },
            },
        },
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, ERR.UNSUPPORTED_PAYLOAD_TYPE);
    assert.equal(calls.tcp.length, 0);
    assert.equal(calls.system.length, 0);
});

test("handlePrinterRequest thermal-receipt protocol=tspl + SYSTEM → sendSystem (req. 5)", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "tr-system-tspl",
        action: "print",
        payload: {
            type: "thermal-receipt",
            ticketText: "x",
            widthMm: 80,
            columns: 48,
            cut: "AUTO",
            connection: {
                interface: "SYSTEM",
                protocol: "tspl",
                system: { printerName: "POS-TSPL" },
            },
        },
    }, deps);
    assert.equal(r.ok, true, r.error);
    assert.equal(calls.tcp.length, 0);
    assert.equal(calls.system.length, 1);
    assert.equal(calls.system[0].printerName, "POS-TSPL");
    assert.match(calls.system[0].buf.toString("ascii"), /SIZE 80 mm,/);
});

test("handlePrinterRequest thermal-receipt protocol=tspl + widthMm fuera de bounds propaga LAYOUT_OUT_OF_BOUNDS", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "tr-oob",
        action: "print",
        payload: {
            type: "thermal-receipt",
            ticketText: "x",
            widthMm: 120, // > 82
            columns: 48,
            connection: {
                interface: "NETWORK",
                protocol: "tspl",
                network: { host: "10.0.0.5", port: 9100 },
            },
        },
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "LAYOUT_OUT_OF_BOUNDS");
    assert.equal(calls.tcp.length, 0);
});

// -----------------------------------------------------------------------------
// G. test-page: receipt sigue la misma rama de protocolo
// -----------------------------------------------------------------------------

test("test-page target=receipt protocol=tspl usa el mismo renderer (TSPL)", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "tp-tspl",
        action: "print",
        payload: {
            type: "test-page",
            target: "receipt",
            config: {
                connection: {
                    interface: "NETWORK",
                    protocol: "tspl",
                    network: { host: "10.0.0.5", port: 9100 },
                },
                receipt: { widthMm: 80, columns: 48, cut: "AUTO" },
            },
        },
    }, deps);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.result.kind, "test-receipt");
    assert.equal(calls.tcp.length, 1);
    const text = calls.tcp[0].buf.toString("ascii");
    assert.match(text, /SIZE 80 mm,/);
    assert.match(text, /GAP 0 mm, 0 mm/);
    assert.match(text, /PAGINA DE PRUEBA/);
    // Debe decir "Canal : TSPL" para que el admin sepa qué canal probó.
    assert.match(text, /Canal\s*:\s*TSPL/);
});

test("test-page target=receipt protocol=escpos sigue siendo ESC/POS (regresión)", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "tp-escpos",
        action: "print",
        payload: {
            type: "test-page",
            target: "receipt",
            config: {
                connection: {
                    interface: "NETWORK",
                    protocol: "escpos",
                    network: { host: "10.0.0.5", port: 9100 },
                },
                receipt: { widthMm: 80, columns: 48, cut: "AUTO" },
            },
        },
    }, deps);
    assert.equal(r.ok, true);
    // ESC @ al inicio.
    assert.equal(calls.tcp[0].buf[0], 0x1B);
    assert.equal(calls.tcp[0].buf[1], 0x40);
});

test("test-page target=receipt protocol=pdf → UNSUPPORTED_PAYLOAD_TYPE", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "tp-pdf",
        action: "printTestPage",
        payload: {
            target: "receipt",
            config: {
                connection: {
                    interface: "SYSTEM",
                    protocol: "pdf",
                    system: { printerName: "PDFCreator" },
                },
                receipt: { widthMm: 80, columns: 48 },
            },
        },
    }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, ERR.UNSUPPORTED_PAYLOAD_TYPE);
    assert.equal(calls.tcp.length, 0);
    assert.equal(calls.system.length, 0);
});

test("buildTsplTestPageReceipt: expone widthMm, columnas y canal en el cuerpo del ticket", () => {
    const buf = buildTsplTestPageReceipt({
        connection: { protocol: "tspl" },
        receipt: { widthMm: 58, columns: 32, cut: "MANUAL" },
    });
    const text = buf.toString("ascii");
    assert.match(text, /SIZE 58 mm,/);
    assert.match(text, /PAGINA DE PRUEBA/);
    assert.match(text, /Canal\s*:\s*TSPL/);
    assert.match(text, /Ancho\s*:\s*58 mm/);
    assert.match(text, /Cols\s*:\s*32/);
});

// -----------------------------------------------------------------------------
// H. Request de etiqueta NO cambia (regresión: TSPL de etiquetas sigue intacto)
// -----------------------------------------------------------------------------

test("thermal-receipt TSPL ≠ etiqueta TSPL — el camino de etiquetas no se altera", async () => {
    const { deps, calls } = makeStubDeps();
    const r = await handlePrinterRequest({
        requestId: "lbl-tspl",
        action: "print",
        payload: {
            // Lote de etiquetas, no thermal-receipt.
            items: [{ code: "ABC", productName: "ARROZ", salePrice: 2500, quantity: 1 }],
            labels: { widthMm: 50, heightMm: 30, sensor: { gapMm: 3 }, barcode: { heightMm: 8 } },
            connection: {
                interface: "NETWORK",
                protocol: "tspl",
                network: { host: "10.0.0.5", port: 9100 },
            },
        },
    }, deps);
    assert.equal(r.ok, true, r.error);
    const text = calls.tcp[0].buf.toString("ascii");
    // Etiqueta: GAP de sensor != 0 (el renderer de etiquetas usa `sensor.gapMm`).
    assert.match(text, /GAP 3 mm, 0 mm/);
    assert.match(text, /BARCODE /, "etiqueta debe emitir BARCODE");
    // Y NO debe tener "Canal : TSPL" (eso es cabecera del test-page receipt).
    assert.ok(!/Canal\s*:\s*TSPL/.test(text));
});


// -----------------------------------------------------------------------------
// H. Geometría física: centrar área imprimible dentro del rollo
// -----------------------------------------------------------------------------

test("buildTsplReceiptDocument usa el margen interno sin duplicar el offset del medio", () => {
    const cases = [
        { widthMm: 58, printableWidthMm: 48 },
        { widthMm: 80, printableWidthMm: 76 },
        { widthMm: 82, printableWidthMm: 76 },
        { widthMm: 45, printableWidthMm: 45 },
    ];
    for (const row of cases) {
        const text = buildTsplReceiptDocument({
            ticketText: "X",
            receipt: {
                widthMm: row.widthMm,
                printableWidthMm: row.printableWidthMm,
                columns: row.widthMm <= 58 ? 32 : 48,
            },
            escapeFn: escapeForTspl,
        }).toString("ascii");
        const match = text.match(/TEXT (\d+),\d+,/);
        assert.ok(match, `TEXT requerido para ${row.widthMm}/${row.printableWidthMm}`);
        const expectedDots = Math.round(1.5 * 203 / 25.4);
        assert.equal(Number(match[1]), expectedDots,
            `X debe aplicar una sola vez el margen interno en ${row.widthMm}/${row.printableWidthMm}`);
    }
});

test("buildTsplReceiptDocument respeta leftMarginMm configurado como X final", () => {
    const text = buildTsplReceiptDocument({
        ticketText: "X",
        receipt: {
            widthMm: 58,
            printableWidthMm: 48,
            columns: 32,
            tspl: { leftMarginMm: 3 },
        },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    const x = Number(text.match(/TEXT (\d+),\d+,/)[1]);
    assert.equal(x, Math.round(3 * 203 / 25.4),
        "el margen configurado no debe sumar un segundo offset físico");
});

test("buildTsplReceiptDocument clampa leftMarginMm negativo a cero", () => {
    const text = buildTsplReceiptDocument({
        ticketText: "X",
        receipt: {
            widthMm: 58,
            printableWidthMm: 80, // se clampa al ancho físico
            columns: 32,
            tspl: { leftMarginMm: 0 },
        },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(text, /TEXT 0,\d+,/);
});

test("buildTsplReceiptDocument permite override direction/mirror acotado a 0..1", () => {
    const rotated = buildTsplReceiptDocument({
        ticketText: "X",
        receipt: {
            widthMm: 58,
            printableWidthMm: 48,
            columns: 32,
            tspl: { direction: 1, mirror: 1 },
        },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(rotated, /DIRECTION 1,1/);

    const clamped = buildTsplReceiptDocument({
        ticketText: "X",
        receipt: {
            widthMm: 58,
            printableWidthMm: 48,
            columns: 32,
            tspl: { direction: 99, mirror: -4 },
        },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(clamped, /DIRECTION 1,0/);
});

// -----------------------------------------------------------------------------
// I. Legibilidad física en papel angosto
// -----------------------------------------------------------------------------

test("58/48 con 30 columnas usa fuente 2 a escala vertical 2", () => {
    const text = buildTsplReceiptDocument({
        ticketText: "RECIBO LEGIBLE",
        receipt: { widthMm: 58, printableWidthMm: 48, columns: 30 },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(text, /TEXT \d+,\d+,"2",0,1,2,"RECIBO LEGIBLE"/);
});

test("cliente antiguo 58/48 con 32 columnas usa fuente 1 pero altura 2", () => {
    const text = buildTsplReceiptDocument({
        ticketText: "12345678901234567890123456789012",
        receipt: { widthMm: 58, printableWidthMm: 48, columns: 32 },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(text, /TEXT \d+,\d+,"1",0,1,2,/);
});

test("80/76 con 48 columnas conserva fuente 2 a escala vertical 1", () => {
    const text = buildTsplReceiptDocument({
        ticketText: "RECIBO 80",
        receipt: { widthMm: 80, printableWidthMm: 76, columns: 48 },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(text, /TEXT \d+,\d+,"2",0,1,1,"RECIBO 80"/);
});

test("override scaleY explícito manda sobre el default angosto", () => {
    const text = buildTsplReceiptDocument({
        ticketText: "OVERRIDE",
        receipt: {
            widthMm: 58,
            printableWidthMm: 48,
            columns: 30,
            tspl: { scaleY: 1 },
        },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(text, /TEXT \d+,\d+,"2",0,1,1,"OVERRIDE"/);
});

// -----------------------------------------------------------------------------
// I.b Midpoint oficial 58/48/26 columnas (bridge-printing-v3.2)
//
// Antes el ticket de 58 mm caía forzosamente en font 2 scaleY 2 (grande
// pero muy alto, duplicando el largo del recibo) o en font 1 scaleY 2
// (chico y aún así alto). El rediseño inserta font 8 (14×25) en el ladder
// entre font 3 y font 2: a 26 columnas cabe sin recortar y produce un
// alto base equivalente al de font 3 (24 dots), por lo que scaleY 1
// alcanza. El objetivo visual es "mitad de altura, misma legibilidad".
// -----------------------------------------------------------------------------

test("58/48 con 26 columnas (midpoint) usa fuente 8 a escala vertical 1", () => {
    const text = buildTsplReceiptDocument({
        ticketText: "RECIBO MIDPOINT",
        receipt: { widthMm: 58, printableWidthMm: 48, columns: 26 },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(text, /TEXT \d+,\d+,"8",0,1,1,"RECIBO MIDPOINT"/);
});

test("pickTsplReceiptFont: 58/48/26 cols aterriza en font \"8\" (midpoint)", () => {
    assert.equal(
        pickTsplReceiptFont({ columns: 26, printableWidthMm: 48, leftMarginMm: 1.5, scaleX: 1 }),
        "8",
        "26 cols en 48 mm imprimible deben caer en font 8 del ladder [4,3,8,2,1]",
    );
});

test("58/48/26 col+font 8: scaleY default sigue siendo 1 incluso con narrow=true", () => {
    // El picker decide font 8 (midpoint) → aunque printable <=50 el default
    // NO escala vertical. Solo las fuentes delgadas (1/2) hacen scaleY=2
    // defensivo en papel angosto. Este test blinda el ajuste: si alguien
    // revierte el reorden "font antes de scaleY" o vuelve al predicado
    // viejo `printableWidthMm <= 50 ? 2 : 1`, falla acá.
    const text = buildTsplReceiptDocument({
        ticketText: "X",
        receipt: { widthMm: 58, printableWidthMm: 48, columns: 26 },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(text, /TEXT \d+,\d+,"8",0,1,1,"X"/);
});

test("admin override font=8 en papel angosto respeta scaleY=1 default", () => {
    // Caso donde el admin fuerza font 8 vía receipt.tspl.font: aunque esté
    // en papel 58/48 y pasara columns=32 (que normalmente iría a font 1
    // scaleY 2), el override manda y la fuente final es la 8, así que
    // scaleY defaultea a 1 — no se "contagia" la lógica narrow→2 porque
    // depende de la fuente FINAL, no del picker.
    const text = buildTsplReceiptDocument({
        ticketText: "FORCE",
        receipt: {
            widthMm: 58,
            printableWidthMm: 48,
            columns: 32,
            tspl: { font: "8" },
        },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(text, /TEXT \d+,\d+,"8",0,1,1,"FORCE"/);
});

test("fallback pickTsplReceiptColumns(58)=26 encadena con picker → font 8 scaleY 1", () => {
    // Si el frontend omite `receipt.columns` (payload corrupto o cliente
    // viejo), el bridge usa pickTsplReceiptColumns(58)=26 como default.
    // Esta cadena completa debe terminar en el ticket canónico 58 mm:
    // font 8, scaleX=1, scaleY=1. Es el end-to-end del midpoint.
    assert.equal(pickTsplReceiptColumns(58), 26);
    const text = buildTsplReceiptDocument({
        ticketText: "FALLBACK",
        receipt: { widthMm: 58, printableWidthMm: 48 /* columns omitido */ },
        escapeFn: escapeForTspl,
    }).toString("ascii");
    assert.match(text, /TEXT \d+,\d+,"8",0,1,1,"FALLBACK"/);
});

// -----------------------------------------------------------------------------
// J. Ladder canónico [4,3,8,2,1] y metrics de font 8 (bridge-printing-v3.2)
// -----------------------------------------------------------------------------

test("TSPL_RECEIPT_FONT_LADDER expone [4,3,8,2,1] en ese orden exacto", () => {
    // El orden importa: el picker recorre el ladder y DEVUELVE la primera
    // que cabe. Insertar font 8 entre 3 y 2 asegura que el 58/48/26 lo
    // elija antes que el 2 (que también cabría pero quedaría chico).
    assert.deepEqual(
        [...TSPL_RECEIPT_FONT_LADDER],
        ["4", "3", "8", "2", "1"],
    );
});

test("TSPL_FONT_METRICS[\"8\"] = 14x25 dots (midpoint oficial TSPL)", () => {
    // Si TSC cambia la métrica de font 8 en algún firmware futuro, el
    // picker podría escoger "8" para columnas que no caben físicamente.
    // Blindamos el valor que estamos usando como base de diseño.
    assert.deepEqual(
        { widthDots: TSPL_FONT_METRICS["8"].widthDots, heightDots: TSPL_FONT_METRICS["8"].heightDots },
        { widthDots: 14, heightDots: 25 },
    );
});

test("TSPL_FONT_METRICS cubre 1..8 (ningún índice del ladder se queda sin métricas)", () => {
    for (const id of TSPL_RECEIPT_FONT_LADDER) {
        assert.ok(TSPL_FONT_METRICS[id], `falta métrica para font "${id}" del ladder`);
        assert.ok(TSPL_FONT_METRICS[id].widthDots > 0);
        assert.ok(TSPL_FONT_METRICS[id].heightDots > 0);
    }
});

test("tsplLineHeightMm(font 8, 1) ≈ tsplLineHeightMm(font 3, 1) — midpoint real", () => {
    // La promesa del midpoint es que un recibo render-eado con font 8
    // scaleY 1 ocupe ~ la mitad del alto del viejo font 2 scaleY 2
    // y ~ el mismo alto que font 3 scaleY 1. Lo verificamos por métricas,
    // sin acoplarnos a la constante exacta (depende de 203 dpi + padding).
    const h8 = tsplLineHeightMm("8", 1);
    const h3 = tsplLineHeightMm("3", 1);
    const h2x2 = tsplLineHeightMm("2", 2);
    // 25 dots vs 24 dots → la diferencia debe ser < 10% (padding común).
    assert.ok(Math.abs(h8 - h3) / h3 < 0.1,
        `font 8 scaleY 1 (${h8}mm) debe quedar cerca de font 3 scaleY 1 (${h3}mm)`);
    // Y debe ser muy inferior al viejo gigantismo font 2 scaleY 2.
    assert.ok(h8 < h2x2 * 0.75,
        `font 8 scaleY 1 (${h8}mm) debe ser < 75% de font 2 scaleY 2 (${h2x2}mm)`);
});
