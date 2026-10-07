import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeLoanPayExpenseResponse } from "../src/lib/loans.mjs";

// ============================================================================
// Guardianes y tests unitarios para la opción "pagar con PRÉSTAMO" del
// ExpensePaymentModal + enrutamiento al endpoint
// `POST /api/loans/:id/pay-expense`.
//
// Reglas de oro que estos tests protegen:
//
//   1. El frontend NO fabrica `paymentSource='PRESTAMO'` en el payload de
//      /loans/:id/pay-expense: ese canal lo pone el backend. El payload
//      sólo lleva `loanId` + metadata (`expenseId`, `amount`, `description`,
//      `category`, `supplierId`, `purpose`).
//   2. La opción "Préstamo" en ExpensePaymentModal sólo aparece cuando el
//      padre entrega `loanOption?.enabled`. En /loans/detail (pagar cuota)
//      y en /inventory/receive (recepción de mercancía) NO debe aparecer.
//   3. Los consumidores correctos (ExpenseFormModal y PayablesCenter) sí
//      pasan `loanOption` cuando corresponde.
//   4. El normalizador de respuesta `{ expense, loanExpense, totalUsed,
//      available }` es puro y tolerante.
// ============================================================================

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");

const PAYMENT_MODAL = join(srcRoot, "app", "(app)", "expenses", "components", "ExpensePaymentModal.tsx");
const EXPENSE_FORM_MODAL = join(srcRoot, "app", "(app)", "expenses", "components", "ExpenseFormModal.tsx");
const EXPENSES_PAGE = join(srcRoot, "app", "(app)", "expenses", "page.tsx");
const PAYABLES_CENTER = join(srcRoot, "app", "(app)", "loans", "components", "PayablesCenter.tsx");
const LOANS_PAGE = join(srcRoot, "app", "(app)", "loans", "page.tsx");
const CLOSURE_PAGE = join(srcRoot, "app", "(app)", "dashboard", "closure", "page.tsx");

const LOANS_DETAIL = join(srcRoot, "app", "(app)", "loans", "detail", "page.tsx");
const INVENTORY_RECEIVE = join(srcRoot, "app", "(app)", "inventory", "receive", "page.tsx");
const EXPENSE_TABLE = join(srcRoot, "app", "(app)", "expenses", "components", "ExpenseTable.tsx");

async function leer(path) {
  return readFile(path, "utf8");
}

// ============================================================================
// 1. normalizeLoanPayExpenseResponse — helper puro
// ============================================================================

test("normalizeLoanPayExpenseResponse: shape canónico se preserva", () => {
  const res = normalizeLoanPayExpenseResponse({
    expense: { id: 7, amount: 25000, paymentSource: "PRESTAMO" },
    loanExpense: { id: 3, loanId: 10, amountUsed: 25000 },
    totalUsed: 125000,
    available: 375000,
  });
  assert.ok(res);
  assert.equal(res.totalUsed, 125000);
  assert.equal(res.available, 375000);
  assert.equal(res.expense.id, 7);
  assert.equal(res.loanExpense.amountUsed, 25000);
});

test("normalizeLoanPayExpenseResponse: tolera available/totalUsed ausentes", () => {
  const res = normalizeLoanPayExpenseResponse({ expense: { id: 1 } });
  assert.ok(res);
  assert.equal(res.totalUsed, 0);
  assert.equal(res.available, 0);
  assert.equal(res.loanExpense, null);
});

test("normalizeLoanPayExpenseResponse: null para shape irreconocible", () => {
  assert.equal(normalizeLoanPayExpenseResponse(null), null);
  assert.equal(normalizeLoanPayExpenseResponse(undefined), null);
  assert.equal(normalizeLoanPayExpenseResponse({}), null);
  assert.equal(normalizeLoanPayExpenseResponse("meh"), null);
});

test("normalizeLoanPayExpenseResponse: strings numéricos se parsean", () => {
  const res = normalizeLoanPayExpenseResponse({
    expense: {},
    loanExpense: {},
    totalUsed: "150000.50",
    available: "350000",
  });
  assert.equal(res.totalUsed, 150000.5);
  assert.equal(res.available, 350000);
});

// ============================================================================
// 2. ExpensePaymentModal — la opción aparece sólo con loanOption.enabled
// ============================================================================

test("ExpensePaymentModal: expone la prop opcional loanOption", async () => {
  const src = await leer(PAYMENT_MODAL);
  assert.match(src, /loanOption\?:\s*LoanOption/, "El modal debe declarar la prop loanOption?: LoanOption");
  assert.match(src, /export interface LoanOption/, "Debe exportar el tipo LoanOption para los consumidores");
});

test("ExpensePaymentModal: el payload de onPay admite loanId opcional", async () => {
  const src = await leer(PAYMENT_MODAL);
  // El tipo del payload tiene que exponer loanId para que el padre lo
  // reciba cuando el usuario elige la pestaña Préstamo.
  assert.match(src, /loanId\?:\s*number\s*\|\s*string/, "ExpensePaymentModalPayload debe incluir loanId opcional");
});

test("ExpensePaymentModal: la pestaña 'Préstamo' se agrega SOLO con loanTabEnabled", async () => {
  const src = await leer(PAYMENT_MODAL);
  assert.match(src, /HandCoins/, "Debe importar y usar el icono HandCoins para la pestaña préstamo");
  assert.match(
    src,
    /loanTabEnabled[\s\S]{0,120}id:\s*'loan'/,
    "La pestaña 'loan' debe ser condicional a loanTabEnabled (sin loanOption no debe existir)",
  );
  // Mensaje "No hay préstamos activos" para empty state (requisito explícito).
  assert.match(
    src,
    /No hay préstamos activos/i,
    "Debe mostrar 'No hay préstamos activos' cuando la lista está vacía",
  );
  // Mensaje para available < totalToPay.
  assert.match(
    src,
    /El préstamo sólo tiene \$/i,
    "Debe mostrar 'El préstamo sólo tiene $X disponible' cuando el disponible es menor al total",
  );
});

test("ExpensePaymentModal: préstamo es canal EXCLUSIVO (limpia los demás)", async () => {
  const src = await leer(PAYMENT_MODAL);
  // Al elegir la pestaña loan, los setters de los otros canales deben
  // ponerse en 0 para evitar mezcla (el contrato backend no la soporta).
  assert.match(src, /setCashPaid\(0\)/);
  assert.match(src, /setNequiPaid\(0\)/);
  assert.match(src, /setDaviplataPaid\(0\)/);
  assert.match(src, /setFondoPaid\(0\)/);
  assert.match(src, /setCoinsPaid\(0\)/);
});

test("ExpensePaymentModal: al autorizar con préstamo, onPay recibe loanId y canales en 0", async () => {
  const src = await leer(PAYMENT_MODAL);
  // Buscamos el bloque específico de la rama préstamo del processPayment.
  const match = src.match(/if \(activePaymentTab === 'loan'\)[\s\S]{0,2000}?await onPay\(\{[\s\S]{0,600}?\}\)/);
  assert.ok(match, "Debe existir un onPay dedicado para la rama préstamo");
  const block = match[0];
  // Todos los canales en 0 y paymentSourceString = 'PRESTAMO'.
  assert.match(block, /cash:\s*0/);
  assert.match(block, /nequi:\s*0/);
  assert.match(block, /daviplata:\s*0/);
  assert.match(block, /fondo:\s*0/);
  assert.match(block, /coins:\s*0/);
  assert.match(block, /paymentSourceString:\s*['"]PRESTAMO['"]/);
  assert.match(block, /taxAmount:\s*0/);
  assert.match(block, /loanId:\s*chosen\.id/);
});

// ============================================================================
// 3. Consumidores CORRECTOS pasan loanOption
// ============================================================================

test("ExpenseFormModal: expone la prop loanOption y la pasa al ExpensePaymentModal", async () => {
  const src = await leer(EXPENSE_FORM_MODAL);
  assert.match(src, /loanOption\?:\s*LoanOption/);
  // El import del tipo tiene que venir de ExpensePaymentModal.
  assert.match(src, /import[\s\S]*LoanOption[\s\S]*from\s+['"]\.\/ExpensePaymentModal['"]/);
  // El modal interior recibe loanOption={loanOption}.
  assert.match(
    src,
    /<ExpensePaymentModal[\s\S]{0,2000}loanOption=\{loanOption\}/,
    "ExpenseFormModal debe propagar loanOption al ExpensePaymentModal",
  );
});

test("expenses/page: carga /loans y pasa loanOption al ExpenseFormModal (admin only)", async () => {
  const src = await leer(EXPENSES_PAGE);
  assert.match(src, /from ['"]@\/lib\/loans\.mjs['"]/, "debe importar helpers de loans.mjs");
  // Un fetch a /loans (vía apiFetch) cuando se abre el modal.
  assert.match(
    src,
    /apiFetch[\s\S]{0,160}['"`]\/loans['"`]/,
    "expenses/page debe llamar apiFetch a /loans",
  );
  // Usa normalizeLoanListResponse y liveLoanAvailable como fuente única.
  assert.match(src, /normalizeLoanListResponse/);
  assert.match(src, /liveLoanAvailable/);
  // Pasa loanOption al ExpenseFormModal.
  assert.match(
    src,
    /<ExpenseFormModal[\s\S]{0,800}loanOption=\{addDialogOpen \? loanOption : undefined\}/,
    "expenses/page debe pasar loanOption al ExpenseFormModal",
  );
});

test("expenses/page: cuando el payload trae loanId, llama POST /loans/:id/pay-expense", async () => {
  const src = await leer(EXPENSES_PAGE);
  assert.match(
    src,
    /\/loans\/\$\{[^}]+\}\/pay-expense/,
    "expenses/page debe tener la ruta /loans/:id/pay-expense con template literal",
  );
  // No fabrica paymentSource='PRESTAMO' en el payload a pay-expense.
  // (Chequeo general: ningún payload nuevo cerca de pay-expense debe
  // mandar paymentSource).
  const section = src.match(/data\.loanId[\s\S]{0,3000}?pay-expense[\s\S]{0,2000}?\}/);
  assert.ok(section, "Debe existir el bloque específico de pay-expense");
  assert.ok(
    !/paymentSource\s*:\s*['"]PRESTAMO['"]/.test(section[0]),
    "La rama pay-expense NO debe fabricar paymentSource='PRESTAMO' (lo pone el backend)",
  );
  // El payload debe incluir amount y purpose/description.
  assert.match(section[0], /amount/);
  assert.match(section[0], /description/);
});

test("expenses/page: mapea códigos de error del endpoint (LOAN_NOT_ACTIVE / EXCEEDED)", async () => {
  const src = await leer(EXPENSES_PAGE);
  assert.match(src, /LOAN_NOT_ACTIVE/);
  assert.match(src, /LOAN_PRINCIPAL_EXCEEDED/);
});

test("PayablesCenter: expone loanOption y lo pasa al ExpensePaymentModal", async () => {
  const src = await leer(PAYABLES_CENTER);
  assert.match(src, /loanOption\?:\s*LoanOption/);
  assert.match(src, /import[\s\S]*LoanOption[\s\S]*from\s+["']@\/app\/\(app\)\/expenses\/components\/ExpensePaymentModal["']/);
  assert.match(
    src,
    /<ExpensePaymentModal[\s\S]{0,1200}loanOption=\{loanOption\}/,
    "PayablesCenter debe propagar loanOption al ExpensePaymentModal",
  );
  // El payload de onPay admite loanId.
  assert.match(
    src,
    /loanId\?:\s*number\s*\|\s*string/,
    "handleSettleClick debe admitir loanId en paymentData",
  );
});

test("loans/page: calcula loanOption desde liveLoanAvailable y lo pasa al PayablesCenter", async () => {
  const src = await leer(LOANS_PAGE);
  assert.match(src, /liveLoanAvailable/);
  // Pasa loanOption al PayablesCenter.
  assert.match(
    src,
    /<PayablesCenter[\s\S]{0,500}loanOption=\{loanOptionForPayables\}/,
    "loans/page debe pasar loanOption al PayablesCenter",
  );
});

test("loans/page: cuando el modal entrega loanId, enruta a POST /loans/:id/pay-expense", async () => {
  const src = await leer(LOANS_PAGE);
  assert.match(
    src,
    /\/loans\/\$\{[^}]+\}\/pay-expense/,
    "loans/page debe tener el endpoint /loans/:id/pay-expense",
  );
  // Mapeo de errores incluye los códigos nuevos.
  assert.match(src, /LOAN_NOT_ACTIVE/);
  assert.match(src, /LOAN_PRINCIPAL_EXCEEDED/);
  // Toast claro ("no afecta la caja" como pedido textual del contrato UX).
  assert.match(src, /no afecta la caja/i);
});

test("loans/page: la rama préstamo NO fabrica paymentSource='PRESTAMO' en el body", async () => {
  // Guardián: respeta el contrato loans-ui-contract. El backend coloca el
  // canal; el frontend sólo manda loanId + metadata.
  const src = await leer(LOANS_PAGE);
  const payExpenseMatches = [...src.matchAll(/pay-expense[\s\S]{0,1200}?\}/g)];
  assert.ok(payExpenseMatches.length > 0, "debe haber al menos una invocación a pay-expense");
  for (const m of payExpenseMatches) {
    assert.ok(
      !/paymentSource\s*:\s*['"]PRESTAMO['"]/.test(m[0]),
      "La rama pay-expense NO debe fabricar paymentSource='PRESTAMO'",
    );
  }
});

// ============================================================================
// 4. Consumidores INCORRECTOS NO pasan loanOption
// ============================================================================

test("loans/detail: NO pasa loanOption al ExpensePaymentModal (pagar cuota con el mismo préstamo es un bucle)", async () => {
  const src = await leer(LOANS_DETAIL);
  // El modal se usa para pagar cuotas; permitir pagar la cuota de un préstamo
  // con la plata del mismo préstamo es un bucle sin sentido y además lo
  // prohíbe AllowedDisbursementChannels del backend.
  const modalMatches = [...src.matchAll(/<ExpensePaymentModal[\s\S]{0,1500}\/>/g)];
  assert.ok(modalMatches.length > 0, "loans/detail debe seguir usando ExpensePaymentModal para pagar cuotas");
  for (const m of modalMatches) {
    assert.ok(
      !/loanOption/.test(m[0]),
      "loans/detail NO debe pasar loanOption al ExpensePaymentModal",
    );
  }
});

test("inventory/receive: NO pasa loanOption al ExpensePaymentModal", async () => {
  const src = await leer(INVENTORY_RECEIVE);
  const modalMatches = [...src.matchAll(/<ExpensePaymentModal[\s\S]{0,1500}\/>/g)];
  assert.ok(modalMatches.length > 0, "inventory/receive debe seguir usando ExpensePaymentModal");
  for (const m of modalMatches) {
    assert.ok(
      !/loanOption/.test(m[0]),
      "inventory/receive NO debe pasar loanOption — pagar recepción con préstamo requiere coordinación con BulkReceive (fuera de alcance)",
    );
  }
});

// ============================================================================
// 5. Tabla de /expenses: chip "PRÉSTAMO" con acento, y los stats no suman
//    los PRESTAMO. ExpenseStats sigue excluyendo PRESTAMO del totalMonth.
// ============================================================================

test("ExpenseTable: el canal 'PRESTAMO' se muestra como 'PRÉSTAMO' con acento", async () => {
  const src = await leer(EXPENSE_TABLE);
  // La función de display convierte PRESTAMO/PREST a PRÉSTAMO.
  assert.match(src, /PRESTAMO\\b\/g,\s*['"]PRÉSTAMO['"]/);
  // El estilo (chip ámbar) acepta la versión con acento.
  assert.match(
    src,
    /s === 'PRESTAMO'[\s\S]{0,80}s === 'PRÉSTAMO'/,
    "getPaymentSourceStyle debe reconocer 'PRÉSTAMO' con acento como ámbar",
  );
});

test("expenses/page: ExpenseStats (totalMonth) excluye los egresos PRESTAMO", async () => {
  // Guardián: el filtro ya existía y debe mantenerse. El egreso de
  // préstamo es informativo; no cuenta en el total del mes.
  const src = await leer(EXPENSES_PAGE);
  assert.match(
    src,
    /e\.paymentSource\?\.toUpperCase\(\)\s*!==\s*['"]PRESTAMO['"]/,
    "totalMonth debe excluir paymentSource='PRESTAMO'",
  );
  assert.match(
    src,
    /e\.paymentSource\?\.toUpperCase\(\)\s*!==\s*['"]PREST\.['"]/,
    "totalMonth debe excluir paymentSource='PREST.'",
  );
});

// ============================================================================
// 6. Nadie fabrica paymentSource='PRESTAMO' en el frontend de /loans al
//    pegarle al endpoint nuevo. Reitera el contrato que ya protege
//    tests/loans-ui-contract.
// ============================================================================

test("loans/* (page, detail, PayablesCenter): no fabrican paymentSource='PRESTAMO' al llamar pay-expense", async () => {
  for (const file of [LOANS_PAGE, LOANS_DETAIL, PAYABLES_CENTER]) {
    const src = await leer(file);
    // Ningún payload JSON.stringify debe tener literal paymentSource: 'PRESTAMO'.
    const stringifyBlocks = [...src.matchAll(/JSON\.stringify\(\{[\s\S]{0,800}?\}\)/g)];
    for (const block of stringifyBlocks) {
      assert.ok(
        !/paymentSource\s*:\s*['"]PRESTAMO['"]/.test(block[0]),
        `${file}: ningún payload JSON.stringify debe fabricar paymentSource='PRESTAMO' (lo pone el backend)`,
      );
    }
  }
});


test("dashboard/closure: ofrece préstamo sólo al crear y llama pay-expense", async () => {
  const src = await leer(CLOSURE_PAGE);
  assert.match(src, /normalizeLoanListResponse/);
  assert.match(src, /liveLoanAvailable/);
  assert.match(src, /loanOption=\{!expenseToEdit && !isEditMode \? loanOptionForExpense : undefined\}/);
  assert.match(src, /`\/loans\/\$\{encodeURIComponent\(String\(data\.loanId\)\)\}\/pay-expense`/);
  assert.match(src, /if \(!expenseToEdit && !isEditMode && data\.loanId/);
});

test("pagos: los errores se propagan y no producen pantalla de éxito falsa", async () => {
  const [expenses, loans, payables] = await Promise.all([
    leer(EXPENSES_PAGE),
    leer(LOANS_PAGE),
    leer(PAYABLES_CENTER),
  ]);
  assert.match(expenses, /return Promise\.reject\(err\)/);
  assert.match(loans, /El modal sólo debe mostrar éxito[\s\S]{0,120}throw err/);
  assert.match(payables, /catch \(e\)[\s\S]{0,100}throw e/);
});
