import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ============================================================================
// Guardianes de idempotencia anti-doble-cierre.
//
// Contrato (ver auditoria_cierre P1.B.1):
//
//   1. Antes de postear /cashier-closure/close, el frontend genera (o
//      reusa) un UUID per intento via getOrCreateClientClosureId. Ese
//      UUID viaja en el payload como `clientTxId` y como `client_tx_id`
//      (alias snake_case por si el backend lee del map crudo).
//
//   2. El id SOLO se limpia tras exito confirmado. Si falla el POST,
//      el id persiste y el reintento envia el MISMO id para que el
//      backend lo deduplique.
//
//   3. En modo edicion NO se envia clientTxId (ahi hay un id real).
//
//   4. Debe existir un latch anti-doble-submit a nivel de ref (useRef)
//      que bloquee clicks seguidos antes de que isSubmitting commitee.
// ============================================================================

const page = readFileSync(
  new URL("../src/app/(app)/dashboard/closure/page.tsx", import.meta.url),
  "utf8",
);

test("handleCloseRegister pide el clientTxId via getOrCreateClientClosureId", () => {
  assert.match(
    page,
    /getOrCreateClientClosureId\(\)/,
    "la pantalla debe reusar el helper puro (no reimplementar UUID por su cuenta)",
  );
});

test("el id se envia como clientTxId Y client_tx_id en el payload", () => {
  assert.match(
    page,
    /createPayload\.clientTxId\s*=\s*clientClosureId/,
    "falta la asignacion camelCase (createPayload.clientTxId = clientClosureId)",
  );
  assert.match(
    page,
    /createPayload\.client_tx_id\s*=\s*clientClosureId/,
    "falta el alias snake_case por si el backend lo lee del map crudo",
  );
});

test("el id SOLO se incluye en modo CREATE (no en edicion)", () => {
  // El helper se invoca con `!isEditMode ? ... : undefined`.
  assert.match(
    page,
    /const\s+clientClosureId\s*=\s*!isEditMode\s*\?\s*getOrCreateClientClosureId/,
    "en modo edicion no debe haber clientTxId (ya existe un id real)",
  );
});

test("clearClientClosureId se llama DESPUES del exito del POST", () => {
  // El orden deberia ser: await apiFetch(...) -> toast exito -> confirmReset -> clearClientClosureId.
  const idxApiFetch = page.indexOf("/dashboard/cashier-closure/close");
  const idxClear = page.indexOf("clearClientClosureId()");
  assert.ok(idxApiFetch >= 0 && idxClear >= 0, "ambos pasos deben existir");
  assert.ok(
    idxClear > idxApiFetch,
    "clearClientClosureId debe ejecutarse DESPUES del POST para preservar idempotencia si falla",
  );
});

test("existe un latch anti-doble-submit sincrono via useRef", () => {
  assert.match(
    page,
    /submitLatchRef\s*=\s*useRef\(false\)/,
    "falta el ref que previene el doble click entre render y commit",
  );
  assert.match(
    page,
    /if\s*\(\s*submitLatchRef\.current\s*\|\|\s*isSubmitting/,
    "el latch debe revisarse al principio del handler",
  );
  assert.match(
    page,
    /submitLatchRef\.current\s*=\s*true/,
    "el latch se enciende antes del await",
  );
});

test("el boton CERRAR CAJA queda bloqueado tras exito hasta la expulsion", () => {
  // closureCompleted sigue true aunque isSubmitting vuelva a false.
  assert.match(
    page,
    /setClosureCompleted\(true\)/,
    "falta la bandera que mantiene el boton bloqueado tras exito",
  );
  assert.match(
    page,
    /isDisabled=\{isSubmitting\s*\|\|\s*closureCompleted\s*\|\|/,
    "el isDisabled del boton debe incluir closureCompleted",
  );
});

test("el finally resetea el latch pero respeta closureCompleted", () => {
  // El reset de isSubmitting SOLO corre si closureCompleted sigue false.
  assert.match(
    page,
    /submitLatchRef\.current\s*=\s*false/,
    "el finally debe liberar el latch ref",
  );
  assert.match(
    page,
    /if\s*\(\s*!closureCompleted\s*\)\s*\{\s*setIsSubmitting\(false\)/,
    "no reactivar isSubmitting si el cierre ya tuvo exito",
  );
});

test("el id se verifica ANTES de encender el latch", () => {
  // Si falta el token, retornamos sin latch encendido.
  const handlerMatch = page.match(/const\s+handleCloseRegister\s*=\s*async[\s\S]*?submitLatchRef\.current\s*=\s*false;[\s\S]*?\}\s*\}\s*;/);
  // No importa el handler completo; basta con que el flujo exista.
  assert.match(
    page,
    /const\s+token\s*=\s*Cookies\.get\(['"]org-pos-token['"]\)[\s\S]*?if\s*\(\s*!token\s*\)[\s\S]*?return;[\s\S]*?submitLatchRef\.current\s*=\s*true/,
    "el token debe revisarse antes de encender el latch",
  );
});
