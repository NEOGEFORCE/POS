// =============================================================================
// tests/drawer-kick-decoupled-contract.test.mjs
//
// Guardia contractual del desacople total del pulso lateral POS-VENTA
// respecto a la impresión.
//
// Reglas blindadas aquí:
//
//   R1. En `useNewSale.handleConfirmSale`, la respuesta 201 de
//       /sales/register se CAPTURA y su `id` (o `saleId`/`SaleID` legacy)
//       se extrae con `extractSaleIdFromRegisterResponse` y se pasa como
//       4º argumento a `finalizeLocalSale`. El resultado llega a
//       `lastReceipt.saleId` sólo cuando es un entero positivo.
//
//   R2. En offline (addToSyncQueue) y en modo edición, `finalizeLocalSale`
//       se llama SIN el 4º argumento: no se inventa un saleId.
//
//   R3. En `UniversalPaymentModal`, `dispatchDrawerKickOnSale`:
//         - Audita a /cash-drawer/open ANTES de llamar al bridge.
//         - Adjunta `saleId` al body del audit SÓLO cuando es entero
//           positivo (`Number.isInteger(saleIdForAudit) && saleIdForAudit > 0`).
//         - Llama DIRECTAMENTE `window.posBridge.kickDrawer({...})` si
//           está disponible; nunca pasa por `hasPosBridgePrint` (ese
//           helper mide la ruta de IMPRESIÓN, no la del pulso lateral).
//         - NO depende de `autoPrint`, `receipt.deliveryMode` ni
//           `hasPosBridgePrint`.
//         - Devuelve un resultado estructurado que el orquestador usa
//           para emitir toast NO BLOQUEANTE en los 3 fallos laterales
//           (audit-failed / bridge-missing / bridge-failed).
//         - El bloque siempre captura excepciones y nunca propaga: la
//           venta jamás se revierte ni marca como fallida por el pulso.
//
//   R4. El orquestador postventa:
//         - Es single-fire con `didSaleCompletionEffectsRef`.
//         - Deps array del useEffect es `[showSuccessScreen]` únicamente.
//         - BEFORE_PRINT → kick → auto-print → (no AFTER kick).
//         - AFTER_PRINT  → auto-print → kick (incluso cuando autoPrint
//           está activo y la impresión directa falla; `dispatchAutoPrint`
//           no lanza).
//         - MANUAL nunca dispara el pulso lateral.
//         - El toggle de auto-print solo persiste; no re-dispara nada.
//
//   R5. La reimpresión manual (SaleDetailModal / sales page) nunca llama
//       a `kickDrawer`. Esto se cubre en `drawer-on-sale-complete.test.mjs`
//       y se re-verifica aquí para blindar el contrato.
//
// Son tests ESTÁTICOS (lectura de fuente): no ejercen React en runtime.
// Para fallar temprano con mensajes claros, cada aserción documenta la
// invariante que viola.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const paymentModalPath = join(repoRoot, "src", "components", "shared", "UniversalPaymentModal.tsx");
const useNewSalePath = join(repoRoot, "src", "app", "(app)", "sales", "new", "hooks", "useNewSale.ts");
const saleDetailModalPath = join(repoRoot, "src", "app", "(app)", "sales", "components", "SaleDetailModal.tsx");
const salesPagePath = join(repoRoot, "src", "app", "(app)", "sales", "page.tsx");

async function read(path) {
  return readFile(path, "utf8");
}

/**
 * Balancea paréntesis desde `start` hasta cerrar el bloque, incluyendo el
 * `;` final si está presente. Permite extraer un `useEffect(...)` o un
 * `useCallback(..., [])` completo sin asumir un formato específico de
 * salto de línea.
 */
function sliceBalancedCall(source, start) {
  let depth = 0;
  let i = start;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  while (i < source.length && source[i] !== ";") i++;
  return source.slice(start, i + 1);
}

function extractDispatcher(source) {
  const start = source.indexOf("const dispatchDrawerKickOnSale");
  assert.ok(start > 0, "No se encontró `const dispatchDrawerKickOnSale` en UniversalPaymentModal.");
  // El dispatcher es un useCallback(async (cfg) => { ... }, []);
  const useCbStart = source.indexOf("useCallback(", start);
  assert.ok(useCbStart > start, "No se encontró el useCallback del dispatcher.");
  return sliceBalancedCall(source, useCbStart);
}

function extractNotifier(source) {
  const start = source.indexOf("const notifyDrawerKickResult");
  assert.ok(start > 0, "No se encontró `const notifyDrawerKickResult` en UniversalPaymentModal.");
  const useCbStart = source.indexOf("useCallback(", start);
  assert.ok(useCbStart > start, "El notifier debe estar envuelto en useCallback para no depender de identidades frescas por render.");
  return sliceBalancedCall(source, useCbStart);
}

function extractOrchestratorEffect(source) {
  const marker = "Auto-impresión persistente y cajón al completar venta";
  const start = source.indexOf(marker);
  assert.ok(start > 0, "No se encontró el marcador del orquestador postventa.");
  const effectStart = source.indexOf("useEffect(", start);
  assert.ok(effectStart > start, "No se encontró el useEffect del orquestador postventa.");
  return sliceBalancedCall(source, effectStart);
}

function extractFinalizeLocalSale(source) {
  const start = source.indexOf("const finalizeLocalSale");
  assert.ok(start > 0, "No se encontró `const finalizeLocalSale` en useNewSale.");
  // Es una function expression normal: `const finalizeLocalSale = (...) => { ... };`
  const arrowStart = source.indexOf("=> {", start);
  assert.ok(arrowStart > start, "El cuerpo de finalizeLocalSale debe ser un arrow con bloque.");
  const bodyStart = source.indexOf("{", arrowStart);
  let depth = 0;
  let i = bodyStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return source.slice(start, i + 1);
}

// ---------------------------------------------------------------------------
// R1 — useNewSale captura `id` del 201 y lo pasa a finalizeLocalSale
// ---------------------------------------------------------------------------

test("useNewSale: existe `extractSaleIdFromRegisterResponse` que exige entero positivo", async () => {
  const src = await read(useNewSalePath);
  assert.match(src, /function\s+extractSaleIdFromRegisterResponse/,
    "El helper debe estar nombrado explícitamente para ser auditable y testeable.");
  assert.match(src, /Number\.isInteger/,
    "El helper DEBE validar `Number.isInteger` antes de aceptar un id.");
  // Debe considerar tanto `id` (contrato canónico) como el fallback legacy.
  assert.match(src, /bag\.id/, "Debe mirar `bag.id` (contrato canónico).");
  assert.match(src, /bag\.saleId/, "Debe tolerar `bag.saleId` legacy.");
});

test("useNewSale: la rama de /sales/register captura el response y pasa serverSaleId", async () => {
  const src = await read(useNewSalePath);
  // La llamada al endpoint debe estar seguida de la captura del response y
  // la extracción del id sólo cuando `isEditMode` es false y el endpoint
  // es exactamente /sales/register.
  const regIdx = src.indexOf("'/sales/register'");
  assert.ok(regIdx > 0, "No se encontró la ruta '/sales/register'.");
  const afterReg = src.slice(regIdx);
  assert.match(afterReg, /const\s+registerResponse\s*=\s*await\s+apiFetch<Record<string,\s*unknown>>/,
    "El fetch debe capturar el 201 en una variable tipada (`const registerResponse = await apiFetch<Record<string, unknown>>(...)`).");
  assert.match(afterReg, /extractSaleIdFromRegisterResponse\(registerResponse\)/,
    "La extracción del id debe pasar por el helper validado sobre el response capturado.");
  assert.match(afterReg, /finalizeLocalSale\(itemsToPay,\s*saleData,\s*change,\s*serverSaleId\)/,
    "finalizeLocalSale debe recibir serverSaleId como 4º argumento en la rama online.");
  // Guard explícito contra la regresión: ni edit mode ni rutas diferentes
  // deben caer en la extracción.
  assert.match(afterReg, /!isEditMode\s*&&\s*endpointPath\s*===\s*'\/sales\/register'/,
    "Sólo la ruta /sales/register fuera de edit mode puede propagar serverSaleId.");
});

test("useNewSale: la rama offline NO pasa saleId (nunca inventa un id)", async () => {
  const src = await read(useNewSalePath);
  // En la rama offline, el call a finalizeLocalSale debe tener EXACTAMENTE
  // 3 argumentos. El guardia estático se asegura localizando el bloque de
  // `addToSyncQueue` y comprobando que la llamada subsiguiente a
  // finalizeLocalSale no cita `serverSaleId` ni ningún 4º parámetro.
  const offlineStart = src.indexOf("addToSyncQueue");
  assert.ok(offlineStart > 0, "No se encontró el bloque offline (addToSyncQueue).");
  const offlineBlock = src.slice(offlineStart, offlineStart + 1200);
  const finalizeMatch = offlineBlock.match(/finalizeLocalSale\(([^)]*)\)/);
  assert.ok(finalizeMatch, "finalizeLocalSale debe seguir llamándose en la rama offline.");
  const args = finalizeMatch[1].split(",").map(s => s.trim());
  assert.strictEqual(args.length, 3,
    `La rama offline debe pasar exactamente 3 argumentos a finalizeLocalSale (itemsToPay, saleData, change). ` +
    `Encontrados: [${args.join(", ")}]`);
});

test("useNewSale: finalizeLocalSale fija lastReceipt.saleId sólo si serverSaleId es entero positivo", async () => {
  const src = await read(useNewSalePath);
  const body = extractFinalizeLocalSale(src);
  // La firma debe admitir el 4º argumento opcional.
  assert.match(body, /const finalizeLocalSale\s*=\s*\([^)]*serverSaleId\?/,
    "finalizeLocalSale debe aceptar `serverSaleId?: number` como 4º argumento opcional.");
  // Y el shape de lastReceipt debe traer la rama saleId con guard de entero positivo.
  assert.match(body, /saleId:\s*typeof\s+serverSaleId\s*===\s*['"]number['"][\s\S]*Number\.isInteger\(serverSaleId\)[\s\S]*serverSaleId\s*>\s*0/,
    "lastReceipt.saleId debe validar typeof + Number.isInteger + > 0 antes de aceptar el id.");
});

// ---------------------------------------------------------------------------
// R3 — Dispatcher audit-first, con saleId, directo al bridge
// ---------------------------------------------------------------------------

test("Dispatcher: audita ANTES de kickear y en ese orden", async () => {
  const src = await read(paymentModalPath);
  const dispatcher = extractDispatcher(src);
  const auditIdx = dispatcher.indexOf('"/cash-drawer/open"');
  const kickIdx = dispatcher.indexOf("kickDrawer(");
  assert.ok(auditIdx >= 0 && kickIdx > auditIdx,
    "La auditoría a /cash-drawer/open DEBE suceder antes del kickDrawer.");
});

test("Dispatcher: adjunta `saleId` al audit sólo si es entero positivo", async () => {
  const src = await read(paymentModalPath);
  const dispatcher = extractDispatcher(src);
  // Debe leer el saleId desde el ref ya sincronizado con lastReceipt.
  assert.match(dispatcher, /lastReceiptSaleIdRef\.current/,
    "El dispatcher debe leer el saleId desde lastReceiptSaleIdRef.current.");
  // Y debe validar entero positivo antes de añadirlo al body.
  assert.match(dispatcher, /Number\.isInteger\(saleIdForAudit\)[\s\S]{0,80}saleIdForAudit\s*>\s*0/,
    "El dispatcher DEBE validar `Number.isInteger` + `> 0` antes de incluir saleId en el audit body.");
  assert.match(dispatcher, /auditBody\.saleId\s*=\s*saleIdForAudit/,
    "El dispatcher debe asignar saleIdForAudit a `auditBody.saleId` cuando aplique.");
});

test("Dispatcher: NO depende de autoPrint, receipt.deliveryMode ni hasPosBridgePrint", async () => {
  const src = await read(paymentModalPath);
  const dispatcher = extractDispatcher(src);
  assert.doesNotMatch(dispatcher, /\bautoPrint\b/,
    "El dispatcher NO puede consultar `autoPrint`: el pulso lateral es independiente de la tirilla.");
  assert.doesNotMatch(dispatcher, /receipt\.deliveryMode/,
    "El dispatcher NO puede consultar `receipt.deliveryMode`: el canal del recibo no condiciona el pulso lateral.");
  assert.doesNotMatch(dispatcher, /hasPosBridgePrint\s*\(/,
    "El dispatcher NO puede llamar a `hasPosBridgePrint`: ese helper mide la ruta de IMPRESIÓN, no la lateral.");
});

test("Dispatcher: llama DIRECTAMENTE `window.posBridge.kickDrawer` cuando está disponible", async () => {
  const src = await read(paymentModalPath);
  const dispatcher = extractDispatcher(src);
  assert.match(dispatcher, /typeof\s+w\.posBridge\.kickDrawer\s*!==\s*["']function["']/,
    "El dispatcher debe comprobar la existencia de kickDrawer en el bridge antes de invocarla.");
  assert.match(dispatcher, /await\s+w\.posBridge\.kickDrawer\(/,
    "El dispatcher debe invocar directamente `window.posBridge.kickDrawer({...})`, sin pasar por helpers de impresión.");
  // Y el payload sigue llevando el contexto completo del evento (BEFORE/AFTER).
  assert.match(dispatcher, /openDrawerOnSale:\s*true/);
  assert.match(dispatcher, /event:\s*cfg\.drawer\.event/);
});

test("Dispatcher: devuelve resultado estructurado con los 4 estados contractuales", async () => {
  const src = await read(paymentModalPath);
  const dispatcher = extractDispatcher(src);
  assert.match(dispatcher, /return\s*\{\s*status:\s*["']ok["']\s*\}/,
    "Debe devolver `{status:'ok'}` tras un pulso aceptado por el bridge.");
  assert.match(dispatcher, /return\s*\{\s*status:\s*["']audit-failed["']/,
    "Debe devolver `{status:'audit-failed'}` si la auditoría falla.");
  assert.match(dispatcher, /return\s*\{\s*status:\s*["']bridge-missing["']\s*\}/,
    "Debe devolver `{status:'bridge-missing'}` cuando no hay kickDrawer disponible.");
  assert.match(dispatcher, /return\s*\{\s*status:\s*["']bridge-failed["']/,
    "Debe devolver `{status:'bridge-failed'}` cuando el bridge rechaza el pulso.");
});

test("Dispatcher: nunca lanza (los try/catch envuelven audit y kick)", async () => {
  const src = await read(paymentModalPath);
  const dispatcher = extractDispatcher(src);
  // Para fallar fuerte si alguien quita cualquiera de los dos try/catch.
  const tryCount = (dispatcher.match(/\btry\s*\{/g) ?? []).length;
  assert.ok(tryCount >= 2,
    `El dispatcher debe tener al menos 2 bloques try/catch (audit + kick). Encontrados: ${tryCount}.`);
  assert.doesNotMatch(dispatcher, /throw\s+new\s+Error/,
    "El dispatcher NO debe lanzar errores propios: la venta nunca se revierte por el pulso lateral.");
});

// ---------------------------------------------------------------------------
// Notificador (toast) — avisos claros y no bloqueantes
// ---------------------------------------------------------------------------

test("Notifier: emite toast NO BLOQUEANTE para cada fallo lateral", async () => {
  const src = await read(paymentModalPath);
  const notifier = extractNotifier(src);
  assert.match(notifier, /status\s*===\s*["']ok["'][\s\S]{0,20}return/,
    "Un resultado `ok` NO debe emitir toast.");
  // Toast para audit-failed
  assert.match(notifier, /status\s*===\s*["']audit-failed["']/);
  // Toast para bridge-missing
  assert.match(notifier, /status\s*===\s*["']bridge-missing["']/);
  // Rama por defecto para bridge-failed (via toast final).
  const toastCount = (notifier.match(/toast\(\{/g) ?? []).length;
  assert.ok(toastCount >= 3,
    `El notifier debe emitir hasta 3 toasts distintos (audit/bridge-missing/bridge-failed). Encontrados: ${toastCount}.`);
  // Todos los toasts deben llevar `variant: "destructive"` para resaltar el aviso lateral.
  const destructiveCount = (notifier.match(/variant:\s*["']destructive["']/g) ?? []).length;
  assert.ok(destructiveCount >= 3,
    "Los 3 toasts del notifier deben usar `variant: 'destructive'` para que el cajero note el aviso.");
});

test("Notifier: no menciona la palabra prohibida en los toasts (guardia visible)", async () => {
  const src = await read(paymentModalPath);
  const notifier = extractNotifier(src);
  // `drawer-visible-strings-hidden.test.mjs` cubre todo el archivo; aquí lo
  // reforzamos sólo sobre el notifier para fallar más temprano si alguien
  // reintroduce la palabra en una copy nueva.
  assert.doesNotMatch(notifier, /caj[oó]n/i,
    "Los toasts laterales NO pueden mencionar la palabra prohibida.");
});

// ---------------------------------------------------------------------------
// R4 — Orquestador postventa: single-fire, orden, MANUAL excluido
// ---------------------------------------------------------------------------

test("Orquestador: usa resultado del dispatcher para notificar fallos", async () => {
  const src = await read(paymentModalPath);
  const effect = extractOrchestratorEffect(src);
  // Debe asignar el resultado y llamar al notifier en AMBAS ramas BEFORE/AFTER.
  const okCount = (effect.match(/const result\s*=\s*await\s+dispatchDrawerKickOnSale\(cfg\)/g) ?? []).length;
  assert.ok(okCount >= 2,
    "El orquestador debe capturar `result` del dispatcher en BEFORE_PRINT y AFTER_PRINT. Encontrados: " + okCount + ".");
  const notifyCount = (effect.match(/notifyDrawerKickResult\(result\)/g) ?? []).length;
  assert.ok(notifyCount >= 2,
    "El orquestador debe llamar a notifyDrawerKickResult(result) en AMBAS ramas BEFORE_PRINT y AFTER_PRINT. Encontrados: " + notifyCount + ".");
});

test("Orquestador: AFTER_PRINT se intenta aunque autoPrint esté activo y falle", async () => {
  const src = await read(paymentModalPath);
  const effect = extractOrchestratorEffect(src);
  // La única garantía estática posible: `dispatchAutoPrint` se await-ea
  // antes del kick AFTER_PRINT, pero su resultado NO condiciona el kick
  // (no hay guard `if (printOk)` alrededor del AFTER kick).
  const printIdx = effect.indexOf("await dispatchAutoPrint()");
  const afterKickIdx = effect.indexOf("DRAWER_EVENTS.AFTER_PRINT", printIdx);
  assert.ok(printIdx > 0 && afterKickIdx > printIdx,
    "El AFTER_PRINT kick debe ejecutarse después de dispatchAutoPrint, no en lugar de él.");
  // Entre el print y el AFTER kick NO puede haber un `if (!...)` que lo
  // omita basado en el resultado del print.
  const between = effect.slice(printIdx, afterKickIdx);
  assert.doesNotMatch(between, /if\s*\(!/, 
    "No puede haber un guard negativo entre dispatchAutoPrint y el AFTER_PRINT kick: el pulso lateral es independiente.");
});

test("Orquestador: MANUAL nunca dispara el pulso lateral", async () => {
  const src = await read(paymentModalPath);
  const effect = extractOrchestratorEffect(src);
  assert.match(effect, /cfg\.drawer\.event\s*!==\s*DRAWER_EVENTS\.MANUAL/,
    "`shouldKick` DEBE excluir explícitamente DRAWER_EVENTS.MANUAL.");
});

test("Orquestador: BEFORE/AFTER son ramas excluyentes (una u otra, nunca ambas)", async () => {
  const src = await read(paymentModalPath);
  const effect = extractOrchestratorEffect(src);
  // Cada rama exige el `===` con una constante distinta. No hay forma de
  // ejecutar las dos simultáneamente porque `cfg.drawer.event` es un enum.
  assert.match(effect, /cfg\.drawer\.event\s*===\s*DRAWER_EVENTS\.BEFORE_PRINT/);
  assert.match(effect, /cfg\.drawer\.event\s*===\s*DRAWER_EVENTS\.AFTER_PRINT/);
});

test("Orquestador: deps únicamente `[showSuccessScreen]`, single-fire preservado", async () => {
  const src = await read(paymentModalPath);
  const effect = extractOrchestratorEffect(src);
  assert.match(effect, /didSaleCompletionEffectsRef\.current\s*=\s*true/,
    "El single-fire se asegura con `didSaleCompletionEffectsRef.current = true`.");
  // Encontramos el `}, [...])` final del useEffect: miramos su contenido.
  const deps = effect.match(/\},\s*\[([^\]]*)\]\s*\)/)?.[1] ?? "";
  assert.match(deps, /showSuccessScreen/, "Deps debe incluir `showSuccessScreen`.");
  assert.doesNotMatch(deps, /autoPrint/, "Deps NO debe incluir `autoPrint` (romperia single-fire).");
  assert.doesNotMatch(deps, /lastReceipt/, "Deps NO debe incluir `lastReceipt` (romperia single-fire).");
  assert.doesNotMatch(deps, /dispatchDrawerKickOnSale/, "Deps NO debe incluir el dispatcher.");
  assert.doesNotMatch(deps, /notifyDrawerKickResult/, "Deps NO debe incluir el notifier.");
});

// ---------------------------------------------------------------------------
// R4 bis — El toggle no re-imprime ni re-dispara el pulso lateral
// ---------------------------------------------------------------------------

test("Toggle autoPrint: no imprime ni kickea en onValueChange", async () => {
  const src = await read(paymentModalPath);
  const idx = src.indexOf('aria-label="Impresión automática del ticket"');
  assert.ok(idx > 0, "No se encontró el Switch de impresión automática.");
  const windowStart = Math.max(0, idx - 500);
  const windowEnd = Math.min(src.length, idx + 500);
  const scope = src.slice(windowStart, windowEnd);
  const handlerMatch = scope.match(/onValueChange=\{\s*\(?val\)?\s*=>\s*\{[\s\S]*?\}\s*\}/);
  assert.ok(handlerMatch, "No se pudo capturar el handler del Switch.");
  const handlerBody = handlerMatch[0];
  assert.doesNotMatch(handlerBody, /dispatchAutoPrint\(/,
    "El handler NO puede llamar a dispatchAutoPrint.");
  assert.doesNotMatch(handlerBody, /dispatchDrawerKickOnSale\(/,
    "El handler NO puede llamar a dispatchDrawerKickOnSale.");
  assert.doesNotMatch(handlerBody, /kickDrawer\(/,
    "El handler NO puede llamar al bridge directamente.");
});

// ---------------------------------------------------------------------------
// R5 — Reimpresión manual nunca llama a kickDrawer
// ---------------------------------------------------------------------------

test("Reimpresión manual: SaleDetailModal no llama a kickDrawer", async () => {
  const src = await read(saleDetailModalPath);
  assert.doesNotMatch(src, /kickDrawer\s*\(/,
    "La reimpresión desde el historial NO debe disparar el pulso lateral.");
});

test("Reimpresión manual: sales page no llama a kickDrawer", async () => {
  const src = await read(salesPagePath);
  assert.doesNotMatch(src, /kickDrawer\s*\(/,
    "La reimpresión desde la tabla de ventas NO debe disparar el pulso lateral.");
});

// ---------------------------------------------------------------------------
// Helpers — tests de sanidad del helper puro de useNewSale
// ---------------------------------------------------------------------------

test("Helper extractSaleIdFromRegisterResponse: contrato puro (reconstruido por evaluación controlada)", async () => {
  // Evaluamos el helper en un sandbox controlado para asegurar que su
  // comportamiento coincide con el contrato: entero positivo o `undefined`.
  //
  // Preferimos un sandbox a importar `useNewSale.ts` porque este último
  // trae imports de Next.js, hooks de React y rutas con alias `@/` que
  // node --test no resuelve. Extraemos SÓLO el cuerpo del helper del
  // archivo fuente y lo compilamos a mano. Si alguien cambia la firma
  // sin cambiar las aserciones, este test lo detecta porque la
  // reconstrucción falla al no encontrar la función.
  const src = await read(useNewSalePath);
  const start = src.indexOf("function extractSaleIdFromRegisterResponse");
  assert.ok(start > 0, "El helper debe seguir existiendo con ese nombre.");
  // Balanceamos llaves para extraer el bloque completo:
  const openBrace = src.indexOf("{", start);
  let depth = 0;
  let i = openBrace;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  // Convertimos la firma TS a JS plano para `new Function`: el helper es
  // puro y sus únicos tipos involucrados son los primitivos.
  const tsSignature = src.slice(start, openBrace);
  const jsSignature = tsSignature
    .replace(/:\s*unknown/g, "")
    .replace(/:\s*number\s*\|\s*undefined/g, "")
    .replace(/function\s+/, "function ");
  const body = src.slice(openBrace, i);
  const jsBody = body
    .replace(/:\s*Record<string,\s*unknown>/g, "")
    .replace(/as\s+Record<string,\s*unknown>/g, "")
    .replace(/\bNumber\.parseInt\b/g, "Number.parseInt"); // sanity
  const factory = new Function(`${jsSignature}${jsBody}; return extractSaleIdFromRegisterResponse;`);
  const extract = factory();

  // Casos positivos
  assert.strictEqual(extract({ id: 42 }), 42, "id entero positivo pasa tal cual");
  assert.strictEqual(extract({ id: "42" }), 42, "id string con dígitos pasa tras parseInt");
  assert.strictEqual(extract({ saleId: 7 }), 7, "fallback saleId también se honra");
  assert.strictEqual(extract({ SaleID: 7 }), 7, "fallback SaleID (legacy) también se honra");

  // Casos negativos: nunca inventan un id.
  assert.strictEqual(extract(null), undefined);
  assert.strictEqual(extract(undefined), undefined);
  assert.strictEqual(extract({}), undefined);
  assert.strictEqual(extract({ id: 0 }), undefined, "0 nunca es un id válido");
  assert.strictEqual(extract({ id: -5 }), undefined, "negativos nunca son válidos");
  assert.strictEqual(extract({ id: 1.5 }), undefined, "fracciones nunca son válidas");
  assert.strictEqual(extract({ id: "" }), undefined, "string vacío no es id");
  assert.strictEqual(extract({ id: "0" }), undefined, "string '0' no es id positivo");
  assert.strictEqual(extract({ id: "abc" }), undefined, "string no numérico no es id");
  assert.strictEqual(extract({ id: " 42 " }), 42, "string con espacios se tolera via trim");
  assert.strictEqual(extract({ id: "42abc" }), undefined, "mezcla alfanumérica se rechaza");
  assert.strictEqual(extract({ id: {} }), undefined, "objetos nunca son id");
});
