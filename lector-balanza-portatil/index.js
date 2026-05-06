const { SerialPort } = require('serialport');
const { ReadlineParser } = require('serialport');
const WebSocket = require('ws');

const PUERTO_COM = 'COM1';
const BAUD_RATE  = 4800;
const WS_PORT    = 9876;

const wss = new WebSocket.Server({ port: WS_PORT });
console.log('WebSocket en puerto ' + WS_PORT);

const port = new SerialPort({ path: PUERTO_COM, baudRate: BAUD_RATE });
const parser = port.pipe(new ReadlineParser({ delimiter: '\r' }));

var pesoActual = 0;

wss.on('connection', function(ws) {
    ws.send(JSON.stringify({ type: 'status', connected: true, port: PUERTO_COM }));
    ws.send(JSON.stringify({ type: 'weight', value: pesoActual, display: pesoActual.toFixed(3) }));

    ws.on('message', function(message) {
        try {
            const data = JSON.parse(message);
            if (data.type === 'command' && (data.value === 'read' || data.value === 'refresh')) {
                // Respondemos con lo que la báscula está enviando en ESTE preciso instante
                ws.send(JSON.stringify({ type: 'weight', value: pesoActual, display: pesoActual.toFixed(3) }));
            }
        } catch (e) {}
    });
});

parser.on('data', function(linea) {
    var limpio = linea.replace(/[^0-9.]/g, '');
    var peso = parseFloat(limpio);
    if (!isNaN(peso) && peso >= 0) {
        pesoActual = peso; // Actualización constante en milisegundos
        wss.clients.forEach(function(c) {
            if (c.readyState === WebSocket.OPEN) {
                c.send(JSON.stringify({ type: 'weight', value: peso, display: peso.toFixed(3) }));
            }
        });
    }
});

port.on('error', function(err) { console.error('Error: ' + err.message); });
port.on('open', function() { console.log('Puerto abierto OK'); });