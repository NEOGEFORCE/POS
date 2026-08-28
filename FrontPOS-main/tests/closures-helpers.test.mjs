import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getClosureExpensesSummary,
  getRealPhysicalCash,
  getVentasCajero,
} from '../src/lib/closures-helpers.mjs';

test('physical cash prefers canonical backend value', () => {
  assert.equal(getRealPhysicalCash({ physicalCashReal: 125000, cashBills: 1 }), 125000);
});

test('legacy cash breakdown calculates bills and stored coin values', () => {
  const closure = {
    cashBreakdown: JSON.stringify({ bills: { 50000: '2', 20000: '1' }, coins: { '500/1000': '3000', 200: '400' } }),
  };
  assert.equal(getRealPhysicalCash(closure), 123400);
});

test('expense summary prefers canonical channels and excludes returns and pending debt', () => {
  const closure = {
    expensesDetail: JSON.stringify([
      { amount: 15000, paymentSource: 'NEQUI: $10.000 / CAJA: $5.000', status: 'PAID', category: 'SERVICIOS' },
      { amount: 3000, paymentSource: 'EFECTIVO', status: 'PAID', category: 'DEVOLUCIONES' },
      { amount: 9000, paymentSource: 'EFECTIVO', status: 'PENDING', category: 'OTROS' },
    ]),
  };
  assert.deepEqual(getClosureExpensesSummary(closure), {
    cashExpenses: 5000,
    totalExpenses: 15000,
    fondoExpenses: 0,
    digitalExpenses: 10000,
  });
});

test('cashier sales fallback reconciles physical cash, digital, cash expenses and returns', () => {
  const closure = {
    physicalCash: 100000,
    totalNequi: 20000,
    totalDaviplata: 10000,
    totalReturns: 5000,
    expensesDetail: JSON.stringify([{ amount: 7000, paymentSource: 'EFECTIVO', status: 'PAID', category: 'OTROS' }]),
  };
  assert.equal(getVentasCajero(closure), 142000);
});
