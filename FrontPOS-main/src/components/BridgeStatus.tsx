"use client";

// =============================================================================
// src/components/BridgeStatus.tsx
//
// Chip pequeño que resume el estado del bridge local/relay y, cuando hay
// varias cajas conectadas al servidor, abre un selector para elegir cuál.
//
// Muestra tres estados:
//   - "Balanza/impresora: local"       (verde)   → bridge directo
//   - "vía servidor · Caja X"          (ámbar)   → relay
//   - "sin conexión"                   (rojo)    → ni local ni relay
//
// Está pensado para montarse en el `AppHeader` (visible en todas las
// pantallas). Reusa shadcn/ui existentes (Popover + Button) para no
// introducir componentes nuevos. Respeta pares `dark:` del tema.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Radio, RefreshCcw, Server, WifiOff } from "lucide-react";

import useSWR from "swr";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useScale } from "@/hooks/useScale";
import { subscribePosBridgeStatus } from "@/lib/pos-bridge";
import { apiFetch, ApiError } from "@/lib/api-error";
import {
    POS_BRIDGE_CAJA_STORAGE_KEY,
    getRelayEndpoints,
    normalizeAgents,
    readSavedCajaId,
    writeSavedCajaId,
    type BridgeAgentInfo,
    type BridgeConnectionMode,
} from "@/lib/bridge-connection.mjs";

interface AgentsResponse {
    agents?: unknown[];
}

interface BridgeStatusViewModel {
    mode: BridgeConnectionMode | null;
    cajaId: string | null;
    scaleConnected: boolean;
    printConnected: boolean;
}

/**
 * Combina el estado de los dos sockets (balanza + impresión) en una vista
 * única. Si cualquiera de los dos está conectado, mostramos el modo del
 * que esté activo (local manda sobre relay en el display).
 */
function useBridgeViewModel(): BridgeStatusViewModel {
    const scale = useScale();
    const [printStatus, setPrintStatus] = useState<{
        connected: boolean;
        mode: BridgeConnectionMode | null;
        cajaId: string | null;
    }>({ connected: false, mode: null, cajaId: null });

    useEffect(() => {
        return subscribePosBridgeStatus((status) => {
            setPrintStatus({
                connected: !!status.connected,
                mode: (status.mode ?? null) as BridgeConnectionMode | null,
                cajaId: status.cajaId ?? null,
            });
        });
    }, []);

    const mode: BridgeConnectionMode | null = scale.mode ?? printStatus.mode ?? null;
    const cajaId: string | null = (() => {
        if (scale.mode === "relay" && scale.cajaId) return scale.cajaId;
        if (printStatus.mode === "relay" && printStatus.cajaId) return printStatus.cajaId;
        return null;
    })();

    return {
        mode,
        cajaId,
        scaleConnected: scale.isConnected,
        printConnected: printStatus.connected,
    };
}

async function fetchAgents(path: string): Promise<AgentsResponse> {
    try {
        return await apiFetch<AgentsResponse>(path, {
            method: "GET",
            skipSessionRecovery: true,
            timeoutMs: 7000,
            fallbackError: "No se pudo listar las cajas conectadas",
        });
    } catch (err) {
        // Un 401 o un fallo HTTP no deben romper el header; devolvemos lista
        // vacía y la UI muestra "no hay cajas" sin interrumpir el POS.
        if (err instanceof ApiError) return { agents: [] };
        return { agents: [] };
    }
}

interface BridgeStatusProps {
    /** Clases extra para el disparador. */
    className?: string;
}

export function BridgeStatus({ className }: BridgeStatusProps) {
    const vm = useBridgeViewModel();
    const [open, setOpen] = useState(false);
    const anyConnected = vm.scaleConnected || vm.printConnected;

    const { agentsPath } = useMemo(() => getRelayEndpoints(), []);

    // Carga perezosa: sólo preguntamos por agentes cuando el popover está
    // abierto o cuando ya estamos en modo relay (así el chip puede listar
    // el nombre completo de la caja activa aunque sólo haya una).
    const shouldQuery = open || vm.mode === "relay";
    const { data, isLoading, mutate } = useSWR<AgentsResponse>(
        shouldQuery ? agentsPath : null,
        fetchAgents,
        {
            revalidateOnFocus: false,
            dedupingInterval: 10_000,
            refreshInterval: open ? 15_000 : 0,
        },
    );

    const agents: BridgeAgentInfo[] = useMemo(() => normalizeAgents(data), [data]);
    const connectedAgents = useMemo(() => agents.filter((a) => a.connected), [agents]);

    const [savedCajaId, setSavedCajaIdState] = useState<string | null>(() => {
        if (typeof window === "undefined") return null;
        return readSavedCajaId(window.localStorage);
    });

    // Si otra pestaña modifica la preferencia, nos enteramos y refrescamos.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const onStorage = (event: StorageEvent) => {
            if (event.key !== POS_BRIDGE_CAJA_STORAGE_KEY) return;
            setSavedCajaIdState(event.newValue?.trim() || null);
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);

    const chooseCaja = useCallback(
        (cajaId: string | null) => {
            if (typeof window !== "undefined") {
                writeSavedCajaId(window.localStorage, cajaId);
            }
            setSavedCajaIdState(cajaId);
            // Refrescamos listas antes de disparar la renegociación para que
            // el chip refleje la nueva caja seleccionada aunque falle la
            // reconexión del socket.
            void mutate();
            // Dispara la renegociación en ambos clientes (balanza + impresión)
            // vía evento global. No importamos ScaleBridge aquí porque el
            // chip puede renderizarse sin que /sales/new esté montado.
            if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent("pos-bridge-renegotiate"));
            }
        },
        [mutate],
    );

    const label = useMemo(() => {
        if (!anyConnected && vm.mode === null) return "sin conexión";
        if (vm.mode === "local") return "local";
        if (vm.mode === "relay" && vm.cajaId) return `vía servidor · ${vm.cajaId}`;
        if (vm.mode === "relay") return "vía servidor";
        return "sin conexión";
    }, [anyConnected, vm.mode, vm.cajaId]);

    const toneClasses = useMemo(() => {
        if (!anyConnected || vm.mode === null) {
            return "bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/20 text-rose-600 dark:text-rose-400";
        }
        if (vm.mode === "local") {
            return "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20 text-emerald-600 dark:text-emerald-400";
        }
        return "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20 text-amber-600 dark:text-amber-400";
    }, [anyConnected, vm.mode]);

    const Icon = vm.mode === "relay" ? Server : vm.mode === "local" ? Radio : WifiOff;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label={`Estado del bridge: ${label}`}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    className={cn(
                        "inline-flex items-center gap-1.5 px-2 py-1 rounded-2xl border text-[10px] font-bold uppercase tracking-widest",
                        "transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400",
                        "active:scale-95",
                        toneClasses,
                        className,
                    )}
                >
                    <Icon className="h-3 w-3" aria-hidden="true" />
                    <span className="hidden sm:inline">Bridge</span>
                    <span className="font-mono normal-case tracking-tight">{label}</span>
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="end"
                sideOffset={6}
                className="w-80 border-zinc-200 dark:border-white/5 bg-white dark:bg-zinc-900 p-4"
            >
                <div className="flex items-start justify-between gap-2">
                    <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                            Balanza / impresora
                        </p>
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            {vm.mode === "local" && "Conectado al bridge local"}
                            {vm.mode === "relay" && `Conectado vía servidor · Caja ${vm.cajaId ?? "?"}`}
                            {vm.mode === null && "Sin conexión al bridge"}
                        </p>
                    </div>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Refrescar lista de cajas"
                        className="h-7 w-7"
                        onClick={() => void mutate()}
                    >
                        {isLoading
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            : <RefreshCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        }
                    </Button>
                </div>

                <div className="mt-3 space-y-2">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                        Cajas conectadas al servidor
                    </p>
                    {connectedAgents.length === 0 ? (
                        <p
                            className="text-xs text-zinc-500 dark:text-zinc-400"
                            data-testid="bridge-status-no-agents"
                        >
                            {isLoading
                                ? "Consultando cajas…"
                                : "No hay cajas conectadas al servidor. Enciende el PC de caja o vuelve a intentar."}
                        </p>
                    ) : (
                        <ul
                            className="space-y-1"
                            role="listbox"
                            aria-label="Cajas disponibles para operar"
                        >
                            {connectedAgents.map((agent) => {
                                const isActive = vm.cajaId === agent.cajaId;
                                const isPreferred = savedCajaId === agent.cajaId;
                                return (
                                    <li key={agent.cajaId} role="option" aria-selected={isActive}>
                                        <button
                                            type="button"
                                            onClick={() => chooseCaja(agent.cajaId)}
                                            className={cn(
                                                "w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border text-left transition-colors",
                                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400",
                                                isActive
                                                    ? "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                                                    : "bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-white/5 hover:bg-zinc-100 dark:hover:bg-zinc-800/70 text-zinc-800 dark:text-zinc-200",
                                            )}
                                        >
                                            <span className="flex items-center gap-2 min-w-0">
                                                <Server className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                                <span className="font-mono text-xs truncate">{agent.cajaId}</span>
                                            </span>
                                            <span className="flex items-center gap-1 text-[9px] uppercase tracking-widest">
                                                {isPreferred && (
                                                    <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">
                                                        preferida
                                                    </span>
                                                )}
                                                {isActive && (
                                                    <span className="rounded-full bg-emerald-500/40 px-1.5 py-0.5 text-emerald-800 dark:text-emerald-200">
                                                        activa
                                                    </span>
                                                )}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    {savedCajaId && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="w-full justify-start text-xs text-zinc-600 dark:text-zinc-400"
                            onClick={() => chooseCaja(null)}
                        >
                            Limpiar preferencia y auto-seleccionar
                        </Button>
                    )}
                </div>

                <p className="mt-3 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
                    El POS intenta primero el bridge local (ws://localhost:9876);
                    si no responde, usa el servidor como relay para alcanzar la
                    caja remota. La selección se guarda en este dispositivo.
                </p>
            </PopoverContent>
        </Popover>
    );
}

export default BridgeStatus;
