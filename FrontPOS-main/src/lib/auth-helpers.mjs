// Fuente única de verdad para la detección de roles con privilegios admin.
//
// Antes había al menos tres sets paralelos:
//   - src/app/(app)/dashboard/closure/page.tsx       (hardcode local)
//   - src/app/(app)/labels/page.tsx                  (hardcode local)
//   - src/app/(app)/reports/components/ClosuresHistory.tsx (otro set)
//   - src/lib/payment-correction.mjs::isAdmin        (set paralelo)
//   - src/lib/historical-marker.mjs::isAdminRole     (otro set)
//
// Esta duplicación hacía que, por ejemplo, un rol "SUPERADMIN" en mayúsculas
// pasara en una pantalla y en otra no, o que una variante en español como
// "administrador" fuera reconocida sólo en algunos puntos.
//
// Este módulo centraliza la decisión. Es puro JS (.mjs) sin dependencias para
// poder usarse desde:
//   - código cliente de Next.js (componentes "use client")
//   - tests con `node --test`
//   - helpers puros en otros archivos .mjs
//
// Reglas:
//   - El rol se normaliza con trim + lowercase.
//   - Se aceptan: "admin", "administrador", "superadmin", "super_admin",
//     "super-admin", "root".
//   - Cualquier otro valor devuelve false.
//   - null/undefined/"" devuelven false sin lanzar.

const ADMIN_ROLES = new Set([
  "admin",
  "administrador",
  "superadmin",
  "super_admin",
  "super-admin",
  "root",
]);

const SUPERADMIN_ROLES = new Set([
  "superadmin",
  "super_admin",
  "super-admin",
  "root",
]);

const EMPLOYEE_ROLES = new Set([
  "empleado",
  "employee",
  "cajero",
  "cashier",
]);

/**
 * Normaliza un string de rol a su forma canónica.
 * @param {unknown} role
 * @returns {string} rol en minúsculas y sin espacios, o "" si no es string.
 */
export function normalizeRole(role) {
  if (role === null || role === undefined) return "";
  if (typeof role !== "string") return "";
  return role.trim().toLowerCase();
}

/**
 * Extrae el rol efectivo de un objeto `user` (con tolerancia a shapes del
 * backend: `role` o `Role`).
 * @param {{ role?: unknown; Role?: unknown } | null | undefined} user
 */
export function roleOfUser(user) {
  if (!user || typeof user !== "object") return "";
  const raw = /** @type {any} */ (user).role ?? /** @type {any} */ (user).Role;
  return normalizeRole(raw);
}

/**
 * Verdadero cuando el rol tiene privilegios administrativos.
 * Acepta la cadena del rol directamente ("admin", "administrador"...).
 * @param {string | null | undefined} role
 */
export function isAdminRole(role) {
  return ADMIN_ROLES.has(normalizeRole(role));
}

/**
 * Verdadero cuando el usuario (objeto completo) es admin.
 * @param {{ role?: unknown; Role?: unknown } | null | undefined} user
 */
export function isAdminUser(user) {
  return ADMIN_ROLES.has(roleOfUser(user));
}

/**
 * Verdadero cuando el usuario es superadmin estricto (más que admin común).
 * Útil para acciones destructivas de nivel sistema.
 * @param {{ role?: unknown; Role?: unknown } | null | undefined} user
 */
export function isSuperAdminUser(user) {
  return SUPERADMIN_ROLES.has(roleOfUser(user));
}

/**
 * Verdadero cuando el rol es de empleado operativo (cajero).
 * @param {string | null | undefined} role
 */
export function isEmployeeRole(role) {
  return EMPLOYEE_ROLES.has(normalizeRole(role));
}

/**
 * Devuelve la lista exacta de alias de admin. Útil en tests y para registrar
 * en documentación operativa.
 * @returns {string[]}
 */
export function listAdminAliases() {
  return [...ADMIN_ROLES];
}
