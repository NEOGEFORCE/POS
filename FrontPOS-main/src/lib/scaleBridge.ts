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
                    if (this.state.isConnected && (now - this.lastMessageTime > 8000)) {
                        console.warn("ScaleBridge Watchdog: Inactividad detectada. Reiniciando conexión automáticamente...");
                        this.ws?.close(); // Forzar cierre para disparar reconexión
                        this.connect();
                    }
                }, 4000);
            }

            if (!this.pingInterval) {
                this.pingInterval = setInterval(() => {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({ type: 'ping' }));
                    }
                }, 3000);
            }

            ws.onopen = () => {
                this.updateState({ isConnected: true, error: null });
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
            };

            ws.onmessage = (event) => {
                this.lastMessageTime = Date.now();
                if (this.state.isReloading) {
                    this.updateState({ isReloading: false });
                }
                try {
                    const msg = JSON.parse(event.data);
                    switch (msg.type) {
                        case 'weight':
                            const newWeight = msg.value ?? 0;
                            // Actualización INSTANTÁNEA para latencia cero
                            this.updateState({ weight: newWeight });
                            this.pendingWeight = null;
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
                    }
                } catch {
                    // Ignore invalid JSON
                }
            };

            ws.onerror = () => {
                this.updateState({ isConnected: false, error: 'Error de conexión con el bridge de balanza' });
            };

            ws.onclose = () => {
                this.ws = null;
                this.updateState({ isConnected: false, isScaleOnline: false, weight: 0 });
                if (!this.reconnectTimer) {
                    this.reconnectTimer = setTimeout(() => {
                        this.reconnectTimer = null;
                        if (this.subscriberCount > 0) this.connect();
                    }, RECONNECT_DELAY);
                }
            };
        } catch {
            this.updateState({ isConnected: false, error: 'No se pudo conectar al bridge' });
            if (!this.reconnectTimer) {
                this.reconnectTimer = setTimeout(() => {
                    this.reconnectTimer = null;
                    if (this.subscriberCount > 0) this.connect();
                }, RECONNECT_DELAY);
            }
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
        if (this.throttleTimer) {
            clearTimeout(this.throttleTimer);
            this.throttleTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
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
