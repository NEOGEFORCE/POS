// Fuente ÚNICA del cálculo de cuentas por pagar en el frontend.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// El 2026-09-04 el dueño reportó que las cuentas por pagar "iban en 8 millones
// 900 y ahora sale 7 millones algo". La causa principal fue un truncamiento en
// el backend (ver GetAllFiltered), pero además había DOS fórmulas distintas en
// el frontend calculando lo mismo:
//
//   - La tarjeta "Cuentas por Pagar" de /expenses sumaba sin impuesto y sólo
//     contaba status === 'PENDING'.
//   - El pie del "Centro de Pagos" (PendingDebtsModal, del que hay DOS copias:
//     una en /expenses y otra en /dashboard) sumaba con su propia expresión,
//     también sin impuesto.
//
// Resultado: la tarjeta y el modal que abre esa misma tarjeta podían mostrar
// números distintos de la misma plata. Este módulo es el único lugar donde vive
// la regla, y debe coincidir con GetPendingDebtsSummary del backend Go:
//
//   (status = PENDING  OR  paymentSource IN ('PRESTAMO','PREST.'))
//   AND status NOT IN ('PAID','SETTLED')
//   monto = (remaining_amount > 0 ? remaining_amount : amount) + tax_amount
//
// La lógica vive en .mjs (no .ts) porque la convención del proyecto es que lo
// puro y testeable se pueda correr con `node --test`.

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function upper(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * True cuando el egreso es un préstamo por su canal de pago. El backend
 * reconoce exactamente estos dos valores.
 */
export function isLoanSource(expense) {
  const source = upper(expense?.paymentSource);
  return source === "PRESTAMO" || source === "PREST.";
}

/**
 * True cuando el egreso es una DEUDA VIVA, es decir plata que todavía se debe.
 *
 * Se cuentan los PENDING y además los préstamos cuyo estado no sea PAID ni
 * SETTLED: hay préstamos con estado vacío que igual son plata pendiente, y si
 * se exigiera status === 'PENDING' exacto se escaparían del total.
 */
export function isLiveDebt(expense) {
  if (!expense) return false;
  const status = upper(expense.status);
  if (status === "PAID" || status === "SETTLED") return false;
  return status === "PENDING" || isLoanSource(expense);
}

/**
 * Capital pendiente de la deuda, SIN impuesto.
 *
 * Se prefiere remaining_amount cuando es positivo, porque refleja los abonos
 * ya registrados. Si es cero (deuda sin abonos) se usa el monto original.
 */
export function liveDebtPrincipal(expense) {
  const remaining = numeric(expense?.remainingAmount);
  if (remaining > 0) return remaining;
  return numeric(expense?.amount);
}

/**
 * Lo que realmente se le debe al acreedor por esta factura: capital + impuesto.
 *
 * El impuesto SÍ se debe: la factura del proveedor se paga completa. El backend
 * lo suma en GetPendingDebtsSummary, así que omitirlo acá hacía que la pantalla
 * de egresos mostrara menos deuda que el dashboard.
 */
export function liveDebtTotal(expense) {
  return liveDebtPrincipal(expense) + numeric(expense?.taxAmount);
}

/**
 * Filtra las deudas vivas de una lista de egresos, descartando las que no
 * representan monto alguno.
 */
export function selectLiveDebts(expenses) {
  if (!Array.isArray(expenses)) return [];
  return expenses.filter(
    (expense) => isLiveDebt(expense) && (numeric(expense.remainingAmount) > 0 || numeric(expense.amount) > 0)
  );
}

/**
 * Total de cuentas por pagar de una lista. Suma capital + impuesto de cada
 * deuda viva. Es el número de la tarjeta "Cuentas por Pagar" y del pie del
 * Centro de Pagos: por definición son el mismo.
 */
export function sumPayables(expenses) {
  return selectLiveDebts(expenses).reduce((acc, expense) => acc + liveDebtTotal(expense), 0);
}

/**
 * Agrupa deudas por acreedor y devuelve el subtotal de cada grupo, ordenado de
 * mayor a menor deuda. Sirve para que el Centro de Pagos muestre a quién se le
 * debe más sin que el operador tenga que sumar de memoria.
 */
export function groupPayablesByCreditor(expenses) {
  const groups = new Map();
  for (const expense of selectLiveDebts(expenses)) {
    const creditor =
      expense.lenderName?.trim() || expense.supplier?.name?.trim() || "OTROS ACREEDORES";
    if (!groups.has(creditor)) {
      groups.set(creditor, { creditor, debts: [], total: 0 });
    }
    const group = groups.get(creditor);
    group.debts.push(expense);
    group.total += liveDebtTotal(expense);
  }
  return [...groups.values()].sort((left, right) => right.total - left.total);
}
