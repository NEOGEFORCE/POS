const WS_URL = process.env.NEXT_PUBLIC_SCALE_WS_URL || 'ws://localhost:9876';
const RECONNECT_DELAY = 10000;

interface ScaleState {
    weight: number;
    isConnected: boolean;
    isScaleOnline: boolean;
    port: string;
    error: string | null;
    rawData: string;
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
    };
    private listeners: Set<Listener> = new Set();
    private subscriberCount = 0;

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

            ws.onopen = () => {
                this.updateState({ isConnected: true, error: null });
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    switch (msg.type) {
                        case 'weight':
                            this.updateState({ weight: msg.value ?? 0 });
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
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    private updateState(partial: Partial<ScaleState>) {
        this.state = { ...this.state, ...partial };
        this.listeners.forEach(listener => listener(this.state));
    }

    getState(): ScaleState {
        return { ...this.state };
    }
}

export { ScaleBridge };
