// =============================================================================
// tests/bold-qr-finalized-dedupe.test.mjs
//
// Guardianes del fix contra la DOBLE VENTA post-APROBADO del flujo QR
// Bold / Bre-B (migración 027, patch DispatchAutoSale).
//
// Contexto del bug:
//
//   El backend `DispatchAutoSale` crea la venta canónica después del
//   webhook y publica `qr_intent_update` con `status=APROBADO +
//   saleId + amountCop`. Antes del patch, el modal `ModalPagoBoldQR`
//   consumía ese frame y pasaba el control a
//   `UniversalPaymentModal.handleBoldQrApproved`, que llamaba a
//   `onPay(...)`. `onPay` disparaba `useNewSale.handleConfirmSale`,
//   el cual regeneraba un `clientTxId` fresco y hacía POST
//   `/sales/register` creando una SEGUNDA venta duplicada que
//   descontaba stock por partida doble.
//
// Nuevas invariantes:
//
//   F1. `StreamIntentPayload` acepta `saleId` (number|string) y
//       `amountCop` (number) como opcionales. El shape de `onApproved`
//       los propaga.
//   F2. `applyStreamPayload` extrae `saleId` y `amountCop` del
//       QREvent y los pasa al callback `onApproved`.
//   F3. UPM `handleBoldQrApproved`:
//        - cuando `info.saleId > 0`, llama a `onBoldQrFinalized({
//          ventaTempId, saleId, amountCop, reference, approvedAt,
//          approvedVia })` y JAMÁS llama a `onPay`.
//        - cuando `info.saleId` falta o es <=0, muestra un toast
//          "esperando conciliación" y tampoco llama a `onPay`.
//        - Elimina por completo la rama heredada que componía el
//          payload `transferSource: "BOLD_QR"` para `onPay`.
//   F4. UPM pasa el callback `onApproved={(info) => void
//       handleBoldQrApproved(info)}` para que `info` llegue entero.
//   F5. `sales/new/page.tsx` expone `handleBoldQrFinalized` cableado
//       a la prop del UPM. El callback:
//        - usa `notifyBoldQrApprovedOnce` (dedupe compartido con la
//          bandeja global `useBoldQrTray` → `handleQrTrayApproved`),
//        - cierra el UPM (`setIsPaymentDialogOpen(false)`),
//        - libera SÓLO el carrito activo vía
//          `confirmEnqueuedAndFreeCart()`,
//        - borra la entrada de `qrPreparationsRef`.
//   F6. `useBoldQrTray` sigue siendo la fuente del Set de dedupe:
//       `notifiedApprovedKeysRef`. Ambas rutas (modal + tray)
//       consultan el MISMO Set vía `notifyBoldQrApprovedOnce`.
//   F7. Dedupe lógico (prueba pura): dos invocaciones con el mismo
//       `ventaTempId` o `sale:<saleId>` sólo pintan la alerta una
//       vez y sólo liberan carrito una vez, independientemente del
//       orden de llegada (modal→tray o tray→modal).
//
// Todos los tests leen fuente o ejecutan helpers puros. No montan
// React.
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

async function readSrc(path) {
    return readFile(path, "utf8");
}

async function readWithoutComments(path) {
    const raw = await readFile(path, "utf8");
    return raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Extrae el bloque del primer `const <name> = useCallback(...)` incluyendo su
 * cierre `}, [...]);`. Lanza si no lo encuentra.
 */
function extractCallbackBody(src, name) {
    const idx = src.indexOf(`const ${name}`);
    assert.ok(idx > 0, `No se encontró declaración de ${name}.`);
    const end = src.indexOf("}, [", idx);
    assert.ok(end > idx, `No se encontró cierre del useCallback de ${name}.`);
    return src.slice(idx, end + 2);
}

// ---------------------------------------------------------------------------
// F1 + F2. StreamIntentPayload transporta saleId/amountCop
// ---------------------------------------------------------------------------

test("F1: StreamIntentPayload declara saleId (number|string) y amountCop (number) opcionales", async () => {
    const src = await readSrc(modalPath);
    const ifaceStart = src.indexOf("interface StreamIntentPayload");
    assert.ok(ifaceStart > 0, "La interfaz StreamIntentPayload debe existir.");
    const ifaceEnd = src.indexOf("}", ifaceStart);
    const iface = src.slice(ifaceStart, ifaceEnd + 1);
    assert.match(
        iface,
        /readonly\s+saleId\?\s*:\s*number\s*\|\s*string/,
        "StreamIntentPayload debe declarar `readonly saleId?: number | string` (uint64 del backend llega como number, resistente a gateways que stringifican).",
    );
    assert.match(
        iface,
        /readonly\s+amountCop\?\s*:\s*number/,
        "StreamIntentPayload debe declarar `readonly amountCop?: number`.",
    );
});

test("F2: applyStreamPayload lee payload.saleId + payload.amountCop y los pasa a onApproved", async () => {
    const src = await readSrc(modalPath);
    // Debe existir el acceso explícito a los dos campos nuevos.
    assert.match(src, /payload\s+as\s+\{\s*saleId\?/,
        "applyStreamPayload debe acceder a payload.saleId con una lectura tipada defensiva.");
    assert.match(src, /payload\s+as\s+\{\s*amountCop\?/,
        "applyStreamPayload debe acceder a payload.amountCop con una lectura tipada defensiva.");
    // La invocación de onApproved debe incluir saleId y amountCop.
    assert.match(
        src,
        /onApproved\(\s*\{[\s\S]*?saleId[\s\S]*?amountCop[\s\S]*?\}\s*\)/,
        "El setTimeout del approve debe invocar onApproved({ reference, approvedAt, approvedVia, saleId, amountCop }).",
    );
    // La firma del prop onApproved debe aceptar los dos campos.
    const propStart = src.indexOf("readonly onApproved:");
    assert.ok(propStart > 0, "La prop onApproved debe existir.");
    const propBlock = src.slice(propStart, src.indexOf("=>", propStart) + 40);
    assert.match(
        propBlock,
        /saleId\?\s*:\s*number/,
        "El shape del callback onApproved debe tipar saleId?: number.",
    );
    assert.match(
        propBlock,
        /amountCop\?\s*:\s*number/,
        "El shape del callback onApproved debe tipar amountCop?: number.",
    );
});

// ---------------------------------------------------------------------------
// F3. UPM.handleBoldQrApproved NUNCA llama onPay, delega a onBoldQrFinalized
// ---------------------------------------------------------------------------

test("F3a: UPM.handleBoldQrApproved acepta `info` con saleId y amountCop", async () => {
    const src = await readSrc(upmPath);
    const body = extractCallbackBody(src, "handleBoldQrApproved");
    assert.match(
        body,
        /\(info\?\s*:\s*\{[\s\S]*?saleId\?\s*:\s*number[\s\S]*?amountCop\?\s*:\s*number/,
        "El handler debe aceptar info con saleId/amountCop opcionales.",
    );
});

test("F3b: UPM.handleBoldQrApproved con saleId>0 llama a onBoldQrFinalized y NO a onPay", async () => {
    const src = await readSrc(upmPath);
    const body = extractCallbackBody(src, "handleBoldQrApproved");
    // Debe existir la invocación explícita.
    assert.match(
        body,
        /onBoldQrFinalized\(\s*\{/,
        "La rama saleId>0 debe invocar onBoldQrFinalized con el payload del backend.",
    );
    // Cero `onPay(` en el handler (ni await ni sin await).
    assert.ok(
        !/\bawait\s+onPay\s*\(/.test(body),
        "handleBoldQrApproved NO debe invocar `await onPay(`.",
    );
    assert.ok(
        !/\bonPay\s*\(/.test(body),
        "handleBoldQrApproved NO debe invocar `onPay(` en NINGUNA rama.",
    );
    // Cero composición de payload heredado "transferSource: 'BOLD_QR'".
    assert.ok(
        !/transferSource:\s*[\s\S]*?["']BOLD_QR["']/.test(body),
        "El payload heredado transferSource='BOLD_QR' quedó fuera del handler.",
    );
});

test("F3c: UPM pasa ventaTempId exacto desde boldSessionIdRef.current al onBoldQrFinalized", async () => {
    const src = await readSrc(upmPath);
    const body = extractCallbackBody(src, "handleBoldQrApproved");
    // El handler debe reutilizar el ventaTempId generado al abrir el
    // modal (no inventar uno nuevo).
    assert.match(
        body,
        /ventaTempId\s*=\s*typeof\s+boldSessionIdRef\.current/,
        "El handler debe leer boldSessionIdRef.current para componer ventaTempId.",
    );
    // Y debe pasarlo literalmente al callback onBoldQrFinalized.
    assert.match(
        body,
        /onBoldQrFinalized\(\s*\{[\s\S]*?ventaTempId[\s\S]*?saleId[\s\S]*?\}\s*\)/,
        "La invocación debe incluir ventaTempId y saleId.",
    );
    // No debe regenerar un UUID aquí.
    assert.ok(
        !/randomUUID\(/.test(body),
        "El handler NO debe generar un ventaTempId nuevo al aprobar.",
    );
});

test("F3d: UPM saleId<=0 muestra toast de conciliación y NO llama onPay", async () => {
    const src = await readSrc(upmPath);
    const body = extractCallbackBody(src, "handleBoldQrApproved");
    assert.match(
        body,
        /ESPERANDO\s+CONCILIACI[OÓ]N/i,
        "La rama saleId<=0 debe pintar un toast informativo (copy 'esperando conciliación').",
    );
    // Y seguir sin tocar onPay.
    assert.ok(
        !/\bonPay\s*\(/.test(body),
        "La rama saleId<=0 tampoco puede caer a onPay.",
    );
});

test("F3e: UPM no mantiene imports residuales del flujo heredado de BOLD_QR→onPay", async () => {
    const src = await readWithoutComments(upmPath);
    // El fallback heredado componía `boldDelta` y mezclaba canales.
    // Si queda rastro ejecutable (fuera de comentarios) el guardián salta.
    assert.ok(
        !/boldDelta\s*=/.test(src),
        "El cálculo `boldDelta` del flujo heredado debe estar eliminado del runtime.",
    );
    assert.ok(
        !/finalNequi\s*\+\s*finalDaviplata\s*\+\s*boldDelta/.test(src),
        "La suma `finalNequi + finalDaviplata + boldDelta` del flujo heredado debe eliminarse.",
    );
});

// ---------------------------------------------------------------------------
// F4. UPM pasa info completa al handleBoldQrApproved
// ---------------------------------------------------------------------------

test("F4: UPM wire `onApproved={(info) => void handleBoldQrApproved(info)}`", async () => {
    const src = await readSrc(upmPath);
    assert.match(
        src,
        /onApproved=\{\(info\)\s*=>\s*\{\s*void\s+handleBoldQrApproved\(info\)/,
        "El UPM debe pasar `info` al handler para no perder saleId/amountCop.",
    );
    // La forma vieja sin argumento no debe sobrevivir.
    assert.ok(
        !/onApproved=\{\(\s*\)\s*=>\s*\{\s*void\s+handleBoldQrApproved\(\s*\)/.test(src),
        "La forma antigua `onApproved={() => void handleBoldQrApproved()}` debe quedar eliminada.",
    );
});

// ---------------------------------------------------------------------------
// F5. sales/new/page.tsx expone handleBoldQrFinalized y lo cablea al UPM
// ---------------------------------------------------------------------------

test("F5a: sales/new/page.tsx define handleBoldQrFinalized como useCallback", async () => {
    const src = await readSrc(salesNewPagePath);
    const body = extractCallbackBody(src, "handleBoldQrFinalized");
    assert.match(
        body,
        /saleId:\s*number/,
        "handleBoldQrFinalized debe tipar `saleId: number` en su firma.",
    );
    assert.match(
        body,
        /ventaTempId:\s*string/,
        "handleBoldQrFinalized debe tipar `ventaTempId: string` en su firma.",
    );
});

test("F5b: handleBoldQrFinalized dedupe compartido via notifyBoldQrApprovedOnce", async () => {
    const src = await readSrc(salesNewPagePath);
    const body = extractCallbackBody(src, "handleBoldQrFinalized");
    assert.match(
        body,
        /notifyBoldQrApprovedOnce\s*\(/,
        "handleBoldQrFinalized debe pasar por el helper de dedupe compartido.",
    );
    // Debe cerrar el UPM.
    assert.match(
        body,
        /setIsPaymentDialogOpen\(\s*false\s*\)/,
        "handleBoldQrFinalized debe cerrar el UniversalPaymentModal.",
    );
    // Y liberar sólo el carrito activo.
    assert.match(
        body,
        /confirmEnqueuedAndFreeCart\(\s*\)/,
        "handleBoldQrFinalized debe liberar sólo el carrito activo con confirmEnqueuedAndFreeCart().",
    );
    // Y limpiar el reopen payload para no reabrir el QR por accidente.
    assert.match(
        body,
        /setBoldQrReopenPayload\(\s*null\s*\)/,
        "handleBoldQrFinalized debe limpiar el boldQrReopenPayload.",
    );
    // NUNCA debe llamar a `handleConfirmSale` (eso es el flujo
    // heredado que creaba la segunda venta).
    assert.ok(
        !/handleConfirmSale\s*\(/.test(body),
        "handleBoldQrFinalized NO debe invocar handleConfirmSale.",
    );
});

test("F5c: handleQrTrayApproved comparte el mismo helper de dedupe y NO toca carritos", async () => {
    const src = await readSrc(salesNewPagePath);
    const body = extractCallbackBody(src, "handleQrTrayApproved");
    assert.match(
        body,
        /notifyBoldQrApprovedOnce\s*\(/,
        "handleQrTrayApproved debe reusar notifyBoldQrApprovedOnce (fuente única de dedupe).",
    );
    // La ruta tray NO libera carritos (el cajero puede estar atendiendo
    // otra factura cuando la bandeja aprueba).
    assert.ok(
        !/confirmEnqueuedAndFreeCart\s*\(/.test(body),
        "handleQrTrayApproved NO debe liberar carrito (ruta exclusiva de la ruta modal).",
    );
    assert.ok(
        !/setIsPaymentDialogOpen\(/.test(body),
        "handleQrTrayApproved NO debe cerrar el UPM (ruta exclusiva de la ruta modal).",
    );
});

test("F5d: notifyBoldQrApprovedOnce usa un único Set compartido (notifiedApprovedKeysRef)", async () => {
    const src = await readSrc(salesNewPagePath);
    // El guard global que el modal + la bandeja consultan.
    const refDecl = src.indexOf("notifiedApprovedKeysRef");
    assert.ok(refDecl > 0, "El ref notifiedApprovedKeysRef debe estar definido en page.tsx.");
    assert.match(
        src,
        /notifiedApprovedKeysRef\s*=\s*useRef<Set<string>>/,
        "El guard debe ser un Set<string> estable (useRef).",
    );
    // El helper debe consultar ese Set antes de activar los efectos.
    const helperBody = extractCallbackBody(src, "notifyBoldQrApprovedOnce");
    assert.match(
        helperBody,
        /notifiedApprovedKeysRef\.current\.has\(/,
        "notifyBoldQrApprovedOnce debe consultar el Set antes de activar los efectos.",
    );
    assert.match(
        helperBody,
        /notifiedApprovedKeysRef\.current\.add\(/,
        "notifyBoldQrApprovedOnce debe marcar la clave tras ejecutar los efectos.",
    );
});

test("F5e: page.tsx cablea onBoldQrFinalized al UniversalPaymentModal", async () => {
    const src = await readSrc(salesNewPagePath);
    assert.match(
        src,
        /onBoldQrFinalized=\{[^}]*handleBoldQrFinalized[^}]*\}/,
        "page.tsx debe pasar handleBoldQrFinalized a UniversalPaymentModal (deshabilitado en edit mode está permitido).",
    );
});

// ---------------------------------------------------------------------------
// F7. Dedupe lógico puro — simular dos entradas concurrentes
// ---------------------------------------------------------------------------

test("F7a: la clave de dedupe prioriza ventaTempId y cae a `sale:<saleId>`", () => {
    // Replicamos la lógica pura de normalizeBoldQrKey para que el
    // guardian viva en test sin montar React. El contrato está
    // documentado por extenso en page.tsx (`normalizeBoldQrKey`).
    const normalize = (info) => {
        const venta = typeof info.ventaTempId === "string" ? info.ventaTempId.trim() : "";
        if (venta) return venta;
        if (typeof info.saleId === "number" && Number.isFinite(info.saleId) && info.saleId > 0) {
            return `sale:${info.saleId}`;
        }
        return "";
    };
    assert.equal(normalize({ ventaTempId: "vt_abc", saleId: 10 }), "vt_abc");
    assert.equal(normalize({ ventaTempId: "   vt_abc   ", saleId: 10 }), "vt_abc");
    assert.equal(normalize({ ventaTempId: "", saleId: 10 }), "sale:10");
    assert.equal(normalize({ saleId: 10 }), "sale:10");
    assert.equal(normalize({ saleId: 0 }), "");
    assert.equal(normalize({ saleId: -3 }), "");
    assert.equal(normalize({}), "");
    assert.equal(normalize({ ventaTempId: 42 }), "");
});

test("F7b: dedupe concurrente (modal + tray) → UNA alerta, UN cart release", () => {
    // Simulación del `notifyBoldQrApprovedOnce` combinado con las
    // acciones exclusivas del modal. Replica contratos documentados
    // de page.tsx — si el patrón cambiara, actualizar la simulación
    // también.
    const notifiedKeys = new Set();
    const effects = {
        alert: 0,
        sound: 0,
        prepCleared: 0,
        cartReleased: 0,
        upmClosed: 0,
    };

    const normalize = (info) => {
        const venta = typeof info.ventaTempId === "string" ? info.ventaTempId.trim() : "";
        if (venta) return venta;
        if (typeof info.saleId === "number" && info.saleId > 0) return `sale:${info.saleId}`;
        return "";
    };

    const notifyOnce = (info) => {
        const key = normalize(info);
        if (!key) return false;
        if (notifiedKeys.has(key)) return false;
        notifiedKeys.add(key);
        effects.alert++;
        effects.sound++;
        effects.prepCleared++;
        return true;
    };

    const handleTray = (info) => {
        notifyOnce(info);
        // Tray NO toca carritos: el cajero puede estar en otro.
    };

    const handleModalFinalized = (info) => {
        if (!(typeof info.saleId === "number" && info.saleId > 0)) return;
        notifyOnce({ ventaTempId: info.ventaTempId, saleId: info.saleId });
        // Acciones exclusivas del modal (fuera del dedupe porque el
        // modal garantiza `onApproved` una sola vez por sesión).
        effects.upmClosed++;
        effects.cartReleased++;
    };

    // Escenario 1: Tray llega primero, Modal después.
    const info1 = { ventaTempId: "vt_a", saleId: 101 };
    handleTray(info1);
    handleModalFinalized(info1);
    assert.equal(effects.alert, 1, "El alert debe sonar UNA vez (tray fue primero).");
    assert.equal(effects.sound, 1, "El sonido debe sonar UNA vez.");
    assert.equal(effects.prepCleared, 1, "La preparación se limpia UNA vez.");
    assert.equal(effects.cartReleased, 1, "El carrito se libera UNA vez (ruta modal).");
    assert.equal(effects.upmClosed, 1, "El UPM se cierra UNA vez (ruta modal).");

    // Escenario 2: Modal llega primero, Tray después (reset de contadores).
    effects.alert = 0;
    effects.sound = 0;
    effects.prepCleared = 0;
    effects.cartReleased = 0;
    effects.upmClosed = 0;
    notifiedKeys.clear();
    const info2 = { ventaTempId: "vt_b", saleId: 202 };
    handleModalFinalized(info2);
    handleTray(info2);
    assert.equal(effects.alert, 1, "El alert debe sonar UNA vez (modal fue primero).");
    assert.equal(effects.sound, 1);
    assert.equal(effects.cartReleased, 1);
    assert.equal(effects.upmClosed, 1);

    // Escenario 3: dos tray repetidos (sin modal) → NO libera carrito,
    // alerta UNA vez.
    effects.alert = 0;
    effects.cartReleased = 0;
    effects.upmClosed = 0;
    notifiedKeys.clear();
    const info3 = { ventaTempId: "vt_c", saleId: 303 };
    handleTray(info3);
    handleTray(info3);
    assert.equal(effects.alert, 1, "Dos tray repetidos: alerta UNA vez.");
    assert.equal(effects.cartReleased, 0, "Tray nunca libera carrito.");
    assert.equal(effects.upmClosed, 0, "Tray nunca cierra UPM.");

    // Escenario 4: saleId=0 llega al modal → NO libera carrito y NO
    // activa dedupe (porque no hay saleId válido ni para la clave).
    effects.alert = 0;
    effects.cartReleased = 0;
    effects.upmClosed = 0;
    notifiedKeys.clear();
    handleModalFinalized({ ventaTempId: "vt_d", saleId: 0 });
    assert.equal(effects.alert, 0, "saleId=0 NO dispara efectos post-commit.");
    assert.equal(effects.cartReleased, 0, "saleId=0 NO libera carrito (defensa).");
    assert.equal(effects.upmClosed, 0);
});
