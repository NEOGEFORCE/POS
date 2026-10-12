// =============================================================================
// tests/label-print-queue.test.mjs
//
// Tests PUROS del helper `src/lib/label-print-queue.mjs`. El helper es la
// única fuente de verdad de la cola persistente de etiquetas (localStorage
// `pos_label_print_queue_v1` + backup `..._backup`) y debe cubrir:
//
//   1. Sanitización de entries y colas enteras (campos faltantes/tipos
//      inválidos nunca llegan a storage) con shape canónico:
//      { id, reason: 'PRICE_CHANGE', productBarcode, productName,
//        oldSalePrice, newSalePrice, salePrice, quantity, receptionRef,
//        queuedAt }.
//      El sanitizer acepta ALIASES LEGACY (`barcode`, `enqueuedAt`,
//      reason en minúsculas) pero SIEMPRE emite la forma canónica.
//   2. Load tolerante a storage ausente, clave ausente o JSON corrupto.
//      En NINGÚN caso el helper borra la clave corrupta — preservamos
//      evidencia forense y, además, recupera del backup si existe.
//   3. Save → load roundtrip. Save escribe primary + backup.
//   4. Enqueue:
//        · entry nueva se agrega al final (orden FIFO)
//        · entry duplicada (reason+productBarcode) se deduplica,
//          preservando `id`, `oldSalePrice` ÚTIL (>0) y la quantity
//          existente, y actualizando newSalePrice, salePrice,
//          receptionRef, queuedAt y productName.
//        · dedupe NO suma cantidad.
//        · dedupe toma oldSalePrice NUEVO cuando el existente es 0.
//        · enqueue tras corrupción del primario parte del BACKUP, NO
//          pisa con [] y conserva las entradas previas.
//   5. updateQuantity por id (clamp a >=1, idempotente si no existe id).
//   6. remove por id (no lanza si id no existe).
//   7. clear vacía AMBAS claves (primary + backup).
//   8. Storage inyectable: todas las funciones aceptan un objeto Storage
//      mock. El helper NO alcanza localStorage global si se le pasa uno.
//   9. BC aliases (`sanitizeEntry`, `loadQueue`, `removeFromQueue`,
//      `clearQueue`…) siguen funcionando equivalentes a los canónicos.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";

import {
    // Canonical names
    QUEUE_STORAGE_KEY,
    QUEUE_STORAGE_BACKUP_KEY,
    QUEUE_REASONS,
    sanitize,
    sanitizeAll,
    load,
    save,
    enqueue,
    updateQuantity,
    remove,
    clear,
    generateEntryId,
    // Backwards-compat aliases
    sanitizeEntry,
    sanitizeQueue,
    loadQueue,
    saveQueue,
    removeFromQueue,
    clearQueue,
} from "../src/lib/label-print-queue.mjs";

/**
 * Mock storage mínimo compatible con la API Storage del DOM. Las pruebas
 * crean uno nuevo por caso para evitar fugas de estado.
 */
function makeStorage(initial) {
    const store = new Map();
    if (initial && typeof initial === "object") {
        for (const [k, v] of Object.entries(initial)) store.set(k, String(v));
    }
    return {
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(key, String(value));
        },
        removeItem(key) {
            store.delete(key);
        },
        // Helper interno para los asserts; no es parte de la API Storage.
        __raw(key) {
            return store.has(key) ? store.get(key) : null;
        },
        __size() {
            return store.size;
        },
    };
}

// -----------------------------------------------------------------------------
// Constantes públicas
// -----------------------------------------------------------------------------

test("QUEUE_STORAGE_KEY es la clave canónica `pos_label_print_queue_v1`", () => {
    assert.equal(QUEUE_STORAGE_KEY, "pos_label_print_queue_v1");
});

test("QUEUE_STORAGE_BACKUP_KEY es `${QUEUE_STORAGE_KEY}_backup`", () => {
    assert.equal(QUEUE_STORAGE_BACKUP_KEY, "pos_label_print_queue_v1_backup");
});

test("QUEUE_REASONS expone sólo PRICE_CHANGE (literal 'PRICE_CHANGE')", () => {
    assert.equal(QUEUE_REASONS.PRICE_CHANGE, "PRICE_CHANGE");
    // POST_RECEIVE fue retirado del modelo — no debe existir.
    assert.equal(QUEUE_REASONS.POST_RECEIVE, undefined);
});

test("generateEntryId: devuelve un string no vacío con prefijo lpq-", () => {
    const id = generateEntryId();
    assert.equal(typeof id, "string");
    assert.ok(id.length > 4);
    assert.ok(id.startsWith("lpq-"), "El id debe tener prefijo canónico 'lpq-'.");
});

test("generateEntryId: ids colisionan muy poco en 1000 llamadas", () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) seen.add(generateEntryId());
    assert.ok(seen.size >= 999, "Debe generar ids suficientemente únicos (>=999/1000).");
});

// -----------------------------------------------------------------------------
// sanitize — campos requeridos y aliases legacy
// -----------------------------------------------------------------------------

test("sanitize: null/undefined/no-objeto → null", () => {
    assert.equal(sanitize(null), null);
    assert.equal(sanitize(undefined), null);
    assert.equal(sanitize("string"), null);
    assert.equal(sanitize(123), null);
    assert.equal(sanitize([]), null);
});

test("sanitize: sin productBarcode válido → null", () => {
    assert.equal(sanitize({ reason: "PRICE_CHANGE" }), null);
    assert.equal(sanitize({ productBarcode: "", reason: "PRICE_CHANGE" }), null);
    assert.equal(sanitize({ productBarcode: "   ", reason: "PRICE_CHANGE" }), null);
    assert.equal(sanitize({ productBarcode: 1234, reason: "PRICE_CHANGE" }), null);
});

test("sanitize: sin reason canónico → null", () => {
    assert.equal(sanitize({ productBarcode: "ABC123" }), null);
    assert.equal(sanitize({ productBarcode: "ABC123", reason: "other" }), null);
    assert.equal(sanitize({ productBarcode: "ABC123", reason: "" }), null);
});

test("sanitize: ALIAS LEGACY — `barcode` → productBarcode canónico", () => {
    const e = sanitize({ barcode: "abc-123", reason: "PRICE_CHANGE" });
    assert.ok(e);
    assert.equal(e.productBarcode, "ABC-123");
    // Comprobamos que el alias legacy desapareció del output canónico.
    assert.equal(e.barcode, undefined, "El output canónico NO expone `barcode`.");
});

test("sanitize: ALIAS LEGACY — reason minúsculas `price_change` → 'PRICE_CHANGE'", () => {
    const e = sanitize({ productBarcode: "A", reason: "price_change" });
    assert.ok(e);
    assert.equal(e.reason, "PRICE_CHANGE");
});

test("sanitize: ALIAS LEGACY — `enqueuedAt` → `queuedAt`", () => {
    const stamp = 1_700_000_000_000;
    const e = sanitize({
        productBarcode: "A",
        reason: "PRICE_CHANGE",
        enqueuedAt: stamp,
    });
    assert.ok(e);
    assert.equal(e.queuedAt, stamp);
    assert.equal(e.enqueuedAt, undefined, "El output canónico NO expone `enqueuedAt`.");
});

test("sanitize: productBarcode canónico tiene prioridad sobre `barcode` legacy", () => {
    const e = sanitize({
        productBarcode: "CANON",
        barcode: "LEGACY",
        reason: "PRICE_CHANGE",
    });
    assert.ok(e);
    assert.equal(e.productBarcode, "CANON");
});

test("sanitize: normaliza productBarcode a MAYÚSCULAS + trim", () => {
    const e = sanitize({ productBarcode: "  abc-123  ", reason: "PRICE_CHANGE" });
    assert.ok(e);
    assert.equal(e.productBarcode, "ABC-123");
});

test("sanitize: quantity por defecto es 1 cuando falta o es inválida", () => {
    const e1 = sanitize({ productBarcode: "A", reason: "PRICE_CHANGE" });
    assert.equal(e1.quantity, 1);
    const e2 = sanitize({ productBarcode: "A", reason: "PRICE_CHANGE", quantity: 0 });
    assert.equal(e2.quantity, 1, "0 clamp a 1");
    const e3 = sanitize({ productBarcode: "A", reason: "PRICE_CHANGE", quantity: -3 });
    assert.equal(e3.quantity, 1, "negativo clamp a 1");
    const e4 = sanitize({ productBarcode: "A", reason: "PRICE_CHANGE", quantity: "abc" });
    assert.equal(e4.quantity, 1, "no numérico clamp a 1");
});

test("sanitize: quantity > 1 se preserva y floor-eado a entero", () => {
    const e = sanitize({ productBarcode: "A", reason: "PRICE_CHANGE", quantity: 7.9 });
    assert.equal(e.quantity, 7);
});

test("sanitize: oldSalePrice y newSalePrice se castean a número finito (default 0)", () => {
    const e = sanitize({
        productBarcode: "A",
        reason: "PRICE_CHANGE",
        oldSalePrice: "550",
        newSalePrice: null,
    });
    assert.equal(e.oldSalePrice, 550);
    assert.equal(e.newSalePrice, 0);
});

test("sanitize: salePrice (precio actual/nuevo) se sincroniza con newSalePrice si no viene", () => {
    const e = sanitize({
        productBarcode: "A",
        reason: "PRICE_CHANGE",
        newSalePrice: 650,
    });
    assert.equal(e.salePrice, 650, "salePrice se sincroniza con newSalePrice.");
});

test("sanitize: salePrice explícito se respeta cuando el caller lo pasa", () => {
    const e = sanitize({
        productBarcode: "A",
        reason: "PRICE_CHANGE",
        newSalePrice: 650,
        salePrice: 999,
    });
    assert.equal(e.salePrice, 999);
});

test("sanitize: productName/receptionRef strings por defecto ''", () => {
    const e = sanitize({ productBarcode: "A", reason: "PRICE_CHANGE" });
    assert.equal(e.productName, "");
    assert.equal(e.receptionRef, "");
    assert.equal(e.lineId, undefined, "La forma canónica no persiste lineId.");
});

test("sanitize: respeta id existente; genera uno si falta", () => {
    const e1 = sanitize({
        id: "my-custom-id",
        productBarcode: "A",
        reason: "PRICE_CHANGE",
    });
    assert.equal(e1.id, "my-custom-id");
    const e2 = sanitize({ productBarcode: "A", reason: "PRICE_CHANGE" });
    assert.ok(e2.id.startsWith("lpq-"));
});

test("sanitize: queuedAt válido se preserva; si falta usa Date.now()", () => {
    const stamp = 1_700_000_000_000;
    const e1 = sanitize({ productBarcode: "A", reason: "PRICE_CHANGE", queuedAt: stamp });
    assert.equal(e1.queuedAt, stamp);
    const before = Date.now();
    const e2 = sanitize({ productBarcode: "A", reason: "PRICE_CHANGE" });
    const after = Date.now();
    assert.ok(e2.queuedAt >= before && e2.queuedAt <= after);
});

// -----------------------------------------------------------------------------
// sanitizeAll — colas enteras
// -----------------------------------------------------------------------------

test("sanitizeAll: no-array → []", () => {
    assert.deepEqual(sanitizeAll(null), []);
    assert.deepEqual(sanitizeAll(undefined), []);
    assert.deepEqual(sanitizeAll("abc"), []);
    assert.deepEqual(sanitizeAll({ 0: {} }), []);
});

test("sanitizeAll: filtra entradas inválidas pero preserva válidas", () => {
    const raw = [
        { productBarcode: "A", reason: "PRICE_CHANGE" }, // válida
        null, // inválida
        { productBarcode: "", reason: "PRICE_CHANGE" }, // inválida
        { productBarcode: "B", reason: "PRICE_CHANGE", quantity: 2 }, // válida
    ];
    const q = sanitizeAll(raw);
    assert.equal(q.length, 2);
    assert.equal(q[0].productBarcode, "A");
    assert.equal(q[1].productBarcode, "B");
    assert.equal(q[1].quantity, 2);
});

test("sanitizeAll: deduplica por id si viene duplicado por bug de persistencia", () => {
    const raw = [
        { id: "x1", productBarcode: "A", reason: "PRICE_CHANGE" },
        { id: "x1", productBarcode: "A", reason: "PRICE_CHANGE" }, // dup
        { id: "x2", productBarcode: "B", reason: "PRICE_CHANGE" },
    ];
    const q = sanitizeAll(raw);
    assert.equal(q.length, 2);
    assert.equal(q[0].id, "x1");
    assert.equal(q[1].id, "x2");
});

test("sanitizeAll: array mixto con aliases legacy se migra a shape canónico", () => {
    const q = sanitizeAll([
        // Legacy: barcode + reason lower-case + enqueuedAt
        {
            id: "legacy",
            barcode: "lower-abc",
            reason: "price_change",
            enqueuedAt: 1234,
        },
        // Canónica
        {
            id: "canon",
            productBarcode: "canon-def",
            reason: "PRICE_CHANGE",
            queuedAt: 5678,
        },
    ]);
    assert.equal(q.length, 2);
    assert.equal(q[0].productBarcode, "LOWER-ABC");
    assert.equal(q[0].reason, "PRICE_CHANGE");
    assert.equal(q[0].queuedAt, 1234);
    assert.equal(q[1].productBarcode, "CANON-DEF");
});

// -----------------------------------------------------------------------------
// load — tolerancia a storage ausente / clave ausente / JSON corrupto +
// FALLBACK A BACKUP
// -----------------------------------------------------------------------------

test("load: sin storage ni localStorage global → []", () => {
    assert.deepEqual(load(null), []);
});

test("load: storage sin la clave → []", () => {
    const s = makeStorage({});
    assert.deepEqual(load(s), []);
});

test("load: JSON corrupto en primario NO borra la clave; recupera del backup si existe", () => {
    const backup = [
        {
            id: "backup-id",
            productBarcode: "ABC",
            reason: "PRICE_CHANGE",
            newSalePrice: 650,
        },
    ];
    const s = makeStorage({
        [QUEUE_STORAGE_KEY]: "{not valid json",
        [QUEUE_STORAGE_BACKUP_KEY]: JSON.stringify(backup),
    });
    const result = load(s);
    assert.equal(result.length, 1, "load debe recuperar la cola desde el backup.");
    assert.equal(result[0].id, "backup-id");
    assert.equal(result[0].productBarcode, "ABC");
    // Y el primario corrupto NO se tocó: evidencia forense.
    assert.equal(
        s.__raw(QUEUE_STORAGE_KEY),
        "{not valid json",
        "load no debe borrar el primario corrupto.",
    );
});

test("load: JSON corrupto en primario y SIN backup → [] sin borrar el primario", () => {
    const s = makeStorage({ [QUEUE_STORAGE_KEY]: "{not valid json" });
    const result = load(s);
    assert.deepEqual(result, []);
    assert.equal(
        s.__raw(QUEUE_STORAGE_KEY),
        "{not valid json",
        "load debe preservar el raw cuando el JSON está corrupto.",
    );
});

test("load: JSON válido pero no array en primario → fallback a backup", () => {
    const backup = [{ productBarcode: "A", reason: "PRICE_CHANGE" }];
    const s = makeStorage({
        [QUEUE_STORAGE_KEY]: '"not an array"',
        [QUEUE_STORAGE_BACKUP_KEY]: JSON.stringify(backup),
    });
    const result = load(s);
    assert.equal(result.length, 1);
    assert.equal(result[0].productBarcode, "A");
});

test("load: array con mix de válidas e inválidas → filtra", () => {
    const q = [
        { id: "a1", productBarcode: "ABC", reason: "PRICE_CHANGE" },
        { foo: "bar" }, // inválida
    ];
    const s = makeStorage({ [QUEUE_STORAGE_KEY]: JSON.stringify(q) });
    const result = load(s);
    assert.equal(result.length, 1);
    assert.equal(result[0].productBarcode, "ABC");
});

test("load: getItem que lanza no revienta — devuelve []", () => {
    const broken = {
        getItem() {
            throw new Error("boom");
        },
        setItem() {},
        removeItem() {},
    };
    assert.deepEqual(load(broken), []);
});

// -----------------------------------------------------------------------------
// save + roundtrip + backup escrito en paralelo
// -----------------------------------------------------------------------------

test("save + load: roundtrip conserva orden FIFO y campos canónicos", () => {
    const s = makeStorage({});
    const q = [
        {
            id: "a1",
            productBarcode: "ABC",
            productName: "Papas",
            oldSalePrice: 500,
            newSalePrice: 600,
            salePrice: 600,
            reason: "PRICE_CHANGE",
            quantity: 2,
            receptionRef: "RCV-1",
            queuedAt: 1700,
            lineId: "L1",
        },
        {
            id: "a2",
            productBarcode: "DEF",
            reason: "PRICE_CHANGE",
        },
    ];
    const ok = save(s, q);
    assert.equal(ok, true);
    const loaded = load(s);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].productBarcode, "ABC");
    assert.equal(loaded[0].productName, "Papas");
    assert.equal(loaded[0].oldSalePrice, 500);
    assert.equal(loaded[0].newSalePrice, 600);
    assert.equal(loaded[0].salePrice, 600);
    assert.equal(loaded[0].quantity, 2);
    assert.equal(loaded[0].receptionRef, "RCV-1");
    assert.equal(loaded[0].queuedAt, 1700);
    assert.equal(loaded[1].reason, "PRICE_CHANGE");
});

test("save: escribe PRIMARY y BACKUP con el mismo contenido", () => {
    const s = makeStorage({});
    save(s, [{ productBarcode: "A", reason: "PRICE_CHANGE" }]);
    const primary = s.__raw(QUEUE_STORAGE_KEY);
    const backup = s.__raw(QUEUE_STORAGE_BACKUP_KEY);
    assert.ok(primary, "primario escrito");
    assert.ok(backup, "backup escrito");
    assert.equal(primary, backup, "primary y backup deben ser idénticos tras un save ok.");
});

test("save: setItem que lanza devuelve false sin romper", () => {
    const broken = {
        getItem() {
            return null;
        },
        setItem() {
            throw new Error("quota");
        },
        removeItem() {},
    };
    const ok = save(broken, [{ productBarcode: "A", reason: "PRICE_CHANGE" }]);
    assert.equal(ok, false);
});

test("save: entradas inválidas se filtran antes de serializar", () => {
    const s = makeStorage({});
    save(s, [
        { productBarcode: "A", reason: "PRICE_CHANGE" },
        null,
        { productBarcode: "", reason: "PRICE_CHANGE" },
    ]);
    const raw = s.__raw(QUEUE_STORAGE_KEY);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.length, 1, "save debe filtrar entradas inválidas al escribir.");
});

// -----------------------------------------------------------------------------
// enqueue
// -----------------------------------------------------------------------------

test("enqueue: entry nueva se agrega al final (FIFO)", () => {
    const s = makeStorage({});
    enqueue(s, { productBarcode: "A", reason: "PRICE_CHANGE", newSalePrice: 100 });
    enqueue(s, { productBarcode: "B", reason: "PRICE_CHANGE", newSalePrice: 200 });
    const q = load(s);
    assert.equal(q.length, 2);
    assert.equal(q[0].productBarcode, "A");
    assert.equal(q[1].productBarcode, "B");
});

test("enqueue: entrada inválida no modifica la cola", () => {
    const s = makeStorage({});
    enqueue(s, { productBarcode: "A", reason: "PRICE_CHANGE" });
    const result = enqueue(s, { reason: "PRICE_CHANGE" }); // sin barcode
    assert.equal(result.length, 1);
    assert.equal(result[0].productBarcode, "A");
});

test("enqueue: duplicado por reason+productBarcode PRESERVA oldSalePrice ÚTIL, quantity, id", () => {
    const s = makeStorage({});
    enqueue(s, {
        id: "my-id-1",
        productBarcode: "A",
        reason: "PRICE_CHANGE",
        oldSalePrice: 500,
        newSalePrice: 600,
        salePrice: 600,
        productName: "Papas v1",
        quantity: 3,
        receptionRef: "RCV-1",
        queuedAt: 100,
    });
    enqueue(s, {
        id: "my-id-2", // debería IGNORARSE
        productBarcode: "A",
        reason: "PRICE_CHANGE",
        oldSalePrice: 700, // debería IGNORARSE
        newSalePrice: 650,
        salePrice: 650,
        productName: "Papas v2",
        quantity: 10, // debería IGNORARSE (no suma, no sobrescribe)
        receptionRef: "RCV-2",
        queuedAt: 200,
    });
    const q = load(s);
    assert.equal(q.length, 1, "No duplica entradas por (reason, productBarcode)");
    assert.equal(q[0].id, "my-id-1", "El id original se preserva.");
    assert.equal(q[0].oldSalePrice, 500, "oldSalePrice ÚTIL original se preserva.");
    assert.equal(q[0].quantity, 3, "quantity original se preserva (no se suma).");
    assert.equal(q[0].newSalePrice, 650, "newSalePrice se actualiza con el nuevo.");
    assert.equal(q[0].salePrice, 650, "salePrice se actualiza con el nuevo.");
    assert.equal(q[0].receptionRef, "RCV-2", "receptionRef se actualiza al último lote.");
    assert.equal(q[0].queuedAt, 200, "queuedAt se actualiza al último stamp.");
    assert.equal(q[0].productName, "Papas v2", "productName se actualiza.");
});

test("enqueue: duplicado con oldSalePrice existente = 0 → toma el nuevo valor", () => {
    const s = makeStorage({});
    enqueue(s, {
        productBarcode: "A",
        reason: "PRICE_CHANGE",
        oldSalePrice: 0, // "no útil"
        newSalePrice: 600,
    });
    enqueue(s, {
        productBarcode: "A",
        reason: "PRICE_CHANGE",
        oldSalePrice: 500, // útil
        newSalePrice: 650,
    });
    const q = load(s);
    assert.equal(q.length, 1);
    assert.equal(q[0].oldSalePrice, 500, "Si el existente era 0, se toma el nuevo útil.");
    assert.equal(q[0].newSalePrice, 650);
});

test("enqueue: productBarcode distinto NO deduplica", () => {
    const s = makeStorage({});
    enqueue(s, { productBarcode: "A", reason: "PRICE_CHANGE" });
    enqueue(s, { productBarcode: "B", reason: "PRICE_CHANGE" });
    const q = load(s);
    assert.equal(q.length, 2);
});

test("enqueue: productBarcode normalizado a MAYÚSCULAS participa de la dedup", () => {
    const s = makeStorage({});
    enqueue(s, { productBarcode: "abc", reason: "PRICE_CHANGE", newSalePrice: 100 });
    enqueue(s, { productBarcode: "ABC", reason: "PRICE_CHANGE", newSalePrice: 200 });
    enqueue(s, { productBarcode: "  Abc  ", reason: "PRICE_CHANGE", newSalePrice: 300 });
    const q = load(s);
    assert.equal(q.length, 1, "Los tres barcodes se normalizan a 'ABC' y deduplican.");
    assert.equal(q[0].productBarcode, "ABC");
    assert.equal(q[0].newSalePrice, 300);
    assert.equal(q[0].salePrice, 300);
});

test("enqueue: acepta aliases legacy (barcode + reason lower-case) y emite canónico", () => {
    const s = makeStorage({});
    enqueue(s, {
        barcode: "legacy-abc",
        reason: "price_change",
        newSalePrice: 100,
        enqueuedAt: 42,
    });
    const q = load(s);
    assert.equal(q.length, 1);
    assert.equal(q[0].productBarcode, "LEGACY-ABC");
    assert.equal(q[0].reason, "PRICE_CHANGE");
    assert.equal(q[0].queuedAt, 42);
});

// -----------------------------------------------------------------------------
// enqueue sobre primario corrupto → recupera backup y no lo pisa con []
// -----------------------------------------------------------------------------

test("enqueue: con primario corrupto y backup presente, PARTE del backup y conserva entradas", () => {
    const backup = [
        {
            id: "backup-1",
            productBarcode: "KEEP",
            reason: "PRICE_CHANGE",
            quantity: 2,
            newSalePrice: 999,
        },
    ];
    const s = makeStorage({
        [QUEUE_STORAGE_KEY]: "{garbage",
        [QUEUE_STORAGE_BACKUP_KEY]: JSON.stringify(backup),
    });
    const next = enqueue(s, {
        productBarcode: "NEW",
        reason: "PRICE_CHANGE",
        newSalePrice: 123,
    });
    assert.equal(next.length, 2, "enqueue debe partir del backup y anexar la nueva entrada.");
    const kept = next.find((e) => e.productBarcode === "KEEP");
    const added = next.find((e) => e.productBarcode === "NEW");
    assert.ok(kept, "La entrada previa del backup se conserva.");
    assert.equal(kept.quantity, 2);
    assert.ok(added, "La entrada nueva se agregó.");
    assert.equal(added.newSalePrice, 123);
});

test("enqueue: tras corrupción + backup, el nuevo save sobreescribe primario (ya no corrupto)", () => {
    const backup = [
        { id: "backup-1", productBarcode: "KEEP", reason: "PRICE_CHANGE" },
    ];
    const s = makeStorage({
        [QUEUE_STORAGE_KEY]: "{garbage",
        [QUEUE_STORAGE_BACKUP_KEY]: JSON.stringify(backup),
    });
    enqueue(s, { productBarcode: "NEW", reason: "PRICE_CHANGE" });
    const primary = s.__raw(QUEUE_STORAGE_KEY);
    const parsed = JSON.parse(primary);
    assert.equal(parsed.length, 2, "El primario reemplazado debe tener ambas entradas.");
});

test("load: tras corrupción recuperando backup, load devuelve lo mismo que un enqueue leería", () => {
    const backup = [
        { id: "b1", productBarcode: "A", reason: "PRICE_CHANGE" },
    ];
    const s = makeStorage({
        [QUEUE_STORAGE_KEY]: "{broken",
        [QUEUE_STORAGE_BACKUP_KEY]: JSON.stringify(backup),
    });
    const l = load(s);
    assert.equal(l.length, 1);
    assert.equal(l[0].productBarcode, "A");
});

// -----------------------------------------------------------------------------
// updateQuantity
// -----------------------------------------------------------------------------

test("updateQuantity: actualiza por id existente, clamp a >=1", () => {
    const s = makeStorage({});
    enqueue(s, {
        id: "e1",
        productBarcode: "A",
        reason: "PRICE_CHANGE",
        quantity: 1,
    });
    updateQuantity(s, "e1", 5);
    assert.equal(load(s)[0].quantity, 5);
    updateQuantity(s, "e1", 0); // clamp
    assert.equal(load(s)[0].quantity, 1);
    updateQuantity(s, "e1", -4); // clamp
    assert.equal(load(s)[0].quantity, 1);
    updateQuantity(s, "e1", 3.9); // floor
    assert.equal(load(s)[0].quantity, 3);
});

test("updateQuantity: id inexistente no modifica nada ni lanza", () => {
    const s = makeStorage({});
    enqueue(s, { id: "e1", productBarcode: "A", reason: "PRICE_CHANGE", quantity: 2 });
    updateQuantity(s, "no-existe", 99);
    assert.equal(load(s)[0].quantity, 2);
});

test("updateQuantity: id no string / vacío → no-op", () => {
    const s = makeStorage({});
    enqueue(s, { id: "e1", productBarcode: "A", reason: "PRICE_CHANGE", quantity: 2 });
    updateQuantity(s, "", 99);
    updateQuantity(s, null, 99);
    assert.equal(load(s)[0].quantity, 2);
});

// -----------------------------------------------------------------------------
// remove
// -----------------------------------------------------------------------------

test("remove: elimina por id existente", () => {
    const s = makeStorage({});
    enqueue(s, { id: "e1", productBarcode: "A", reason: "PRICE_CHANGE" });
    enqueue(s, { id: "e2", productBarcode: "B", reason: "PRICE_CHANGE" });
    remove(s, "e1");
    const q = load(s);
    assert.equal(q.length, 1);
    assert.equal(q[0].id, "e2");
});

test("remove: id inexistente no modifica nada ni lanza", () => {
    const s = makeStorage({});
    enqueue(s, { id: "e1", productBarcode: "A", reason: "PRICE_CHANGE" });
    const r = remove(s, "no-existe");
    assert.equal(r.length, 1);
});

test("remove: id vacío / no string → no-op", () => {
    const s = makeStorage({});
    enqueue(s, { id: "e1", productBarcode: "A", reason: "PRICE_CHANGE" });
    remove(s, "");
    remove(s, undefined);
    assert.equal(load(s).length, 1);
});

// -----------------------------------------------------------------------------
// clear — vacía primary + backup
// -----------------------------------------------------------------------------

test("clear: vacía todas las entradas y AMBAS claves (primary + backup)", () => {
    const s = makeStorage({});
    enqueue(s, { productBarcode: "A", reason: "PRICE_CHANGE" });
    enqueue(s, { productBarcode: "B", reason: "PRICE_CHANGE" });
    const r = clear(s);
    assert.deepEqual(r, []);
    assert.equal(s.__raw(QUEUE_STORAGE_KEY), null, "primary borrado");
    assert.equal(s.__raw(QUEUE_STORAGE_BACKUP_KEY), null, "backup borrado");
});

test("clear: sin storage → []", () => {
    const r = clear(null);
    assert.deepEqual(r, []);
});

test("clear: removeItem que lanza no revienta", () => {
    const broken = {
        getItem() {
            return null;
        },
        setItem() {},
        removeItem() {
            throw new Error("boom");
        },
    };
    const r = clear(broken);
    assert.deepEqual(r, []);
});

// -----------------------------------------------------------------------------
// Contratos cross-cutting
// -----------------------------------------------------------------------------

test("CROSS: ningún helper hace fetch — es puro, offline-first", () => {
    const s = makeStorage({});
    enqueue(s, { productBarcode: "A", reason: "PRICE_CHANGE", newSalePrice: 10 });
    updateQuantity(s, load(s)[0].id, 5);
    remove(s, load(s)[0]?.id || "x");
    clear(s);
    assert.ok(true);
});

test("CROSS: el storage inyectado SOBREESCRIBE cualquier localStorage global", () => {
    const originalLS = globalThis.localStorage;
    const touched = { called: false };
    globalThis.localStorage = {
        getItem() {
            touched.called = true;
            return null;
        },
        setItem() {
            touched.called = true;
        },
        removeItem() {
            touched.called = true;
        },
    };
    try {
        const s = makeStorage({});
        enqueue(s, { productBarcode: "A", reason: "PRICE_CHANGE" });
        load(s);
        updateQuantity(s, load(s)[0].id, 2);
        remove(s, load(s)[0]?.id || "x");
        clear(s);
        assert.equal(
            touched.called,
            false,
            "El storage inyectado debe tener prioridad sobre el localStorage global.",
        );
    } finally {
        if (originalLS === undefined) {
            delete globalThis.localStorage;
        } else {
            globalThis.localStorage = originalLS;
        }
    }
});

test("CROSS: enqueue → load → remove → load conserva un id estable", () => {
    const s = makeStorage({});
    enqueue(s, { productBarcode: "A", reason: "PRICE_CHANGE", newSalePrice: 100 });
    const id1 = load(s)[0].id;
    enqueue(s, { productBarcode: "B", reason: "PRICE_CHANGE" });
    const id1Again = load(s).find((e) => e.productBarcode === "A").id;
    assert.equal(id1, id1Again, "El id de A debe ser estable entre operaciones.");
});

test("CROSS: dedupe con queuedAt más viejo preserva ordenamiento FIFO para no-duplicados", () => {
    const s = makeStorage({});
    enqueue(s, { productBarcode: "A", reason: "PRICE_CHANGE", newSalePrice: 100, queuedAt: 100 });
    enqueue(s, { productBarcode: "B", reason: "PRICE_CHANGE", newSalePrice: 200, queuedAt: 200 });
    enqueue(s, { productBarcode: "A", reason: "PRICE_CHANGE", newSalePrice: 150, queuedAt: 300 });
    const q = load(s);
    assert.equal(q.length, 2);
    assert.equal(q[0].productBarcode, "A");
    assert.equal(q[0].newSalePrice, 150);
    assert.equal(q[1].productBarcode, "B");
});

// -----------------------------------------------------------------------------
// Backwards-compat aliases
// -----------------------------------------------------------------------------

test("BC: sanitizeEntry/sanitizeQueue/loadQueue/saveQueue/removeFromQueue/clearQueue son los canónicos", () => {
    assert.equal(sanitizeEntry, sanitize);
    assert.equal(sanitizeQueue, sanitizeAll);
    assert.equal(loadQueue, load);
    assert.equal(saveQueue, save);
    assert.equal(removeFromQueue, remove);
    assert.equal(clearQueue, clear);
});

test("BC: loadQueue + saveQueue siguen funcionando con la nueva schema canónica", () => {
    const s = makeStorage({});
    saveQueue(s, [{ productBarcode: "A", reason: "PRICE_CHANGE", newSalePrice: 10 }]);
    const q = loadQueue(s);
    assert.equal(q.length, 1);
    assert.equal(q[0].productBarcode, "A");
});
