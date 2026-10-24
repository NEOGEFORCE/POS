// =============================================================================
// tests/scale-indicator-status.test.mjs
//
// Guardianes de la nueva lógica de indicador de la balanza en /sales/new.
// Compuesta por dos piezas:
//
//   1. Un helper puro `describeScaleIndicator` que mapea el estado del hook
//      `useScale` (isConnected / isScaleOnline / mode / cajaId / error) a
//      un objeto {tone, label, reason} listo para el UI.
//
//   2. El indicador del toolbar de `/sales/new/page.tsx` lo invoca y lo
//      renderiza con `data-testid="sales-toolbar-scale-indicator"`,
//      `data-tone` acorde y `title`/`aria-label` con el motivo.
//
// Si el helper cambia de contrato o el toolbar deja de usarlo, estos
// tests fallan antes de que el móvil muestre "---" sin explicación.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
    describeScaleIndicator,
    RELAY_ERROR_CODES,
} from "../src/lib/bridge-connection.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const SALES_NEW_PAGE = join(repoRoot, "src", "app", "(app)", "sales", "new", "page.tsx");
const USE_NEW_SALE = join(repoRoot, "src", "app", "(app)", "sales", "new", "hooks", "useNewSale.ts");
const BRIDGE_TYPES = join(repoRoot, "src", "lib", "bridge-connection.d.mts");

// -----------------------------------------------------------------------------
// describeScaleIndicator — pura
// -----------------------------------------------------------------------------

test("describeScaleIndicator: conectado + balanza online + relay → tone ok con 'Vía servidor · <caja>'", () => {
    const status = describeScaleIndicator({
        isConnected: true,
        isScaleOnline: true,
        mode: "relay",
        cajaId: "CAJA-01",
        error: null,
    });
    assert.equal(status.tone, "ok");
    assert.equal(status.label, "Sincronizar");
    assert.match(String(status.reason), /Vía servidor · CAJA-01/);
});

test("describeScaleIndicator: conectado + balanza online + local → tone ok con 'Bridge local'", () => {
    const status = describeScaleIndicator({
        isConnected: true,
        isScaleOnline: true,
        mode: "local",
        cajaId: null,
        error: null,
    });
    assert.equal(status.tone, "ok");
    assert.equal(status.label, "Sincronizar");
    assert.equal(status.reason, "Bridge local");
});

test("describeScaleIndicator: conectado al bridge pero balanza offline → warn", () => {
    const relay = describeScaleIndicator({
        isConnected: true,
        isScaleOnline: false,
        mode: "relay",
        cajaId: "CAJA-02",
    });
    assert.equal(relay.tone, "warn");
    assert.equal(relay.label, "Balanza offline");
    assert.match(String(relay.reason), /CAJA-02/);

    const local = describeScaleIndicator({
        isConnected: true,
        isScaleOnline: false,
        mode: "local",
    });
    assert.equal(local.tone, "warn");
    assert.match(String(local.reason), /no detectada/i);
});

test("describeScaleIndicator: reloading tiene prioridad y produce tone warn", () => {
    const status = describeScaleIndicator({
        isConnected: true,
        isScaleOnline: true,
        isReloading: true,
    });
    assert.equal(status.tone, "warn");
    assert.equal(status.label, "Esperando...");
});

test("describeScaleIndicator: desconectado por RELAY_AGENT_OFFLINE con cajaId → 'Caja X sin conexión'", () => {
    const status = describeScaleIndicator({
        isConnected: false,
        isScaleOnline: false,
        mode: null,
        cajaId: "CAJA-01",
        error: `${RELAY_ERROR_CODES.AGENT_OFFLINE}: la caja no responde`,
    });
    assert.equal(status.tone, "error");
    assert.equal(status.label, "Caja CAJA-01 sin conexión");
    assert.match(String(status.reason), /RELAY_AGENT_OFFLINE|caja no responde/);
});

test("describeScaleIndicator: usa savedCajaId si cajaId no está en el estado activo", () => {
    const status = describeScaleIndicator({
        isConnected: false,
        error: "No hay cajas conectadas al servidor para operar en remoto.",
        savedCajaId: "CAJA-07",
    });
    assert.equal(status.tone, "error");
    assert.equal(status.label, "Caja CAJA-07 sin conexión");
});

test("describeScaleIndicator: sin cajaId guardado → 'Sin cajas conectadas'", () => {
    const status = describeScaleIndicator({
        isConnected: false,
        error: "No hay cajas conectadas al servidor para operar en remoto.",
    });
    assert.equal(status.tone, "error");
    assert.equal(status.label, "Sin cajas conectadas");
});

test("describeScaleIndicator: RELAY_FORBIDDEN → 'Sin permiso'", () => {
    const status = describeScaleIndicator({
        isConnected: false,
        error: `${RELAY_ERROR_CODES.FORBIDDEN}: tu rol no permite kickDrawer`,
    });
    assert.equal(status.tone, "error");
    assert.equal(status.label, "Sin permiso");
});

test("describeScaleIndicator: error con 'ticket' → 'Servidor sin relay'", () => {
    const status = describeScaleIndicator({
        isConnected: false,
        error: "El servidor no devolvió un ticket relay válido para CAJA-01.",
    });
    assert.equal(status.tone, "error");
    assert.equal(status.label, "Servidor sin relay");
});

test("describeScaleIndicator: fallback → 'Sin conexión'", () => {
    const status = describeScaleIndicator({
        isConnected: false,
        error: null,
    });
    assert.equal(status.tone, "error");
    assert.equal(status.label, "Sin conexión");
});

test("describeScaleIndicator: null-safe, acepta estado vacío sin lanzar", () => {
    const status = describeScaleIndicator({});
    assert.equal(status.tone, "error");
    assert.equal(status.label, "Sin conexión");
});

// -----------------------------------------------------------------------------
// Tipos declarados en bridge-connection.d.mts
// -----------------------------------------------------------------------------

test("bridge-connection.d.mts expone ScaleIndicatorStatus y describeScaleIndicator", () => {
    const src = readFileSync(BRIDGE_TYPES, "utf8");
    assert.match(src, /interface\s+ScaleIndicatorStatus/, "Debe declarar ScaleIndicatorStatus.");
    assert.match(src, /interface\s+ScaleIndicatorInput/, "Debe declarar ScaleIndicatorInput.");
    assert.match(src, /describeScaleIndicator\s*\(/, "Debe exportar describeScaleIndicator.");
    assert.match(src, /ScaleIndicatorTone\s*=\s*"ok"\s*\|\s*"warn"\s*\|\s*"error"\s*\|\s*"idle"/,
        "Debe declarar ScaleIndicatorTone con los 4 valores.");
});

// -----------------------------------------------------------------------------
// useNewSale expone estado detallado del bridge
// -----------------------------------------------------------------------------

test("useNewSale.ts destructura mode/cajaId/error/isConnected desde useScale", () => {
    const src = readFileSync(USE_NEW_SALE, "utf8");
    assert.match(src, /isConnected:\s*isScaleConnected/,
        "Debe destructurar isConnected del hook (renombrado a isScaleConnected).");
    assert.match(src, /mode:\s*scaleBridgeMode/,
        "Debe exponer scaleBridgeMode desde useScale.");
    assert.match(src, /cajaId:\s*scaleBridgeCajaId/,
        "Debe exponer scaleBridgeCajaId desde useScale.");
    assert.match(src, /error:\s*scaleBridgeError/,
        "Debe exponer scaleBridgeError desde useScale.");
});

test("useNewSale.ts regresa los nuevos campos al consumidor", () => {
    const src = readFileSync(USE_NEW_SALE, "utf8");
    for (const token of ["isScaleConnected,", "scaleBridgeMode,", "scaleBridgeCajaId,", "scaleBridgeError,"]) {
        assert.ok(src.includes(token), `useNewSale debe retornar \`${token.slice(0, -1)}\`.`);
    }
});

// -----------------------------------------------------------------------------
// sales/new/page.tsx consume el helper y renderiza el indicador
// -----------------------------------------------------------------------------

test("sales/new/page.tsx importa describeScaleIndicator desde bridge-connection", () => {
    const src = readFileSync(SALES_NEW_PAGE, "utf8");
    assert.match(
        src,
        /import\s*\{\s*describeScaleIndicator\s*\}\s*from\s*['"]@\/lib\/bridge-connection\.mjs['"]/,
        "page.tsx debe importar describeScaleIndicator del módulo compartido.",
    );
});

test("sales/new/page.tsx destructura isScaleConnected/scaleBridgeMode/scaleBridgeCajaId/scaleBridgeError", () => {
    const src = readFileSync(SALES_NEW_PAGE, "utf8");
    for (const token of ["isScaleConnected", "scaleBridgeMode", "scaleBridgeCajaId", "scaleBridgeError"]) {
        assert.ok(
            src.includes(token),
            `page.tsx debe destructurar \`${token}\` desde useNewSale.`,
        );
    }
});

test("sales/new/page.tsx: el indicador invoca describeScaleIndicator con todos los campos", () => {
    const src = readFileSync(SALES_NEW_PAGE, "utf8");
    const match = src.match(/describeScaleIndicator\(\{([\s\S]{0,800}?)\}\)/);
    assert.ok(match, "El page.tsx debe llamar a describeScaleIndicator({...}).");
    const body = match[1];
    for (const key of ["isConnected", "isScaleOnline", "isReloading", "mode", "cajaId", "error"]) {
        assert.match(
            body,
            new RegExp(`\\b${key}:?\\b`),
            `La llamada a describeScaleIndicator debe pasar \`${key}\`.`,
        );
    }
});

test("sales/new/page.tsx: el indicador expone data-testid y data-tone para el motivo", () => {
    const src = readFileSync(SALES_NEW_PAGE, "utf8");
    assert.match(
        src,
        /data-testid=['"]sales-toolbar-scale-indicator['"]/,
        "El indicador debe tener data-testid='sales-toolbar-scale-indicator'.",
    );
    assert.match(
        src,
        /data-tone=\{scaleStatus\.tone\}/,
        "El indicador debe propagar scaleStatus.tone como data-tone.",
    );
    assert.match(
        src,
        /aria-label=\{`Estado de la balanza:/,
        "El indicador debe anunciarse por accesibilidad con aria-label que empiece por 'Estado de la balanza:'.",
    );
});

test("sales/new/page.tsx: el indicador YA NO usa el ternario Offline/Sincronizar fijo", () => {
    const src = readFileSync(SALES_NEW_PAGE, "utf8");
    // El antiguo ternario hardcoded era:
    //   `${isScaleReloading ? 'Esperando...' : isScaleOnline ? 'Sincronizar' : 'Offline'}`
    // Se reemplaza por `scaleStatus.label`. Si el ternario viejo vuelve,
    // perdemos el motivo detallado.
    assert.doesNotMatch(
        src,
        /isScaleReloading \? 'Esperando\.\.\.' : isScaleOnline \? 'Sincronizar' : 'Offline'/,
        "El ternario viejo del indicador se reemplazó con scaleStatus.label.",
    );
});
