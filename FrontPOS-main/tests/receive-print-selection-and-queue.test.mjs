// =============================================================================
// tests/receive-print-selection-and-queue.test.mjs
//
// Guardianes ESTÁTICOS del flujo de recepción tras el rediseño "selección
// previa + cola persistente" (contratos A y B). Validan sobre
// `src/app/(app)/inventory/receive/page.tsx`:
//
//   1. `ReceiveItem.printLabelAfterReceive?: boolean` existe en la
//      interfaz de la línea.
//   2. TODAS las rutas de creación/hidratación inicializan el flag en
//      `false`:
//        · addFreeItem
//        · addToReceive
//        · handleInvoiceMatch (OCR nueva línea)
//        · handleUnmatchedResolved (reviewer resolution)
//        · loadOrderIntoList (pedidos)
//        · fetchEditReception (edición histórica)
//        · Not Found Dialog "Asociar" branch
//        · Persistencia legacy localStorage (reset al rehidratar)
//   3. `updateItem` fuerza `printLabelAfterReceive = false` cuando
//      `entryType === 'return'` (defense in depth).
//   4. El panel de selección "N seleccionadas" + botones Todas/Ninguna
//      vive en el header del carrito y:
//        · El contador N viene de `selectionCounts.selected`.
//        · "Todas" sólo marca items ELEGIBLES (no devolución, qty>0).
//        · "Ninguna" apaga TODO (incluyendo cualquier residuo).
//   5. `stampedLines` SOLO contiene líneas con `printLabelAfterReceive === true`
//      (filtrado estricto post-sync).
//   6. La cola persistente (`enqueueLabelPrintEntry`) se llama DESPUÉS de
//      `/products/bulk-receive` OK y ANTES de limpiar el carrito.
//   7. NUNCA se hace POST a `/labels/print-jobs` al encolar.
//   8. El modal "Zona de impresión" existe con botones "Ir a zona" y
//      "Continuar"/"Finalizar"; preserva WhatsApp y lista cambios old→new.
//   9. Secuencia: price modal → PostReceptionLabelsModal sin perder
//      stampedLines ni redirigir temprano.
//  10. `changedItems` se calcula sobre `receiveList` antes de limpiar.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const page = join(here, "..", "src", "app", "(app)", "inventory", "receive", "page.tsx");

async function readPage() {
    return readFile(page, "utf8");
}

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
}

// -----------------------------------------------------------------------------
// A — ReceiveItem.printLabelAfterReceive y defaults en TODAS las rutas
// -----------------------------------------------------------------------------

test("ReceiveItem.printLabelAfterReceive?: boolean está declarado en la interfaz", async () => {
    const src = await readPage();
    assert.ok(
        /interface\s+ReceiveItem[\s\S]*?printLabelAfterReceive\?:\s*boolean/.test(src),
        "ReceiveItem debe exponer `printLabelAfterReceive?: boolean` para la selección previa.",
    );
});

test("TODAS las rutas de creación/hidratación inicializan printLabelAfterReceive: false", async () => {
    const code = stripComments(await readPage());
    // Buscamos la cantidad de inicializaciones con `printLabelAfterReceive: false`.
    const occurrences = code.match(/printLabelAfterReceive:\s*false/g) || [];
    // Rutas esperadas (ver docstring arriba): 8 rutas distintas.
    assert.ok(
        occurrences.length >= 8,
        `Se esperaban al menos 8 inicializaciones con \`printLabelAfterReceive: false\` (una por cada ruta de creación/hidratación); se encontraron ${occurrences.length}.`,
    );
    // Las ÚNICAS rutas que pueden setear `printLabelAfterReceive: true`
    // son los helpers de selección masiva. Ninguna CREACIÓN/HIDRATACIÓN
    // debe arrancar en `true`. Comprobamos sólo literales de código
    // ejecutable (comentarios ya quitados).
    const trueOccurrences = (code.match(/printLabelAfterReceive:\s*true/g) || []).length;
    // handleSelectAllPrintLabels marca los eligibles como true: 1 ocurrencia esperada.
    assert.ok(
        trueOccurrences <= 1,
        `Sólo el helper de "Marcar todas" puede setear \`printLabelAfterReceive: true\`; se encontraron ${trueOccurrences} ocurrencias.`,
    );
});

test("addFreeItem inicializa printLabelAfterReceive: false", async () => {
    const code = stripComments(await readPage());
    const re = /const\s+addFreeItem\s*=\s*useCallback\([\s\S]*?printLabelAfterReceive:\s*false/;
    assert.ok(re.test(code), "addFreeItem debe setear printLabelAfterReceive=false.");
});

test("addToReceive inicializa printLabelAfterReceive: false", async () => {
    const code = stripComments(await readPage());
    const re = /const\s+addToReceive\s*=\s*useCallback\([\s\S]*?printLabelAfterReceive:\s*false/;
    assert.ok(re.test(code), "addToReceive debe setear printLabelAfterReceive=false.");
});

test("handleInvoiceMatch rama 'extra' (nuevo item OCR) inicializa printLabelAfterReceive: false", async () => {
    const code = stripComments(await readPage());
    // La rama que inserta nuevos items OCR se identifica por matchStatus: 'extra'.
    const re = /matchStatus:\s*['"]extra['"][\s\S]{0,200}printLabelAfterReceive:\s*false/;
    assert.ok(re.test(code), "La rama OCR que pushea nuevos items debe setear printLabelAfterReceive=false.");
});

test("handleUnmatchedResolved inicializa printLabelAfterReceive: false", async () => {
    const code = stripComments(await readPage());
    const re = /handleUnmatchedResolved[\s\S]*?printLabelAfterReceive:\s*false/;
    assert.ok(re.test(code), "handleUnmatchedResolved debe setear printLabelAfterReceive=false.");
});

test("loadOrderIntoList inicializa printLabelAfterReceive: false", async () => {
    const code = stripComments(await readPage());
    const re = /const\s+loadOrderIntoList\s*=[\s\S]*?printLabelAfterReceive:\s*false/;
    assert.ok(re.test(code), "loadOrderIntoList debe setear printLabelAfterReceive=false.");
});

test("fetchEditReception (edición histórica) inicializa printLabelAfterReceive: false", async () => {
    const code = stripComments(await readPage());
    const re = /fetchEditReception[\s\S]*?printLabelAfterReceive:\s*false/;
    assert.ok(re.test(code), "fetchEditReception debe setear printLabelAfterReceive=false.");
});

test("Not Found Dialog 'Asociar' branch inicializa printLabelAfterReceive: false", async () => {
    const code = stripComments(await readPage());
    // Buscamos actualPhysicalStock: null (shape distintivo del asociar) + flag.
    const re = /actualPhysicalStock:\s*null[\s\S]{0,200}printLabelAfterReceive:\s*false/;
    assert.ok(re.test(code), "El Not Found Dialog debe setear printLabelAfterReceive=false al asociar un barcode a un existente.");
});

test("Persistencia legacy (localStorage): entryType==='return' => false; selección 'true' del draft sobrevive al reload", async () => {
    const code = stripComments(await readPage());
    // Contrato post-auditoría: la rehidratación legacy ya NO fuerza
    // siempre `false`. Debe aplicar:
    //   entryType === 'return' ? false : item.printLabelAfterReceive === true
    // Así, una línea con selección explícita 'true' sobrevive al reload,
    // pero una devolución nunca puede quedar marcada (defensa en
    // profundidad para el modo RETURN).
    const re = /org-pos-reception-list[\s\S]*?printLabelAfterReceive:[\s\S]{0,160}entryType\s*===\s*['"]return['"][\s\S]{0,80}\?\s*false\s*:\s*[\s\S]{0,80}printLabelAfterReceive\s*===\s*true/;
    assert.ok(
        re.test(code),
        "La rehidratación legacy debe usar el ternario entryType==='return' ? false : item.printLabelAfterReceive===true (preserva selección del draft).",
    );
    // Y NO debe forzar `printLabelAfterReceive: false` literal dentro
    // de la rama de hidratación legacy (eso descartaría la selección).
    const legacyBlock = code.slice(
        code.indexOf("savedList && try") >= 0
            ? code.indexOf("savedList && try")
            : code.indexOf("org-pos-reception-list"),
        code.indexOf("savedSupplier && savedSupplier !== 'none'"),
    );
    if (legacyBlock.length > 0) {
        assert.ok(
            !/printLabelAfterReceive:\s*false\s*,/.test(legacyBlock),
            "La rama de hidratación legacy NO debe setear `printLabelAfterReceive: false` literal (debe usar el ternario).",
        );
    }
});

// -----------------------------------------------------------------------------
// A — defense in depth: RETURN siempre false
// -----------------------------------------------------------------------------

test("updateItem fuerza printLabelAfterReceive=false cuando entryType === 'return'", async () => {
    const code = stripComments(await readPage());
    const re = /entryType\s*===\s*['"]return['"][\s\S]{0,250}printLabelAfterReceive\s*=\s*false/;
    assert.ok(
        re.test(code),
        "updateItem debe forzar printLabelAfterReceive=false para RETURN como defensa en profundidad.",
    );
});

// -----------------------------------------------------------------------------
// A — Panel de selección N seleccionadas + Todas/Ninguna
// -----------------------------------------------------------------------------

test("Panel de selección: expone selectionCounts.selected/eligible", async () => {
    const code = stripComments(await readPage());
    assert.ok(
        /const\s+selectionCounts\s*=\s*useMemo/.test(code),
        "Debe existir el memo `selectionCounts`.",
    );
    assert.ok(
        /selectionCounts\.selected/.test(code),
        "El panel debe exponer selectionCounts.selected.",
    );
    assert.ok(
        /selectionCounts\.eligible/.test(code),
        "El panel debe exponer selectionCounts.eligible.",
    );
});

test("Panel de selección: elegibleForLabelPrint descarta devoluciones y qty<=0", async () => {
    const src = await readPage();
    assert.ok(
        /entryType\s*!==\s*['"]return['"]\s*&&\s*Number\(it\.addedQuantity[^)]*\)\s*>\s*0/.test(src),
        "Elegible = no-return && qty>0 — contrato A: devoluciones nunca cuentan.",
    );
});

test("Panel de selección: botón 'Todas' sólo marca ELEGIBLES", async () => {
    const code = stripComments(await readPage());
    // handleSelectAllPrintLabels aplica `eligibleForLabelPrint` como guard
    // antes de marcar `printLabelAfterReceive: true`.
    const re = /handleSelectAllPrintLabels[\s\S]*?eligibleForLabelPrint\(item\)[\s\S]*?printLabelAfterReceive:\s*true/;
    assert.ok(re.test(code), "handleSelectAllPrintLabels debe filtrar por eligibleForLabelPrint.");
    // Y los no elegibles explícitamente quedan en false.
    const re2 = /handleSelectAllPrintLabels[\s\S]*?printLabelAfterReceive:\s*false/;
    assert.ok(re2.test(code), "Los no-elegibles deben quedar en printLabelAfterReceive=false, no 'intactos'.");
});

test("Panel de selección: botón 'Ninguna' apaga TODO (incluyendo residuos en return)", async () => {
    const code = stripComments(await readPage());
    assert.ok(
        /handleSelectNonePrintLabels[\s\S]*?printLabelAfterReceive:\s*false/.test(code),
        "handleSelectNonePrintLabels debe forzar false en todas las líneas sin excepción.",
    );
});

test("Panel de selección: renderiza data-testid='label-selection-summary'", async () => {
    const src = await readPage();
    assert.ok(
        /data-testid="label-selection-summary"/.test(src),
        "El panel de resumen debe exponer data-testid para los tests.",
    );
    assert.ok(
        /data-testid="label-selection-count"/.test(src),
        "El contador debe exponer data-testid='label-selection-count'.",
    );
    assert.ok(
        /data-testid="label-select-all"/.test(src),
        "El botón 'Todas' debe exponer data-testid='label-select-all'.",
    );
    assert.ok(
        /data-testid="label-select-none"/.test(src),
        "El botón 'Ninguna' debe exponer data-testid='label-select-none'.",
    );
});

// -----------------------------------------------------------------------------
// A — stampedLines sólo contiene items con printLabelAfterReceive=true
// -----------------------------------------------------------------------------

test("stampedLines SÓLO incluye líneas con printLabelAfterReceive === true", async () => {
    const src = await readPage();
    // El filtrado de stampedLines debe tener la triple condición:
    //   printLabelAfterReceive === true && entryType !== 'return' && qty > 0.
    const re = /stampedLines[\s\S]*?filter\([\s\S]*?printLabelAfterReceive\s*===\s*true[\s\S]*?entryType\s*!==\s*['"]return['"][\s\S]*?Number\(it\.addedQuantity[^)]*\)\s*>\s*0/;
    assert.ok(re.test(src), "stampedLines debe filtrar por printLabelAfterReceive=true + no-return + qty>0.");
});

test("stampedLines estampa cada línea con syncedReceptionId = receptionRef", async () => {
    const src = await readPage();
    assert.ok(
        /stampedLines[\s\S]*?syncedReceptionId:\s*receptionRef/.test(src),
        "stampedLines debe propagar syncedReceptionId = receptionRef al snapshot.",
    );
});

// -----------------------------------------------------------------------------
// B — Cola persistente: import y uso tras bulk-receive OK
// -----------------------------------------------------------------------------

test("page.tsx importa `enqueue` del helper label-print-queue.mjs con alias explícito", async () => {
    const src = await readPage();
    assert.ok(
        /from\s+["']@\/lib\/label-print-queue\.mjs["']/.test(src),
        "page.tsx debe importar del helper puro label-print-queue.mjs.",
    );
    assert.ok(
        /enqueue\s+as\s+enqueueLabelPrintEntry/.test(src),
        "El import debe usar un alias claro (`enqueue as enqueueLabelPrintEntry`) para evitar colisiones.",
    );
    assert.ok(
        /QUEUE_REASONS\s+as\s+LABEL_QUEUE_REASONS/.test(src),
        "El import también debe traer el enum de motivos con alias.",
    );
});

test("Encolar ocurre DESPUÉS de bulk-receive OK y ANTES de limpiar receiveList", async () => {
    const code = stripComments(await readPage());
    const bulkIdx = code.indexOf("'/products/bulk-receive'");
    // Buscamos la llamada a enqueueLabelPrintEntry después del bulk-receive
    // (hay otra ocurrencia en los imports del tope del archivo, ignórala).
    const enqueueIdx = code.indexOf("enqueueLabelPrintEntry(", bulkIdx);
    // Y el setReceiveList([]) específicamente dentro de handleConfirmReceive
    // (que es DESPUÉS de bulkIdx).
    const clearIdx = code.indexOf("setReceiveList([])", bulkIdx);
    assert.ok(bulkIdx > 0, "Debe existir el POST a /products/bulk-receive.");
    assert.ok(enqueueIdx > 0, "Debe existir una llamada a enqueueLabelPrintEntry(...) tras bulk-receive.");
    assert.ok(clearIdx > 0, "Debe existir setReceiveList([]) después del bulk-receive para limpiar el carrito.");
    assert.ok(
        bulkIdx < enqueueIdx,
        "El enqueue debe ejecutarse DESPUÉS de que /products/bulk-receive responda OK.",
    );
    assert.ok(
        enqueueIdx < clearIdx,
        "El enqueue debe ejecutarse ANTES de limpiar el carrito con setReceiveList([]).",
    );
});

test("Encolar usa reason canónico PRICE_CHANGE + productBarcode + salePrice", async () => {
    const src = await readPage();
    assert.ok(
        /enqueueLabelPrintEntry[\s\S]*?reason:\s*LABEL_QUEUE_REASONS\.PRICE_CHANGE/.test(src),
        "El enqueue debe usar el motivo canónico PRICE_CHANGE.",
    );
    assert.ok(
        /enqueueLabelPrintEntry[\s\S]*?receptionRef,/.test(src),
        "El enqueue debe propagar `receptionRef` (único por lote).",
    );
    // Shape canónico: productBarcode (NO `barcode:`) y salePrice.
    assert.ok(
        /enqueueLabelPrintEntry[\s\S]*?productBarcode:\s*change\.item\.barcode/.test(src),
        "El enqueue debe pasar `productBarcode` (shape canónico; el helper acepta aliases legacy pero el caller nuevo DEBE emitir canónico).",
    );
    assert.ok(
        /enqueueLabelPrintEntry[\s\S]*?salePrice:\s*change\.newSalePrice/.test(src),
        "El enqueue debe pasar `salePrice: newSalePrice` para que la cola persista el precio actual del flujo PRICE_CHANGE.",
    );
    // Nunca debe emitir el alias legacy `barcode:` desde este call-site.
    const callSite = src.match(/enqueueLabelPrintEntry\(\s*window\.localStorage,\s*\{[\s\S]*?\}\s*\)/);
    assert.ok(callSite, "No se encontró la invocación enqueueLabelPrintEntry(...).");
    assert.ok(
        !/\bbarcode:/.test(callSite[0]),
        "El call-site NO debe usar el alias legacy `barcode:` — el caller nuevo emite `productBarcode`.",
    );
});

test("Encolar NUNCA hace POST a /labels/print-jobs (contrato: audit sólo en /labels)", async () => {
    const code = stripComments(await readPage());
    // En CÓDIGO EJECUTABLE no debe aparecer /labels/print-jobs (comentarios
    // de contrato que lo mencionan como invariante negativa están OK).
    assert.ok(
        !/\/labels\/print-jobs/.test(code),
        "receive/page.tsx NO debe POSTear a /labels/print-jobs (eso ocurre al imprimir en /labels).",
    );
});

test("Encolar nunca llama a /labels/codes (eso lo hace /labels al hidratar)", async () => {
    const code = stripComments(await readPage());
    assert.ok(
        !/\/labels\/codes/.test(code),
        "receive/page.tsx NO debe POSTear a /labels/codes al encolar.",
    );
});

// -----------------------------------------------------------------------------
// B — changedItems snapshot antes de limpiar
// -----------------------------------------------------------------------------

test("changedItems se calcula ANTES de setReceiveList([]) y ANTES de localStorage.remove", async () => {
    const code = stripComments(await readPage());
    const bulkIdx = code.indexOf("'/products/bulk-receive'");
    // Nos interesa el cómputo DENTRO de handleConfirmReceive, que vive
    // después del bulk-receive. Antes de bulk-receive hay otros usos
    // de setReceiveList([]) (handleClearList) que no cuentan.
    const changedIdx = code.indexOf("const changedItems", bulkIdx);
    const clearIdx = code.indexOf("setReceiveList([])", bulkIdx);
    assert.ok(bulkIdx > 0, "Debe existir el bulk-receive como anchor.");
    assert.ok(changedIdx > 0, "Debe existir la computación `const changedItems` tras bulk-receive.");
    assert.ok(clearIdx > 0, "Debe existir setReceiveList([]) tras bulk-receive.");
    assert.ok(changedIdx < clearIdx, "`changedItems` debe computarse antes de limpiar el estado React.");
    // localStorage.removeItem de la clave de recepción también debe estar
    // DESPUÉS del snapshot changedItems. Buscamos sólo DESPUÉS de bulkIdx.
    const lsRemoveIdx = code.indexOf("org-pos-reception-list", bulkIdx);
    assert.ok(
        lsRemoveIdx > changedIdx,
        "El removeItem de localStorage también debe ocurrir después del snapshot changedItems.",
    );
});

// -----------------------------------------------------------------------------
// B — Modal 'Zona de impresión'
// -----------------------------------------------------------------------------

test("Modal 'Zona de impresión' existe con estado dedicado priceZoneState", async () => {
    const src = await readPage();
    assert.ok(
        /const\s+\[priceZoneState,\s*setPriceZoneState\]\s*=\s*useState/.test(src),
        "Debe existir un state `priceZoneState` que controla el modal.",
    );
    assert.ok(
        /priceZoneState\.changes/.test(src),
        "El state debe exponer `changes` (lista de cambios de precio).",
    );
    assert.ok(
        /priceZoneState\.whatsappText/.test(src),
        "El state debe conservar el texto de WhatsApp (preserva feature anterior).",
    );
    assert.ok(
        /priceZoneState\.receptionRef/.test(src),
        "El state debe conservar el `receptionRef` del lote.",
    );
});

test("Modal 'Zona de impresión': botón 'Ir a zona de impresión' redirige a /labels", async () => {
    const src = await readPage();
    assert.ok(
        /data-testid="price-zone-go-to-labels"/.test(src),
        "El botón 'Ir a zona de impresión' debe tener data-testid='price-zone-go-to-labels'.",
    );
    // El TEXTO del botón debe ser COMPLETO: 'Ir a zona de impresión'
    // (contrato post-auditoría; antes decía sólo 'Ir a zona').
    assert.ok(
        /Ir a zona de impresión/.test(src),
        "El botón 'Ir a zona de impresión' debe mostrar el texto completo (no abreviado a 'Ir a zona').",
    );
    // Debe estar cableado a un handler EXPLÍCITO (sin pasar por onClose
    // del render-prop) y ese handler debe disparar router.push('/labels').
    assert.ok(
        /onPress=\{handlePriceZoneGoToLabels\}/.test(src),
        "El botón 'Ir a zona de impresión' debe cablearse al handler explícito handlePriceZoneGoToLabels.",
    );
    const handlerMatch = src.match(/const\s+handlePriceZoneGoToLabels\s*=\s*useCallback\([\s\S]*?\n\s*\},\s*\[/);
    assert.ok(handlerMatch, "Debe existir el handler handlePriceZoneGoToLabels como useCallback.");
    assert.ok(
        /router\.push\(['"]\/labels['"]\)/.test(handlerMatch[0]),
        "handlePriceZoneGoToLabels debe disparar router.push('/labels').",
    );
    // Y nunca programar un redirect al dashboard ni abrir el post modal:
    // eso rompería la elección explícita del usuario.
    assert.ok(
        !/setIsPostReceptionOpen\(true\)/.test(handlerMatch[0]),
        "handlePriceZoneGoToLabels NO debe abrir PostReceptionLabelsModal (el usuario eligió /labels).",
    );
    assert.ok(
        !/router\.push\(['"]\/dashboard['"]\)/.test(handlerMatch[0]),
        "handlePriceZoneGoToLabels NO debe programar un push al dashboard.",
    );
});

test("Modal 'Zona de impresión': botón 'Continuar/Finalizar' usa handler explícito que encadena a PostReceptionLabelsModal", async () => {
    const src = await readPage();
    assert.ok(
        /data-testid="price-zone-continue"/.test(src),
        "El botón 'Continuar' debe tener data-testid='price-zone-continue'.",
    );
    // El botón debe cablearse al handler explícito (no inline, para evitar
    // la carrera `onClose()` + acción).
    assert.ok(
        /onPress=\{handlePriceZoneContinue\}/.test(src),
        "El botón 'Continuar' debe cablearse al handler handlePriceZoneContinue.",
    );
    // El handler debe consultar postReceptionLines.length y abrir el
    // modal post-recepción si corresponde.
    const handlerMatch = src.match(/const\s+handlePriceZoneContinue\s*=\s*useCallback\([\s\S]*?\n\s*\},\s*\[/);
    assert.ok(handlerMatch, "Debe existir el handler handlePriceZoneContinue como useCallback.");
    assert.ok(
        /postReceptionLines\.length\s*>\s*0/.test(handlerMatch[0]),
        "handlePriceZoneContinue debe consultar postReceptionLines.length.",
    );
    assert.ok(
        /setIsPostReceptionOpen\(true\)/.test(handlerMatch[0]),
        "handlePriceZoneContinue debe abrir PostReceptionLabelsModal cuando hay stampedLines.",
    );
    // Y el label dinámico "Continuar"/"Finalizar" sigue vigente.
    const anchor = src.indexOf('data-testid="price-zone-continue"');
    const block = src.slice(Math.max(0, anchor - 1500), anchor + 500);
    assert.ok(
        /postReceptionLines\.length\s*>\s*0/.test(block),
        "El botón 'Continuar' debe decidir su texto por postReceptionLines.length.",
    );
});

test("Modal 'Zona de impresión': carrera eliminada — ningún botón combina onClose() con acción", async () => {
    const code = stripComments(await readPage());
    // El antipatrón previo era llamar `onClose()` del render-prop y luego
    // navegar o abrir otro modal en el mismo handler. Buscamos la ventana
    // del modal (de `priceZoneState.open` a `</Modal>`) y verificamos que
    // NO exista una secuencia `onClose(); ... router.push(` o
    // `onClose(); ... setIsPostReceptionOpen(true)`.
    const modalStart = code.indexOf("isOpen={priceZoneState.open}");
    assert.ok(modalStart > 0, "Debe existir el <Modal isOpen={priceZoneState.open}>.");
    const modalEnd = code.indexOf("</Modal>", modalStart);
    assert.ok(modalEnd > modalStart, "Debe cerrarse el </Modal>.");
    const modalScope = code.slice(modalStart, modalEnd);
    assert.ok(
        !/onClose\(\)\s*;?\s*[\s\S]{0,120}router\.push/.test(modalScope),
        "Prohibido onClose() seguido de router.push dentro del modal (carrera).",
    );
    assert.ok(
        !/onClose\(\)\s*;?\s*[\s\S]{0,120}setIsPostReceptionOpen/.test(modalScope),
        "Prohibido onClose() seguido de setIsPostReceptionOpen dentro del modal (carrera).",
    );
});

test("Modal 'Zona de impresión': texto explícito 'N productos fueron enviados a Zona de impresión para revisión posterior'", async () => {
    const src = await readPage();
    // La cadena en JSX viene plural/singular condicional, así que
    // permitimos cualquier contenido entre `enviados`/`enviado` y `a Zona`
    // (en el fuente real hay un `'}` + espacio).
    assert.ok(
        /productos fueron enviados[\s\S]{0,10}a Zona de impresión para revisión posterior/.test(src),
        "El modal debe mostrar el texto explícito 'N productos fueron enviados a Zona de impresión para revisión posterior'.",
    );
    // Y la singularización 'producto fue enviado' debe cubrir N=1.
    assert.ok(
        /producto fue enviado/.test(src),
        "El modal debe pluralizar correctamente (N=1 → 'producto fue enviado').",
    );
    assert.ok(
        /data-testid="price-zone-summary"/.test(src),
        "El párrafo resumen debe exponer data-testid='price-zone-summary'.",
    );
});

test("Modal 'Zona de impresión': handlers explícitos evitan doble navegación", async () => {
    const code = stripComments(await readPage());
    assert.ok(
        /onPress=\{handlePriceZoneGoToLabels\}/.test(code),
        "Ir a zona debe usar un handler explícito.",
    );
    assert.ok(
        /onPress=\{handlePriceZoneContinue\}/.test(code),
        "Continuar debe usar un handler explícito.",
    );
    assert.ok(
        /if \(!open && priceZoneState\.open\)[\s\S]*handlePriceZoneContinue\(\)/.test(code),
        "Sólo X/backdrop debe caer al handler Continuar.",
    );
    assert.ok(
        !/priceZoneIntentRef/.test(code),
        "No debe quedar una ref de intención que pueda contaminar la siguiente apertura.",
    );
});

test("Modal 'Zona de impresión': lista los cambios old→new con data-testid='price-zone-change-row'", async () => {
    const src = await readPage();
    assert.ok(
        /data-testid="price-zone-change-row"/.test(src),
        "Cada fila del listado debe tener data-testid='price-zone-change-row'.",
    );
    // Debe mostrar oldSalePrice y newSalePrice de cada entrada.
    assert.ok(
        /change\.oldSalePrice/.test(src),
        "El modal debe pintar `change.oldSalePrice`.",
    );
    assert.ok(
        /change\.newSalePrice/.test(src),
        "El modal debe pintar `change.newSalePrice`.",
    );
});

test("Modal 'Zona de impresión': preserva WhatsApp sharing (textarea escapado o botón)", async () => {
    const src = await readPage();
    // Mantenemos la funcionalidad "Enviar por WhatsApp" (feature anterior).
    assert.ok(
        /wa\.me/.test(src),
        "El modal (o sus handlers) debe preservar el flujo WhatsApp (wa.me) del contrato anterior.",
    );
    assert.ok(
        /priceZoneState\.whatsappText/.test(src),
        "El texto de WhatsApp debe venir del state del modal, no reconstruirse.",
    );
});

// -----------------------------------------------------------------------------
// B — Secuencia correcta price-modal → PostReceptionLabelsModal
// -----------------------------------------------------------------------------

test("Flujo: con changedItems > 0 NO abrimos PostReceptionLabelsModal inmediatamente", async () => {
    const code = stripComments(await readPage());
    // La rama `if (changedItems.length > 0)` NO debe contener
    // `setIsPostReceptionOpen(true)` ANTES del `else if`. Al abrir el
    // modal 'Zona de impresión' guardamos stampedLines en postReceptionLines
    // pero NO abrimos el otro modal hasta que el usuario pulse "Continuar".
    const branchStart = code.indexOf("if (changedItems.length > 0)");
    const elseBranchStart = code.indexOf("else if (stampedLines.length > 0)", branchStart);
    assert.ok(branchStart > 0, "Debe existir la rama `if (changedItems.length > 0)`.");
    assert.ok(elseBranchStart > branchStart, "Debe existir `else if (stampedLines.length > 0)` como rama alternativa.");
    const changedBranch = code.slice(branchStart, elseBranchStart);
    assert.ok(
        !/setIsPostReceptionOpen\(true\)/.test(changedBranch),
        "La rama changedItems > 0 NO debe abrir PostReceptionLabelsModal directamente (lo abre el botón 'Continuar').",
    );
    // Pero sí debe setPostReceptionLines(stampedLines) para no perderlos.
    assert.ok(
        /setPostReceptionLines\(stampedLines\)/.test(changedBranch),
        "La rama changedItems > 0 debe guardar stampedLines para la secuencia posterior.",
    );
    // Y debe abrir el priceZoneState.
    assert.ok(
        /setPriceZoneState\(\s*\{[\s\S]*?open:\s*true/.test(changedBranch),
        "La rama changedItems > 0 debe abrir el modal 'Zona de impresión'.",
    );
});

test("Flujo: sin changedItems pero con stampedLines → PostReceptionLabelsModal se abre directo", async () => {
    const code = stripComments(await readPage());
    const branchStart = code.indexOf("else if (stampedLines.length > 0)");
    const nextElse = code.indexOf("} else {", branchStart);
    assert.ok(branchStart > 0 && nextElse > branchStart, "Rama else-if debe existir.");
    const branch = code.slice(branchStart, nextElse);
    assert.ok(
        /setIsPostReceptionOpen\(true\)/.test(branch),
        "Sin changedItems pero con stampedLines, PostReceptionLabelsModal se abre.",
    );
    assert.ok(
        /setPendingPostReceptionRedirect\(true\)/.test(branch),
        "El redirect queda en espera hasta que el modal cierre.",
    );
});

test("Flujo: sin changedItems y sin stampedLines → router.push('/dashboard') con setTimeout", async () => {
    const code = stripComments(await readPage());
    // Rama default (fin del encadenamiento).
    const finalElse = code.lastIndexOf("router.push('/dashboard')");
    assert.ok(finalElse > 0, "Debe existir fallback de redirección al dashboard.");
    const scope = code.slice(finalElse - 200, finalElse + 50);
    assert.ok(
        /setTimeout\s*\(/.test(scope),
        "El redirect al dashboard debe estar envuelto en setTimeout para que el toast se vea.",
    );
});
