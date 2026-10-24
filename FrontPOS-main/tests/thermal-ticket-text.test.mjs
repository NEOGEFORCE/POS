// =============================================================================
// tests/thermal-ticket-text.test.mjs
//
// Tests BEHAVIORALES (no grep) para el módulo puro `thermal-ticket-text.mjs`.
// Verifican que:
//
//   - `buildTicketText(data)` sin options es byte a byte compatible con la
//     salida histórica (contrato BC).
//   - Cada toggle de `TicketPrintOptions` (showTaxes, thankYou, cut,
//     showValidationQR) altera el OUTPUT real, no sólo el shape.
//   - `escapeHtml` cubre `& < > " '` y coerciona entradas no-string.
//
// El fin es que los próximos cambios a la plantilla térmica no puedan
// pasar a producción silenciando regresiones del ticket real.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";

import {
    INVALID_DATE_LABEL,
    STORE,
    buildTicketText,
    center,
    charsPerLine,
    escapeHtml,
    formatDateTime,
    money,
    pad,
    padLeft,
    resolveStore,
    wrap,
} from "../src/lib/thermal-ticket-text.mjs";

// --- Fixture --------------------------------------------------------------

function sampleTicket(overrides = {}) {
    return {
        ticketNumber: "001",
        date: new Date(2026, 9, 5, 10, 30, 0), // 2026-10-05 10:30 AM local
        cashier: "Juan",
        lines: [
            { name: "Café", quantity: 2, unitPrice: 1500, total: 3000 },
        ],
        subtotal: 3000,
        taxes: 570,
        total: 3570,
        paymentMethod: "EFECTIVO",
        ...overrides,
    };
}

// --- Helpers puros --------------------------------------------------------

test("charsPerLine: 58mm → 32, 80mm → 48, override válido → ese valor", () => {
    assert.equal(charsPerLine("58mm"), 32);
    assert.equal(charsPerLine("80mm"), 48);
    assert.equal(charsPerLine("58mm", 40), 40);
    assert.equal(charsPerLine("58mm", 10), 32, "fuera de rango inferior cae al default");
    assert.equal(charsPerLine("58mm", 100), 32, "fuera de rango superior cae al default");
    assert.equal(charsPerLine("58mm", "not a number"), 32, "no-number cae al default");
});

test("money: formato colombiano con punto como miles y signo negativo", () => {
    assert.equal(money(0), "$0");
    assert.equal(money(1234), "$1.234");
    assert.equal(money(1234567), "$1.234.567");
    assert.equal(money(-500), "-$500");
    assert.equal(money(99.6), "$100", "redondeo al peso");
});

test("pad/padLeft: alinean a derecha o izquierda y truncan en overflow", () => {
    assert.equal(pad("ABC", 5), "ABC  ");
    assert.equal(pad("ABCDEF", 3), "ABC", "overflow trunca por el final");
    assert.equal(padLeft("ABC", 5), "  ABC");
    assert.equal(padLeft("ABCDEF", 3), "DEF", "overflow trunca por el inicio");
});

test("center: centra respetando overflow", () => {
    assert.equal(center("ab", 10), "    ab");
    assert.equal(center("ab", 2), "ab");
    assert.equal(center("abcdef", 4), "abcd");
});

test("wrap: respeta palabras y no deja líneas vacías", () => {
    assert.deepEqual(wrap("uno dos tres", 7), ["uno dos", "tres"]);
    assert.deepEqual(wrap("", 10), [""]);
    assert.deepEqual(wrap("palabra-muy-larga", 5), ["palabra-muy-larga"]);
});

test("resolveStore: override gana sobre config, config sobre defaults", () => {
    const r1 = resolveStore(null, null);
    assert.equal(r1.name, STORE.name);
    const r2 = resolveStore(null, { name: "Tienda CFG" });
    assert.equal(r2.name, "Tienda CFG");
    assert.equal(r2.address, STORE.address, "campos no provistos caen a default");
    const r3 = resolveStore({ name: "Override" }, { name: "Tienda CFG" });
    assert.equal(r3.name, "Override");
});

// --- buildTicketText: BC sin options --------------------------------------

test("buildTicketText: sin options emite el footer histórico (BC)", () => {
    const out = buildTicketText(sampleTicket(), "58mm");
    const lines = out.split("\n");

    assert.ok(lines.some((l) => l.trim() === "Gracias por su compra en"),
        "primera línea histórica del footer");
    assert.ok(lines.some((l) => l.trim() === "SURTIFAMILIAR!"),
        "segunda línea histórica del footer");
    assert.ok(out.includes("IVA / IMPUESTOS"),
        "showTaxes default = mostrar: la línea existe");
    assert.ok(!out.includes("CORTE MANUAL"), "sin marcador manual por default");
    assert.ok(!out.includes("CORTE AUTOMATICO"), "sin marcador auto por default");
    assert.ok(!out.includes("Validar en:"), "sin URL de validación por default");
});

test("buildTicketText: options={} equivale a options undefined (BC)", () => {
    const t = sampleTicket();
    const a = buildTicketText(t, "58mm");
    const b = buildTicketText(t, "58mm", {});
    const c = buildTicketText(t);
    assert.equal(a, b, "options vacío no cambia el output");
    assert.equal(a, c, "width default = '58mm'");
});

test("buildTicketText: estructura general incluye encabezado del negocio por defecto", () => {
    const out = buildTicketText(sampleTicket(), "58mm");
    assert.ok(out.includes(STORE.name), "nombre del negocio presente");
    assert.ok(out.includes(STORE.nit), "NIT presente");
    assert.ok(out.includes("TICKET #001"), "número de ticket presente");
    assert.ok(out.includes("Cajero: JUAN"), "cajero en mayúsculas");
    assert.ok(out.includes("Cliente: CONSUMIDOR FINAL"), "cliente default");
});

// --- buildTicketText: priceCols/totalCols adaptativos --------------------
//
// Fijan el contrato que negocia `thermal-ticket-text` con el bridge TSPL:
// cuando el ancho total (W) cae a 30 o menos, las columnas monetarias
// V.UNIT y TOTAL se recortan a 8 y 9 chars (en vez de 9 y 10) para no
// aplastar el nombre del producto. Para W >= 31 se preservan los anchos
// históricos 9/10 — ésa es la salida BC de `buildTicketText(data, '58mm')`
// con el default de 32 columnas y de `buildTicketText(data, '80mm')` con
// 48 columnas. El nuevo path se activa típicamente con TSPL 58/48 saneado
// a 26 columnas (punto medio font8 14x25 scaleY1).

// Helper local: localiza la fila de cabecera por el token V.UNIT (que
// siempre aparece completo, en contraste con "CANT/PRODUCTO" que se
// trunca cuando `nameCols < 13`).
function findHeaderRow(out) {
    return out.split("\n").find((l) => l.includes("V.UNIT") && l.includes("TOTAL"));
}

test("buildTicketText: W<=30 (TSPL 58/48 saneado) usa priceCols=8/totalCols=9 adaptativos", () => {
    const t = sampleTicket({
        lines: [{ name: "Café", quantity: 1, unitPrice: 12345, total: 12345 }],
        subtotal: 12345, taxes: 0, total: 12345,
    });
    const out = buildTicketText(t, "58mm", { columns: 26 });
    const header = findHeaderRow(out);
    assert.ok(header, "existe la fila de cabecera V.UNIT/TOTAL");
    assert.equal(header.length, 26, "la cabecera respeta el ancho saneado");
    // Con priceCols=8 / totalCols=9 el header termina en "  V.UNIT    TOTAL"
    // alineado a la derecha: comprobamos los 17 chars finales exactos
    // (8 chars "  V.UNIT" + 9 chars "    TOTAL" = 17).
    const tail = header.slice(-17);
    assert.equal(tail, "  V.UNIT    TOTAL",
        "los 17 chars finales son V.UNIT (8) + TOTAL (9) alineados a la derecha");
    // La línea de SUBTOTAL también queda alineada a totalCols=9.
    const subtotalLine = out.split("\n").find((l) => l.startsWith("SUBTOTAL"));
    assert.ok(subtotalLine, "línea SUBTOTAL presente");
    assert.equal(subtotalLine.length, 26, "SUBTOTAL respeta el ancho saneado");
    assert.equal(subtotalLine.slice(-9), "  $12.345",
        "los 9 chars finales son el monto SUBTOTAL alineado a totalCols=9");
});

test("buildTicketText: W=30 también entra en la rama adaptativa (frontera inclusiva)", () => {
    const t = sampleTicket({
        lines: [{ name: "X", quantity: 1, unitPrice: 100, total: 100 }],
        subtotal: 100, taxes: 0, total: 100,
    });
    const out = buildTicketText(t, "58mm", { columns: 30 });
    const header = findHeaderRow(out);
    assert.ok(header);
    assert.equal(header.length, 30);
    // 30 chars = 13 (nombre) + 8 (V.UNIT) + 9 (TOTAL).
    assert.equal(header.slice(-17), "  V.UNIT    TOTAL",
        "W=30 activa la rama adaptativa 8/9");
});

test("buildTicketText: W=32 default 58mm preserva priceCols=9/totalCols=10 (BC byte a byte)", () => {
    const t = sampleTicket({
        lines: [{ name: "X", quantity: 1, unitPrice: 100, total: 100 }],
        subtotal: 100, taxes: 0, total: 100,
    });
    const out = buildTicketText(t, "58mm");
    const header = findHeaderRow(out);
    assert.ok(header);
    assert.equal(header.length, 32, "default 58mm → 32 columnas");
    // 9 "   V.UNIT" + 10 "     TOTAL" = 19 chars al final.
    assert.equal(header.slice(-19), "   V.UNIT     TOTAL",
        "los 19 chars finales son V.UNIT (9) + TOTAL (10) — BC preservado");
});

test("buildTicketText: W=48 (80mm/82mm/JAL_838L) preserva priceCols=9/totalCols=10 (BC byte a byte)", () => {
    const t = sampleTicket({
        lines: [{ name: "X", quantity: 1, unitPrice: 100, total: 100 }],
        subtotal: 100, taxes: 0, total: 100,
    });
    const out = buildTicketText(t, "80mm");
    const header = findHeaderRow(out);
    assert.ok(header);
    assert.equal(header.length, 48);
    assert.equal(header.slice(-19), "   V.UNIT     TOTAL");
});

test("buildTicketText: W=31 queda en el camino BC (frontera estricta >30)", () => {
    // La regla usa <= 30 para la rama adaptativa; W=31 debe comportarse
    // como el camino BC (9/10). Si alguien cambia a < 30 este test salta.
    const t = sampleTicket({
        lines: [{ name: "X", quantity: 1, unitPrice: 100, total: 100 }],
        subtotal: 100, taxes: 0, total: 100,
    });
    const out = buildTicketText(t, "58mm", { columns: 31 });
    const header = findHeaderRow(out);
    assert.ok(header);
    assert.equal(header.length, 31);
    assert.equal(header.slice(-19), "   V.UNIT     TOTAL",
        "W=31 preserva 9/10; sólo W<=30 activa 8/9");
});

// --- buildTicketText: showTaxes --------------------------------------------

test("buildTicketText: showTaxes=false omite la línea de impuestos", () => {
    const out = buildTicketText(sampleTicket(), "58mm", { showTaxes: false });
    assert.ok(!out.includes("IVA / IMPUESTOS"), "línea de impuestos desaparece");
    assert.ok(out.includes("SUBTOTAL"), "SUBTOTAL se preserva");
    assert.ok(out.includes("TOTAL A PAGAR"), "TOTAL A PAGAR se preserva");
});

test("buildTicketText: showTaxes=true mantiene la línea aunque taxes sea 0", () => {
    const out = buildTicketText(sampleTicket({ taxes: 0 }), "58mm", { showTaxes: true });
    assert.ok(out.includes("IVA / IMPUESTOS"), "showTaxes explícito=true: línea presente");
    const lines = out.split("\n");
    const ivaLine = lines.find((l) => l.includes("IVA / IMPUESTOS"));
    assert.ok(ivaLine && ivaLine.includes("$0"), "con taxes=0 debe mostrarse $0");
});

test("buildTicketText: showTaxes undefined mantiene BC (muestra la línea)", () => {
    const out = buildTicketText(sampleTicket(), "58mm", { thankYou: "x" });
    assert.ok(out.includes("IVA / IMPUESTOS"),
        "showTaxes undefined con otras options sigue preservando la línea");
});

// --- buildTicketText: thankYou --------------------------------------------

test("buildTicketText: thankYou reemplaza el footer hardcoded completo", () => {
    const out = buildTicketText(sampleTicket(), "58mm", {
        thankYou: "¡Gracias por su compra!",
    });
    assert.ok(!out.includes("Gracias por su compra en"),
        "fallback histórico queda fuera cuando hay thankYou");
    assert.ok(!out.includes("SURTIFAMILIAR!"),
        "segunda línea del fallback queda fuera");
    assert.ok(out.includes("¡Gracias por su compra!"),
        "mensaje configurado aparece");
});

test("buildTicketText: thankYou vacío o whitespace cae al fallback histórico", () => {
    const o1 = buildTicketText(sampleTicket(), "58mm", { thankYou: "" });
    assert.ok(o1.includes("Gracias por su compra en"), "'' cae al fallback");
    const o2 = buildTicketText(sampleTicket(), "58mm", { thankYou: "   " });
    assert.ok(o2.includes("Gracias por su compra en"), "whitespace cae al fallback");
});

test("buildTicketText: thankYou multiline se centra sin cortar palabras", () => {
    const mensaje = "Gracias totales por su visita hoy";
    const out = buildTicketText(sampleTicket(), "58mm", { thankYou: mensaje });
    // El mensaje puede dividirse en varias líneas por el wrap, pero las
    // palabras deben preservarse completas.
    const words = mensaje.split(/\s+/);
    for (const w of words) {
        assert.ok(out.includes(w), `palabra "${w}" presente en el footer centrado`);
    }
});

// --- buildTicketText: cut --------------------------------------------------

test("buildTicketText: cut='MANUAL' agrega el marcador al FINAL del ticket", () => {
    const out = buildTicketText(sampleTicket(), "58mm", { cut: "MANUAL" });
    assert.ok(out.includes("CORTE MANUAL"), "marcador manual presente");
    const nonEmpty = out.split("\n").filter((l) => l.trim().length > 0);
    assert.ok(nonEmpty[nonEmpty.length - 1].includes("CORTE MANUAL"),
        "el marcador manual queda en la última línea no-vacía");
});

test("buildTicketText: cut='AUTO' agrega marcador automático al final", () => {
    const out = buildTicketText(sampleTicket(), "58mm", { cut: "AUTO" });
    assert.ok(out.includes("CORTE AUTOMATICO"), "marcador auto presente");
    const nonEmpty = out.split("\n").filter((l) => l.trim().length > 0);
    assert.ok(nonEmpty[nonEmpty.length - 1].includes("CORTE AUTOMATICO"),
        "el marcador auto queda en la última línea no-vacía");
});

test("buildTicketText: cut='NONE' NO agrega marcador (BC)", () => {
    const out = buildTicketText(sampleTicket(), "58mm", { cut: "NONE" });
    assert.ok(!out.includes("CORTE MANUAL"), "sin marcador manual");
    assert.ok(!out.includes("CORTE AUTOMATICO"), "sin marcador auto");
});

test("buildTicketText: cut inválido se trata como NONE (defensa)", () => {
    const out = buildTicketText(sampleTicket(), "58mm", { cut: "RANDOM" });
    assert.ok(!out.includes("CORTE"), "un valor desconocido no inventa marcador");
});

// --- buildTicketText: validation URL --------------------------------------

test("buildTicketText: showValidationQR + data.validationUrl → URL como texto plano", () => {
    const t = sampleTicket({ validationUrl: "https://pos.local/v/abc123" });
    const out = buildTicketText(t, "58mm", { showValidationQR: true });
    assert.ok(out.includes("Validar en:"), "etiqueta de validación presente");
    assert.ok(out.includes("https://pos.local/v/abc123"), "URL emitida sin modificar");
});

test("buildTicketText: showValidationQR sin validationUrl NO inventa validación", () => {
    const out = buildTicketText(sampleTicket(), "58mm", { showValidationQR: true });
    assert.ok(!out.includes("Validar en:"),
        "sin URL en data, el toggle se ignora (representación honesta)");
});

test("buildTicketText: showValidationQR con validationUrl vacío/whitespace → no se rotula", () => {
    const o1 = buildTicketText(sampleTicket({ validationUrl: "" }), "58mm", { showValidationQR: true });
    assert.ok(!o1.includes("Validar en:"), "URL vacía se ignora");
    const o2 = buildTicketText(sampleTicket({ validationUrl: "   " }), "58mm", { showValidationQR: true });
    assert.ok(!o2.includes("Validar en:"), "URL whitespace se ignora");
});

test("buildTicketText: showValidationQR=false NO emite URL aunque haya data.validationUrl", () => {
    const t = sampleTicket({ validationUrl: "https://pos.local/v/abc123" });
    const out = buildTicketText(t, "58mm", { showValidationQR: false });
    assert.ok(!out.includes("Validar en:"), "toggle apagado respeta la decisión del admin");
    assert.ok(!out.includes("https://pos.local/v/abc123"), "URL no se emite");
});

// --- buildTicketText: combinación realista --------------------------------

test("buildTicketText: config típica guardada (showTaxes=true, thankYou configurado, cut=AUTO)", () => {
    const t = sampleTicket();
    const out = buildTicketText(t, "80mm", {
        columns: 48,
        store: { name: "Mi Super", nit: "NIT 900.123" },
        showTaxes: true,
        thankYou: "¡Gracias por su compra!",
        cut: "AUTO",
    });
    assert.ok(out.includes("Mi Super"), "override de store se aplica");
    assert.ok(out.includes("IVA / IMPUESTOS"), "taxes activados");
    assert.ok(out.includes("¡Gracias por su compra!"), "thankYou activo");
    assert.ok(out.includes("CORTE AUTOMATICO"), "marcador auto presente");
    assert.ok(!out.includes("SURTIFAMILIAR"), "no debe aparecer el default");
});

test("buildTicketText: ancho 80mm cambia columnas pero preserva estructura", () => {
    const wide = buildTicketText(sampleTicket(), "80mm");
    const narrow = buildTicketText(sampleTicket(), "58mm");
    assert.notEqual(wide, narrow, "los dos anchos producen outputs distintos");
    assert.ok(wide.length > narrow.length, "80mm da líneas más anchas");
    // Las líneas de 80mm deben tener 48 caracteres de ancho (separador).
    const wideSep = wide.split("\n").find((l) => /^-+$/.test(l));
    assert.ok(wideSep && wideSep.length === 48, "separador de 80mm = 48 chars");
    const narrowSep = narrow.split("\n").find((l) => /^-+$/.test(l));
    assert.ok(narrowSep && narrowSep.length === 32, "separador de 58mm = 32 chars");
});

// --- buildTicketText: valores de usuario en texto plano -------------------

test("buildTicketText: valores de usuario entran como texto crudo (no HTML)", () => {
    // buildTicketText produce TEXTO monoespaciado, no HTML. Verificamos que
    // los valores "peligrosos" aparezcan tal cual, sin escape ni corrupción;
    // el escape de HTML corre en printThermalTicket al generar el iframe.
    const t = sampleTicket({ ticketNumber: "<a&b>", clientName: "O'<brien>" });
    const out = buildTicketText(t, "58mm");
    assert.ok(out.includes("TICKET #<a&b>"), "ticketNumber plano");
    assert.ok(out.includes("Cliente: O'<BRIEN>"), "clientName plano");
});

// --- escapeHtml -----------------------------------------------------------

test("escapeHtml: escapa & < > \" ' en el orden correcto", () => {
    assert.equal(escapeHtml("a & b"), "a &amp; b");
    assert.equal(escapeHtml("<tag>"), "&lt;tag&gt;");
    assert.equal(escapeHtml('say "hi"'), "say &quot;hi&quot;");
    assert.equal(escapeHtml("it's"), "it&#39;s");
});

test("escapeHtml: & se escapa PRIMERO para no corromper los demás escapes", () => {
    // Si & se escapa después, "<&>" podría convertirse en "&lt;&amp;&gt;"
    // pero si el orden fuera incorrecto podría quedar "&amp;lt;" etc.
    assert.equal(escapeHtml("<&>"), "&lt;&amp;&gt;");
    // Un payload XSS clásico no se puede inyectar en atributos.
    assert.equal(
        escapeHtml('"><script>alert(1)</script>'),
        "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
});

test("escapeHtml: coerciona entradas no-string sin lanzar", () => {
    assert.equal(escapeHtml(123), "123");
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
    assert.equal(escapeHtml(true), "true");
});

test("escapeHtml: HTML inyectado en una URL de logo queda neutralizado como atributo", () => {
    // El consumidor típico: `<img src="${escapeHtml(data.logoUrl)}" />`.
    // Un intento de romper el atributo con " no debe lograr salir del atributo.
    const malicious = 'https://evil.example/x" onerror="alert(1)';
    const escaped = escapeHtml(malicious);
    assert.ok(!escaped.includes('"'), "la comilla cruda no debe quedar en el output");
    assert.ok(escaped.includes("&quot;"), "la comilla se neutraliza como &quot;");
});


// --- formatDateTime: defensa pura contra fechas inválidas -----------------
//
// Historial: `useNewSale.ts` guardaba `lastReceipt.date` con
// `new Date().toLocaleString()`. `saleToTicket` lo reparseaba con
// `new Date(string)`, lo que según locale producía Invalid Date y el
// `getHours()` directo propagaba `NaN` → la tirilla térmica real
// imprimía `NaN/NaN/NaN NaN:NaN NaN`. Estos tests fijan el nuevo
// contrato: la fuente guarda ISO 8601 y `formatDateTime` nunca puede
// escupir NaN, incluso si llega basura.
//

test("formatDateTime: Date válido se renderiza como dd/MM/yyyy hh:mm AM", () => {
    const d = new Date(2026, 9, 5, 10, 30, 0); // 2026-10-05 10:30 AM local
    assert.equal(formatDateTime(d), "05/10/2026 10:30 AM");
});

test("formatDateTime: ISO 8601 string parseable se trata como Date válido", () => {
    // ISO 8601 UTC parseable sin ambigüedad: usamos construcción explícita
    // para no depender del offset local del runner que ejecuta los tests.
    const iso = new Date(2026, 9, 5, 14, 45, 0).toISOString();
    const out = formatDateTime(iso);
    // Debe tener el shape canónico; comparamos la forma, no la hora exacta,
    // porque formatDateTime usa getters locales y el ISO viaja en UTC.
    assert.match(out, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} (AM|PM)$/,
        "formato dd/MM/yyyy hh:mm AM/PM");
    assert.ok(!out.includes("NaN"), "jamás NaN para ISO 8601 válido");
});

test("formatDateTime: epoch number parseable se trata como Date válido", () => {
    const d = new Date(2026, 9, 5, 10, 30, 0);
    const out = formatDateTime(d.getTime());
    assert.match(out, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} (AM|PM)$/);
    assert.ok(!out.includes("NaN"));
});

test("formatDateTime: Invalid Date → literal FECHA NO DISPONIBLE (nunca NaN)", () => {
    const invalid = new Date("not a date");
    assert.ok(Number.isNaN(invalid.getTime()), "pre-condición: Date inválido");
    const out = formatDateTime(invalid);
    assert.equal(out, INVALID_DATE_LABEL);
    assert.equal(INVALID_DATE_LABEL, "FECHA NO DISPONIBLE",
        "literal público, estable; cualquier consumidor puede comparar contra él");
    assert.ok(!out.includes("NaN"), "literal estable, sin NaN");
});

test("formatDateTime: string indescifrable (locale sucio) → FECHA NO DISPONIBLE", () => {
    // Antes esto era exactamente lo que `useNewSale.ts` guardaba y lo que
    // reventaba al reparsear: un `toLocaleString()` colombiano con coma,
    // "p. m." y espacio no-rompible. `new Date(ese string)` ⇒ Invalid Date.
    const localeDirty = "14/10/2026, 12:48:15\u00a0p. m.";
    const out = formatDateTime(localeDirty);
    assert.equal(out, INVALID_DATE_LABEL);
    assert.ok(!out.includes("NaN"));
});

test("formatDateTime: undefined/null → FECHA NO DISPONIBLE", () => {
    assert.equal(formatDateTime(undefined), INVALID_DATE_LABEL);
    assert.equal(formatDateTime(null), INVALID_DATE_LABEL);
});

test("formatDateTime: NaN numérico → FECHA NO DISPONIBLE", () => {
    assert.equal(formatDateTime(Number.NaN), INVALID_DATE_LABEL);
});

test("formatDateTime: objeto arbitrario que no es Date → FECHA NO DISPONIBLE", () => {
    assert.equal(formatDateTime({}), INVALID_DATE_LABEL);
    assert.equal(formatDateTime([]), INVALID_DATE_LABEL);
    assert.equal(formatDateTime(true), INVALID_DATE_LABEL);
});

// --- buildTicketText: integración de la defensa de fecha -----------------

test("buildTicketText: Invalid Date NUNCA produce 'NaN' en el output y rotula FECHA NO DISPONIBLE", () => {
    const invalid = new Date("not a date");
    const out = buildTicketText(sampleTicket({ date: invalid }), "58mm");
    assert.ok(!out.includes("NaN"),
        "la tirilla térmica real jamás puede imprimir NaN");
    assert.ok(out.includes(INVALID_DATE_LABEL),
        "debe aparecer el literal estable en lugar de la fecha corrupta");
});

test("buildTicketText: date undefined tampoco rompe el ticket (defensa en profundidad)", () => {
    // El contrato público es `date: Date`, pero si un consumidor olvida
    // pasarla, preferimos imprimir el literal honesto antes que NaN.
    const t = sampleTicket();
    delete t.date;
    const out = buildTicketText(t, "58mm");
    assert.ok(!out.includes("NaN"), "sin fecha tampoco imprime NaN");
    assert.ok(out.includes(INVALID_DATE_LABEL),
        "sin fecha, el ticket rotula FECHA NO DISPONIBLE");
});
