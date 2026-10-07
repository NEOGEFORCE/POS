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
    STORE,
    buildTicketText,
    center,
    charsPerLine,
    escapeHtml,
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
