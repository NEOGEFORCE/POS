const { SerialPort } = require('serialport');
const WebSocket = require('ws');

// Configuración
const PREFERRED_PORT = process.env.SCALE_PORT || 'COM1';
const BAUD_RATE      = parseInt(process.env.SCALE_BAUD || '4800', 10);
const WS_PORT        = parseInt(process.env.SCALE_WS_PORT || '9876', 10);
const RECONNECT_MS   = 2000;
const WEIGHT_DIFF_THRESHOLD = 0.003; // kg

console.log('====================================================');
console.log('⚖️  SCALE BRIDGE v2.0 UNIFIED (AUTO-DETECCION)');
console.log('====================================================');
console.log(`Puerto preferido: ${PREFERRED_PORT} | Baud: ${BAUD_RATE} | WS: ${WS_PORT}`);

// Servidor WebSocket
let wss;
try {
    wss = new WebSocket.Server({ port: WS_PORT }, () => {
        console.log(`✓ Servidor WebSocket escuchando en ws://localhost:${WS_PORT}`);
    });
} catch (e) {
    console.error(`❌ Error iniciando WebSocket en puerto ${WS_PORT}:`, e.message);
}

let activePort = null;
let currentWeight = 0;
let isConnected = false;
let reconnectTimer = null;
let isScanning = false;

function broadcast(data) {
    if (!wss) return;
    const msg = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(msg); } catch (e) {}
        }
    });
}

if (wss) {
    wss.on('connection', (ws) => {
        console.log(`✓ Cliente POS conectado al WebSocket (Total: ${wss.clients.size})`);
        
        ws.send(JSON.stringify({ 
            type: 'status', 
            connected: isConnected, 
            port: activePort ? activePort.path : '' 
        }));
        ws.send(JSON.stringify({ 
            type: 'weight', 
            value: currentWeight, 
            display: currentWeight.toFixed(3) 
        }));

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.type === 'ping') {
                    ws.send(JSON.stringify({ type: 'pong' }));
                    return;
                }
                if (data.type === 'command' && (data.value === 'read' || data.value === 'refresh')) {
                    ws.send(JSON.stringify({ 
                        type: 'weight', 
                        value: currentWeight, 
                        display: currentWeight.toFixed(3) 
                    }));
                }
            } catch (e) {}
        });

        ws.on('close', () => {
            console.log(`✗ Cliente POS desconectado (Restantes: ${wss.clients.size})`);
        });
    });
}

// Intentar abrir un puerto específico
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
                autoOpen: false
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

// Buscar y conectar al puerto de la balanza
async function scanAndConnect() {
    if (isScanning || (activePort && activePort.isOpen)) return;
    isScanning = true;

    try {
        const ports = await SerialPort.list();
        const portPaths = ports.map(p => p.path);
        console.log(`Puertos COM detectados en el sistema: [${portPaths.join(', ') || 'Ninguno'}]`);

        let targetPorts = [];
        if (PREFERRED_PORT && portPaths.includes(PREFERRED_PORT)) {
            targetPorts.push(PREFERRED_PORT);
        }

        ports.forEach(p => {
            const desc = (p.friendlyName || p.manufacturer || '').toLowerCase();
            if (p.path !== PREFERRED_PORT && (desc.includes('ch340') || desc.includes('usb') || desc.includes('serial') || desc.includes('prolific') || desc.includes('ftdi'))) {
                targetPorts.push(p.path);
            }
        });

        portPaths.forEach(path => {
            if (!targetPorts.includes(path)) {
                targetPorts.push(path);
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
                if (Math.abs(peso - currentWeight) >= WEIGHT_DIFF_THRESHOLD || (peso === 0 && currentWeight > 0)) {
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
        try { activePort.close(); } catch (e) {}
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

scanAndConnect();

setInterval(() => {
    if (isConnected) {
        broadcast({ type: 'weight', value: currentWeight, display: currentWeight.toFixed(3) });
    }
}, 2000);

process.on('SIGINT', () => {
    if (activePort && activePort.isOpen) activePort.close();
    if (wss) wss.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    if (activePort && activePort.isOpen) activePort.close();
    if (wss) wss.close();
    process.exit(0);
});


