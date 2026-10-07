import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ordersPage = join(here, "..", "src", "app", "(app)", "inventory", "orders", "page.tsx");

// ============================================================================
// Guardián de /inventory/orders: editar "Valor del pedido" NO debe reemplazar
// la fecha predeterminada derivada de la agenda del proveedor.
// ============================================================================
//
// Síntoma histórico: `updateForm` creaba la entrada en `forms[key]` con
// `expectedDate: current[key]?.expectedDate ?? dateAfter(7)`. Como el flujo
// típico es que el usuario cambia primero el VALOR del pedido antes que la
// fecha, al escribir en el campo numérico se creaba una entrada nueva con
// fallback `dateAfter(7)`, reemplazando silenciosamente la fecha calculada
// desde la agenda del proveedor (visit_days + delivery_days).
//
// El guardián se expresa sobre el código fuente: no corre React, pero
// detecta el patrón prohibido y exige el patrón correcto.

async function leerPagina() {
  return await readFile(ordersPage, "utf8");
}

test("updateForm NO usa dateAfter(7) como primer fallback para expectedDate", async () => {
  const src = await leerPagina();
  // El patrón prohibido crea la fila usando SOLO dateAfter(7) como fallback.
  // Lo prohibimos textualmente: después del fix, dateAfter(7) sólo puede
  // aparecer en ramas EXPLÍCITAS que ya chequearon la ausencia de items.
  const prohibido = /expectedDate:\s*current\[key\]\?\.expectedDate\s*\?\?\s*dateAfter\(7\)/;
  assert.ok(
    !prohibido.test(src),
    "updateForm volvió a usar dateAfter(7) como fallback silencioso. El fallback debe venir de resolveExpectedDeliveryDate(group.items) primero.",
  );
});

test("updateForm acepta groupItems para resolver expectedDate desde la agenda del proveedor", async () => {
  const src = await leerPagina();
  // El nuevo contrato: updateForm(key, patch, groupItems?). Si groupItems
  // está, se resuelve con resolveExpectedDeliveryDate(groupItems).isoDate.
  assert.match(
    src,
    /updateForm\s*=\s*useCallback\s*\(\s*\(\s*key:\s*string\s*,\s*patch:\s*Partial<GroupForm>\s*,\s*groupItems\?/,
    "updateForm debe recibir groupItems opcionales para derivar expectedDate desde la agenda.",
  );
  assert.match(
    src,
    /resolveExpectedDeliveryDate\(\s*groupItems\s*\)\.isoDate/,
    "updateForm debe llamar a resolveExpectedDeliveryDate(groupItems).isoDate como fuente primaria del fallback.",
  );
});

test("los callsites de updateForm en el formulario pasan completeGroup.items", async () => {
  const src = await leerPagina();
  // Las dos entradas del formulario donde se edita expectedDate y orderValue
  // deben propagar completeGroup.items para que el fallback inicial sea el
  // de la agenda del proveedor y NO 7 días.
  const expectedDateCall = /onChange=\{\(event\)\s*=>\s*updateForm\(\s*completeGroup\.key\s*,\s*\{\s*expectedDate:\s*event\.target\.value\s*\}\s*,\s*completeGroup\.items\s*\)\}/;
  assert.match(
    src,
    expectedDateCall,
    "El input de 'Fecha de entrega' debe pasar completeGroup.items a updateForm.",
  );
  const orderValueCall = /orderValue:\s*normalizeOrderValueInput\(event\.target\.value\),?\s*\}\s*,\s*completeGroup\.items\s*\)/;
  assert.match(
    src,
    orderValueCall,
    "El input de 'Valor del pedido' debe pasar completeGroup.items a updateForm para no borrar la fecha.",
  );
});
