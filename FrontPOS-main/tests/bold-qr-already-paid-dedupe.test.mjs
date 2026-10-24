// =============================================================================
// tests/bold-qr-already-paid-dedupe.test.mjs
//
// Guardianes contractuales del parche de defensa anti-reapertura del QR Bold
// (bug 2026-10-23). El síntoma era:
//
//   1. Cajero cobra $100 por QR Bold → backend materializa venta y emite
//      APROBADO (saleId > 0). Pending desaparece de la bandeja.
//   2. Cajero abre el cobro de OTRA factura. UniversalPaymentModal
//      consumía el nonce `boldQrRequestId` pendiente (seguía > 0) y
//      reabría el QR del pending anterior con el MISMO ventaTempId.
//   3. `/pos/pagos-qr/iniciar` respondía 200 con `alreadyPaid=true`;
//      `/pos/pagos-qr/encolar` respondía 409 QR_INTENT_ALREADY_PAID.
//   4. El frontend ignoraba esos marcadores y re-abría el QR, dejando
//      otra intención en PENDIENTE para la factura equivocada.
//
// Invariantes fijadas por este archivo:
//
//   AP1. El UPM NO expone ya la prop `boldQrRequestId` (nonce persistente
//        retirado). Expone `boldQrReopenPayload` + `onBoldQrReopenConsumed`
//        como contrato de un solo uso.
//   AP2. El UPM no tiene fallback que llame `handleOpenBoldQr()` desde el
//        useEffect del reopen payload. El QR SÓLO se abre por el click
//        del botón "QR Bold" o por el consumo del payload de reapertura.
//   AP3. El UPM mantiene un `useRef` con el último payload consumido y
//        rechaza reconsumir el mismo. Al cerrar el UPM se limpia el ref
//        + `boldSessionIdRef` + `boldQrAmount`.
//   AP4. `handleOpenBoldQr` genera un uuid fresco cada vez, limpia los
//        refs antes de generarlo, y captura el `BOLD_QR_ALREADY_PAID_SENTINEL`
//        para abortar en silencio (sin toast de error).
//   AP5. `useBoldQrTray` expone `markPaid` + `isPaid`. El Set vive en
//        state y se persiste en sessionStorage con el prefijo canónico
//        `bold-qr-paid:`. Las pendings se filtran siempre.
//   AP6. `prepareBoldQrIntent` detecta `alreadyPaid=true` del `/iniciar`,
//        marca pagado en la bandeja, limpia el reopen payload, cierra el
//        UPM y lanza `BOLD_QR_ALREADY_PAID_SENTINEL`.
//   AP7. `handleBoldQrEnqueueRequested` captura el 409 QR_INTENT_ALREADY_PAID
//        y lo trata como finalizado (markPaid + confirmEnqueuedAndFreeCart
//        + cerrar UPM), nunca como error ruidoso.
//   AP8. `handleReopenPending` consulta `qrIsPaid` y si está pagado,
//        muestra toast "YA PAGADO" + dismiss, nunca abre el QR.
//   AP9. `handleBoldQrFinalized` llama `qrMarkPaidRef.current` para
//        persistir el pagado en el storage de la bandeja.
//   AP10. `ModalPagoBoldQR` detecta `alreadyPaid=true` del `/iniciar`
//         y transiciona a APPROVED sin countdown, disparando `onApproved`
//         inmediatamente (setTimeout 0) con el `saleId`/`amountCop`.
//   AP11. Los helpers puros `isAlreadyPaidResponse`/`isAlreadyPaidError`/
//         `markBoldQrPaidInStorage`/`isBoldQrPaidInStorage`/`listBoldQrPaidKeys`
//         siguen el contrato "nunca inventan": entradas inválidas → null/false/[].
//   AP12. Guard end-to-end: abrir el cobro de otra cuenta tras un QR
//         pagado NO reabre el QR viejo. Enforcado por composición de AP1+AP2+AP3.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    BOLD_QR_ALREADY_PAID_SENTINEL,
    BOLD_QR_ALREADY_PAID_ERROR_CODE,
    BOLD_QR_PAID_SESSION_PREFIX,
    extractAlreadyPaidErrorInfo,
    isAlreadyPaidError,
    isAlreadyPaidResponse,
    isBoldQrPaidInStorage,
    listBoldQrPaidKeys,
    markBoldQrPaidInStorage,
} from "../src/lib/bold-qr-helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const upmPath = join(repoRoot, "src", "components", "shared", "UniversalPaymentModal.tsx");
const modalPath = join(repoRoot, "src", "components", "shared", "ModalPagoBoldQR.tsx");
const salesNewPagePath = join(repoRoot, "src", "app", "(app)", "sales", "new", "page.tsx");
const trayHookPath = join(repoRoot, "src", "app", "(app)", "sales", "new", "hooks", "useBoldQrTray.ts");

const readSrc = (path) => readFile(path, "utf8");

/**
 * Captura el bloque de un useCallback por nombre, hasta el cierre `}, [`.
 */
function extractCallbackBody(src, name) {
    const idx = src.indexOf(`const ${name}`);
    assert.ok(idx > 0, `No se encontró declaración de ${name}.`);
    const end = src.indexOf("}, [", idx);
    assert.ok(end > idx, `No se encontró cierre del useCallback de ${name}.`);
    return src.slice(idx, end + 2);
}

// ---------------------------------------------------------------------------
// AP1 — UPM no expone boldQrRequestId (nonce persistente retirado)
// ---------------------------------------------------------------------------

test("AP1a: UniversalPaymentModal NO declara la prop `boldQrRequestId` en su interfaz", async () => {
    const src = await readSrc(upmPath);
    assert.ok(
        !/boldQrRequestId\?\s*:\s*number/.test(src),
        "El nonce persistente `boldQrRequestId` debe estar retirado por completo.",
    );
    assert.ok(
        !/lastConsumedBoldQrRequestIdRef/.test(src),
        "El ref anti-doble-consumo del nonce quedó retirado.",
    );
});

test("AP1b: UniversalPaymentModal expone `onBoldQrReopenConsumed` como prop opcional", async () => {
    const src = await readSrc(upmPath);
    assert.match(
        src,
        /onBoldQrReopenConsumed\?\s*:\s*\(\s*\)\s*=>\s*void/,
        "El UPM debe tipar `onBoldQrReopenConsumed?: () => void` para el contrato de un solo uso.",
    );
    assert.match(
        src,
        /onBoldQrReopenConsumed,/,
        "La prop debe destructurarse en la firma del componente.",
    );
});

test("AP1c: UniversalPaymentModal: boldQrReopenPayload tipa `| null` para habilitar limpieza explícita", async () => {
    const src = await readSrc(upmPath);
    assert.match(
        src,
        /boldQrReopenPayload\?\s*:\s*\{\s*readonly\s+ventaTempId:\s*string;\s*readonly\s+monto:\s*number\s*\}\s*\|\s*null/,
        "La prop debe aceptar `| null` para que el padre limpie explícitamente tras el consumo.",
    );
});

// ---------------------------------------------------------------------------
// AP2 — No hay fallback que abra el QR al abrir el modal de pago
// ---------------------------------------------------------------------------

test("AP2a: UniversalPaymentModal: el useEffect del reopen payload NO llama handleOpenBoldQr() como fallback", async () => {
    const src = await readSrc(upmPath);
    // Capturamos el useEffect que consume el reopen payload (identificado
    // por `lastConsumedReopenRef`).
    const idx = src.indexOf("lastConsumedReopenRef");
    assert.ok(idx > 0, "Debe existir el ref anti-replay `lastConsumedReopenRef`.");
    // El useEffect subsiguiente debe abrir el modal hijo con el payload
    // o retornar silenciosamente — nunca caer a `handleOpenBoldQr()`.
    const effectStart = src.indexOf("useEffect(() => {", idx);
    const effectEnd = src.indexOf("}, [isOpen, boldQrReopenPayload", effectStart);
    assert.ok(effectEnd > effectStart, "Debe existir el useEffect con deps [isOpen, boldQrReopenPayload, ...]");
    const effectBody = src.slice(effectStart, effectEnd);
    assert.ok(
        !/handleOpenBoldQr\(\)/.test(effectBody),
        "El useEffect del reopen payload NO debe llamar handleOpenBoldQr() como fallback. El QR sólo se abre por click explícito o por payload válido.",
    );
    assert.ok(
        !/canUseBoldQr/.test(effectBody),
        "El useEffect ya no depende de canUseBoldQr: sin payload no hace nada, con payload abre.",
    );
});

test("AP2b: UniversalPaymentModal: el useEffect del reopen payload dispara onBoldQrReopenConsumed", async () => {
    const src = await readSrc(upmPath);
    const idx = src.indexOf("lastConsumedReopenRef");
    assert.ok(idx > 0);
    const effectStart = src.indexOf("useEffect(() => {", idx);
    const effectEnd = src.indexOf("}, [isOpen, boldQrReopenPayload", effectStart);
    const effectBody = src.slice(effectStart, effectEnd);
    assert.match(
        effectBody,
        /onBoldQrReopenConsumed\(\s*\)/,
        "Tras consumir el payload el UPM debe llamar onBoldQrReopenConsumed() para que el padre limpie el estado.",
    );
});

// ---------------------------------------------------------------------------
// AP3 — Ref anti-replay + cleanup on close
// ---------------------------------------------------------------------------

test("AP3a: UniversalPaymentModal: lastConsumedReopenRef guarda `{ventaTempId, monto}` para rechazar reconsumo", async () => {
    const src = await readSrc(upmPath);
    assert.match(
        src,
        /lastConsumedReopenRef\s*=\s*useRef<\{\s*readonly\s+ventaTempId:\s*string;\s*readonly\s+monto:\s*number\s*\}\s*\|\s*null>/,
        "El ref debe tipar la última solicitud consumida para comparar en el próximo render.",
    );
});

test("AP3b: UniversalPaymentModal: useEffect `!isOpen` limpia el ref + boldSessionIdRef + boldQrAmount", async () => {
    const src = await readSrc(upmPath);
    // Buscamos el useEffect de limpieza: tiene dep [isOpen] y empieza con `if (isOpen) return;`
    const idx = src.indexOf("if (isOpen) return;\n    lastConsumedReopenRef.current = null");
    assert.ok(idx > 0, "Debe existir el useEffect de limpieza al cerrar que resetea `lastConsumedReopenRef`.");
    const block = src.slice(idx, idx + 500);
    for (const expected of [
        /lastConsumedReopenRef\.current\s*=\s*null/,
        /boldSessionIdRef\.current\s*=\s*""/,
        /boldApprovedPayloadRef\.current\s*=\s*null/,
        /setIsBoldQrOpen\(\s*false\s*\)/,
        /setBoldQrAmount\(\s*0\s*\)/,
    ]) {
        assert.match(block, expected, `El useEffect de cierre debe ejecutar ${expected}.`);
    }
});

// ---------------------------------------------------------------------------
// AP4 — handleOpenBoldQr genera uuid fresco y usa remainingDebt actual
// ---------------------------------------------------------------------------

test("AP4a: UniversalPaymentModal.handleOpenBoldQr: cada click limpia refs ANTES de generar uuid", async () => {
    const src = await readSrc(upmPath);
    const body = extractCallbackBody(src, "handleOpenBoldQr");
    const cleanupIdx = body.indexOf("boldApprovedPayloadRef.current = null");
    const uuidIdx = body.indexOf("crypto.randomUUID");
    assert.ok(cleanupIdx > 0, "El handler debe limpiar `boldApprovedPayloadRef`.");
    assert.ok(uuidIdx > cleanupIdx, "La limpieza debe ocurrir ANTES de generar el uuid.");
    assert.match(
        body,
        /boldSessionIdRef\.current\s*=\s*""/,
        "Debe limpiar boldSessionIdRef para no reutilizar el id de una sesión anterior.",
    );
    assert.match(
        body,
        /setBoldQrAmount\(0\)/,
        "Debe resetear boldQrAmount a 0 antes de medir el remainingDebt actual.",
    );
    assert.match(
        body,
        /setIsBoldQrOpen\(false\)/,
        "Debe cerrar un sub-modal residual antes de generar el nuevo uuid.",
    );
});

test("AP4b: handleOpenBoldQr: amount = Math.round(remainingDebt) actual", async () => {
    const src = await readSrc(upmPath);
    const body = extractCallbackBody(src, "handleOpenBoldQr");
    assert.match(
        body,
        /const\s+amount\s*=\s*Math\.round\(remainingDebt\)/,
        "El monto debe venir del `remainingDebt` actual, no de un prop viejo.",
    );
});

test("AP4c: handleOpenBoldQr: captura BOLD_QR_ALREADY_PAID_SENTINEL y aborta silenciosamente", async () => {
    const src = await readSrc(upmPath);
    const body = extractCallbackBody(src, "handleOpenBoldQr");
    assert.match(
        body,
        /BOLD_QR_ALREADY_PAID_SENTINEL/,
        "El catch debe reconocer el sentinel para abortar sin pintar toast de error.",
    );
    // El import también debe traer el sentinel.
    assert.match(
        src,
        /BOLD_QR_ALREADY_PAID_SENTINEL,\s*BOLD_QR_METHOD_LABEL/,
        "El UPM debe importar el sentinel desde el helper puro.",
    );
});

// ---------------------------------------------------------------------------
// AP5 — useBoldQrTray expone markPaid/isPaid con persistencia en sessionStorage
// ---------------------------------------------------------------------------

test("AP5a: useBoldQrTray: expone markPaid + isPaid en BoldQrTrayState", async () => {
    const src = await readSrc(trayHookPath);
    assert.match(
        src,
        /readonly\s+markPaid:\s*\(info:\s*\{\s*readonly\s+ventaTempId:\s*string;\s*readonly\s+saleId\?\s*:\s*number;\s*readonly\s+amountCop\?\s*:\s*number;?\s*\}\)\s*=>\s*void/,
        "La interfaz debe exponer markPaid con shape canónico.",
    );
    assert.match(
        src,
        /readonly\s+isPaid:\s*\(ventaTempId:\s*string\)\s*=>\s*boolean/,
        "La interfaz debe exponer isPaid.",
    );
});

test("AP5b: useBoldQrTray: paidKeys repuebla desde sessionStorage al montar", async () => {
    const src = await readSrc(trayHookPath);
    assert.match(
        src,
        /useState<Set<string>>\(\(\)\s*=>\s*\{[\s\S]*?listBoldQrPaidKeys\(window\.sessionStorage\)/,
        "El state paidKeys debe inicializarse leyendo sessionStorage con listBoldQrPaidKeys.",
    );
});

test("AP5c: useBoldQrTray: reload filtra pendings por paidKeys y refresca desde storage", async () => {
    const src = await readSrc(trayHookPath);
    const idx = src.indexOf("const reload = useCallback");
    const end = src.indexOf("}, [", idx);
    const body = src.slice(idx, end);
    assert.match(
        body,
        /normalized\.filter\(\(p\)\s*=>\s*!paidRef\.has\(p\.ventaTempId\)\)/,
        "Reload debe filtrar los pendings que ya están marcados como pagados.",
    );
    assert.match(
        body,
        /listBoldQrPaidKeys\(window\.sessionStorage\)/,
        "Reload debe reconsultar sessionStorage para absorber marcas desde otras pestañas.",
    );
});

test("AP5d: useBoldQrTray: markPaid persiste en sessionStorage + filtra pending", async () => {
    const src = await readSrc(trayHookPath);
    const idx = src.indexOf("const markPaid = useCallback");
    const end = src.indexOf("}, [", idx);
    const body = src.slice(idx, end);
    assert.match(
        body,
        /markBoldQrPaidInStorage\(window\.sessionStorage/,
        "markPaid debe escribir al sessionStorage para resistir reloads.",
    );
    assert.match(
        body,
        /setPendings\(\(prev\)\s*=>\s*prev\.filter/,
        "markPaid debe filtrar el ventaTempId pagado de la lista visible.",
    );
});

test("AP5e: useBoldQrTray: SSE APPROVED también marca pagado en storage (resistente a dedupe path)", async () => {
    const src = await readSrc(trayHookPath);
    // El handler de APPROVED debe llamar markBoldQrPaidInStorage en ambas ramas:
    //   (a) ya notificado (defensa): otra pestaña lo marcó.
    //   (b) primera notificación.
    const approvedBlockIdx = src.indexOf("kind === BOLD_QR_TRAY_KIND.APPROVED");
    const approvedBlockEnd = src.indexOf("if (\n                kind === BOLD_QR_TRAY_KIND.AMBIGUOUS", approvedBlockIdx);
    const block = src.slice(approvedBlockIdx, approvedBlockEnd > approvedBlockIdx ? approvedBlockEnd : approvedBlockIdx + 4000);
    const occurrences = (block.match(/markBoldQrPaidInStorage/g) || []).length;
    assert.ok(
        occurrences >= 2,
        `El handler APPROVED debe persistir en storage en las dos ramas (ya notificado + nuevo). Vistas: ${occurrences}.`,
    );
});

// ---------------------------------------------------------------------------
// AP6 — prepareBoldQrIntent detecta alreadyPaid, marca y lanza sentinel
// ---------------------------------------------------------------------------

test("AP6a: sales/new/page.tsx: prepareBoldQrIntent importa isAlreadyPaidResponse y BOLD_QR_ALREADY_PAID_SENTINEL", async () => {
    const src = await readSrc(salesNewPagePath);
    assert.match(
        src,
        /BOLD_QR_ALREADY_PAID_SENTINEL/,
        "El page debe importar el sentinel para lanzarlo al UPM.",
    );
    assert.match(
        src,
        /isAlreadyPaidResponse/,
        "El page debe importar isAlreadyPaidResponse para detectar la rama alreadyPaid.",
    );
});

test("AP6b: prepareBoldQrIntent: tras isAlreadyPaidResponse llama qrMarkPaid + limpia payload + cierra UPM + lanza sentinel", async () => {
    const src = await readSrc(salesNewPagePath);
    const body = extractCallbackBody(src, "prepareBoldQrIntent");
    assert.match(
        body,
        /const\s+alreadyPaid\s*=\s*isAlreadyPaidResponse\(res\)/,
        "Debe evaluar la respuesta con el helper puro.",
    );
    assert.match(
        body,
        /qrMarkPaid\(\s*\{\s*ventaTempId:\s*trimmedTemp/,
        "Debe marcar pagado en la bandeja antes de cerrar.",
    );
    assert.match(
        body,
        /setBoldQrReopenPayload\(\s*null\s*\)/,
        "Debe limpiar el reopen payload para que el UPM no reabra el QR.",
    );
    assert.match(
        body,
        /setIsPaymentDialogOpen\(\s*false\s*\)/,
        "Debe cerrar el UPM — ya no hay nada que cobrar.",
    );
    assert.match(
        body,
        /throw\s+new\s+Error\(BOLD_QR_ALREADY_PAID_SENTINEL\)/,
        "Debe lanzar el sentinel para que el UPM aborte en silencio sin pintar toast de error.",
    );
});

// ---------------------------------------------------------------------------
// AP7 — handleBoldQrEnqueueRequested captura 409 QR_INTENT_ALREADY_PAID
// ---------------------------------------------------------------------------

test("AP7a: handleBoldQrEnqueueRequested importa isAlreadyPaidError y lo evalúa en el catch", async () => {
    const src = await readSrc(salesNewPagePath);
    const body = extractCallbackBody(src, "handleBoldQrEnqueueRequested");
    assert.match(
        body,
        /isAlreadyPaidError\(err\)/,
        "El catch debe discriminar los 409 QR_INTENT_ALREADY_PAID con el helper puro.",
    );
});

test("AP7b: handleBoldQrEnqueueRequested: rama alreadyPaid marca pagado + libera carrito + cierra UPM (sin re-lanzar)", async () => {
    const src = await readSrc(salesNewPagePath);
    const body = extractCallbackBody(src, "handleBoldQrEnqueueRequested");
    // Capturamos el bloque del `if (isAlreadyPaidError(err))`.
    const start = body.indexOf("if (isAlreadyPaidError(err))");
    assert.ok(start > 0, "Debe existir la rama de alreadyPaid dentro del catch.");
    const branch = body.slice(start, body.indexOf("throw err", start));
    assert.match(branch, /qrMarkPaid\(/, "Marca pagado en la bandeja.");
    assert.match(branch, /confirmEnqueuedAndFreeCart\(\s*\)/, "Libera sólo el carrito activo.");
    assert.match(branch, /setIsPaymentDialogOpen\(\s*false\s*\)/, "Cierra el UPM.");
    assert.match(branch, /setBoldQrReopenPayload\(\s*null\s*\)/, "Limpia el reopen payload.");
    assert.match(branch, /return;/, "Retorna sin re-lanzar — no es error ruidoso.");
});

// ---------------------------------------------------------------------------
// AP8 — handleReopenPending consulta qrIsPaid
// ---------------------------------------------------------------------------

test("AP8: handleReopenPending ignora pagados con toast 'YA PAGADO'", async () => {
    const src = await readSrc(salesNewPagePath);
    const body = extractCallbackBody(src, "handleReopenPending");
    assert.match(body, /qrIsPaid\(item\.ventaTempId\)/, "Debe consultar qrIsPaid antes de setear el payload.");
    // Y mostrar un toast + dismiss cuando ya está pagado.
    assert.match(
        body,
        /YA PAGADO/i,
        "El toast debe decir 'YA PAGADO' para que el cajero entienda.",
    );
    assert.match(
        body,
        /qrDismissIntent\(item\.ventaTempId\)/,
        "El pending debe sacarse visualmente de la bandeja.",
    );
    // Y NO debe seguir hasta setBoldQrReopenPayload.
    const dismissIdx = body.indexOf("qrDismissIntent");
    const setPayloadIdx = body.indexOf("setBoldQrReopenPayload");
    assert.ok(
        setPayloadIdx > dismissIdx,
        "El `return` tras qrDismissIntent asegura que setBoldQrReopenPayload no se ejecuta en la rama pagada.",
    );
});

// ---------------------------------------------------------------------------
// AP9 — handleBoldQrFinalized también marca pagado
// ---------------------------------------------------------------------------

test("AP9: handleBoldQrFinalized llama qrMarkPaidRef.current para persistir pagado", async () => {
    const src = await readSrc(salesNewPagePath);
    const body = extractCallbackBody(src, "handleBoldQrFinalized");
    assert.match(
        body,
        /qrMarkPaidRef\.current\?\.\(\s*\{[\s\S]*?ventaTempId:/,
        "Debe llamar qrMarkPaidRef.current con el ventaTempId confirmado.",
    );
});

// ---------------------------------------------------------------------------
// AP10 — ModalPagoBoldQR detecta alreadyPaid en /iniciar y transiciona a APPROVED
// ---------------------------------------------------------------------------

test("AP10a: ModalPagoBoldQR importa isAlreadyPaidResponse del helper puro", async () => {
    const src = await readSrc(modalPath);
    assert.match(
        src,
        /isAlreadyPaidResponse,?/,
        "El modal debe importar el helper que detecta alreadyPaid del response.",
    );
});

test("AP10b: ModalPagoBoldQR.start(): si alreadyPaid, phase=APPROVED y onApproved se dispara en setTimeout(..,0) con saleId/amountCop", async () => {
    const src = await readSrc(modalPath);
    const idx = src.indexOf("const alreadyPaid = isAlreadyPaidResponse(res)");
    assert.ok(idx > 0, "El start() debe evaluar alreadyPaid tras el POST /iniciar.");
    const end = src.indexOf("const rawIntentId = res?.intentId", idx);
    const block = src.slice(idx, end > idx ? end : idx + 2000);
    assert.match(block, /approvedFiredRef\.current\s*=\s*true/,
        "Debe prender el guard antes de disparar onApproved.");
    assert.match(block, /kind:\s*"APPROVED"/,
        "La fase debe transicionar a APPROVED directamente.");
    assert.match(block, /approvedVia:\s*"ALREADY_PAID"/,
        "approvedVia debe ser 'ALREADY_PAID' para distinguir de BOLD_OFFICIAL/BRIDGE/MANUAL.");
    assert.match(block, /setTimeout\(\s*\(\)\s*=>\s*\{[\s\S]*?onApproved\([\s\S]*?saleId:\s*alreadyPaid\.saleId[\s\S]*?amountCop:\s*alreadyPaid\.amountCop[\s\S]*?\}\s*\)[\s\S]*?\}\s*,\s*0\s*\)/,
        "onApproved debe dispararse inmediatamente (setTimeout 0, no 1500) con saleId/amountCop del helper.");
});

test("AP10c: ModalPagoBoldQR: IniciarResponse declara alreadyPaid/saleId/amountCop", async () => {
    const src = await readSrc(modalPath);
    const start = src.indexOf("interface IniciarResponse");
    const end = src.indexOf("}", start);
    const iface = src.slice(start, end + 1);
    assert.match(iface, /readonly\s+alreadyPaid\?\s*:\s*boolean/,
        "IniciarResponse debe tipar alreadyPaid opcional.");
    assert.match(iface, /readonly\s+saleId\?\s*:\s*number\s*\|\s*string/,
        "IniciarResponse debe tipar saleId opcional number|string.");
    assert.match(iface, /readonly\s+amountCop\?\s*:\s*number/,
        "IniciarResponse debe tipar amountCop opcional number.");
});

// ---------------------------------------------------------------------------
// AP11 — Helpers puros: contrato de "nunca inventan"
// ---------------------------------------------------------------------------

test("AP11a: BOLD_QR_ALREADY_PAID_SENTINEL es un string literal exportado", () => {
    assert.equal(typeof BOLD_QR_ALREADY_PAID_SENTINEL, "string");
    assert.ok(BOLD_QR_ALREADY_PAID_SENTINEL.length > 0, "El sentinel debe ser no vacío.");
});

test("AP11b: BOLD_QR_ALREADY_PAID_ERROR_CODE coincide con el contrato backend", () => {
    assert.equal(BOLD_QR_ALREADY_PAID_ERROR_CODE, "QR_INTENT_ALREADY_PAID");
});

test("AP11c: BOLD_QR_PAID_SESSION_PREFIX es exactamente 'bold-qr-paid:'", () => {
    assert.equal(BOLD_QR_PAID_SESSION_PREFIX, "bold-qr-paid:");
});

test("AP11d: isAlreadyPaidResponse: detecta alreadyPaid=true", () => {
    const info = isAlreadyPaidResponse({ alreadyPaid: true, saleId: 42, amountCop: 1500 });
    assert.deepEqual(info, { saleId: 42, amountCop: 1500 });
});

test("AP11e: isAlreadyPaidResponse: detecta status/streamStatus=APROBADA(O) sin flag explícito", () => {
    assert.deepEqual(
        isAlreadyPaidResponse({ status: "APROBADA", saleId: 100 }),
        { saleId: 100 },
    );
    assert.deepEqual(
        isAlreadyPaidResponse({ streamStatus: "APROBADO", amountCop: 200 }),
        { amountCop: 200 },
    );
});

test("AP11f: isAlreadyPaidResponse: PENDIENTE o shape sin flag → null (no inventa)", () => {
    assert.equal(isAlreadyPaidResponse({ status: "PENDIENTE" }), null);
    assert.equal(isAlreadyPaidResponse({}), null);
    assert.equal(isAlreadyPaidResponse(null), null);
    assert.equal(isAlreadyPaidResponse(undefined), null);
    assert.equal(isAlreadyPaidResponse("foo"), null);
});

test("AP11g: isAlreadyPaidResponse: saleId <= 0 o no entero no viaja en el output", () => {
    assert.deepEqual(isAlreadyPaidResponse({ alreadyPaid: true }), {});
    assert.deepEqual(isAlreadyPaidResponse({ alreadyPaid: true, saleId: 0 }), {});
    assert.deepEqual(isAlreadyPaidResponse({ alreadyPaid: true, saleId: -1 }), {});
    assert.deepEqual(isAlreadyPaidResponse({ alreadyPaid: true, saleId: 1.5 }), {});
    // String numérico se acepta.
    assert.deepEqual(isAlreadyPaidResponse({ alreadyPaid: true, saleId: "123" }), { saleId: 123 });
});

test("AP11h: extractAlreadyPaidErrorInfo: 409 + code=QR_INTENT_ALREADY_PAID retorna info", () => {
    const err = { status: 409, data: { code: "QR_INTENT_ALREADY_PAID", saleId: 500, amountCop: 7000 } };
    assert.deepEqual(extractAlreadyPaidErrorInfo(err), { saleId: 500, amountCop: 7000 });
});

test("AP11i: extractAlreadyPaidErrorInfo: tolera variantes anidadas (data.error.code, body.code)", () => {
    assert.ok(extractAlreadyPaidErrorInfo({ status: 409, data: { error: { code: "QR_INTENT_ALREADY_PAID" } } }));
    assert.ok(extractAlreadyPaidErrorInfo({ status: 409, body: { code: "QR_INTENT_ALREADY_PAID" } }));
    assert.ok(extractAlreadyPaidErrorInfo({ status: 409, response: { data: { code: "QR_INTENT_ALREADY_PAID" } } }));
});

test("AP11j: extractAlreadyPaidErrorInfo: status != 409 o code distinto → null", () => {
    assert.equal(extractAlreadyPaidErrorInfo({ status: 500, data: { code: "QR_INTENT_ALREADY_PAID" } }), null);
    assert.equal(extractAlreadyPaidErrorInfo({ status: 409, data: { code: "OTHER_CODE" } }), null);
    assert.equal(extractAlreadyPaidErrorInfo({ status: 409, data: null }), null);
    assert.equal(extractAlreadyPaidErrorInfo(null), null);
    assert.equal(extractAlreadyPaidErrorInfo("boom"), null);
});

test("AP11k: isAlreadyPaidError es alias defensivo de extractAlreadyPaidErrorInfo", () => {
    assert.equal(isAlreadyPaidError({ status: 409, data: { code: "QR_INTENT_ALREADY_PAID" } }), true);
    assert.equal(isAlreadyPaidError({ status: 500 }), false);
    assert.equal(isAlreadyPaidError(null), false);
});

function makeInMemoryStorage() {
    const map = new Map();
    return {
        get length() { return map.size; },
        key(i) { return Array.from(map.keys())[i] ?? null; },
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { map.set(k, String(v)); },
        removeItem(k) { map.delete(k); },
        clear() { map.clear(); },
    };
}

test("AP11l: markBoldQrPaidInStorage: idempotente y JSON parseable", () => {
    const storage = makeInMemoryStorage();
    assert.equal(markBoldQrPaidInStorage(storage, "vt-abc", { saleId: 7, amountCop: 1000, now: 1000 }), true);
    assert.equal(markBoldQrPaidInStorage(storage, "vt-abc", { saleId: 7 }), false, "Idempotente.");
    const raw = storage.getItem(BOLD_QR_PAID_SESSION_PREFIX + "vt-abc");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.saleId, 7);
    assert.equal(parsed.amountCop, 1000);
    assert.equal(parsed.markedAt, 1000);
});

test("AP11m: markBoldQrPaidInStorage: entradas inválidas → no escribe", () => {
    const storage = makeInMemoryStorage();
    assert.equal(markBoldQrPaidInStorage(storage, "", {}), false);
    assert.equal(markBoldQrPaidInStorage(storage, "   ", {}), false);
    assert.equal(markBoldQrPaidInStorage(storage, null, {}), false);
    assert.equal(markBoldQrPaidInStorage(null, "vt", {}), false);
    assert.equal(storage.length, 0);
});

test("AP11n: isBoldQrPaidInStorage + listBoldQrPaidKeys: contrato defensivo", () => {
    const storage = makeInMemoryStorage();
    markBoldQrPaidInStorage(storage, "vt-1", { saleId: 1 });
    markBoldQrPaidInStorage(storage, "vt-2", { saleId: 2 });
    // Ruido fuera del prefijo
    storage.setItem("foo:other", "x");
    assert.equal(isBoldQrPaidInStorage(storage, "vt-1"), true);
    assert.equal(isBoldQrPaidInStorage(storage, "vt-99"), false);
    assert.equal(isBoldQrPaidInStorage(storage, "  vt-2  "), true);
    const keys = listBoldQrPaidKeys(storage).sort();
    assert.deepEqual(keys, ["vt-1", "vt-2"]);
    // Entradas inválidas defensivas
    assert.equal(isBoldQrPaidInStorage(storage, ""), false);
    assert.equal(isBoldQrPaidInStorage(storage, null), false);
    assert.equal(isBoldQrPaidInStorage(null, "vt-1"), false);
    assert.deepEqual(listBoldQrPaidKeys(null), []);
});

// ---------------------------------------------------------------------------
// AP12 — Guard end-to-end (lectura compuesta de fuentes)
// ---------------------------------------------------------------------------

test("AP12: abrir cobro de otra cuenta tras QR pagado NO reabre el QR viejo (secuencia estática)", async () => {
    const upm = await readSrc(upmPath);
    const page = await readSrc(salesNewPagePath);

    // (1) El page nunca envía boldQrRequestId (prop eliminada).
    assert.ok(!/boldQrRequestId=\{/.test(page), "El page no debe pasar boldQrRequestId al UPM.");

    // (2) El page limpia boldQrReopenPayload tras consumo.
    assert.match(
        page,
        /const\s+handleBoldQrReopenConsumed\s*=\s*useCallback\(/,
        "El page expone handleBoldQrReopenConsumed para el contrato de un solo uso.",
    );
    assert.match(
        page,
        /setBoldQrReopenPayload\(\s*null\s*\)/,
        "handleBoldQrReopenConsumed limpia el payload a null.",
    );

    // (3) El UPM, sin payload, NO abre QR en el useEffect del reopen.
    const idx = upm.indexOf("if (!boldQrReopenPayload) return;");
    assert.ok(
        idx > 0,
        "El useEffect del reopen debe retornar temprano cuando no hay payload.",
    );

    // (4) Si el payload persiste por error, el ref anti-replay lo rechaza.
    assert.match(
        upm,
        /if\s*\(last\s*&&\s*last\.ventaTempId\s*===\s*reopenVenta\s*&&\s*last\.monto\s*===\s*reopenMonto\)/,
        "El ref anti-replay compara (ventaTempId + monto) antes de abrir.",
    );

    // (5) El UPM nunca cae a `handleOpenBoldQr()` desde el useEffect de reopen.
    const reopenEffectStart = upm.indexOf("lastConsumedReopenRef");
    const reopenEffectEnd = upm.indexOf("}, [isOpen, boldQrReopenPayload", reopenEffectStart);
    const reopenEffectBody = upm.slice(reopenEffectStart, reopenEffectEnd);
    assert.ok(
        !/handleOpenBoldQr\(\)/.test(reopenEffectBody),
        "El fallback a handleOpenBoldQr() está eliminado del useEffect de reopen.",
    );
});
