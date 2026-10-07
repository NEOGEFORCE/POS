// =============================================================================
// tests/label-print-trigger.test.mjs
//
// Tests BEHAVIORALES de `src/lib/label-print-trigger.mjs`. El page
// `/labels/page.tsx` colapsa un lote de etiquetas en un único payload
// de auditoría; la elección entre `"new"` y `"reprint"` debe reflejar
// honestamente los flags `created` que devolvió `POST /labels/codes`
// por item.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";

import { labelBatchTriggerSource } from "../src/lib/label-print-trigger.mjs";

test("labelBatchTriggerSource: lote 100% codes recién creados → 'new'", () => {
    assert.equal(labelBatchTriggerSource([true]), "new");
    assert.equal(labelBatchTriggerSource([true, true, true]), "new");
});

test("labelBatchTriggerSource: cualquier item reusado → 'reprint'", () => {
    assert.equal(labelBatchTriggerSource([false]), "reprint",
        "un único item reusado basta");
    assert.equal(labelBatchTriggerSource([true, false]), "reprint",
        "una reimpresión en el batch marca el lote");
    assert.equal(labelBatchTriggerSource([false, true, true]), "reprint",
        "primera posición reutilizada → reprint");
    assert.equal(labelBatchTriggerSource([true, true, false, true]), "reprint",
        "reimpresión en el medio del batch");
    assert.equal(labelBatchTriggerSource([false, false, false]), "reprint",
        "todo el batch reusado también es reprint");
});

test("labelBatchTriggerSource: contrato defensivo con entradas vacías/inválidas → 'new'", () => {
    assert.equal(labelBatchTriggerSource([]), "new",
        "lote vacío cae al default histórico");
    assert.equal(labelBatchTriggerSource(null), "new",
        "null no debe romper");
    assert.equal(labelBatchTriggerSource(undefined), "new",
        "undefined no debe romper");
    // Un arg que no es array se trata como vacío (defensa contra callers rotos).
    assert.equal(labelBatchTriggerSource("not-an-array"), "new");
    assert.equal(labelBatchTriggerSource({ 0: true, length: 1 }), "new",
        "array-like no es array real");
});

test("labelBatchTriggerSource: entradas truthy/falsy no-boolean se tratan como 'no creado'", () => {
    // El contrato del backend es `created: boolean`. Si llegara un valor
    // raro (null, 1, "true"), lo tratamos como NO creado para no perder
    // el rastro de la reimpresión. La única firma válida es `=== true`.
    assert.equal(labelBatchTriggerSource([1]), "reprint",
        "1 no es true literal → reprint (conservador)");
    assert.equal(labelBatchTriggerSource(["true"]), "reprint",
        "'true' string no es true literal → reprint");
    assert.equal(labelBatchTriggerSource([null]), "reprint");
    assert.equal(labelBatchTriggerSource([undefined]), "reprint");
    assert.equal(labelBatchTriggerSource([true, null]), "reprint",
        "mezcla valida+inválida mantiene reprint");
});

test("labelBatchTriggerSource: refleja el shape por item que usa LabelPrintSheet", () => {
    // En LabelPrintSheet la expresión es `ensure.created ? "new" : "reprint"`.
    // Para un batch de un solo item el helper debe coincidir con esa
    // semántica, de lo contrario tendríamos dos verdades distintas sobre
    // "qué significa reprint".
    const perItem = (created) => (created ? "new" : "reprint");
    for (const created of [true, false]) {
        assert.equal(
            labelBatchTriggerSource([created]),
            perItem(created),
            `item único con created=${created} debe coincidir con LabelPrintSheet`,
        );
    }
});
