// =============================================================================
// useBoldQrTray.ts
//
// Hook global de la bandeja QR Bold/Bre-B para /sales/new (migración 027).
//
// Responsabilidades:
//   - Al montar, cargar GET /api/pos/pagos-qr/pendientes?caja_id=... para
//     repoblar la bandeja tras refresh/reconexión.
//   - Al montar, cargar GET /api/pos/pagos-qr/pagos-sin-asignar?minutos=30
//     para mostrar transferencias que llegaron sin match claro (AMBIGUOUS
//     o UNMATCHED) y permitir asignación manual del cajero.
//   - Mantener abierto GET /api/pos/pagos-qr/caja-stream?caja_id=... con
//     fetch streaming + Authorization: Bearer. NUNCA token en query.
//   - Reconectar con backoff exponencial reusando computeSSERetryDelay.
//   - Deduplicar APPROVED por ventaTempId con un Set en useRef + un
//     sessionStorage key `bold-qr-notified:<ventaTempId>` para que un
//     refresh de pestaña no vuelva a mostrar la alerta grande.
//   - Mantener polling cada 20 s de `/pagos-sin-asignar` mientras existan
//     pendings o pagos sin asignar.
//   - Exponer los pendings + pagosSinAsignar + un callback
//     `onApprovedOnce(info)` que la página consume para mostrar la alerta
//     grande + sonido + anuncio por voz. El hook NO renderiza UI.
//
// Reglas duras:
//   - El hook sobrevive al cierre del modal. Lo monta /sales/new/page.tsx
//     y vive hasta que el cajero navega fuera del route.
//   - Si no hay sesión, el hook queda inactivo (listas vacías, sin SSE).
//   - El Set de dedupe se mantiene en useRef, no en useState (evitamos
//     renders en cada APPROVED). sessionStorage es la defensa contra
//     reload del navegador.
//   - La asignación manual (POST /asignar) devuelve 200 o errores 404/409
//     con codes canónicos (QR_EVENT_ALREADY_ASSIGNED, QR_AMOUNT_MISMATCH,
//     QR_INTENT_ALREADY_TERMINAL, QR_EVENT_NOT_FOUND, QR_INTENT_NOT_FOUND).
//     El hook sólo dispara el POST y propaga el error al llamador; el UI
//     muestra el toast legible usando `describeAssignErrorCode`.
// =============================================================================

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
    isBoldQrPaidInStorage,
    listBoldQrPaidKeys,
    markBoldQrPaidInStorage,
    type BoldQrUnassignedPayment,
} from "@/lib/bold-qr-helpers.mjs";

export interface BoldQrPendingItem {
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

export interface BoldQrTrayApprovedInfo {
    readonly ventaTempId: string;
    readonly intentId?: number;
    readonly amountCop?: number;
    readonly saleId?: number;
    readonly reference?: string;
    readonly approvedAt?: string;
    readonly approvedVia?: string;
    readonly cashierName?: string;
}

interface UseBoldQrTrayOptions {
    readonly cajaId: string;
    /**
     * Se dispara EXACTAMENTE UNA VEZ por ventaTempId cuando llega un
     * tray event kind=APPROVED. Dedupe por sessionStorage para que un
     * reload no vuelva a emitir alerta + sonido + anuncio.
     */
    readonly onApprovedOnce?: (info: BoldQrTrayApprovedInfo) => void;
    /**
     * Ventana del backend para listar pagos sin asignar. Por defecto
     * 30 min (empata con contrato backend). Se puede subir en pantallas
     * administrativas.
     */
    readonly unassignedWindowMinutes?: number;
    /**
     * Intervalo de polling cuando existen pendings/pagos sin asignar.
     * Por defecto 20 s (empata con prompt del sprint).
     */
    readonly pollIntervalMs?: number;
}

const SESSION_PREFIX = "bold-qr-notified:";
const DEFAULT_UNASSIGNED_WINDOW_MINUTES = 30;
const DEFAULT_POLL_INTERVAL_MS = 20_000;

function normalizePending(raw: PendientesResponse["items"]): BoldQrPendingItem[] {
    if (!Array.isArray(raw)) return [];
    const items: BoldQrPendingItem[] = [];
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

function markSessionNotified(ventaTempId: string): boolean {
    if (typeof window === "undefined") return false;
    try {
        const key = SESSION_PREFIX + ventaTempId;
        if (window.sessionStorage.getItem(key)) return false;
        window.sessionStorage.setItem(key, String(Date.now()));
        return true;
    } catch {
        return true; // storage denegado: deja pasar para no silenciar la alerta.
    }
}

export interface BoldQrTrayState {
    readonly pendings: BoldQrPendingItem[];
    readonly unassignedPayments: BoldQrUnassignedPayment[];
    readonly latestError: string | null;
    readonly latestUnassignedError: string | null;
    readonly reconnect: () => Promise<void>;
    readonly reloadUnassigned: () => Promise<void>;
    readonly dismissIntent: (ventaTempId: string) => void;
    readonly assignPaymentToIntent: (
        ventaTempId: string,
        eventId: number,
    ) => Promise<void>;
    /** Confirmación manual auditada (sólo admin) cuando el SMS no llegó. */
    readonly confirmManualIntent: (ventaTempId: string, nota: string) => Promise<void>;
    /**
     * Marca un ventaTempId como pagado. Lo persiste en sessionStorage
     * (sobrevive refresh) y lo filtra inmediatamente de la bandeja
     * visible. Idempotente: llamar dos veces no duplica efectos.
     *
     * El consumidor DEBE invocarla en:
     *   - `onBoldQrFinalized` (ruta modal, saleId > 0 confirmado).
     *   - `onApprovedOnce` (ruta bandeja, aprobación por caja-stream).
     *   - `prepareBoldQrIntent` cuando `/iniciar` responde `alreadyPaid=true`.
     *   - `handleBoldQrEnqueueRequested` cuando `/encolar` responde
     *     409 QR_INTENT_ALREADY_PAID.
     */
    readonly markPaid: (info: {
        readonly ventaTempId: string;
        readonly saleId?: number;
        readonly amountCop?: number;
    }) => void;
    /** `true` si el ventaTempId quedó marcado como pagado en esta sesión. */
    readonly isPaid: (ventaTempId: string) => boolean;
}

export function useBoldQrTray({
    cajaId,
    onApprovedOnce,
    unassignedWindowMinutes,
    pollIntervalMs,
}: UseBoldQrTrayOptions): BoldQrTrayState {
    const { user } = useAuth();
    const token = user?.token;
    const trimmedCaja = (cajaId || "").trim();
    const windowMinutes =
        typeof unassignedWindowMinutes === "number" &&
        Number.isFinite(unassignedWindowMinutes) &&
        unassignedWindowMinutes > 0
            ? Math.floor(unassignedWindowMinutes)
            : DEFAULT_UNASSIGNED_WINDOW_MINUTES;
    const pollMs =
        typeof pollIntervalMs === "number" && Number.isFinite(pollIntervalMs) && pollIntervalMs >= 1000
            ? Math.floor(pollIntervalMs)
            : DEFAULT_POLL_INTERVAL_MS;

    const [pendings, setPendings] = useState<BoldQrPendingItem[]>([]);
    const [unassignedPayments, setUnassignedPayments] = useState<BoldQrUnassignedPayment[]>([]);
    const [latestError, setLatestError] = useState<string | null>(null);
    const [latestUnassignedError, setLatestUnassignedError] = useState<string | null>(null);
    // Set de ventaTempId que ya quedaron finalizados en esta sesión del
    // navegador (APPROVED por el stream, finalizados por el modal o
    // detectados como alreadyPaid por `/iniciar`/`/encolar`). Se
    // persiste en sessionStorage para resistir reloads y se repuebla
    // al montar el hook. La bandeja los filtra siempre: aunque el
    // backend aún liste el intent viejo durante un instante, el
    // frontend NO lo muestra como pending.
    const [paidKeys, setPaidKeys] = useState<Set<string>>(() => {
        if (typeof window === "undefined") return new Set<string>();
        try {
            return new Set<string>(listBoldQrPaidKeys(window.sessionStorage));
        } catch {
            return new Set<string>();
        }
    });

    // Set de ventas ya notificadas en esta sesión (en memoria). Combina
    // con sessionStorage para resistir reloads.
    const notifiedRef = useRef<Set<string>>(new Set());
    const onApprovedOnceRef = useRef(onApprovedOnce);
    onApprovedOnceRef.current = onApprovedOnce;

    const markPaid = useCallback(
        (info: { ventaTempId: string; saleId?: number; amountCop?: number }) => {
            if (!info || typeof info !== "object") return;
            const key = typeof info.ventaTempId === "string" ? info.ventaTempId.trim() : "";
            if (!key) return;
            if (typeof window !== "undefined") {
                markBoldQrPaidInStorage(window.sessionStorage, key, {
                    saleId: info.saleId,
                    amountCop: info.amountCop,
                });
            }
            setPaidKeys((prev) => {
                if (prev.has(key)) return prev;
                const next = new Set(prev);
                next.add(key);
                return next;
            });
            // Al marcar pagado filtramos inmediatamente de la bandeja
            // sin esperar al siguiente frame SSE. Es idempotente con
            // `dismissIntent` (ya se usaba en el flujo APPROVED del
            // stream).
            setPendings((prev) => prev.filter((p) => p.ventaTempId !== key));
        },
        [],
    );

    const isPaid = useCallback(
        (ventaTempId: string): boolean => {
            const key = typeof ventaTempId === "string" ? ventaTempId.trim() : "";
            if (!key) return false;
            if (paidKeys.has(key)) return true;
            if (typeof window !== "undefined") {
                return isBoldQrPaidInStorage(window.sessionStorage, key);
            }
            return false;
        },
        [paidKeys],
    );

    const reload = useCallback(async () => {
        if (!token || !trimmedCaja) return;
        try {
            const res = await apiFetch<PendientesResponse>(
                `/pos/pagos-qr/pendientes?caja_id=${encodeURIComponent(trimmedCaja)}&limit=20`,
                { method: "GET", fallbackError: "No se pudo cargar la bandeja QR", timeoutMs: 8000 },
            );
            const normalized = normalizePending(res?.items);
            // Filtrar los que ya quedaron pagados en esta sesión: el
            // backend puede tardar un instante en sacar la intención
            // de /pendientes tras un APROBADO; el frontend NO muestra
            // basura entretanto.
            let paid = paidKeys;
            if (typeof window !== "undefined") {
                try {
                    const fromStorage = listBoldQrPaidKeys(window.sessionStorage);
                    if (fromStorage.length !== paid.size || fromStorage.some((k) => !paid.has(k))) {
                        paid = new Set<string>(fromStorage);
                        setPaidKeys(paid);
                    }
                } catch {
                    // Storage denegado: usamos lo que tengamos en memoria.
                }
            }
            const paidRef = paid;
            setPendings(normalized.filter((p) => !paidRef.has(p.ventaTempId)));
            setLatestError(null);
        } catch (err) {
            setLatestError(err instanceof Error ? err.message : "No se pudo cargar la bandeja QR");
        }
    }, [token, trimmedCaja, paidKeys]);

    const reloadUnassigned = useCallback(async () => {
        if (!token) return;
        try {
            const res = await apiFetch<UnassignedResponse>(
                `/pos/pagos-qr/pagos-sin-asignar?minutos=${encodeURIComponent(String(windowMinutes))}`,
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
    }, [token, windowMinutes]);

    const dismissIntent = useCallback((ventaTempId: string) => {
        setPendings((prev) => prev.filter((p) => p.ventaTempId !== ventaTempId));
    }, []);

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
            // Al éxito, el backend emite SSE APPROVED que
            // llegará por caja-stream y cerrará el ciclo del
            // pending. Refrescamos ambas listas defensivamente
            // para que la UI no espere al próximo frame.
            await Promise.all([reload(), reloadUnassigned()]);
        },
        [token, reload, reloadUnassigned],
    );

    // Confirmación manual (sólo admin; el backend lo exige por rol).
    // Se usa cuando el pago entró en la app Bold pero el SMS nunca
    // llegó. El backend audita el DNI de la sesión y el barrido de
    // finalización factura la venta encolada con su snapshot.
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

    // Primera carga + reload al cambiar de caja.
    useEffect(() => {
        void reload();
    }, [reload]);

    // Primera carga + reload de pagos sin asignar al cambiar de token.
    useEffect(() => {
        void reloadUnassigned();
    }, [reloadUnassigned]);

    // Polling cada `pollMs` mientras existan pendings o pagos sin asignar.
    const hasActivity = pendings.length > 0 || unassignedPayments.length > 0;
    useEffect(() => {
        if (!token) return;
        if (!hasActivity) return;
        const id = window.setInterval(() => {
            void reloadUnassigned();
        }, pollMs);
        return () => window.clearInterval(id);
    }, [token, hasActivity, pollMs, reloadUnassigned]);

    // SSE caja-stream.
    useEffect(() => {
        if (!token || !trimmedCaja) return;
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
                // Añadir a la bandeja (dedupe por ventaTempId).
                setPendings((prev) => {
                    if (prev.some((p) => p.ventaTempId === ventaTempId)) return prev;
                    return [
                        {
                            intentId: evt.intentId ?? 0,
                            ventaTempId,
                            cajaId: evt.cajaId ?? trimmedCaja,
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
            if (kind === BOLD_QR_TRAY_KIND.APPROVED) {
                // Dedupe: emitimos alerta sólo una vez por ventaTempId
                // en esta sesión (useRef + sessionStorage).
                if (notifiedRef.current.has(ventaTempId)) {
                    dismissIntent(ventaTempId);
                    // Persistir pagado también en este guard: si el
                    // frame volvió a llegar es porque otra pestaña lo
                    // notificó. Al escribirlo aquí la bandeja al
                    // próximo `reload()` lo filtra sin reaparecer.
                    if (typeof window !== "undefined") {
                        markBoldQrPaidInStorage(window.sessionStorage, ventaTempId, {
                            saleId: evt.saleId,
                            amountCop: evt.amountCop,
                        });
                    }
                    setPaidKeys((prev) => {
                        if (prev.has(ventaTempId)) return prev;
                        const next = new Set(prev);
                        next.add(ventaTempId);
                        return next;
                    });
                    return;
                }
                if (!markSessionNotified(ventaTempId)) {
                    dismissIntent(ventaTempId);
                    return;
                }
                notifiedRef.current.add(ventaTempId);
                dismissIntent(ventaTempId);
                // Persistir como pagado para que el próximo `reload()`
                // (y la próxima pestaña) no muestre el pending viejo.
                if (typeof window !== "undefined") {
                    markBoldQrPaidInStorage(window.sessionStorage, ventaTempId, {
                        saleId: evt.saleId,
                        amountCop: evt.amountCop,
                    });
                }
                setPaidKeys((prev) => {
                    if (prev.has(ventaTempId)) return prev;
                    const next = new Set(prev);
                    next.add(ventaTempId);
                    return next;
                });
                // Al aprobar un pending, puede que un pago sin asignar
                // haya quedado consumido en backend — refrescar lista.
                void reloadUnassigned();
                const cb = onApprovedOnceRef.current;
                if (typeof cb === "function") {
                    cb({
                        ventaTempId,
                        intentId: evt.intentId,
                        amountCop: evt.amountCop,
                        saleId: evt.saleId,
                        reference: evt.reference,
                        approvedAt: evt.approvedAt,
                        approvedVia: evt.approvedVia,
                        cashierName: evt.cashierName,
                    });
                }
                return;
            }
            if (
                kind === BOLD_QR_TRAY_KIND.AMBIGUOUS ||
                kind === BOLD_QR_TRAY_KIND.UNMATCHED
            ) {
                // Al recibir AMBIGUOUS/UNMATCHED del backend, es muy
                // probable que un pago sin asignar nuevo esté
                // disponible. Refrescamos la lista para que el cajero
                // lo vea sin esperar al próximo tick de polling.
                void reloadUnassigned();
                // Además refrescamos el estado del intent desde /pendientes
                // para que la UI muestre el motivo actualizado.
                void reload();
                return;
            }
            if (
                kind === BOLD_QR_TRAY_KIND.EXPIRED ||
                kind === BOLD_QR_TRAY_KIND.CANCELLED
            ) {
                dismissIntent(ventaTempId);
                return;
            }
            // ERROR: refetchear estado en segundo plano para que la
            // UI muestre el motivo.
            void reload();
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
                const url =
                    `${API_URL}/pos/pagos-qr/caja-stream?caja_id=` + encodeURIComponent(trimmedCaja);
                const response = await fetch(url, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: "text/event-stream",
                    },
                    cache: "no-store",
                    signal: controller.signal,
                });
                if (response.status === 401) {
                    throw new Error("Sesión expirada en la bandeja QR");
                }
                if (!response.ok) throw new Error(`SSE HTTP ${response.status}`);
                retryAttempt = 0;
                // Al reconectar, repoblar la bandeja + pagos sin asignar
                // desde la BD (fuente de verdad).
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
    }, [token, trimmedCaja, reload, reloadUnassigned, dismissIntent]);

    return {
        pendings,
        unassignedPayments,
        latestError,
        latestUnassignedError,
        reconnect: reload,
        reloadUnassigned,
        dismissIntent,
        assignPaymentToIntent,
        confirmManualIntent,
        markPaid,
        isPaid,
    };
}
