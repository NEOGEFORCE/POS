// =============================================================================
// tests/bold-qr-helpers.test.mjs
//
// Tests PUROS para `src/lib/bold-qr-helpers.mjs`. Fijan el contrato que
// consume el `ModalPagoBoldQR` y el stream SSE:
//
//   - Expiración 5 min determinista con reloj inyectado.
//   - Extracción de monto COP honesta (nunca inventa, nunca propaga NaN).
//   - Clasificación de eventos del stream (APROBADO / UNMATCHED /
//     AMBIGUOUS / EXPIRADO / CANCELADO / ERROR / PENDIENTE / desconocido).
//   - Builder de payload para POST /api/pos/pagos-qr/iniciar.
//   - Constantes públicas (merchant verificado + ruta QR).
//
// ACTIVO /qr-bold-breb-code.png:
// -----------------------------------------------------------------------------
// La imagen real entregada por el comercio vive en `public/qr-bold-breb-code.png`.
// Este guardián valida existencia, firma PNG y dimensiones mínimas sin intentar
// decodificar, regenerar ni sustituir el QR financiero.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
    BOLD_MERCHANT,
    BOLD_QR_CSS_MIN,
    BOLD_QR_IMAGE_PATH,
    BOLD_QR_INTENT_TTL_MS,
    BOLD_QR_METHOD_BADGE,
    BOLD_QR_METHOD_LABEL,
    BOLD_QR_MIN_SIDE_PX,
    BOLD_QR_STATUS,
    buildIniciarPayload,
    classifyStreamEvent,
    extractCOPFromMessage,
    formatCountdown,
    isIntentExpired,
    msUntilExpiry,
    parseCOPToken,
} from "../src/lib/bold-qr-helpers.mjs";

// ---------------------------------------------------------------------------
// Constantes del merchant verificado
// ---------------------------------------------------------------------------

test("BOLD_MERCHANT: identidad del comercio Surtifamiliar (constantes públicas)", () => {
    assert.equal(BOLD_MERCHANT.businessName, "SUPERMERCADO SURTIFAMILIAR");
    assert.equal(BOLD_MERCHANT.titular, "Sebastian Sarmiento");
    assert.equal(BOLD_MERCHANT.codigoComercio, "0093097755");
    assert.equal(
        BOLD_MERCHANT.subheader,
        "Titular verificado: Sebastian Sarmiento | Comercio Bre-B: 0093097755",
    );
    assert.equal(
        BOLD_MERCHANT.footer,
        "Titular: Sebastian Sarmiento | Código de comercio: 0093097755",
    );
});

test("BOLD_MERCHANT: inmutable (Object.freeze)", () => {
    assert.ok(Object.isFrozen(BOLD_MERCHANT));
});

test("Etiquetas del método de pago quedan ancladas al UI contract", () => {
    assert.equal(BOLD_QR_METHOD_LABEL, "QR Bold / Bre-B (Nequi, DaviPlata, Bancos)");
    assert.equal(
        BOLD_QR_METHOD_BADGE,
        "Escanea desde Nequi, DaviPlata, Bancolombia o cualquier banco (Bre-B)",
    );
});

test("BOLD_QR_IMAGE_PATH es la ruta pública estática `/qr-bold-breb-code.png`", () => {
    assert.equal(BOLD_QR_IMAGE_PATH, "/qr-bold-breb-code.png");
    assert.equal(BOLD_QR_MIN_SIDE_PX, 260, "mínimo 260 px por lado");
    assert.equal(BOLD_QR_CSS_MIN, "260px");
});

test("public/qr-bold-breb-code.png existe, es PNG y cumple dimensiones mínimas", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const assetPath = join(here, "..", "public", "qr-bold-breb-code.png");
    assert.equal(existsSync(assetPath), true, "Falta el QR real del comercio");

    const bytes = readFileSync(assetPath);
    assert.ok(bytes.length >= 24, "PNG truncado");
    assert.equal(
        bytes.subarray(0, 8).toString("hex"),
        "89504e470d0a1a0a",
        "El activo debe tener firma PNG real, no sólo extensión .png",
    );
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    assert.ok(width >= BOLD_QR_MIN_SIDE_PX, `ancho ${width}px < ${BOLD_QR_MIN_SIDE_PX}px`);
    assert.ok(height >= BOLD_QR_MIN_SIDE_PX, `alto ${height}px < ${BOLD_QR_MIN_SIDE_PX}px`);
});

// ---------------------------------------------------------------------------
// isIntentExpired / msUntilExpiry / formatCountdown
// ---------------------------------------------------------------------------

test("BOLD_QR_INTENT_TTL_MS fija expiración = 15 minutos exactos (flujo asíncrono migración 027)", () => {
    assert.equal(BOLD_QR_INTENT_TTL_MS, 15 * 60 * 1000);
});

test("isIntentExpired: dentro de la ventana de 15 min → false", () => {
    const start = 1_000_000_000_000;
    assert.equal(isIntentExpired(start, start), false);
    assert.equal(isIntentExpired(start, start + 60_000), false, "1 min después → vigente");
    assert.equal(isIntentExpired(start, start + 10 * 60_000), false, "10 min después → vigente");
    assert.equal(isIntentExpired(start, start + 14 * 60_000), false, "14 min después → vigente");
    assert.equal(
        isIntentExpired(start, start + BOLD_QR_INTENT_TTL_MS - 1),
        false,
        "1 ms antes del tope → vigente",
    );
});

test("isIntentExpired: >= 15 min → true (frontera inclusiva en el tope)", () => {
    const start = 1_000_000_000_000;
    assert.equal(isIntentExpired(start, start + BOLD_QR_INTENT_TTL_MS), true);
    assert.equal(isIntentExpired(start, start + BOLD_QR_INTENT_TTL_MS + 1), true);
    assert.equal(isIntentExpired(start, start + 30 * 60_000), true);
});

test("isIntentExpired: entradas inválidas → true (nunca asume vigencia con basura)", () => {
    const now = 1_000_000_000_000;
    assert.equal(isIntentExpired(null, now), true);
    assert.equal(isIntentExpired(undefined, now), true);
    assert.equal(isIntentExpired("basura", now), true);
    assert.equal(isIntentExpired({}, now), true);
    assert.equal(isIntentExpired(NaN, now), true);
    assert.equal(isIntentExpired(now, NaN), true);
});

test("isIntentExpired: acepta Date, ISO string y número (epoch ms)", () => {
    const start = new Date("2026-05-20T10:00:00Z");
    const startMs = start.getTime();
    assert.equal(isIntentExpired(start, startMs + 60_000), false, "Date vigente");
    assert.equal(isIntentExpired(start.toISOString(), startMs + 60_000), false, "ISO vigente");
    assert.equal(isIntentExpired(startMs, startMs + 60_000), false, "número vigente");
    assert.equal(isIntentExpired(start, startMs + BOLD_QR_INTENT_TTL_MS + 60_000), true, "Date expirada (> 15 min)");
});

test("msUntilExpiry: devuelve exactamente los ms restantes, nunca negativo ni NaN", () => {
    const start = 1_000_000_000_000;
    assert.equal(msUntilExpiry(start, start), BOLD_QR_INTENT_TTL_MS);
    assert.equal(msUntilExpiry(start, start + 60_000), BOLD_QR_INTENT_TTL_MS - 60_000);
    assert.equal(msUntilExpiry(start, start + BOLD_QR_INTENT_TTL_MS), 0, "frontera → 0");
    assert.equal(msUntilExpiry(start, start + BOLD_QR_INTENT_TTL_MS + 10_000), 0, "pasada → 0, nunca negativo");
    assert.equal(msUntilExpiry(null, start), 0, "input basura → 0");
    assert.equal(msUntilExpiry(start, NaN), 0, "reloj basura → 0");
});

test("formatCountdown: formato MM:SS con dos dígitos y defensa contra NaN", () => {
    assert.equal(formatCountdown(0), "00:00");
    assert.equal(formatCountdown(1_000), "00:01");
    assert.equal(formatCountdown(59_000), "00:59");
    assert.equal(formatCountdown(60_000), "01:00");
    assert.equal(formatCountdown(5 * 60_000), "05:00");
    assert.equal(formatCountdown(10 * 60_000 + 45_000), "10:45");
    assert.equal(formatCountdown(NaN), "--:--", "defensa: nunca escupe NaN:NaN");
    assert.equal(formatCountdown(-1), "--:--", "defensa: negativo → placeholder");
});

// ---------------------------------------------------------------------------
// extractCOPFromMessage / parseCOPToken
// ---------------------------------------------------------------------------

test("extractCOPFromMessage: patrones reales del bridge MacroDroid", () => {
    assert.equal(extractCOPFromMessage("Recibiste $45.800"), 45800);
    assert.equal(extractCOPFromMessage("Recibiste $45,800"), 45800);
    assert.equal(extractCOPFromMessage("Recibiste $1.234.567"), 1234567);
    assert.equal(extractCOPFromMessage("Recibiste $1,234,567"), 1234567);
    assert.equal(extractCOPFromMessage("Pago recibido por $100"), 100);
    assert.equal(extractCOPFromMessage("Transferencia Bre-B $50.000 de PEPE"), 50000);
    assert.equal(extractCOPFromMessage("Monto $45.800,00 COP"), 45800, "centavos ignorados");
    assert.equal(extractCOPFromMessage("Monto $45,800.00 COP"), 45800);
});

test("extractCOPFromMessage: espacios y formato relajado alrededor del $", () => {
    assert.equal(extractCOPFromMessage("Recibiste $ 45.800"), 45800);
    assert.equal(extractCOPFromMessage("[Bold] $20.000 confirmados"), 20000);
});

test("extractCOPFromMessage: entradas sin monto → null (nunca inventa)", () => {
    assert.equal(extractCOPFromMessage("Pago recibido"), null);
    assert.equal(extractCOPFromMessage(""), null);
    assert.equal(extractCOPFromMessage("   "), null);
    assert.equal(extractCOPFromMessage("$"), null);
    assert.equal(extractCOPFromMessage("$0"), null, "monto 0 se descarta");
    assert.equal(extractCOPFromMessage("$-100"), null, "monto negativo se descarta");
});

test("extractCOPFromMessage: entradas no-string → null, nunca lanza", () => {
    assert.equal(extractCOPFromMessage(null), null);
    assert.equal(extractCOPFromMessage(undefined), null);
    assert.equal(extractCOPFromMessage(45800), null, "número crudo no coincide con 'Recibiste $...'");
    assert.equal(extractCOPFromMessage({}), null);
    assert.equal(extractCOPFromMessage([]), null);
    assert.equal(extractCOPFromMessage(true), null);
});

test("parseCOPToken: parser directo (bridge con monto limpio)", () => {
    assert.equal(parseCOPToken("45800"), 45800);
    assert.equal(parseCOPToken("45.800"), 45800);
    assert.equal(parseCOPToken("1.234.567"), 1234567);
    assert.equal(parseCOPToken("1,234,567"), 1234567);
    assert.equal(parseCOPToken("45800,00"), 45800, "centavos descartados");
    assert.equal(parseCOPToken("0"), null);
    assert.equal(parseCOPToken(""), null);
    assert.equal(parseCOPToken("abc"), null);
    assert.equal(parseCOPToken(null), null);
    assert.equal(parseCOPToken(undefined), null);
});

test("parseCOPToken: formatos ambiguos vs decimales (centavos pequeños descartados)", () => {
    // "1234.5" tiene 4 dígitos antes del `.` y 1 dígito después:
    // interpretado como entero + centavos → 1234 (centavos descartados).
    assert.equal(parseCOPToken("1234.5"), 1234);
    // "12,34" tiene primer grupo de 2 dígitos: el parser lo trata como
    // 12 (centavos de 2 chars descartados). El monto 12 es válido (>0).
    assert.equal(parseCOPToken("12,34"), 12);
    // "1.23.45" tiene grupos (1, 23, 45): el primero no es 3 dígitos y
    // el último es de 2 → no es ni miles ni decimal limpio → null.
    assert.equal(parseCOPToken("1.23.456"), null,
        "formato con grupos de miles no consistentes y último de 3 → no match");
});

// ---------------------------------------------------------------------------
// classifyStreamEvent
// ---------------------------------------------------------------------------

test("classifyStreamEvent: APROBADO → action=approve (dispara cierre + impresión)", () => {
    assert.deepEqual(classifyStreamEvent({ status: "APROBADO" }), { action: "approve" });
    // Case-insensitive por defensa (el backend emite UPPER, pero toleramos variantes).
    assert.deepEqual(classifyStreamEvent({ status: "aprobado" }), { action: "approve" });
});

test("classifyStreamEvent: UNMATCHED/AMBIGUOUS → require-manual (nunca aprobar automático)", () => {
    const u = classifyStreamEvent({ status: "UNMATCHED" });
    assert.equal(u.action, "require-manual");
    assert.equal(u.reason, "UNMATCHED");
    const a = classifyStreamEvent({ status: "AMBIGUOUS", reason: "2 pendientes al mismo monto" });
    assert.equal(a.action, "require-manual");
    assert.equal(a.reason, "2 pendientes al mismo monto");
});

test("classifyStreamEvent: EXPIRADO / CANCELADO / ERROR", () => {
    assert.deepEqual(classifyStreamEvent({ status: "EXPIRADO" }), { action: "expire" });
    assert.deepEqual(classifyStreamEvent({ status: "CANCELADO" }), { action: "cancel" });
    const err = classifyStreamEvent({ status: "ERROR", reason: "Backend sin webhook" });
    assert.equal(err.action, "error");
    assert.equal(err.reason, "Backend sin webhook");
});

test("classifyStreamEvent: PENDIENTE → wait (el modal sigue esperando)", () => {
    assert.deepEqual(classifyStreamEvent({ status: "PENDIENTE" }), { action: "wait" });
});

test("classifyStreamEvent: entradas inválidas o status desconocido → ignore", () => {
    assert.deepEqual(classifyStreamEvent(null), { action: "ignore" });
    assert.deepEqual(classifyStreamEvent(undefined), { action: "ignore" });
    assert.deepEqual(classifyStreamEvent({}), { action: "ignore" });
    assert.deepEqual(classifyStreamEvent({ status: 123 }), { action: "ignore" });
    assert.deepEqual(classifyStreamEvent({ status: "FOO" }), { action: "ignore" });
});

// ---------------------------------------------------------------------------
// buildIniciarPayload
// ---------------------------------------------------------------------------

test("buildIniciarPayload: shape snake_case que exige el backend", () => {
    const p = buildIniciarPayload({
        caja_id: "CAJA-1",
        monto: 45800,
        venta_temp_id: "temp-abc-123",
    });
    assert.deepEqual(p, { caja_id: "CAJA-1", monto: 45800, venta_temp_id: "temp-abc-123" });
});

test("buildIniciarPayload: monto se castea a entero positivo (int64 por contrato)", () => {
    const p = buildIniciarPayload({ caja_id: 1, monto: 45800.75, venta_temp_id: "t" });
    assert.equal(p.monto, 45800, "floor para no exceder int64 negociado");
});

test("buildIniciarPayload: rechaza monto <=0, NaN o venta_temp_id vacío", () => {
    assert.equal(buildIniciarPayload({ caja_id: 1, monto: 0, venta_temp_id: "t" }), null);
    assert.equal(buildIniciarPayload({ caja_id: 1, monto: -100, venta_temp_id: "t" }), null);
    assert.equal(buildIniciarPayload({ caja_id: 1, monto: NaN, venta_temp_id: "t" }), null);
    assert.equal(buildIniciarPayload({ caja_id: 1, monto: 100, venta_temp_id: "" }), null);
    assert.equal(buildIniciarPayload({ caja_id: 1, monto: 100, venta_temp_id: "   " }), null);
    assert.equal(buildIniciarPayload({ caja_id: "", monto: 100, venta_temp_id: "t" }), null);
    assert.equal(buildIniciarPayload({ caja_id: null, monto: 100, venta_temp_id: "t" }), null);
    assert.equal(buildIniciarPayload({}), null);
});

test("buildIniciarPayload: venta_temp_id se trimea (defensa contra espacios del cliente)", () => {
    const p = buildIniciarPayload({ caja_id: "C", monto: 100, venta_temp_id: "  temp-id  " });
    assert.equal(p.venta_temp_id, "temp-id");
});

// ---------------------------------------------------------------------------
// BOLD_QR_STATUS: enum sellado
// ---------------------------------------------------------------------------

test("BOLD_QR_STATUS: enum freezable y con los 7 estados contractuales", () => {
    assert.ok(Object.isFrozen(BOLD_QR_STATUS));
    assert.deepEqual(
        Object.keys(BOLD_QR_STATUS).sort(),
        [
            "AMBIGUOUS",
            "APROBADO",
            "CANCELADO",
            "ERROR",
            "EXPIRADO",
            "PENDIENTE",
            "UNMATCHED",
        ],
    );
});
