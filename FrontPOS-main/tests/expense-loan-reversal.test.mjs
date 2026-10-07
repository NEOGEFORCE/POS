// Contrato de reversión de un pago hecho con préstamo.
// La autorización real vive en el backend (RoleMiddleware admin); la UI
// únicamente muestra gestión a admin/superadmin y comunica los dos efectos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const PAGE = new URL("../src/app/(app)/expenses/page.tsx", import.meta.url);
const TABLE = new URL("../src/app/(app)/expenses/components/ExpenseTable.tsx", import.meta.url);
const MODAL = new URL("../src/app/(app)/expenses/components/DeleteExpenseModal.tsx", import.meta.url);
const MAIN = new URL("../../backPOS-go/cmd/api/main.go", import.meta.url);

const read = (url) => readFile(url, "utf8");

test("backend: DELETE expense permanece dentro del grupo RoleMiddleware admin", async () => {
  const src = await read(MAIN);
  const adminStart = src.indexOf('expenseAdminActions.Use(middlewares.RoleMiddleware("admin"))');
  const route = src.indexOf('expenseAdminActions.DELETE("/delete/:id", expenseHandler.Delete)');
  assert.ok(adminStart >= 0 && route > adminStart, "DELETE /expenses/delete/:id debe ser admin-only");
});

test("tabla: editar/eliminar sólo se renderizan cuando isAdmin", async () => {
  const src = await read(TABLE);
  assert.match(src, /\{isAdmin\s*\?\s*\([\s\S]*onDelete\(String\(expense\.id\)\)/);
});

test("eliminar pago con préstamo refresca deuda y principal y muestra confirmación específica", async () => {
  const [page, modal] = await Promise.all([read(PAGE), read(MODAL)]);
  assert.match(page, /response\?\.result\?\.loanReversed\s*===\s*true/);
  assert.match(page, /await loadExpenses\(\)/, "debe recargar Cuentas por pagar");
  assert.match(page, /loadLoansForPayment\(\)/, "debe recargar principal disponible");
  assert.ok(page.includes("La deuda volvió a Cuentas por pagar"));
  assert.ok(modal.includes("la cuenta volverá a Cuentas por pagar"));
  assert.ok(modal.includes("quedará disponible otra vez en el principal"));
});

test("la UI reconoce únicamente PRESTAMO/PREST. como pago financiado", async () => {
  const src = await read(PAGE);
  assert.match(src, /\["PRESTAMO", "PREST\."\]\.includes/);
  assert.match(src, /isLoanFunded=/);
});


test("reparación histórica: endpoint está bajo loansAdmin y botón sólo sale para huérfano+admin", async () => {
  const detailUrl = new URL("../src/app/(app)/loans/detail/page.tsx", import.meta.url);
  const [main, detail] = await Promise.all([read(MAIN), read(detailUrl)]);
  const gate = main.indexOf('loansAdmin.Use(middlewares.RoleMiddleware("admin"))');
  const route = main.indexOf('loansAdmin.POST("/:id/expenses/:usageId/reverse-orphan"');
  assert.ok(gate >= 0 && route > gate, "reverse-orphan debe ser admin/superadmin");
  assert.match(detail, /isAdmin\s*&&\s*exp\.orphanedPayment\s*&&\s*exp\.id/);
  assert.ok(detail.includes("Reparar pago eliminado"));
  assert.ok(detail.includes('broadcastRevalidate("EXPENSE_UPDATE")'));
});
