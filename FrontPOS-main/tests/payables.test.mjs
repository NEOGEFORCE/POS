import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  groupPayablesByCreditor,
  isLiveDebt,
  isLoanSource,
  liveDebtPrincipal,
  liveDebtTotal,
  selectLiveDebts,
  sumPayables,
} from "../src/lib/payables.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");

function debt(overrides = {}) {
  return {
    id: 1,
    description: "PROVEEDOR X",
    amount: 100000,
    taxAmount: 0,
    remainingAmount: 0,
    status: "PENDING",
    paymentSource: "PRESTAMO",
    ...overrides,
  };
}

// ============================================================================
// QUE CUENTA COMO DEUDA VIVA
// ============================================================================
//
// Debe coincidir con GetPendingDebtsSummary del backend Go:
//   (status = PENDING OR paymentSource IN ('PRESTAMO','PREST.'))
//   AND status NOT IN ('PAID','SETTLED')

test("un PENDING es deuda viva", () => {
  assert.equal(isLiveDebt(debt({ status: "PENDING" })), true);
});

test("un PAID o SETTLED ya no se debe", () => {
  assert.equal(isLiveDebt(debt({ status: "PAID" })), false);
  assert.equal(isLiveDebt(debt({ status: "SETTLED" })), false);
  // Aunque sea préstamo: si está pagado, está pagado.
  assert.equal(isLiveDebt(debt({ status: "SETTLED", paymentSource: "PRESTAMO" })), false);
});

test("un préstamo con estado vacío SÍ cuenta (era el que se escapaba)", () => {
  // Exigir status === 'PENDING' exacto dejaba fuera estos préstamos y la
  // pantalla mostraba menos deuda que el dashboard.
  assert.equal(isLiveDebt(debt({ status: "", paymentSource: "PRESTAMO" })), true);
  assert.equal(isLiveDebt(debt({ status: undefined, paymentSource: "PREST." })), true);
});

test("un egreso normal ya pagado sin estado no es deuda", () => {
  assert.equal(isLiveDebt(debt({ status: "", paymentSource: "EFECTIVO" })), false);
});

test("isLoanSource tolera espacios y minúsculas", () => {
  assert.equal(isLoanSource({ paymentSource: "  prestamo " }), true);
  assert.equal(isLoanSource({ paymentSource: "Prest." }), true);
  assert.equal(isLoanSource({ paymentSource: "CAJA" }), false);
});

// ============================================================================
// CUANTO SE DEBE
// ============================================================================

test("sin abonos se debe el monto original", () => {
  assert.equal(liveDebtPrincipal(debt({ amount: 180000, remainingAmount: 0 })), 180000);
});

test("con abonos se debe el saldo restante, no el original", () => {
  assert.equal(liveDebtPrincipal(debt({ amount: 180000, remainingAmount: 50000 })), 50000);
});

test("el impuesto SE DEBE y entra al total", () => {
  // La factura del proveedor se paga completa. El backend lo suma; omitirlo
  // acá subestimaba la deuda.
  const d = debt({ amount: 100000, taxAmount: 19000 });
  assert.equal(liveDebtPrincipal(d), 100000);
  assert.equal(liveDebtTotal(d), 119000);
});

test("montos basura no rompen la suma", () => {
  assert.equal(liveDebtTotal(debt({ amount: "abc", taxAmount: null })), 0);
  assert.equal(liveDebtTotal(debt({ amount: "180000", taxAmount: "20000" })), 200000);
});

test("sumPayables ignora lo ya pagado y suma impuesto", () => {
  const list = [
    debt({ id: 1, amount: 180000, taxAmount: 0 }),
    debt({ id: 2, amount: 296300, taxAmount: 0 }),
    debt({ id: 3, amount: 100000, taxAmount: 19000 }),
    debt({ id: 4, amount: 999999, status: "PAID" }), // no cuenta
    debt({ id: 5, amount: 888888, status: "SETTLED" }), // no cuenta
  ];
  assert.equal(sumPayables(list), 180000 + 296300 + 119000);
});

test("una deuda sin monto alguno no ensucia la lista", () => {
  const list = [debt({ id: 1, amount: 0, remainingAmount: 0 })];
  assert.deepEqual(selectLiveDebts(list), []);
  assert.equal(sumPayables(list), 0);
});

test("sumPayables tolera entradas vacías o inválidas", () => {
  assert.equal(sumPayables(null), 0);
  assert.equal(sumPayables(undefined), 0);
  assert.equal(sumPayables([]), 0);
});

// ============================================================================
// AGRUPADO POR ACREEDOR
// ============================================================================

test("agrupa por acreedor con subtotal y ordena de mayor a menor deuda", () => {
  const list = [
    debt({ id: 1, lenderName: "FABIAN", amount: 100000 }),
    debt({ id: 2, lenderName: "SEBASTIAN", amount: 500000 }),
    debt({ id: 3, lenderName: "FABIAN", amount: 50000 }),
  ];
  const groups = groupPayablesByCreditor(list);

  assert.equal(groups.length, 2);
  // El que más se le debe va primero: es lo primero que uno quiere ver.
  assert.equal(groups[0].creditor, "SEBASTIAN");
  assert.equal(groups[0].total, 500000);
  assert.equal(groups[1].creditor, "FABIAN");
  assert.equal(groups[1].total, 150000);
  assert.equal(groups[1].debts.length, 2);
});

test("usa el nombre del proveedor cuando no hay prestamista, y un cajón final", () => {
  const groups = groupPayablesByCreditor([
    debt({ id: 1, lenderName: null, supplier: { name: "BIMBO" }, amount: 10000 }),
    debt({ id: 2, lenderName: null, supplier: null, amount: 5000 }),
  ]);
  const names = groups.map((g) => g.creditor);
  assert.ok(names.includes("BIMBO"));
  assert.ok(names.includes("OTROS ACREEDORES"));
});

// ============================================================================
// GUARDIAN: NADIE RECALCULA LAS CUENTAS POR PAGAR POR SU CUENTA
// ============================================================================
//
// El bug del 2026-09-04 nació de tener la misma fórmula escrita en varios
// lugares con criterios distintos. Este test estático impide que vuelva a
// aparecer una copia suelta.

const consumers = [
  // /expenses sigue filtrando con selectLiveDebts para OCULTAR las deudas
  // vivas de su tabla principal (viven y se abonan en /loans).
  join(srcRoot, "app", "(app)", "expenses", "page.tsx"),
  // El Centro de Pagos se mudó de /expenses a /loans como pestaña visible.
  // Es la ÚNICA pantalla donde se abonan o condonan deudas vivas.
  join(srcRoot, "app", "(app)", "loans", "components", "PayablesCenter.tsx"),
  // La página de /loans monta el PayablesCenter y usa sumPayables en el
  // footer de totales.
  join(srcRoot, "app", "(app)", "loans", "page.tsx"),
  // El dashboard conserva su propio modal de deudas (payload simplificado);
  // la unificación con la nueva ubicación es tarea de un sprint posterior.
  join(srcRoot, "app", "(app)", "dashboard", "components", "PendingDebtsModal.tsx"),
];

test("las pantallas de deuda usan el helper compartido y no su propia fórmula", async () => {
  for (const file of consumers) {
    const source = await readFile(file, "utf8");

    assert.ok(
      /from ['"]@\/lib\/payables\.mjs['"]/.test(source),
      `${file} debe importar la fórmula de @/lib/payables.mjs`
    );

    // El patrón de la fórmula duplicada: elegir entre remainingAmount y amount
    // a mano. Si vuelve a aparecer, es una copia divergente.
    assert.ok(
      !/remainingAmount\s*>\s*0\s*\?\s*[\w.]*remainingAmount\s*:/.test(source),
      `${file} no puede reimplementar el saldo pendiente: usá liveDebtPrincipal/liveDebtTotal`
    );
  }
});

test("el Centro de Pagos no usa diálogos nativos del navegador", async () => {
  // Índice 1 del array consumers → PayablesCenter.tsx (la nueva ubicación
  // tras mover el Centro de Pagos de /expenses a /loans).
  const source = await readFile(consumers[1], "utf8");
  for (const nativo of ["window.confirm", "window.alert", "window.prompt"]) {
    assert.ok(!source.includes(nativo), `no se permite ${nativo} en el Centro de Pagos`);
  }
  // `confirm(` suelto también estaba en el código original.
  assert.ok(
    !/(^|[^.\w])confirm\s*\(/.test(source),
    "no se permite confirm() nativo: usá el modal de confirmación propio"
  );
  // Y la confirmación de condonar tiene que seguir existiendo: es destructiva.
  assert.ok(/debtToForgive/.test(source), "debe existir la confirmación propia para condonar");
});

// ============================================================================
// MIGRACIÓN: El Centro de Pagos vive EN /loans, NO en /expenses.
// ============================================================================
//
// Reglas del traslado (sprint 2026-10-05):
//   - /expenses no monta PendingDebtsModal ni dispara el modal (sin
//     tarjeta/botón/modal de cuentas por pagar).
//   - El flujo de abono y condonación comparte endpoints con el original
//     (PATCH /expenses/settle/:id y PUT /expenses/:id) — reutilizados
//     desde /loans/page.tsx, sin inventar backend.
//   - El guardián prohíbe redescubrir una "copia" del modal.

test("expenses/page NO monta el modal/CTA de cuentas por pagar", async () => {
  const expensesPage = await readFile(join(srcRoot, "app", "(app)", "expenses", "page.tsx"), "utf8");
  assert.ok(
    !/PendingDebtsModal|PayablesCenter/.test(expensesPage),
    "expenses/page no debe importar ni montar el centro de pagos (vive en /loans)",
  );
  assert.ok(
    !/onOpenPending/.test(expensesPage),
    "expenses/page no debe pasar onOpenPending a ExpenseStats",
  );
  assert.ok(
    !/handleSettleDebt|handleForceCloseDebt/.test(expensesPage),
    "expenses/page no debe conservar los handlers de settle/forceClose (viven en /loans)",
  );
});

test("expenses/components/ExpenseStats no muestra la tarjeta 'Cuentas por Pagar'", async () => {
  const stats = await readFile(join(srcRoot, "app", "(app)", "expenses", "components", "ExpenseStats.tsx"), "utf8");
  // Props removidos
  assert.ok(!/totalPending/.test(stats), "ExpenseStats no debe exponer prop totalPending");
  assert.ok(!/onOpenPending/.test(stats), "ExpenseStats no debe exponer prop onOpenPending");
  // Y la tarjeta visual tampoco debe estar.
  assert.ok(
    !/Cuentas\s+por\s+Pagar/i.test(stats),
    "ExpenseStats no debe renderizar la tarjeta 'Cuentas por Pagar' (vive en /loans)",
  );
});

test("el archivo PendingDebtsModal.tsx ya NO existe en /expenses/components", async () => {
  const legacyPath = join(srcRoot, "app", "(app)", "expenses", "components", "PendingDebtsModal.tsx");
  let found = false;
  try {
    await readFile(legacyPath, "utf8");
    found = true;
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  assert.ok(!found, "El modal viejo debe quedar borrado tras moverse a /loans/components/PayablesCenter.tsx");
});

test("loans/page es el único consumidor que ABONA o CONDONA cuentas por pagar", async () => {
  const loansPage = await readFile(join(srcRoot, "app", "(app)", "loans", "page.tsx"), "utf8");

  // Debe tener los handlers y los endpoints exactos del flujo trasladado.
  assert.ok(/handleSettleDebt/.test(loansPage), "loans/page debe implementar handleSettleDebt");
  assert.ok(/handleForceCloseDebt/.test(loansPage), "loans/page debe implementar handleForceCloseDebt");
  assert.ok(
    /\/expenses\/settle\/\$\{/.test(loansPage),
    "loans/page debe llamar al endpoint existente PATCH /expenses/settle/:id (NO inventa backend)",
  );
  assert.ok(
    /PUT[\s\S]{0,120}\/expenses\/\$\{/.test(loansPage) || /\/expenses\/\$\{[^}]+\}[\s\S]{0,80}method:\s*["']PUT/.test(loansPage),
    "loans/page debe conservar el path irregular PUT /expenses/:id para condonar",
  );

  // Y monta el PayablesCenter como pestaña, no como modal.
  assert.ok(/PayablesCenter/.test(loansPage), "loans/page debe montar PayablesCenter");

  // No duplica fetchs: una sola llamada apiFetch a /expenses/list para
  // alimentar la pestaña de cuentas por pagar. Las menciones en comentarios
  // o docstrings no cuentan — contamos sólo invocaciones reales.
  const fetchCalls = loansPage.match(/apiFetch[\s\S]{0,120}["'`]\/expenses\/list["'`]/g) || [];
  assert.ok(
    fetchCalls.length === 1,
    `loans/page debe tener EXACTAMENTE una llamada apiFetch a /expenses/list (encontradas: ${fetchCalls.length})`,
  );
});

test("loans/page expone un deep link ?pagos para aterrizar en Cuentas por pagar", async () => {
  const loansPage = await readFile(join(srcRoot, "app", "(app)", "loans", "page.tsx"), "utf8");
  assert.ok(
    /pagos/.test(loansPage) && /useSearchParams/.test(loansPage),
    "loans/page debe leer ?pagos de useSearchParams para abrir la pestaña de deuda directamente",
  );
});
