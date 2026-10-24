// =============================================================================
// tests/bold-qr-enqueue.test.mjs
//
// Contrato del body del POST /api/pos/pagos-qr/encolar (migración 027).
// =============================================================================

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
    buildEncolarPayload,
    generateQrClientTxId,
} from "../src/lib/bold-qr-helpers.mjs";

describe("buildEncolarPayload", () => {
    const baseInput = () => ({
        ventaTempId: "vt_abcdef12345",
        cajaId: "CAJA-1",
        monto: 12500,
        clientTxId: generateQrClientTxId(),
        cashierName: "Yulis",
        clientDni: "1193594720",
        salePayload: {
            details: [
                { barcode: "7702001001001", quantity: 2, unitPrice: 2500, costPrice: 1800, subtotal: 5000 },
                { barcode: "7702001002002", quantity: 1, unitPrice: 7500, costPrice: 5000, subtotal: 7500 },
            ],
            totalAmount: 12500,
            amountPaid: 12500,
            transferSource: "BOLD_QR",
            paymentMethod: "BOLD_QR",
            employeeDni: "cajero123",
        },
    });

    test("construye el body canónico", () => {
        const out = buildEncolarPayload(baseInput());
        assert.ok(out);
        assert.equal(out.venta_temp_id, "vt_abcdef12345");
        assert.equal(out.caja_id, "CAJA-1");
        assert.equal(out.monto, 12500);
        assert.equal(out.cashier_name, "Yulis");
        assert.equal(out.client_dni, "1193594720");
        assert.ok(out.sale_payload);
        assert.equal(out.sale_payload.details.length, 2);
    });

    test("rechaza venta_temp_id corto", () => {
        const bad = baseInput();
        bad.ventaTempId = "abc";
        assert.equal(buildEncolarPayload(bad), null);
    });

    test("rechaza monto 0 o negativo", () => {
        for (const bad of [0, -1, NaN, "not-a-number"]) {
            const i = baseInput();
            i.monto = bad;
            assert.equal(buildEncolarPayload(i), null, `monto=${bad}`);
        }
    });

    test("rechaza clientTxId fuera de 8..64", () => {
        const i1 = baseInput();
        i1.clientTxId = "short";
        assert.equal(buildEncolarPayload(i1), null);
        const i2 = baseInput();
        i2.clientTxId = "x".repeat(65);
        assert.equal(buildEncolarPayload(i2), null);
    });

    test("rechaza details vacío", () => {
        const i = baseInput();
        i.salePayload = { ...i.salePayload, details: [] };
        assert.equal(buildEncolarPayload(i), null);
    });

    test("rechaza item sin barcode", () => {
        const i = baseInput();
        i.salePayload = {
            ...i.salePayload,
            details: [{ barcode: "", quantity: 1, unitPrice: 100 }],
        };
        assert.equal(buildEncolarPayload(i), null);
    });

    test("rechaza quantity <= 0", () => {
        const i = baseInput();
        i.salePayload = {
            ...i.salePayload,
            details: [{ barcode: "7702001001001", quantity: 0, unitPrice: 100 }],
        };
        assert.equal(buildEncolarPayload(i), null);
    });

    test("acepta unitPrice 0 (producto obsequio)", () => {
        const i = baseInput();
        i.salePayload = {
            ...i.salePayload,
            details: [{ barcode: "7702001001001", quantity: 1, unitPrice: 0 }],
        };
        i.monto = 1; // >0 pero no cero
        const out = buildEncolarPayload(i);
        assert.ok(out, "unitPrice 0 debe aceptarse (gift)");
    });

    test("rechaza cajaId vacío", () => {
        const i = baseInput();
        i.cajaId = "";
        assert.equal(buildEncolarPayload(i), null);
    });

    test("acepta cajaId numérico y lo convierte a string", () => {
        const i = baseInput();
        i.cajaId = 42;
        const out = buildEncolarPayload(i);
        assert.ok(out);
        assert.equal(out.caja_id, "42");
    });
});

describe("generateQrClientTxId", () => {
    test("genera string en el rango 8..64", () => {
        const id = generateQrClientTxId();
        assert.ok(typeof id === "string");
        assert.ok(id.length >= 8 && id.length <= 64, `length=${id.length}`);
    });

    test("dos llamadas dan ids distintos", () => {
        const a = generateQrClientTxId();
        const b = generateQrClientTxId();
        assert.notEqual(a, b);
    });

    test("prefijo qrtx_ para distinguir del flujo canónico", () => {
        const id = generateQrClientTxId();
        assert.ok(id.startsWith("qrtx_"), `id=${id}`);
    });
});
