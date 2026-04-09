/**
 * Scale Bridge — Serial-to-WebSocket bridge for Moresco HY-918 (CH340)
 * 
 * UNIFIED VERSION: Use this for both desktop and portable scale setups.
 * Configure via environment variables or .env file.
 * 
 * Protocol (JSON over WebSocket):
 *   Server → Client:
 *     { type: "weight",  value: 0.500 }
 *     { type: "status",  connected: true, port: "COM1" }
 *     { type: "error",   message: "..." }
 *     { type: "raw",     data: "ST,GS,+ 0.500kg" }
 */

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('serialport');
const WebSocket = require('ws');

// ── Config ──────────────────────────────────────────────────────────────────
const SERIAL_PORT    = process.env.SCALE_PORT || 'COM1';
const BAUD_RATE      = parseInt(process.env.SCALE_BAUD || '4800', 10);
const WS_PORT        = parseInt(process.env.SCALE_WS_PORT || '9876', 10);
const RECONNECT_MS   = 3000;
const HEARTBEAT_MS   = 2000;
const WEIGHT_STABLE_THRESHOLD = 0.005; // kg — only broadcast if weight changed
const MIN_WEIGHT     = 0.001; // ignore readings below 1g (noise)

// ── State ───────────────────────────────────────────────────────────────────
let currentWeight    = 0;
let serialConnected  = false;
let port             = null;
let parser           = null;
let reconnectTimer   = null;

// ── WebSocket Server ────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ port: WS_PORT }, () => {
    console.log(`\x1b[36m⚖️  Scale Bridge WS listening on ws://localhost:${WS_PORT}\x1b[0m`);
});

function broadcast(data) {
    const msg = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

wss.on('connection', (ws) => {
    console.log(`\x1b[32m✓ Client connected (total: ${wss.clients.size})\x1b[0m`);
    
    ws.send(JSON.stringify({ type: 'status', connected: serialConnected, port: SERIAL_PORT }));
    ws.send(JSON.stringify({ type: 'weight', value: currentWeight }));

    ws.on('close', () => {
        console.log(`\x1b[33m✗ Client disconnected (total: ${wss.clients.size})\x1b[0m`);
    });
});

// ── Weight Parsing ──────────────────────────────────────────────────────────
function parseWeight(line) {
    if (!line || typeof line !== 'string') return null;
    
    const cleaned = line.trim();
    if (!cleaned) return null;

    const match = cleaned.match(/([+-]?\s*\d+[.,]?\d*)/);
    if (match) {
        const numStr = match[1].replace(/\s/g, '').replace(',', '.');
        const value = parseFloat(numStr);
        if (!isNaN(value) && isFinite(value)) {
            const absValue = Math.abs(value);
            if (absValue <= 999 && absValue >= MIN_WEIGHT) {
                return absValue;
            }
        }
    }

    return null;
}

// ── Serial Connection ───────────────────────────────────────────────────────
function connectSerial() {
    if (port && port.isOpen) return;
    
    console.log(`\x1b[36m⚖️  Connecting to ${SERIAL_PORT} at ${BAUD_RATE} baud...\x1b[0m`);

    try {
        port = new SerialPort({
            path: SERIAL_PORT,
            baudRate: BAUD_RATE,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            autoOpen: false
        });

        parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

        port.on('open', () => {
            serialConnected = true;
            console.log(`\x1b[32m✓ Serial port ${SERIAL_PORT} opened successfully\x1b[0m`);
            broadcast({ type: 'status', connected: true, port: SERIAL_PORT });
            
            if (reconnectTimer) {
                clearInterval(reconnectTimer);
                reconnectTimer = null;
            }
        });

        port.on('error', (err) => {
            console.error(`\x1b[31m✗ Serial error: ${err.message}\x1b[0m`);
            serialConnected = false;
            broadcast({ type: 'status', connected: false, port: SERIAL_PORT });
            broadcast({ type: 'error', message: err.message });
            scheduleReconnect();
        });

        port.on('close', () => {
            console.log(`\x1b[33m⚠ Serial port closed\x1b[0m`);
            serialConnected = false;
            currentWeight = 0;
            broadcast({ type: 'status', connected: false, port: SERIAL_PORT });
            broadcast({ type: 'weight', value: 0 });
            scheduleReconnect();
        });

        let rawBuffer = '';
        port.on('data', (data) => {
            rawBuffer += data.toString('ascii');
            if (rawBuffer.length > 30) rawBuffer = rawBuffer.slice(rawBuffer.length - 30);
            
            const matches = rawBuffer.match(/\d{1,3}\.\d{3}/g);
            if (matches && matches.length > 0) {
                const latestStr = matches[matches.length - 1];
                const weight = parseFloat(latestStr);
                if (!isNaN(weight) && Math.abs(weight - currentWeight) > WEIGHT_STABLE_THRESHOLD) {
                    currentWeight = weight;
                    console.log(`\x1b[32m⚖️ Peso detectado:\x1b[0m ${currentWeight} kg`);
                    broadcast({ type: 'weight', value: currentWeight });
                }
            }
        });

        port.open((err) => {
            if (err) {
                console.error(`\x1b[31m✗ Failed to open ${SERIAL_PORT}: ${err.message}\x1b[0m`);
                serialConnected = false;
                broadcast({ type: 'status', connected: false, port: SERIAL_PORT });
                scheduleReconnect();
            }
        });

    } catch (err) {
        console.error(`\x1b[31m✗ Serial init error: ${err.message}\x1b[0m`);
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    console.log(`\x1b[33m↻ Will retry serial in ${RECONNECT_MS / 1000}s...\x1b[0m`);
    reconnectTimer = setInterval(() => {
        if (!serialConnected) {
            if (port) {
                try { port.close(); } catch(e) {}
                port = null;
                parser = null;
            }
            connectSerial();
        } else {
            clearInterval(reconnectTimer);
            reconnectTimer = null;
        }
    }, RECONNECT_MS);
}

// ── Heartbeat ───────────────────────────────────────────────────────────────
setInterval(() => {
    broadcast({ type: 'weight', value: currentWeight });
}, HEARTBEAT_MS);

// ── Startup ─────────────────────────────────────────────────────────────────
console.log('');
console.log('\x1b[1m\x1b[36m╔══════════════════════════════════════════╗\x1b[0m');
console.log('\x1b[1m\x1b[36m║     ⚖️  SCALE BRIDGE v2.0 (UNIFIED)      ║\x1b[0m');
console.log('\x1b[1m\x1b[36m║     Serial → WebSocket Bridge            ║\x1b[0m');
console.log('\x1b[1m\x1b[36m╚══════════════════════════════════════════╝\x1b[0m');
console.log(`  Serial Port:  ${SERIAL_PORT}`);
console.log(`  Baud Rate:    ${BAUD_RATE}`);
console.log(`  WS Port:      ${WS_PORT}`);
console.log('');

connectSerial();

// ── Graceful shutdown ───────────────────────────────────────────────────────
process.on('SIGINT', () => {
    console.log('\n\x1b[33mShutting down...\x1b[0m');
    if (port && port.isOpen) port.close();
    wss.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    if (port && port.isOpen) port.close();
    wss.close();
    process.exit(0);
});

