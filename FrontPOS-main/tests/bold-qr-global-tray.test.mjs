// =============================================================================
// tests/bold-qr-global-tray.test.mjs
//
// Guardianes estáticos para la bandeja global "QR en espera" montada en
// el header de admin / superadmin (F4 del sprint 2026-10-24).
//
// Reglas duras:
//
//   R1. `AppHeader` monta <GlobalBoldQrTray /> y resuelve el flag
//       `enabled` usando `isAdminUser(user)` (fuente única de verdad
//       de roles) + `pathname !== "/sales/new"` (para no duplicar la
//       bandeja local del cajero).
//
//   R2. El hook `useBoldQrGlobalTray` consulta GET
//       `/pos/pagos-qr/pendientes?scope=all` y suscribe SSE a
//       `/pos/pagos-qr/caja-stream?scope=all`. Nunca filtra por caja.
//
//   R3. El componente `GlobalBoldQrTray` reutiliza el contrato ya
//       existente de confirmación manual (POST
//       `/pos/pagos-qr/confirmar-manual`). El backend lo audita por
//       sesión; aquí sólo pasamos venta_temp_id + nota.
//
//   R4. No se dispara sonido ni voz desde el flujo global. Lo
//       validamos buscando ausencia de los helpers `playNotificationSound`
//       y `BOLD_QR_VOICE_PREFERRED_LANG` en el nuevo bundle del
//       componente/hook.
//
//   R5. El componente usa pares `dark:` para los principales colores,
//       cumpliendo la convención visual del repo (bg-white dark:bg-zinc-950,
//       texto zinc-900 dark:zinc-50).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const APP_HEADER = join(repoRoot, "src", "components", "app-header.tsx");
const GLOBAL_TRAY = join(
    repoRoot,
    "src",
    "components",
    "shared",
    "GlobalBoldQrTray.tsx",
);
const GLOBAL_HOOK = join(repoRoot, "src", "hooks", "useBoldQrGlobalTray.ts");
const SALES_NEW_PAGE = join(
    repoRoot,
    "src",
    "app",
    "(app)",
    "sales",
    "new",
    "page.tsx",
);

function read(p) {
    return readFileSync(p, "utf8");
}
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// R1. AppHeader monta la bandeja y aplica los dos predicados correctos.
// ---------------------------------------------------------------------------

test("AppHeader importa GlobalBoldQrTray y usa isAdminUser de auth-helpers.mjs", () => {
    const src = read(APP_HEADER);
    // Aceptamos import estático o dinámico (next/dynamic) hacia el
    // mismo módulo compartido.
    assert.match(
        src,
        /["']@\/components\/shared\/GlobalBoldQrTray["']/,
        "AppHeader debe importar <GlobalBoldQrTray /> desde components/shared.",
    );
    assert.match(
        src,
        /from\s+["']@\/lib\/auth-helpers\.mjs["']/,
        "AppHeader debe usar el helper único `isAdminUser` desde auth-helpers.mjs.",
    );
});

test("AppHeader condiciona el montaje a admin + ruta distinta de /sales/new", () => {
    const src = read(APP_HEADER);
    const runtime = stripComments(src);
    // Flag combinado: isAdminUser(user) && pathname !== "/sales/new"
    assert.match(
        runtime,
        /isAdminUser\(user\)\s*&&\s*pathname\s*!==\s*["']\/sales\/new["']/,
        "El flag `enabled` debe combinar isAdminUser(user) con pathname !== '/sales/new'.",
    );
    // La prop se pasa al componente.
    assert.match(
        runtime,
        /<GlobalBoldQrTray[\s\S]{0,300}enabled=\{\s*isGlobalQrTrayEnabled\s*\}/,
        "AppHeader debe pasar `enabled` al indicador global.",
    );
    assert.match(
        runtime,
        /canConfirmManual=\{\s*isGlobalQrTrayEnabled\s*\}/,
        "AppHeader debe pasar `canConfirmManual` (admin-only coincide con enabled).",
    );
});

test("La bandeja global NO se monta en /sales/new (no está entre sus imports/jsx)", () => {
    const src = read(SALES_NEW_PAGE);
    assert.ok(
        !/GlobalBoldQrTray/.test(src),
        "/sales/new no debe montar <GlobalBoldQrTray />; ahí vive la bandeja local del cajero.",
    );
});

// ---------------------------------------------------------------------------
// R2. El hook habla con el backend con `scope=all` en pendientes y en SSE.
// ---------------------------------------------------------------------------

test("useBoldQrGlobalTray llama GET /pos/pagos-qr/pendientes?scope=all", () => {
    const src = read(GLOBAL_HOOK);
    assert.match(
        src,
        /\/pos\/pagos-qr\/pendientes\?scope=all/,
        "El hook debe pedir pendientes con scope=all (bandeja global).",
    );
});

test("useBoldQrGlobalTray suscribe SSE /pos/pagos-qr/caja-stream?scope=all", () => {
    const src = read(GLOBAL_HOOK);
    assert.match(
        src,
        /\/pos\/pagos-qr\/caja-stream\?scope=all/,
        "El hook debe suscribirse al SSE global con scope=all.",
    );
});

test("useBoldQrGlobalTray NUNCA filtra por caja_id en pendientes/SSE", () => {
    const src = read(GLOBAL_HOOK);
    const runtime = stripComments(src);
    assert.ok(
        !/caja_id=/.test(runtime),
        "La bandeja global no debe pasar caja_id en ningún query (es global).",
    );
});

test("useBoldQrGlobalTray reutiliza Authorization: Bearer del hook de sesión", () => {
    const src = read(GLOBAL_HOOK);
    // Lo propagamos por `useAuth` + `Authorization: Bearer ${token}`.
    assert.match(
        src,
        /Authorization:\s*`Bearer \$\{token\}`/,
        "La SSE global debe autenticarse con `Authorization: Bearer <token>`.",
    );
    assert.match(
        src,
        /from\s+["']@\/lib\/auth["']/,
        "El hook debe leer el token desde useAuth().",
    );
});

// ---------------------------------------------------------------------------
// R3. Confirmación manual reutiliza el endpoint existente.
// ---------------------------------------------------------------------------

test("useBoldQrGlobalTray.confirmManualIntent apunta a /pos/pagos-qr/confirmar-manual", () => {
    const src = read(GLOBAL_HOOK);
    assert.match(
        src,
        /"\/pos\/pagos-qr\/confirmar-manual"/,
        "La confirmación manual debe seguir usando el endpoint existente.",
    );
    assert.match(
        src,
        /JSON\.stringify\(\{\s*venta_temp_id:\s*id,\s*nota:/,
        "Payload mínimo: { venta_temp_id, nota } — nunca DNI.",
    );
});

// ---------------------------------------------------------------------------
// R4. Sin sonido ni voz en el flujo global.
// ---------------------------------------------------------------------------

test("GlobalBoldQrTray NO reproduce sonido ni usa voz", () => {
    const comp = read(GLOBAL_TRAY);
    const hook = read(GLOBAL_HOOK);
    for (const [path, src] of [
        ["GlobalBoldQrTray.tsx", comp],
        ["useBoldQrGlobalTray.ts", hook],
    ]) {
        const runtime = stripComments(src);
        assert.ok(
            !/playNotificationSound/.test(runtime),
            `${path} no debe reproducir sonido.`,
        );
        assert.ok(
            !/BOLD_QR_VOICE_PREFERRED_LANG/.test(runtime),
            `${path} no debe usar el helper de voz.`,
        );
        assert.ok(
            !/speechSynthesis/i.test(runtime),
            `${path} no debe disparar speechSynthesis.`,
        );
    }
});

// ---------------------------------------------------------------------------
// R5. Modo claro y oscuro con pares dark:.
// ---------------------------------------------------------------------------

test("GlobalBoldQrTray usa pares dark: para texto principal", () => {
    const src = read(GLOBAL_TRAY);
    // Al menos un `bg-white dark:bg-zinc-950` + texto `text-zinc-900 dark:text-zinc-50`.
    assert.match(
        src,
        /bg-white[\s\S]{0,80}dark:bg-zinc-950/,
        "El popover debe soportar modo claro y oscuro con pares dark:.",
    );
    assert.match(
        src,
        /text-zinc-900[\s\S]{0,80}dark:text-zinc-50/,
        "El título principal debe usar texto zinc-900/dark:zinc-50.",
    );
});

test("El botón del indicador global tiene aria-label legible", () => {
    const src = read(GLOBAL_TRAY);
    assert.match(
        src,
        /aria-label=\{`Bandeja global de cobros QR \(\$\{total\} pendientes\)`\}/,
        "El trigger debe exponer `aria-label` dinámico con el contador.",
    );
});
