// =============================================================================
// tests/bold-qr-unassigned-helpers.test.mjs
//
// Contrato puro de los helpers de "pagos sin asignar" (migración 027b):
//
//   - `classifyUnassignedPayment` acepta el shape canónico y rechaza
//     entradas inválidas (nunca inventa).
//   - `canAssignToPending` compara montos como enteros tras Math.round
//     y rechaza entradas inválidas.
//   - `buildAsignarPayload` emite snake_case que exige el backend.
//   - `extractAssignErrorCode` lee las variantes conocidas de un error
//     ApiError y devuelve `null` si no reconoce el code.
//   - `describeAssignErrorCode` mapea cada code a copy en español
//     colombiano; fallback honesto para desconocidos.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";

import {
    BOLD_QR_ASSIGN_ERROR_CODE,
    buildAsignarPayload,
    canAssignToPending,
    classifyUnassignedPayment,
    describeAssignErrorCode,
    extractAssignErrorCode,
} from "../src/lib/bold-qr-helpers.mjs";

// ---------------------------------------------------------------------------
// BOLD_QR_ASSIGN_ERROR_CODE
// ---------------------------------------------------------------------------

test("BOLD_QR_ASSIGN_ERROR_CODE: enum sellado con los 5 códigos contractuales", () => {
    assert.ok(Object.isFrozen(BOLD_QR_ASSIGN_ERROR_CODE));
    assert.equal(BOLD_QR_ASSIGN_ERROR_CODE.EVENT_ALREADY_ASSIGNED, "QR_EVENT_ALREADY_ASSIGNED");
    assert.equal(BOLD_QR_ASSIGN_ERROR_CODE.AMOUNT_MISMATCH, "QR_AMOUNT_MISMATCH");
    assert.equal(BOLD_QR_ASSIGN_ERROR_CODE.INTENT_ALREADY_TERMINAL, "QR_INTENT_ALREADY_TERMINAL");
    assert.equal(BOLD_QR_ASSIGN_ERROR_CODE.EVENT_NOT_FOUND, "QR_EVENT_NOT_FOUND");
    assert.equal(BOLD_QR_ASSIGN_ERROR_CODE.INTENT_NOT_FOUND, "QR_INTENT_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// classifyUnassignedPayment
// ---------------------------------------------------------------------------

test("classifyUnassignedPayment: shape canónico AMBIGUOUS parsea correctamente", () => {
    const out = classifyUnassignedPayment({
        eventId: 42,
        amountCop: 45800,
        receivedAt: "2026-10-23T14:00:00Z",
        status: "AMBIGUOUS",
        resumen: "SMS 09:30 — Transferencia Bre-B",
    });
    assert.deepEqual(out, {
        eventId: 42,
        amountCop: 45800,
        receivedAt: "2026-10-23T14:00:00Z",
        status: "AMBIGUOUS",
        resumen: "SMS 09:30 — Transferencia Bre-B",
    });
});

test("classifyUnassignedPayment: UNMATCHED válido", () => {
    const out = classifyUnassignedPayment({
        eventId: 7,
        amountCop: 10000,
        receivedAt: "2026-10-23T14:00:00Z",
        status: "UNMATCHED",
        resumen: "",
    });
    assert.ok(out);
    assert.equal(out.status, "UNMATCHED");
    assert.equal(out.resumen, "");
});

test("classifyUnassignedPayment: case-insensitive en status", () => {
    const out = classifyUnassignedPayment({
        eventId: 1,
        amountCop: 100,
        receivedAt: "2026-01-01T00:00:00Z",
        status: "ambiguous",
        resumen: "",
    });
    assert.ok(out);
    assert.equal(out.status, "AMBIGUOUS");
});

test("classifyUnassignedPayment: eventId como string numérico se acepta", () => {
    const out = classifyUnassignedPayment({
        eventId: "123",
        amountCop: 100,
        receivedAt: "2026-01-01T00:00:00Z",
        status: "UNMATCHED",
    });
    assert.ok(out);
    assert.equal(out.eventId, 123);
});

test("classifyUnassignedPayment: rechaza eventId no-positivo", () => {
    for (const bad of [0, -1, NaN, Infinity, null, "abc", "0", ""]) {
        assert.equal(
            classifyUnassignedPayment({
                eventId: bad,
                amountCop: 100,
                receivedAt: "2026-01-01T00:00:00Z",
                status: "AMBIGUOUS",
            }),
            null,
            `eventId=${JSON.stringify(bad)} debe rechazarse`,
        );
    }
});

test("classifyUnassignedPayment: rechaza amountCop no-positivo", () => {
    for (const bad of [0, -100, NaN, "abc", null]) {
        assert.equal(
            classifyUnassignedPayment({
                eventId: 1,
                amountCop: bad,
                receivedAt: "2026-01-01T00:00:00Z",
                status: "AMBIGUOUS",
            }),
            null,
            `amountCop=${JSON.stringify(bad)} debe rechazarse`,
        );
    }
});

test("classifyUnassignedPayment: rechaza receivedAt vacío o no-string", () => {
    assert.equal(
        classifyUnassignedPayment({
            eventId: 1,
            amountCop: 100,
            receivedAt: "",
            status: "AMBIGUOUS",
        }),
        null,
    );
    assert.equal(
        classifyUnassignedPayment({
            eventId: 1,
            amountCop: 100,
            receivedAt: null,
            status: "AMBIGUOUS",
        }),
        null,
    );
});

test("classifyUnassignedPayment: rechaza status fuera del enum", () => {
    for (const bad of ["APPROVED", "PENDIENTE", "RANDOM", "", 42, null]) {
        assert.equal(
            classifyUnassignedPayment({
                eventId: 1,
                amountCop: 100,
                receivedAt: "2026-01-01T00:00:00Z",
                status: bad,
            }),
            null,
            `status=${JSON.stringify(bad)} debe rechazarse`,
        );
    }
});

test("classifyUnassignedPayment: entradas no-objeto → null", () => {
    assert.equal(classifyUnassignedPayment(null), null);
    assert.equal(classifyUnassignedPayment(undefined), null);
    assert.equal(classifyUnassignedPayment("foo"), null);
    assert.equal(classifyUnassignedPayment(42), null);
});

test("classifyUnassignedPayment: amountCop decimal se redondea (float → int defensivo)", () => {
    const out = classifyUnassignedPayment({
        eventId: 1,
        amountCop: 100.4,
        receivedAt: "2026-01-01T00:00:00Z",
        status: "AMBIGUOUS",
    });
    assert.ok(out);
    assert.equal(out.amountCop, 100);
});

// ---------------------------------------------------------------------------
// canAssignToPending
// ---------------------------------------------------------------------------

test("canAssignToPending: montos exactamente iguales → true", () => {
    assert.equal(
        canAssignToPending({ amountCop: 45800 }, { amountCop: 45800 }),
        true,
    );
});

test("canAssignToPending: ventana de redondeo (floats muy cercanos) → true", () => {
    assert.equal(
        canAssignToPending({ amountCop: 45800.4 }, { amountCop: 45799.6 }),
        true,
        "ambos redondean a 45800",
    );
});

test("canAssignToPending: montos distintos → false", () => {
    assert.equal(
        canAssignToPending({ amountCop: 45800 }, { amountCop: 50000 }),
        false,
    );
    assert.equal(
        canAssignToPending({ amountCop: 100 }, { amountCop: 101 }),
        false,
    );
});

test("canAssignToPending: entradas inválidas → false (nunca inventa)", () => {
    assert.equal(canAssignToPending(null, { amountCop: 100 }), false);
    assert.equal(canAssignToPending({ amountCop: 100 }, null), false);
    assert.equal(canAssignToPending({ amountCop: 0 }, { amountCop: 0 }), false);
    assert.equal(canAssignToPending({ amountCop: -1 }, { amountCop: -1 }), false);
    assert.equal(canAssignToPending({ amountCop: NaN }, { amountCop: 100 }), false);
    assert.equal(canAssignToPending({ amountCop: "100" }, { amountCop: 100 }), false,
        "string crudo no cuenta — defensa contra typos del backend");
});

// ---------------------------------------------------------------------------
// buildAsignarPayload
// ---------------------------------------------------------------------------

test("buildAsignarPayload: shape snake_case que exige el backend", () => {
    const out = buildAsignarPayload({
        venta_temp_id: "vt_abcdef12345",
        event_id: 42,
    });
    assert.deepEqual(out, {
        venta_temp_id: "vt_abcdef12345",
        event_id: 42,
    });
});

test("buildAsignarPayload: event_id como string numérico se acepta", () => {
    const out = buildAsignarPayload({
        venta_temp_id: "vt_abcdef12345",
        event_id: "7",
    });
    assert.ok(out);
    assert.equal(out.event_id, 7);
});

test("buildAsignarPayload: trimea venta_temp_id", () => {
    const out = buildAsignarPayload({
        venta_temp_id: "   vt_abcdef12345   ",
        event_id: 1,
    });
    assert.ok(out);
    assert.equal(out.venta_temp_id, "vt_abcdef12345");
});

test("buildAsignarPayload: rechaza venta_temp_id vacío o no-string", () => {
    assert.equal(buildAsignarPayload({ venta_temp_id: "", event_id: 1 }), null);
    assert.equal(buildAsignarPayload({ venta_temp_id: "   ", event_id: 1 }), null);
    assert.equal(buildAsignarPayload({ venta_temp_id: null, event_id: 1 }), null);
    assert.equal(buildAsignarPayload({ venta_temp_id: 42, event_id: 1 }), null);
    assert.equal(buildAsignarPayload({}), null);
});

test("buildAsignarPayload: rechaza event_id <= 0, NaN o no-numérico", () => {
    for (const bad of [0, -1, NaN, "0", "-1", "abc", "", null, undefined]) {
        assert.equal(
            buildAsignarPayload({ venta_temp_id: "vt_abc", event_id: bad }),
            null,
            `event_id=${JSON.stringify(bad)} debe rechazarse`,
        );
    }
});

test("buildAsignarPayload: input no-objeto → null", () => {
    assert.equal(buildAsignarPayload(null), null);
    assert.equal(buildAsignarPayload(undefined), null);
    assert.equal(buildAsignarPayload("foo"), null);
});

// ---------------------------------------------------------------------------
// extractAssignErrorCode
// ---------------------------------------------------------------------------

test("extractAssignErrorCode: lee err.code canónico", () => {
    const err = { code: "QR_AMOUNT_MISMATCH", message: "mismatch" };
    assert.equal(extractAssignErrorCode(err), "QR_AMOUNT_MISMATCH");
});

test("extractAssignErrorCode: lee err.body.code", () => {
    const err = { body: { code: "QR_EVENT_NOT_FOUND" } };
    assert.equal(extractAssignErrorCode(err), "QR_EVENT_NOT_FOUND");
});

test("extractAssignErrorCode: lee err.data.code", () => {
    const err = { data: { code: "QR_INTENT_ALREADY_TERMINAL" } };
    assert.equal(extractAssignErrorCode(err), "QR_INTENT_ALREADY_TERMINAL");
});

test("extractAssignErrorCode: lee err.response.data.code (axios-like)", () => {
    const err = { response: { data: { code: "QR_EVENT_ALREADY_ASSIGNED" } } };
    assert.equal(extractAssignErrorCode(err), "QR_EVENT_ALREADY_ASSIGNED");
});

test("extractAssignErrorCode: case-insensitive sobre codes conocidos", () => {
    const err = { code: "qr_amount_mismatch" };
    assert.equal(extractAssignErrorCode(err), "QR_AMOUNT_MISMATCH");
});

test("extractAssignErrorCode: codes desconocidos → null (fallback a mensaje genérico)", () => {
    assert.equal(extractAssignErrorCode({ code: "SOMETHING_ELSE" }), null);
    assert.equal(extractAssignErrorCode({ code: "" }), null);
    assert.equal(extractAssignErrorCode({}), null);
    assert.equal(extractAssignErrorCode(null), null);
    assert.equal(extractAssignErrorCode(undefined), null);
    assert.equal(extractAssignErrorCode("string"), null);
});

// ---------------------------------------------------------------------------
// describeAssignErrorCode
// ---------------------------------------------------------------------------

test("describeAssignErrorCode: mapea cada code a copy legible en es-CO", () => {
    assert.match(
        describeAssignErrorCode("QR_EVENT_ALREADY_ASSIGNED"),
        /ya fue asignado/i,
    );
    assert.match(
        describeAssignErrorCode("QR_AMOUNT_MISMATCH"),
        /monto|coincide/i,
    );
    assert.match(
        describeAssignErrorCode("QR_INTENT_ALREADY_TERMINAL"),
        /cerrado|aprobado|cancelado/i,
    );
    assert.match(
        describeAssignErrorCode("QR_EVENT_NOT_FOUND"),
        /pago ya no existe/i,
    );
    assert.match(
        describeAssignErrorCode("QR_INTENT_NOT_FOUND"),
        /cobro pendiente ya no existe/i,
    );
});

test("describeAssignErrorCode: fallback honesto para codes desconocidos", () => {
    const generic = describeAssignErrorCode("UNKNOWN_CODE");
    assert.match(generic, /no se pudo asignar/i);
    assert.equal(generic, describeAssignErrorCode(null));
    assert.equal(generic, describeAssignErrorCode(undefined));
    assert.equal(generic, describeAssignErrorCode(""));
});
