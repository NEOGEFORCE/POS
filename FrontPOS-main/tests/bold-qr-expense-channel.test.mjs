// =============================================================================
// tests/bold-qr-expense-channel.test.mjs
//
// Guardianes estáticos del contrato "Bold QR como canal propio" en el
// frontend POS. Son lecturas de fuente (`node --test`) sin montar React,
// coherentes con el patrón de los demás tests Bold QR del repo.
//
// Reglas duras (ver informe research y POS_MEMORY.md):
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
//       `paymentSourceString` se etiqueta como `BOLD_QR` SIEMPRE que se
//       cobra Bold QR. El canal es EXCLUSIVO (ver R5b): el backend no
//       puede desglosar un egreso Bold QR mixto porque no existe la
//       columna física, así que el frontend obliga al pago completo
//       (como la pestaña Préstamo). No hay token mixto `BOLD_QR: $N`.
//
//   R5b. Al seleccionar la pestaña Bold QR, los demás canales
//       (cash/nequi/daviplata/fondo/coins) quedan en 0. Al abandonar la
//       pestaña Bold QR, `boldQrPaid` también se limpia. El aviso
//       "Bold QR se paga completo, no se combina" se muestra en el
//       panel de monto mientras Bold QR está activo.
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
//   R9. Ninguno de los nuevos puntos crea una columna física nueva ni
//       referencia una migración (restricción del sprint: no migrar).
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
 * Elimina comentarios de bloque /* ... *\/ y de línea // ... antes de
 * buscar identificadores runtime. Protege contra falsos positivos cuando
 * el contrato se documenta como ejemplo en el docstring.
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
    // El campo vive dentro del bloque `realCashFlow: { ... }`. Buscamos
    // la aparición exacta del nombre con el tipo opcional para no caer en
    // falsos positivos con `realCashFlow?.boldQr` leído en los componentes.
    assert.match(
        src,
        /boldQr\?:\s*number/,
        "Falta `boldQr?: number` en el shape de realCashFlow de DashboardData.",
    );
});

// ---------------------------------------------------------------------------
// R2. CashFlowWidget: canal Bold QR paralelo a Nequi/Daviplata
// ---------------------------------------------------------------------------

test("CashFlowWidget incluye BOLD_QR como canal propio en `methods`", () => {
    const src = read(CASHFLOW_WIDGET);
    const runtime = stripComments(src);
    assert.match(
        runtime,
        /\bQrCode\b/,
        "CashFlowWidget debe importar QrCode de lucide-react para el canal Bold QR.",
    );
    // Buscamos la tupla exacta key: 'BOLD_QR' + label: 'Bold QR' en un mismo bloque.
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
    // Buscamos el bloque `todayCashFlow?: { ... }` y verificamos las 4 claves.
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

test("DashboardKPIs importa QrCode y lee data.realCashFlow?.boldQr", () => {
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
    // La etiqueta visible en la pastilla.
    assert.ok(
        src.includes("BOLD QR"),
        "DashboardKPIs debe mostrar el texto 'BOLD QR' en la pastilla del canal.",
    );
});

test("DashboardKPIs: fallback de TOTAL GENERAL incluye `realCashFlow?.boldQr`", () => {
    const src = read(DASHBOARD_KPIS);
    // El cálculo del fallback cuando el backend no entrega `totalLiquidity`
    // debe sumar los tres canales digitales: nequi, daviplata Y boldQr.
    // Buscamos la expresión completa dentro del bloque TOTAL GENERAL.
    const match = src.match(/data\.totalLiquidity\s*\|\|\s*\(([\s\S]{0,400}?)\)\)/);
    assert.ok(match, "Debe existir el fallback `data.totalLiquidity || (...)` en DashboardKPIs.");
    const expr = match[1];
    assert.match(
        expr,
        /realCashFlow\?\.boldQr/,
        "El fallback de TOTAL GENERAL debe sumar `realCashFlow?.boldQr` (Bold QR también es liquidez digital).",
    );
});

// ---------------------------------------------------------------------------
// R4. DashboardCharts: color BOLD_QR en PAYMENT_COLORS
// ---------------------------------------------------------------------------

test("DashboardCharts.PAYMENT_COLORS mapea 'BOLD_QR' a un color hex", () => {
    const src = read(DASHBOARD_CHARTS);
    const runtime = stripComments(src);
    // La clave debe aparecer dentro del objeto PAYMENT_COLORS con un
    // literal hex (#rrggbb). Toleramos cualquier color, pero exigimos la
    // sintaxis del map.
    assert.match(
        runtime,
        /['"]BOLD_QR['"]\s*:\s*['"]#[0-9a-fA-F]{3,8}['"]/,
        "PAYMENT_COLORS debe tener la entrada 'BOLD_QR' con un color hex.",
    );
});

// ---------------------------------------------------------------------------
// R5. ExpensePaymentModal: canal BOLD_QR + payload.boldQr
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
    // Estado del canal.
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
    // Pestaña del rail con id BOLD_QR y label 'Bold QR'.
    assert.match(
        runtime,
        /id:\s*['"]BOLD_QR['"][\s\S]{0,160}label:\s*['"]Bold QR['"]/,
        "El rail de métodos debe exponer `{ id: 'BOLD_QR', label: 'Bold QR', icon: <QrCode .../> }`.",
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
    // La función se llama en dos puntos (préstamo y pago normal). Ambos
    // deben incluir el campo `boldQr`.
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

test("ExpensePaymentModal.processPayment NO compone token mixto `BOLD_QR: $N`", () => {
    const src = read(EXPENSE_PAYMENT_MODAL);
    const runtime = stripComments(src);
    // Guardian de exclusividad: nunca debe haber `parts.push(\`BOLD_QR: $...\`)`
    // en el string compuesto, porque el backend no desglosa Bold QR en
    // egresos mixtos (sin columna `bold_qr_amount`). Bold QR siempre
    // viaja solo en `paymentSourceString === 'BOLD_QR'`.
    assert.doesNotMatch(
        runtime,
        /parts\.push\(`BOLD_QR:/,
        "El string del paymentSource NO debe incluir el token mixto `BOLD_QR: $...`.",
    );
    // Cuando el canal es exclusivo, `paymentSourceString` debe ser EXACTAMENTE 'BOLD_QR'
    // para que el parser del backend lo reconozca sin partir el string.
    assert.match(
        src,
        /paymentSourceString:\s*['"]BOLD_QR['"]/,
        "La rama Bold QR debe enviar `paymentSourceString: 'BOLD_QR'` canónico.",
    );
});

test("ExpensePaymentModal: al seleccionar Bold QR se limpian los demás canales", () => {
    const src = read(EXPENSE_PAYMENT_MODAL);
    // La rama `tab.id === 'BOLD_QR'` del onClick debe limpiar cash,
    // nequi, daviplata, fondo y coins. Buscamos la secuencia completa
    // dentro de un bloque flexible para no romper si cambia el orden.
    const match = src.match(/tab\.id\s*===\s*['"]BOLD_QR['"][\s\S]{0,800}?\}/);
    assert.ok(match, "Debe existir una rama `tab.id === 'BOLD_QR'` en el onClick de pestaña.");
    const block = match[0];
    for (const setter of ["setCashPaid(0)", "setNequiPaid(0)", "setDaviplataPaid(0)", "setFondoPaid(0)", "setCoinsPaid(0)"]) {
        assert.ok(
            block.includes(setter),
            `La rama Bold QR debe llamar ${setter} (exclusividad del canal).`,
        );
    }
});

test("ExpensePaymentModal: al abandonar Bold QR se limpia `boldQrPaid`", () => {
    const src = read(EXPENSE_PAYMENT_MODAL);
    // La rama `else` del onClick (ni loan ni BOLD_QR) debe limpiar
    // `boldQrPaid` para evitar enviar un mixto que el backend no sabe
    // desglosar.
    assert.match(
        src,
        /else\s*\{[\s\S]{0,400}setBoldQrPaid\(0\)/,
        "La rama por defecto del onClick debe llamar `setBoldQrPaid(0)` cuando se abandona Bold QR.",
    );
});

test("ExpensePaymentModal: muestra el aviso 'Bold QR se paga completo, no se combina'", () => {
    const src = read(EXPENSE_PAYMENT_MODAL);
    assert.ok(
        src.includes("Bold QR se paga completo, no se combina"),
        "El modal debe mostrar el aviso corto cuando la pestaña Bold QR está activa.",
    );
});

// ---------------------------------------------------------------------------
// R6/R7. Propagación al backend: ExpenseFormModal + expenses/page.tsx
// ---------------------------------------------------------------------------

test("ExpenseFormModal propaga `data.boldQr` como `boldQrAmount` en el payload de onSave", () => {
    const src = read(EXPENSE_FORM_MODAL);
    const runtime = stripComments(src);
    // La prop del modal multi-pago recibe el initial.
    assert.match(
        runtime,
        /initialBoldQr=\{Number\(localExpense\.boldQrAmount\)\s*\|\|\s*0\}/,
        "ExpenseFormModal debe inicializar `initialBoldQr` desde `localExpense.boldQrAmount`.",
    );
    // El payload que viaja a onSave incluye `boldQrAmount: data.boldQr`.
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

test("PendingDebtsModal expone Bold QR como opción de abono", () => {
    const src = read(PENDING_DEBTS_MODAL);
    const runtime = stripComments(src);
    assert.match(
        runtime,
        /\bQrCode\b/,
        "PendingDebtsModal debe importar QrCode de lucide-react para el botón Bold QR.",
    );
    assert.match(
        runtime,
        /id:\s*['"]BOLD_QR['"][\s\S]{0,120}label:\s*['"]Bold QR['"]/,
        "El array de métodos de abono debe exponer `{ id: 'BOLD_QR', label: 'Bold QR', ... }`.",
    );
});

// ---------------------------------------------------------------------------
// R9. Sin referencias a migración desde el frontend
// ---------------------------------------------------------------------------

test("Ningún archivo tocado por este sprint referencia migración de esquema", () => {
    // El sprint corre con la restricción explícita del dueño:
    // "no aplicar migraciones". Los tests estáticos deben defender esa
    // promesa: no debe aparecer la palabra `MIGRATION` o `migration`
    // asociada a BOLD_QR en el bundle (los helpers de migraciones viven
    // en el backend). Si alguien introduce lógica basada en el flag de
    // una migración, este guardian salta y pide revisión.
    for (const path of [
        CASHFLOW_WIDGET,
        DASHBOARD_KPIS,
        DASHBOARD_CHARTS,
        EXPENSE_PAYMENT_MODAL,
        EXPENSE_FORM_MODAL,
    ]) {
        const runtime = stripComments(read(path));
        assert.ok(
            !/MIGRATION_|migrate\(\)|runMigration\(/.test(runtime),
            `El archivo ${path} no debe depender de migraciones de esquema para exponer Bold QR.`,
        );
    }
});


test("R10 'Venta Real del Cierre' muestra Bold QR del turno", () => {
    const src = readFileSync(
        new URL("../src/app/(app)/dashboard/components/DashboardKPIs.tsx", import.meta.url),
        "utf8",
    );
    assert.match(src, /shiftSalesByMethod\?\.BOLD_QR/,
        "la tarjeta Venta Real del Cierre debe leer shiftSalesByMethod.BOLD_QR");
});
