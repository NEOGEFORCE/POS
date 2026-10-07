// Contrato Go ↔ TS del modo FRENCH. Los fixtures replican la forma EXACTA
// que serializa el backend (LoanSchedulePreview y LoanInstallment con
// MarshalJSON). Antes cada lado se probaba por separado y el detalle
// mostraba $0 por cuota y el preview del servidor perdía la cuota base.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLoanPreviewResponse,
  normalizeLoanDetailResponse,
} from "../src/lib/loans.mjs";

const goFrenchPreview = {
  preview: {
    totalInterest: 14296336.4,
    totalPayable: 40996336.4,
    installmentBase: 654938.94,
    installments: [
      { id: 0, loanId: 0, number: 1, dueDate: "2026-11-06T00:00:00-05:00", principalDue: 249382.78, interestDue: 405556.16, insuranceDue: 25000, fgaDue: 10000, paidAmount: 0, status: "PENDING", totalDue: 689938.94 },
    ],
    monthlyInsurance: 25000,
    totalInsurance: 1500000,
    fgaTotal: 600000,
    monthlyFga: 10000,
    totalFga: 600000,
    baseInstallment: 654938.94,
    monthlyRate: 0.016222,
    monthlyTotal: 689938.94,
  },
};

test("contrato: preview FRENCH del servidor conserva cuota base, M.V. y total mensual", () => {
  const p = normalizeLoanPreviewResponse(goFrenchPreview);
  assert.equal(p.totals.baseInstallment, 654938.94);
  assert.equal(p.totals.monthlyTotal, 689938.94);
  assert.equal(p.totals.monthlyRatePct, 1.62);
  assert.equal(p.totals.monthlyInsurance, 25000);
  assert.equal(p.totals.monthlyFga, 10000);
  assert.equal(p.installments[0].totalDue, 689938.94);
});

test("contrato: preview FRENCH sin baseInstallment cae a installmentBase y deriva el total", () => {
  const { baseInstallment, monthlyTotal, ...rest } = goFrenchPreview.preview;
  const p = normalizeLoanPreviewResponse({ preview: rest });
  assert.equal(p.totals.baseInstallment, 654938.94);
  assert.equal(p.totals.monthlyTotal, 689938.94);
});

test("contrato: preview SIMPLE no inventa extras franceses", () => {
  const p = normalizeLoanPreviewResponse({
    preview: { totalInterest: 100000, totalPayable: 1100000, installmentBase: 220000, installments: [{ number: 1, principalDue: 200000, interestDue: 20000, insuranceDue: 0, fgaDue: 0, totalDue: 220000 }], monthlyInsurance: 0, totalInsurance: 0, fgaTotal: 0, monthlyFga: 0, totalFga: 0 },
  });
  assert.equal(p.totals.baseInstallment, undefined);
  assert.equal(p.totals.monthlyTotal, undefined);
  assert.equal(p.totals.monthlyRate, undefined);
});

test("contrato: detalle completa totalDue de cada cuota aunque el backend no lo mande", () => {
  const loan = normalizeLoanDetailResponse({
    loan: {
      id: 7, lenderName: "BANCO", principalAmount: 25000000, interestMode: "FRENCH",
      installments: [
        { number: 1, principalDue: 249382.78, interestDue: 405556.16, insuranceDue: 25000, fgaDue: 10000, paidAmount: 0, status: "PENDING" },
        { number: 2, principalDue: 100, interestDue: 10, paidAmount: 0, status: "PENDING" },
      ],
    },
  });
  assert.equal(loan.installments[0].totalDue, 689938.94);
  assert.equal(loan.installments[1].totalDue, 110);
  assert.equal(loan.installments[1].insuranceDue, 0);
  assert.equal(loan.installments[1].fgaDue, 0);
});

test("contrato: detalle respeta totalDue del backend", () => {
  const loan = normalizeLoanDetailResponse({
    loan: { id: 8, lenderName: "X", installments: [{ number: 1, principalDue: 1, interestDue: 1, insuranceDue: 1, fgaDue: 1, totalDue: 4 }] },
  });
  assert.equal(loan.installments[0].totalDue, 4);
});
