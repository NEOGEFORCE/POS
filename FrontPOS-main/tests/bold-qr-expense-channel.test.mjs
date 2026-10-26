// =============================================================================
// tests/bold-qr-expense-channel.test.mjs
//
// Guardianes estáticos del contrato "Bold QR como canal propio" en el
// frontend POS. Son lecturas de fuente (`node --test`) sin montar React,
// coherentes con el patrón de los demás tests Bold QR del repo.
//
// Reglas duras (ver informe research, migración 028 y POS_MEMORY.md):
//
//   R1. Dashboard — `DashboardData.realCashFlow` admite el campo opcional
//       `boldQr?: number`. El contrato empata con el saldo propuesto por
//       el backend:
//         boldQr = globalSalesByMethod["BOLD_QR"]
//                + globalCollectedByMethod["BOLD_QR"]
//                - globalPaidByMethod["BOLD_QR"]
//
//   R2. `CashFlowWidget` lista Bold QR como canal paralelo a Nequi y
//       Daviplata (lee `todayCashFlow.income["BOLD_QR"]` y
//       `.expense["BOLD_QR"]`).
//
//   R3. `DashboardKPIs` dibuja una tercera pastilla en el bloque
//       "BILLETERAS DIGITALES (TOTAL)" con el saldo Bold QR.
//
//   R4. `DashboardCharts` tiene una entrada `'BOLD_QR'` en
//       `PAYMENT_COLORS` para pintar el slice del donut cuando el backend
//       empiece a devolver la clave.
//
//   R5. `ExpensePaymentModal` expone un sexto canal `BOLD_QR` entre los
//       métodos de pago, su payload incluye `boldQr: number` y el
//       `paymentSourceString` admite el token mixto `BOLD_QR: $N`. El
//       canal es COMBINABLE (ver R5b): tras la migración 028 el backend
//       persiste `expenses.bold_qr_amount` y puede desglosarlo igual que
//       Nequi, Caja, Bóveda, Alcancía o Daviplata.
//
//   R5b. Al seleccionar la pestaña Bold QR, los demás canales se
//       preservan — se puede combinar. Al abandonar la pestaña Bold QR,
//       `boldQrPaid` NO se limpia: el cajero puede saltar entre pestañas
//       sin perder el monto Bold. Y NO existe el aviso "Bold se paga
//       completo, no se combina".
//
//   R6. `ExpenseFormModal` propaga `data.boldQr` del modal como campo
//       top-level `boldQrAmount` al handler de guardado.
//
//   R7. `expenses/page.tsx` envía `boldQrAmount` dentro del payload POST
//       a `/expenses/create` y `/expenses/create-linked`.
//
//   R8. `PendingDebtsModal` expone Bold QR como opción de abono (botón
//       con id `BOLD_QR`) para que las deudas se puedan saldar contra
//       el saldo del canal.
//
// La política UX la define el padre; estos tests sólo blindan los
// identificadores exactos del contrato.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const DASHBOARD_PAGE = join(
    repoRoot,
    "src",
    "app",
    "(app)",
    "dashboard",
    "page.tsx",
);
const CASHFLOW_WIDGET = join(
    repoRoot,
    "src",
    "app",
    "(app)",
    "dashboard",
    "components",
    "CashFlowWidget.tsx",
);
const DASHBOARD_KPIS = join(
    repoRoot,
    "src",
    "app",
    "(app)",
    "dashboard",
    "components",
    "DashboardKPIs.tsx",
);
const DASHBOARD_CHARTS = join(
    repoRoot,
    "src",
    "app",
    "(app)",
    "dashboard",
    "components",
    "DashboardCharts.tsx",
);
const PENDING_DEBTS_MODAL = join(
    repoRoot,
    "src",
    "app",
    "(app)",
    "dashboard",
    "components",
    "PendingDebtsModal.tsx",
);
const EXPENSE_PAYMENT_MODAL = join(
    repoRoot,
    "src",
    "app",
    "(app)",
    "expenses",
    "components",
    "ExpensePaymentModal.tsx",
);
const EXPENSE_FORM_MODAL = join(
    repoRoot,
    "src",
    "app",
    "(app)",
    "expenses",
    "components",
    "ExpenseFormModal.tsx",
);
const EXPENSES_PAGE = join(
    repoRoot,
    "src",
    "app",
    "(app)",
    "expenses",
    "page.tsx",
);

function read(path) {
    return readFileSync(path, "utf8");
}

/**
 * Elimina comentarios de bloque y de línea antes de buscar identificadores
 * runtime. Protege contra falsos positivos cuando el contrato se documenta
 * como ejemplo en el docstring.
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// R1. Dashboard: realCashFlow.boldQr?: number
// ---------------------------------------------------------------------------

test("DashboardData.realCashFlow admite el campo opcional `boldQr?: number`", () => {
    const src = read(DASHBOARD_PAGE);
    assert.match(
        src,
        /boldQr\?:\s*number/,
        "Falta `boldQr?: number` en el shape de realCashFlow de DashboardData.",
    );
});

// ---------------------------------------------------------------------------
// R2. CashFlowWidget: canal Bold QR paralelo a Nequi/Daviplata
// ---------------------------------------------------------------------------

test.skip("(retirado 2026-10-26: Bold reemplazado por Daviplata) CashFlowWidget incluye BOLD_QR", () => {
    const src = read(CASHFLOW_WIDGET);
    const runtime = stripComments(src);
    assert.match(
        runtime,
        /\bQrCode\b/,
        "CashFlowWidget debe importar QrCode de lucide-react para el canal Bold QR.",
    );
    assert.match(
        runtime,
        /key:\s*['"]BOLD_QR['"][\s\S]{0,80}label:\s*['"]Bold QR['"]/,
        "El array `methods` debe exponer `{ key: 'BOLD_QR', label: 'Bold QR', ... }`.",
    );
});

// ---------------------------------------------------------------------------
// R2b. Dashboard contrata `todayCashFlowDetail` (shape rico) y el widget
//      lo consume en lugar de `todayCashFlow` (saldos por canal).
// ---------------------------------------------------------------------------

test("DashboardData declara `todayCashFlowDetail?: {income, expense, balance}`", () => {
    const src = read(DASHBOARD_PAGE);
    assert.match(
        src,
        /todayCashFlowDetail\?:\s*\{[\s\S]{0,200}income:\s*Record<string,\s*number>;[\s\S]{0,200}expense:\s*Record<string,\s*number>;[\s\S]{0,100}balance:\s*number;?\s*\}/,
        "El shape de `todayCashFlowDetail` debe exponer income + expense + balance.",
    );
});

test("DashboardData.todayCashFlow refleja el shape real {cash, nequi, daviplata, boldQr}", () => {
    const src = read(DASHBOARD_PAGE);
    const match = src.match(/todayCashFlow\?:\s*\{([\s\S]{0,400}?)\};/);
    assert.ok(match, "El shape de `todayCashFlow` debe estar declarado.");
    const body = match[1];
    for (const key of ["cash", "nequi", "daviplata", "boldQr"]) {
        assert.match(
            body,
            new RegExp(`\\b${key}:\\s*number`),
            `El shape de todayCashFlow debe tener \`${key}: number\`.`,
        );
    }
});

test("Dashboard pasa `data.todayCashFlowDetail` a <CashFlowWidget />", () => {
    const src = read(DASHBOARD_PAGE);
    assert.match(
        src,
        /<CashFlowWidget\s+data=\{data\.todayCashFlowDetail\}/,
        "El dashboard debe pasar `data.todayCashFlowDetail` (no `data.todayCashFlow`) al widget.",
    );
});

// ---------------------------------------------------------------------------
// R3. DashboardKPIs: pastilla Bold QR en BILLETERAS DIGITALES
// ---------------------------------------------------------------------------

test.skip("(retirado 2026-10-26) DashboardKPIs pastilla Bold QR", () => {
    const src = read(DASHBOARD_KPIS);
    const runtime = stripComments(src);
    assert.match(
        runtime,
        /\bQrCode\b/,
        "DashboardKPIs debe importar QrCode de lucide-react para la pastilla Bold QR.",
    );
    assert.match(
        runtime,
        /data\.realCashFlow\?\.boldQr/,
        "La pastilla Bold QR debe leer data.realCashFlow?.boldQr (contrato realCashFlow).",
    );
    assert.ok(
        src.includes("BOLD QR"),
        "DashboardKPIs debe mostrar el texto 'BOLD QR' en la pastilla del canal.",
    );
});

test.skip("(retirado 2026-10-26) TOTAL GENERAL incluye boldQr", () => {
    const src = read(DASHBOARD_KPIS);
    const match = src.match(/data\.totalLiquidity\s*\|\|\s*\(([\s\S]{0,400}?)\)\)/);
    assert.ok(match, "Debe existir el fallback `data.totalLiquidity || (...)` en DashboardKPIs.");
    const expr = match[1];
    assert.match(
        expr,
        /realCashFlow\?\.boldQr/,
        "El fallback de TOTAL GENERAL debe sumar `realCashFlow?.boldQr`.",
    );
});

// ---------------------------------------------------------------------------
// R4. DashboardCharts: color BOLD_QR en PAYMENT_COLORS
// ---------------------------------------------------------------------------

test("DashboardCharts.PAYMENT_COLORS mapea 'BOLD_QR' a un color hex", () => {
    const src = read(DASHBOARD_CHARTS);
    const runtime = stripComments(src);
    assert.match(
        runtime,
        /['"]BOLD_QR['"]\s*:\s*['"]#[0-9a-fA-F]{3,8}['"]/,
        "PAYMENT_COLORS debe tener la entrada 'BOLD_QR' con un color hex.",
    );
});

// ---------------------------------------------------------------------------
// R5. ExpensePaymentModal: canal BOLD_QR + payload.boldQr (COMBINABLE)
// ---------------------------------------------------------------------------

test("ExpensePaymentModalPayload declara `boldQr: number`", () => {
    const src = read(EXPENSE_PAYMENT_MODAL);
    assert.match(
        src,
        /export interface ExpensePaymentModalPayload[\s\S]*?boldQr:\s*number/,
        "El payload del modal debe exponer `boldQr: number` (contrato con el padre).",
    );
});

test("ExpensePaymentModal mantiene estado dedicado `boldQrPaid` y pestaña `BOLD_QR`", () => {
    const src = read(EXPENSE_PAYMENT_MODAL);
    const runtime = stripComments(src);
    assert.match(
        runtime,
        /\bsetBoldQrPaid\b/,
        "El modal debe tener setter `setBoldQrPaid` para acumular el monto del canal Bold QR.",
    );
    assert.match(
        runtime,
        /\bboldQrPaid\b/,
        "El modal debe mantener la variable `boldQrPaid` como monto acumulado del canal.",
    );
    assert.match(
        runtime,
        /id:\s*['"]BOLD_QR['"][\s\S]{0,160}label:\s*['"]QR['"][\s\S]{0,60}logo:\s*['"]\/logos\/bold\.png['"]/,
        "El rail de métodos debe exponer `{ id: 'BOLD_QR', label: 'QR', logo: '/logos/bold.png' }` (sólo egresos viejos).",
    );
});

test("ExpensePaymentModal totalAlreadyPaid incluye `boldQrPaid` para que el restante baje", () => {
    const src = read(EXPENSE_PAYMENT_MODAL);
    const runtime = stripComments(src);
    assert.match(
        runtime,
        /totalAlreadyPaid\s*=\s*cashPaid\s*\+\s*nequiPaid\s*\+\s*daviplataPaid\s*\+\s*fondoPaid\s*\+\s*coinsPaid\s*\+\s*boldQrPaid/,
        "`totalAlreadyPaid` debe sumar `boldQrPaid` para que el remanente del egreso cuadre con los seis canales.",
    );
});

test("ExpensePaymentModal.processPayment envía `boldQr` en el objeto a onPay (ambas ramas)", () => {
    const src = read(EXPENSE_PAYMENT_MODAL);
    const onPayCalls = [...src.matchAll(/onPay\(\s*\{[\s\S]*?\}\s*\)/g)];
    assert.ok(onPayCalls.length >= 2, "Deben existir al menos 2 llamadas a onPay (préstamo + pago normal).");
    for (const call of onPayCalls) {
        assert.match(
            call[0],
            /\bboldQr\s*:/,
            "Cada llamada a onPay debe incluir el campo `boldQr`.",
        );
    }
});

test("ExpensePaymentModal.processPayment compone el token mixto `BOLD_QR: $N` cuando hay Bold combinado", () => {
    const src = read(EXPENSE_PAYMENT_MODAL);
    const runtime = stripComments(src);
    // Al ser combinable, el string compuesto debe incluir el token
    // `BOLD_QR: $...` entre los demás (`NEQUI: $...`, `CAJA: $...`, etc.).
    assert.match(
        runtime,
        /parts\.push\(`BOLD_QR:\s*\$\$\{finalBoldQr\}`\)/,
        "El string del paymentSource DEBE incluir el token mixto `BOLD_QR: $...` cuando hay monto Bold.",
    );
    // El fallback cuando sólo Bold QR tiene monto sigue siendo el canónico
    // 'BOLD_QR' sin tokens, para que el agregador legacy lo cuente limpio.
    assert.match(
        runtime,
        /finalPaymentSource\s*=\s*['"]BOLD_QR['"]/,
        "Cuando BOLD_QR es el único canal con monto, paymentSourceString debe ser 'BOLD_QR' canónico.",
    );
});

test("ExpensePaymentModal.processPayment suma `boldQrPaid` al cálculo del mixto", () => {
    const src = read(EXPENSE_PAYMENT_MODAL);
    const runtime = stripComments(src);
    // La variable finalBoldQr debe inicializarse con lo acumulado (no en 0)
    // para que combine con los demás canales.
    assert.match(
        runtime,
        /let\s+finalBoldQr\s*=\s*boldQrPaid/,
        "finalBoldQr debe inicializarse con el acumulado `boldQrPaid` (combinable).",
    );
    // La asignación del input digitado y del leftover debe contemplar la
    // pestaña BOLD_QR, igual que el resto de canales.
    assert.match(
        runtime,
        /activePaymentTab\s*===\s*['"]BOLD_QR['"][\s\S]{0,80}finalBoldQr\s*\+=\s*actualPay/,
        "Si la pestaña activa es BOLD_QR y el usuario digitó un monto, debe sumarse a finalBoldQr.",
    );
    assert.match(
        runtime,
        /activePaymentTab\s*===\s*['"]BOLD_QR['"][\s\S]{0,120}finalBoldQr\s*\+=\s*leftover/,
        "Si queda remanente con la pestaña BOLD_QR activa, debe asignarse a finalBoldQr.",
    );
    // El total allocated debe incluir boldQr.
    assert.match(
        runtime,
        /totalAllocated\s*=\s*finalCash\s*\+\s*finalNequi\s*\+\s*finalDaviplata\s*\+\s*finalFondo\s*\+\s*finalCoins\s*\+\s*finalBoldQr/,
        "totalAllocated debe sumar finalBoldQr al resto (combinable).",
    );
});

test("ExpensePaymentModal: al seleccionar Bold QR NO limpia los demás canales (combinable)", () => {
    const src = read(EXPENSE_PAYMENT_MODAL);
    // La rama del onClick de pestaña con tab.id === 'BOLD_QR' NO debe
    // existir como bloque que limpia los otros canales. Buscamos el
    // antipatrón específico que había antes: cuando entrabas a Bold QR
    // se limpiaban todos los demás setters.
    assert.doesNotMatch(
        src,
        /tab\.id\s*===\s*['"]BOLD_QR['"][\s\S]{0,400}setCashPaid\(0\)[\s\S]{0,200}setNequiPaid\(0\)/,
        "La rama Bold QR NO debe limpiar los demás canales — Bold QR es combinable.",
    );
});

test("ExpensePaymentModal: al abandonar Bold QR NO limpia `boldQrPaid` (combinable)", () => {
    const src = read(EXPENSE_PAYMENT_MODAL);
    // El antipatrón previo era: la rama por defecto del onClick llamaba
    // `setBoldQrPaid(0)` justo después de `setSelectedLoanId(null)`
    // cuando se abandonaba la pestaña Bold QR. Ahora Bold QR es
    // combinable; el monto se preserva al cambiar de pestaña. El
    // `setBoldQrPaid(0)` sigue existiendo en la inicialización del
    // modal (`useEffect` al abrir sin montos iniciales), eso es sano.
    assert.doesNotMatch(
        src,
        /setSelectedLoanId\(null\);\s*setBoldQrPaid\(0\)/,
        "La rama por defecto del onClick NO debe llamar `setBoldQrPaid(0)` tras `setSelectedLoanId(null)` — se preserva el combinado.",
    );
});

test("ExpensePaymentModal: NO muestra el aviso 'Bold se paga completo, no se combina'", () => {
    const src = read(EXPENSE_PAYMENT_MODAL);
    assert.ok(
        !src.includes("Bold se paga completo, no se combina"),
        "El aviso de exclusividad debe haberse eliminado — Bold ya es combinable.",
    );
});

test("ExpensePaymentModal: el chip de Bold en el resumen sigue mostrando el logo /logos/bold.png", () => {
    const src = read(EXPENSE_PAYMENT_MODAL);
    // El chip del resumen cuando boldQrPaid > 0 muestra `<img src="/logos/bold.png"/>`
    // dentro de un bloque condicional. Verificamos que el patrón sobreviva
    // al refactor combinable.
    assert.match(
        src,
        /boldQrPaid\s*>\s*0[\s\S]{0,400}\/logos\/bold\.png/,
        "El chip de Bold en el resumen debe seguir usando el logo /logos/bold.png.",
    );
});

// ---------------------------------------------------------------------------
// R6/R7. Propagación al backend: ExpenseFormModal + expenses/page.tsx
// ---------------------------------------------------------------------------

test("ExpenseFormModal propaga `data.boldQr` como `boldQrAmount` en el payload de onSave", () => {
    const src = read(EXPENSE_FORM_MODAL);
    const runtime = stripComments(src);
    assert.match(
        runtime,
        /initialBoldQr=\{Number\(localExpense\.boldQrAmount\)\s*\|\|\s*0\}/,
        "ExpenseFormModal debe inicializar `initialBoldQr` desde `localExpense.boldQrAmount`.",
    );
    assert.match(
        runtime,
        /boldQrAmount:\s*data\.boldQr/,
        "ExpenseFormModal debe mapear `data.boldQr` del modal a `boldQrAmount` en el payload de onSave.",
    );
});

test("expenses/page.tsx envía `boldQrAmount` dentro del payload POST a /expenses", () => {
    const src = read(EXPENSES_PAGE);
    const runtime = stripComments(src);
    assert.match(
        runtime,
        /boldQrAmount:\s*isPending\s*\?\s*0\s*:\s*\(data\.boldQrAmount\s*\|\|\s*0\)/,
        "El payload POST debe incluir `boldQrAmount` (0 en deuda, el monto real en pago inmediato).",
    );
});

// ---------------------------------------------------------------------------
// R8. Abonos a deudas con Bold QR
// ---------------------------------------------------------------------------

test.skip("(retirado 2026-10-26) PendingDebtsModal opción Bold", () => {
    const src = read(PENDING_DEBTS_MODAL);
    const runtime = stripComments(src);
    assert.match(
        runtime,
        /\/logos\/bold\.png/,
        "PendingDebtsModal debe usar el logo oficial de Bold en el botón.",
    );
    assert.match(
        runtime,
        /id:\s*['"]BOLD_QR['"][\s\S]{0,120}label:\s*['"]Bold['"]/,
        "El array de métodos de abono debe exponer `{ id: 'BOLD_QR', label: 'Bold', ... }`.",
    );
});

test("R10 'Venta Real del Cierre' muestra Bold QR del turno", () => {
    const src = readFileSync(
        new URL("../src/app/(app)/dashboard/components/DashboardKPIs.tsx", import.meta.url),
        "utf8",
    );
    assert.match(src, /shiftSalesByMethod\?\.BOLD_QR/,
        "la tarjeta Venta Real del Cierre debe leer shiftSalesByMethod.BOLD_QR");
});
