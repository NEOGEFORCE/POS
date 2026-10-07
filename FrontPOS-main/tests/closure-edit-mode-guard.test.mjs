import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(
  new URL("../src/app/(app)/dashboard/closure/page.tsx", import.meta.url),
  "utf8",
);

// ============================================================================
// Guardianes del modo edicion de /dashboard/closure.
//
// Reglas (ver auditoria_cierre P2):
//
//   1. Si fetchCurrent devuelve null en edit mode, se avisa y se redirige
//      al historial (/reports). No se puede dejar al usuario en una
//      pantalla con defaults vacios que luego envie un PUT con ceros.
//
//   2. El boton GUARDAR CAMBIOS debe quedar deshabilitado cuando
//      currentClosure === null (modo edicion sin datos cargados).
//
//   3. El PUT debe usar apiFetch (no fetch crudo) para heredar
//      recuperacion de sesion 401 y timeouts.
//
//   4. No debe sobreescribir authorized_by cuando el admin no reautoriza
//      explicitamente en esta edicion.
// ============================================================================

test("edit mode: fetchCurrent redirige a /reports si no logra cargar el cierre", () => {
  assert.match(
    page,
    /router\.replace\(['"]\/reports['"]\)/,
    "cuando el cierre no se puede cargar, debe redirigir a /reports",
  );
  assert.match(
    page,
    /Volviendo al historial/,
    "el toast de error debe mencionar que se vuelve al historial",
  );
});

test("edit mode: el boton CERRAR/GUARDAR se deshabilita si no hay cierre cargado", () => {
  assert.match(
    page,
    /isDisabled=\{isSubmitting\s*\|\|\s*closureCompleted\s*\|\|\s*\(isEditMode\s*&&\s*!currentClosure\)\}/,
    "el isDisabled debe cubrir el caso edit sin datos cargados",
  );
});

test("edit mode: handleCloseRegister aborta temprano si no hay cierre cargado", () => {
  assert.match(
    page,
    /if\s*\(\s*isEditMode\s*&&\s*!currentClosure\s*\)/,
    "falta la guarda temprana contra edit sin datos",
  );
  assert.match(
    page,
    /NO HAY CIERRE CARGADO/,
    "falta el toast descriptivo cuando se intenta guardar sin cierre",
  );
});

test("edit mode: el PUT usa apiFetch (no fetch crudo)", () => {
  // Debe existir una llamada a apiFetch con la ruta de edicion.
  assert.match(
    page,
    /apiFetch\(`\/dashboard\/cashier-history\/\$\{editId\}`/,
    "el PUT de edit debe pasar por apiFetch para heredar sesion/timeouts",
  );
  // Y NO debe quedar la rama fetch(... method: 'PUT' ...) del codigo viejo.
  assert.doesNotMatch(
    page,
    /fetch\(\s*`\$\{[^`]*\}\/dashboard\/cashier-history\/\$\{editId\}`,\s*\{\s*method:\s*['"]PUT['"]/,
    "el fetch crudo del PUT edit debe eliminarse para no bypassear el modal ReLogin",
  );
});

test("edit mode: authorized_by del PUT se preserva salvo que admin reautorice", () => {
  // La condicion debe gatear la asignacion.
  assert.match(
    page,
    /if\s*\(\s*isAuthorized\s*&&\s*adminAuthorizer\s*\)\s*\{\s*updatePayload\.authorized_by/,
    "authorized_by del PUT solo se setea cuando el admin reautorizo en esta edicion",
  );
  // Y no debe mandarlo incondicionalmente.
  assert.doesNotMatch(
    page,
    /authorized_by:\s*closureData\.authorizedBy,/,
    "no debe quedar el assignment incondicional viejo",
  );
});

test("logout del cajero limpia pos_closure_* via clearClosureStorage", () => {
  const auth = readFileSync(
    new URL("../src/lib/auth.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    auth,
    /clearClosureStorage\(\)/,
    "el logout del AuthProvider debe borrar las claves del cierre",
  );
  // Y tambien en el handler de "logout" broadcast entre pestanas.
  const logoutRegion = auth.match(/if\s*\(message\.type\s*===\s*["']logout["']\)\s*\{[\s\S]*?return;/);
  assert.ok(logoutRegion, "no se pudo localizar el handler de mensaje logout");
  assert.match(
    logoutRegion[0],
    /clearClosureStorage\(/,
    "el broadcast de logout debe limpiar en la pestana receptora tambien",
  );
});
