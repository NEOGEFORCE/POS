// =============================================================================
// tests/internal-barcode-helpers.test.mjs
//
// Tests contractuales del módulo `src/lib/internal-barcode.mjs`.
//
// El helper es la ÚNICA fuente de verdad del namespace POSINT- en el
// frontend: reconoce códigos, extrae los códigos de error estables del
// backend y traduce los 6+1 códigos del contrato a mensajes humanos.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";

import {
    INTERNAL_BARCODE_PREFIX,
    INTERNAL_BARCODE_HEX_MIN,
    INTERNAL_BARCODE_HEX_MAX,
    INTERNAL_BARCODE_DEFAULT_TTL_SECONDS,
    INTERNAL_BARCODE_ERROR_CODES,
    INTERNAL_BARCODE_SOURCES,
    buildReservePayload,
    extractInternalErrorCode,
    isInternalBarcode,
    isInternalBarcodeError,
    isValidInternalBarcode,
    normalizeInternalBarcode,
    translateInternalErrorCode,
} from "../src/lib/internal-barcode.mjs";

// ---------------------------------------------------------------------------
// Constantes del contrato.
// ---------------------------------------------------------------------------

test("INTERNAL_BARCODE_PREFIX es 'POSINT-' exacto (contrato con backend)", () => {
    assert.equal(INTERNAL_BARCODE_PREFIX, "POSINT-");
});

test("Longitud hex: mínimo 8, máximo 24 (coincide con migración 024)", () => {
    assert.equal(INTERNAL_BARCODE_HEX_MIN, 8);
    assert.equal(INTERNAL_BARCODE_HEX_MAX, 24);
});

test("TTL por defecto 15 minutos (900s)", () => {
    assert.equal(INTERNAL_BARCODE_DEFAULT_TTL_SECONDS, 900);
});

test("Los 7 códigos estables de error están presentes y son strings", () => {
    const expected = [
        "INTERNAL_RESERVATION_NOT_FOUND",
        "INTERNAL_RESERVATION_EXPIRED",
        "INTERNAL_RESERVATION_ALREADY_USED",
        "INTERNAL_BARCODE_REQUIRES_RESERVATION",
        "INTERNAL_BARCODE_FORMAT_INVALID",
        "INTERNAL_PRODUCT_BARCODE_IN_USE",
        "INTERNAL_NAMESPACE_FORBIDDEN",
    ];
    const got = Object.values(INTERNAL_BARCODE_ERROR_CODES).sort();
    assert.deepEqual(got, expected.sort());
});

test("Los 3 sources enumerados coinciden con el enum del backend", () => {
    assert.equal(INTERNAL_BARCODE_SOURCES.PRODUCT_FORM, "product_form");
    assert.equal(INTERNAL_BARCODE_SOURCES.RECEPTION, "reception");
    assert.equal(INTERNAL_BARCODE_SOURCES.OTHER, "other");
});

// ---------------------------------------------------------------------------
// normalizeInternalBarcode.
// ---------------------------------------------------------------------------

test("normalizeInternalBarcode: trim + toUpper", () => {
    assert.equal(normalizeInternalBarcode("  posint-abcdef01  "), "POSINT-ABCDEF01");
    assert.equal(normalizeInternalBarcode("POSINT-abc"), "POSINT-ABC");
});

test("normalizeInternalBarcode: valores raros se vuelven string vacío sin lanzar", () => {
    assert.equal(normalizeInternalBarcode(null), "");
    assert.equal(normalizeInternalBarcode(undefined), "");
    assert.equal(normalizeInternalBarcode(""), "");
    // Un número termina siendo su representación en mayúsculas.
    assert.equal(normalizeInternalBarcode(123), "123");
});

// ---------------------------------------------------------------------------
// isInternalBarcode: pertenencia al namespace.
// ---------------------------------------------------------------------------

test("isInternalBarcode: reconoce POSINT-* en cualquier casing y con espacios", () => {
    assert.equal(isInternalBarcode("POSINT-ABCDEF01"), true);
    assert.equal(isInternalBarcode("posint-abcdef01"), true);
    assert.equal(isInternalBarcode("  POSINT-ABCDEF01  "), true);
});

test("isInternalBarcode: rechaza códigos comerciales y cadenas raras", () => {
    assert.equal(isInternalBarcode("7701234567890"), false);
    assert.equal(isInternalBarcode("LC-ABC"), false);
    assert.equal(isInternalBarcode("ABC-POSINT-"), false, "'POSINT-' debe estar al principio");
    assert.equal(isInternalBarcode(""), false);
    assert.equal(isInternalBarcode(null), false);
    assert.equal(isInternalBarcode(undefined), false);
});

// ---------------------------------------------------------------------------
// isValidInternalBarcode: shape estricto.
// ---------------------------------------------------------------------------

test("isValidInternalBarcode: acepta sólo 8..24 nibbles hex uppercase (tras normalizar)", () => {
    // Mínimo (8 nibbles).
    assert.equal(isValidInternalBarcode("POSINT-ABCDEF01"), true);
    // Máximo (24 nibbles).
    assert.equal(isValidInternalBarcode("POSINT-" + "A".repeat(24)), true);
    // Lowercase se normaliza antes de testear.
    assert.equal(isValidInternalBarcode("posint-abcdef01"), true);
});

test("isValidInternalBarcode: rechaza longitudes fuera de rango", () => {
    // 7 nibbles — demasiado corto.
    assert.equal(isValidInternalBarcode("POSINT-ABCDEF0"), false);
    // 25 nibbles — demasiado largo.
    assert.equal(isValidInternalBarcode("POSINT-" + "A".repeat(25)), false);
});

test("isValidInternalBarcode: rechaza caracteres no hex", () => {
    assert.equal(isValidInternalBarcode("POSINT-ZZZZZZZZ"), false);
    assert.equal(isValidInternalBarcode("POSINT-ABCDEFG1"), false);
    assert.equal(isValidInternalBarcode("POSINT-ABCDEF-1"), false);
});

// ---------------------------------------------------------------------------
// extractInternalErrorCode: reconocer los dos shapes del backend.
// ---------------------------------------------------------------------------

test("extractInternalErrorCode: shape SendError (error.code anidado)", () => {
    const err = {
        data: {
            success: false,
            error: {
                code: INTERNAL_BARCODE_ERROR_CODES.ALREADY_USED,
                message: "ya se consumió",
            },
        },
    };
    assert.equal(extractInternalErrorCode(err), INTERNAL_BARCODE_ERROR_CODES.ALREADY_USED);
});

test("extractInternalErrorCode: shape plano (code en la raíz, p.ej. GET /:code 404)", () => {
    const err = {
        data: {
            error: "reserva no encontrada",
            code: INTERNAL_BARCODE_ERROR_CODES.NOT_FOUND,
        },
    };
    assert.equal(extractInternalErrorCode(err), INTERNAL_BARCODE_ERROR_CODES.NOT_FOUND);
});

test("extractInternalErrorCode: ignora códigos desconocidos (defensa en profundidad)", () => {
    const err = { data: { error: { code: "SOMETHING_ELSE" } } };
    assert.equal(extractInternalErrorCode(err), null);
});

test("extractInternalErrorCode: devuelve null ante shapes inesperados", () => {
    assert.equal(extractInternalErrorCode(null), null);
    assert.equal(extractInternalErrorCode(undefined), null);
    assert.equal(extractInternalErrorCode("string"), null);
    assert.equal(extractInternalErrorCode({}), null);
    assert.equal(extractInternalErrorCode({ data: {} }), null);
    assert.equal(extractInternalErrorCode({ data: { error: {} } }), null);
});

// ---------------------------------------------------------------------------
// translateInternalErrorCode: cubre los 6+1 casos.
// ---------------------------------------------------------------------------

test("translateInternalErrorCode: devuelve texto en ES para cada código estable", () => {
    for (const code of Object.values(INTERNAL_BARCODE_ERROR_CODES)) {
        const msg = translateInternalErrorCode(code);
        assert.ok(typeof msg === "string" && msg.length > 0,
            `El código ${code} debe producir un mensaje no vacío`);
    }
});

test("translateInternalErrorCode: null/undefined/unknown devuelven null", () => {
    assert.equal(translateInternalErrorCode(null), null);
    assert.equal(translateInternalErrorCode(undefined), null);
    assert.equal(translateInternalErrorCode(""), null);
    assert.equal(translateInternalErrorCode("UNKNOWN_CODE"), null);
});

test("translateInternalErrorCode: 409 PRODUCT_IN_USE sugiere Regenerar explícitamente", () => {
    const msg = translateInternalErrorCode(INTERNAL_BARCODE_ERROR_CODES.PRODUCT_IN_USE);
    assert.ok(/regenerar/i.test(msg || ""),
        "El mensaje de 409 PRODUCT_IN_USE debe pedir regenerar.");
});

// ---------------------------------------------------------------------------
// isInternalBarcodeError: combinación de los dos helpers anteriores.
// ---------------------------------------------------------------------------

test("isInternalBarcodeError: true cuando hay un código conocido", () => {
    const err = { data: { error: { code: INTERNAL_BARCODE_ERROR_CODES.EXPIRED } } };
    assert.equal(isInternalBarcodeError(err), true);
});

test("isInternalBarcodeError: false para errores sin código estable", () => {
    assert.equal(isInternalBarcodeError({ data: { error: "fallo genérico" } }), false);
    assert.equal(isInternalBarcodeError(new Error("boom")), false);
    assert.equal(isInternalBarcodeError(null), false);
});

// ---------------------------------------------------------------------------
// buildReservePayload: defaults sanos y clamp del hexLen.
// ---------------------------------------------------------------------------

test("buildReservePayload: valores por defecto cuando no se pasa nada", () => {
    const p = buildReservePayload();
    assert.equal(p.source, INTERNAL_BARCODE_SOURCES.PRODUCT_FORM);
    assert.equal(p.note, "");
    assert.equal(p.hexLen, 0, "hexLen=0 señaliza al backend que use su default");
    assert.equal(p.ttlSeconds, 0, "ttlSeconds=0 señaliza al backend que use su default");
});

test("buildReservePayload: source override funciona", () => {
    const p = buildReservePayload({ source: INTERNAL_BARCODE_SOURCES.RECEPTION });
    assert.equal(p.source, INTERNAL_BARCODE_SOURCES.RECEPTION);
});

test("buildReservePayload: hexLen fuera de rango se clampa a [8..24]", () => {
    assert.equal(buildReservePayload({ hexLen: 3 }).hexLen, 8);
    assert.equal(buildReservePayload({ hexLen: 50 }).hexLen, 24);
    assert.equal(buildReservePayload({ hexLen: 12 }).hexLen, 12);
});

test("buildReservePayload: ttlSeconds negativo se normaliza a 0 (sin reservas eternas)", () => {
    assert.equal(buildReservePayload({ ttlSeconds: -100 }).ttlSeconds, 0);
    assert.equal(buildReservePayload({ ttlSeconds: 60 }).ttlSeconds, 60);
});

test("buildReservePayload: valores no numéricos NaN se tratan como 0", () => {
    const p = buildReservePayload({ hexLen: "abc", ttlSeconds: "xyz" });
    assert.equal(p.hexLen, 0);
    assert.equal(p.ttlSeconds, 0);
});
