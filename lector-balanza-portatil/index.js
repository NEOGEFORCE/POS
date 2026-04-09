/**
 * Scale Bridge — Serial-to-WebSocket bridge for Moresco HY-918 (CH340)
 * 
 * Reads weight data from COM port and broadcasts to all WebSocket clients
 * on ws://localhost:9876
 * 
 * Protocol (JSON over WebSocket):
 *   Server → Client:
 *     { type: "weight",  value: 0.500 }
 *     { type: "status",  connected: true, port: "COM1" }
 *     { type: "error",   message: "..." }
 *     { type: "raw",     data: "ST,GS,+ 0.500kg" }  // debug
 */

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('serialport');
const WebSocket = require('ws');

// ── Config ──────────────────────────────────────────────────────────────────
const SERIAL_PORT    = process.env.SCALE_PORT || 'COM1';
const BAUD_RATE      = parseInt(process.env.SCALE_BAUD || '9600', 10);
const WS_PORT        = parseInt(process.env.SCALE_WS_PORT || '9876', 10);
const RECONNECT_MS   = 3000;   // retry serial connection every 3s
const HEARTBEAT_MS   = 2000;   // send weight to clients every 2s even if unchanged

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
    
    // Send current state immediately
    ws.send(JSON.stringify({ type: 'status', connected: serialConnected, port: SERIAL_PORT }));
    ws.send(JSON.stringify({ type: 'weight', value: currentWeight }));

    ws.on('close', () => {
        console.log(`\x1b[33m✗ Client disconnected (total: ${wss.clients.size})\x1b[0m`);
    });
});

// ── Weight Parsing ──────────────────────────────────────────────────────────
/**
 * Flexible parser for various scale formats:
 *   - Moresco:     "ST,GS,+  0.500kg"
 *   - Generic:     "  0.500 kg"
 *   - Numeric:     "0.500"
 *   - With sign:   "+0.500" or "-0.500"
 *   - With unit:   "0.500kg" "0.500g" "0.500lb"
 *   - Comma dec:   "0,500"
 */
function parseWeight(line) {
    if (!line || typeof line !== 'string') return null;
    
    const cleaned = line.trim();
    if (!cleaned) return null;

    // Log raw data for debugging
    console.log(`\x1b[90m  RAW: "${cleaned}"\x1b[0m`);

    // Try to extract a decimal number (handles both . and , as decimal separator)
    // Look for patterns like: +0.500  -0.500  0.500  0,500  500
    const match = cleaned.match(/([+-]?\s*\d+[.,]?\d*)/);
    if (match) {
        const numStr = match[1].replace(/\s/g, '').replace(',', '.');
        const value = parseFloat(numStr);
        if (!isNaN(value) && isFinite(value)) {
            // Sanity check: weight should be between 0 and 999 kg
            const absValue = Math.abs(value);
            if (absValue <= 999) {
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

        // Use readline parser (splits by \r\n or \n)
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

        parser.on('data', (line) => {
            const weight = parseWeight(line);
            if (weight !== null) {
                currentWeight = weight;
                broadcast({ type: 'weight', value: currentWeight });
                broadcast({ type: 'raw', data: line.trim() });
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
            // Clean up old port
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

// ── Heartbeat: periodically send weight to all clients ──────────────────────
setInterval(() => {
    broadcast({ type: 'weight', value: currentWeight });
}, HEARTBEAT_MS);

// ── Startup ─────────────────────────────────────────────────────────────────
console.log('');
console.log('\x1b[1m\x1b[36m╔══════════════════════════════════════════╗\x1b[0m');
console.log('\x1b[1m\x1b[36m║     ⚖️  SCALE BRIDGE v1.0               ║\x1b[0m');
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
