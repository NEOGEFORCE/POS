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
