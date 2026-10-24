// =============================================================================
// tests/labels-workspace-persistent-queue.test.mjs
//
// Guardianes ESTÁTICOS del contrato C del rediseño "selección previa +
// cola persistente" aplicado al `LabelsWorkspace` compartido:
//
//   1. Importa el helper puro `label-print-queue.mjs` con alias claros
//      (loadPersistentQueue, removePersistentEntry, persistentUpdateQuantity,
//      PERSISTENT_QUEUE_KEY, PERSISTENT_QUEUE_REASONS).
//   2. Hidrata la cola persistente al montar y escucha el `storage` event
//      para refrescar cuando otro tab la modifica (sin loops).
//   3. Resuelve cada entry contra POST /labels/codes (idempotente) y
//      preserva los errores en `resolveError` para badge + reintento.
//   4. Fusiona manualmente escaneados con persistentes de forma
//      DETERMINISTA (mismo code.code → merge sin duplicar filas).
//   5. "Vaciar" NO toca entradas persistentes (sólo filtra manuales).
//   6. Discard EXPLÍCITO de persistentes elimina de storage y de memoria.
//   7. Audit-first: antes de borrar persistentes del storage debemos
//      haber auditado /labels/print-jobs + invocado print()/bridge.
//   8. Si la auditoría falla, NO se borra nada del storage.
//   9. shelf usa el `salePrice` NUEVO persistido (persistentSalePrice) y
//      SIGUE siendo iframe-only; nunca pasa por el bridge térmico.
//  10. Thermal preserva bridge → fallback window.print() actual.
//  11. Badges: motivo, cambio old→new, receptionRef se exponen con
//      test-ids previsibles.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = join(
    here,
    "..",
    "src",
    "app",
    "(app)",
    "labels",
    "components",
    "LabelsWorkspace.tsx",
);

async function readWS() {
    return readFile(workspace, "utf8");
}

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
}

// -----------------------------------------------------------------------------
// 1 — Imports del helper puro
// -----------------------------------------------------------------------------

test("LabelsWorkspace importa helpers de label-print-queue.mjs con alias", async () => {
    const src = await readWS();
    assert.ok(
        /from\s+["']@\/lib\/label-print-queue\.mjs["']/.test(src),
        "LabelsWorkspace debe importar del helper puro label-print-queue.mjs.",
    );
    assert.ok(
        /load\s+as\s+loadPersistentQueue/.test(src),
        "El import debe aliasar load → loadPersistentQueue.",
    );
    assert.ok(
        /remove\s+as\s+removePersistentEntry/.test(src),
        "El import debe aliasar remove → removePersistentEntry.",
    );
    assert.ok(
        /updateQuantity\s+as\s+persistentUpdateQuantity/.test(src),
        "El import debe aliasar updateQuantity → persistentUpdateQuantity.",
    );
    assert.ok(
        /QUEUE_STORAGE_KEY\s+as\s+PERSISTENT_QUEUE_KEY/.test(src),
        "El import debe traer la clave canónica como PERSISTENT_QUEUE_KEY.",
    );
    assert.ok(
        /QUEUE_REASONS\s+as\s+PERSISTENT_QUEUE_REASONS/.test(src),
        "El import debe traer el enum de motivos como PERSISTENT_QUEUE_REASONS.",
    );
});

// -----------------------------------------------------------------------------
// 2 — Hidratación al montar + storage event
// -----------------------------------------------------------------------------

test("LabelsWorkspace define hydratePersistentQueue como callback", async () => {
    const src = await readWS();
    assert.ok(
        /const\s+hydratePersistentQueue\s*=\s*useCallback\(/.test(src),
        "Debe existir el callback hydratePersistentQueue.",
    );
});

test("LabelsWorkspace llama hydratePersistentQueue en el useEffect de montaje", async () => {
    const src = await readWS();
    // El useEffect debe disparar hydratePersistentQueue() en mount.
    assert.ok(
        /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?void\s+hydratePersistentQueue\(\)/.test(src),
        "hydratePersistentQueue debe invocarse al montar vía useEffect.",
    );
});

test("LabelsWorkspace escucha el 'storage' event filtrando por PERSISTENT_QUEUE_KEY", async () => {
    const src = await readWS();
    assert.ok(
        /window\.addEventListener\(\s*["']storage["']\s*,\s*onStorage\s*\)/.test(src),
        "LabelsWorkspace debe suscribirse al evento 'storage' del navegador.",
    );
    assert.ok(
        /ev\.key\s*===\s*PERSISTENT_QUEUE_KEY/.test(src),
        "El handler debe filtrar por la clave canónica del queue persistente.",
    );
    // Y debe limpiarse en el return del useEffect (sin loops).
    assert.ok(
        /window\.removeEventListener\(\s*["']storage["']\s*,\s*onStorage\s*\)/.test(src),
        "El listener debe liberarse en el cleanup del efecto.",
    );
});

test("hydratePersistentQueue tiene guard anti-reentrancy (hydrationInFlightRef)", async () => {
    const src = await readWS();
    assert.ok(
        /hydrationInFlightRef\s*=\s*useRef\(false\)/.test(src),
        "Debe existir un ref anti-reentrancy para evitar hidrataciones concurrentes.",
    );
    assert.ok(
        /if\s*\(hydrationInFlightRef\.current\)\s*\{[\s\S]*?hydrationPendingRef\.current\s*=\s*true;[\s\S]*?return;/.test(src),
        "El callback debe marcar una rehidratación pendiente y retornar si ya hay otra en curso.",
    );
});

// -----------------------------------------------------------------------------
// 3 — Resuelve contra /labels/codes y conserva errores con reintento
// -----------------------------------------------------------------------------

test("Hidratación POSTea /labels/codes por cada entrada persistente", async () => {
    const src = await readWS();
    // Buscamos el bloque de hidratación. Debe mapear persistent → apiFetch /labels/codes.
    assert.ok(
        /persistent\.map\(\s*async\s*\(entry[^)]*\)[\s\S]*?apiFetch[\s\S]*?["']\/labels\/codes["']/.test(src),
        "Cada entrada persistente debe resolverse contra /labels/codes (idempotente).",
    );
});

test("Hidratación: cuando falla la resolución, la entrada queda con resolveError", async () => {
    const src = await readWS();
    assert.ok(
        /resolveError:/.test(src),
        "El shape de la entrada en memoria debe exponer resolveError para la UI.",
    );
    // Y el shape debe incluir el fallback __pending__ para que no se envíe
    // al audit si todavía no se resolvió.
    assert.ok(
        /__pending__/.test(src),
        "Las entradas sin resolver deben usar un code placeholder `__pending__{id}`.",
    );
});

test("Discard explícito: `discardPersistentEntry` elimina de storage y de memoria", async () => {
    const src = await readWS();
    assert.ok(
        /const\s+discardPersistentEntry\s*=\s*useCallback\(/.test(src),
        "Debe existir el callback discardPersistentEntry.",
    );
    assert.ok(
        /removePersistentEntry\(\s*window\.localStorage,\s*persistentId\s*\)/.test(src),
        "discardPersistentEntry debe eliminar del storage con removePersistentEntry.",
    );
    assert.ok(
        /setQueue\(\(prev\)\s*=>[\s\S]*?q\.persistentId\s*!==\s*persistentId[\s\S]*?source:\s*["']manual["'][\s\S]*?quantity:\s*manual[\s\S]*?filter\(\(q\)\s*=>\s*q\.quantity\s*>\s*0\)/.test(src),
        "discardPersistentEntry debe retirar la porción persistente y preservar la manual si existe.",
    );
});

test("Retry: `retryPersistentEntry` re-invoca hydratePersistentQueue", async () => {
    const src = await readWS();
    assert.ok(
        /const\s+retryPersistentEntry\s*=\s*useCallback\(/.test(src),
        "Debe existir el callback retryPersistentEntry.",
    );
    assert.ok(
        /retryPersistentEntry[\s\S]*?await\s+hydratePersistentQueue\(\)/.test(src),
        "retryPersistentEntry debe esperar a hydratePersistentQueue().",
    );
});

// -----------------------------------------------------------------------------
// 4 — Fusión determinista con items manuales
// -----------------------------------------------------------------------------

test("Hidratación: fusiona manuales con persistentes por productBarcode sin duplicar", async () => {
    const src = await readWS();
    assert.ok(
        /new\s+Map<string,\s*QueueItem>\(\)/.test(src),
        "La hidratación debe usar un Map determinista por barcode.",
    );
    assert.ok(
        /q\.productBarcode\s*\|\|\s*q\.code\.productBarcode/.test(src),
        "La clave de fusión debe ser productBarcode, no el LabelCode.",
    );
    assert.ok(
        /quantity:\s*persistentQuantity\s*\+\s*manualQuantity/.test(src),
        "La fila fusionada debe sumar sus porciones sin contaminar la cantidad persistida.",
    );
});

test("Hidratación: NO borra manuales al refrescar", async () => {
    const src = await readWS();
    assert.ok(
        /persistentManualPreserved:\s*QueueItem\[\]/.test(src),
        "La hidratación debe acumular manuales preservadas.",
    );
    assert.ok(
        /return\s*\[\.\.\.persistentList,\s*\.\.\.persistentManualPreserved\]/.test(src),
        "La cola rehidratada debe devolver persistentes y manuales no duplicados.",
    );
});

// -----------------------------------------------------------------------------
// 5 — "Vaciar" NO toca persistentes
// -----------------------------------------------------------------------------

test("'Vaciar' sólo filtra manuales (preserva persistentes)", async () => {
    const src = await readWS();
    assert.ok(
        /data-testid="labels-clear-manual-btn"/.test(src),
        "El botón 'Vaciar' debe exponer data-testid='labels-clear-manual-btn'.",
    );
    assert.ok(
        /manualQuantity:\s*0[\s\S]*?quantity:\s*q\.persistentQuantity[\s\S]*?filter\(\(q\)\s*=>\s*q\.source\s*===\s*["']persistent["']\)/.test(src),
        "Vaciar debe quitar manuales puras y poner en cero sólo la porción manual de filas persistentes.",
    );
});

// -----------------------------------------------------------------------------
// 7 / 8 — Audit-first para limpieza de persistentes
// -----------------------------------------------------------------------------

test("handlePrint (thermal): la limpieza de persistentes ocurre DESPUÉS del POST a /labels/print-jobs", async () => {
    const code = stripComments(await readWS());
    // Aislamos handlePrint para evitar que la llamada a removePersistentEntry
    // dentro de `discardPersistentEntry` (helper separado) confunda el orden.
    const handlerMatch = code.match(
        /const\s+handlePrint\s*=\s*useCallback\([\s\S]*?\n\s*\},\s*\[/,
    );
    assert.ok(handlerMatch, "handlePrint debe existir como useCallback.");
    const body = handlerMatch[0];
    const auditIdx = body.indexOf('"/labels/print-jobs"');
    const removeCallIdx = body.indexOf("removePersistentEntry(");
    assert.ok(auditIdx > 0, "handlePrint debe POSTear a /labels/print-jobs.");
    assert.ok(removeCallIdx > 0, "handlePrint debe invocar removePersistentEntry al limpiar.");
    assert.ok(
        auditIdx < removeCallIdx,
        "El POST a /labels/print-jobs debe ocurrir antes de la llamada a removePersistentEntry — audit-first.",
    );
});

test("handlePrint: si la auditoría arroja, NO se limpia storage (persistentes conservados)", async () => {
    const code = stripComments(await readWS());
    // Si el apiFetch del audit arroja, caemos al catch de handlePrint. El
    // catch NO debe tocar removePersistentEntry; el flujo correcto es
    // conservar las persistentes para reintento.
    const handler = code.match(/const\s+handlePrint\s*=\s*useCallback\([\s\S]*?\n\s*\},\s*\[/);
    assert.ok(handler, "No se pudo localizar handlePrint.");
    const body = handler[0];
    // El catch del handler no menciona removePersistentEntry.
    const catchMatch = body.match(/\}\s*catch\s*\(e:[^)]*\)\s*\{[\s\S]*?\}\s*finally/);
    assert.ok(catchMatch, "handlePrint debe tener un catch.");
    assert.ok(
        !/removePersistentEntry/.test(catchMatch[0]),
        "El catch de handlePrint NO debe eliminar entradas persistentes (conservar para reintento).",
    );
});

test("handlePrint: limpieza de persistentes sólo si printInvoked === true", async () => {
    const code = stripComments(await readWS());
    assert.ok(
        /let\s+printInvoked\s*=\s*false/.test(code),
        "Debe existir un flag `printInvoked` que marca si print()/bridge se invocó.",
    );
    assert.ok(
        /if\s*\(printInvoked\s*&&\s*typeof\s+window\s*!==\s*["']undefined["']\)\s*\{[\s\S]*?removePersistentEntry/.test(code),
        "La limpieza de persistentes debe estar guardada por `printInvoked === true`.",
    );
});

test("handlePrintShelfSheetSheet (shelf LETTER/LEGAL): limpia persistentes DESPUÉS de iframe.print()", async () => {
    const code = stripComments(await readWS());
    const shelfFn = code.match(/const\s+handlePrintShelfSheetSheet\s*=\s*useCallback\([\s\S]*?\n\s*\},\s*\[/);
    assert.ok(shelfFn, "handlePrintShelfSheetSheet debe existir (rama LETTER/LEGAL).");
    const body = shelfFn[0];
    const auditIdx = body.indexOf('"/labels/print-jobs"');
    const printIdx = body.indexOf("iframe.contentWindow?.print()");
    const removeIdx = body.indexOf("removePersistentEntry");
    assert.ok(auditIdx > 0 && printIdx > 0 && removeIdx > 0);
    assert.ok(auditIdx < printIdx, "AUDIT antes de iframe.print.");
    assert.ok(
        removeIdx > auditIdx,
        "La limpieza de persistentes en shelf LETTER/LEGAL debe ocurrir tras la auditoría (dentro del cleanup).",
    );
});

// -----------------------------------------------------------------------------
// 9 — shelf usa persistentSalePrice y es iframe-only
// -----------------------------------------------------------------------------

test("shelf: shelfPriceOf prefiere persistentSalePrice sobre product.salePrice", async () => {
    const src = await readWS();
    assert.ok(
        /const\s+shelfPriceOf\s*=\s*useCallback/.test(src),
        "Debe existir shelfPriceOf para resolver el precio en góndola.",
    );
    assert.ok(
        /q\.source\s*===\s*["']persistent["']\s*&&\s*typeof\s+q\.persistentSalePrice\s*===\s*["']number["']/.test(src),
        "shelfPriceOf debe inspeccionar `persistentSalePrice` cuando source==='persistent'.",
    );
});

test("shelf (LETTER/LEGAL): usa EXCLUSIVAMENTE iframe + diálogo del navegador (sin bridge)", async () => {
    const code = stripComments(await readWS());
    const shelfFn = code.match(/const\s+handlePrintShelfSheetSheet\s*=\s*useCallback\([\s\S]*?\n\s*\},\s*\[/);
    assert.ok(shelfFn, "handlePrintShelfSheetSheet debe existir (rama LETTER/LEGAL).");
    const body = shelfFn[0];
    assert.ok(
        /document\.createElement\(["']iframe["']\)/.test(body),
        "shelf Carta/Oficio debe crear un iframe aislado.",
    );
    assert.ok(
        /iframe\.contentWindow\?\.print\(\)/.test(body),
        "shelf Carta/Oficio debe imprimir con iframe.contentWindow.print().",
    );
    assert.ok(
        !/posBridge\?\.print\(|posBridge\.print\(/.test(body),
        "shelf Carta/Oficio NUNCA debe invocar al bridge térmico (esa ruta es THERMAL_80).",
    );
    assert.ok(
        !/window\.print\(\)/.test(body),
        "shelf Carta/Oficio nunca llama a window.print() del documento principal.",
    );
});

test("shelf (THERMAL_80): usa EXCLUSIVAMENTE bridge directo (sin iframe, sin window.print)", async () => {
    const code = stripComments(await readWS());
    const thermalFn = code.match(/const\s+handlePrintShelfSheetThermal\s*=\s*useCallback\([\s\S]*?\n\s*\},\s*\[/);
    assert.ok(thermalFn, "handlePrintShelfSheetThermal debe existir (rama THERMAL_80).");
    const body = thermalFn[0];
    assert.ok(
        /posBridge\?\.print|posBridge\.print/.test(body),
        "shelf THERMAL_80 debe invocar al bridge.",
    );
    assert.ok(
        /buildShelfLabelsBridgePayload/.test(body),
        "shelf THERMAL_80 debe armar su payload con buildShelfLabelsBridgePayload.",
    );
    assert.ok(
        !/document\.createElement\(["']iframe["']\)/.test(body),
        "shelf THERMAL_80 NUNCA crea iframe — es ruta bridge pura.",
    );
    assert.ok(
        !/window\.print\(\)/.test(body),
        "shelf THERMAL_80 nunca llama a window.print() del documento principal.",
    );
    assert.ok(
        !/kickDrawer/.test(body),
        "shelf THERMAL_80 nunca abre el cajón.",
    );
});

// -----------------------------------------------------------------------------
// 10 — Thermal preserva bridge → fallback window.print()
// -----------------------------------------------------------------------------

test("thermal: preserva ruta bridge → fallback window.print() actual", async () => {
    const src = await readWS();
    assert.ok(
        /w\.posBridge\?\.print/.test(src),
        "handlePrint debe seguir intentando w.posBridge.print.",
    );
    assert.ok(
        /window\.print\(\)/.test(src),
        "handlePrint debe seguir cayendo a window.print() cuando el bridge falla o no existe.",
    );
});

// -----------------------------------------------------------------------------
// 11 — Badges y data-testids
// -----------------------------------------------------------------------------

test("Queue item: badge de motivo PRICE_CHANGE con test-id (POST_RECEIVE retirado del modelo)", async () => {
    const src = await readWS();
    assert.ok(
        /data-testid="labels-queue-badge-reason"/.test(src),
        "La fila debe pintar un badge con data-testid='labels-queue-badge-reason'.",
    );
    assert.ok(
        /PERSISTENT_QUEUE_REASONS\.PRICE_CHANGE/.test(src),
        "El badge debe decidirse comparando con el enum PERSISTENT_QUEUE_REASONS.PRICE_CHANGE.",
    );
    // POST_RECEIVE fue retirado del modelo: no debe quedar ningún
    // cableado residual.
    assert.ok(
        !/PERSISTENT_QUEUE_REASONS\.POST_RECEIVE/.test(src),
        "El modelo canónico retiró POST_RECEIVE — no debe quedar referencia en la UI.",
    );
});

test("Queue item: badge de cambio old→new con test-id", async () => {
    const src = await readWS();
    assert.ok(
        /data-testid="labels-queue-badge-change"/.test(src),
        "El bloque old→new debe tener data-testid='labels-queue-badge-change'.",
    );
    assert.ok(
        /item\.oldSalePrice/.test(src) && /item\.persistentSalePrice/.test(src),
        "El badge debe mostrar oldSalePrice y persistentSalePrice.",
    );
});

test("Queue item: badge de ref de recepción con test-id", async () => {
    const src = await readWS();
    assert.ok(
        /data-testid="labels-queue-badge-ref"/.test(src),
        "La fila debe mostrar el receptionRef con data-testid='labels-queue-badge-ref'.",
    );
    assert.ok(
        /Lote:\s*\{item\.receptionRef\}/.test(src),
        "El badge de ref debe pintar 'Lote: {item.receptionRef}'.",
    );
});

test("Queue item: botón descartar persistente con test-id", async () => {
    const src = await readWS();
    assert.ok(
        /data-testid="labels-queue-discard"/.test(src),
        "El botón de descartar persistente debe exponer data-testid='labels-queue-discard'.",
    );
});

test("Queue item: botón reintentar expuesto para resoluciones con error", async () => {
    const src = await readWS();
    assert.ok(
        /data-testid="labels-queue-retry"/.test(src),
        "El botón de reintentar debe exponer data-testid='labels-queue-retry'.",
    );
});

// -----------------------------------------------------------------------------
// Cross: la cola persistente propaga quantity al storage al editar
// -----------------------------------------------------------------------------

test("updateQuantity del workspace propaga a storage para entradas persistentes", async () => {
    const src = await readWS();
    // Acepta el nuevo nombre de variable (`pending.id` / `pending.qty`)
    // tras el refactor que separa persistentQuantity de manualQuantity.
    // La invariante contratada: existe una llamada a
    // persistentUpdateQuantity con window.localStorage, un id y una
    // cantidad resueltos FUERA del updater (sin side effects dentro
    // de setState).
    assert.ok(
        /persistentUpdateQuantity\(\s*window\.localStorage,[\s\S]{0,160}\)/.test(src),
        "El updateQuantity local debe sincronizar la cantidad al storage para persistentes.",
    );
    // La llamada debe estar fuera del callback de `prev.map`: primero se
    // calcula desde el snapshot renderizado, luego se actualiza storage y
    // finalmente React. Así no depende de que React ejecute el updater de
    // forma síncrona ni duplica side effects en Strict Mode.
    const updateFn = src.match(/const\s+updateQuantity\s*=\s*useCallback\([\s\S]*?\n\s*\},\s*\[/);
    assert.ok(updateFn, "Debe existir updateQuantity como useCallback.");
    const persistCallIdx = updateFn[0].indexOf("persistentUpdateQuantity(");
    const setQueueIdx = updateFn[0].indexOf("setQueue((prev)", persistCallIdx);
    assert.ok(persistCallIdx > 0, "Debe persistir fuera del reducer React.");
    assert.ok(
        setQueueIdx > persistCallIdx,
        "Debe persistir desde el snapshot antes de actualizar React, sin side effects dentro del updater.",
    );
});
