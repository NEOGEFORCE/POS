import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  sanitizeNextParam,
  defaultRoleTarget,
  resolvePostLoginTarget,
} from "../src/lib/reauth-redirect.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const loginPage = join(here, "..", "src", "app", "login", "page.tsx");
const authFile = join(here, "..", "src", "lib", "auth.tsx");
const guardianFile = join(here, "..", "src", "components", "SessionGuardian.tsx");

// ============================================================================
// Guardián de reautenticación: preservar ruta y bloquear open-redirect.
// ============================================================================

test("sanitizeNextParam acepta rutas internas válidas", () => {
  assert.equal(sanitizeNextParam("/inventory/orders"), "/inventory/orders");
  assert.equal(sanitizeNextParam("/sales/new?autoFocus=1"), "/sales/new?autoFocus=1");
  assert.equal(sanitizeNextParam("/dashboard"), "/dashboard");
});

test("sanitizeNextParam rechaza open-redirect clásicos", () => {
  // //evil.com es la trampa clásica: el navegador la ve como protocol-relative.
  assert.equal(sanitizeNextParam("//evil.com"), null);
  assert.equal(sanitizeNextParam("//evil.com/anything"), null);
  // \\ como backslash de Windows en segunda posición: otro bypass.
  assert.equal(sanitizeNextParam("/\\evil.com"), null);
  // Esquemas directos.
  assert.equal(sanitizeNextParam("javascript:alert(1)"), null);
  assert.equal(sanitizeNextParam("http://evil.com"), null);
  assert.equal(sanitizeNextParam("https://evil.com"), null);
  assert.equal(sanitizeNextParam("data:text/html,<script>"), null);
  // Rutas internas que contienen esquema disfrazado también se rechazan.
  assert.equal(sanitizeNextParam("/path?q=javascript:alert(1)"), null);
});

test("sanitizeNextParam rechaza ciclos a páginas públicas", () => {
  assert.equal(sanitizeNextParam("/login"), null);
  assert.equal(sanitizeNextParam("/login?reason=timeout"), null);
  assert.equal(sanitizeNextParam("/setup"), null);
});

test("sanitizeNextParam rechaza entradas no string o vacías", () => {
  assert.equal(sanitizeNextParam(null), null);
  assert.equal(sanitizeNextParam(undefined), null);
  assert.equal(sanitizeNextParam(""), null);
  assert.equal(sanitizeNextParam("   "), null);
  // Longitud absurda:
  assert.equal(sanitizeNextParam("/" + "a".repeat(2500)), null);
});

test("defaultRoleTarget respeta la tabla admin → /dashboard, resto → /sales/new", () => {
  assert.equal(defaultRoleTarget("admin"), "/dashboard");
  assert.equal(defaultRoleTarget("ADMIN"), "/dashboard");
  assert.equal(defaultRoleTarget("administrador"), "/dashboard");
  assert.equal(defaultRoleTarget("superadmin"), "/dashboard");
  assert.equal(defaultRoleTarget("empleado"), "/sales/new");
  assert.equal(defaultRoleTarget(""), "/sales/new");
  assert.equal(defaultRoleTarget(null), "/sales/new");
});

test("resolvePostLoginTarget: next válido gana al rol", () => {
  assert.equal(resolvePostLoginTarget("admin", "/inventory/orders"), "/inventory/orders");
  assert.equal(resolvePostLoginTarget("empleado", "/inventory"), "/inventory");
});

test("resolvePostLoginTarget: next inseguro cae al destino por rol", () => {
  assert.equal(resolvePostLoginTarget("admin", "//evil.com"), "/dashboard");
  assert.equal(resolvePostLoginTarget("empleado", "javascript:alert(1)"), "/sales/new");
  assert.equal(resolvePostLoginTarget(null, null), "/sales/new");
});

// ============================================================================
// Guardianes estáticos: el patrón hardcoded de redirect está prohibido.
// ============================================================================

test("login/page: lee ?next= y usa resolvePostLoginTarget en lugar de hardcode", async () => {
  const src = await readFile(loginPage, "utf8");
  assert.ok(
    src.includes("useSearchParams") && src.includes("resolvePostLoginTarget"),
    "login/page debe importar useSearchParams y resolvePostLoginTarget.",
  );
  // El patrón hardcoded antiguo no puede volver.
  assert.ok(
    !/role\s*===\s*['"]admin['"]\s*\|\|\s*role\s*===\s*['"]administrador['"]\s*\|\|\s*role\s*===\s*['"]superadmin['"]\s*\)\s*\n?\s*\?\s*['"]\/dashboard['"]/.test(src),
    "login/page NO debe tener el if hardcoded admin→/dashboard : /sales/new; usar resolvePostLoginTarget.",
  );
});

test("auth.tsx: login() lee ?next= del window.location.search y lo valida", async () => {
  const src = await readFile(authFile, "utf8");
  assert.ok(
    src.includes("resolvePostLoginTarget"),
    "auth.tsx debe usar resolvePostLoginTarget en el login().",
  );
  assert.ok(
    src.includes('new URLSearchParams(window.location.search).get("next")')
      || src.includes("new URLSearchParams(window.location.search).get('next')"),
    "auth.tsx debe leer el next del URL del browser.",
  );
});

test("SessionGuardian: construye ?next=<ruta> al expulsar al usuario", async () => {
  const src = await readFile(guardianFile, "utf8");
  assert.ok(
    src.includes("next=") && src.includes("encodeURIComponent"),
    "SessionGuardian debe generar query ?next=<ruta encodeURIComponent>.",
  );
  assert.ok(
    src.includes("buildReturnUrl"),
    "SessionGuardian debe tener un helper buildReturnUrl() que normaliza la ruta.",
  );
  // No debe redirigir directamente a /login sin pasar por el helper cuando
  // hay una ruta válida que preservar.
  assert.ok(
    src.includes("router.replace") && src.includes("`/login"),
    "SessionGuardian sigue redirigiendo a /login (template string esperado).",
  );
});
