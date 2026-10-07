import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sidebar = join(here, "..", "src", "components", "app-sidebar.tsx");

// ============================================================================
// Guardianes del menú lateral — el módulo /loans tiene que estar presente,
// debajo de /expenses (son hermanos conceptuales), y usar el icono HandCoins
// para no colisionar con /sales/debts (Landmark).
// ============================================================================

test("app-sidebar: tiene entrada href '/loans'", async () => {
  const src = await readFile(sidebar, "utf8");
  assert.match(src, /href:\s*"\/loans"/, "Falta el ítem /loans en el menú lateral");
});

test("app-sidebar: /loans usa el icono HandCoins (no choca con /sales/debts=Landmark)", async () => {
  const src = await readFile(sidebar, "utf8");
  assert.match(
    src,
    /\{\s*href:\s*"\/loans",[^}]*icon:\s*HandCoins/,
    "/loans debe usar HandCoins como icono",
  );
  assert.match(
    src,
    /import[\s\S]*HandCoins[\s\S]*from\s+["']lucide-react["']/,
    "HandCoins debe estar importado de lucide-react",
  );
});

test("app-sidebar: /loans está DEBAJO de /expenses (son flujos financieros hermanos)", async () => {
  const src = await readFile(sidebar, "utf8");
  const idxExpenses = src.indexOf('href: "/expenses"');
  const idxLoans = src.indexOf('href: "/loans"');
  assert.ok(idxExpenses >= 0, "falta la entrada /expenses como referencia");
  assert.ok(idxLoans > idxExpenses, "/loans debe aparecer después de /expenses en el array menuItems");
});

test("app-sidebar: /loans NO es adminOnly (empleados ven la pantalla; crear/pagar lo gatea la UI)", async () => {
  const src = await readFile(sidebar, "utf8");
  // La entrada no debería declarar adminOnly: true. La restricción fina se
  // hace en la pantalla (botones de crear/pagar) y en el backend
  // (role_middleware admin para mutaciones).
  const re = /\{\s*href:\s*"\/loans"[^}]*\}/;
  const match = re.exec(src);
  assert.ok(match, "No se pudo localizar el bloque del ítem /loans");
  assert.ok(
    !/adminOnly:\s*true/.test(match[0]),
    "/loans no debe ser adminOnly — los empleados consultan, admin aprueba.",
  );
});
