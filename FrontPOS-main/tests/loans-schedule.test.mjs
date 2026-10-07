import test from "node:test";
import assert from "node:assert/strict";

import {
  INTEREST_MODES,
  PAYMENT_FREQUENCIES,
  LOAN_STATUSES,
  INSTALLMENT_STATUSES,
  LOAN_ERROR_CODES,
  addPeriod,
  buildSchedule,
  classifyInstallment,
  groupInstallmentsByStatus,
  installmentProgress,
  liveLoanAvailable,
  liveLoanOutstanding,
  loanProgress,
  normalizeLoanDetailResponse,
  normalizeLoanListResponse,
  normalizeLoanPreviewResponse,
  parseLoanAmount,
  sumActivePrincipal,
  sumLoans,
  summarizeLoans,
  toISODate,
  totalPaidOfLoan,
  upcomingInstallments,
  formatLoanMoney,
} from "../src/lib/loans.mjs";

// ============================================================================
// buildSchedule — matemática del cronograma
//
// Debe coincidir con el service Go `loan_service.BuildLoanSchedule`. Si estos
// tests cambian, también cambia el contrato con el backend.
//
// CONTRATO DEFINITIVO (migración 021):
//   - Modos aceptados: NONE, SIMPLE, FRENCH. FRENCH coexiste con los otros
//     dos SIN reinterpretarlos.
//   - SIMPLE: interés TOTAL FLAT. totalPayable = principal * (1 + rate/100)
//     INDEPENDIENTE de termCount y frequency.
//   - FRENCH: Sistema francés banca. Entrada EA (efectiva anual) + seguro
//     mensual + FGA total. Fórmula i_m = (1+EA/100)^(1/12) − 1. La cuota
//     base = P · i_m · (1+i_m)^n / ((1+i_m)^n − 1).
//   - Última cuota absorbe el residuo de centavos en los tres modos.
// ============================================================================

test("buildSchedule: sin interés — N cuotas iguales de capital", () => {
  const r = buildSchedule({
    principal: 1_200_000,
    interestRatePct: 0,
    mode: INTEREST_MODES.NONE,
    termCount: 12,
    frequency: PAYMENT_FREQUENCIES.MONTHLY,
    firstPaymentDate: "2026-02-01",
  });
  assert.equal(r.error, undefined);
  assert.equal(r.installments.length, 12);
  assert.equal(r.totals.principal, 1_200_000);
  assert.equal(r.totals.interest, 0);
  assert.equal(r.totals.totalPayable, 1_200_000);
  for (const it of r.installments) {
    assert.equal(it.principalDue, 100_000);
    assert.equal(it.interestDue, 0);
    assert.equal(it.totalDue, 100_000);
  }
  // Primera fecha coincide, última es firstPaymentDate + 11 meses.
  assert.equal(r.installments[0].dueDate, "2026-02-01");
  assert.equal(r.installments[11].dueDate, "2027-01-01");
});

test("buildSchedule: NONE con principal indivisible — última cuota absorbe centavos", () => {
  const r = buildSchedule({
    principal: 100,
    interestRatePct: 0,
    mode: INTEREST_MODES.NONE,
    termCount: 3,
    frequency: PAYMENT_FREQUENCIES.MONTHLY,
    firstPaymentDate: "2026-01-15",
  });
  const sum = r.installments.reduce((a, it) => a + it.principalDue, 0);
  assert.equal(Math.round(sum * 100) / 100, 100);
  // Primeras N-1 cuotas tienen el valor base; la última compensa.
  assert.equal(r.installments[0].principalDue, 33.33);
  assert.equal(r.installments[2].principalDue, 33.34);
});

test("buildSchedule: SIMPLE flat total — totalPayable = principal * (1 + rate/100)", () => {
  // Préstamo de 1.000.000 al 10% TOTAL FLAT → totalInterest = 100.000 →
  // totalPayable = 1.100.000. Independiente de la cantidad de cuotas.
  const r = buildSchedule({
    principal: 1_000_000,
    interestRatePct: 10,
    mode: INTEREST_MODES.SIMPLE,
    termCount: 10,
    frequency: PAYMENT_FREQUENCIES.MONTHLY,
    firstPaymentDate: "2026-01-01",
  });
  assert.equal(r.totals.principal, 1_000_000);
  assert.equal(r.totals.interest, 100_000);
  assert.equal(r.totals.totalPayable, 1_100_000);
  // Cuotas iguales de 110.000 (10 cuotas).
  for (const it of r.installments) {
    assert.equal(it.totalDue, 110_000);
  }
});

test("buildSchedule: SIMPLE con residuo — última cuota absorbe centavos", () => {
  const r = buildSchedule({
    principal: 333_333,
    interestRatePct: 15,
    mode: INTEREST_MODES.SIMPLE,
    termCount: 7,
    frequency: PAYMENT_FREQUENCIES.MONTHLY,
    firstPaymentDate: "2026-01-01",
  });
  // interest = 333_333 * 15 / 100 = 49_999.95
  // totalPayable = 383_332.95
  assert.equal(r.totals.interest, 49_999.95);
  assert.equal(r.totals.totalPayable, 383_332.95);
  const sumP = r.installments.reduce((a, it) => a + it.principalDue, 0);
  const sumI = r.installments.reduce((a, it) => a + it.interestDue, 0);
  const sumT = r.installments.reduce((a, it) => a + it.totalDue, 0);
  assert.equal(Math.round(sumP * 100) / 100, 333_333);
  assert.equal(Math.round(sumI * 100) / 100, 49_999.95);
  assert.equal(Math.round(sumT * 100) / 100, 383_332.95);
});

test("buildSchedule: SIMPLE a 6 cuotas — total flat independiente del plazo", () => {
  const r = buildSchedule({
    principal: 1_200_000,
    interestRatePct: 20,
    mode: INTEREST_MODES.SIMPLE,
    termCount: 6,
    frequency: PAYMENT_FREQUENCIES.MONTHLY,
    firstPaymentDate: "2026-01-01",
  });
  assert.equal(r.totals.interest, 240_000);
  assert.equal(r.totals.totalPayable, 1_440_000);
  // 1_440_000 / 6 = 240_000 por cuota.
  for (const it of r.installments) {
    assert.equal(it.totalDue, 240_000);
  }
});

test("buildSchedule: SIMPLE a 12 cuotas — el total NO cambia por aumentar el plazo", () => {
  const r = buildSchedule({
    principal: 1_200_000,
    interestRatePct: 20,
    mode: INTEREST_MODES.SIMPLE,
    termCount: 12,
    frequency: PAYMENT_FREQUENCIES.MONTHLY,
    firstPaymentDate: "2026-01-01",
  });
  // Mismo monto principal + mismo 20% total → mismos totals, solo cambia
  // el reparto por cuota (12 vez 6).
  assert.equal(r.totals.interest, 240_000);
  assert.equal(r.totals.totalPayable, 1_440_000);
  assert.equal(r.installments.length, 12);
  for (const it of r.installments) {
    assert.equal(it.totalDue, 120_000);
  }
});

test("buildSchedule: SIMPLE a 24 cuotas quincenales — totals no dependen de la frecuencia", () => {
  const r = buildSchedule({
    principal: 1_200_000,
    interestRatePct: 20,
    mode: INTEREST_MODES.SIMPLE,
    termCount: 24,
    frequency: PAYMENT_FREQUENCIES.BIWEEKLY,
    firstPaymentDate: "2026-01-01",
  });
  // 20% total flat sobre 1.2M → interés 240.000 sin importar freq ni cuotas.
  assert.equal(r.totals.interest, 240_000);
  assert.equal(r.totals.totalPayable, 1_440_000);
  assert.equal(r.installments.length, 24);
  for (const it of r.installments) {
    assert.equal(it.totalDue, 60_000);
  }
  // Fechas quincenales.
  assert.equal(r.installments[0].dueDate, "2026-01-01");
  assert.equal(r.installments[1].dueDate, "2026-01-15");
});

test("buildSchedule: SIMPLE acepta alias annualRatePct por compatibilidad (misma semántica flat)", () => {
  const legacy = buildSchedule({
    principal: 500_000,
    annualRatePct: 10,
    mode: INTEREST_MODES.SIMPLE,
    termCount: 5,
    frequency: PAYMENT_FREQUENCIES.MONTHLY,
    firstPaymentDate: "2026-01-01",
  });
  const canon = buildSchedule({
    principal: 500_000,
    interestRatePct: 10,
    mode: INTEREST_MODES.SIMPLE,
    termCount: 5,
    frequency: PAYMENT_FREQUENCIES.MONTHLY,
    firstPaymentDate: "2026-01-01",
  });
  assert.equal(legacy.totals.totalPayable, canon.totals.totalPayable);
  assert.equal(legacy.totals.interest, canon.totals.interest);
  assert.equal(legacy.installments[0].totalDue, canon.installments[0].totalDue);
});

test("buildSchedule: FRENCH — golden case P=25M, n=60, EA=21.3% → cuota base ≈ 655_000 (contrato con backend 021)", () => {
  const r = buildSchedule({
    principal: 25_000_000,
    annualEffectiveRatePct: 21.3,
    mode: "FRENCH",
    termCount: 60,
    frequency: "MONTHLY",
    firstPaymentDate: "2026-01-01",
  });
  assert.equal(r.error, undefined);
  assert.equal(r.installments.length, 60);
  // El motor Go y el motor JS usan Math.pow con precisión IEEE 754. El valor
  // exacto es ~654_938.94. Tolerancia ±1_000 pesos para absorber redondeos a
  // centavos y la aproximación mental "≈ 655.300" dada en el contrato.
  const baseInstallment = r.totals.baseInstallment;
  assert.ok(
    Math.abs(baseInstallment - 655_000) < 1_000,
    `Cuota base ${baseInstallment} fuera de rango 655_000±1000`,
  );
  // Tasa M.V. ≈ 1.62% (aproximadamente 1.6222).
  const mvPct = r.totals.monthlyRatePct;
  assert.ok(
    Math.abs(mvPct - 1.62) < 0.05,
    `Tasa M.V. ${mvPct}% debe ser ~1.62`,
  );
  // Invariante 1: Σ principal == P (al centavo).
  const sumPrincipal = r.installments.reduce((a, it) => a + it.principalDue, 0);
  assert.ok(
    Math.abs(sumPrincipal - 25_000_000) < 0.01,
    `Σ principal=${sumPrincipal} debe ser 25_000_000`,
  );
  // Invariante 2: saldo final == 0 (reconstruimos para verificar).
  let saldo = 25_000_000;
  for (const it of r.installments) saldo -= it.principalDue;
  assert.ok(Math.abs(saldo) < 0.01, `saldo final=${saldo} debe ser 0`);
  // Invariante 3: cuotas uniformes salvo la última. Las primeras 59 iguales
  // a `baseInstallment` dentro de ±1 centavo. La última PUEDE diferir en
  // hasta 1 peso por absorción.
  for (let i = 0; i < 59; i++) {
    const diff = Math.abs(r.installments[i].totalDue - baseInstallment);
    assert.ok(diff < 0.015, `cuota ${i + 1}=${r.installments[i].totalDue} vs base ${baseInstallment}`);
  }
  // Totales coherentes con el principal + intereses.
  assert.ok(r.totals.totalPayable > r.totals.principal);
  assert.ok(r.totals.interest > 0);
});

test("buildSchedule: FRENCH — con seguro mensual fijo y FGA total diferido", () => {
  const r = buildSchedule({
    principal: 25_000_000,
    annualEffectiveRatePct: 21.3,
    mode: "FRENCH",
    termCount: 60,
    frequency: "MONTHLY",
    firstPaymentDate: "2026-01-01",
    monthlyInsurance: 50_000,
    fgaTotal: 600_000,
  });
  assert.equal(r.error, undefined);
  // Seguro mensual: constante en todas las cuotas = 50_000. Suma = 60 * 50_000 = 3_000_000.
  for (const it of r.installments) {
    assert.equal(it.insuranceDue, 50_000);
  }
  const sumIns = r.installments.reduce((a, it) => a + it.insuranceDue, 0);
  assert.equal(Math.round(sumIns * 100) / 100, 3_000_000);
  assert.equal(r.totals.totalInsurance, 3_000_000);
  // FGA diferido: 600_000 / 60 = 10_000 por mes exacto (sin residuo aquí).
  for (const it of r.installments) {
    assert.ok(
      Math.abs(it.fgaDue - 10_000) < 0.01,
      `fgaDue ${it.fgaDue} debe ser ~10_000`,
    );
  }
  const sumFga = r.installments.reduce((a, it) => a + it.fgaDue, 0);
  assert.ok(
    Math.abs(sumFga - 600_000) < 0.01,
    `Σ fga=${sumFga} debe ser 600_000`,
  );
  assert.equal(r.totals.totalFga, 600_000);
  // Cuota base (capital + interés) permanece ~655_000.
  const baseInstallment = r.totals.baseInstallment;
  assert.ok(Math.abs(baseInstallment - 655_000) < 1_000);
  // monthlyTotal = baseInstallment + 50_000 (seguro) + 10_000 (fga).
  const expectedMonthly = baseInstallment + 50_000 + 10_000;
  assert.ok(
    Math.abs(r.totals.monthlyTotal - expectedMonthly) < 1,
    `monthlyTotal=${r.totals.monthlyTotal} vs esperado ${expectedMonthly}`,
  );
  // Cuota total del primer mes = capital_1 + interest_1 + 50_000 + 10_000.
  const first = r.installments[0];
  const expectedFirst =
    first.principalDue + first.interestDue + first.insuranceDue + first.fgaDue;
  assert.ok(Math.abs(first.totalDue - expectedFirst) < 0.02);
});

test("buildSchedule: FRENCH — FGA con residuo lo absorbe la última cuota", () => {
  // 100_000 / 7 = 14_285.71 base, con residuo de 0.03 pesos acumulado en la
  // última. El motor trabaja en centavos: 10_000_000c / 7 = 1_428_571c base,
  // última = 1_428_574c (3c residuo).
  const r = buildSchedule({
    principal: 1_000_000,
    annualEffectiveRatePct: 20,
    mode: "FRENCH",
    termCount: 7,
    frequency: "MONTHLY",
    firstPaymentDate: "2026-01-01",
    fgaTotal: 100_000,
  });
  assert.equal(r.error, undefined);
  // Primeras 6 cuotas con el FGA base; la 7ª con el residuo.
  for (let i = 0; i < 6; i++) {
    assert.equal(r.installments[i].fgaDue, 14_285.71);
  }
  assert.equal(r.installments[6].fgaDue, 14_285.74);
  const sumFga = r.installments.reduce((a, it) => a + it.fgaDue, 0);
  // La suma debe cuadrar a 100_000 al centavo.
  assert.ok(
    Math.abs(sumFga - 100_000) < 0.01,
    `Σ fga=${sumFga} debe ser 100_000 al centavo`,
  );
  assert.equal(r.totals.totalFga, 100_000);
});

test("buildSchedule: FRENCH — ignora frecuencia distinta de MONTHLY (fuerza mensual)", () => {
  // El contrato banca: FRENCH es siempre mensual. Si el callsite envía
  // WEEKLY, el motor normaliza a MONTHLY sin romper (no es error de usuario,
  // es un invariante del modo).
  const r = buildSchedule({
    principal: 1_000_000,
    annualEffectiveRatePct: 20,
    mode: "FRENCH",
    termCount: 12,
    frequency: "WEEKLY",
    firstPaymentDate: "2026-01-15",
  });
  assert.equal(r.error, undefined);
  assert.equal(r.installments[0].dueDate, "2026-01-15");
  // Siguiente cuota a 1 mes, no 1 semana.
  assert.equal(r.installments[1].dueDate, "2026-02-15");
});

test("buildSchedule: FRENCH acepta interestRatePct como fallback de annualEffectiveRatePct", () => {
  // Si el UI envía la tasa en el campo legacy `interestRatePct` con modo
  // FRENCH, el motor la interpreta como EA. Compatibilidad defensiva.
  const explicit = buildSchedule({
    principal: 10_000_000,
    annualEffectiveRatePct: 18,
    mode: "FRENCH",
    termCount: 24,
    frequency: "MONTHLY",
    firstPaymentDate: "2026-01-01",
  });
  const fallback = buildSchedule({
    principal: 10_000_000,
    interestRatePct: 18,
    mode: "FRENCH",
    termCount: 24,
    frequency: "MONTHLY",
    firstPaymentDate: "2026-01-01",
  });
  assert.equal(explicit.error, undefined);
  assert.equal(fallback.error, undefined);
  assert.equal(explicit.totals.baseInstallment, fallback.totals.baseInstallment);
  assert.equal(explicit.totals.monthlyRatePct, fallback.totals.monthlyRatePct);
});

test("buildSchedule: FRENCH con EA <= 0 es inválido", () => {
  const r = buildSchedule({
    principal: 1_000_000,
    annualEffectiveRatePct: 0,
    mode: "FRENCH",
    termCount: 12,
    frequency: "MONTHLY",
    firstPaymentDate: "2026-01-01",
  });
  assert.equal(r.error, "LOAN_INVALID_SCHEDULE");
});

test("buildSchedule: FRENCH con seguro o FGA negativos es inválido", () => {
  const seguro = buildSchedule({
    principal: 1_000_000,
    annualEffectiveRatePct: 18,
    mode: "FRENCH",
    termCount: 12,
    frequency: "MONTHLY",
    monthlyInsurance: -1,
  });
  assert.equal(seguro.error, "LOAN_INVALID_SCHEDULE");
  const fga = buildSchedule({
    principal: 1_000_000,
    annualEffectiveRatePct: 18,
    mode: "FRENCH",
    termCount: 12,
    frequency: "MONTHLY",
    fgaTotal: -100,
  });
  assert.equal(fga.error, "LOAN_INVALID_SCHEDULE");
});

test("buildSchedule: SIMPLE no se reinterpreta como FRENCH (sigue siendo flat)", () => {
  // Golden guard contra "reinterpretar SIMPLE como francés". SIMPLE sigue
  // dando totalPayable = P * (1 + rate/100) sin convertir a EA.
  const simple = buildSchedule({
    principal: 25_000_000,
    interestRatePct: 21.3,
    mode: "SIMPLE",
    termCount: 60,
    frequency: "MONTHLY",
    firstPaymentDate: "2026-01-01",
  });
  // 25M * (1 + 0.213) = 30_325_000 (flat, no amortizado).
  assert.equal(simple.totals.totalPayable, 30_325_000);
  assert.equal(simple.totals.interest, 5_325_000);
  // En SIMPLE todos los campos de FRENCH son undefined.
  assert.equal(simple.totals.monthlyRate, undefined);
  assert.equal(simple.totals.baseInstallment, undefined);
  assert.equal(simple.totals.monthlyInsurance, undefined);
});

test("buildSchedule: INTEREST_MODES expone NONE, SIMPLE y FRENCH (sin reinterpretar SIMPLE)", () => {
  const keys = Object.keys(INTEREST_MODES).sort();
  assert.deepEqual(keys, ["FRENCH", "NONE", "SIMPLE"]);
  assert.equal(INTEREST_MODES.FRENCH, "FRENCH");
  assert.equal(INTEREST_MODES.SIMPLE, "SIMPLE");
  assert.equal(INTEREST_MODES.NONE, "NONE");
});

test("buildSchedule: NONE con tasa > 0 es inválido (coincide con backend)", () => {
  const r = buildSchedule({
    principal: 1_000_000,
    interestRatePct: 5,
    mode: INTEREST_MODES.NONE,
    termCount: 6,
    frequency: PAYMENT_FREQUENCIES.MONTHLY,
    firstPaymentDate: "2026-01-01",
  });
  assert.equal(r.error, "LOAN_INVALID_SCHEDULE");
});

test("buildSchedule: SIMPLE con tasa 0 es inválido (coincide con backend)", () => {
  const r = buildSchedule({
    principal: 1_000_000,
    interestRatePct: 0,
    mode: INTEREST_MODES.SIMPLE,
    termCount: 6,
    frequency: PAYMENT_FREQUENCIES.MONTHLY,
    firstPaymentDate: "2026-01-01",
  });
  assert.equal(r.error, "LOAN_INVALID_SCHEDULE");
});

test("buildSchedule: frecuencia semanal — primer vencimiento = firstDate + 0, último = firstDate + 7*(N-1) días", () => {
  const r = buildSchedule({
    principal: 100_000,
    interestRatePct: 0,
    mode: INTEREST_MODES.NONE,
    termCount: 4,
    frequency: PAYMENT_FREQUENCIES.WEEKLY,
    firstPaymentDate: "2026-01-05",
  });
  assert.equal(r.installments[0].dueDate, "2026-01-05");
  assert.equal(r.installments[1].dueDate, "2026-01-12");
  assert.equal(r.installments[2].dueDate, "2026-01-19");
  assert.equal(r.installments[3].dueDate, "2026-01-26");
});

test("buildSchedule: frecuencia quincenal — pasos de 14 días", () => {
  const r = buildSchedule({
    principal: 100_000,
    interestRatePct: 0,
    mode: INTEREST_MODES.NONE,
    termCount: 3,
    frequency: PAYMENT_FREQUENCIES.BIWEEKLY,
    firstPaymentDate: "2026-01-05",
  });
  assert.equal(r.installments[0].dueDate, "2026-01-05");
  assert.equal(r.installments[1].dueDate, "2026-01-19");
  assert.equal(r.installments[2].dueDate, "2026-02-02");
});

test("buildSchedule: MONTHLY preserva día cuando el mes destino lo permite", () => {
  const r = buildSchedule({
    principal: 60_000,
    interestRatePct: 0,
    mode: INTEREST_MODES.NONE,
    termCount: 3,
    frequency: PAYMENT_FREQUENCIES.MONTHLY,
    firstPaymentDate: "2026-01-31",
  });
  // Febrero 2026 no tiene 31 → cae a 28 (año no bisiesto).
  // Marzo 2026 vuelve a 31. Es el mismo comportamiento del backend
  // (`addOneMonthPreservingDay`): preserva el día original consultándolo
  // contra el último del mes destino.
  assert.equal(r.installments[0].dueDate, "2026-01-31");
  assert.equal(r.installments[1].dueDate, "2026-02-28");
  assert.equal(r.installments[2].dueDate, "2026-03-31");
});

test("buildSchedule: sin firstPaymentDate devuelve dueDate nulo pero mantiene montos", () => {
  const r = buildSchedule({
    principal: 300_000,
    interestRatePct: 0,
    mode: INTEREST_MODES.NONE,
    termCount: 3,
    frequency: PAYMENT_FREQUENCIES.MONTHLY,
  });
  assert.equal(r.installments.length, 3);
  for (const it of r.installments) assert.equal(it.dueDate, null);
});

test("buildSchedule: rechaza inputs inválidos devolviendo error LOAN_INVALID_SCHEDULE", () => {
  const cases = [
    { principal: 0, interestRatePct: 0, mode: "NONE", termCount: 3, frequency: "MONTHLY" },
    { principal: -1, interestRatePct: 0, mode: "NONE", termCount: 3, frequency: "MONTHLY" },
    { principal: 100, interestRatePct: 0, mode: "NONE", termCount: 0, frequency: "MONTHLY" },
    { principal: 100, interestRatePct: -5, mode: "SIMPLE", termCount: 3, frequency: "MONTHLY" },
    { principal: 100, interestRatePct: 0, mode: "WHATEVER", termCount: 3, frequency: "MONTHLY" },
    { principal: 100, interestRatePct: 10, mode: "SIMPLE", termCount: 3, frequency: "DAILY" },
    { principal: 100, interestRatePct: 2000, mode: "SIMPLE", termCount: 3, frequency: "MONTHLY" },
    { principal: 100, interestRatePct: 10, mode: "SIMPLE", termCount: 601, frequency: "MONTHLY" },
  ];
  for (const c of cases) {
    const r = buildSchedule(c);
    assert.equal(r.error, "LOAN_INVALID_SCHEDULE", `caso inválido no rechazado: ${JSON.stringify(c)}`);
    assert.equal(r.installments.length, 0);
  }
});

test("buildSchedule: tolera strings numéricos (ej. inputs de formularios)", () => {
  const r = buildSchedule({
    principal: "1200000",
    interestRatePct: "20",
    mode: "SIMPLE",
    termCount: "6",
    frequency: "MONTHLY",
    firstPaymentDate: "2026-02-01",
  });
  assert.equal(r.error, undefined);
  assert.equal(r.installments.length, 6);
  assert.ok(r.totals.totalPayable > r.totals.principal);
});

// ============================================================================
// parseLoanAmount — parseo robusto de montos escritos en COP
// ============================================================================

test("parseLoanAmount: 1.000.000 (es-CO con punto miles) → 1000000, NO 1", () => {
  assert.equal(parseLoanAmount("1.000.000"), 1_000_000);
  assert.notEqual(parseLoanAmount("1.000.000"), 1);
});

test("parseLoanAmount: 1,000,000 (anglo coma miles) → 1000000", () => {
  assert.equal(parseLoanAmount("1,000,000"), 1_000_000);
});

test("parseLoanAmount: 1.000 (es-CO 'mil') → 1000, NO 1", () => {
  // Este es EL caso que `Number("1.000")` arruina.
  assert.equal(parseLoanAmount("1.000"), 1000);
});

test("parseLoanAmount: formato mixto es-CO 1.000.000,50 → 1000000.5", () => {
  assert.equal(parseLoanAmount("1.000.000,50"), 1_000_000.5);
});

test("parseLoanAmount: formato mixto anglo 1,000,000.50 → 1000000.5", () => {
  assert.equal(parseLoanAmount("1,000,000.50"), 1_000_000.5);
});

test("parseLoanAmount: números con símbolo y espacios se limpian", () => {
  assert.equal(parseLoanAmount("$ 1.000.000"), 1_000_000);
  assert.equal(parseLoanAmount("  2.500.000 COP "), 2_500_000);
});

test("parseLoanAmount: 1000 sin separadores → 1000", () => {
  assert.equal(parseLoanAmount("1000"), 1000);
  assert.equal(parseLoanAmount(1000), 1000);
});

test("parseLoanAmount: tolera basura, vacíos y nulls devolviendo 0", () => {
  assert.equal(parseLoanAmount(""), 0);
  assert.equal(parseLoanAmount(null), 0);
  assert.equal(parseLoanAmount(undefined), 0);
  assert.equal(parseLoanAmount("sin número"), 0);
  assert.equal(parseLoanAmount({}), 0);
  assert.equal(parseLoanAmount(NaN), 0);
});

test("parseLoanAmount: Number() directo sobre 1.000.000 falla — este helper NO", () => {
  assert.ok(Number.isNaN(Number("1.000.000")), "guardián del bug: Number ambiguo falla");
  assert.equal(parseLoanAmount("1.000.000"), 1_000_000);
});

// ============================================================================
// Normalizadores de envelopes del backend
// ============================================================================

test("normalizeLoanListResponse: envelope {loans:[LoanWithStatsRow], total} se desenvuelve", () => {
  const envelope = {
    loans: [
      {
        loan: { id: 1, lenderName: "A", principalAmount: 1_000_000, status: "ACTIVE" },
        totalPayable: 1_200_000,
        remainingBalance: 600_000,
        totalDue: 1_200_000,
        totalPaid: 600_000,
        outstandingDue: 600_000,
        nextDueDate: "2026-03-01",
        nextDueAmount: 100_000,
        installmentsPaid: 5,
        installmentsTotal: 12,
        principalUsed: 400_000,
      },
      {
        loan: { id: 2, lenderName: "B", principalAmount: 500_000, status: "ACTIVE" },
        totalPayable: 600_000,
        remainingBalance: 600_000,
        totalDue: 600_000,
        totalPaid: 0,
        outstandingDue: 600_000,
        nextDueDate: "2026-02-01",
        nextDueAmount: 100_000,
        installmentsPaid: 0,
        installmentsTotal: 6,
        principalUsed: 0,
      },
    ],
    total: 2,
  };
  const { loans, total } = normalizeLoanListResponse(envelope);
  assert.equal(total, 2);
  assert.equal(loans.length, 2);
  // Los stats fueron elevados al LoanRecord resultante.
  assert.equal(loans[0].id, 1);
  assert.equal(loans[0].totalPayable, 1_200_000);
  assert.equal(loans[0].remainingBalance, 600_000);
  assert.equal(loans[0].installmentsPaid, 5);
  assert.equal(loans[0].installmentsTotal, 12);
  assert.equal(loans[0].principalUsed, 400_000);
  // Y conserva stats crudo bajo stats.
  assert.equal(loans[0].stats.totalPaid, 600_000);
  assert.equal(loans[0].stats.outstandingDue, 600_000);
});

test("normalizeLoanListResponse: acepta array crudo como fallback defensivo", () => {
  const list = [{ id: 10, lenderName: "C", principalAmount: 100, status: "ACTIVE" }];
  const { loans, total } = normalizeLoanListResponse(list);
  assert.equal(total, 1);
  assert.equal(loans[0].id, 10);
});

test("normalizeLoanListResponse: respuesta vacía produce lista vacía sin romper", () => {
  assert.deepEqual(normalizeLoanListResponse(null), { loans: [], total: 0 });
  assert.deepEqual(normalizeLoanListResponse(undefined), { loans: [], total: 0 });
  assert.deepEqual(normalizeLoanListResponse({}), { loans: [], total: 0 });
});

test("normalizeLoanDetailResponse: {loan: ...} se desenvuelve", () => {
  const envelope = {
    loan: {
      id: 7,
      lenderName: "PEPE",
      principalAmount: 1_000_000,
      totalPayable: 1_200_000,
      remainingBalance: 400_000,
      status: "ACTIVE",
      installments: [{ number: 1, dueDate: "2026-01-01", principalDue: 100_000, interestDue: 20_000, totalDue: 120_000 }],
    },
  };
  const loan = normalizeLoanDetailResponse(envelope);
  assert.ok(loan);
  assert.equal(loan.id, 7);
  assert.equal(loan.totalPayable, 1_200_000);
  assert.equal(loan.installments.length, 1);
});

test("normalizeLoanDetailResponse: también acepta un LoanRecord crudo (fallback)", () => {
  const raw = { id: 99, lenderName: "X", principalAmount: 500, status: "ACTIVE" };
  const loan = normalizeLoanDetailResponse(raw);
  assert.equal(loan.id, 99);
});

test("normalizeLoanDetailResponse: null/undefined/no-reconocible → null", () => {
  assert.equal(normalizeLoanDetailResponse(null), null);
  assert.equal(normalizeLoanDetailResponse(undefined), null);
  assert.equal(normalizeLoanDetailResponse({}), null);
});

test("normalizeLoanPreviewResponse: {preview: ScheduleResult} se desenvuelve", () => {
  const envelope = {
    preview: {
      installments: [
        { number: 1, dueDate: "2026-01-01", principalDue: 100, interestDue: 10, totalDue: 110 },
        { number: 2, dueDate: "2026-02-01", principalDue: 100, interestDue: 10, totalDue: 110 },
      ],
      totals: { principal: 200, interest: 20, totalPayable: 220 },
    },
  };
  const r = normalizeLoanPreviewResponse(envelope);
  assert.ok(r);
  assert.equal(r.installments.length, 2);
  assert.equal(r.totals.totalPayable, 220);
});

test("normalizeLoanPreviewResponse: acepta estructura alternativa con totalInterest/totalPayable sueltos", () => {
  const raw = {
    preview: {
      installments: [{ number: 1, dueDate: "2026-01-01", principalDue: 100, interestDue: 10 }],
      totalInterest: 10,
      totalPayable: 110,
    },
  };
  const r = normalizeLoanPreviewResponse(raw);
  assert.ok(r);
  assert.equal(r.totals.interest, 10);
  assert.equal(r.totals.totalPayable, 110);
  // Cuando totalDue no viene explícito, lo recomponemos de principal+interés.
  assert.equal(r.installments[0].totalDue, 110);
});

// ============================================================================
// Selectores sobre un préstamo
// ============================================================================

function loanFixture(overrides = {}) {
  return {
    id: 1,
    lenderName: "PEPITO",
    principalAmount: 1_000_000,
    totalPayable: 1_240_000,
    totalPaid: 0,
    status: LOAN_STATUSES.ACTIVE,
    installments: [
      { number: 1, dueDate: "2026-01-01", principalDue: 83333.33, interestDue: 20000, totalDue: 103333.33, paidAmount: 0, status: INSTALLMENT_STATUSES.PENDING },
      { number: 2, dueDate: "2026-02-01", principalDue: 83333.33, interestDue: 20000, totalDue: 103333.33, paidAmount: 0, status: INSTALLMENT_STATUSES.PENDING },
      { number: 3, dueDate: "2026-03-01", principalDue: 83333.34, interestDue: 20000, totalDue: 103333.34, paidAmount: 0, status: INSTALLMENT_STATUSES.PENDING },
    ],
    expenses: [],
    ...overrides,
  };
}

test("liveLoanOutstanding: prefiere remainingBalance canónico del backend cuando viene", () => {
  // Si el backend trae remainingBalance=777.000, lo usamos EXACTO aunque los
  // installments diesen otra cifra. Es la verdad fiscal.
  const l = loanFixture({
    totalPayable: 1_240_000,
    remainingBalance: 777_000,
    installments: [], // backend no mandó installments en la lista
  });
  assert.equal(liveLoanOutstanding(l), 777_000);
});

test("liveLoanOutstanding: sin remainingBalance, suma remanentes de las cuotas vivas", () => {
  const l = loanFixture();
  const out = liveLoanOutstanding(l);
  assert.ok(Math.abs(out - 310000) < 0.01, `out=${out}`);
});

test("liveLoanOutstanding: una cuota pagada no cuenta", () => {
  const l = loanFixture({
    installments: [
      { number: 1, dueDate: "2026-01-01", totalDue: 103333.33, paidAmount: 103333.33, status: INSTALLMENT_STATUSES.PAID },
      { number: 2, dueDate: "2026-02-01", totalDue: 103333.33, paidAmount: 0, status: INSTALLMENT_STATUSES.PENDING },
      { number: 3, dueDate: "2026-03-01", totalDue: 103333.34, paidAmount: 0, status: INSTALLMENT_STATUSES.PENDING },
    ],
  });
  const out = liveLoanOutstanding(l);
  assert.ok(Math.abs(out - 206666.67) < 0.01, `out=${out}`);
});

test("liveLoanOutstanding: préstamo PAID devuelve 0 aunque tenga saldo residual", () => {
  const l = loanFixture({ status: LOAN_STATUSES.PAID, remainingBalance: 123 });
  assert.equal(liveLoanOutstanding(l), 0);
});

test("liveLoanOutstanding: fallback sin installments usa totalPayable - totalPaid", () => {
  const l = loanFixture({ installments: [], totalPayable: 500_000, totalPaid: 200_000, remainingBalance: 0 });
  assert.equal(liveLoanOutstanding(l), 300_000);
});

test("totalPaidOfLoan: prefiere totalPayable - remainingBalance cuando el backend los dio", () => {
  // backend: totalPayable=1_000_000, remainingBalance=600_000 → paid=400_000
  // aunque installments digan otra cosa.
  const l = loanFixture({
    totalPayable: 1_000_000,
    remainingBalance: 600_000,
    installments: [{ totalDue: 500, paidAmount: 500 }], // inconsistente a propósito
  });
  assert.equal(totalPaidOfLoan(l), 400_000);
});

test("totalPaidOfLoan: suma pagos parciales de todas las cuotas (fallback)", () => {
  const l = loanFixture({
    totalPayable: 0,
    remainingBalance: 0,
    installments: [
      { totalDue: 100, paidAmount: 100, status: INSTALLMENT_STATUSES.PAID },
      { totalDue: 100, paidAmount: 50, status: INSTALLMENT_STATUSES.PARTIAL },
      { totalDue: 100, paidAmount: 0, status: INSTALLMENT_STATUSES.PENDING },
    ],
  });
  assert.equal(totalPaidOfLoan(l), 150);
});

test("loanProgress: devuelve fracción entre 0 y 1 según pagos", () => {
  const l1 = loanFixture({ totalPayable: 1000, remainingBalance: 750, installments: [] });
  assert.equal(loanProgress(l1), 0.25);
  const l2 = loanFixture({ totalPayable: 1000, remainingBalance: 0, installments: [{ totalDue: 1000, paidAmount: 1000 }] });
  assert.equal(loanProgress(l2), 1);
  const l3 = loanFixture({ totalPayable: 0, remainingBalance: 0, principalAmount: 0, installments: [] });
  assert.equal(loanProgress(l3), 0);
});

test("liveLoanAvailable: principal - Σ(amountUsed) y nunca negativo", () => {
  const l = loanFixture({
    principalAmount: 1_000_000,
    expenses: [
      { amountUsed: 300_000 },
      { amountUsed: 150_000 },
    ],
  });
  assert.equal(liveLoanAvailable(l), 550_000);
  const over = loanFixture({ principalAmount: 100, expenses: [{ amountUsed: 500 }] });
  assert.equal(liveLoanAvailable(over), 0);
  // Compat con shape snake_case por si el backend aún no normaliza.
  const snake = loanFixture({ principalAmount: 1000, expenses: [{ amount_used: 400 }] });
  assert.equal(liveLoanAvailable(snake), 600);
});

test("liveLoanAvailable: prefiere principalUsed canónico del backend si viene en stats", () => {
  // En la lista NO cargamos expenses, pero el backend ya nos dijo principalUsed.
  // La UI tiene que mostrar el disponible exacto sin esperar la pantalla de detalle.
  const l = loanFixture({
    principalAmount: 1_000_000,
    principalUsed: 400_000,
    expenses: [], // vacío en lista
  });
  assert.equal(liveLoanAvailable(l), 600_000);
});

// ============================================================================
// Agrupaciones y resúmenes
// ============================================================================

test("groupInstallmentsByStatus: paid / overdue / pending según fecha de hoy", () => {
  const loan = loanFixture({
    installments: [
      { number: 1, dueDate: "2025-12-01", totalDue: 100, paidAmount: 100, status: INSTALLMENT_STATUSES.PAID },
      { number: 2, dueDate: "2026-01-01", totalDue: 100, paidAmount: 0, status: INSTALLMENT_STATUSES.PENDING },
      { number: 3, dueDate: "2026-06-01", totalDue: 100, paidAmount: 0, status: INSTALLMENT_STATUSES.PENDING },
    ],
  });
  const b = groupInstallmentsByStatus(loan, "2026-02-15");
  assert.equal(b.paid.length, 1);
  assert.equal(b.overdue.length, 1);
  assert.equal(b.pending.length, 1);
  assert.equal(b.overdue[0].number, 2);
  assert.equal(b.pending[0].number, 3);
});

test("sumLoans: ignora cancelados y pagados; suma remanentes vivos", () => {
  const loans = [
    loanFixture({ id: 1 }), // ~310_000
    loanFixture({ id: 2, status: LOAN_STATUSES.PAID }), // 0
    loanFixture({ id: 3, status: LOAN_STATUSES.CANCELLED }), // 0
    loanFixture({
      id: 4,
      status: LOAN_STATUSES.ACTIVE,
      totalPayable: 0,
      remainingBalance: 0,
      installments: [
        { totalDue: 500, paidAmount: 200 },
        { totalDue: 500, paidAmount: 0 },
      ],
    }), // 800
  ];
  const total = sumLoans(loans);
  // 310_000 (fixture base) + 800 (préstamo 4) = 310_800.
  assert.ok(Math.abs(total - 310_800) < 1, `total=${total}`);
});

test("sumActivePrincipal: suma el principal declarado solo de activos y en mora", () => {
  const loans = [
    loanFixture({ id: 1, principalAmount: 1_000_000 }),
    loanFixture({ id: 2, principalAmount: 500_000, status: LOAN_STATUSES.PAID }), // no cuenta
    loanFixture({ id: 3, principalAmount: 2_000_000, status: LOAN_STATUSES.DEFAULTED }),
    loanFixture({ id: 4, principalAmount: 100_000, status: LOAN_STATUSES.CANCELLED }), // no cuenta
  ];
  assert.equal(sumActivePrincipal(loans), 3_000_000);
});

test("upcomingInstallments: devuelve cuotas en ventana de 30 días, ordenadas", () => {
  const base = new Date("2026-01-15T00:00:00");
  const loans = [
    loanFixture({
      id: 1,
      lenderName: "A",
      installments: [
        { number: 1, dueDate: "2026-01-10", totalDue: 100, paidAmount: 100, status: INSTALLMENT_STATUSES.PAID },
        { number: 2, dueDate: "2026-01-20", totalDue: 100, paidAmount: 0, status: INSTALLMENT_STATUSES.PENDING },
        { number: 3, dueDate: "2026-03-01", totalDue: 100, paidAmount: 0, status: INSTALLMENT_STATUSES.PENDING },
      ],
    }),
    loanFixture({
      id: 2,
      lenderName: "B",
      installments: [
        { number: 1, dueDate: "2026-02-01", totalDue: 200, paidAmount: 0, status: INSTALLMENT_STATUSES.PENDING },
      ],
    }),
  ];
  const upcoming = upcomingInstallments(loans, 30, base);
  assert.equal(upcoming.length, 2);
  assert.equal(upcoming[0].dueDate, "2026-01-20");
  assert.equal(upcoming[0].loanId, 1);
  assert.equal(upcoming[1].dueDate, "2026-02-01");
  assert.equal(upcoming[1].loanId, 2);
});

test("summarizeLoans: produce el resumen que consume el dashboard", () => {
  const base = new Date("2026-02-15T00:00:00");
  const loans = [
    loanFixture({
      id: 1,
      principalAmount: 1_000_000,
      totalPayable: 300,
      remainingBalance: 200,
      installments: [
        { number: 1, dueDate: "2026-01-01", totalDue: 100, paidAmount: 100, status: INSTALLMENT_STATUSES.PAID },
        { number: 2, dueDate: "2026-02-01", totalDue: 100, paidAmount: 0, status: INSTALLMENT_STATUSES.PENDING },
        { number: 3, dueDate: "2026-03-01", totalDue: 100, paidAmount: 0, status: INSTALLMENT_STATUSES.PENDING },
      ],
    }),
    loanFixture({
      id: 2,
      principalAmount: 500_000,
      status: LOAN_STATUSES.PAID,
      remainingBalance: 0,
      installments: [
        { number: 1, dueDate: "2025-12-01", totalDue: 500000, paidAmount: 500000, status: INSTALLMENT_STATUSES.PAID },
      ],
    }),
  ];
  const s = summarizeLoans(loans, base);
  assert.equal(s.activeCount, 1);
  assert.equal(s.overdueCount, 1); // la del 1-feb vencida respecto a 15-feb
  assert.equal(s.totalPrincipal, 1_000_000);
  assert.ok(s.totalOutstanding > 0);
  assert.equal(s.upcoming30d.length, 1);
  assert.equal(s.upcoming30d[0].dueDate, "2026-03-01");
});

test("classifyInstallment: paid / partial / overdue / pending", () => {
  assert.equal(classifyInstallment({ totalDue: 100, paidAmount: 100 }, "2026-01-01"), "paid");
  assert.equal(classifyInstallment({ totalDue: 100, paidAmount: 50 }, "2026-01-01"), "partial");
  assert.equal(classifyInstallment({ totalDue: 100, paidAmount: 0, dueDate: "2025-12-01" }, "2026-01-02"), "overdue");
  assert.equal(classifyInstallment({ totalDue: 100, paidAmount: 0, dueDate: "2026-06-01" }, "2026-01-02"), "pending");
  assert.equal(classifyInstallment({ status: "PAID", totalDue: 0, paidAmount: 0 }, "2026-01-01"), "paid");
});

test("installmentProgress: fracción pagada", () => {
  assert.equal(installmentProgress({ totalDue: 100, paidAmount: 25 }), 0.25);
  assert.equal(installmentProgress({ totalDue: 0, paidAmount: 0 }), 0);
  // No se desborda si paidAmount > totalDue
  assert.equal(installmentProgress({ totalDue: 100, paidAmount: 500 }), 1);
});

test("formatLoanMoney: COP legible con separador de miles es-CO", () => {
  assert.equal(formatLoanMoney(0), "$0");
  assert.equal(formatLoanMoney(1234567), "$1.234.567");
  assert.equal(formatLoanMoney("1500.5"), "$1.501");
  assert.equal(formatLoanMoney(null), "$0");
});

// ============================================================================
// Fechas: toISODate / addPeriod
// ============================================================================

test("toISODate: respeta hora local (no desplaza por UTC)", () => {
  const d = new Date(2026, 9, 1, 23, 0, 0);
  assert.equal(toISODate(d), "2026-10-01");
});

test("toISODate: devuelve null para entradas inválidas", () => {
  assert.equal(toISODate(null), null);
  assert.equal(toISODate(undefined), null);
  assert.equal(toISODate("no-es-fecha"), null);
  assert.equal(toISODate(new Date("invalid")), null);
});

test("addPeriod: avanza correctamente en WEEKLY/BIWEEKLY/MONTHLY", () => {
  const base = new Date(2026, 0, 1); // 2026-01-01 local
  assert.equal(toISODate(addPeriod(base, "WEEKLY", 2)), "2026-01-15");
  assert.equal(toISODate(addPeriod(base, "BIWEEKLY", 1)), "2026-01-15");
  assert.equal(toISODate(addPeriod(base, "MONTHLY", 1)), "2026-02-01");
  assert.equal(toISODate(addPeriod(base, "MONTHLY", 12)), "2027-01-01");
});

// ============================================================================
// Códigos de error expuestos — contrato estable con el backend.
// ============================================================================

test("LOAN_ERROR_CODES: expone los 7 códigos canónicos del backend", () => {
  assert.equal(LOAN_ERROR_CODES.LOAN_NOT_FOUND, "LOAN_NOT_FOUND");
  assert.equal(LOAN_ERROR_CODES.LOAN_INSTALLMENT_NOT_FOUND, "LOAN_INSTALLMENT_NOT_FOUND");
  assert.equal(LOAN_ERROR_CODES.LOAN_INSTALLMENT_ALREADY_PAID, "LOAN_INSTALLMENT_ALREADY_PAID");
  assert.equal(LOAN_ERROR_CODES.LOAN_PRINCIPAL_EXCEEDED, "LOAN_PRINCIPAL_EXCEEDED");
  assert.equal(LOAN_ERROR_CODES.LOAN_INVALID_SCHEDULE, "LOAN_INVALID_SCHEDULE");
  assert.equal(LOAN_ERROR_CODES.LOAN_INVALID_INPUT, "LOAN_INVALID_INPUT");
  assert.equal(LOAN_ERROR_CODES.LOAN_HAS_PAYMENTS, "LOAN_HAS_PAYMENTS");
});
