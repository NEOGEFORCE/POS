import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  sanitizeNextParam,
  resolvePostLoginTarget,
} from "../src/lib/reauth-redirect.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const loginPage = join(here, "..", "src", "app", "login", "page.tsx");

// ============================================================================
// Guardián del fix de Next.js 15 `output: 'export'` + useSearchParams():
// el prerender estático exige que cualquier uso de useSearchParams() esté
// envuelto en <Suspense>. Sin esto, `npm run build` aborta con
// "useSearchParams() should be wrapped in a suspense boundary at page '/login'".
//
// El fix separa el formulario (que lee ?next) en un componente interno
// y lo envuelve con Suspense en el export default. El contrato de
// redirección (`?next=<ruta sanitizada>` → resolvePostLoginTarget) debe
// permanecer intacto.
// ============================================================================

test("login/page: el export default envuelve a LoginForm con <Suspense>", async () => {
  const src = await readFile(loginPage, "utf8");
  // Importamos Suspense desde React.
  assert.ok(
    /import\s+\{[^}]*Suspense[^}]*\}\s+from\s+['"]react['"]/.test(src),
    "login/page debe importar Suspense desde React.",
  );
  // Hay un <Suspense ...> en el JSX.
  assert.ok(src.includes("<Suspense"), "login/page debe renderizar <Suspense>.");
  // Y envuelve a LoginForm (no al cuerpo pelado del page). Como el
  // atributo fallback puede contener JSX con `/>` interno, usamos un
  // match multilínea no-greedy que busca cualquier contenido hasta el
  // `>` que corresponde al Suspense (nos basta que exista un <LoginForm
  // dentro del rango del export default).
  const defaultBodyMatch = /export\s+default\s+function\s+LoginPage\s*\([^)]*\)\s*\{([\s\S]*?)^\}/m.exec(src);
  assert.ok(defaultBodyMatch, "No se pudo localizar el cuerpo del export default LoginPage().");
  const body = defaultBodyMatch[1];
  assert.ok(
    body.includes("<Suspense") && body.includes("<LoginForm"),
    "El export default debe renderizar <Suspense> con <LoginForm /> dentro.",
  );
  // Y el <LoginForm /> aparece después del <Suspense (no antes).
  assert.ok(
    body.indexOf("<Suspense") < body.indexOf("<LoginForm"),
    "<LoginForm /> debe estar DENTRO de <Suspense>, no antes.",
  );
});

test("login/page: useSearchParams se usa SOLO dentro de LoginForm, no en el export default", async () => {
  const src = await readFile(loginPage, "utf8");
  // El símbolo sigue importado desde next/navigation.
  assert.ok(
    /import\s+\{[^}]*useSearchParams[^}]*\}\s+from\s+['"]next\/navigation['"]/.test(src),
    "login/page sigue importando useSearchParams desde next/navigation.",
  );
  // El cuerpo del export default `function LoginPage()` NO debe llamar
  // useSearchParams(); la llamada debe estar dentro de LoginForm.
  const loginPageMatch = /export\s+default\s+function\s+LoginPage\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/m.exec(src);
  assert.ok(loginPageMatch, "No se pudo localizar el cuerpo del export default LoginPage().");
  const body = loginPageMatch[1];
  assert.ok(
    !body.includes("useSearchParams("),
    "El export default LoginPage NO debe llamar useSearchParams(); eso rompe el prerender estático.",
  );
  // Debe existir una función LoginForm que SÍ llama useSearchParams.
  assert.ok(
    /function\s+LoginForm\s*\(/.test(src),
    "login/page debe tener una función LoginForm interna.",
  );
  const loginFormMatch = /function\s+LoginForm\s*\(\s*\)\s*\{([\s\S]*?)\n\}/m.exec(src);
  assert.ok(loginFormMatch, "No se pudo localizar el cuerpo de LoginForm.");
  // Verificar que LoginForm sí usa useSearchParams
  assert.ok(
    loginFormMatch[1].includes("useSearchParams("),
    "LoginForm debe ser quien llama useSearchParams(); así queda detrás de la frontera Suspense.",
  );
});

test("login/page: resolvePostLoginTarget se sigue invocando con el nextParam sanitizado", async () => {
  const src = await readFile(loginPage, "utf8");
  assert.ok(
    src.includes("resolvePostLoginTarget("),
    "login/page debe seguir usando resolvePostLoginTarget para calcular el destino post-login.",
  );
  assert.ok(
    src.includes("searchParams?.get('next')") || src.includes('searchParams?.get("next")'),
    "login/page debe leer ?next= del searchParams.",
  );
});

test("resolvePostLoginTarget: contrato de sanitización no se rompió", () => {
  assert.equal(resolvePostLoginTarget("admin", "/inventory/orders"), "/inventory/orders");
  assert.equal(resolvePostLoginTarget("admin", "//evil.com"), "/dashboard");
  assert.equal(sanitizeNextParam("//evil.com"), null);
  assert.equal(sanitizeNextParam("javascript:alert(1)"), null);
  assert.equal(sanitizeNextParam("/sales/new?autoFocus=1"), "/sales/new?autoFocus=1");
});
