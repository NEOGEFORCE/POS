// ============================================================================
// Guardianes del flujo de EDICIÓN de préstamos (/loans + detail + modal).
//
// Cubre:
//   - El tipo LoanRecord acepta la metadata bancaria (creditNumber,
//     loanType, holderName/Dni, currency, rateType, autoDebit,
//     maturityDate, lateAnnualEffectiveRatePct, netDisbursement,
//     fgaIva/Gmf) y el snapshot bancario (bankBalance/AsOf/Paid,
//     officialNextInstallment{Amount,Date}).
//   - normalizeLoanDetailResponse tolera camelCase y snake_case.
//   - nextInstallmentDelta expone discrepancias (nunca las oculta).
//   - LoanFormModal soporta mode="edit", recibe loan precargado,
//     switch "Recalcular cuotas" gated por installmentsPaid === 0,
//     muestra sección Datos del banco + Snapshot banco siempre.
//   - detail/page.tsx expone botón "Editar" admin, pintar banner
//     "Banco oficial vs Cronograma estimado" (nunca oculto), envía
//     PUT /loans/:id con { metadata, schedule } y maneja los
//     códigos nuevos LOAN_HAS_PAID_INSTALLMENTS /
//     LOAN_PRINCIPAL_BELOW_USAGE.
//
// Reglas que seguimos aplicando desde loans-ui-contract.test.mjs:
//   - Nunca paymentSource='PRESTAMO'.
//   - Nunca diálogos nativos.
//   - Edición restringida a isAdminUser.
//   - El modal mantiene la fuente única @/lib/loans.mjs.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const loansRoot = join(here, "..", "src", "app", "(app)", "loans");

const DETAIL = join(loansRoot, "detail", "page.tsx");
const FORM_MODAL = join(loansRoot, "components", "LoanFormModal.tsx");
const PAGE = join(loansRoot, "page.tsx");
const LOANS_LIB = join(here, "..", "src", "lib", "loans.mjs");
const LOANS_TYPES = join(here, "..", "src", "lib", "loans.d.mts");

async function leer(path) {
  return readFile(path, "utf8");
}

// ---------------------------------------------------------------------------
// Normalizadores y helpers puros (unit tests)
// ---------------------------------------------------------------------------

test("loans.mjs: expone LOAN_TYPES, RATE_TYPES y LOAN_CURRENCIES con los valores que acepta el backend 023", async () => {
  const mod = await import("../src/lib/loans.mjs");
  assert.deepEqual(Object.keys(mod.LOAN_TYPES).sort(), [
    "COMERCIAL",
    "CONSUMO",
    "HIPOTECARIO",
    "LIBRANZA",
    "OTRO",
    "VEHICULO",
  ]);
  assert.deepEqual(Object.keys(mod.RATE_TYPES).sort(), ["FIJO", "VARIABLE"]);
  assert.deepEqual(Object.keys(mod.LOAN_CURRENCIES).sort(), ["COP", "USD"]);
});

test("loans.mjs: LOAN_ERROR_CODES incluye los sentinels del endpoint PUT /loans/:id", async () => {
  const { LOAN_ERROR_CODES } = await import("../src/lib/loans.mjs");
  assert.equal(LOAN_ERROR_CODES.LOAN_HAS_PAID_INSTALLMENTS, "LOAN_HAS_PAID_INSTALLMENTS");
  assert.equal(LOAN_ERROR_CODES.LOAN_PRINCIPAL_BELOW_USAGE, "LOAN_PRINCIPAL_BELOW_USAGE");
});

test("normalizeLoanDetailResponse: carga metadata bancaria desde camelCase", async () => {
  const { normalizeLoanDetailResponse } = await import("../src/lib/loans.mjs");
  const raw = {
    loan: {
      id: 42,
      lenderName: "BANCO DE BOGOTA",
      principalAmount: 25297500,
      interestMode: "FRENCH",
      creditNumber: "0013-0021-96-00322102",
      loanType: "CONSUMO",
      holderName: "FABIAN ERNESTO SARMIENTO",
      holderDni: null,
      currency: "COP",
      rateType: "FIJO",
      autoDebit: true,
      maturityDate: "2031-10-05",
      lateAnnualEffectiveRatePct: 0,
      netDisbursementAmount: 25000000,
      fgaIvaAmount: 47500,
      fgaGmfAmount: 1190,
      bankBalanceAmount: 25326046.44,
      bankBalanceAsOf: "2026-10-07T12:00:00-05:00",
      bankPaidAmount: 0,
      officialNextInstallmentAmount: 693951.69,
      officialNextInstallmentDate: "2026-11-05",
    },
  };
  const loan = normalizeLoanDetailResponse(raw);
  assert.ok(loan);
  assert.equal(loan.creditNumber, "0013-0021-96-00322102");
  assert.equal(loan.loanType, "CONSUMO");
  assert.equal(loan.holderName, "FABIAN ERNESTO SARMIENTO");
  assert.equal(loan.holderDni, null);
  assert.equal(loan.currency, "COP");
  assert.equal(loan.rateType, "FIJO");
  assert.equal(loan.autoDebit, true);
  assert.equal(loan.maturityDate, "2031-10-05");
  assert.equal(loan.lateAnnualEffectiveRatePct, 0);
  assert.equal(loan.netDisbursementAmount, 25000000);
  assert.equal(loan.fgaIvaAmount, 47500);
  assert.equal(loan.fgaGmfAmount, 1190);
  assert.equal(loan.bankBalanceAmount, 25326046.44);
  assert.equal(loan.bankBalanceAsOf, "2026-10-07T12:00:00-05:00");
  assert.equal(loan.bankPaidAmount, 0);
  assert.equal(loan.officialNextInstallmentAmount, 693951.69);
  assert.equal(loan.officialNextInstallmentDate, "2026-11-05");
});

test("normalizeLoanDetailResponse: tolera snake_case y strings vacíos como null", async () => {
  const { normalizeLoanDetailResponse } = await import("../src/lib/loans.mjs");
  const raw = {
    loan: {
      id: 7,
      lenderName: "ACME",
      principalAmount: 1000,
      credit_number: "A-1",
      loan_type: "OTRO",
      holder_name: "   ",
      auto_debit: "true",
      maturity_date: "2027-01-01",
      net_disbursement_amount: "950.00",
      bank_balance_amount: "1050.5",
      bank_balance_as_of: "2026-11-01T09:00:00-05:00",
      official_next_installment_amount: "160.0",
      official_next_installment_date: "2026-12-01",
    },
  };
  const loan = normalizeLoanDetailResponse(raw);
  assert.ok(loan);
  assert.equal(loan.creditNumber, "A-1");
  assert.equal(loan.loanType, "OTRO");
  // El trim debe convertir "   " en null (string vacío).
  assert.equal(loan.holderName, null);
  assert.equal(loan.autoDebit, true);
  assert.equal(loan.maturityDate, "2027-01-01");
  assert.equal(loan.netDisbursementAmount, 950);
  assert.equal(loan.bankBalanceAmount, 1050.5);
  assert.equal(loan.bankBalanceAsOf, "2026-11-01T09:00:00-05:00");
  assert.equal(loan.officialNextInstallmentAmount, 160);
  assert.equal(loan.officialNextInstallmentDate, "2026-12-01");
});

test("normalizeLoanDetailResponse: préstamos legacy sin metadata siguen funcionando", async () => {
  const { normalizeLoanDetailResponse } = await import("../src/lib/loans.mjs");
  const raw = {
    loan: {
      id: 1,
      lenderName: "SR. GARCIA",
      principalAmount: 100000,
      interestRatePct: 10,
      interestMode: "SIMPLE",
      termCount: 5,
      paymentFrequency: "MONTHLY",
      status: "ACTIVE",
    },
  };
  const loan = normalizeLoanDetailResponse(raw);
  assert.ok(loan);
  // Metadata no está — y los campos del snapshot tampoco. No deben
  // aparecer como `undefined` falsamente poblado.
  assert.equal(loan.creditNumber, undefined);
  assert.equal(loan.loanType, undefined);
  assert.equal(loan.bankBalanceAmount, undefined);
  assert.equal(loan.officialNextInstallmentAmount, undefined);
  // Lo que sí cargaba sigue intacto.
  assert.equal(loan.interestMode, "SIMPLE");
  assert.equal(loan.principalAmount, 100000);
  assert.equal(loan.termCount, 5);
});

test("nextInstallmentDelta: calcula amountDelta y dateDelta positivos cuando el banco pide más (caso real BOG 2026-11)", async () => {
  const { nextInstallmentDelta } = await import("../src/lib/loans.mjs");
  const loan = {
    id: 42,
    lenderName: "BANCO",
    principalAmount: 25297500,
    installments: [
      {
        number: 1,
        dueDate: "2026-11-06",
        principalDue: 249382.78,
        interestDue: 405556.16,
        insuranceDue: 30040.78,
        fgaDue: 7793.78,
        totalDue: 692773.5,
        paidAmount: 0,
        status: "PENDING",
      },
      {
        number: 2,
        dueDate: "2026-12-06",
        principalDue: 249382.78,
        interestDue: 405556.16,
        insuranceDue: 30040.78,
        fgaDue: 7793.78,
        totalDue: 692773.5,
        paidAmount: 0,
        status: "PENDING",
      },
    ],
    officialNextInstallmentAmount: 693951.69,
    officialNextInstallmentDate: "2026-11-05",
  };
  const delta = nextInstallmentDelta(loan);
  assert.ok(delta);
  assert.equal(delta.hasOfficial, true);
  assert.equal(delta.officialAmount, 693951.69);
  assert.equal(delta.officialDate, "2026-11-05");
  assert.equal(delta.estimatedAmount, 692773.5);
  assert.equal(delta.estimatedDate, "2026-11-06");
  // Banco pide más → delta positivo. Banco corta un día antes → -1.
  assert.ok(delta.amountDelta !== null && delta.amountDelta > 0);
  assert.equal(Math.round(delta.amountDelta * 100) / 100, 1178.19);
  assert.equal(delta.dateDelta, -1);
});

test("nextInstallmentDelta: hasOfficial=false cuando no hay snapshot del banco cargado", async () => {
  const { nextInstallmentDelta } = await import("../src/lib/loans.mjs");
  const delta = nextInstallmentDelta({ id: 1, installments: [] });
  assert.ok(delta);
  assert.equal(delta.hasOfficial, false);
  assert.equal(delta.officialAmount, null);
});

test("nextInstallmentDelta: ignora cuotas pagadas al elegir la 'próxima estimada'", async () => {
  const { nextInstallmentDelta } = await import("../src/lib/loans.mjs");
  const loan = {
    id: 2,
    installments: [
      {
        number: 1,
        dueDate: "2026-11-06",
        totalDue: 100,
        paidAmount: 100,
        status: "PAID",
      },
      {
        number: 2,
        dueDate: "2026-12-06",
        totalDue: 100,
        paidAmount: 0,
        status: "PENDING",
      },
    ],
    officialNextInstallmentAmount: 110,
    officialNextInstallmentDate: "2026-12-05",
  };
  const delta = nextInstallmentDelta(loan);
  assert.ok(delta);
  assert.equal(delta.estimatedDate, "2026-12-06");
  assert.equal(delta.estimatedAmount, 100);
  assert.equal(delta.amountDelta, 10);
});

// ---------------------------------------------------------------------------
// Tipos (loans.d.mts)
// ---------------------------------------------------------------------------

test("loans.d.mts: LoanRecord declara los nuevos campos de metadata bancaria", async () => {
  const types = await leer(LOANS_TYPES);
  for (const needle of [
    "creditNumber",
    "loanType",
    "holderName",
    "holderDni",
    "currency",
    "rateType",
    "autoDebit",
    "maturityDate",
    "lateAnnualEffectiveRatePct",
    "netDisbursementAmount",
    "fgaIvaAmount",
    "fgaGmfAmount",
    "bankBalanceAmount",
    "bankBalanceAsOf",
    "bankPaidAmount",
    "officialNextInstallmentAmount",
    "officialNextInstallmentDate",
  ]) {
    assert.ok(
      types.includes(needle),
      `LoanRecord debe exponer el campo opcional '${needle}' en loans.d.mts`,
    );
  }
});

test("loans.d.mts: exporta los enums LoanType, LoanRateType, LoanCurrency", async () => {
  const types = await leer(LOANS_TYPES);
  assert.match(types, /export type LoanType =/);
  assert.match(types, /export type LoanRateType =/);
  assert.match(types, /export type LoanCurrency =/);
  // Y los códigos de error nuevos.
  assert.match(types, /"LOAN_HAS_PAID_INSTALLMENTS"/);
  assert.match(types, /"LOAN_PRINCIPAL_BELOW_USAGE"/);
});

// ---------------------------------------------------------------------------
// LoanFormModal — soporta modo edición
// ---------------------------------------------------------------------------

test("LoanFormModal: tipa mode='create'|'edit' y acepta un `loan` precargado", async () => {
  const src = await leer(FORM_MODAL);
  assert.match(
    src,
    /export type LoanFormMode\s*=\s*["']create["']\s*\|\s*["']edit["']/,
    "El modal debe exportar el tipo LoanFormMode",
  );
  assert.match(
    src,
    /mode\?\s*:\s*LoanFormMode/,
    "La prop `mode` debe ser opcional (default 'create') y tipada con LoanFormMode",
  );
  assert.match(
    src,
    /loan\?\s*:\s*LoanRecord\s*\|\s*null/,
    "La prop `loan` debe ser `LoanRecord | null` opcional",
  );
});

test("LoanFormModal: en modo edit el estado se precarga con stateFromLoan y el header dice 'Editar'", async () => {
  const src = await leer(FORM_MODAL);
  assert.match(src, /stateFromLoan\(/, "Debe haber un helper stateFromLoan para precargar");
  assert.match(
    src,
    /mode === ["']edit["'][\s\S]{0,160}stateFromLoan\(loan\)/,
    "En modo edit el estado inicial debe venir de stateFromLoan(loan)",
  );
  assert.match(
    src,
    /mode === ["']edit["'][\s\S]{0,200}Editar/,
    "El header debe cambiar a 'Editar' cuando mode==='edit'",
  );
  assert.match(
    src,
    /Guardar cambios/,
    "El botón primario debe decir 'Guardar cambios' en modo edit",
  );
});

test("LoanFormModal: en modo edit expone switch 'Recalcular cuotas' con gating por installmentsPaid === 0", async () => {
  const src = await leer(FORM_MODAL);
  assert.match(
    src,
    /Recalcular cuotas/,
    "El modal debe tener un control 'Recalcular cuotas'",
  );
  assert.match(
    src,
    /installmentsPaid\s*===\s*0/,
    "La condición de habilitación debe ser installmentsPaid === 0",
  );
  // Si no se puede recalcular, el switch viene bloqueado explícitamente.
  assert.match(
    src,
    /disabled=\{!canRecalculate\}/,
    "El switch de recalcular debe estar disabled cuando !canRecalculate",
  );
  // Y la copia explica el ancla contable.
  assert.match(src, /anclado contablemente|cuota[s]? pagada[s]?/i);
});

test("LoanFormModal: scheduleLocked bloquea principal/termCount/tasa/frecuencia/firstPaymentDate en edit sin recalculate", async () => {
  const src = await leer(FORM_MODAL);
  assert.match(
    src,
    /const scheduleLocked\s*=\s*mode === ["']edit["']\s*&&\s*!recalculate/,
    "Debe calcular scheduleLocked como mode==='edit' && !recalculate",
  );
  // Cada input financiero debe recibir isDisabled={scheduleLocked...}.
  for (const fieldId of [
    "loan-principal",
    "loan-term-count",
    "loan-first-payment",
    "loan-interest-mode",
  ]) {
    const idx = src.indexOf(`id="${fieldId}"`);
    assert.ok(idx > 0, `Falta el input ${fieldId} en el modal`);
    // Ventana amplia: después del <Field> viene el <Input>/<Select> con sus
    // props. 1500 chars es suficiente para pasar el isDisabled sin falsos
    // negativos por truncamiento del slice.
    const window = src.slice(idx, idx + 2500);
    assert.match(
      window,
      /isDisabled=\{scheduleLocked/,
      `${fieldId} debe estar isDisabled cuando scheduleLocked es true`,
    );
  }
});

test("LoanFormModal: formulario contiene la sección 4 (Datos del banco) con todos los campos pedidos", async () => {
  const src = await leer(FORM_MODAL);
  // Encabezado de sección.
  assert.match(src, /4 · Datos del banco/);
  // Inputs específicos:
  for (const fieldId of [
    "loan-credit-number",
    "loan-type",
    "loan-holder-name",
    "loan-holder-dni",
    "loan-currency",
    "loan-rate-type",
    "loan-auto-debit-title",
    "loan-maturity-date",
    "loan-late-rate",
    "loan-net-disbursement",
    "loan-fga-iva",
    "loan-fga-gmf",
  ]) {
    assert.ok(
      src.includes(`"${fieldId}"`),
      `La sección Datos del banco debe exponer el control '${fieldId}'`,
    );
  }
});

test("LoanFormModal: formulario contiene la sección 5 (Snapshot banco) y aclara que NO ajusta el saldo contable", async () => {
  const src = await leer(FORM_MODAL);
  assert.match(src, /5 · Snapshot banco/);
  for (const fieldId of [
    "loan-bank-balance",
    "loan-bank-balance-asof",
    "loan-bank-paid",
    "loan-official-amount",
    "loan-official-date",
  ]) {
    assert.ok(
      src.includes(`"${fieldId}"`),
      `La sección Snapshot banco debe exponer el control '${fieldId}'`,
    );
  }
  assert.match(
    src,
    /Nunca ajusta el saldo contable/i,
    "El Snapshot debe aclarar que no ajusta el saldo contable",
  );
  assert.match(
    src,
    /Banco oficial vs Cronograma estimado/,
    "La UI debe nombrar 'Banco oficial vs Cronograma estimado' explícitamente",
  );
});

test("LoanFormModal: toPayload emite todos los campos nuevos + flag `recalculate` sólo en modo edit", async () => {
  const src = await leer(FORM_MODAL);
  // Los campos de metadata y snapshot aparecen todos en toPayload.
  for (const key of [
    "creditNumber",
    "loanType",
    "holderName",
    "holderDni",
    "currency",
    "rateType",
    "autoDebit",
    "maturityDate",
    "lateAnnualEffectiveRatePct",
    "netDisbursementAmount",
    "fgaTotalAmount",
    "fgaIvaAmount",
    "fgaGmfAmount",
    "bankBalanceAmount",
    "bankBalanceAsOf",
    "bankPaidAmount",
    "officialNextInstallmentAmount",
    "officialNextInstallmentDate",
  ]) {
    assert.ok(
      new RegExp(`payload\\.${key}\\s*=`).test(src),
      `toPayload debe emitir payload.${key}`,
    );
  }
  // El flag `recalculate` se incluye SOLO cuando mode === 'edit'.
  assert.match(
    src,
    /if \(mode === ["']edit["']\)\s*\{[\s\S]{0,80}payload\.recalculate = recalculate/,
    "payload.recalculate sólo debe asignarse cuando mode==='edit'",
  );
});

test("LoanFormModal: en modo edit NO exige preview (permite guardar sólo metadata)", async () => {
  const src = await leer(FORM_MODAL);
  // canSubmit debe permitir el envío cuando scheduleLocked y no hay preview sano.
  assert.match(
    src,
    /if \(!scheduleLocked\)\s*\{\s*if\s*\(!preview\s*\|\|\s*preview\.error\)\s*return false;\s*\}/,
    "canSubmit debe permitir envío metadata-only (sin preview) cuando scheduleLocked",
  );
});

test("LoanFormModal: Switch viene del shared @/components/ui/switch, no de @heroui/react", async () => {
  const src = await leer(FORM_MODAL);
  assert.match(
    src,
    /import\s*\{\s*Switch\s*\}\s*from\s*["']@\/components\/ui\/switch["']/,
    "El modal debe reusar el Switch compartido del POS (no HeroUI)",
  );
  // No debe importar Switch desde heroui.
  assert.doesNotMatch(
    src,
    /import\s*\{[^}]*\bSwitch\b[^}]*\}\s*from\s*["']@heroui\/react["']/,
    "No importar Switch desde @heroui/react en el formulario",
  );
});

test("LoanFormModal: no se añadieron diálogos nativos ni paymentSource='PRESTAMO' en la refactorización", async () => {
  const src = await leer(FORM_MODAL);
  for (const nativo of ["window.confirm", "window.alert", "window.prompt"]) {
    assert.ok(!src.includes(nativo), `No se permite ${nativo} en el modal`);
  }
  assert.ok(
    !/paymentSource\s*:\s*['"]PRESTAMO['"]/.test(src),
    "El modal no debe generar paymentSource='PRESTAMO' directamente",
  );
});

// ---------------------------------------------------------------------------
// Detail page — botón Editar + banner Banco oficial + handler PUT
// ---------------------------------------------------------------------------

test("loans/detail: expone botón 'Editar' sólo para admin que abre LoanFormModal con mode='edit'", async () => {
  const src = await leer(DETAIL);
  assert.match(
    src,
    /isAdmin\s*&&\s*\(\s*<Button[\s\S]{0,500}Editar/,
    "El botón 'Editar' debe estar gated por isAdmin",
  );
  assert.match(
    src,
    /<LoanFormModal[\s\S]{0,400}mode=["']edit["']/,
    "LoanFormModal debe montarse con mode='edit' en el detalle",
  );
  assert.match(
    src,
    /<LoanFormModal[\s\S]{0,400}loan=\{loan\}/,
    "LoanFormModal debe recibir `loan={loan}` precargado",
  );
});

test("loans/detail: usa nextInstallmentDelta y pinta el banner 'Banco oficial vs Cronograma estimado'", async () => {
  const src = await leer(DETAIL);
  assert.match(
    src,
    /import[\s\S]*nextInstallmentDelta[\s\S]*from\s+["']@\/lib\/loans\.mjs["']/,
    "detail debe importar nextInstallmentDelta del helper central",
  );
  assert.match(src, /BankOfficialBanner/, "detail debe pintar el banner con un componente propio");
  assert.match(src, /Banco oficial vs Cronograma estimado/);
  // Siempre que haya hasOfficial se muestra; no se usa display:none ni condicional
  // que oculte la discrepancia detrás de un flag "si-cuadra".
  assert.match(
    src,
    /bankDelta\?\.hasOfficial/,
    "El banner se enciende con bankDelta?.hasOfficial (no con 'si cuadra')",
  );
});

test("loans/detail: envía PUT /loans/:id con cuerpo { metadata, schedule }", async () => {
  const src = await leer(DETAIL);
  assert.match(
    src,
    /method:\s*["']PUT["']/,
    "El handler de edición debe hacer PUT",
  );
  assert.match(
    src,
    /\/loans\/\$\{[^}]*String\(loan\.id\)[^}]*\}/,
    "Debe pegar a /loans/:id",
  );
  assert.match(
    src,
    /JSON\.stringify\(\s*\{\s*metadata\s*,\s*schedule\s*\}\s*\)/,
    "El payload del PUT debe ser { metadata, schedule } (contrato 023)",
  );
});

test("loans/detail: handleEditLoan nunca envía paymentSource='PRESTAMO' ni toca remainingBalance", async () => {
  const src = await leer(DETAIL);
  // El handler no debe inventar paymentSource.
  assert.ok(
    !/paymentSource\s*:\s*['"]PRESTAMO['"]/.test(src),
    "El handler de edición no debe fabricar paymentSource='PRESTAMO'",
  );
  // Y no debe escribir remainingBalance como si fuera editable desde el modal.
  const putBlock = src.slice(src.indexOf("const handleEditLoan"), src.indexOf("const handleEditLoan") + 4000);
  assert.ok(
    putBlock.length > 0,
    "No se pudo localizar handleEditLoan en detail.tsx",
  );
  assert.ok(
    !/remainingBalance\s*:/i.test(putBlock),
    "El PUT del detalle no debe enviar remainingBalance como campo editable",
  );
});

test("loans/detail: maneja LOAN_HAS_PAID_INSTALLMENTS y LOAN_PRINCIPAL_BELOW_USAGE con toasts específicos", async () => {
  const src = await leer(DETAIL);
  assert.match(
    src,
    /code === ["']LOAN_HAS_PAID_INSTALLMENTS["']/,
    "detail debe reaccionar a LOAN_HAS_PAID_INSTALLMENTS",
  );
  assert.match(
    src,
    /code === ["']LOAN_PRINCIPAL_BELOW_USAGE["']/,
    "detail debe reaccionar a LOAN_PRINCIPAL_BELOW_USAGE",
  );
});

test("loans/detail: Edición mantiene las reglas del guardián loans-ui-contract (apiFetch, sin dialogs nativos)", async () => {
  const src = await leer(DETAIL);
  // apiFetch sigue siendo la única puerta a /loans.
  assert.ok(
    !/fetch\(\s*`\$\{API_URL\}\/loans/.test(src),
    "El PUT debe pasar por apiFetch (no fetch crudo)",
  );
  for (const nativo of ["window.confirm", "window.alert", "window.prompt"]) {
    assert.ok(!src.includes(nativo), `No se permite ${nativo} en detail.tsx`);
  }
});

// ---------------------------------------------------------------------------
// Página /loans — compatibilidad con el modal nuevo
// ---------------------------------------------------------------------------

test("loans/page: el modal de creación sigue montando sin mode (default 'create')", async () => {
  const src = await leer(PAGE);
  // La página NO debe pasar mode="edit" (eso lo hace detail).
  assert.ok(
    !/mode=["']edit["']/.test(src),
    "La página /loans sólo monta el modal en modo create",
  );
  // El onSubmit sigue sin bifurcar por recalculate — es create puro.
  assert.ok(
    !/recalculate\s*:/.test(src),
    "El POST de creación no debe incluir recalculate (ese flag es exclusivo del PUT)",
  );
});

// ---------------------------------------------------------------------------
// Reglas de arquitectura
// ---------------------------------------------------------------------------

test("La reversión 022 (loan_expenses.reversed_at) sigue intacta en el frontend", async () => {
  // En la página de detalle persiste el botón "Reparar pago eliminado" que
  // acompaña a `exp.orphanedPayment`.
  const src = await leer(DETAIL);
  assert.match(src, /orphanedPayment/);
  assert.match(src, /reverse-orphan/);
  assert.match(src, /Reparar pago eliminado/);
});

test("NONE y SIMPLE se siguen soportando (edit no los degrada a FRENCH)", async () => {
  const lib = await leer(LOANS_LIB);
  // Las constantes siguen expuestas con los 3 modos.
  assert.match(lib, /NONE:\s*["']NONE["']/);
  assert.match(lib, /SIMPLE:\s*["']SIMPLE["']/);
  assert.match(lib, /FRENCH:\s*["']FRENCH["']/);
  // En el modal se preserva la rama NONE/SIMPLE en toPayload (interestRatePct
  // flat se envía fuera de FRENCH).
  const form = await leer(FORM_MODAL);
  assert.match(
    form,
    /interestRatePct\s*=\s*\n?\s*interestModeValue === INTEREST_MODES\.NONE \? 0 : isFrench \? 0 : ratePctRaw/,
    "toPayload debe mantener la lógica NONE/SIMPLE/FRENCH legacy en interestRatePct",
  );
});
