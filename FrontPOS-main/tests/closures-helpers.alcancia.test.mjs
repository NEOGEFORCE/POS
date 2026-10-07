import assert from "node:assert/strict";
import test from "node:test";

import {
  CLOSURE_TX_STORAGE_KEY,
  clearClientClosureId,
  clearClosureStorage,
  expenseChannels,
  generateClientClosureId,
  getClosureExpensesSummary,
  getOrCreateClientClosureId,
  listClosureStorageKeys,
  sanitizeCashBreakdown,
  serializeCashBreakdown,
} from "../src/lib/closures-helpers.mjs";

// ============================================================================
// ALCANCIA / MONEDAS: canal independiente
//
// El backend separa `EgresosAlcancia` como canal propio (ver
// services.closure_metrics.go). El frontend lo pintaba todo bajo `cash` y las
// tarjetas quedaban desalineadas con el PDF/Telegram. Esta prueba congela el
// contrato: ALCANCIA | MONEDAS -> coins > 0; nunca contaminan cash.
// ============================================================================

test("expenseChannels: una fuente ALCANCIA cae en coins", () => {
  const channels = expenseChannels({ amount: 50000, paymentSource: "ALCANCIA" });
  assert.equal(channels.coins, 50000);
  assert.equal(channels.cash, 0);
});

test("expenseChannels: una fuente MONEDAS tambien cae en coins", () => {
  const channels = expenseChannels({ amount: 2500, paymentSource: "MONEDAS" });
  assert.equal(channels.coins, 2500);
  assert.equal(channels.cash, 0);
});

test("expenseChannels: ALCANCIA con tilde", () => {
  const channels = expenseChannels({ amount: 1000, paymentSource: "ALCANCÍA" });
  assert.equal(channels.coins, 1000);
});

test("expenseChannels: mixto NEQUI + ALCANCIA respeta los dos canales", () => {
  const channels = expenseChannels({
    amount: 15000,
    paymentSource: "NEQUI: $10.000 / ALCANCIA: $5.000",
  });
  assert.equal(channels.nequi, 10000);
  assert.equal(channels.coins, 5000);
  assert.equal(channels.cash, 0);
});

test("expenseChannels: columnas canonicas coinsAmount priman sobre heuristica", () => {
  const channels = expenseChannels({
    amount: 7000,
    paymentSource: "FONDO",
    coinsAmount: 3000,
  });
  assert.equal(channels.coins, 3000);
});

test("getClosureExpensesSummary: coinsExpenses se expone como campo separado", () => {
  const closure = {
    expensesDetail: JSON.stringify([
      { amount: 50000, paymentSource: "ALCANCIA", status: "PAID", category: "OTROS" },
      { amount: 10000, paymentSource: "EFECTIVO", status: "PAID", category: "OTROS" },
    ]),
  };
  const summary = getClosureExpensesSummary(closure);
  assert.equal(summary.coinsExpenses, 50000);
  assert.equal(summary.cashExpenses, 10000);
  assert.equal(summary.totalExpenses, 60000);
});

test("getClosureExpensesSummary: usa egresosAlcancia del backend si lo trae", () => {
  const closure = {
    egresosTotales: 100000,
    egresosCaja: 60000,
    egresosFondo: 20000,
    egresosDigital: 15000,
    egresosAlcancia: 5000,
  };
  const summary = getClosureExpensesSummary(closure);
  assert.equal(summary.coinsExpenses, 5000);
  assert.equal(summary.totalExpenses, 100000);
});

// ============================================================================
// SANITIZACION DE cashBreakdown
//
// El backend reventaba cuando el payload traia strings vacios porque hacia
// strconv.ParseFloat(""). Este contrato garantiza que el frontend NUNCA manda
// un string vacio a `applyCashBreakdown`.
// ============================================================================

test("sanitizeCashBreakdown: convierte '' en 0 en bills y coins", () => {
  const raw = {
    bills: { "100000": "", "50000": "2", "20000": null },
    coins: { "500/1000": "", "200": "400", "100": undefined },
  };
  const safe = sanitizeCashBreakdown(raw);
  assert.deepEqual(safe, {
    bills: { "100000": 0, "50000": 2, "20000": 0 },
    coins: { "500/1000": 0, "200": 400, "100": 0 },
  });
});

test("sanitizeCashBreakdown: trata null/undefined/NaN como 0", () => {
  const safe = sanitizeCashBreakdown({
    bills: { "50000": "abc", "20000": NaN, "10000": "   " },
  });
  assert.deepEqual(safe.bills, { "50000": 0, "20000": 0, "10000": 0 });
  assert.deepEqual(safe.coins, {});
});

test("sanitizeCashBreakdown: parse colombiano ('1.000') como 1000", () => {
  const safe = sanitizeCashBreakdown({ coins: { "100": "1.000" } });
  assert.equal(safe.coins["100"], 1000);
});

test("sanitizeCashBreakdown: entrada null/undefined no explota", () => {
  assert.deepEqual(sanitizeCashBreakdown(null), { bills: {}, coins: {} });
  assert.deepEqual(sanitizeCashBreakdown(undefined), { bills: {}, coins: {} });
  assert.deepEqual(sanitizeCashBreakdown({}), { bills: {}, coins: {} });
});

test("serializeCashBreakdown: produce JSON parseable sin strings vacios", () => {
  const json = serializeCashBreakdown({
    bills: { "50000": "" },
    coins: { "500/1000": "" },
  });
  const parsed = JSON.parse(json);
  assert.equal(parsed.bills["50000"], 0);
  assert.equal(parsed.coins["500/1000"], 0);
  // Garantizar que no quede ningun string en el payload.
  for (const value of Object.values(parsed.bills).concat(Object.values(parsed.coins))) {
    assert.equal(typeof value, "number", "todas las denominaciones deben ser numeros");
  }
});

// ============================================================================
// IDEMPOTENCIA: clientClosureId
//
// Antes el backend permitia dos POST consecutivos crear dos cierres. La UI
// genera un UUID por intento, lo persiste en localStorage y lo limpia tras
// exito. Un reintento reutiliza el mismo UUID y el backend lo deduplica.
// ============================================================================

function createFakeStorage() {
  const store = new Map();
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
    get _size() { return store.size; },
    _dump() { return Object.fromEntries(store); },
  };
}

test("generateClientClosureId: devuelve un string no vacio", () => {
  const a = generateClientClosureId();
  const b = generateClientClosureId();
  assert.equal(typeof a, "string");
  assert.ok(a.length >= 16, "el id debe ser lo suficientemente largo");
  assert.notEqual(a, b, "dos llamadas no deberian colisionar");
});

test("getOrCreateClientClosureId: lo guarda bajo CLOSURE_TX_STORAGE_KEY", () => {
  const storage = createFakeStorage();
  const id = getOrCreateClientClosureId(storage);
  assert.equal(storage.getItem(CLOSURE_TX_STORAGE_KEY), id);
});

test("getOrCreateClientClosureId: lo reutiliza en el segundo intento", () => {
  const storage = createFakeStorage();
  const first = getOrCreateClientClosureId(storage);
  const second = getOrCreateClientClosureId(storage);
  assert.equal(first, second, "los reintentos deben reusar el mismo id");
});

test("getOrCreateClientClosureId: regenera cuando el storage tiene un valor muy corto", () => {
  const storage = createFakeStorage();
  storage.setItem(CLOSURE_TX_STORAGE_KEY, "x");
  const id = getOrCreateClientClosureId(storage);
  assert.notEqual(id, "x");
  assert.equal(storage.getItem(CLOSURE_TX_STORAGE_KEY), id);
});

test("clearClientClosureId: borra la clave para el proximo cierre", () => {
  const storage = createFakeStorage();
  const id = getOrCreateClientClosureId(storage);
  assert.ok(id, "debe existir un id inicial");
  clearClientClosureId(storage);
  assert.equal(storage.getItem(CLOSURE_TX_STORAGE_KEY), null);
  // El proximo getOrCreate crea uno nuevo.
  const next = getOrCreateClientClosureId(storage);
  assert.notEqual(next, id);
});

// ============================================================================
// LIMPIEZA DE sessionStorage/localStorage DEL CIERRE
// ============================================================================

test("listClosureStorageKeys: incluye todos los campos del cierre y el tx id", () => {
  const keys = listClosureStorageKeys();
  const required = [
    "pos_closure_bills",
    "pos_closure_coins",
    "pos_closure_actual",
    "pos_closure_salary",
    "pos_closure_operational",
    "pos_closure_note",
    CLOSURE_TX_STORAGE_KEY,
  ];
  for (const key of required) {
    assert.ok(keys.includes(key), `falta clave: ${key}`);
  }
});

test("clearClosureStorage: borra las 7 claves del cierre", () => {
  const storage = createFakeStorage();
  for (const key of listClosureStorageKeys()) {
    storage.setItem(key, "ocupado");
  }
  assert.ok(storage._size >= 7, "las claves deben haberse grabado");
  clearClosureStorage(storage);
  for (const key of listClosureStorageKeys()) {
    assert.equal(storage.getItem(key), null, `${key} debe quedar vacia`);
  }
});

test("clearClosureStorage: tolera storage inexistente (SSR)", () => {
  assert.doesNotThrow(() => clearClosureStorage(null));
});
