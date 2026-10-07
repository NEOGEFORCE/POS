// ============================================================================
// Helpers de reautenticación: preservar la ruta de retorno de forma segura.
// ============================================================================
//
// Al expulsar al usuario a /login (por timeout o 401 agotado), llevamos
// la ruta previa como `?next=<url interna>`. Al autenticar, el flujo
// vuelve a esa ruta en lugar de ir al dashboard genérico.
//
// Para evitar open-redirect, los `next` sólo son válidos si:
//   - Empiezan con "/" y NO con "//" ni con "/\\" (bypass clásico).
//   - No contienen esquema ("javascript:", "http:", "data:", etc.).
//   - No apuntan a "/login" ni "/setup" (ciclos y páginas públicas).
//   - Longitud razonable (<2000 chars).
//
// Si el `next` no es seguro, el helper devuelve `null` y el llamador debe
// caer al destino por rol (admin → /dashboard, demás → /sales/new).

const INTERNAL_PATH_MAX_LENGTH = 2000;
// Prefijos que denotan intento de open-redirect o rutas no útiles para
// preservar flujo. `//` es el bypass clásico (protocol-relative URL).
const DISALLOWED_PREFIXES = ["//", "/\\", "/login", "/setup"];

export function sanitizeNextParam(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (value.length > INTERNAL_PATH_MAX_LENGTH) return null;
  if (!value.startsWith("/")) return null;
  if (value.includes(":")) return null;
  for (const bad of DISALLOWED_PREFIXES) {
    // Caso exacto, o siguen "/", "?" o CUALQUIER otro carácter (dominio).
    // Ejemplo: `//evil.com` empieza con `//` y debe rechazarse.
    if (value === bad) return null;
    if (value.startsWith(bad + "/")) return null;
    if (value.startsWith(bad + "?")) return null;
    // Los prefijos `//` y `/\\` no son rutas legítimas: cualquier texto
    // detrás de ellos los convierte en open-redirect.
    if ((bad === "//" || bad === "/\\") && value.startsWith(bad)) return null;
  }
  return value;
}

export function defaultRoleTarget(role) {
  const normalized = (role || "").toLowerCase();
  if (["admin", "administrador", "superadmin"].includes(normalized)) return "/dashboard";
  return "/sales/new";
}

export function resolvePostLoginTarget(role, nextRaw) {
  const safe = sanitizeNextParam(nextRaw);
  if (safe) return safe;
  return defaultRoleTarget(role);
}
