// Caso obligatorio del dueño (2026-10-07): P=25.000.000, EA=21,3%, n=60,
// cargos mensuales 37.472. La UI muestra cuota final = base + cargos y
// total = cuota final × cuotas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSchedule, frenchDisplayTotals } from "../src/lib/loans.mjs";

const input = {
  mode: "FRENCH",
  principal: 25_000_000,
  annualEffectiveRatePct: 21.3,
  termCount: 60,
  monthlyInsurance: 37_472,
  firstPaymentDate: "2026-11-07",
};

test("caso banco: cuota base, cuota final y total a pagar", () => {
  const r = buildSchedule(input);
  assert.equal(r.error, undefined);
  const v = frenchDisplayTotals(r.totals, 60);
  assert.equal(v.baseInstallment, 654938.94);
  assert.equal(v.monthlyCharges, 37472);
  assert.equal(v.finalMonthly, 692410.94);
  assert.equal(v.totalToPay, 41544656.4);
  // El banco reporta ≈692.772; la fórmula exacta queda a menos de $500.
  assert.ok(Math.abs(v.finalMonthly - 692772) < 500);
});

test("caso banco: cronograma por saldos con saldo, interés y capital", () => {
  const r = buildSchedule(input);
  const iM = Math.pow(1.213, 1 / 12) - 1;
  let prev = 25_000_000;
  for (const it of r.installments) {
    assert.equal(it.interestDue, Math.round(prev * 100 * iM) / 100, `interés cuota ${it.number}`);
    prev = Math.round((prev - it.principalDue) * 100) / 100;
    assert.equal(it.balance, prev, `saldo cuota ${it.number}`);
    assert.equal(it.insuranceDue, 37472);
  }
  assert.equal(r.installments.at(-1).balance, 0);
});

test("frenchDisplayTotals: null fuera de FRENCH o sin cuotas", () => {
  assert.equal(frenchDisplayTotals({ principal: 1, interest: 0, totalPayable: 1 }, 6), null);
  assert.equal(frenchDisplayTotals({ baseInstallment: 100 }, 0), null);
  assert.equal(frenchDisplayTotals(null, 6), null);
});
