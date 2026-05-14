const WS_URL = process.env.NEXT_PUBLIC_SCALE_WS_URL || 'ws://localhost:9876';
const RECONNECT_DELAY = 1000; // 1 segundo para reconexión ultra-rápida

interface ScaleState {
    weight: number;
    isConnected: boolean;
    isScaleOnline: boolean;
    port: string;
    error: string | null;
    rawData: string;
    isReloading: boolean;
}

type Listener = (state: ScaleState) => void;

class ScaleBridge {
    private static instance: ScaleBridge | null = null;
    private ws: WebSocket | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private state: ScaleState = {
        weight: 0,
        isConnected: false,
        isScaleOnline: false,
        port: '',
        error: null,
        rawData: '',
        isReloading: false,
    };
    private listeners: Set<Listener> = new Set();
    private subscriberCount = 0;
    private throttleTimer: any = null;
    private pendingWeight: number | null = null;
    private lastMessageTime: number = Date.now();
    private watchdogInterval: any = null;
    private pingInterval: any = null;

    private constructor() {}

    static getInstance(): ScaleBridge {
        if (!ScaleBridge.instance) {
            ScaleBridge.instance = new ScaleBridge();
        }
        return ScaleBridge.instance;
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        this.subscriberCount++;
        listener(this.state);

        if (this.subscriberCount === 1) {
            this.connect();
        }

        return () => {
            this.listeners.delete(listener);
            this.subscriberCount--;
            if (this.subscriberCount === 0) {
                this.disconnect();
            }
        };
    }

    private connect() {
        if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
            return;
        }

        try {
            const ws = new WebSocket(WS_URL);
            this.ws = ws;

            if (!this.watchdogInterval) {
                this.watchdogInterval = setInterval(() => {
                    const now = Date.now();
                    // Watchdog: 5 segundos de silencio total = reconectar
                    // Aumentamos a 5s para dar margen a micro-cortes sin ser tan agresivos que causemos loops
                    if (this.state.isConnected && (now - this.lastMessageTime > 5000)) {
                        console.warn("ScaleBridge Watchdog: Inactividad detectada. Reiniciando...");
                        if (this.ws) {
                            this.ws.onclose = null; // Evitar disparar onclose del socket viejo
                            this.ws.close();
                            this.ws = null;
                        }
                        this.updateState({ isConnected: false });
                        this.connect();
                    }
                }, 2000);
            }

            if (!this.pingInterval) {
                this.pingInterval = setInterval(() => {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        try {
                            this.ws.send(JSON.stringify({ type: 'ping' }));
                        } catch (e) {
                            console.error("ScaleBridge: Error enviando ping", e);
                        }
                    }
                }, 3000);
            }

            ws.onopen = () => {
                if (this.ws !== ws) return;
                this.updateState({ isConnected: true, error: null });
                this.lastMessageTime = Date.now();
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
            };

            ws.onmessage = (event) => {
                if (this.ws !== ws) return;
                this.lastMessageTime = Date.now();
                if (this.state.isReloading) {
                    this.updateState({ isReloading: false });
                }
                try {
                    const msg = JSON.parse(event.data);
                    switch (msg.type) {
                        case 'weight':
                            const newWeight = msg.value ?? 0;
                            this.throttleUpdate(newWeight);
                            break;
                        case 'status':
                            this.updateState({ isScaleOnline: msg.connected ?? false, port: msg.port ?? '' });
                            break;
                        case 'error':
                            this.updateState({ error: msg.message ?? 'Error desconocido' });
                            break;
                        case 'raw':
                            this.updateState({ rawData: msg.data ?? '' });
                            break;
                        case 'pong':
                            // El pong mantiene viva la conexión y actualiza lastMessageTime
                            break;
                    }
                } catch {
                    // Ignore invalid JSON
                }
            };

            ws.onerror = () => {
                if (this.ws !== ws) return;
                this.updateState({ isConnected: false, error: 'Error de conexión con el bridge de balanza' });
            };

            ws.onclose = () => {
                if (this.ws === ws) {
                    this.ws = null;
                    this.updateState({ isConnected: false, isScaleOnline: false, weight: 0 });
                    if (!this.reconnectTimer) {
                        this.reconnectTimer = setTimeout(() => {
                            this.reconnectTimer = null;
                            if (this.subscriberCount > 0) this.connect();
                        }, RECONNECT_DELAY);
                    }
                }
            };
        } catch (e) {
            console.error("ScaleBridge: Fallo crítico al conectar", e);
            this.updateState({ isConnected: false, error: 'No se pudo conectar al bridge' });
            if (!this.reconnectTimer) {
                this.reconnectTimer = setTimeout(() => {
                    this.reconnectTimer = null;
                    if (this.subscriberCount > 0) this.connect();
                }, RECONNECT_DELAY);
            }
        }
    }

    private throttleUpdate(weight: number) {
        this.pendingWeight = weight;
        if (!this.throttleTimer) {
            // Limitar a 10 actualizaciones por segundo (100ms)
            // Esto reduce la carga del CPU en el navegador y evita lag en el UI
            this.throttleTimer = setTimeout(() => {
                if (this.pendingWeight !== null) {
                    this.updateState({ weight: this.pendingWeight });
                    this.pendingWeight = null;
                }
                this.throttleTimer = null;
            }, 100);
        }
    }

    private disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = null;
        }
        if (this.throttleTimer) {
            clearTimeout(this.throttleTimer);
            this.throttleTimer = null;
        }
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
        this.updateState({ isConnected: false, isScaleOnline: false, weight: 0 });
    }

    private updateState(partial: Partial<ScaleState>) {
        if (partial.isReloading) {
            partial.weight = 0;
        }
        this.state = { ...this.state, ...partial };
        this.listeners.forEach(listener => listener(this.state));
    }

    reload() {
        // Resetear peso a 0 inmediatamente para no usar el del producto anterior
        this.updateState({ weight: 0, isReloading: true });
        
        if (this.ws?.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ type: 'command', value: 'read' }));
                this.ws.send(JSON.stringify({ type: 'command', value: 'refresh' }));
            } catch (e) {
                this.connect();
            }
        } else {
            this.connect();
        }

        // Quitar estado de recarga después de medio segundo
        setTimeout(() => {
            if (this.state.isReloading) {
                this.updateState({ isReloading: false });
            }
        }, 500); 
    }

    getState(): ScaleState {
        return { ...this.state };
    }
}

export { ScaleBridge };
