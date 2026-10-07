import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sheet = join(here, "..", "src", "app", "(app)", "inventory", "receive", "components", "LabelPrintSheet.tsx");
const page = join(here, "..", "src", "app", "(app)", "inventory", "receive", "page.tsx");
const row = join(here, "..", "src", "app", "(app)", "inventory", "receive", "components", "ReceptionRow.tsx");
const postModal = join(here, "..", "src", "app", "(app)", "inventory", "receive", "components", "PostReceptionLabelsModal.tsx");

// ============================================================================
// Guardianes estáticos del LabelPrintSheet y del gating "print after sync".
//
//   - El sheet usa el flujo existente /labels/codes (idempotente) seguido
//     de /labels/print-jobs para auditar el envío.
//   - El POST a /labels/codes aparece antes que el POST a
//     /labels/print-jobs (orden importa: la auditoría necesita el code).
//   - Si window.posBridge.print existe, se delega al bridge; si no,
//     cae a window.print(). La recepción NO se revierte si el bridge falla.
//   - El trigger se marca como "reprint" cuando el code ya existía (idempotencia).
//   - El sheet usa el mismo productBarcode en reimpresiones; nunca
//     genera un code nuevo para el mismo producto.
//   - [GATING POST-SYNC]: el botón Printer SOLO aparece después de que
//     la recepción se confirmó en BD. En la vista DRAFT del carrito
//     (receiveList) nunca se expone, y por tanto nunca se puede disparar
//     /labels/print-jobs antes de que exista la recepción.
// ============================================================================

async function leer(path) { return readFile(path, "utf8"); }

test("LabelPrintSheet: POSTea a /labels/codes para asegurar el code idempotente", async () => {
  const src = await leer(sheet);
  assert.ok(
    src.includes("'/labels/codes'") || src.includes('"/labels/codes"'),
    "LabelPrintSheet debe asegurar el code con POST /labels/codes (idempotente).",
  );
});

test("LabelPrintSheet: POSTea a /labels/print-jobs DESPUÉS de obtener el code", async () => {
  const src = await leer(sheet);
  const idxEnsure = src.indexOf("/labels/codes");
  const idxJob = src.indexOf("/labels/print-jobs");
  assert.ok(idxEnsure >= 0, "Falta POST /labels/codes.");
  assert.ok(idxJob >= 0, "Falta POST /labels/print-jobs.");
  assert.ok(
    idxEnsure < idxJob,
    "El POST a /labels/codes debe aparecer antes que el POST a /labels/print-jobs (orden importa: la auditoría necesita el code).",
  );
});

test("LabelPrintSheet: usa trigger='reprint' cuando el code ya existía", async () => {
  const src = await leer(sheet);
  // ensure?.created es TRUE sólo cuando se acaba de crear el code.
  // Si existía (idempotente), el trigger debe ser 'reprint'.
  assert.ok(
    /triggerSource:\s*ensure\?\.created\s*\?\s*['"]new['"]\s*:\s*['"]reprint['"]/.test(src),
    "La reimpresión debe mandar trigger='reprint' cuando el code ya existía.",
  );
});

test("LabelPrintSheet: delega al bridge local si window.posBridge.print existe", async () => {
  const src = await leer(sheet);
  assert.ok(
    /window\.posBridge/.test(src) || /window\?\.posBridge/.test(src) || /posBridge/.test(src),
    "El sheet debe intentar usar window.posBridge.print antes del fallback.",
  );
  assert.ok(
    src.includes("window.print()"),
    "Debe existir fallback a window.print() para que al menos el navegador abra el diálogo.",
  );
});

test("LabelPrintSheet: si el bridge falla, informa pero NO revierte stock", async () => {
  const src = await leer(sheet);
  // El catch del bridge debe mostrar toast destructivo y NO llamar a
  // nada que revierta la recepción.
  assert.ok(
    /bridge local no respondió/i.test(src) || /no respondió/i.test(src) || /IMPRESIÓN LOCAL FALLÓ/i.test(src),
    "El sheet debe mostrar un mensaje claro cuando el bridge local falla.",
  );
  // No debe haber referencia a /products/bulk-receive, /inventory/receive
  // o ejecución de una reversión real de stock.
  assert.ok(
    !/bulk-receive/.test(src) && !/rollback/i.test(src),
    "El LabelPrintSheet NUNCA debe tocar el stock ni ejecutar un rollback de la recepción.",
  );
  // Si menciona la palabra "revertir" o "revierte" debe ser en frase
  // NEGATIVA ("NO se revierte", "no revierte"), nunca como instrucción
  // activa de revertir ("revertir stock", "revierte la recepción").
  const activeRevert = /(?<!no se )(?<!no )revi(erte|erta|ertan|ertas|ertieron)\s+(stock|recepci|inventario|carrito)/i.test(src)
    || /revertir\s+(stock|recepci|inventario|carrito)/i.test(src);
  assert.ok(
    !activeRevert,
    "El LabelPrintSheet NUNCA debe ejecutar una reversión real de stock/recepción.",
  );
});

test("LabelPrintSheet: usa el mismo productBarcode en todas las llamadas (reutilización del code)", async () => {
  const src = await leer(sheet);
  // La llamada a /labels/codes recibe { productBarcode } — eso garantiza
  // que /labels/codes.EnsureCodeForProduct devuelva el mismo code en
  // reimpresiones.
  assert.ok(
    /body:\s*JSON\.stringify\(\s*\{\s*productBarcode\s*\}/.test(src),
    "La llamada a /labels/codes debe pasar productBarcode como único identificador para que el code sea idempotente.",
  );
});

test("LabelPrintSheet: NO manipula alternateCodes ni cambia el barcode del producto", async () => {
  const src = await leer(sheet);
  assert.ok(
    !src.includes("alternateCodes") && !src.includes("alternate_codes"),
    "LabelPrintSheet NO debe tocar alternateCodes.",
  );
  // Ni ejecuta /products/update
  assert.ok(
    !src.includes("/products/update"),
    "LabelPrintSheet NO debe modificar el catálogo de productos.",
  );
});

test("LabelPrintSheet: cantidad default parseada con Math.floor para prevenir decimales", async () => {
  const src = await leer(sheet);
  assert.ok(
    /Math\.floor\(Number\(.*count/.test(src) || /Math\.floor\(Number\(.*default/.test(src),
    "El sheet debe parsear la cantidad con Math.floor: una etiqueta por unidad.",
  );
});

// ============================================================================
// Gating "print only after sync": requisito funcional explícito.
//   "Recepción debe confirmarse antes de crear/auditar el trabajo de
//   impresión; si impresión/bridge falla, conservar recepción y permitir
//   reimpresión."
// ============================================================================

test("receive/page: el map del DRAFT (receiveList) NO cablea onPrintLabels", async () => {
  const src = await leer(page);
  // Buscamos el bloque receiveList.map(... ReceptionRow ...) y verificamos
  // que no contenga `onPrintLabels={`. Es la invariante crítica: si alguien
  // lo re-cablea, el botón volvería a imprimir trabajos antes de que la
  // recepción se confirme.
  const mapRe = /receiveList\.map\(\s*\(item\)\s*=>\s*\(\s*<ReceptionRow[\s\S]*?\/>\s*\)\s*\)/m;
  const match = mapRe.exec(src);
  assert.ok(match, "No se pudo localizar el .map de receiveList sobre ReceptionRow.");
  assert.ok(
    !/onPrintLabels\s*=/.test(match[0]),
    "El map del DRAFT NO debe pasar onPrintLabels a ReceptionRow: imprimir una línea no sincronizada auditaría /labels/print-jobs antes de que la recepción exista.",
  );
});

test("receive/page: el botón Printer sólo se expone via PostReceptionLabelsModal", async () => {
  const src = await leer(page);
  // El page importa PostReceptionLabelsModal y lo renderiza condicionalmente
  // (isPostReceptionOpen && lines.length > 0).
  assert.ok(
    /PostReceptionLabelsModal/.test(src),
    "El page debe renderizar PostReceptionLabelsModal (único punto post-sync donde se expone Printer).",
  );
  assert.ok(
    /isPostReceptionOpen/.test(src),
    "El page debe tener un flag isPostReceptionOpen que gate el modal post-recepción.",
  );
});

test("receive/page: handleConfirmReceive genera un syncedReceptionId DESPUÉS del POST", async () => {
  const src = await leer(page);
  // El prefijo del ref es parte del contrato: RCV-<timestamp>-<rand>.
  assert.ok(
    /RCV-\$\{Date\.now\(\)/.test(src),
    "El page debe generar un receptionRef con el formato RCV-<Date.now()>-<rand> tras el POST exitoso.",
  );
  // Y el ref se asigna a cada línea stampada antes de abrir el modal.
  assert.ok(
    /syncedReceptionId:\s*receptionRef/.test(src),
    "Cada línea stampada debe recibir syncedReceptionId = receptionRef.",
  );
});

test("ReceptionRow: botón Printer gateado por item.syncedReceptionId", async () => {
  const src = await leer(row);
  // Debe existir una guardia explícita: `onPrintLabels && item.syncedReceptionId`.
  assert.ok(
    /onPrintLabels\s*&&\s*item\.syncedReceptionId/.test(src),
    "El botón Printer de ReceptionRow debe estar gateado por item.syncedReceptionId: sin esa marca, la línea aún es DRAFT y no debe permitir imprimir.",
  );
});

test("PostReceptionLabelsModal: existe y declara que es post-sync", async () => {
  const src = await leer(postModal);
  // El componente debe mencionar su contrato explícitamente para que
  // futuros refactors no borren la invariante sin darse cuenta.
  assert.ok(
    src.includes("syncedReceptionId") || src.includes("recepción confirmada") || src.includes("Recepción confirmada"),
    "PostReceptionLabelsModal debe documentar que se abre sólo tras una recepción confirmada.",
  );
  assert.ok(
    /receptionRef/.test(src),
    "PostReceptionLabelsModal debe usar receptionRef para auditar.",
  );
});
