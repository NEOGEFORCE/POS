// =============================================================================
// src/lib/pos-bridge-ws.ts
//
// Cliente real de `window.posBridge` sobre el mismo WebSocket que ya expone
// `scaleBridge.ts` (`ws://<host>:9876`). Se encarga de:
//
//   1. Abrir una conexión WS al bridge local y reconectarse con backoff
//      cuando se cae. Nunca mantiene una balanza bloqueada: usa su propio
//      socket paralelo porque el protocolo de mensajes es distinto.
//   2. Serializar cada solicitud como el envelope canónico del bridge
//      `{ type: "printer.request", action, requestId, payload }`
//      (coincide con `validatePrinterRequest` en `scale-bridge/printer-bridge.js`
//      y con el patrón `type:'status'|'weight'|'ping'|'command'` que ya
//      usa el loop de balanza). Resuelve la promesa cuando llega la
//      respuesta `{ type: "printer.response", requestId, ok, result?, error?, errorCode? }`
//      con el mismo `requestId`.
//   3. Timeout por solicitud (default 10s) para que el POS no se cuelgue
//      si el bridge local no responde. Al dispararse el timeout se limpia
//      la entrada de `pending` y se rechaza con el sentinel
//      `DIRECT_PRINT_UNAVAILABLE: timeout del bridge (...)` para que el
//      consumidor (ej. `thermal-ticket.printThermalTicketAuto`) presente
//      la acción manual explícita en vez de caer en silencio al diálogo
//      del navegador.
//   4. Reportar estado de conectividad a través de `isConnected()` y
//      `onStatusChange()` — así `hasPosBridgePrint()` queda honesto sin
//      modificar el contrato de bridges externos preexistentes.
//
// IMPORTANTE: `installWebSocketPosBridge()` NO sobreescribe un
// `window.posBridge.print` que ya exista. Si el POS corre dentro de
// Electron/Chromium shell y ya hay un bridge nativo, se preserva — este
// cliente sólo cubre el caso del navegador vainilla con el bridge local
// escuchando en el WebSocket.
// =============================================================================

import type { PosBridge, PosBridgeConnectivity } from "./pos-bridge";

/** Resuelve la URL del WebSocket. Comparte el default con `scaleBridge.ts`. */
function defaultWsUrl(): string {
    if (typeof window !== "undefined") {
        // Permitimos una URL dedicada para el bridge POS si llega a hacerse
        // falta separar canales en el futuro. Hoy ambos escuchan en 9876.
        const explicit = (process.env.NEXT_PUBLIC_POS_BRIDGE_WS_URL
            || process.env.NEXT_PUBLIC_SCALE_WS_URL
            || "").trim();
        if (explicit) return explicit;
        const host = window.location.hostname || "localhost";
        return `ws://${host}:9876`;
    }
    return process.env.NEXT_PUBLIC_POS_BRIDGE_WS_URL
        || process.env.NEXT_PUBLIC_SCALE_WS_URL
        || "ws://localhost:9876";
}

interface PendingRequest {
    /** Acción del bridge que originó la solicitud (`"print"`, `"printTestPage"`, `"kickDrawer"`). */
    readonly action: string;
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface ClientOptions {
    url?: string;
    /** Timeout por request en ms. Default 10s. */
    timeoutMs?: number;
    /** Delay base de reconexión en ms. Default 2s. */
    reconnectDelayMs?: number;
}

export type PosBridgeStatusListener = (status: PosBridgeConnectivity) => void;

/**
 * Sentinel usado por los helpers de `thermal-ticket` para que el consumidor
 * pueda matchear `err.message.startsWith(DIRECT_PRINT_UNAVAILABLE)` y
 * decidir si cae al fallback de navegador o si muestra toast accionable.
 */
const DIRECT_PRINT_UNAVAILABLE = "DIRECT_PRINT_UNAVAILABLE";

export class PosBridgeWsClient implements PosBridge {
    private ws: WebSocket | null = null;
    private readonly url: string;
    private readonly timeoutMs: number;
    private readonly reconnectDelayMs: number;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly pending = new Map<string, PendingRequest>();
    private seq = 0;
    private readonly listeners = new Set<PosBridgeStatusListener>();
    private destroyed = false;
    private status: PosBridgeConnectivity = {
        connected: false,
        url: "",
        lastError: null,
        lastConnectedAt: null,
    };

    constructor(options: ClientOptions = {}) {
        this.url = options.url ?? defaultWsUrl();
        this.timeoutMs = options.timeoutMs ?? 10_000;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
        this.status = { ...this.status, url: this.url };
    }

    // -------------------------------------------------------------------
    // Ciclo de vida
    // -------------------------------------------------------------------

    connect(): void {
        if (this.destroyed) return;
        if (typeof WebSocket === "undefined") return;
        if (this.ws
            && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        let ws: WebSocket;
        try {
            ws = new WebSocket(this.url);
        } catch (err) {
            this.updateStatus({
                connected: false,
                lastError: err instanceof Error ? err.message : String(err),
            });
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            if (this.ws !== ws) return;
            this.updateStatus({
                connected: true,
                lastError: null,
                lastConnectedAt: Date.now(),
            });
        };

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
            this.updateStatus({ connected: false });
            // Rechazamos pendientes con el sentinel para que los consumidores
            // puedan presentar fallback manual sin confundir "no conectado"
            // con "rechazado por hardware".
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
        this.updateStatus({ connected: false });
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

    // -------------------------------------------------------------------
    // Introspección (sólo lectura)
    // -------------------------------------------------------------------

    getStatus(): PosBridgeConnectivity {
        return { ...this.status };
    }

    getPendingCount(): number {
        return this.pending.size;
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
            if (!this.destroyed) this.connect();
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
            listener({ connected: false, lastError: "ws-bridge-not-installed", lastConnectedAt: null });
        } catch { /* ignore */ }
        return () => {};
    }
    return client.onStatusChange(listener);
}
