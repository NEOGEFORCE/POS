import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const loansRoot = join(here, "..", "src", "app", "(app)", "loans");

const PAGE = join(loansRoot, "page.tsx");
const DETAIL = join(loansRoot, "detail", "page.tsx");
const FORM_MODAL = join(loansRoot, "components", "LoanFormModal.tsx");
const EXPENSE_MODAL = join(loansRoot, "components", "LoanExpenseModal.tsx");

// ============================================================================
// Guardianes estáticos del módulo /loans.
//
// Los chequeos de aquí fallan si alguien:
//   - Reimplementa la fórmula de deuda en vez de usar @/lib/loans.mjs.
//   - Reintroduce FRENCH como modo visible al usuario (contrato backend).
//   - Toca payables.mjs/paymentSource=PRESTAMO de forma que duplique conteo.
//   - Usa window.confirm/alert/prompt en vez de los modales propios.
//   - Reinventa isAdmin en vez de importar auth-helpers.mjs.
//   - Rompe los contratos de las rutas /loans[/:id/...] del backend.
//   - Omite la normalización de envelopes `{loans}`, `{loan}`, `{preview}`.
//   - Olvida explicar que el tracker de gastos NO crea un expense contable.
// ============================================================================

async function leer(path) {
  return readFile(path, "utf8");
}

test("loans/page: importa loans.mjs y no reimplementa la fórmula de saldo", async () => {
  const src = await leer(PAGE);
  assert.ok(
    /from ['"]@\/lib\/loans\.mjs['"]/.test(src),
    "loans/page debe importar los helpers desde @/lib/loans.mjs",
  );
  assert.ok(
    !/remainingAmount\s*>\s*0\s*\?\s*[\w.]*remainingAmount\s*:/.test(src),
    "loans/page NO debe reimplementar la fórmula de payables (remainingAmount > 0 ? ...)",
  );
});

test("loans/detail: importa loans.mjs y usa classifyInstallment / liveLoanAvailable", async () => {
  const src = await leer(DETAIL);
  assert.ok(/from ['"]@\/lib\/loans\.mjs['"]/.test(src));
  assert.ok(src.includes("classifyInstallment"), "debe usar classifyInstallment del helper central");
  assert.ok(src.includes("liveLoanAvailable"), "debe usar liveLoanAvailable para calcular el disponible");
});

test("loans/form: calcula el preview con buildSchedule y pide el server-side preview", async () => {
  const src = await leer(FORM_MODAL);
  assert.ok(src.includes("buildSchedule"), "form debe tener fallback local con buildSchedule");
  assert.ok(src.includes('"/loans/preview"'), "form debe llamar al endpoint de preview");
  assert.ok(
    /debounce|setTimeout\(/i.test(src),
    "el preview debe estar debounced (setTimeout) para no spamear el backend",
  );
});

test("loans/form: FRENCH es el modo por defecto con labels y cargo mensual único (spec 2026-10-07)", async () => {
  const src = await leer(FORM_MODAL);
  assert.ok(
    /SelectItem\s+key\s*=\s*["']FRENCH["']/.test(src),
    "El selector de modo debe exponer FRENCH para registrar préstamos bancarios",
  );
  assert.ok(
    /Sistema Francés \(Sobre saldos\)/.test(src),
    "FRENCH debe mostrarse como 'Sistema Francés (Sobre saldos)'",
  );
  assert.ok(
    /interestMode:\s*INTEREST_MODES\.FRENCH/.test(src),
    "El formulario debe arrancar en Sistema Francés por defecto",
  );
  assert.ok(
    /Tasa Efectiva Anual \(E\.A\.\)/.test(src),
    "Al elegir FRENCH, el label del input de tasa debe ser 'Tasa Efectiva Anual (E.A.)'",
  );
  assert.ok(
    /Valor mensual de seguros y otros cargos \(Ej: Seguro de Vida \+ FGA diferido\)/.test(src),
    "FRENCH debe incluir el campo único de seguros y otros cargos mensuales",
  );
  assert.ok(
    !/FGA total \(COP\)/.test(src),
    "El campo 'FGA total' se reemplazó por el valor mensual de cargos",
  );
  assert.ok(
    /parseLoanAmount\(state\.monthlyInsurance\)/.test(src),
    "monthlyInsurance debe pasar por parseLoanAmount en toPayload",
  );
});

test("loans/form: payload FRENCH incluye annualEffectiveRatePct, monthlyInsurance y fgaTotal", async () => {
  const src = await leer(FORM_MODAL);
  assert.ok(
    /annualEffectiveRatePct\s*=\s*ratePctRaw|payload\.annualEffectiveRatePct/.test(src),
    "Al elegir FRENCH, el payload debe emitir annualEffectiveRatePct explícito",
  );
  assert.ok(
    /payload\.monthlyInsurance\s*=/.test(src),
    "El payload debe emitir monthlyInsurance cuando el modo es FRENCH",
  );
  assert.ok(
    /payload\.fgaTotal\s*=/.test(src),
    "El payload debe emitir fgaTotal cuando el modo es FRENCH",
  );
  // interestRatePct sigue existiendo (para NONE/SIMPLE) y en FRENCH se pone
  // en 0 por retro-compatibilidad con la columna legacy NUMERIC(7,3).
  assert.ok(
    /interestRatePct\s*[:,]/.test(src),
    "interestRatePct debe seguir en el payload (para SIMPLE/NONE)",
  );
});

test("loans/form: FRENCH fuerza frecuencia MONTHLY (no permite WEEKLY/BIWEEKLY)", async () => {
  const src = await leer(FORM_MODAL);
  // El select de frecuencia se deshabilita cuando el modo es FRENCH para que
  // el operador no envíe algo distinto a MONTHLY (es el contrato banca).
  // Desde el sprint de edición acepta además un prefijo `scheduleLocked ||`
  // para bloquear el control en modo "edit" sin recálculo; ambos cumplen
  // la invariante bancaria.
  assert.ok(
    /isDisabled=\{(?:scheduleLocked\s*\|\|\s*)?form\.interestMode === INTEREST_MODES\.FRENCH\}/.test(src),
    "El selector de frecuencia debe estar isDisabled cuando el modo es FRENCH",
  );
  // Y en toPayload la frecuencia se fuerza a MONTHLY aunque el estado haya
  // quedado con otra (si el usuario cambió de SIMPLE a FRENCH sin recargar).
  assert.ok(
    /isFrench\s*\?\s*["']MONTHLY["']/.test(src),
    "toPayload debe forzar paymentFrequency a 'MONTHLY' cuando FRENCH",
  );
});

test("loans/form: preview FRENCH muestra tasa M.V., cuota base, cargos y cuota mensual final; total = final × cuotas", async () => {
  const src = await leer(FORM_MODAL);
  for (const needle of [
    "Tasa M.V.",
    "Cuota base",
    "Seguros y otros cargos / mes",
    "Cuota mensual final",
    "Saldo",
  ]) {
    assert.ok(
      src.includes(needle),
      `El preview debe mostrar '${needle}' cuando el modo es FRENCH`,
    );
  }
  assert.ok(
    /frenchDisplayTotals\(/.test(src) && /formatLoanMoney\(displayTotalToPay\)/.test(src),
    "El TOTAL A PAGAR debe salir de frenchDisplayTotals (cuota final × cuotas)",
  );
});

test("loans/form: usa interestRatePct en el payload (no annualRatePct)", async () => {
  const src = await leer(FORM_MODAL);
  // El form envía `interestRatePct` al backend; `annualRatePct` ya no es el
  // nombre canónico (semánticamente carga porcentaje total flat, no anual).
  assert.ok(
    /interestRatePct\s*[:,]/.test(src),
    "el payload debe incluir interestRatePct (contrato backend)",
  );
  assert.ok(
    !/\bannualRatePct\s*:/.test(src),
    "el payload NO debe seguir emitiendo annualRatePct — el nombre engañaba",
  );
});

test("loans/form: parsea montos COP de forma robusta (parseLoanAmount, no Number directo)", async () => {
  const src = await leer(FORM_MODAL);
  assert.ok(
    /parseLoanAmount\(/.test(src),
    "el form debe parsear con parseLoanAmount — Number('1.000.000') devuelve NaN y arruinaba el flujo",
  );
  // Guardián reforzado: en el `toPayload` NO debe aparecer `Number(` seguido
  // de un campo monetario del formulario (p.ej. `principalAmount`).
  assert.ok(
    !/Number\(\s*state\.principalAmount/.test(src),
    "principalAmount no debe pasar por Number() directo — usar parseLoanAmount",
  );
});

test("loans: NUNCA crea un expense con paymentSource='PRESTAMO'", async () => {
  // Los pagos de cuota deben enviar el canal real (EFECTIVO/NEQUI/...) para
  // no entrar en doble conteo con GetPendingDebtsSummary.
  for (const file of [PAGE, DETAIL, FORM_MODAL, EXPENSE_MODAL]) {
    const src = await leer(file);
    assert.ok(
      !/paymentSource\s*:\s*['"]PRESTAMO['"]/.test(src),
      `${file}: no debe fabricar paymentSource='PRESTAMO' — ese canal se reserva al legacy de payables.mjs.`,
    );
  }
});

test("loans: no usa diálogos nativos del navegador (confirm/alert/prompt)", async () => {
  for (const file of [PAGE, DETAIL, FORM_MODAL, EXPENSE_MODAL]) {
    const src = await leer(file);
    for (const nativo of ["window.confirm", "window.alert", "window.prompt"]) {
      assert.ok(!src.includes(nativo), `${file}: no se permite ${nativo} en el módulo de préstamos`);
    }
    assert.ok(
      !/(^|[^.\w])confirm\s*\(/.test(src),
      `${file}: no se permite confirm() nativo — usa HeroUI Modal o ConfirmDialog`,
    );
    assert.ok(
      !/(^|[^.\w])alert\s*\(/.test(src),
      `${file}: no se permite alert() nativo — usa el toast del hook useToast`,
    );
  }
});

test("loans: usa auth-helpers central y respeta isAdmin para acciones destructivas", async () => {
  for (const file of [PAGE, DETAIL]) {
    const src = await leer(file);
    assert.ok(
      /from ['"]@\/lib\/auth-helpers\.mjs['"]/.test(src),
      `${file}: debe importar isAdminUser desde @/lib/auth-helpers.mjs (no reinventar)`,
    );
    assert.ok(src.includes("isAdminUser(user)"), `${file}: debe decidir admin con isAdminUser(user)`);
  }
  // En la UI, los botones de crear préstamo / pagar cuota / registrar uso
  // deben estar envueltos en {isAdmin && ...} o isDisabled={!isAdmin}.
  const pageSrc = await leer(PAGE);
  assert.ok(/isAdmin\s*&&/.test(pageSrc), "El botón de crear préstamo debe estar gated por isAdmin");
  const detailSrc = await leer(DETAIL);
  assert.ok(/isAdmin\s*&&/.test(detailSrc), "Las acciones del detalle deben estar gated por isAdmin");
});

test("loans: respeta el contrato de endpoints documentado", async () => {
  const page = await leer(PAGE);
  assert.ok(page.includes('"/loans"'), "La página principal debe listar en /loans");

  const form = await leer(FORM_MODAL);
  assert.ok(form.includes('"/loans/preview"'), "El preview debe pegar a /loans/preview");

  // El detail usa plantillas con el id. Verificamos presencia de los endpoints.
  const detail = await leer(DETAIL);
  assert.ok(/\/loans\/\$\{[^}]*idParam[^}]*\}/.test(detail), "El detail debe cargar GET /loans/:id");
  assert.ok(
    /\/loans\/\$\{[^}]*String\(loan\.id\)[^}]*\}\/installments\/\$\{[^}]*\.number\}\/pay/.test(detail),
    "El detail debe pagar cuotas en POST /loans/:id/installments/:n/pay",
  );
  assert.ok(
    /\/loans\/\$\{[^}]*String\(loan\.id\)[^}]*\}\/expenses/.test(detail),
    "El detail debe registrar uso del principal en POST /loans/:id/expenses",
  );
});

test("loans: toda llamada a la API va por apiFetch (contrato de errores)", async () => {
  // Sólo nos interesan los archivos que efectivamente hacen peticiones a los
  // endpoints `/loans*` del backend. El import de `@/lib/loans.mjs` es un
  // helper interno y no cuenta.
  const CALL_ENDPOINT_RE = /["'`]\/loans\b|\/loans\/\$\{/;
  for (const file of [PAGE, DETAIL, FORM_MODAL, EXPENSE_MODAL]) {
    const src = await leer(file);
    if (!CALL_ENDPOINT_RE.test(src)) continue;
    assert.ok(
      /from ['"]@\/lib\/api-error['"]/.test(src),
      `${file}: debe importar apiFetch desde @/lib/api-error`,
    );
    // Prohibir fetch(`${API_URL}/loans...`) crudo que esquive el contrato de errores.
    assert.ok(
      !/fetch\(\s*`\$\{API_URL\}\/loans/.test(src),
      `${file}: todas las llamadas /loans deben pasar por apiFetch (manejo central de 401/errores)`,
    );
  }
});

test("loans: maneja códigos de error estables del backend", async () => {
  const page = await leer(PAGE);
  assert.ok(
    page.includes("LOAN_INVALID_SCHEDULE"),
    "La página debe reaccionar a LOAN_INVALID_SCHEDULE al crear",
  );
  const detail = await leer(DETAIL);
  assert.ok(
    detail.includes("LOAN_NOT_FOUND"),
    "El detalle debe manejar LOAN_NOT_FOUND (404 con código estable)",
  );
  assert.ok(
    detail.includes("LOAN_INSTALLMENT_ALREADY_PAID"),
    "El pago debe reaccionar a LOAN_INSTALLMENT_ALREADY_PAID",
  );
  assert.ok(
    detail.includes("LOAN_PRINCIPAL_EXCEEDED"),
    "El registro de gasto debe reaccionar a LOAN_PRINCIPAL_EXCEEDED",
  );
  assert.ok(
    detail.includes("LOAN_INSTALLMENT_NOT_FOUND"),
    "El pago debe reaccionar a LOAN_INSTALLMENT_NOT_FOUND",
  );
});

test("loans: NO modifica el helper legacy @/lib/payables.mjs (coexistencia)", async () => {
  // Si alguien renombró o movió payables.mjs se rompe este chequeo. El
  // objetivo es que el módulo de préstamos conviva con el flujo legacy
  // de cuentas por pagar a proveedores sin tocarlo.
  const payables = await leer(join(here, "..", "src", "lib", "payables.mjs"));
  assert.ok(payables.includes("liveDebtPrincipal"), "payables.mjs sigue exportando liveDebtPrincipal");
  assert.ok(payables.includes("groupPayablesByCreditor"), "payables.mjs sigue exportando groupPayablesByCreditor");
});

test("loans: usa los normalizadores de envelope para cada endpoint", async () => {
  const page = await leer(PAGE);
  assert.ok(
    page.includes("normalizeLoanListResponse"),
    "loans/page debe desenvolver {loans:[LoanWithStatsRow],total} con normalizeLoanListResponse",
  );
  assert.ok(
    page.includes("normalizeLoanDetailResponse"),
    "loans/page debe desenvolver {loan} de POST /loans con normalizeLoanDetailResponse",
  );

  const detail = await leer(DETAIL);
  assert.ok(
    detail.includes("normalizeLoanDetailResponse"),
    "loans/detail debe desenvolver {loan} de GET /loans/:id con normalizeLoanDetailResponse",
  );

  const form = await leer(FORM_MODAL);
  assert.ok(
    form.includes("normalizeLoanPreviewResponse"),
    "loans/form debe desenvolver {preview} de POST /loans/preview con normalizeLoanPreviewResponse",
  );
});

test("loans/detail: explica que el tracker NO crea un expense contable", async () => {
  const src = await leer(DETAIL);
  // Palabras clave que deben aparecer juntas (como texto, no como código).
  assert.ok(
    /no\s+crea\s+un\s+gasto\s+contable|bit[áa]cora/i.test(src),
    "el detalle debe explicar que el tracker de uso del principal NO crea un expense contable",
  );
});

test("loans: dashboard y detail usan LoanRecord unificado (no shapes paralelos)", async () => {
  const page = await leer(PAGE);
  const detail = await leer(DETAIL);
  // Ambos importan el tipo LoanRecord del helper central.
  assert.ok(
    /import[\s\S]*\bLoanRecord\b[\s\S]*from\s+["']@\/lib\/loans\.mjs["']/.test(page),
    "loans/page debe tipar las filas como LoanRecord del helper central",
  );
  assert.ok(
    /import[\s\S]*\bLoanRecord\b[\s\S]*from\s+["']@\/lib\/loans\.mjs["']/.test(detail),
    "loans/detail debe tipar el préstamo como LoanRecord del helper central",
  );
});

test("loans: liveLoanOutstanding prefiere remainingBalance canónico del backend (unit test)", async () => {
  const { liveLoanOutstanding } = await import("../src/lib/loans.mjs");
  // Lista: backend sólo mandó stats, no installments. La UI debe mostrar el
  // saldo exacto que el backend reporta.
  const loanFromList = {
    id: 10,
    lenderName: "ACME",
    principalAmount: 1_000_000,
    totalPayable: 1_200_000,
    remainingBalance: 900_000,
    status: "ACTIVE",
    installments: [],
  };
  assert.equal(liveLoanOutstanding(loanFromList), 900_000);
});

test("loans: liveLoanAvailable usa principalUsed canónico del backend si lo trae", async () => {
  const { liveLoanAvailable } = await import("../src/lib/loans.mjs");
  const loanFromList = {
    id: 11,
    principalAmount: 1_000_000,
    principalUsed: 250_000,
    expenses: [],
  };
  assert.equal(liveLoanAvailable(loanFromList), 750_000);
});


// ============================================================================
// REDISEÑO + MIGRACIÓN DEL CENTRO DE PAGOS (sprint 2026-10-05)
// ============================================================================
//
// Reglas que se tienen que seguir cumpliendo:
//   1. /loans/page.tsx expone pestañas (Tabs) para navegar entre Préstamos
//      y Cuentas por pagar.
//   2. /loans/components/PayablesCenter.tsx existe y usa payables.mjs.
//   3. El formulario de préstamo se vuelve responsive: grid 1 col móvil →
//      sm:grid-cols-2, labels fuera del control, footer apilado en móvil,
//      modal con max-height/scroll.
//   4. La lista de préstamos muestra el saldo en TODO breakpoint.

const PAYABLES_CENTER = join(loansRoot, "components", "PayablesCenter.tsx");

test("loans/page: incluye Tabs (Préstamos ↔ Cuentas por pagar)", async () => {
  const src = await leer(PAGE);
  // HeroUI Tabs/Tab importados
  assert.ok(/\bTabs\b/.test(src) && /\bTab\b/.test(src), "loans/page debe usar HeroUI Tabs/Tab");
  // Pestañas con keys estables para que el deep link ?pagos sea reconocible
  assert.ok(/key=["']loans["']/.test(src), "debe haber una pestaña con key='loans'");
  assert.ok(/key=["']payables["']/.test(src), "debe haber una pestaña con key='payables'");
});

test("loans/PayablesCenter: existe y usa el helper compartido payables.mjs", async () => {
  const src = await leer(PAYABLES_CENTER);
  assert.ok(
    /from ['"]@\/lib\/payables\.mjs['"]/.test(src),
    "PayablesCenter debe importar la fórmula de payables.mjs (fuente única)",
  );
  // Reutiliza el modal de pago del módulo de egresos (no duplica payment UI).
  assert.ok(
    /ExpensePaymentModal/.test(src),
    "PayablesCenter debe reutilizar ExpensePaymentModal del módulo /expenses",
  );
  // Confirmación propia de condonar presente (no dialogs nativos).
  assert.ok(/debtToForgive/.test(src), "PayablesCenter debe tener la confirmación propia de condonar");
  for (const nativo of ["window.confirm", "window.alert", "window.prompt"]) {
    assert.ok(!src.includes(nativo), `PayablesCenter no puede usar ${nativo}`);
  }
});

test("loans/PayablesCenter: NO llama directamente al backend (el padre decide)", async () => {
  const src = await leer(PAYABLES_CENTER);
  // No debe tener apiFetch directo: recibe handlers por props. Esto evita
  // duplicar peticiones si llegan a existir dos consumidores del Centro.
  assert.ok(
    !/apiFetch\s*</.test(src) && !/apiFetch\s*\(/.test(src),
    "PayablesCenter no debe llamar apiFetch directamente — el padre maneja settle/forceClose",
  );
});

test("loans/LoanFormModal: grid responsive 1 col móvil → 2 cols sm+", async () => {
  const src = await leer(FORM_MODAL);
  // Al menos un grid con la pareja de clases responsive.
  assert.ok(
    /grid-cols-1[\s\S]{0,80}sm:grid-cols-2/.test(src),
    "El formulario debe usar grid-cols-1 → sm:grid-cols-2 (sin solape de labels)",
  );
  // Y NO debe quedar un `grid-cols-2 gap-2` suelto (patrón que causaba el solape).
  assert.ok(
    !/grid\s+grid-cols-2\s+gap-2(?!\s*sm:)/.test(src),
    "No debe quedar grid-cols-2 gap-2 fijo (regresión del solape de labels)",
  );
});

test("loans/LoanFormModal: footer apilado en móvil y acomoda en sm+", async () => {
  const src = await leer(FORM_MODAL);
  // El ModalFooter se vuelve `flex-col sm:flex-row` para que en móvil
  // el total y los botones no se peleen por 390 px.
  assert.ok(
    /ModalFooter[\s\S]{0,200}flex-col[\s\S]{0,80}sm:flex-row/.test(src),
    "ModalFooter debe apilarse en móvil (flex-col sm:flex-row)",
  );
});

test("loans/LoanFormModal: modal con max-height y scroll inside", async () => {
  const src = await leer(FORM_MODAL);
  assert.ok(
    /scrollBehavior=["']inside["']/.test(src),
    "El modal debe tener scrollBehavior='inside' para no desbordar la silueta",
  );
  assert.ok(
    /max-h-\[(?:[^\]]+)\]/.test(src),
    "El modal debe limitar su alto (max-h-[...]) para no romper el layout en pantallas chicas",
  );
});

test("loans/page: LoanRow muestra el saldo SIEMPRE (no 'hidden sm:...')", async () => {
  const src = await leer(PAGE);
  // Rechazar el patrón previo: `hidden ... sm:flex` sobre el bloque de saldo.
  // El saldo aparece como texto "Saldo" seguido del valor; no debe ir precedido
  // de `hidden` que lo esconda en móvil.
  const saldoHidden = /hidden[^<]{0,120}sm:flex[\s\S]{0,160}Saldo/.test(src);
  assert.ok(!saldoHidden, "El saldo debe ser visible en móvil, no detrás de hidden sm:flex");
});

test("loans/page: usa selectLiveDebts y sumPayables para el panel de cuentas por pagar", async () => {
  const src = await leer(PAGE);
  assert.ok(/selectLiveDebts/.test(src), "loans/page debe filtrar deudas con selectLiveDebts");
  assert.ok(/sumPayables/.test(src), "loans/page debe sumar el total con sumPayables");
});

test("loans/page: SSE EXPENSE_UPDATE refresca tanto loans como expenses", async () => {
  const src = await leer(PAGE);
  // El listener debe gatillar las dos recargas en el mismo callback.
  assert.ok(
    /EXPENSE_UPDATE[\s\S]{0,400}loadLoans[\s\S]{0,160}loadExpenses|EXPENSE_UPDATE[\s\S]{0,400}loadExpenses[\s\S]{0,160}loadLoans/.test(src),
    "El listener de EXPENSE_UPDATE debe recargar préstamos y cuentas por pagar",
  );
});

test("loans/page: NO llama directamente a los endpoints del Centro de Pagos sin apiFetch", async () => {
  // Guardián de contrato de errores. apiFetch centraliza 401, retries y traducción.
  const src = await leer(PAGE);
  assert.ok(
    !/fetch\(\s*`\$\{API_URL\}\/expenses/.test(src),
    "loans/page debe llamar los endpoints de /expenses sólo vía apiFetch",
  );
});



test("loans/LoanFormModal: banco o entidad no requiere NIT/documento", async () => {
  const src = await leer(FORM_MODAL);

  // El payload traduce un documento vacío a null: el backend recibe el
  // campo opcional y el registro no se bloquea por no conocer el NIT.
  assert.ok(
    /lenderDni:\s*state\.lenderDni\.trim\(\)\s*\|\|\s*null/.test(src),
    "lenderDni vacío debe enviarse como null, no convertirse en requisito",
  );

  // El único Input obligatorio en la sección Prestamista debe ser el nombre.
  // El control de lenderDni no puede adquirir isRequired accidentalmente.
  const documentStart = src.indexOf('value={form.lenderDni}');
  assert.ok(documentStart > 0, "Debe existir el campo opcional de referencia");
  const documentScope = src.slice(Math.max(0, documentStart - 350), documentStart + 500);
  assert.ok(!/isRequired/.test(documentScope), "Documento/NIT no puede ser obligatorio");
  assert.match(
    documentScope,
    /Puedes dejarlo vacío|nunca bloquea el registro/,
    "La UI debe explicar claramente que bancos y entidades pueden omitirlo",
  );

  // El nombre sí es suficiente y la ayuda debe mencionar bancos/entidades.
  assert.match(src, /Para bancos o entidades, escribe únicamente su nombre/);
});


// Regresión 2026-10-05 (producción): la pestaña "Cuentas por pagar" no se
// veía en escritorio. El slot `tab` de HeroUI trae `w-full`; con
// `sm:flex-none` la primera pestaña tomaba el 100% del tabList (que hace
// overflow-x-scroll oculto) y la segunda quedaba fuera de pantalla.
test("/loans: las dos pestañas existen y ninguna usa flex-none (ambas visibles)", async () => {
  const src = await leer(PAGE);
  assert.match(src, /<Tab\s+key="loans"/, "Falta la pestaña de préstamos.");
  assert.match(src, /<Tab\s+key="payables"/, "Falta la pestaña de cuentas por pagar.");
  const tabSlot = src.match(/\btab:\s*"([^"]*)"/);
  assert.ok(tabSlot, "Falta classNames.tab en los Tabs de /loans.");
  assert.match(tabSlot[1], /\bflex-1\b/, "Las pestañas deben repartirse el ancho con flex-1.");
  assert.doesNotMatch(tabSlot[1], /flex-none/, "flex-none + w-full de HeroUI esconde la segunda pestaña.");
});


// Regresión 2026-10-05 (producción): con `labelPlacement="outside"` +
// `!static` los labels de HeroUI quedaban encima/debajo de los controles.
test("LoanFormModal: labels propios (<Field>), sin label/labelPlacement de HeroUI", async () => {
  const src = await leer(FORM_MODAL);
  assert.doesNotMatch(src, /\slabelPlacement=["{]/, "No usar labelPlacement de HeroUI en el formulario de préstamo.");
  assert.doesNotMatch(src, /<(Input|Select|Textarea)\b[^>]*\slabel=/s, "Los controles no deben recibir `label`; usa <Field>.");
  assert.match(src, /<label\b[^>]*htmlFor=\{id\}/, "<Field> debe asociar el label con htmlFor.");
  for (const id of ["loan-lender-name", "loan-principal", "loan-term-count", "loan-start-date", "loan-channel"]) {
    assert.ok(src.includes(`<Field id="${id}"`) && src.includes(`id="${id}"`), `Falta el Field/control ${id}.`);
  }
});
