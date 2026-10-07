import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ============================================================================
// Guardianes de la pantalla /dashboard/closure sobre el flujo de
// autorizacion administrativa de un faltante.
//
// Reglas del contrato (ver auditoria_cierre P0.A.3):
//
//   1. handleAdminVerify DEBE intentar POST /auth/verify-admin primero.
//      Ese endpoint devuelve un token firmado por el backend que lleva
//      el claim action="closure_authorization" con exp corta. El
//      frontend lo guarda APARTE (adminAuthToken state) y NO sobre-
//      escribe las cookies de sesion.
//
//   2. Si el endpoint no existe (404), el frontend cae a /auth/login,
//      exige rol admin, pero sigue sin tocar la sesion del cajero.
//
//   3. handleCloseRegister DEBE enviar el token en el payload como
//      `authorizationToken` (nombre canonico que el backend decodifica
//      en dashboard_handler.go). Se envia tambien `authorizedByToken`
//      como alias deprecado durante la ventana de convivencia con un
//      backend aun sin este fix.
//
//   4. El token NUNCA debe llamarse writeSession/clearSession porque
//      haciendolo cambiaria la sesion del cajero y el POST de cierre
//      quedaria firmado por el admin.
// ============================================================================

const page = readFileSync(
  new URL("../src/app/(app)/dashboard/closure/page.tsx", import.meta.url),
  "utf8",
);

test("handleAdminVerify intenta /auth/verify-admin antes del fallback", () => {
  assert.match(
    page,
    /\/auth\/verify-admin/,
    "la pantalla debe llamar /auth/verify-admin como camino preferido",
  );
  const idxVerify = page.indexOf("/auth/verify-admin");
  const idxLegacy = page.indexOf("/auth/login");
  assert.ok(idxVerify >= 0 && idxLegacy >= 0, "ambos caminos deben existir");
  assert.ok(
    idxVerify < idxLegacy,
    "verify-admin debe aparecer antes que /auth/login (orden del codigo = orden de intento)",
  );
});

test("handleAdminVerify guarda el token aparte sin reemplazar la sesion", () => {
  // El token se guarda en state (`setAdminAuthToken`), nunca en cookies.
  assert.match(
    page,
    /setAdminAuthToken\(token\)/,
    "el token admin debe guardarse en state, no en la sesion del cajero",
  );
  // La pantalla NO debe llamar writeSession ni clearSession desde handleAdminVerify.
  const verifyRegion = page.match(/const\s+handleAdminVerify\s*=\s*async[\s\S]*?setIsVerifying\(false\);\s*\}\s*\}\s*;/);
  assert.ok(verifyRegion, "no se pudo delimitar handleAdminVerify");
  assert.doesNotMatch(
    verifyRegion[0],
    /writeSession\(/,
    "handleAdminVerify NO puede sobrescribir la sesion del cajero",
  );
  assert.doesNotMatch(
    verifyRegion[0],
    /clearSession\(/,
    "handleAdminVerify NO puede limpiar la sesion del cajero",
  );
});

test("handleAdminVerify cierra el modal automaticamente tras exito", () => {
  const verifyRegion = page.match(/const\s+handleAdminVerify\s*=\s*async[\s\S]*?setIsVerifying\(false\);\s*\}\s*\}\s*;/);
  assert.ok(verifyRegion);
  assert.match(
    verifyRegion[0],
    /setShowAuthModal\(false\)/,
    "al autorizar correctamente, el modal se cierra sin que el usuario tenga que hacer click",
  );
});

test("handleCloseRegister envia authorizationToken (nombre canonico del backend)", () => {
  // ESTE es el nombre que el handler SaveClosure del backend decodifica
  // (dashboard_handler.go, json tag `authorizationToken`). Si el frontend
  // envia solo `authorizedByToken`, el backend nunca ve el token y
  // responde 403 a todo cierre con faltante firmado por un empleado.
  assert.match(
    page,
    /createPayload\.authorizationToken\s*=\s*adminAuthToken/,
    "el POST de cierre debe propagar el token admin como authorizationToken",
  );
});

test("handleCloseRegister conserva el alias deprecado authorizedByToken", () => {
  // Durante la ventana de convivencia con un backend sin este fix (por
  // ejemplo si el frontend se despliega antes del binario), enviamos
  // tambien el alias deprecado. No reemplaza al canonico; viaja ademas.
  assert.match(
    page,
    /createPayload\.authorizedByToken\s*=\s*adminAuthToken/,
    "el alias deprecado authorizedByToken debe seguir viajando como respaldo",
  );
});

test("handleCloseRegister NO envia el id en modo CREATE", () => {
  // El patron de limpieza vive junto a la rama no-edit.
  assert.match(
    page,
    /delete\s+baseClosureData\.id/,
    "el POST create debe eliminar el id del payload (riesgo GORM upsert)",
  );
});

test("el payload de PUT en modo edicion solo setea authorized_by si hay reautorizacion", () => {
  // La condicion exacta vive en handleCloseRegister.
  assert.match(
    page,
    /if\s*\(\s*isAuthorized\s*&&\s*adminAuthorizer\s*\)\s*\{\s*updatePayload\.authorized_by/,
    "el PUT no debe sobreescribir authorized_by salvo que el admin reautorice en esta edicion",
  );
});

test("el campo authorizedBy del payload create cae a undefined cuando no hay admin autorizando", () => {
  // adminAuthorizer vacio -> undefined para no mandar un string vacio al backend.
  assert.match(
    page,
    /authorizedBy:\s*isAdmin\s*\?\s*\([^)]*\)\s*:\s*\(adminAuthorizer\s*\|\|\s*undefined\)/,
    "sin autorizacion y no-admin, authorizedBy NO debe viajar en el payload",
  );
});
