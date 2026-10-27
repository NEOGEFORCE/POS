// =============================================================================
// tests/bold-qr-tray.test.mjs
//
// Contrato de los helpers de la bandeja asíncrona QR Bold/Bre-B
// (migración 027): `classifyTrayEvent` + guard estático contra el
// resurgimiento de "Confirmar manual" en la UI del cajero.
// =============================================================================

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";

import {
    BOLD_QR_TRAY_EVENT,
    BOLD_QR_TRAY_KIND,
    classifyTrayEvent,
} from "../src/lib/bold-qr-helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("BOLD_QR_TRAY_EVENT y BOLD_QR_TRAY_KIND", () => {
    test("event name empata con el backend", () => {
        assert.equal(BOLD_QR_TRAY_EVENT, "qr_tray_update");
    });

    test("kinds esperados existen y son 7", () => {
        const expected = [
            "ENQUEUED",
            "APPROVED",
            "AMBIGUOUS",
            "UNMATCHED",
            "EXPIRED",
            "CANCELLED",
            "ERROR",
        ];
        for (const k of expected) {
            assert.equal(BOLD_QR_TRAY_KIND[k], k, `kind faltante: ${k}`);
        }
        assert.equal(Object.keys(BOLD_QR_TRAY_KIND).length, 7);
    });
});

describe("classifyTrayEvent", () => {
    test("acepta un evento APPROVED canónico", () => {
        const out = classifyTrayEvent({
            kind: "APPROVED",
            ventaTempId: "vt_abcdef12345",
            amountCop: 45800,
            saleId: 1234,
            reference: "ABC123",
            approvedAt: "2026-10-21T20:00:00Z",
            approvedVia: "BRIDGE_NOTIFICATION",
        });
        assert.ok(out, "classifyTrayEvent devolvió null para evento válido");
        assert.equal(out.kind, "APPROVED");
        assert.equal(out.ventaTempId, "vt_abcdef12345");
        assert.equal(out.amountCop, 45800);
        assert.equal(out.saleId, 1234);
        assert.equal(out.reference, "ABC123");
    });

    test("acepta ENQUEUED sin saleId", () => {
        const out = classifyTrayEvent({
            kind: "ENQUEUED",
            ventaTempId: "vt_abcdef12345",
            amountCop: 10000,
        });
        assert.ok(out);
        assert.equal(out.kind, "ENQUEUED");
        assert.equal(out.saleId, undefined);
    });

    test("rechaza kind desconocido", () => {
        const out = classifyTrayEvent({
            kind: "WUT",
            ventaTempId: "vt_abcdef12345",
        });
        assert.equal(out, null);
    });

    test("rechaza ventaTempId vacío", () => {
        const out = classifyTrayEvent({
            kind: "APPROVED",
            ventaTempId: "",
        });
        assert.equal(out, null);
    });

    test("rechaza payload no-objeto", () => {
        assert.equal(classifyTrayEvent(null), null);
        assert.equal(classifyTrayEvent(undefined), null);
        assert.equal(classifyTrayEvent("foo"), null);
        assert.equal(classifyTrayEvent(42), null);
    });

    test("case-insensitive: KIND en lowercase se acepta via toUpperCase", () => {
        const out = classifyTrayEvent({
            kind: "approved",
            ventaTempId: "vt_abcdef12345",
        });
        assert.ok(out);
        assert.equal(out.kind, "APPROVED");
    });
});

describe("Guard estático: el modal del cajero NO contiene Confirmar manual", () => {
    const modalPath = resolve(__dirname, "..", "src", "components", "shared", "ModalPagoBoldQR.tsx");
    const src = readFileSync(modalPath, "utf8");

    test("No aparece el label 'Confirmar manual'", () => {
        assert.ok(
            !src.includes("Confirmar manual"),
            "El modal del cajero NO debe exponer el botón 'Confirmar manual' tras la migración 027",
        );
    });

    test("La confirmación manual del modal es SOLO para admin (2026-10-27)", () => {
        assert.ok(src.includes("/pos/pagos-qr/confirmar-manual"), "El modal llama /confirmar-manual para el admin");
        assert.match(src, /isAdmin && \(isWaiting \|\| isManualGate\)/, "El botón sólo se pinta si isAdmin");
        assert.match(src, /const isAdmin = isAdminUser\(user\)/);
    });

    test("Sí aparece el nuevo botón 'Dejar en espera'", () => {
        assert.ok(
            src.toLowerCase().includes("dejar en espera"),
            "El modal debe mostrar el botón 'Dejar en espera y seguir'",
        );
    });

    test("Sí aparece la prop onEnqueueAndClose", () => {
        assert.ok(
            src.includes("onEnqueueAndClose"),
            "El modal debe aceptar la prop onEnqueueAndClose",
        );
    });
});
