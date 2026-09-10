function numeric(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseLocalizedAmount(value) {
  let normalized = String(value ?? '').trim().replace(/\$/g, '');
  if (!normalized) return 0;
  if (normalized.includes(',')) normalized = normalized.replace(/\./g, '').replace(',', '.');
  else if (normalized.includes('.') && !/\.\d{1,2}$/.test(normalized)) normalized = normalized.replace(/\./g, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseObject(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export function getRealPhysicalCash(closure) {
  if (typeof closure?.physicalCashReal === 'number' && closure.physicalCashReal > 0) {
    return closure.physicalCashReal;
  }

  let bills = numeric(closure?.cashBills);
  let coins = numeric(closure?.coins1000) + numeric(closure?.coins500) + numeric(closure?.coins200) + numeric(closure?.coins100);
  const breakdown = parseObject(closure?.cashBreakdown);

  if (breakdown?.bills && typeof breakdown.bills === 'object') {
    const calculated = Object.entries(breakdown.bills).reduce(
      (total, [denomination, quantity]) => total + numeric(denomination) * numeric(quantity),
      0,
    );
    if (calculated > 0) bills = calculated;
  }
  if (breakdown?.coins && typeof breakdown.coins === 'object') {
    const calculated = ['500/1000', '200', '100', '50'].reduce(
      (total, key) => total + numeric(breakdown.coins[key]),
      0,
    );
    if (calculated > 0) coins = calculated;
  }

  return bills + coins > 0 ? bills + coins : numeric(closure?.physicalCash);
}

function expenseChannels(expense) {
  const base = numeric(expense.amount);
  const total = base + numeric(expense.taxAmount ?? expense.tax_amount);
  const raw = {
    cash: numeric(expense.cashAmount ?? expense.cash_amount),
    nequi: numeric(expense.nequiAmount ?? expense.nequi_amount),
    daviplata: numeric(expense.daviplataAmount ?? expense.daviplata_amount),
    fondo: numeric(expense.fondoAmount ?? expense.fondo_amount),
  };
  if (raw.cash + raw.nequi + raw.daviplata + raw.fondo > 0) return raw;

  const result = { cash: 0, nequi: 0, daviplata: 0, fondo: 0 };
  const source = String(expense.paymentSource ?? expense.payment_source ?? '').toUpperCase();
  if (source.includes('/')) {
    for (const part of source.split('/')) {
      const match = part.match(/\$?([0-9.,]+)/);
      const amount = match ? parseLocalizedAmount(match[1]) : 0;
      if (part.includes('NEQUI') || part.includes('NEQ')) result.nequi += amount;
      else if (part.includes('DAVIPLATA') || part.includes('DAVI')) result.daviplata += amount;
      else if (part.includes('FONDO') || part.includes('BOVEDA') || part.includes('BÓVEDA') || part.includes('FOND')) result.fondo += amount;
      else if (part.includes('CAJA') || part.includes('EFECTIVO') || part.includes('CASH') || part.includes('EFEC')) result.cash += amount;
    }
    if (result.cash + result.nequi + result.daviplata + result.fondo === 0) result.cash = total || base;
    return result;
  }

  if (source.includes('NEQUI')) result.nequi = total || base;
  else if (source.includes('DAVIPLATA') || source.includes('DAVI')) result.daviplata = total || base;
  else if (source.includes('FONDO') || source.includes('BOVEDA') || source.includes('BÓVEDA') || source.includes('FOND')) result.fondo = total || base;
  else if (!source.includes('PREST') && !source.includes('DEUDA')) result.cash = total || base;
  return result;
}

export function getClosureExpensesSummary(closure) {
  if (typeof closure?.egresosTotales === 'number') {
    return {
      cashExpenses: numeric(closure.egresosCaja),
      totalExpenses: numeric(closure.egresosTotales),
      fondoExpenses: numeric(closure.egresosFondo),
      digitalExpenses: numeric(closure.egresosDigital),
    };
  }

  const summary = { cashExpenses: 0, totalExpenses: 0, fondoExpenses: 0, digitalExpenses: 0 };
  const parsed = parseObject(closure?.expensesDetail);
  const expenses = Array.isArray(parsed) ? parsed : [];
  for (const expense of expenses) {
    if (!expense || String(expense.status ?? '').toUpperCase() === 'PENDING') continue;
    if (String(expense.category ?? '').toUpperCase() === 'DEVOLUCIONES') continue;
    const channels = expenseChannels(expense);
    summary.cashExpenses += channels.cash;
    summary.fondoExpenses += channels.fondo;
    summary.digitalExpenses += channels.nequi + channels.daviplata;
    summary.totalExpenses += channels.cash + channels.fondo + channels.nequi + channels.daviplata;
  }
  return summary;
}

export function getVentasCajero(closure) {
  if (typeof closure?.ventasCajero === 'number' && closure.ventasCajero > 0) return closure.ventasCajero;
  const digitalIncome = numeric(closure?.totalNequi) + numeric(closure?.totalDaviplata) + numeric(closure?.totalCard) + numeric(closure?.totalBancolombia) + numeric(closure?.totalOtherTransfer);
  return getRealPhysicalCash(closure) + digitalIncome + getClosureExpensesSummary(closure).cashExpenses + numeric(closure?.totalReturns);
}

// ============================================================================
// ¿SE PUEDE CERRAR LA CAJA?
//
// REPORTE DEL DUEÑO (2026-09-10): "En el cierre cuando no registro billetes no
// me está dejando cerrar caja".
//
// El botón CERRAR CAJA estaba con isDisabled cuando el campo de efectivo
// contado quedaba vacío: se veía apagado y sin ninguna explicación, así que la
// única salida era adivinar que había que llenar la grilla de billetes.
//
// El bloqueo tenía una razón legítima que NO se puede tirar a la basura: cerrar
// con el campo vacío guardaría $0 de efectivo físico y un faltante falso igual a
// todo lo esperado, que después aparece como descuadre en los reportes y en el
// cuadre real.
//
// La respuesta correcta no es bloquear en silencio ni dejar pasar en silencio,
// sino PREGUNTAR una vez. Esta función decide qué hace falta; la pantalla se
// encarga de preguntarlo.
// ============================================================================

/**
 * Decide si el cierre puede enviarse y, si no, qué le falta.
 *
 * @param {object} input
 * @param {string}  input.actualCashInput  texto del campo de efectivo contado
 * @param {number}  input.expectedCash     efectivo que el sistema espera
 * @param {boolean} [input.isEditMode]     true al corregir un cierre histórico
 * @param {boolean} [input.confirmedNoCash] true si ya confirmó que no hay efectivo
 * @returns {{ canSubmit: boolean, needsCashDeclaration: boolean, reason: string }}
 */
export function evaluateClosureSubmission({
  actualCashInput,
  expectedCash,
  isEditMode = false,
  confirmedNoCash = false,
}) {
  const declarado = String(actualCashInput ?? '').trim();
  const esperado = numeric(expectedCash);

  // Corregir un cierre histórico no exige volver a contar: el admin ya está
  // editando cifras existentes desde reportes.
  if (isEditMode) {
    return { canSubmit: true, needsCashDeclaration: false, reason: 'edit_mode' };
  }

  // Con un monto escrito —incluido "0"— hay declaración y se puede cerrar.
  // Ojo: "0" es una declaración válida y distinta de dejar el campo vacío.
  if (declarado !== '') {
    return { canSubmit: true, needsCashDeclaration: false, reason: 'declarado' };
  }

  // Campo vacío pero el sistema no esperaba efectivo: no hay nada que declarar
  // ni faltante que inventar. Es el día que se vendió todo por transferencia.
  if (esperado <= 0) {
    return { canSubmit: true, needsCashDeclaration: false, reason: 'sin_efectivo_esperado' };
  }

  // Campo vacío con efectivo esperado: hay que preguntar.
  if (confirmedNoCash) {
    return { canSubmit: true, needsCashDeclaration: false, reason: 'confirmado_sin_efectivo' };
  }
  return { canSubmit: false, needsCashDeclaration: true, reason: 'falta_declarar_efectivo' };
}

