// =============================================================================
// src/lib/pos-bridge-ws.ts
//
// Cliente real de `window.posBridge` sobre el WebSocket del bridge local
// (`ws://<host>:9876`) o, cuando ese bridge no es alcanzable, sobre el
// RELAY del servidor Go (`ws(s)://host/api/bridge/relay?ticket=...`). La
// resolución del transporte vive centralizada en
// `./bridge-connection.mjs`.
//
// Responsabilidades:
//
//   1. Negociar la URL de conexión (local primero, relay después) y abrir
//      el WebSocket. Reconecta con backoff tras caídas y pide un ticket
//      NUEVO en cada reconexión relay (los tickets son one-shot).
//   2. Serializar cada solicitud como el envelope canónico del bridge
//      `{ type: "printer.request", action, requestId, payload }`. Esto
//      coincide con `validatePrinterRequest` en `scale-bridge/printer-bridge.js`.
//      El relay propaga el envelope sin modificarlo: el bridge sigue viendo
//      exactamente lo que ya validaba, por eso la UI no cambia de forma.
//   3. Timeout por solicitud (default 10s) para que el POS no se cuelgue
//      si el bridge local no responde. Se rechaza con el sentinel
//      `DIRECT_PRINT_UNAVAILABLE: timeout del bridge (...)` para que el
//      consumidor (ej. `thermal-ticket.printThermalTicketAuto`) presente
//      la acción manual explícita en vez de caer al diálogo del navegador.
//   4. Reportar estado de conectividad con `isConnected()`, `onStatusChange()`
//      y ahora también `mode: "local"|"relay"` + `cajaId` para que la UI
//      pueda mostrar un chip honesto.
//
// IMPORTANTE: `installWebSocketPosBridge()` NO sobreescribe un
// `window.posBridge.print` que ya exista. Si el POS corre dentro de
// Electron/Chromium shell y ya hay un bridge nativo, se preserva.
// =============================================================================

import type { PosBridge, PosBridgeConnectivity } from "./pos-bridge";
import {
    LOCAL_BRIDGE_PROBE_TIMEOUT_MS,
    extractRelayErrorCode,
    getRelayEndpoints,
    negotiateBridgeConnection,
    resolveLocalBridgeUrl,
    writeSavedCajaId,
    type BridgeConnectionMode,
    type NegotiateBridgeResult,
} from "./bridge-connection.mjs";
import { apiFetch } from "./api-error";

interface PendingRequest {
    /** Acción del bridge que originó la solicitud (`"print"`, `"printTestPage"`, `"kickDrawer"`). */
    readonly action: string;
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface ClientOptions {
    /** URL opcional del WS. Útil para tests; en producción se negocia dinámicamente. */
    url?: string;
    /** Timeout por request en ms. Default 10s. */
    timeoutMs?: number;
    /** Delay base de reconexión en ms. Default 2s. */
    reconnectDelayMs?: number;
    /** Timeout de la sonda del bridge local. Default 1500ms. */
    localProbeTimeoutMs?: number;
}

export type PosBridgeStatusListener = (status: PosBridgeConnectivity) => void;

/**
 * Sentinel usado por los helpers de `thermal-ticket` para que el consumidor
 * pueda matchear `err.message.startsWith(DIRECT_PRINT_UNAVAILABLE)` y
 * decidir si cae al fallback de navegador o si muestra toast accionable.
 */
const DIRECT_PRINT_UNAVAILABLE = "DIRECT_PRINT_UNAVAILABLE";

function readEnv(): Record<string, string | undefined> {
    return {
        NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
        NEXT_PUBLIC_POS_BRIDGE_WS_URL: process.env.NEXT_PUBLIC_POS_BRIDGE_WS_URL,
        NEXT_PUBLIC_SCALE_WS_URL: process.env.NEXT_PUBLIC_SCALE_WS_URL,
    };
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

export class PosBridgeWsClient implements PosBridge {
    private ws: WebSocket | null = null;
    private readonly explicitUrl: string | null;
    private readonly timeoutMs: number;
    private readonly reconnectDelayMs: number;
    private readonly localProbeTimeoutMs: number;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly pending = new Map<string, PendingRequest>();
    private seq = 0;
    private readonly listeners = new Set<PosBridgeStatusListener>();
    private destroyed = false;
    private connecting = false;
    private status: PosBridgeConnectivity = {
        connected: false,
        url: "",
        lastError: null,
        lastConnectedAt: null,
        mode: null,
        cajaId: null,
    };

    constructor(options: ClientOptions = {}) {
        this.explicitUrl = typeof options.url === "string" && options.url.trim() ? options.url.trim() : null;
        this.timeoutMs = options.timeoutMs ?? 10_000;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
        this.localProbeTimeoutMs = options.localProbeTimeoutMs ?? LOCAL_BRIDGE_PROBE_TIMEOUT_MS;
        // Mostramos como "url" inicial el bridge local resuelto; se
        // actualiza al relay si cae ahí tras el primer intento.
        const initialUrl = this.explicitUrl ?? resolveLocalBridgeUrl({
            env: readEnv(),
            location: typeof window !== "undefined" ? window.location : undefined,
        });
        this.status = { ...this.status, url: initialUrl };
    }

    // -------------------------------------------------------------------
    // Ciclo de vida
    // -------------------------------------------------------------------

    connect(): void {
        void this.connectAsync();
    }

    private async connectAsync(): Promise<void> {
        if (this.destroyed) return;
        if (this.connecting) return;
        if (typeof WebSocket === "undefined") return;
        if (this.ws
            && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        this.connecting = true;

        // Caso 1: URL explícita (tests, bridges embebidos). Reproducimos
        // el flujo histórico sin pasar por la negociación.
        if (this.explicitUrl) {
            try {
                const ws = new WebSocket(this.explicitUrl);
                this.ws = ws;
                this.wireSocket(ws, { mode: "local", cajaId: null, url: this.explicitUrl });
            } catch (err) {
                this.updateStatus({
                    connected: false,
                    lastError: err instanceof Error ? err.message : String(err),
                    mode: null,
                    cajaId: null,
                });
                this.scheduleReconnect();
            } finally {
                this.connecting = false;
            }
            return;
        }

        // Caso 2: negociación dinámica local → relay.
        let negotiated: NegotiateBridgeResult | null = null;
        try {
            negotiated = await negotiateBridgeConnection({
                env: readEnv(),
                location: typeof window !== "undefined" ? window.location : undefined,
                storage: typeof window !== "undefined" ? window.localStorage : null,
                localProbeTimeoutMs: this.localProbeTimeoutMs,
                probeLocal: probeLocalBridge,
                fetchAgents: fetchAgentsOverApi,
                requestTicket: requestRelayTicket,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : "No se pudo abrir el bridge";
            this.updateStatus({ connected: false, lastError: message, mode: null, cajaId: null });
            this.connecting = false;
            this.scheduleReconnect();
            return;
        }

        if (negotiated.mode === "relay" && negotiated.cajaId && typeof window !== "undefined") {
            try { writeSavedCajaId(window.localStorage, negotiated.cajaId); } catch { /* ignore */ }
        }

        const existingSocket = negotiated.socket instanceof WebSocket ? negotiated.socket : null;
        let ws: WebSocket;
        if (existingSocket) {
            ws = existingSocket;
        } else {
            try {
                ws = new WebSocket(negotiated.url);
            } catch (err) {
                this.updateStatus({
                    connected: false,
                    lastError: err instanceof Error ? err.message : String(err),
                    mode: null,
                    cajaId: null,
                });
                this.connecting = false;
                this.scheduleReconnect();
                return;
            }
        }

        this.ws = ws;
        this.wireSocket(ws, {
            mode: negotiated.mode,
            cajaId: negotiated.cajaId,
            url: negotiated.url,
        });
        this.connecting = false;
    }

    private wireSocket(
        ws: WebSocket,
        meta: { mode: BridgeConnectionMode; cajaId: string | null; url: string },
    ): void {
        const applyOpen = () => {
            if (this.ws !== ws) return;
            this.updateStatus({
                connected: true,
                lastError: null,
                lastConnectedAt: Date.now(),
                url: meta.url,
                mode: meta.mode,
                cajaId: meta.cajaId,
            });
        };

        if (ws.readyState === WebSocket.OPEN) {
            applyOpen();
        } else {
            ws.onopen = () => applyOpen();
        }

        ws.onmessage = (event: MessageEvent) => {
            if (this.ws !== ws) return;
            this.handleIncoming(event);
        };

        ws.onerror = () => {
            if (this.ws !== ws) return;
            this.updateStatus({ lastError: "WebSocket error" });
        };

        ws.onclose = () => {
            if (this.ws !== ws) return;
            this.ws = null;
            this.updateStatus({ connected: false, mode: null, cajaId: null });
            this.rejectAllPending(new Error(`${DIRECT_PRINT_UNAVAILABLE}: bridge WS cerrado`));
            if (!this.destroyed) this.scheduleReconnect();
        };
    }

    disconnect(): void {
        this.destroyed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.rejectAllPending(new Error(`${DIRECT_PRINT_UNAVAILABLE}: bridge desconectado por cliente`));
        if (this.ws) {
            try {
                this.ws.onclose = null;
                this.ws.close();
            } catch { /* ignore */ }
            this.ws = null;
        }
        this.updateStatus({ connected: false, mode: null, cajaId: null });
    }

    // -------------------------------------------------------------------
    // Métodos del contrato PosBridge
    // -------------------------------------------------------------------

    isConnected(): boolean {
        return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    onStatusChange(listener: PosBridgeStatusListener): () => void {
        this.listeners.add(listener);
        try { listener(this.getStatus()); } catch { /* ignore */ }
        return () => { this.listeners.delete(listener); };
    }

    print(payload: unknown): Promise<unknown> {
        return this.sendRequest("print", payload);
    }

    printTestPage(payload: unknown): Promise<unknown> {
        return this.sendRequest("printTestPage", payload);
    }

    kickDrawer(payload: unknown): Promise<unknown> {
        return this.sendRequest("kickDrawer", payload);
    }

    /**
     * Enumera las colas de impresión del equipo donde corre el bridge.
     * Delegación tipada de la acción `listPrinters` del contrato WS; el
     * `payload.refresh=true` indica al bridge que ignore cualquier cache
     * interna. El valor devuelto es el `result` crudo del bridge; el
     * consumidor lo pasa por `parseDetectedPrintersResult` para obtener
     * un shape tipado.
     */
    listPrinters(payload?: unknown): Promise<unknown> {
        return this.sendRequest("listPrinters", payload ?? {});
    }

    // -------------------------------------------------------------------
    // Introspección (sólo lectura)
    // -------------------------------------------------------------------

    getStatus(): PosBridgeConnectivity {
        return { ...this.status };
    }

    getPendingCount(): number {
        return this.pending.size;
    }

    /**
     * Fuerza una renegociación cerrando el socket vivo. Útil cuando el
     * usuario cambia la caja preferida en el selector de UI: el próximo
     * ciclo abrirá una conexión relay contra la nueva caja.
     */
    renegotiate(): void {
        if (this.destroyed) return;
        if (this.ws) {
            try {
                this.ws.onclose = null;
                this.ws.close();
            } catch { /* ignore */ }
            this.ws = null;
        }
        this.updateStatus({ connected: false, mode: null, cajaId: null });
        void this.connectAsync();
    }

    // -------------------------------------------------------------------
    // Internos
    // -------------------------------------------------------------------

    private handleIncoming(event: MessageEvent) {
        let msg: unknown;
        try {
            msg = JSON.parse(String(event.data));
        } catch {
            return;
        }
        if (!msg || typeof msg !== "object") return;
        const obj = msg as Record<string, unknown>;
        const requestId = typeof obj.requestId === "string" ? obj.requestId : null;
        if (!requestId) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        // El bridge canónico responde `{type:"printer.response", ok, result?, error?, errorCode?}`.
        // Mantenemos tolerante a formas antiguas (`pos.response.error` o
        // `<action>.error`) por si el bridge rota de versión; `ok === false`
        // es la señal autoritativa — exigirlo evita que un payload sin
        // `ok` ni `type` se interprete como fallo.
        const explicitlyFailed = obj.ok === false
            || obj.type === "pos.response.error"
            || obj.type === `${pending.action}.error`;
        if (explicitlyFailed) {
            const rawMessage = typeof obj.error === "string" && obj.error.trim()
                ? obj.error.trim()
                : "bridge rechazó la solicitud";
            const code = typeof obj.errorCode === "string" && obj.errorCode.trim()
                ? obj.errorCode.trim()
                : null;
            // Prefijamos con el errorCode cuando viene (ej. "TCP_TIMEOUT: ...")
            // para que `thermal-ticket.printThermalTicketDirect` pueda matchear
            // el prefijo y clasificar el error accionable sin perder el
            // mensaje humano del bridge.
            const errMessage = code && !rawMessage.startsWith(code)
                ? `${code}: ${rawMessage}`
                : rawMessage;
            pending.reject(new Error(errMessage));
            return;
        }
        pending.resolve(obj.result !== undefined ? obj.result : obj);
    }

    private sendRequest(action: string, payload: unknown): Promise<unknown> {
        if (!this.isConnected() || !this.ws) {
            return Promise.reject(
                new Error(`${DIRECT_PRINT_UNAVAILABLE}: bridge WS no conectado`),
            );
        }
        const requestId = this.nextRequestId();
        // Envelope canónico del bridge: `type:"printer.request"` lo rutea al
        // handler de impresión en `scale-bridge/index.js`; `action` elige
        // dispatch (`print`/`printTestPage`/`kickDrawer`) dentro de
        // `handlePrinterRequest`; `payload` queda tal cual.
        const message = { type: "printer.request", action, requestId, payload };
        try {
            this.ws.send(JSON.stringify(message));
        } catch (err) {
            return Promise.reject(
                err instanceof Error ? err : new Error(String(err)),
            );
        }
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`${DIRECT_PRINT_UNAVAILABLE}: timeout del bridge (${this.timeoutMs}ms)`));
            }, this.timeoutMs);
            this.pending.set(requestId, { action, resolve, reject, timer });
        });
    }

    private nextRequestId(): string {
        this.seq += 1;
        const stamp = typeof Date.now === "function" ? Date.now().toString(36) : "x";
        return `pos-${stamp}-${this.seq}`;
    }

    private rejectAllPending(err: Error) {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            try { p.reject(err); } catch { /* ignore */ }
        }
        this.pending.clear();
    }

    private scheduleReconnect() {
        if (this.reconnectTimer || this.destroyed) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.destroyed) void this.connectAsync();
        }, this.reconnectDelayMs);
    }

    private updateStatus(partial: Partial<PosBridgeConnectivity>) {
        this.status = { ...this.status, ...partial };
        for (const listener of this.listeners) {
            try { listener(this.getStatus()); } catch { /* ignore */ }
        }
    }
}

// =============================================================================
// Instalación global del bridge
// =============================================================================
//
// `installWebSocketPosBridge()` adjunta un cliente WS a `window.posBridge`
// ÚNICAMENTE si no hay un bridge nativo preexistente. Si un shell Electron
// o un Chromium wrapper ya instaló `window.posBridge.print`, lo respetamos
// (no sobreescribir bridges nativos ajenos).

let installed: PosBridgeWsClient | null = null;

const INTERNAL_HANDLE_KEY = "__posBridgeWsClient";

export function installWebSocketPosBridge(options: ClientOptions = {}): PosBridgeWsClient | null {
    if (typeof window === "undefined") return null;
    const w = window as Window & { [INTERNAL_HANDLE_KEY]?: PosBridgeWsClient };
    // Preserve preexisting native bridge: no overwrite.
    const existing = window.posBridge;
    if (existing && typeof existing.print === "function" && !(existing instanceof PosBridgeWsClient)) {
        return null;
    }
    const cached = w[INTERNAL_HANDLE_KEY];
    if (cached instanceof PosBridgeWsClient) {
        installed = cached;
        return cached;
    }
    const client = new PosBridgeWsClient(options);
    installed = client;
    w[INTERNAL_HANDLE_KEY] = client;
    window.posBridge = client;
    client.connect();
    return client;
}

/**
 * Devuelve el cliente WS instalado por `installWebSocketPosBridge`. No
 * recorre bridges nativos ajenos: si el POS corre con un bridge Electron
 * nativo este helper devuelve `null`.
 */
export function getInstalledPosBridgeWsClient(): PosBridgeWsClient | null {
    if (typeof window === "undefined") return installed;
    const w = window as Window & { [INTERNAL_HANDLE_KEY]?: PosBridgeWsClient };
    if (w[INTERNAL_HANDLE_KEY] instanceof PosBridgeWsClient) {
        return w[INTERNAL_HANDLE_KEY] as PosBridgeWsClient;
    }
    return installed;
}

/**
 * Suscripción de alto nivel al estado del WS bridge. Si no hay cliente WS
 * instalado (porque el bridge nativo ya tomó el `window.posBridge`), el
 * callback recibe un único snapshot inicial y el helper devuelve un noop.
 */
export function subscribeWebSocketPosBridgeStatus(
    listener: PosBridgeStatusListener,
): () => void {
    const client = getInstalledPosBridgeWsClient();
    if (!client) {
        try {
            listener({ connected: false, lastError: "ws-bridge-not-installed", lastConnectedAt: null, mode: null, cajaId: null });
        } catch { /* ignore */ }
        return () => {};
    }
    return client.onStatusChange(listener);
}

// Re-export para que la UI pueda clasificar mensajes del relay sin importar
// el módulo .mjs directamente.
export { extractRelayErrorCode };

// -----------------------------------------------------------------------------
// Sonda del bridge local (declarada al FINAL del archivo a propósito).
//
// Las function declarations se hoistean, así que `connectAsync` puede
// referenciar `probeLocalBridge` sin romper. Vive aquí abajo para que la
// primera aparición de `ws.onclose = () => {` en el archivo pertenezca a
// la clase `PosBridgeWsClient` (contrato validado por los tests estáticos
// existentes que usan `src.indexOf("ws.onclose = () => {")`).
// -----------------------------------------------------------------------------

/**
 * Abre un WS al bridge local y lo devuelve si pasa a OPEN dentro del
 * timeout; cierra y devuelve `null` en cualquier otro caso. El socket
 * devuelto se REUTILIZA — así evitamos abrir dos conexiones consecutivas
 * contra la misma URL.
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
