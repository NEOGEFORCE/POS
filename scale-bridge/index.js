// =============================================================================
// scale-bridge/index.js
//
// Puente WebSocket ↔ balanza serial + impresión térmica (ESC/POS / TSPL),
// con MODO AGENTE opcional (relay-agent.js) para operar desde fuera del PC
// de caja a través del servidor backend.
//
// Compatibilidad total con la versión anterior:
//   - Mismo WS local (default: puerto 9876), mismo auto-escaneo de puertos
//     serie, mismos mensajes `type:'status'`, `type:'weight'`, `type:'pong'`.
//   - Comandos entrantes `type:'ping'` y `type:'command'` con value
//     `'read'|'refresh'` responden exactamente igual.
//   - Mensajes `type:'printer.request'` con las acciones
//     `print|printTestPage|kickDrawer|listPrinters`, respuesta
//     `type:'printer.response'` con `requestId`, `ok`, `result?`, `error?`.
//
// Qué cambia:
//   - `SCALE_WS_HOST` (default `127.0.0.1`): el WS local ya NO abre todas
//     las interfaces por defecto. Desde fuera se entra por el servidor
//     backend vía el relay. Para volver al comportamiento anterior:
//     `SCALE_WS_HOST=0.0.0.0`.
//   - El handler de mensajes vive en una función pura (`handleIncomingMessage`)
//     que recibe un `responder` abstracto (`{send(obj)}`). Un cliente local
//     usa un responder que escribe en su WS; el relay-agent usa uno que
//     envuelve la respuesta con `{relayId, payload}`.
//   - Si están definidas las tres variables de entorno POS_SERVER_URL,
//     POS_AGENT_TOKEN y POS_CAJA_ID, se crea un relay-agent saliente que
//     reenvía al servidor backend los broadcasts (status/weight) y procesa
//     requests enrutados `{relayId, payload}`.
// =============================================================================

const { SerialPort } = require('serialport');
const WebSocket = require('ws');

const {
    LIMITS,
    validatePrinterRequest,
    isLocalOrigin,
    handlePrinterRequest,
} = require('./printer-bridge');
const { sendTcp, sendSystemWindows, listSystemPrintersWindows } = require('./print-transports');
const { createRelayAgent, readConfigFromEnv } = require('./relay-agent');

// Configuración
const PREFERRED_PORT = process.env.SCALE_PORT || 'COM1';
const BAUD_RATE      = parseInt(process.env.SCALE_BAUD || '4800', 10);
const WS_PORT        = parseInt(process.env.SCALE_WS_PORT || '9876', 10);
// SCALE_WS_HOST: hostname en el que el WS local escucha. Por defecto el
// bridge se restringe a `127.0.0.1` porque desde fuera se entra por el
// servidor backend (relay). Para abrirlo a toda la LAN, exportar
// `SCALE_WS_HOST=0.0.0.0`. Ver README-RELAY.md.
const WS_HOST        = process.env.SCALE_WS_HOST || '127.0.0.1';
const RECONNECT_MS   = 2000;
const WEIGHT_DIFF_THRESHOLD = 0.003; // kg

console.log('====================================================');
console.log('⚖️  SCALE BRIDGE v2.2 (balanza + impresión + relay)');
console.log('====================================================');
console.log(`Puerto preferido: ${PREFERRED_PORT} | Baud: ${BAUD_RATE} | WS: ${WS_HOST}:${WS_PORT}`);
console.log(`Printer bridge: TCP (9100 default) + Windows RAW spool (print-raw.ps1)`);
console.log(`Printer discovery: listPrinters WS action (list-printers.ps1)`);

// ---------------------------------------------------------------------------
// Servidor WebSocket local
// ---------------------------------------------------------------------------
//
// - `host` se restringe por defecto a loopback: cambios desde fuera entran
//   por el servidor backend (modo relay). SCALE_WS_HOST=0.0.0.0 restaura
//   el comportamiento anterior.
// - `maxPayload` fuerza el límite duro del mensaje JSON entrante.
// - `verifyClient` sincronico corta orígenes no locales si alguien decide
//   abrir el WS a la LAN. Permisivo con apps embebidas (sin Origin).
// ---------------------------------------------------------------------------
let wss;
try {
    wss = new WebSocket.Server(
        {
            port: WS_PORT,
            host: WS_HOST,
            maxPayload: LIMITS.maxMessageBytes,
            verifyClient: (info) => {
                const origin = info.origin || info.req.headers?.origin || '';
                if (!isLocalOrigin(origin)) {
                    console.warn(`✗ WS rechazado por origin "${origin}"`);
                    return false;
                }
                return true;
            },
        },
        () => {
            console.log(`✓ Servidor WebSocket escuchando en ws://${WS_HOST}:${WS_PORT}`);
            // Invariante singleton: sólo la instancia que logró reservar
            // WS_PORT puede abrir la báscula. Antes scanAndConnect() corría
            // al final del módulo incluso si otro bridge ya tenía 9876;
            // ese duplicado quedaba invisible pero retenía COM1.
            scanAndConnect();
            // Modo agente: se arranca después de escuchar local, para que
            // snapshot() devuelva estado coherente desde el primer mensaje.
            startRelayAgentIfConfigured();
        },
    );
} catch (e) {
    console.error(`❌ Error iniciando WebSocket en puerto ${WS_PORT}:`, e.message);
}

let activePort = null;
let currentWeight = 0;
let isConnected = false;
let reconnectTimer = null;
let isScanning = false;
let relayAgent = null;

function broadcast(data) {
    const msg = JSON.stringify(data);
    if (wss) {
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                try { client.send(msg); } catch (e) { /* cliente roto */ }
            }
        });
    }
    // Relay: todo lo que se hace broadcast local se publica al servidor,
    // envuelto en {payload} para que éste lo reparta a los clientes de la
    // caja. Si el agente no está conectado, es un no-op silencioso.
    if (relayAgent) {
        try { relayAgent.broadcast(data); } catch (_) { /* no romper el loop local */ }
    }
}

/**
 * Convierte el resultado del handler en un mensaje `printer.response`.
 * Si el handler explota con una excepción no capturada, generamos un
 * fallback accionable para que el frontend muestre un toast legible.
 */
function makeResponseMessage(requestId, result) {
    if (!result || typeof result !== 'object') {
        return {
            type: 'printer.response',
            requestId,
            ok: false,
            error: 'respuesta vacía del bridge',
            errorCode: 'INVALID_REQUEST',
        };
    }
    const base = { type: 'printer.response', requestId, ok: !!result.ok };
    if (result.ok) {
        base.result = result.result ?? {};
    } else {
        base.error = result.error || 'error desconocido';
        base.errorCode = result.errorCode || 'INVALID_REQUEST';
    }
    return base;
}

/**
 * Procesa un `printer.request` ya parseado, respondiendo por el `responder`
 * abstracto (puede ser el WS local o el canal relay con envoltorio).
 */
async function processPrinterMessage(responder, raw) {
    const validation = validatePrinterRequest(raw);
    if (!validation.ok) {
        const requestId = typeof raw?.requestId === 'string' || typeof raw?.requestId === 'number'
            ? String(raw.requestId).slice(0, 80)
            : '';
        responder.send({
            type: 'printer.response',
            requestId,
            ok: false,
            error: validation.message,
            errorCode: validation.code,
        });
        return;
    }
    const { requestId, action, payload } = validation.request;
    try {
        const result = await handlePrinterRequest({ requestId, action, payload }, {
            sendTcp,
            sendSystem: sendSystemWindows,
            listSystemPrinters: listSystemPrintersWindows,
        });
        responder.send(makeResponseMessage(requestId, result));
        const kind = result?.result?.kind || action;
        if (result?.ok) {
            console.log(`✓ printer.${action} [${requestId}] via ${result.result?.transport || '?'} (${result.result?.bytes ?? '?'} B) ${kind}`);
        } else {
            console.warn(`✗ printer.${action} [${requestId}] ${result.errorCode}: ${result.error}`);
        }
    } catch (err) {
        console.error(`✗ printer.${action} [${requestId}] excepción:`, err?.stack || err);
        responder.send({
            type: 'printer.response',
            requestId,
            ok: false,
            error: err?.message || 'error interno',
            errorCode: 'INVALID_REQUEST',
        });
    }
}

/**
 * Despacha un mensaje ya parseado del protocolo local del bridge.
 * El `responder` abstrae de dónde viene el mensaje: cliente local o relay.
 * - Local: `send(obj)` escribe en el WS del cliente.
 * - Relay: `send(obj)` envía `{relayId, payload: obj}` al servidor backend,
 *   que a su vez lo entrega al cliente correcto.
 *
 * El protocolo visto desde el payload es IDÉNTICO en ambos casos: esto es
 * lo que hace que el frontend reutilice su cliente sin cambios.
 */
function handleIncomingMessage(data, responder) {
    if (!data || typeof data !== 'object') return;

    // === Protocolo balanza =====================================
    if (data.type === 'ping') {
        responder.send({ type: 'pong' });
        return;
    }
    if (data.type === 'command' && (data.value === 'read' || data.value === 'refresh')) {
        responder.send({
            type: 'weight',
            value: currentWeight,
            display: currentWeight.toFixed(3),
        });
        return;
    }

    // === Protocolo impresión ===================================
    if (data.type === 'printer.request') {
        // Fire-and-forget: la promesa interna responde al cliente.
        processPrinterMessage(responder, data).catch((err) => {
            console.error('✗ printer.request error no capturado:', err);
        });
        return;
    }
    // Mensajes desconocidos → ignorar (compat con clientes viejos).
}

function safeSend(ws, obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* conexión caída */ }
}

if (wss) {
    wss.on('connection', (ws, req) => {
        console.log(`✓ Cliente POS conectado al WebSocket (Total: ${wss.clients.size})`);

        // Snapshot inicial: estado del puerto + último peso conocido.
        ws.send(JSON.stringify({
            type: 'status',
            connected: isConnected,
            port: activePort ? activePort.path : '',
        }));
        ws.send(JSON.stringify({
            type: 'weight',
            value: currentWeight,
            display: currentWeight.toFixed(3),
        }));

        const localResponder = { send: (obj) => safeSend(ws, obj) };

        ws.on('message', (message) => {
            // Guardia extra: ws ya recorta por maxPayload, pero esto evita
            // JSON.parse sobre buffers enormes si cambiara la config.
            if (message && message.length > LIMITS.maxMessageBytes) {
                safeSend(ws, {
                    type: 'printer.response',
                    requestId: '',
                    ok: false,
                    error: 'mensaje excede el límite',
                    errorCode: 'PAYLOAD_TOO_LARGE',
                });
                return;
            }
            let data;
            try {
                data = JSON.parse(message);
            } catch (e) {
                // Mensaje no-JSON: lo ignoramos silenciosamente igual que antes.
                return;
            }
            handleIncomingMessage(data, localResponder);
        });

        ws.on('close', () => {
            console.log(`✗ Cliente POS desconectado (Restantes: ${wss.clients.size})`);
        });

        ws.on('error', (err) => {
            // Normalizamos para no spammear stack traces del wire-protocol.
            console.warn(`⚠ WS cliente error: ${err?.message || err}`);
        });
    });

    wss.on('error', (err) => {
        console.error('❌ WS server error:', err?.message || err);
        // EADDRINUSE significa que ya existe una instancia saludable dueña
        // de 9876. Este proceso no debe seguir vivo ni intentar abrir COM1:
        // salir evita el bridge fantasma que bloqueó la báscula en producción.
        if (err?.code === 'EADDRINUSE') {
            process.exit(1);
        }
    });
}

// ---------------------------------------------------------------------------
// Modo AGENTE (relay saliente). Opcional: sólo si están las 3 env vars.
// ---------------------------------------------------------------------------

function buildSnapshot() {
    return [
        {
            type: 'status',
            connected: isConnected,
            port: activePort ? activePort.path : '',
        },
        {
            type: 'weight',
            value: currentWeight,
            display: currentWeight.toFixed(3),
        },
    ];
}

function startRelayAgentIfConfigured() {
    const cfg = readConfigFromEnv();
    if (!cfg) {
        console.log('↷ Modo agente desactivado (faltan POS_SERVER_URL / POS_AGENT_TOKEN / POS_CAJA_ID)');
        return;
    }
    try {
        relayAgent = createRelayAgent({
            serverUrl: cfg.serverUrl,
            token: cfg.token,
            cajaId: cfg.cajaId,
            handleMessage: handleIncomingMessage,
            snapshot: buildSnapshot,
        });
        relayAgent.start();
        console.log(`↗ Modo agente activo → ${cfg.serverUrl} (caja_id=${cfg.cajaId})`);
    } catch (err) {
        console.error('❌ Error iniciando relay-agent:', err?.message || err);
        relayAgent = null;
    }
}

// ---------------------------------------------------------------------------
// Balanza — intacta respecto a la versión v2.0 unificada.
// ---------------------------------------------------------------------------

async function tryOpenPort(portPath) {
    return new Promise((resolve) => {
        try {
            console.log(`Intentando conectar a ${portPath} (${BAUD_RATE} baud)...`);
            const p = new SerialPort({
                path: portPath,
                baudRate: BAUD_RATE,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                autoOpen: false,
            });

            p.open((err) => {
                if (err) {
                    console.log(`✗ No se pudo abrir ${portPath}: ${err.message}`);
                    resolve(null);
                } else {
                    console.log(`✓ ¡PUERTO ${portPath} ABIERTO CON ÉXITO!`);
                    resolve(p);
                }
            });
        } catch (e) {
            resolve(null);
        }
    });
}

async function scanAndConnect() {
    if (isScanning || (activePort && activePort.isOpen)) return;
    isScanning = true;

    try {
        const ports = await SerialPort.list();
        const portPaths = ports.map((p) => p.path);
        console.log(`Puertos COM detectados en el sistema: [${portPaths.join(', ') || 'Ninguno'}]`);

        const targetPorts = [];
        if (PREFERRED_PORT && portPaths.includes(PREFERRED_PORT)) {
            targetPorts.push(PREFERRED_PORT);
        }

        ports.forEach((p) => {
            const desc = (p.friendlyName || p.manufacturer || '').toLowerCase();
            if (
                p.path !== PREFERRED_PORT &&
                (desc.includes('ch340') ||
                    desc.includes('usb') ||
                    desc.includes('serial') ||
                    desc.includes('prolific') ||
                    desc.includes('ftdi'))
            ) {
                targetPorts.push(p.path);
            }
        });

        portPaths.forEach((p) => {
            if (!targetPorts.includes(p)) {
                targetPorts.push(p);
            }
        });

        if (targetPorts.length === 0 && PREFERRED_PORT) {
            targetPorts.push(PREFERRED_PORT);
        }

        for (const portPath of targetPorts) {
            const p = await tryOpenPort(portPath);
            if (p) {
                setupPort(p);
                isScanning = false;
                return;
            }
        }
    } catch (e) {
        console.error('Error durante escaneo de puertos:', e.message);
    }

    isScanning = false;
    scheduleReconnect();
}

function setupPort(p) {
    activePort = p;
    isConnected = true;
    broadcast({ type: 'status', connected: true, port: p.path });

    let rawBuffer = '';

    p.on('data', (chunk) => {
        const str = chunk.toString('ascii');
        rawBuffer += str;

        if (rawBuffer.length > 50) {
            rawBuffer = rawBuffer.slice(rawBuffer.length - 50);
        }

        const matches = rawBuffer.match(/\d{1,3}\.\d{2,3}/g);
        if (matches && matches.length > 0) {
            const latestStr = matches[matches.length - 1];
            const peso = parseFloat(latestStr);
            if (!isNaN(peso) && peso >= 0) {
                if (
                    Math.abs(peso - currentWeight) >= WEIGHT_DIFF_THRESHOLD ||
                    (peso === 0 && currentWeight > 0)
                ) {
                    currentWeight = peso;
                    console.log(`⚖️ Peso recibido (${p.path}): ${peso.toFixed(3)} kg`);
                    broadcast({ type: 'weight', value: peso, display: peso.toFixed(3) });
                }
            }
        }
    });

    p.on('error', (err) => {
        console.error(`✗ Error en puerto ${p.path}:`, err.message);
        handlePortClose();
    });

    p.on('close', () => {
        console.log(`⚠ Puerto ${p.path} cerrado`);
        handlePortClose();
    });
}

function handlePortClose() {
    isConnected = false;
    currentWeight = 0;
    if (activePort) {
        try { activePort.close(); } catch (e) { /* ya cerrado */ }
        activePort = null;
    }
    broadcast({ type: 'status', connected: false, port: '' });
    broadcast({ type: 'weight', value: 0, display: '0.000' });
    scheduleReconnect();
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    console.log(`↻ Reintentando conexión en ${RECONNECT_MS / 1000}s...`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!activePort || !activePort.isOpen) {
            scanAndConnect();
        }
    }, RECONNECT_MS);
}

// `scanAndConnect()` se inicia exclusivamente en el callback `listening`
// del WebSocket. No moverlo de nuevo al top-level: ése es el cerrojo que
// impide que una segunda instancia sin 9876 capture COM1.

setInterval(() => {
    if (isConnected) {
        broadcast({
            type: 'weight',
            value: currentWeight,
            display: currentWeight.toFixed(3),
        });
    }
}, 2000);

process.on('SIGINT', () => {
    if (relayAgent) { try { relayAgent.stop(); } catch (_) {} }
    if (activePort && activePort.isOpen) activePort.close();
    if (wss) wss.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    if (relayAgent) { try { relayAgent.stop(); } catch (_) {} }
    if (activePort && activePort.isOpen) activePort.close();
    if (wss) wss.close();
    process.exit(0);
});
