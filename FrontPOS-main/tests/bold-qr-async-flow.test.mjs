// =============================================================================
// tests/bold-qr-async-flow.test.mjs
//
// Guardianes contractuales del flujo QR Bold/Bre-B asíncrono (migración
// 027). Cubre:
//
//   A. Botón primario del modal con copy EXACTO
//      "DEJAR EN ESPERA Y SEGUIR ATENDIENDO" (uppercase, sin typos).
//   B. Callback de encolado reutiliza `ventaTempId` + `monto` recibidos
//      en props (nunca regenera, nunca recalcula).
//   C. `confirmEnqueuedAndFreeCart` del hook `useNewSale.ts` libera
//      SÓLO el carrito activo y abre uno limpio sin tocar otros.
//   D. El POST /encolar en /sales/new/page.tsx se dispara ANTES de
//      liberar el carrito; sólo tras el 200 el padre llama a
//      `confirmEnqueuedAndFreeCart()`.
//   E. Bandeja global `useBoldQrTray` monta un listener de
//      `/caja-stream` autenticado por Bearer header, SIN token en
//      query, con reconexión + refresh vía `/pendientes`.
//   F. La aprobación muestra un `AlertDialog` shadcn verde grande, con
//      sonido `playNotificationSound('success')` disparado UNA sola
//      vez (dedupe por ventaTempId/saleId); el frontend NO llama
//      explícitamente a helpers de impresión (el backend/SaleService
//      imprime).
//   G. Estados ambiguous/unmatched/expired/error muestran copy
//      informativo + acciones seguras (dejar en espera / cancelar)
//      sin mencionar la ruta `confirmar-manual` retirada.
//   H. TTL del modal y helper = 15 min.
//
// Tests por LECTURA DE FUENTE: no montan React.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const modalPath = join(repoRoot, "src", "components", "shared", "ModalPagoBoldQR.tsx");
const upmPath = join(repoRoot, "src", "components", "shared", "UniversalPaymentModal.tsx");
const salesNewPagePath = join(repoRoot, "src", "app", "(app)", "sales", "new", "page.tsx");
const useNewSalePath = join(repoRoot, "src", "app", "(app)", "sales", "new", "hooks", "useNewSale.ts");
const useBoldQrTrayPath = join(repoRoot, "src", "app", "(app)", "sales", "new", "hooks", "useBoldQrTray.ts");
const trayPopoverPath = join(repoRoot, "src", "app", "(app)", "sales", "new", "components", "BoldQrTrayPopover.tsx");
const helperPath = join(repoRoot, "src", "lib", "bold-qr-helpers.mjs");

async function readSrc(path) {
    return readFile(path, "utf8");
}

async function readWithoutComments(path) {
    const raw = await readFile(path, "utf8");
    return raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// A. Botón primario del modal: copy EXACTO
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR: botón primario con copy EXACTO 'DEJAR EN ESPERA Y SEGUIR ATENDIENDO'", async () => {
    const src = await readSrc(modalPath);
    // Debe estar presente como literal uppercase (no 'dejar en espera', no 'y seguir').
    assert.ok(
        src.includes("DEJAR EN ESPERA Y SEGUIR ATENDIENDO"),
        "El copy EXACTO 'DEJAR EN ESPERA Y SEGUIR ATENDIENDO' (uppercase) debe aparecer en el bundle.",
    );
    // La versión incompleta "Dejar en espera y seguir" (sin "Atendiendo")
    // no debe sobrevivir en el runtime. El negative lookahead es
    // case-insensitive para tolerar aria-label en minúsculas.
    const runtime = await readWithoutComments(modalPath);
    assert.ok(
        !/Dejar en espera y seguir(?!\s+[Aa]tendiendo)/.test(runtime),
        "No debe quedar la versión incompleta 'Dejar en espera y seguir' sin 'atendiendo' en el runtime.",
    );
});

test("ModalPagoBoldQR: label 'Confirmar manual' retirado por completo del bundle del cajero", async () => {
    const src = await readSrc(modalPath);
    assert.ok(!src.includes("Confirmar manual"), "'Confirmar manual' no debe aparecer en NINGUNA parte del archivo.");
});

// ---------------------------------------------------------------------------
// B. Callback onEnqueueAndClose reutiliza ventaTempId+monto
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR: onEnqueueAndClose tipa (ventaTempId: string, monto: number)", async () => {
    const src = await readSrc(modalPath);
    assert.match(
        src,
        /onEnqueueAndClose\?\s*:\s*\(ventaTempId:\s*string,\s*monto:\s*number\)\s*=>\s*Promise<void>\s*\|\s*void/,
        "La prop debe tipar explícitamente ventaTempId + monto.",
    );
});

test("ModalPagoBoldQR: handleEnqueueAndClose pasa (ventaTempId, Math.round(monto)) exactos de props", async () => {
    const src = await readSrc(modalPath);
    assert.match(
        src,
        /onEnqueueAndClose\(\s*ventaTempId\s*,\s*Math\.round\(monto\)\s*\)/,
        "El handler NUNCA debe regenerar ventaTempId ni recalcular monto.",
    );
    // Guard duro: no debe existir regeneración via Date.now()+random en el
    // callback del modal (el padre tampoco lo hace, ver test E/F).
    const handlerBlock = src.slice(src.indexOf("const handleEnqueueAndClose"));
    const handlerBody = handlerBlock.slice(0, handlerBlock.indexOf("}, ["));
    assert.ok(
        !/Date\.now\(\)/.test(handlerBody),
        "El modal NO debe regenerar un ventaTempId con Date.now() en handleEnqueueAndClose.",
    );
    assert.ok(
        !/randomUUID/.test(handlerBody),
        "El modal NO debe generar UUIDs nuevos en handleEnqueueAndClose; usa los props.",
    );
});

test("UniversalPaymentModal: onBoldQrEnqueueRequested firma (ventaTempId, monto)", async () => {
    const src = await readSrc(upmPath);
    assert.match(
        src,
        /onBoldQrEnqueueRequested\?\s*:\s*\(ventaTempId:\s*string,\s*monto:\s*number\)\s*=>\s*Promise<void>/,
        "La prop del UPM debe propagar la firma canónica (ventaTempId, monto).",
    );
    // El modal hijo recibe el callback TAL CUAL (sin envolverlo), salvo en
    // la reapertura desde la bandeja, donde no se reencola.
    assert.match(
        src,
        /onEnqueueAndClose=\{isBoldQrReopen \? undefined : onBoldQrEnqueueRequested\}/,
        "UPM debe pasar directamente el callback del padre al modal hijo.",
    );
});

test("sales/new/page.tsx: handleBoldQrEnqueueRequested recibe (ventaTempId, monto) y NO regenera ids", async () => {
    const src = await readSrc(salesNewPagePath);
    assert.match(
        src,
        /handleBoldQrEnqueueRequested\s*=\s*useCallback\(\s*async\s*\(ventaTempId:\s*string,\s*monto:\s*number\)/,
        "El callback del padre debe recibir (ventaTempId, monto).",
    );
    // Captura el bloque del callback y asegura que NO contenga regeneración.
    const start = src.indexOf("handleBoldQrEnqueueRequested = useCallback");
    const end = src.indexOf("}, [", start);
    assert.ok(end > start, "No se encontró el cierre del useCallback de handleBoldQrEnqueueRequested.");
    const body = src.slice(start, end);
    assert.ok(
        !/vt_\$\{Date\.now\(\)\}/.test(body),
        "El padre NO debe fabricar 'vt_${Date.now()}...' para el QR encolado.",
    );
    assert.ok(
        !/Math\.random\(\)\.toString\(36\)\.slice\(2,/.test(body),
        "El padre NO debe fabricar un identificador aleatorio en el callback de encolado.",
    );
});

// ---------------------------------------------------------------------------
// C. Cart isolation: confirmEnqueuedAndFreeCart sólo toca el activo
// ---------------------------------------------------------------------------

test("useNewSale.confirmEnqueuedAndFreeCart: libera el carrito activo y preserva otros", async () => {
    const src = await readSrc(useNewSalePath);
    const idx = src.indexOf("const confirmEnqueuedAndFreeCart");
    assert.ok(idx > 0, "El helper confirmEnqueuedAndFreeCart debe existir en useNewSale.ts.");
    // Debe filtrar `otherKeys = cartKeys.filter((k) => k !== currentKey)`
    assert.match(
        src.slice(idx),
        /otherKeys\s*=\s*cartKeys\.filter\(\s*\(k\)\s*=>\s*k\s*!==\s*currentKey\s*\)/,
        "Debe filtrar explícitamente los demás carritos.",
    );
    // Debe exportar el helper al consumidor
    assert.match(
        src,
        /confirmEnqueuedAndFreeCart,/,
        "El helper debe exportarse en el return del hook useNewSale.",
    );
    // El audit log debe anotar la acción
    assert.match(
        src.slice(idx),
        /registerAuditLog\(['"]CART_CLEAR['"]/,
        "La acción debe quedar auditada con CART_CLEAR.",
    );
});

// ---------------------------------------------------------------------------
// D. POST /encolar antes de liberar el carrito
// ---------------------------------------------------------------------------

test("sales/new/page.tsx: espera 200 de POST /encolar ANTES de liberar el carrito", async () => {
    const src = await readSrc(salesNewPagePath);
    const start = src.indexOf("handleBoldQrEnqueueRequested = useCallback");
    const end = src.indexOf("}, [", start);
    const body = src.slice(start, end);
    const postIdx = body.indexOf("apiFetch('/pos/pagos-qr/encolar'");
    const freeIdx = body.indexOf("confirmEnqueuedAndFreeCart()");
    assert.ok(postIdx > 0, "El callback debe llamar apiFetch('/pos/pagos-qr/encolar').");
    assert.ok(freeIdx > 0, "El callback debe invocar confirmEnqueuedAndFreeCart().");
    assert.ok(
        freeIdx > postIdx,
        "El `confirmEnqueuedAndFreeCart()` debe ocurrir DESPUÉS del POST /encolar (await previo).",
    );
    // El await DEBE estar presente (si fuera fire-and-forget, el callback
    // liberaría el carrito antes de saber si el backend lo persistió).
    assert.match(
        body.slice(0, freeIdx),
        /await\s+apiFetch\(\s*['"]\/pos\/pagos-qr\/encolar['"]/,
        "El POST /encolar debe esperarse (await) antes de tocar el carrito.",
    );
});

// ---------------------------------------------------------------------------
// E. Bandeja global: /caja-stream con Bearer, reconexión y /pendientes
// ---------------------------------------------------------------------------

test("useBoldQrTray: monta SSE autenticado /caja-stream con Bearer header, SIN token en query", async () => {
    const src = await readSrc(useBoldQrTrayPath);
    const runtime = await readWithoutComments(useBoldQrTrayPath);
    // Debe usar fetch streaming + Authorization Bearer en header
    assert.match(src, /\/pos\/pagos-qr\/caja-stream\?caja_id=/);
    assert.match(src, /Authorization:\s*`Bearer \$\{token\}`/);
    assert.match(src, /Accept:\s*["']text\/event-stream["']/);
    // El token NUNCA en query
    assert.doesNotMatch(runtime, /caja-stream[^"'`\n]*token=/,
        "El token no puede viajar por query en /caja-stream.");
    // EventSource está prohibido (no acepta headers)
    assert.doesNotMatch(runtime, /new\s+EventSource\(/,
        "No usar EventSource; Authorization exige fetch streaming.");
});

test("useBoldQrTray: reconexión con computeSSERetryDelay + reload desde /pendientes", async () => {
    const src = await readSrc(useBoldQrTrayPath);
    assert.match(src, /computeSSERetryDelay\(/,
        "El backoff de reconexión usa computeSSERetryDelay (consistente con GlobalSyncProvider).");
    assert.match(src, /\/pos\/pagos-qr\/pendientes\?caja_id=/,
        "El reload debe pegar al endpoint /pendientes de la bandeja.");
    assert.match(src, /parseSSEBlock\(/,
        "El parseo de frames SSE debe usar el helper puro.");
    // Al reconectar, repoblamos la bandeja desde la BD.
    assert.match(
        src,
        /retryAttempt\s*=\s*0;[\s\S]*?void\s+reload\(\)/,
        "Tras reconectar, debe refrescarse la bandeja vía /pendientes.",
    );
});

test("useBoldQrTray: APPROVED se dedupea por ventaTempId con sessionStorage + Set en ref", async () => {
    const src = await readSrc(useBoldQrTrayPath);
    assert.match(src, /notifiedRef\s*=\s*useRef<Set<string>>/,
        "Debe mantener un Set<string> por sesión para dedupear APPROVED.");
    assert.match(src, /markSessionNotified/,
        "Debe combinar con sessionStorage para resistir reloads.");
    // Y debe garantizar que la callback onApprovedOnce se dispare una sola vez.
    assert.match(src, /notifiedRef\.current\.has\(ventaTempId\)/,
        "El guard de dedupe debe consultar el Set antes de disparar.");
});

test("sales/new/page.tsx: la bandeja (BoldQrTrayPopover) se monta MIENTRAS la ruta esté activa", async () => {
    const src = await readSrc(salesNewPagePath);
    // El popover vive en el JSX principal, no detrás de un modal con isOpen=false.
    assert.match(src, /<BoldQrTrayPopover[\s\S]*?pendings=\{qrPendings\}/,
        "El popover de la bandeja debe estar en el árbol principal de /sales/new.");
    assert.match(src, /useBoldQrTray\(\{\s*cajaId,\s*onApprovedOnce:\s*handleQrTrayApproved/,
        "El hook se monta con cajaId + callback de aprobación.");
});

test("BoldQrTrayPopover: respeta FRONTEND_LAYOUT_RULES (flex-1 min-h-0 overflow-auto)", async () => {
    const src = await readSrc(trayPopoverPath);
    // El scroller interno debe usar la cadena elástica (ancla de FRONTEND_LAYOUT_RULES.md).
    assert.match(src, /flex-1\s+min-h-0\s+overflow-auto\s+overscroll-contain/,
        "El scroller del popover debe cumplir la regla de resorte: flex-1 min-h-0 overflow-auto overscroll-contain.");
    // Debe exponer acciones de reabrir + ocultar
    assert.match(src, /onReopen\(item\)/);
    assert.match(src, /onDismiss\(item\.ventaTempId\)/);
});

// ---------------------------------------------------------------------------
// F. AlertDialog aprobación + sonido una sola vez + sin impresión explícita
// ---------------------------------------------------------------------------

test("sales/new/page.tsx: usa AlertDialog shadcn para la aprobación (no un div ad-hoc)", async () => {
    const src = await readSrc(salesNewPagePath);
    assert.match(src, /from\s+['"]@\/components\/ui\/alert-dialog['"]/,
        "Debe importar AlertDialog de shadcn (@/components/ui/alert-dialog).");
    assert.match(src, /<AlertDialog[\s\S]*?open=\{!!qrApprovedAlert\}/,
        "El AlertDialog debe abrirse cuando qrApprovedAlert esté presente.");
    assert.match(src, /data-testid="bold-qr-approved-dialog"/,
        "El AlertDialogContent debe exponer un testid para pruebas semánticas futuras.");
    assert.match(src, /\$\{qrApprovedAlert\?\.amountCop/,
        "Debe mostrar el monto aprobado del evento.");
});

test("sales/new/page.tsx: APPROVED dedupe duro por ventaTempId (y saleId como fallback)", async () => {
    const src = await readSrc(salesNewPagePath);
    assert.match(src, /notifiedApprovedKeysRef\s*=\s*useRef<Set<string>>/,
        "Debe existir un Set defensivo en la página para dedupear APPROVED.");
    // La lógica de dedupe quedó extraída en `normalizeBoldQrKey` +
    // `notifyBoldQrApprovedOnce` (fuente única compartida por la ruta
    // modal y la de la bandeja). Verificamos que el helper exista y
    // que mantenga la prioridad ventaTempId → `sale:<saleId>` como
    // fallback explícito.
    assert.match(
        src,
        /const\s+normalizeBoldQrKey\s*=\s*useCallback/,
        "Debe existir el helper normalizeBoldQrKey para componer la clave de dedupe.",
    );
    assert.match(
        src,
        /if\s*\(\s*venta\s*\)\s*return\s+venta/,
        "normalizeBoldQrKey debe priorizar el ventaTempId trimado antes del fallback.",
    );
    assert.match(
        src,
        /return\s+`sale:\$\{info\.saleId\}`/,
        "normalizeBoldQrKey debe producir `sale:<saleId>` cuando no hay ventaTempId.",
    );
    assert.match(
        src,
        /const\s+notifyBoldQrApprovedOnce\s*=\s*useCallback/,
        "Debe existir el helper notifyBoldQrApprovedOnce (fuente única de dedupe).",
    );
    assert.match(src, /notifiedApprovedKeysRef\.current\.has\(key\)/,
        "El guard debe consultar la clave antes de pintar el AlertDialog y sonar.");
    assert.match(src, /playNotificationSound\(\s*['"]success['"]/,
        "El sonido se dispara una vez tras pasar el guard.");
});

test("sales/new/page.tsx: NO imprime explícitamente al recibir APPROVED (backend SaleService imprime)", async () => {
    const src = await readSrc(salesNewPagePath);
    // Buscamos la función handleQrTrayApproved y validamos que no llame
    // a helpers de impresión del thermal-ticket.
    const start = src.indexOf("handleQrTrayApproved = useCallback");
    const end = src.indexOf("}, [", start);
    const body = src.slice(start, end);
    for (const forbidden of [
        /printThermalTicket/,
        /printThermalTicketDirect/,
        /saleToTicket/,
        /thermal-ticket/,
    ]) {
        assert.ok(
            !forbidden.test(body),
            `handleQrTrayApproved NO debe llamar impresión explícita (${forbidden}); el backend materializa+imprime.`,
        );
    }
});

// ---------------------------------------------------------------------------
// G. Estados ambiguous/unmatched/expired/error visibles + acciones seguras
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR: estados AMBIGUOUS/UNMATCHED/EXPIRED/ERROR pintan Alert con copy sin 'Confirmar manual'", async () => {
    const src = await readSrc(modalPath);
    assert.match(src, /phase\.kind === "AMBIGUOUS"[\s\S]*?<Alert/,
        "El estado AMBIGUOUS debe pintar un Alert.");
    assert.match(src, /phase\.kind === "UNMATCHED"[\s\S]*?<Alert/,
        "El estado UNMATCHED debe pintar un Alert.");
    assert.match(src, /phase\.kind === "EXPIRED"[\s\S]*?<Alert/,
        "El estado EXPIRED debe pintar un Alert.");
    assert.match(src, /phase\.kind === "ERROR"[\s\S]*?<Alert/,
        "El estado ERROR debe pintar un Alert.");
    // Las acciones del footer (Cancelar + Dejar en espera) son siempre visibles.
    // Verificamos que ninguno de los Alert descriptions mencione "Confirmar manual".
    assert.ok(!src.includes("Confirmar manual"),
        "Ningún Alert debe pedir 'Confirmar manual'.");
    // Expired debe mencionar 15 minutos (y no 5)
    assert.match(src, /15 minutos sin confirmación/,
        "El copy de EXPIRED debe mencionar 15 minutos.");
});

// ---------------------------------------------------------------------------
// H. TTL del modal y helper = 15 min
// ---------------------------------------------------------------------------

test("Helper BOLD_QR_INTENT_TTL_MS = 15 * 60 * 1000", async () => {
    const src = await readSrc(helperPath);
    assert.match(src, /BOLD_QR_INTENT_TTL_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000/,
        "El helper debe fijar TTL a 15 min para empatar con el backend asíncrono.");
});

test("ModalPagoBoldQR: estado inicial del contador = 900 s (15 min)", async () => {
    const src = await readSrc(modalPath);
    assert.match(src, /useState<number>\(900\)/,
        "El estado inicial del contador debe inicializarse a 900 segundos (15 min).");
});



test("sales/new/page.tsx: la bandeja QR vive inline en la barra visible, no flotante", async () => {
    const src = await readSrc(salesNewPagePath);
    const toolbarAnchor = src.indexOf('/* Bandeja QR inline: debe vivir en esta barra visible');
    const catalogAnchor = src.indexOf('/* CANTIDAD DE PRODUCTOS EN MEMORIA / CACHÉ */');
    assert.ok(toolbarAnchor >= 0, "Debe existir el ancla de la bandeja QR inline.");
    assert.ok(catalogAnchor > toolbarAnchor, "La bandeja debe estar junto a Catálogo/Sincro en la barra superior.");
    const toolbarSlice = src.slice(toolbarAnchor, catalogAnchor);
    assert.match(toolbarSlice, /<BoldQrTrayPopover[\s\S]*?pendings=\{qrPendings\}/,
        "BoldQrTrayPopover debe renderizarse dentro del toolbar visible.");
    assert.doesNotMatch(src, /pointer-events-none\s+fixed\s+right-3\s+top-3/,
        "No debe reaparecer el montaje fixed que queda cubierto por la cabecera global.");
});

test("BoldQrTrayPopover: botón compacto y siempre visible en la barra", async () => {
    const src = await readSrc(trayPopoverPath);
    assert.match(src, /className="relative h-8 shrink-0[^\"]*"/,
        "El trigger debe medir h-8 y no encogerse dentro del toolbar.");
    assert.match(src, /QR en espera/,
        "El trigger debe conservar el texto visible QR en espera.");
});
