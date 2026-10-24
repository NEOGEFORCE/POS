// =============================================================================
// src/lib/pos-bridge.ts
//
// Contrato tipado único de `window.posBridge`. El bridge local (scale-bridge
// o similar) expone estos métodos opcionales; el frontend NUNCA debe asumir
// que están presentes y debe comprobarlos antes de llamarlos.
//
// Hasta este sprint, el contrato estaba replicado como casts anónimos en
// `labels/page.tsx`, `labels/config/page.tsx`, `LabelPrintSheet.tsx` y en el
// nuevo `thermal-ticket.ts`. Centralizarlo elimina drift y hace que un
// cambio de firma del bridge rompa en un único lugar en TypeScript.
//
// Convenciones del contrato:
//
//   - Todos los métodos son OPCIONALES (`?`). El frontend NUNCA puede dar
//     por sentado que `posBridge.print` existe: siempre debe verificar la
//     función antes de invocarla. El tipo refuerza este contrato en
//     TypeScript estricto.
//
//   - El payload es `unknown` a propósito: cada consumidor arma el shape
//     que necesita (recepción de etiquetas, página de prueba, recibo
//     térmico, cajón) y el bridge lo interpreta. Modelar los payloads en
//     detalle acá acoplaría el frontend a cada versión del bridge; mejor
//     dejarlo laxo y validar en el bridge.
//
//   - El tipo del retorno es `Promise<unknown>` incluso cuando el bridge
//     responde con un objeto estructurado: el frontend sólo necesita
//     saber si la promesa resuelve (éxito) o rechaza (fallback a
//     diálogo del navegador o toast accionable).
//
//   - Opcionales de conectividad: `isConnected()` y `onStatusChange()` son
//     ADITIVOS. Los bridges nativos preexistentes (electron shell, chromium
//     wrapper) que no los implementan siguen funcionando igual — se asume
//     que están "conectados" cuando exponen `print`. Sólo los bridges que
//     SÍ los implementan reportan su estado honesto al consumidor.
// =============================================================================

/**
 * Estado estructurado del bridge que `onStatusChange` entrega a los
 * suscriptores. Se mantiene minimalista para que distintas implementaciones
 * (nativa, WebSocket, mock) puedan reportarlo sin fricción.
 */
export interface PosBridgeConnectivity {
    /** `true` cuando el bridge está listo para recibir solicitudes. */
    readonly connected: boolean;
    /** Endpoint o descriptor humano del bridge (ej. URL WS, modelo nativo). */
    readonly url?: string;
    /** Último error observado por el cliente. `null` cuando nada pendiente. */
    readonly lastError?: string | null;
    /** Timestamp (ms epoch) del último `connected=true`. */
    readonly lastConnectedAt?: number | null;
    /**
     * Modo activo del transporte: `"local"` cuando el navegador alcanza el
     * bridge directamente (ws://localhost:9876) y `"relay"` cuando el POS
     * atraviesa el servidor Go (ws(s)://host/api/bridge/relay). Opcional
     * por retrocompatibilidad: los bridges nativos (Electron, Chromium
     * shell) pueden omitirlo y se asume local.
     */
    readonly mode?: "local" | "relay" | null;
    /**
     * Caja del PC de caja a la que apunta el relay. Sólo relevante cuando
     * `mode === "relay"`; en modo local es `null` porque el bridge y el
     * navegador comparten máquina.
     */
    readonly cajaId?: string | null;
}

/**
 * Firma pública del bridge local. Mantener alineado con el bridge
 * `scale-bridge` (o equivalente) y con los llamadores en:
 *   - src/lib/thermal-ticket.ts         (impresión directa de recibos)
 *   - src/app/(app)/labels/page.tsx     (impresión de etiquetas en lotes)
 *   - src/app/(app)/labels/config/page.tsx (página de prueba)
 *   - src/app/(app)/inventory/receive/components/LabelPrintSheet.tsx
 */
export interface PosBridge {
    /**
     * Entrega un trabajo de impresión al bridge local. El payload cambia
     * según el llamador:
     *
     *   - Recibo térmico: `{ type: "thermal-receipt", ticket, connection,
     *     receipt, columns, cut, width, widthMm, printableWidthMm }`.
     *   - Etiquetas: `{ printerProfileId, sizeTemplateId, triggerSource,
     *     items, meta, connection, labels, labelItems }`.
     *   - Página de prueba: `{ type: "test-page", target, config }`.
     */
    print?(payload: unknown): Promise<unknown>;

    /**
     * Firma alternativa específica para la página de prueba de
     * `/labels/config`. El bridge puede soportar `print({type:"test-page"})`
     * o bien `printTestPage({type:"test-page"})`; el llamador debe
     * intentar ambas y caer al iframe si ninguna responde.
     */
    printTestPage?(payload: unknown): Promise<unknown>;

    /**
     * Enumera las colas de impresión disponibles en el equipo donde corre
     * el bridge. El contrato acordado con `scale-bridge`:
     *
     *   - Request envelope: `{ type:"printer.request", action:"listPrinters",
     *     requestId, payload: { refresh?: boolean } }`.
     *   - Respuesta: `{ ok:true, result: { kind:"printer-list", platform,
     *     defaultName, printers: DetectedPrinter[] } }` o `{ ok:false,
     *     errorCode:"PRINTER_LIST_FAILED", error }`.
     *
     * Es opcional porque los bridges nativos (Electron, Chromium shell)
     * pueden exponer la enumeración de otra manera. El consumidor debe
     * hacer `typeof window.posBridge?.listPrinters === "function"` antes
     * de invocarla y respetar `isConnected()` cuando esté disponible.
     *
     * El bridge NUNCA debe interpolar nombres de impresora dentro de
     * comandos de shell: el helper (`list-printers.ps1`) toma cero
     * parámetros variables, y los campos devueltos se consumen como
     * strings opacos.
     */
    listPrinters?(payload?: unknown): Promise<unknown>;

    /**
     * Dispara el pulso ESC/POS al cajón. Payload típico:
     * `{ command, event, connection, printerProfileId, drawer }`.
     *
     * El backend ya audita la apertura antes de llamar al bridge; una
     * falla aquí NO debe revertir la auditoría.
     */
    kickDrawer?(payload: unknown): Promise<unknown>;

    /**
     * Reporta si el bridge está listo. Opcional: los bridges nativos que
     * no la exponen se asumen conectados (compatibilidad hacia atrás).
     * Un bridge basado en WebSocket la usa para que `hasPosBridgePrint`
     * refleje la realidad del enlace.
     */
    isConnected?(): boolean;

    /**
     * Suscripción opcional a cambios de conectividad. Se llama inmediatamente
     * con el estado actual y después cada vez que cambia. Debe devolver
     * una función para cancelar la suscripción.
     */
    onStatusChange?(listener: (status: PosBridgeConnectivity) => void): () => void;
}

declare global {
    interface Window {
        /**
         * Bridge local opcional. Verificar `typeof window.posBridge?.print === "function"`
         * antes de usar — la ausencia del bridge NO es una condición de error, es la
         * situación normal cuando el POS corre sólo en el navegador.
         */
        posBridge?: PosBridge;
    }
}

/**
 * Helper centralizado: `true` si el navegador expone un `posBridge.print`
 * callable Y, cuando el bridge reporta conectividad, está efectivamente
 * conectado. Nunca abre una conexión por sí mismo: sólo consulta estado.
 *
 * Compatibilidad: los bridges externos (electron, chromium shell) que NO
 * exponen `isConnected` siguen tratándose como conectados, igual que
 * antes. Sólo los que SÍ lo exponen (ej. el cliente WebSocket de
 * `src/lib/pos-bridge-ws.ts`) pueden reportar `false` cuando el enlace
 * se cae, y ahí es donde `hasPosBridgePrint` se vuelve honesto.
 */
export function hasPosBridgePrint(): boolean {
    if (typeof window === "undefined") return false;
    const bridge = window.posBridge;
    if (!bridge || typeof bridge.print !== "function") return false;
    if (typeof bridge.isConnected === "function") {
        try {
            return !!bridge.isConnected();
        } catch {
            return false;
        }
    }
    // Bridge sin método isConnected: se asume disponible (BC con bridges nativos).
    return true;
}

/**
 * Helper centralizado para la página de prueba: acepta `printTestPage` o,
 * si no está disponible, cae a `print({type:"test-page"})`. Igualmente
 * honra `isConnected` cuando el bridge lo expone.
 */
export function hasPosBridgeTestPrint(): boolean {
    if (typeof window === "undefined") return false;
    const bridge = window.posBridge;
    if (!bridge) return false;
    const hasMethod = typeof bridge.printTestPage === "function"
        || typeof bridge.print === "function";
    if (!hasMethod) return false;
    if (typeof bridge.isConnected === "function") {
        try {
            return !!bridge.isConnected();
        } catch {
            return false;
        }
    }
    return true;
}

/** Helper centralizado: `true` si el bridge puede abrir el cajón físico. */
export function hasPosBridgeDrawer(): boolean {
    if (typeof window === "undefined") return false;
    const bridge = window.posBridge;
    if (!bridge || typeof bridge.kickDrawer !== "function") return false;
    if (typeof bridge.isConnected === "function") {
        try {
            return !!bridge.isConnected();
        } catch {
            return false;
        }
    }
    return true;
}

/**
 * Helper centralizado: `true` si el bridge puede enumerar las colas de
 * impresión del equipo (acción `listPrinters` del contrato WS). Igual que
 * los otros helpers, honra `isConnected()` cuando el bridge lo expone y
 * asume disponible para bridges nativos sin el método.
 */
export function hasPosBridgeListPrinters(): boolean {
    if (typeof window === "undefined") return false;
    const bridge = window.posBridge;
    if (!bridge || typeof bridge.listPrinters !== "function") return false;
    if (typeof bridge.isConnected === "function") {
        try {
            return !!bridge.isConnected();
        } catch {
            return false;
        }
    }
    return true;
}

/**
 * Estados discretos reportados por el bridge por cola de impresión. Los
 * valores son el enum normalizado (`cleanField` + enum fijo en el
 * bridge). Un valor desconocido debe tratarse como `"unknown"` en la UI.
 *
 * Los tipos y el parser viven en `./pos-bridge-printers.mjs` para que
 * tanto el frontend como los tests `node --test` compartan la fuente de
 * verdad sin pasar por tsc.
 */
export type {
    DetectedPrinter,
    DetectedPrinterStatus,
    DetectedPrintersResult,
} from "./pos-bridge-printers.mjs";
export {
    DETECTED_PRINTER_STATUSES,
    parseDetectedPrintersResult,
} from "./pos-bridge-printers.mjs";

/**
 * Suscripción al estado de conectividad del bridge activo. Si el bridge
 * expone `onStatusChange`, delega. Si no, devuelve un noop: los bridges
 * nativos sin eventos simplemente no notifican cambios (el consumidor
 * sigue viendo el estado estático de `hasPosBridgePrint`).
 */
export function subscribePosBridgeStatus(
    listener: (status: PosBridgeConnectivity) => void,
): () => void {
    if (typeof window === "undefined") return () => {};
    const bridge = window.posBridge;
    if (!bridge || typeof bridge.onStatusChange !== "function") {
        // Entregamos un estado best-effort inicial para que el consumidor
        // pueda renderizar algo coherente sin esperar eventos.
        try {
            listener({
                connected: hasPosBridgePrint(),
                lastError: null,
                lastConnectedAt: null,
            });
        } catch { /* ignore */ }
        return () => {};
    }
    try {
        return bridge.onStatusChange(listener);
    } catch {
        return () => {};
    }
}

export {};
