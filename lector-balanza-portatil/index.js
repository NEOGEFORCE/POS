const { SerialPort } = require('serialport');
const { ReadlineParser } = require('serialport');
const WebSocket = require('ws');

// Configuración
const PREFERRED_PORT = process.env.SCALE_PORT || 'COM1';
const BAUD_RATE      = parseInt(process.env.SCALE_BAUD || '4800', 10);
const WS_PORT        = parseInt(process.env.SCALE_WS_PORT || '9876', 10);

console.log('====================================================');
console.log('⚖️  LECTOR DE BALANZA POS PRO');
console.log('====================================================');
console.log(`Puerto: ${PREFERRED_PORT} | Baud: ${BAUD_RATE} | WS: ${WS_PORT}`);

// Servidor WebSocket en puerto 9876
const wss = new WebSocket.Server({ port: WS_PORT }, () => {
    console.log(`✓ Servidor WebSocket escuchando en ws://localhost:${WS_PORT}`);
});

let activePort = null;
let parser = null;
let currentWeight = 0;
let isConnected = false;
let reconnectTimer = null;
let isConnecting = false;

function broadcastWeight(peso) {
    const msg = JSON.stringify({ 
        type: 'weight', 
        value: peso, 
        display: peso.toFixed(3) 
    });
    wss.clients.forEach((c) => {
        if (c.readyState === WebSocket.OPEN) {
            try { c.send(msg); } catch (e) {}
        }
    });
}

function broadcastStatus(connected, portName) {
    const msg = JSON.stringify({ 
        type: 'status', 
        connected: connected, 
        port: portName || '' 
    });
    wss.clients.forEach((c) => {
        if (c.readyState === WebSocket.OPEN) {
            try { c.send(msg); } catch (e) {}
        }
    });
}

wss.on('connection', (ws) => {
    console.log(`✓ Cliente POS conectado al WebSocket (Total: ${wss.clients.size})`);
    
    // Enviar estado y peso actual inmediatamente
    ws.send(JSON.stringify({ 
        type: 'status', 
        connected: isConnected, 
        port: activePort ? activePort.path : PREFERRED_PORT 
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

// Función de procesamiento de peso por línea (formato Moresco / Torrey)
function processLine(linea) {
    if (!linea || typeof linea !== 'string') return;
    
    // Limpiar caracteres que no sean números o punto
    const limpio = linea.replace(/[^0-9.]/g, '');
    if (!limpio) return;

    const peso = parseFloat(limpio);
    if (!isNaN(peso) && isFinite(peso) && peso >= 0 && peso <= 999) {
        if (peso !== currentWeight) {
            currentWeight = peso;
            console.log(`⚖️ Peso: ${peso.toFixed(3)} kg (raw: "${linea.trim()}")`);
            broadcastWeight(peso);
        }
    }
}

// Conectar al puerto serial
async function connectToPort(targetPort) {
    if (isConnecting || (activePort && activePort.isOpen)) return;
    isConnecting = true;

    try {
        console.log(`Conectando a ${targetPort} a ${BAUD_RATE} baud...`);
        const p = new SerialPort({
            path: targetPort,
            baudRate: BAUD_RATE,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            autoOpen: false
        });

        const rParser = p.pipe(new ReadlineParser({ delimiter: '\r' }));

        p.open((err) => {
            isConnecting = false;
            if (err) {
                console.log(`✗ No se pudo abrir ${targetPort}: ${err.message}`);
                handleConnectionFailure();
            } else {
                console.log(`✓ ¡PUERTO ${targetPort} ABIERTO CON ÉXITO!`);
                activePort = p;
                parser = rParser;
                isConnected = true;
                broadcastStatus(true, targetPort);

                // Escuchar líneas leídas por el parser
                rParser.on('data', (linea) => {
                    processLine(linea);
                });

                // Escuchar datos brutos como respaldo
                p.on('data', (chunk) => {
                    const str = chunk.toString('ascii');
                    // Si el chunk contiene números con punto
                    const m = str.match(/([+-]?\s*\d+[.,]?\d*)/);
                    if (m) {
                        processLine(m[1]);
                    }
                });

                p.on('error', (portErr) => {
                    console.error(`✗ Error en ${targetPort}:`, portErr.message);
                    cleanupAndReconnect();
                });

                p.on('close', () => {
                    console.log(`⚠ Puerto ${targetPort} cerrado`);
                    cleanupAndReconnect();
                });
            }
        });
    } catch (e) {
        isConnecting = false;
        console.error('Error al intentar abrir puerto:', e.message);
        handleConnectionFailure();
    }
}

async function handleConnectionFailure() {
    // Si falla el puerto preferido, intentar listar otros puertos disponibles
    try {
        const portList = await SerialPort.list();
        const otherPorts = portList.map(x => x.path).filter(x => x !== PREFERRED_PORT);
        if (otherPorts.length > 0) {
            console.log(`Probando otros puertos detectados: [${otherPorts.join(', ')}]...`);
            for (const altPort of otherPorts) {
                await connectToPort(altPort);
                if (activePort && activePort.isOpen) return;
            }
        }
    } catch (e) {}

    scheduleReconnect();
}

function cleanupAndReconnect() {
    isConnected = false;
    currentWeight = 0;
    if (activePort) {
        try { activePort.close(); } catch (e) {}
        activePort = null;
        parser = null;
    }
    broadcastStatus(false, '');
    broadcastWeight(0);
    scheduleReconnect();
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    console.log(`↻ Reintentando conexión en 2s...`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!activePort || !activePort.isOpen) {
            connectToPort(PREFERRED_PORT);
        }
    }, 2000);
}

// Iniciar conexión inicial a COM1
connectToPort(PREFERRED_PORT);

// Mantener vivo y sincronizado el peso cada 2 segundos
setInterval(() => {
    if (isConnected) {
        broadcastWeight(currentWeight);
    }
}, 2000);