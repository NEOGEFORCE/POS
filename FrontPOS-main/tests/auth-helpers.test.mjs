import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  isAdminRole,
  isAdminUser,
  isSuperAdminUser,
  isEmployeeRole,
  listAdminAliases,
  normalizeRole,
  roleOfUser,
} from "../src/lib/auth-helpers.mjs";

// ============================================================================
// Fuente unica de verdad para `isAdminRole`. Antes habia al menos cuatro sets
// paralelos que no reconocian las mismas variantes del rol. Esta prueba
// cristaliza el contrato: todos los alias oficiales caen bajo true, y los
// shapes del backend (role / Role / string suelto) se normalizan igual.
// ============================================================================

test("normalizeRole: trim + lowercase + tolera no-strings", () => {
  assert.equal(normalizeRole("ADMIN"), "admin");
  assert.equal(normalizeRole("  Administrador  "), "administrador");
  assert.equal(normalizeRole(null), "");
  assert.equal(normalizeRole(undefined), "");
  assert.equal(normalizeRole(42), "");
  assert.equal(normalizeRole(""), "");
});

test("isAdminRole: acepta los alias oficiales", () => {
  for (const alias of ["admin", "ADMIN", "Admin", "administrador", "superadmin", "SUPERADMIN", "super_admin", "super-admin", "root"]) {
    assert.equal(isAdminRole(alias), true, `${alias} debe ser admin`);
  }
});

test("isAdminRole: rechaza cualquier otro valor", () => {
  for (const role of ["cajero", "empleado", "guest", "", null, undefined, "owner", "manager"]) {
    assert.equal(isAdminRole(role), false, `${role} NO debe ser admin`);
  }
});

test("roleOfUser: lee role o Role (shape doble del backend)", () => {
  assert.equal(roleOfUser({ role: "admin" }), "admin");
  assert.equal(roleOfUser({ Role: "ADMIN" }), "admin");
  assert.equal(roleOfUser({}), "");
  assert.equal(roleOfUser(null), "");
});

test("isAdminUser: user completo, cualquier casing", () => {
  assert.equal(isAdminUser({ role: "admin" }), true);
  assert.equal(isAdminUser({ Role: "SUPERADMIN" }), true);
  assert.equal(isAdminUser({ role: "cajero" }), false);
  assert.equal(isAdminUser(null), false);
});

test("isSuperAdminUser: solo superadmin / super_admin / super-admin / root", () => {
  assert.equal(isSuperAdminUser({ role: "admin" }), false, "admin plano NO es super");
  assert.equal(isSuperAdminUser({ role: "superadmin" }), true);
  assert.equal(isSuperAdminUser({ role: "super_admin" }), true);
  assert.equal(isSuperAdminUser({ role: "root" }), true);
});

test("isEmployeeRole: cubre variantes en espanol e ingles", () => {
  assert.equal(isEmployeeRole("empleado"), true);
  assert.equal(isEmployeeRole("CAJERO"), true);
  assert.equal(isEmployeeRole("employee"), true);
  assert.equal(isEmployeeRole("cashier"), true);
  assert.equal(isEmployeeRole("admin"), false);
});

test("listAdminAliases: expone los alias para auditoria/documentacion", () => {
  const aliases = listAdminAliases();
  for (const required of ["admin", "administrador", "superadmin", "super_admin", "super-admin", "root"]) {
    assert.ok(aliases.includes(required), `falta alias requerido: ${required}`);
  }
});

// ============================================================================
// GUARDIANES ESTATICOS: todas las pantallas que decidian "es admin?" por su
// cuenta deben importar del helper central. Si alguien agrega una nueva, debe
// usar el mismo helper.
// ============================================================================

function readSrc(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("GUARDIAN) closure/page.tsx importa isAdminUser del helper central", () => {
  const src = readSrc("../src/app/(app)/dashboard/closure/page.tsx");
  assert.match(
    src,
    /from\s+['"]@\/lib\/auth-helpers\.mjs['"]/,
    "closure/page.tsx debe importar el helper central",
  );
  assert.match(src, /isAdminUser\(user\)/, "closure/page.tsx debe usar isAdminUser");
  // No debe sobrevivir el hardcode anterior (sets propios).
  assert.doesNotMatch(
    src,
    /\['admin',\s*'administrador',\s*'superadmin'\]\.includes/,
    "closure/page.tsx NO debe repetir el set hardcodeado",
  );
});

test("GUARDIAN) labels/page.tsx importa isAdminUser del helper central", () => {
  const src = readSrc("../src/app/(app)/labels/page.tsx");
  assert.match(src, /from\s+['"]@\/lib\/auth-helpers\.mjs['"]/);
  assert.match(src, /isAdminUser\(user\)/);
  assert.doesNotMatch(
    src,
    /const\s+isAdmin\s*=\s*role\s*===\s*"admin"\s*\|\|/,
    "labels/page.tsx NO debe tener la cadena de ORs local",
  );
});

test("GUARDIAN) ClosuresHistory.tsx importa isAdminUser del helper central", () => {
  const src = readSrc("../src/app/(app)/reports/components/ClosuresHistory.tsx");
  assert.match(src, /from\s+['"]@\/lib\/auth-helpers\.mjs['"]/);
  assert.match(src, /isAdminUser\(user\)/);
  assert.doesNotMatch(
    src,
    /user\?\.role\?\.toUpperCase\(\)\s*===\s*'ADMIN'/,
    "ClosuresHistory NO debe mantener el chequeo en mayusculas",
  );
});

test("GUARDIAN) payment-correction delega al helper central", () => {
  const src = readSrc("../src/lib/payment-correction.mjs");
  assert.match(src, /from\s+["']\.\/auth-helpers\.mjs["']/);
  assert.match(src, /isAdminUser/, "payment-correction debe reusar isAdminUser");
  assert.doesNotMatch(
    src,
    /ADMIN_ROLES\s*=\s*new\s+Set/,
    "payment-correction NO debe mantener su propio ADMIN_ROLES",
  );
});

test("GUARDIAN) historical-marker.isAdminRole delega al helper central", () => {
  const src = readSrc("../src/lib/historical-marker.mjs");
  assert.match(src, /from\s+["']\.\/auth-helpers\.mjs["']/);
  assert.doesNotMatch(
    src,
    /normalized\s*===\s*'admin'\s*\|\|\s*normalized\s*===\s*'administrador'/,
    "historical-marker NO debe mantener su propia tabla",
  );
});
