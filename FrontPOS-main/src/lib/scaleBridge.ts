// =============================================================================
// src/lib/scaleBridge.ts
//
// Conexión WebSocket al "scale bridge" que entrega el peso en vivo de la
// balanza al navegador. Históricamente abría un WS directo contra el
// bridge local; eso sólo funciona si el navegador corre en el mismo PC
// que la balanza. Para que la caja se opere desde el celular o desde
// otro PC, el bridge ahora puede trabajar como AGENTE SALIENTE contra el
// backend Go y el servidor hace de relay transparente.
//
// La RESOLUCIÓN DE URL vive en el módulo compartido
// `./bridge-connection.mjs`:
//
//   1. Primero intentamos el bridge local (sonda WS con timeout corto).
//   2. Si no responde, consultamos `/bridge/agents`, elegimos caja (con
//      preferencia guardada en localStorage) y pedimos ticket relay a
//      `/bridge/ticket` para abrir `ws(s)://<host>/api/bridge/relay?...`.
//
// Para el frontend consumidor no cambia nada: el protocolo transportado
// (`weight`/`status`/`ping`/`command`) es idéntico en local y relay.
// =============================================================================

import {
    LOCAL_BRIDGE_PROBE_TIMEOUT_MS,
    extractRelayErrorCode,
    getRelayEndpoints,
    negotiateBridgeConnection,
    writeSavedCajaId,
    type BridgeConnectionMode,
    type NegotiateBridgeResult,
} from "./bridge-connection.mjs";
import { apiFetch } from "./api-error";

const RECONNECT_DELAY = 1000; // 1 segundo para reconexion ultra-rapida

interface ScaleState {
    weight: number;
    isConnected: boolean;
    isScaleOnline: boolean;
    port: string;
    error: string | null;
    rawData: string;
    isReloading: boolean;
    /** Modo de la conexión activa (null si no estamos conectados). */
    mode: BridgeConnectionMode | null;
    /** Caja relay activa (solo cuando mode === "relay"). */
    cajaId: string | null;
}

type Listener = (state: ScaleState) => void;

/**
 * Sonda del bridge local. Abre un WS directo y lo devuelve si logra pasar
 * a OPEN dentro del timeout; si no, lo cierra y devuelve null. El socket
 * devuelto se reutiliza — no se abre uno nuevo contra el mismo URL.
 */
function probeLocalBridge(url: string, timeoutMs: number): Promise<WebSocket | null> {
    return new Promise<WebSocket | null>((resolve) => {
        if (typeof WebSocket === "undefined") {
            resolve(null);
            return;
        }
        let settled = false;
        let probe: WebSocket;
        try {
            probe = new WebSocket(url);
        } catch {
            resolve(null);
            return;
        }
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                probe.onopen = null;
                probe.onerror = null;
                probe.onclose = null;
                probe.close();
            } catch { /* ignore */ }
            resolve(null);
        }, Math.max(100, timeoutMs));
        probe.onopen = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(probe);
        };
        probe.onerror = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { probe.close(); } catch { /* ignore */ }
            resolve(null);
        };
        probe.onclose = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(null);
        };
    });
}

async function fetchAgentsOverApi(): Promise<{ agents?: unknown[] }> {
    const { agentsPath } = getRelayEndpoints();
    return await apiFetch<{ agents?: unknown[] }>(agentsPath, {
        method: "GET",
        skipSessionRecovery: true,
        timeoutMs: 7000,
        fallbackError: "No se pudo listar las cajas conectadas",
    });
}

async function requestRelayTicket(cajaId: string): Promise<{ ticket?: string; expiresInSeconds?: number }> {
    const { ticketPath } = getRelayEndpoints();
    return await apiFetch<{ ticket?: string; expiresInSeconds?: number }>(ticketPath, {
        method: "POST",
        body: JSON.stringify({ cajaId }),
        skipSessionRecovery: true,
        timeoutMs: 7000,
        fallbackError: "No se pudo obtener ticket relay",
    });
}

/**
 * Lee la variable public del entorno Next. Centralizado para no repetir
 * accesos a `process.env` por todo el archivo.
 */
function readEnv(): Record<string, string | undefined> {
    return {
        NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
        NEXT_PUBLIC_POS_BRIDGE_WS_URL: process.env.NEXT_PUBLIC_POS_BRIDGE_WS_URL,
        NEXT_PUBLIC_SCALE_WS_URL: process.env.NEXT_PUBLIC_SCALE_WS_URL,
    };
}

class ScaleBridge {
    private static instance: ScaleBridge | null = null;
    private ws: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private state: ScaleState = {
        weight: 0,
        isConnected: false,
        isScaleOnline: false,
        port: "",
        error: null,
        rawData: "",
        isReloading: false,
        mode: null,
        cajaId: null,
    };
    private listeners: Set<Listener> = new Set();
    private subscriberCount = 0;
    private throttleTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingWeight: number | null = null;
    private lastMessageTime: number = Date.now();
    private watchdogInterval: ReturnType<typeof setInterval> | null = null;
    private pingInterval: ReturnType<typeof setInterval> | null = null;
    private connecting = false;

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
            void this.connect();
        }

        return () => {
            this.listeners.delete(listener);
            this.subscriberCount--;
            if (this.subscriberCount === 0) {
                this.disconnect();
            }
        };
    }

    private async connect(): Promise<void> {
        if (this.connecting) return;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        this.connecting = true;

        let negotiated: NegotiateBridgeResult | null = null;
        try {
            negotiated = await negotiateBridgeConnection({
                env: readEnv(),
                location: typeof window !== "undefined" ? window.location : undefined,
                storage: typeof window !== "undefined" ? window.localStorage : null,
                localProbeTimeoutMs: LOCAL_BRIDGE_PROBE_TIMEOUT_MS,
                probeLocal: probeLocalBridge,
                fetchAgents: fetchAgentsOverApi,
                requestTicket: requestRelayTicket,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : "No se pudo conectar al bridge";
            this.updateState({ isConnected: false, error: message, mode: null, cajaId: null });
            this.connecting = false;
            this.scheduleReconnect();
            return;
        }

        if (negotiated.mode === "relay" && negotiated.cajaId && typeof window !== "undefined") {
            try { writeSavedCajaId(window.localStorage, negotiated.cajaId); } catch { /* ignore */ }
        }

        // Si la sonda local devolvió un socket vivo lo reutilizamos; en el
        // camino relay abrimos una nueva conexión contra la URL firmada.
        const existingSocket = negotiated.socket instanceof WebSocket ? negotiated.socket : null;
        let ws: WebSocket;
        if (existingSocket) {
            ws = existingSocket;
        } else {
            try {
                ws = new WebSocket(negotiated.url);
            } catch (err) {
                this.updateState({
                    isConnected: false,
                    error: err instanceof Error ? err.message : "No se pudo abrir el bridge",
                    mode: null,
                    cajaId: null,
                });
                this.connecting = false;
                this.scheduleReconnect();
                return;
            }
        }

        this.ws = ws;
        this.wireSocket(ws, negotiated);
        this.connecting = false;
    }

    private wireSocket(ws: WebSocket, negotiated: NegotiateBridgeResult): void {
        if (!this.watchdogInterval) {
            this.watchdogInterval = setInterval(() => {
                const now = Date.now();
                if (this.state.isConnected && (now - this.lastMessageTime > 5000)) {
                    console.warn("ScaleBridge Watchdog: Inactividad detectada. Reiniciando...");
                    if (this.ws) {
                        this.ws.onclose = null; // Evitar disparar onclose del socket viejo
                        try { this.ws.close(); } catch { /* ignore */ }
                        this.ws = null;
                    }
                    this.updateState({ isConnected: false });
                    void this.connect();
                }
            }, 2000);
        }

        if (!this.pingInterval) {
            this.pingInterval = setInterval(() => {
                if (this.ws?.readyState === WebSocket.OPEN) {
                    try {
                        this.ws.send(JSON.stringify({ type: "ping" }));
                    } catch (e) {
                        console.error("ScaleBridge: Error enviando ping", e);
                    }
                }
            }, 3000);
        }

        const applyOpen = () => {
            if (this.ws !== ws) return;
            this.updateState({
                isConnected: true,
                error: null,
                mode: negotiated.mode,
                cajaId: negotiated.cajaId,
            });
            this.lastMessageTime = Date.now();
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
        };

        if (ws.readyState === WebSocket.OPEN) {
            applyOpen();
        } else {
            ws.onopen = () => applyOpen();
        }

        ws.onmessage = (event: MessageEvent) => {
            if (this.ws !== ws) return;
            this.lastMessageTime = Date.now();
            if (this.state.isReloading) {
                this.updateState({ isReloading: false });
            }
            try {
                const msg = JSON.parse(String(event.data));
                switch (msg.type) {
                    case "weight": {
                        const newWeight = msg.value ?? 0;
                        this.throttleUpdate(newWeight);
                        break;
                    }
                    case "status":
                        this.updateState({ isScaleOnline: msg.connected ?? false, port: msg.port ?? "" });
                        break;
                    case "error":
                    case "pos.response.error": {
                        const errMsg = msg.message ?? msg.error ?? "Error desconocido";
                        this.updateState({ error: typeof errMsg === "string" ? errMsg : "Error desconocido" });
                        break;
                    }
                    case "raw":
                        this.updateState({ rawData: msg.data ?? "" });
                        break;
                    case "pong":
                        // Mantiene viva la conexión; `lastMessageTime` ya se actualizó arriba.
                        break;
                    default:
                        // Mensajes nuevos del relay (pos.response.*) sin manejo
                        // específico aquí se ignoran; sólo nos interesa el canal
                        // de peso/estado para el hook de la balanza.
                        break;
                }
            } catch {
                // Ignorar JSON malformado
            }
        };

        ws.onerror = () => {
            if (this.ws !== ws) return;
            this.updateState({ isConnected: false, error: "Error de conexion con el bridge de balanza" });
        };

        ws.onclose = () => {
            if (this.ws === ws) {
                this.ws = null;
                this.updateState({
                    isConnected: false,
                    isScaleOnline: false,
                    weight: 0,
                    mode: null,
                    cajaId: null,
                });
                this.scheduleReconnect();
            }
        };
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        if (this.subscriberCount <= 0) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.subscriberCount > 0) void this.connect();
        }, RECONNECT_DELAY);
    }

    private throttleUpdate(weight: number): void {
        this.pendingWeight = weight;
        if (!this.throttleTimer) {
            this.throttleTimer = setTimeout(() => {
                if (this.pendingWeight !== null) {
                    this.updateState({ weight: this.pendingWeight });
                    this.pendingWeight = null;
                }
                this.throttleTimer = null;
            }, 100);
        }
    }

    private disconnect(): void {
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
            try { this.ws.close(); } catch { /* ignore */ }
            this.ws = null;
        }
        this.updateState({
            isConnected: false,
            isScaleOnline: false,
            weight: 0,
            mode: null,
            cajaId: null,
        });
    }

    private updateState(partial: Partial<ScaleState>): void {
        if (partial.isReloading) {
            partial.weight = 0;
        }
        this.state = { ...this.state, ...partial };
        this.listeners.forEach((listener) => listener(this.state));
    }

    reload(): void {
        this.updateState({ weight: 0, isReloading: true });

        if (this.ws?.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ type: "command", value: "read" }));
                this.ws.send(JSON.stringify({ type: "command", value: "refresh" }));
            } catch {
                void this.connect();
            }
        } else {
            void this.connect();
        }

        setTimeout(() => {
            if (this.state.isReloading) {
                this.updateState({ isReloading: false });
            }
        }, 500);
    }

    /**
     * Fuerza una renegociación: cierra el socket actual y reabre con la
     * nueva preferencia de caja. Útil para el selector de caja de la UI.
     */
    renegotiate(): void {
        if (this.ws) {
            try {
                this.ws.onclose = null;
                this.ws.close();
            } catch { /* ignore */ }
            this.ws = null;
        }
        this.updateState({ isConnected: false, mode: null, cajaId: null, weight: 0 });
        if (this.subscriberCount > 0) void this.connect();
    }

    getState(): ScaleState {
        return { ...this.state };
    }
}

export { ScaleBridge, type ScaleState };
// Re-export para que la UI pueda clasificar mensajes de error del relay sin
// importar el módulo .mjs directamente.
export { extractRelayErrorCode };
