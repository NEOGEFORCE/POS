// =============================================================================
// tests/bridge-connection-wiring.test.mjs
//
// Guardianes estáticos de la nueva arquitectura "bridge local → relay por
// servidor". Verifican que los dos clientes WebSocket del frontend
// (`scaleBridge.ts` para peso y `pos-bridge-ws.ts` para impresión/cajón)
// USEN el módulo compartido `bridge-connection.mjs` y no reimplementen
// la resolución por su cuenta.
//
// Si alguien reintroduce `ws://${hostname}:9876` crudo o deja de llamar a
// `negotiateBridgeConnection`, este test falla antes de que el flujo
// móvil/remoto se rompa en producción.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const scaleBridgePath = join(here, "..", "src", "lib", "scaleBridge.ts");
const posBridgeWsPath = join(here, "..", "src", "lib", "pos-bridge-ws.ts");
const bridgeConnectionPath = join(here, "..", "src", "lib", "bridge-connection.mjs");
const bridgeConnectionTypesPath = join(here, "..", "src", "lib", "bridge-connection.d.mts");
const useScalePath = join(here, "..", "src", "hooks", "useScale.ts");
const providersPath = join(here, "..", "src", "app", "providers.tsx");

async function read(path) {
    return await readFile(path, "utf8");
}

// -----------------------------------------------------------------------------
// scaleBridge.ts
// -----------------------------------------------------------------------------

test("scaleBridge.ts: importa el módulo compartido en vez de hardcodear URLs", async () => {
    const src = await read(scaleBridgePath);
    assert.match(
        src,
        /from "\.\/bridge-connection\.mjs"/,
        "scaleBridge.ts debe importar desde `./bridge-connection.mjs`.",
    );
    // Imports concretos que esperamos: negociación, timeout, write caja, mode type.
    for (const token of [
        "negotiateBridgeConnection",
        "LOCAL_BRIDGE_PROBE_TIMEOUT_MS",
        "writeSavedCajaId",
        "BridgeConnectionMode",
    ]) {
        assert.ok(
            src.includes(token),
            `scaleBridge.ts debe usar \`${token}\` del módulo compartido.`,
        );
    }
});

test("scaleBridge.ts: NO reimplementa `ws://${hostname}:9876` fuera del helper", async () => {
    const src = await read(scaleBridgePath);
    // Patron histórico que vivía inline: `ws://${host}:9876` dentro de una
    // función. Si vuelve a aparecer, estamos duplicando la resolución.
    assert.doesNotMatch(
        src,
        /ws:\/\/\$\{[\w.?!]+hostname[^}]*\}/,
        "scaleBridge.ts no debe construir ws://${location.hostname}:9876 directamente — eso vive en resolveLocalBridgeUrl.",
    );
    // El fallback crudo tampoco: `ws://localhost:9876` como literal se queda
    // sólo en el módulo compartido.
    const literalCount = (src.match(/ws:\/\/localhost:9876/g) || []).length;
    assert.equal(
        literalCount, 0,
        "scaleBridge.ts no debe tener literales `ws://localhost:9876` — vienen desde `resolveLocalBridgeUrl`.",
    );
});

test("scaleBridge.ts: expone `mode` y `cajaId` en el estado reportado", async () => {
    const src = await read(scaleBridgePath);
    assert.match(src, /mode:\s*BridgeConnectionMode\s*\|\s*null/, "ScaleState debe tener mode BridgeConnectionMode | null.");
    assert.match(src, /cajaId:\s*string\s*\|\s*null/, "ScaleState debe tener cajaId string | null.");
    assert.match(src, /renegotiate\(\)/, "scaleBridge.ts debe exponer renegotiate() para el selector de caja.");
});

test("scaleBridge.ts: usa apiFetch para consultar agentes y pedir ticket", async () => {
    const src = await read(scaleBridgePath);
    assert.match(src, /from "\.\/api-error"/, "scaleBridge.ts debe importar apiFetch.");
    assert.match(src, /apiFetch</, "scaleBridge.ts debe llamar a apiFetch<...>.");
    assert.match(src, /"\/bridge\/ticket"|ticketPath/, "scaleBridge.ts debe acceder a /bridge/ticket vía apiFetch.");
    assert.match(src, /"\/bridge\/agents"|agentsPath/, "scaleBridge.ts debe acceder a /bridge/agents vía apiFetch.");
});

// -----------------------------------------------------------------------------
// pos-bridge-ws.ts
// -----------------------------------------------------------------------------

test("pos-bridge-ws.ts: importa el módulo compartido y usa negotiateBridgeConnection", async () => {
    const src = await read(posBridgeWsPath);
    assert.match(
        src,
        /from "\.\/bridge-connection\.mjs"/,
        "pos-bridge-ws.ts debe importar desde `./bridge-connection.mjs`.",
    );
    for (const token of [
        "negotiateBridgeConnection",
        "resolveLocalBridgeUrl",
        "LOCAL_BRIDGE_PROBE_TIMEOUT_MS",
        "writeSavedCajaId",
    ]) {
        assert.ok(
            src.includes(token),
            `pos-bridge-ws.ts debe usar \`${token}\` del módulo compartido.`,
        );
    }
});

test("pos-bridge-ws.ts: NO reimplementa la resolución local del bridge", async () => {
    const src = await read(posBridgeWsPath);
    // Patron antiguo `ws://${window.location.hostname}:9876` o similar debe
    // haberse ido junto con `defaultWsUrl()`.
    assert.doesNotMatch(
        src,
        /ws:\/\/\$\{[\w.?!]+hostname[^}]*\}/,
        "pos-bridge-ws.ts no debe construir URLs locales inline.",
    );
    assert.ok(
        !src.includes("defaultWsUrl"),
        "pos-bridge-ws.ts no debe conservar la función `defaultWsUrl()`: ahora delega en bridge-connection.mjs.",
    );
});

test("pos-bridge-ws.ts: expone renegotiate() y reporta mode + cajaId", async () => {
    const src = await read(posBridgeWsPath);
    assert.match(src, /renegotiate\(\)/, "pos-bridge-ws.ts debe exponer renegotiate() para el selector de caja.");
    assert.match(src, /mode:\s*(?:BridgeConnectionMode|meta\.mode)/, "Debe propagar `mode` al status.");
    assert.match(src, /cajaId:\s*(?:meta\.cajaId|negotiated\.cajaId|string)/, "Debe propagar `cajaId` al status.");
});

test("pos-bridge-ws.ts: usa apiFetch para los endpoints del relay", async () => {
    const src = await read(posBridgeWsPath);
    assert.match(src, /from "\.\/api-error"/, "pos-bridge-ws.ts debe importar apiFetch.");
    assert.match(src, /apiFetch</, "pos-bridge-ws.ts debe llamar a apiFetch<...>.");
});

// -----------------------------------------------------------------------------
// pos-bridge.ts (contrato tipado)
// -----------------------------------------------------------------------------

test("pos-bridge.ts: contrato de conectividad incluye mode y cajaId", async () => {
    const src = await read(join(here, "..", "src", "lib", "pos-bridge.ts"));
    assert.match(src, /mode\??:\s*"local"\s*\|\s*"relay"\s*\|\s*null/, "PosBridgeConnectivity debe tener mode.");
    assert.match(src, /cajaId\??:\s*string\s*\|\s*null/, "PosBridgeConnectivity debe tener cajaId.");
});

// -----------------------------------------------------------------------------
// Módulo compartido: existe y tiene las exports previstas
// -----------------------------------------------------------------------------

test("bridge-connection.mjs: exporta los símbolos públicos documentados", async () => {
    const src = await read(bridgeConnectionPath);
    for (const name of [
        "resolveLocalBridgeUrl",
        "httpBaseToWsBase",
        "buildRelayWsUrl",
        "getRelayEndpoints",
        "normalizeAgents",
        "selectCajaId",
        "readSavedCajaId",
        "writeSavedCajaId",
        "describeRelayError",
        "extractRelayErrorCode",
        "negotiateBridgeConnection",
        "POS_BRIDGE_CAJA_STORAGE_KEY",
        "LOCAL_BRIDGE_PROBE_TIMEOUT_MS",
        "RELAY_ERROR_CODES",
    ]) {
        assert.match(
            src,
            new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`),
            `bridge-connection.mjs debe exportar \`${name}\`.`,
        );
    }
});

test("bridge-connection.d.mts: declara los tipos públicos para TypeScript estricto", async () => {
    const src = await read(bridgeConnectionTypesPath);
    for (const name of [
        "resolveLocalBridgeUrl",
        "httpBaseToWsBase",
        "buildRelayWsUrl",
        "selectCajaId",
        "normalizeAgents",
        "negotiateBridgeConnection",
        "BridgeConnectionMode",
        "BridgeAgentInfo",
        "NegotiateBridgeResult",
        "NegotiateBridgeOptions",
        "RELAY_ERROR_CODES",
    ]) {
        assert.ok(src.includes(name), `bridge-connection.d.mts debe declarar \`${name}\`.`);
    }
});

// -----------------------------------------------------------------------------
// useScale.ts
// -----------------------------------------------------------------------------

test("useScale.ts: expone mode, cajaId y renegotiate", async () => {
    const src = await read(useScalePath);
    assert.match(src, /mode:\s*state\.mode/, "El hook debe exponer `mode` desde el estado.");
    assert.match(src, /cajaId:\s*state\.cajaId/, "El hook debe exponer `cajaId` desde el estado.");
    assert.match(src, /renegotiate/, "El hook debe exponer `renegotiate` para que el selector de caja fuerce el reset.");
});

// -----------------------------------------------------------------------------
// providers.tsx: escucha el evento del selector
// -----------------------------------------------------------------------------

test("providers.tsx: engancha el evento global `pos-bridge-renegotiate`", async () => {
    const src = await read(providersPath);
    assert.match(src, /pos-bridge-renegotiate/, "providers.tsx debe escuchar `pos-bridge-renegotiate`.");
    assert.match(src, /renegotiate\(\)/, "providers.tsx debe disparar `renegotiate()` en ambos clientes.");
});
