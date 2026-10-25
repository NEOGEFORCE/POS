// =============================================================================
// useBoldQrGlobalTray.ts
//
// Variante ligera y SÓLO LECTURA del hook `useBoldQrTray` para la
// bandeja global de "QR en espera" que montamos en el header para
// admin / superadmin.
//
// Diferencias con `useBoldQrTray`:
//   - Consulta GET /api/pos/pagos-qr/pendientes?scope=all (no filtra
//     por caja): lista los QR pendientes de TODAS las cajas.
//   - Suscribe SSE /api/pos/pagos-qr/caja-stream?scope=all con el mismo
//     contrato de frames (ver `classifyTrayEvent`).
//   - También consulta GET /api/pos/pagos-qr/pagos-sin-asignar?minutos=1440
//     para que el admin vea pagos huérfanos del día desde cualquier
//     pantalla y pueda enlazarlos a una intención pendiente de cualquier
//     caja (migración 027c). La ventana por defecto es 24 h — alineada
//     con la bandeja local del cajero y la constante backend.
//   - Expone `assignPaymentToIntent` que reutiliza POST /pos/pagos-qr/asignar
//     (ver `useBoldQrTray` — mismo endpoint, pero sin filtro de caja).
//   - NO toca sessionStorage de "pagado": esa es una decisión por caja
//     y no debe interferir con el estado de los cajeros.
//   - NO emite callbacks de aprobación (sin sonido/voz). Al llegar un
//     APPROVED simplemente lo quitamos del listado.
//
// Reglas duras:
//   - Si no hay sesión, el hook queda inactivo (lista vacía, sin SSE).
//   - La confirmación manual (POST /pos/pagos-qr/confirmar-manual) es
//     admin-only por contrato de backend; aquí sólo propaga el error.
// =============================================================================

"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api-error";
import { API_URL } from "@/lib/constants";
import { useAuth } from "@/lib/auth";
import { computeSSERetryDelay, parseSSEBlock } from "@/lib/resilience-policy.mjs";
import {
    BOLD_QR_TRAY_EVENT,
    BOLD_QR_TRAY_KIND,
    buildAsignarPayload,
    classifyTrayEvent,
    classifyUnassignedPayment,
    type BoldQrUnassignedPayment,
} from "@/lib/bold-qr-helpers.mjs";

export interface BoldQrGlobalPendingItem {
    readonly intentId: number;
    readonly ventaTempId: string;
    readonly cajaId: string;
    readonly cashierName?: string;
    readonly amountCop: number;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly queuedAt?: string;
}

export type { BoldQrUnassignedPayment } from "@/lib/bold-qr-helpers.mjs";

interface PendientesResponse {
    readonly ok?: boolean;
    readonly items?: Array<{
        readonly intentId?: number | string;
        readonly ventaTempId?: string;
        readonly cajaId?: string;
        readonly cashierName?: string;
        readonly amountCop?: number;
        readonly createdAt?: string;
        readonly expiresAt?: string;
        readonly queuedAt?: string;
    }>;
    readonly total?: number;
}

interface UnassignedResponse {
    readonly ok?: boolean;
    readonly items?: unknown[];
    readonly total?: number;
}

// Ventana por defecto 24 h. Alineada con `useBoldQrTray` para que el
// admin vea los mismos pagos que el cajero sin configuración adicional.
const DEFAULT_UNASSIGNED_WINDOW_MINUTES = 1440;
const DEFAULT_POLL_INTERVAL_MS = 20_000;

function normalizePending(raw: PendientesResponse["items"]): BoldQrGlobalPendingItem[] {
    if (!Array.isArray(raw)) return [];
    const items: BoldQrGlobalPendingItem[] = [];
    for (const r of raw) {
        if (!r || typeof r !== "object") continue;
        const intentIdRaw = r.intentId;
        const intentId =
            typeof intentIdRaw === "number" && Number.isFinite(intentIdRaw)
                ? intentIdRaw
                : typeof intentIdRaw === "string" && intentIdRaw.trim()
                    ? Number(intentIdRaw)
                    : NaN;
        const ventaTempId = typeof r.ventaTempId === "string" ? r.ventaTempId.trim() : "";
        if (!Number.isFinite(intentId) || !ventaTempId) continue;
        items.push({
            intentId,
            ventaTempId,
            cajaId: typeof r.cajaId === "string" ? r.cajaId : "",
            cashierName: typeof r.cashierName === "string" ? r.cashierName : undefined,
            amountCop: typeof r.amountCop === "number" ? r.amountCop : 0,
            createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
            expiresAt: typeof r.expiresAt === "string" ? r.expiresAt : "",
            queuedAt: typeof r.queuedAt === "string" ? r.queuedAt : undefined,
        });
    }
    return items;
}

function normalizeUnassigned(raw: UnassignedResponse["items"]): BoldQrUnassignedPayment[] {
    if (!Array.isArray(raw)) return [];
    const out: BoldQrUnassignedPayment[] = [];
    for (const r of raw) {
        const parsed = classifyUnassignedPayment(r);
        if (parsed) out.push(parsed);
    }
    return out;
}

export interface BoldQrGlobalTrayState {
    readonly pendings: BoldQrGlobalPendingItem[];
    readonly unassignedPayments: BoldQrUnassignedPayment[];
    readonly latestError: string | null;
    readonly latestUnassignedError: string | null;
    readonly reconnect: () => Promise<void>;
    readonly reloadUnassigned: () => Promise<void>;
    readonly dismissIntent: (ventaTempId: string) => void;
    /** Confirmación manual auditada (sólo admin, lo valida el backend). */
    readonly confirmManualIntent: (ventaTempId: string, nota: string) => Promise<void>;
    /**
     * Enlaza un pago huérfano a una intención pendiente existente usando
     * POST /pos/pagos-qr/asignar. El backend valida monto exacto + rol.
     * El llamador recibe el error (con `code` canónico) si rechaza.
     */
    readonly assignPaymentToIntent: (ventaTempId: string, eventId: number) => Promise<void>;
}

/**
 * `enabled` controla el montaje: cuando el consumidor sabe que el usuario
 * NO es admin o la ruta actual es `/sales/new` (donde ya corre la bandeja
 * de caja), pasa `enabled=false` y el hook queda inerte sin tocar la red.
 */
export function useBoldQrGlobalTray(enabled: boolean = true): BoldQrGlobalTrayState {
    const { user } = useAuth();
    const token = user?.token;

    const [pendings, setPendings] = useState<BoldQrGlobalPendingItem[]>([]);
    const [unassignedPayments, setUnassignedPayments] = useState<BoldQrUnassignedPayment[]>([]);
    const [latestError, setLatestError] = useState<string | null>(null);
    const [latestUnassignedError, setLatestUnassignedError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        if (!enabled || !token) return;
        try {
            const res = await apiFetch<PendientesResponse>(
                `/pos/pagos-qr/pendientes?scope=all&limit=50`,
                {
                    method: "GET",
                    fallbackError: "No se pudo cargar la bandeja QR global",
                    timeoutMs: 8000,
                },
            );
            setPendings(normalizePending(res?.items));
            setLatestError(null);
        } catch (err) {
            setLatestError(
                err instanceof Error ? err.message : "No se pudo cargar la bandeja QR global",
            );
        }
    }, [enabled, token]);

    const reloadUnassigned = useCallback(async () => {
        if (!enabled || !token) return;
        try {
            // `minutos=1440` + `max_minutos=1440` pide al backend la ventana
            // extendida para administradores (migración 027c). Si el backend
            // rechaza el max_minutos (empleado, no admin), responderá sólo
            // los últimos 60 min; igual pintamos lo que llegue.
            const res = await apiFetch<UnassignedResponse>(
                `/pos/pagos-qr/pagos-sin-asignar?minutos=${encodeURIComponent(
                    String(DEFAULT_UNASSIGNED_WINDOW_MINUTES),
                )}&max_minutos=${encodeURIComponent(String(DEFAULT_UNASSIGNED_WINDOW_MINUTES))}`,
                {
                    method: "GET",
                    fallbackError: "No se pudieron cargar los pagos por asignar",
                    timeoutMs: 8000,
                },
            );
            setUnassignedPayments(normalizeUnassigned(res?.items));
            setLatestUnassignedError(null);
        } catch (err) {
            setLatestUnassignedError(
                err instanceof Error ? err.message : "No se pudieron cargar los pagos por asignar",
            );
        }
    }, [enabled, token]);

    const dismissIntent = useCallback((ventaTempId: string) => {
        setPendings((prev) => prev.filter((p) => p.ventaTempId !== ventaTempId));
    }, []);

    const confirmManualIntent = useCallback(
        async (ventaTempId: string, nota: string) => {
            if (!token) {
                throw new Error("Sesión expirada");
            }
            const id = ventaTempId.trim();
            if (!id) {
                throw new Error("Cobro inválido");
            }
            await apiFetch("/pos/pagos-qr/confirmar-manual", {
                method: "POST",
                body: JSON.stringify({ venta_temp_id: id, nota: nota.trim().slice(0, 200) }),
                fallbackError: "No se pudo confirmar el pago",
                timeoutMs: 10000,
            });
            await reload();
        },
        [token, reload],
    );

    const assignPaymentToIntent = useCallback(
        async (ventaTempId: string, eventId: number) => {
            if (!token) {
                throw new Error("Sesión expirada");
            }
            const payload = buildAsignarPayload({
                venta_temp_id: ventaTempId,
                event_id: eventId,
            });
            if (!payload) {
                throw new Error("Datos inválidos para asignar el pago");
            }
            await apiFetch("/pos/pagos-qr/asignar", {
                method: "POST",
                body: JSON.stringify(payload),
                fallbackError: "No se pudo asignar el pago",
                timeoutMs: 10000,
            });
            // Al éxito, refrescar ambas listas defensivamente para que
            // la UI no espere al próximo frame SSE.
            await Promise.all([reload(), reloadUnassigned()]);
        },
        [token, reload, reloadUnassigned],
    );

    // Primera carga + reload al cambiar de token/estado.
    useEffect(() => {
        void reload();
    }, [reload]);

    useEffect(() => {
        void reloadUnassigned();
    }, [reloadUnassigned]);

    // Polling cada 20 s mientras existan pendings o pagos sin asignar.
    const hasActivity = pendings.length > 0 || unassignedPayments.length > 0;
    useEffect(() => {
        if (!enabled || !token) return;
        if (!hasActivity) return;
        const id = window.setInterval(() => {
            void reloadUnassigned();
        }, DEFAULT_POLL_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, [enabled, token, hasActivity, reloadUnassigned]);

    // SSE global.
    useEffect(() => {
        if (!enabled || !token) return;
        let cancelled = false;
        let retryAttempt = 0;
        let retryTimer: number | null = null;
        let controller: AbortController | null = null;

        const scheduleReconnect = () => {
            if (cancelled) return;
            const delay = computeSSERetryDelay(retryAttempt++);
            retryTimer = window.setTimeout(() => void connect(), delay);
        };

        const handleTrayFrame = (payload: unknown) => {
            const evt = classifyTrayEvent(payload);
            if (!evt) return;
            const { kind, ventaTempId } = evt;
            if (kind === BOLD_QR_TRAY_KIND.ENQUEUED) {
                setPendings((prev) => {
                    if (prev.some((p) => p.ventaTempId === ventaTempId)) return prev;
                    return [
                        {
                            intentId: evt.intentId ?? 0,
                            ventaTempId,
                            cajaId: evt.cajaId ?? "",
                            cashierName: evt.cashierName,
                            amountCop: evt.amountCop ?? 0,
                            createdAt: evt.occurredAt ?? new Date().toISOString(),
                            expiresAt: "",
                            queuedAt: evt.occurredAt,
                        },
                        ...prev,
                    ];
                });
                return;
            }
            if (
                kind === BOLD_QR_TRAY_KIND.APPROVED ||
                kind === BOLD_QR_TRAY_KIND.EXPIRED ||
                kind === BOLD_QR_TRAY_KIND.CANCELLED
            ) {
                dismissIntent(ventaTempId);
                // Al aprobar/expirar/cancelar, un pago huérfano puede
                // haber quedado consumido en backend — refrescar lista.
                void reloadUnassigned();
                return;
            }
            if (
                kind === BOLD_QR_TRAY_KIND.AMBIGUOUS ||
                kind === BOLD_QR_TRAY_KIND.UNMATCHED ||
                kind === BOLD_QR_TRAY_KIND.ERROR
            ) {
                // Refetchear estado desde la fuente de verdad para que el
                // badge y la lista queden coherentes.
                void reload();
                void reloadUnassigned();
                return;
            }
        };

        const consumeStream = async (response: Response) => {
            if (!response.body) throw new Error("stream SSE sin body");
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (!cancelled) {
                const { value, done } = await reader.read();
                buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
                let boundary = buffer.indexOf("\n\n");
                while (boundary >= 0) {
                    const frame = parseSSEBlock(buffer.slice(0, boundary));
                    buffer = buffer.slice(boundary + 2);
                    if (frame && frame.event === BOLD_QR_TRAY_EVENT) {
                        try {
                            const parsed = JSON.parse(frame.data);
                            handleTrayFrame(parsed);
                        } catch {
                            // ignorar frame malformado
                        }
                    }
                    boundary = buffer.indexOf("\n\n");
                }
                if (done) break;
            }
        };

        const connect = async () => {
            controller = new AbortController();
            try {
                const url = `${API_URL}/pos/pagos-qr/caja-stream?scope=all`;
                const response = await fetch(url, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: "text/event-stream",
                    },
                    cache: "no-store",
                    signal: controller.signal,
                });
                if (response.status === 401) {
                    throw new Error("Sesión expirada en la bandeja QR global");
                }
                if (!response.ok) throw new Error(`SSE HTTP ${response.status}`);
                retryAttempt = 0;
                // Al reconectar, repoblar desde la BD.
                void reload();
                void reloadUnassigned();
                await consumeStream(response);
                if (!cancelled) throw new Error("stream SSE cerrado");
            } catch (err) {
                if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
                    return;
                }
                scheduleReconnect();
            }
        };

        void connect();
        return () => {
            cancelled = true;
            controller?.abort();
            if (retryTimer !== null) window.clearTimeout(retryTimer);
        };
    }, [enabled, token, reload, reloadUnassigned, dismissIntent]);

    return {
        pendings,
        unassignedPayments,
        latestError,
        latestUnassignedError,
        reconnect: reload,
        reloadUnassigned,
        dismissIntent,
        confirmManualIntent,
        assignPaymentToIntent,
    };
}
