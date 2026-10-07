import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adminCanCorrectPayment,
  employeeCanCorrectPayment,
  initialPaidAmountsFromSale,
  isAdmin,
  isEmployee,
  resolvePaymentCorrectionEndpoint,
  validateEmployeeCorrectionPayload,
} from "../src/lib/payment-correction.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const saleEditPath = join(here, "..", "src", "app", "(app)", "sales", "components", "SaleEditModal.tsx");
const salesTablePath = join(here, "..", "src", "app", "(app)", "sales", "components", "SalesTable.tsx");

// ============================================================================
// CORRECCIÓN DE MEDIO DE PAGO
// ============================================================================
//
// REGLA DEL DUEÑO (2026-10-01):
//
// (A) El admin conserva el endpoint `PUT /sales/update-payment/:id` sin
//     cambios. Puede corregir cualquier venta y mover a/desde fiado.
//
// (B) El EMPLEADO que hizo la venta puede corregir SU PROPIA venta en SU
//     TURNO ACTIVO, usando un endpoint distinto:
//         POST /sales/correct-payment-channel/:id
//
//     Acotaciones (todas obligatorias):
//       - mismo empleado + turno abierto
//       - no cambia total, cliente, productos
//       - no mueve a/desde FIADO
//       - sólo redistribuye entre efectivo y canales de transferencia
//       - venta SIN devoluciones ni abonos/fiado
//
// Las ROUTES del backend (admin PUT, empleado POST) son diferentes porque el
// servicio es semánticamente distinto. El cambio de verbo HTTP NO es una
// forma de eludir la seguridad: el backend valida el actor, el turno, la
// ausencia de devoluciones/fiado, y rechaza con 403/409. El frontend
// documenta esta excepción explícitamente en las pruebas de rutas.

// --- roleHelpers ---

test("isAdmin reconoce las variantes del rol", () => {
  assert.equal(isAdmin({ role: "admin" }), true);
  assert.equal(isAdmin({ role: "ADMIN" }), true);
  assert.equal(isAdmin({ role: "administrador" }), true);
  assert.equal(isAdmin({ Role: "superadmin" }), true);
  assert.equal(isAdmin({ role: "empleado" }), false);
  assert.equal(isAdmin(null), false);
});

test("isEmployee reconoce empleado/cajero y rechaza admin", () => {
  assert.equal(isEmployee({ role: "empleado" }), true);
  assert.equal(isEmployee({ role: "employee" }), true);
  assert.equal(isEmployee({ role: "CAJERO" }), true);
  assert.equal(isEmployee({ role: "admin" }), false);
});

// --- adminCanCorrectPayment ---

test("admin puede corregir siempre, con cualquier venta", () => {
  const sale = { id: "1", total: 10000, cashAmount: 10000, transferAmount: 0, creditAmount: 0 };
  assert.equal(adminCanCorrectPayment(sale, { role: "admin" }), true);
  // Incluso con fiado o devoluciones: el admin tiene el endpoint grande.
  assert.equal(adminCanCorrectPayment({ ...sale, creditAmount: 500 }, { role: "admin" }), true);
  assert.equal(adminCanCorrectPayment({ ...sale, hasReturns: true }, { role: "admin" }), true);
});

test("un no-admin nunca puede usar el endpoint admin", () => {
  const sale = { id: "1", total: 10000 };
  assert.equal(adminCanCorrectPayment(sale, { role: "empleado" }), false);
  assert.equal(adminCanCorrectPayment(sale, {}), false);
});

// --- employeeCanCorrectPayment ---

const EMPLEADO_X = { role: "empleado", dni: "123" };

function baseEmployeeSale(over = {}) {
  return {
    id: "s1",
    total: 10000,
    cashAmount: 10000,
    transferAmount: 0,
    creditAmount: 0,
    employee: { dni: "123" },
    details: [],
    ...over,
  };
}

test("empleado del mismo turno puede corregir su propia venta sin devoluciones ni fiado", () => {
  const sale = baseEmployeeSale();
  assert.equal(employeeCanCorrectPayment(sale, EMPLEADO_X, { shiftOpen: true }), true);
});

test("empleado NO puede corregir una venta ajena", () => {
  const otraVenta = baseEmployeeSale({ employee: { dni: "999" } });
  assert.equal(employeeCanCorrectPayment(otraVenta, EMPLEADO_X, { shiftOpen: true }), false);
});

test("empleado NO puede corregir si la venta tuvo devoluciones", () => {
  const venta = baseEmployeeSale({
    details: [{ barcode: "X", quantity: 2, returnedQty: 1 }],
  });
  assert.equal(employeeCanCorrectPayment(venta, EMPLEADO_X, { shiftOpen: true }), false);
});

test("empleado NO puede corregir si la venta fue fiada o tiene abonos pendientes", () => {
  assert.equal(
    employeeCanCorrectPayment(baseEmployeeSale({ creditAmount: 500 }), EMPLEADO_X, { shiftOpen: true }),
    false,
  );
  assert.equal(
    employeeCanCorrectPayment(baseEmployeeSale({ debtPending: 500 }), EMPLEADO_X, { shiftOpen: true }),
    false,
  );
  assert.equal(
    employeeCanCorrectPayment(baseEmployeeSale({ paymentMethod: "FIADO" }), EMPLEADO_X, { shiftOpen: true }),
    false,
  );
});

test("empleado NO puede corregir si el turno está cerrado", () => {
  const sale = baseEmployeeSale();
  assert.equal(employeeCanCorrectPayment(sale, EMPLEADO_X, { shiftOpen: false }), false);
});

// --- resolvePaymentCorrectionEndpoint ---

test("resolvePaymentCorrectionEndpoint devuelve PUT para admin", () => {
  const resolution = resolvePaymentCorrectionEndpoint({ id: "42" }, { role: "admin" });
  assert.equal(resolution?.method, "PUT");
  assert.equal(resolution?.path, "/sales/update-payment/42");
  assert.equal(resolution?.actor, "admin");
});

test("resolvePaymentCorrectionEndpoint devuelve POST para empleado elegible", () => {
  const sale = baseEmployeeSale({ id: "9" });
  const resolution = resolvePaymentCorrectionEndpoint(sale, EMPLEADO_X, { shiftOpen: true });
  assert.equal(resolution?.method, "POST");
  assert.equal(resolution?.path, "/sales/correct-payment-channel/9");
  assert.equal(resolution?.actor, "employee");
});

test("resolvePaymentCorrectionEndpoint devuelve null cuando el empleado no es elegible", () => {
  const otra = baseEmployeeSale({ employee: { dni: "999" } });
  assert.equal(resolvePaymentCorrectionEndpoint(otra, EMPLEADO_X, { shiftOpen: true }), null);
});

// --- initialPaidAmountsFromSale ---

test("precarga los montos EXACTOS de la venta para evitar que el empleado los tipeé", () => {
  const sale = { total: 10000, cashAmount: 10000, transferAmount: 0, creditAmount: 0 };
  const got = initialPaidAmountsFromSale(sale);
  assert.equal(got.cash, 10000);
  assert.equal(got.nequi, 0);
  assert.equal(got.daviplata, 0);
  assert.equal(got.otherTransfer, 0);
  assert.equal(got.credit, 0);
  // Alias retrocompatibles con la version anterior del shape.
  assert.equal(got.transfer, 0);
  assert.equal(got.transferSource, "");
});

test("precarga reconoce Nequi vs Daviplata para orientar la fuente", () => {
  const sale = { total: 50000, cashAmount: 0, transferAmount: 50000, transferNequi: 50000, transferDaviplata: 0 };
  const result = initialPaidAmountsFromSale(sale);
  assert.equal(result.transferSource, "NEQUI");
  assert.equal(result.nequi, 50000);
  assert.equal(result.daviplata, 0);
  const sale2 = { total: 50000, transferAmount: 50000, transferDaviplata: 50000, transferNequi: 0 };
  const result2 = initialPaidAmountsFromSale(sale2);
  assert.equal(result2.transferSource, "DAVIPLATA");
  assert.equal(result2.daviplata, 50000);
});

test("precarga NO colapsa Nequi + Daviplata simultaneos (bug critico del historial corregido)", () => {
  // Caso raiz: venta corregida 50/50 Nequi + Daviplata. Antes el helper
  // colapsaba ambos en {transfer, transferSource} singular y el modal
  // mostraba 0 en los dos canales. Ahora deben venir por SEPARADO.
  const sale = {
    total: 20000,
    cashAmount: 0,
    transferAmount: 20000,
    transferNequi: 10000,
    transferDaviplata: 10000,
    transferSource: "MIXTO",
  };
  const got = initialPaidAmountsFromSale(sale);
  assert.equal(got.nequi, 10000);
  assert.equal(got.daviplata, 10000);
  assert.equal(got.cash, 0);
  // El transferSource "principal" para orientar el tab inicial del modal
  // elige el canal con mayor monto (empate -> NEQUI).
  assert.equal(got.transferSource, "NEQUI");
  assert.equal(got.transfer, 20000);
});

test("precarga separa cash + nequi + daviplata (combinacion tipica tras correccion)", () => {
  const sale = {
    total: 30000,
    cashAmount: 10000,
    transferAmount: 20000,
    transferNequi: 15000,
    transferDaviplata: 5000,
  };
  const got = initialPaidAmountsFromSale(sale);
  assert.equal(got.cash, 10000);
  assert.equal(got.nequi, 15000);
  assert.equal(got.daviplata, 5000);
});

// --- validateEmployeeCorrectionPayload ---

test("empleado NO puede cambiar el total: la suma debe ser igual al total original", () => {
  const sale = { total: 10000 };
  const bad = { cashAmount: 5000, transferAmount: 0, creditAmount: 0 };
  assert.equal(validateEmployeeCorrectionPayload(bad, sale).ok, false);
  const good = { cashAmount: 7000, transferAmount: 3000, creditAmount: 0 };
  assert.equal(validateEmployeeCorrectionPayload(good, sale).ok, true);
});

test("empleado NO puede dejar nada en FIADO", () => {
  const sale = { total: 10000 };
  const bad = { cashAmount: 5000, transferAmount: 2000, creditAmount: 3000 };
  const result = validateEmployeeCorrectionPayload(bad, sale);
  assert.equal(result.ok, false);
  assert.equal(result.error, "credit-not-allowed");
});

test("empleado NO puede enviar magnitudes negativas", () => {
  const sale = { total: 10000 };
  const bad = { cashAmount: -1, transferAmount: 10001, creditAmount: 0 };
  assert.equal(validateEmployeeCorrectionPayload(bad, sale).ok, false);
});

test("empleado NO puede enviar un desglose transferNequi+transferDaviplata que supere transferAmount", () => {
  // Replica la regla backend ValidateCorrectPaymentChannelRequest para
  // evitar un 400 por round-trip. El payload mantiene el total (ok), pero
  // el desglose por canal digital es inconsistente.
  const sale = { total: 10000 };
  const bad = {
    cashAmount: 0,
    transferAmount: 10000,
    transferNequi: 7000,
    transferDaviplata: 7000, // suma 14000 > 10000 + 5
    creditAmount: 0,
  };
  const result = validateEmployeeCorrectionPayload(bad, sale);
  assert.equal(result.ok, false);
  assert.equal(result.error, "transfer-breakdown-exceeds-total");
});

test("empleado SI puede enviar un desglose mitad Nequi y mitad Daviplata que suma el total", () => {
  const sale = { total: 10000 };
  const good = {
    cashAmount: 0,
    transferAmount: 10000,
    transferNequi: 5000,
    transferDaviplata: 5000,
    creditAmount: 0,
  };
  assert.equal(validateEmployeeCorrectionPayload(good, sale).ok, true);
});

// ---------------------------------------------------------------------------
// Guardianes estáticos: SaleEditModal usa el endpoint correcto por rol y
// precarga los montos iniciales. SalesTable muestra "Corregir Pago" sólo si
// hay elegibilidad.
// ---------------------------------------------------------------------------

test("SaleEditModal rutea por rol usando resolvePaymentCorrectionEndpoint", async () => {
  const source = await readFile(saleEditPath, "utf8");
  assert.match(source, /resolvePaymentCorrectionEndpoint/,
    "el modal usa el helper centralizado para decidir el endpoint");
  // Mantiene el PUT del admin.
  assert.match(source, /\/sales\/update-payment\//,
    "el endpoint admin PUT sigue vivo");
  // Y usa el POST nuevo para empleado.
  assert.match(source, /\/sales\/correct-payment-channel\//,
    "el endpoint nuevo POST para empleado está cableado");
  // Precarga los montos iniciales (no obliga a redigitar).
  assert.match(source, /initialPaidAmountsFromSale/,
    "los montos iniciales se precargan desde la venta");
  // 403 / 409 se muestran con mensajes claros (status explícito en el catch).
  assert.match(source, /status === 403/, "maneja explícitamente 403");
  assert.match(source, /status === 409/, "maneja explícitamente 409");
});

test("SalesTable sólo muestra Corregir Pago cuando hay elegibilidad", async () => {
  const source = await readFile(salesTablePath, "utf8");
  // Debe usar el helper de autorización, no un simple isAdmin boolean como
  // antes. El botón se oculta si no hay endpoint resuelto.
  assert.match(source, /canCorrectPayment/, "pasa un flag canCorrectPayment a cada fila");
  // El tooltip indica correctamente la acción.
  assert.match(source, /CORREGIR/, "mantiene el label 'CORREGIR'");
});
