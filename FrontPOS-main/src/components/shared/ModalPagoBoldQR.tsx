"use client";

// =============================================================================
// ModalPagoBoldQR.tsx
//
// Modal shadcn para el método "QR Bold / Bre-B (Nequi, DaviPlata, Bancos)"
// del cobro real del Supermercado Surtifamiliar. El QR es ESTÁTICO: el
// cliente escanea con cualquier app de Bre-B y digita el valor exacto en
// pesos colombianos que el cajero le indica en pantalla.
//
// Contrato con el backend (migración 027 — 100% asíncrono):
//   1. POST  /api/pos/pagos-qr/iniciar           {caja_id, monto, venta_temp_id}
//      → crea una intención PENDIENTE con expiración de 15 min.
//   2. GET   /api/pos/pagos-qr/stream?venta_temp_id=... (SSE)
//      → emite eventos tipados `qr_intent_update` con shape
//        {status, reference?, approvedAt?, approvedVia?, expiresAt?, reason?}.
//      → requiere Authorization: Bearer <token> en el header. El modal
//        monta la conexión con `fetch` + ReadableStream (como
//        GlobalSyncProvider), NUNCA pasa el token por query string.
//   3. GET   /api/pos/pagos-qr/estado?venta_temp_id=...
//      → snapshot sin stream, útil al reconectar.
//   4. POST  /api/pos/pagos-qr/encolar          (snapshot durable)
//      → el cajero deja la intención en espera; el padre
//        (/sales/new/page.tsx) lo invoca al pulsar
//        "DEJAR EN ESPERA Y SEGUIR ATENDIENDO".
//   5. POST  /api/pos/pagos-qr/cancelar          {venta_temp_id, motivo?}
//      → el cajero cancela y cambia de método.
//
//   NOTA: la ruta residual de confirmación manual del cajero quedó
//   retirada en la migración 027. Permanece admin-only de emergencia
//   del lado del backend; el modal del cajero NO la invoca, NO la
//   nombra y NO la pinta en la UI.
//
// Reglas duras del componente:
//   * NUNCA llama a onApproved más de UNA vez por intención (guard con
//     useRef). Esto evita duplicar la venta cuando el webhook llega
//     justo mientras el cajero intenta cerrar el modal.
//   * NUNCA pasa el token en la URL del SSE: queda sólo en el header
//     Authorization (contrato copiado de GlobalSyncProvider).
//   * NUNCA inventa un QR si la imagen /qr-bold-breb-code.png no carga:
//     muestra un error UX honesto y bloquea el botón "DEJAR EN ESPERA Y
//     SEGUIR ATENDIENDO" para que el cajero regrese y elija otro flujo.
//     No se genera placeholder financiero.
//   * NUNCA expone secretos del lado backend: la verificación HMAC y el
//     token del bridge MacroDroid viven solo en el servidor; este modal
//     nunca los recibe ni los nombra.
//   * El SSE se reconecta con backoff exponencial (computeSSERetryDelay)
//     cuando el stream cae por red. La reconexión usa el mismo
//     venta_temp_id, por lo que el backend reemite el snapshot al
//     primer frame y el modal no pierde el estado.
//   * Al expirar (15 min sin webhook) → cambia a estado EXPIRED y ofrece
//     al cajero cancelar o dejar en espera (la aprobación tardía la
//     cerrará automáticamente la bandeja global).
//
// Integración:
//   - El padre (p.ej. /sales/new/page.tsx) renderiza este modal cuando el
//     cajero pulsa el método "QR Bold / Bre-B" en UniversalPaymentModal.
//   - Al éxito "síncrono" el padre cierra ambos modales y ejecuta su propio
//     flujo de registro de venta (POST /sales/register) con
//     transferSource = "BOLD_QR". La impresión y el pulso del cajón
//     siguen el camino normal del POS (no se tocan desde aquí).
//   - En el camino "asíncrono" (preferido en migración 027) el cajero
//     pulsa "DEJAR EN ESPERA Y SEGUIR ATENDIENDO": el padre encola el
//     snapshot vía POST /encolar y la bandeja global muestra la
//     intención hasta que MacroDroid confirma. El backend materializa
//     la venta canónica; el frontend sólo muestra la alerta y suena
//     una vez. La impresión queda a cargo del backend/SaleService
//     para no duplicar tirillas.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
    AlertTriangle,
    Check,
    Loader2,
    Smartphone,
    Timer,
    X,
    ShieldCheck,
    QrCode,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { apiFetch, ApiError } from "@/lib/api-error";
import { API_URL } from "@/lib/constants";
import { useAuth } from "@/lib/auth";
import { playNotificationSound } from "@/lib/audio-utils";
import { computeSSERetryDelay, parseSSEBlock } from "@/lib/resilience-policy.mjs";
import { formatCurrency } from "@/lib/utils";
import {
    BOLD_MERCHANT,
    BOLD_QR_ASSET_SIDE_PX,
    BOLD_QR_CSS_MIN,
    BOLD_QR_IMAGE_PATH,
    DAVIPLATA_KEY,
    BOLD_QR_METHOD_BADGE,
    BOLD_QR_PREFERRED_SIDE_PX,
    BOLD_QR_STATUS,
    buildIniciarPayload,
    classifyStreamEvent,
    formatCountdown,
    isAlreadyPaidResponse,
    msUntilExpiry,
} from "@/lib/bold-qr-helpers.mjs";

// ---------------------------------------------------------------------------
// Tipos del contrato con el backend.
//
// Importante: Go sirve respuestas JSON en camelCase (iniciarResponse,
// cancelarResponse del handler Go). El REQUEST se envía en snake_case
// porque así lo exige `iniciarPayload` del Go. La asimetría es
// intencional y documentada por el equipo backend.
// ---------------------------------------------------------------------------

interface IniciarResponse {
    readonly ok?: boolean;
    /** El backend emite uint64 → JSON number; aceptamos también string por si pasa por un gateway que lo serialice como texto. */
    readonly intentId?: number | string;
    readonly ventaTempId?: string;
    readonly status?: string;
    readonly streamStatus?: string;
    readonly expiresAt?: string;
    readonly expiresInSeconds?: number;
    readonly reused?: boolean;
    readonly message?: string;
    /**
     * Número de intenciones PENDIENTES del mismo monto (incluye otras
     * cajas), al momento del `/iniciar`. Cuando `> 0` el modal muestra
     * una advertencia compacta: si los dos clientes pagan al tiempo el
     * backend no podrá emparejar automáticamente y los pagos aparecen
     * en la bandeja "Pagos por asignar". No bloquea el flujo.
     */
    readonly sameAmountPending?: number;
    /**
     * `true` si la intención asociada al ventaTempId ya fue aprobada
     * previamente. El backend lo retorna como atajo para que el
     * frontend evite reabrir el QR de un cobro cerrado (bug
     * 2026-10-23: UPM reabría un QR pagado al abrir cobros de otra
     * cuenta). Cuando `alreadyPaid === true`:
     *   - El modal pasa a `APPROVED` sin countdown ni botones de espera.
     *   - El padre (`sales/new/page.tsx`) marca el ventaTempId como
     *     pagado en la bandeja y cierra el UPM.
     *
     * `saleId` y `amountCop` acompañan al flag con la venta canónica
     * creada por `DispatchAutoSale`; pueden faltar en backends
     * históricos (defensa: nunca se inventan).
     */
    readonly alreadyPaid?: boolean;
    readonly saleId?: number | string;
    readonly amountCop?: number;
}

interface StreamIntentPayload {
    readonly status?: string;
    readonly reason?: string;
    /** El backend lo serializa como `reference` (ver sse.QREvent). Es el bold_code o manual-reference. */
    readonly reference?: string;
    /** Timestamp UTC RFC3339 del lado servidor. Preferimos este al reloj del cliente. */
    readonly approvedAt?: string;
    /** `approvedVia` replica `approved_source` del intent cuando status=APROBADO (BOLD_OFFICIAL | BRIDGE_NOTIFICATION | MANUAL). */
    readonly approvedVia?: string;
    readonly expiresAt?: string;
    readonly note?: string;
    /**
     * `saleId` positivo acompaña al frame APROBADO cuando el dispatcher
     * backend ya materializó la venta canónica vía `SaleService.CreateSale`
     * y `MarkFinalizationSucceeded` vinculó `related_sale_id` (migración
     * 027, flujo DispatchAutoSale). Hasta ese commit NUNCA se emite:
     * recibir APROBADO con `saleId > 0` es la señal unívoca de que el
     * backend ya cerró la venta y por tanto el POS NO debe crear otra
     * (evita duplicados y descuadres de stock).
     *
     * `uint64` del backend serializa a JSON `number`; aceptamos también
     * `string` por si un gateway hostea números grandes como texto.
     */
    readonly saleId?: number | string;
    /**
     * Monto COP exacto cobrado por el QR (int64 → number). Se emite
     * junto con `saleId` en el frame APROBADO para que el POS pueda
     * mostrar un resumen "Se cobró $X" sin volver a consultar el
     * snapshot. Omitido mientras `saleId` sea 0.
     */
    readonly amountCop?: number;
}

export interface ModalPagoBoldQRProps {
    readonly isOpen: boolean;
    readonly onOpenChange: (open: boolean) => void;
    /** Monto EXACTO en COP que el cliente debe digitar al escanear el QR. */
    readonly monto: number;
    /** ID temporal de la venta en curso (lo genera el padre con crypto.randomUUID). */
    readonly ventaTempId: string;
    /** ID de la caja (string | number). El backend lo valida como entero > 0. */
    readonly cajaId: string | number;
    /**
     * Se dispara EXACTAMENTE UNA VEZ cuando la intención queda aprobada
     * por webhook automático. El padre (UPM) decide la ruta según el
     * `saleId`:
     *
     *   - `saleId > 0` ⇒ el backend ya materializó la venta canónica
     *     (DispatchAutoSale + MarkFinalizationSucceeded). El UPM delega
     *     al callback `onBoldQrFinalized` del padre `/sales/new/page.tsx`
     *     y JAMÁS llama a `onPay` (eso regeneraría un `clientTxId` nuevo
     *     y crearía una segunda venta duplicada en `/sales/register`).
     *   - `saleId <= 0 / undefined` ⇒ frame inconsistente. El UPM muestra
     *     error UX "Esperando conciliación" y nunca llama a `onPay`
     *     automáticamente. El backend reconciliará con el bridge.
     *
     * **FLUJO ASÍNCRONO (migración 027):** la aprobación "normal" ya no
     * exige al cajero esperar en pantalla. El cajero pulsa
     * "DEJAR EN ESPERA Y SEGUIR ATENDIENDO" y el servidor materializa
     * la venta cuando MacroDroid envía la notificación. Este callback
     * sigue siendo útil para la contingencia en la que el cajero prefiera
     * esperar frente al QR.
     *
     * El shape del callback incluye `saleId` y `amountCop` tomados del
     * frame SSE `qr_intent_update` del backend. Nunca se inventan: si
     * el frame no los trae, llegan como `undefined`.
     */
    readonly onApproved: (info: {
        readonly reference: string;
        readonly approvedAt: string;
        readonly approvedVia: string;
        readonly saleId?: number;
        readonly amountCop?: number;
    }) => void;
    /**
     * `onEnqueueAndClose` (migración 027): el cajero pulsa el botón
     * primario "DEJAR EN ESPERA Y SEGUIR ATENDIENDO". El padre encola
     * la intención con snapshot al backend, limpia SÓLO el carrito
     * actual y abre uno limpio para el siguiente cliente. Las ventas
     * QR pendientes siguen vivas en la bandeja global de /sales/new.
     *
     * **Contrato exacto**: el modal pasa `ventaTempId` y `monto` tal
     * cual los recibió en sus props, SIN regenerarlos. El padre debe
     * reutilizar ambos valores en el POST /encolar; nunca generar
     * una nueva ventaTempId, porque dejaría dos pendientes del mismo
     * monto (bandeja global duplicaría la intención viva).
     */
    readonly onEnqueueAndClose?: (ventaTempId: string, monto: number) => Promise<void> | void;
    /** El cajero canceló explícitamente o cambió de método de pago. */
    readonly onCancel?: () => void;
    /**
     * QR reabierto desde la bandeja (cobro ya en espera). En este modo
     * cerrar NO cancela la intención ni toca el carrito activo: sólo
     * oculta el QR. El cobro sigue en espera hasta que llegue el pago.
     */
    readonly reopened?: boolean;
    /**
     * Resumen legible "Efectivo $X + QR $Y" de los OTROS canales que el
     * cajero ya acumuló antes de abrir el QR (migración 027c — pago
     * mixto). Si está presente, el modal lo pinta como banner arriba
     * del monto para que cajero y cliente vean que la cuenta cuadra.
     * Cuando el cajero cobra 100% por QR el padre pasa `undefined` y
     * el banner no se renderiza.
     */
    readonly mixedChannelsSummary?: string;
}

// Estado interno de la máquina. Discriminado para evitar renders en
// estados imposibles (p.ej. "approved" sin referencia).
type ModalPhase =
    | { readonly kind: "INIT" }
    | { readonly kind: "ERROR"; readonly message: string }
    | {
          readonly kind: "PENDING";
          readonly intentId: string;
          readonly createdAtMs: number;
      }
    | {
          readonly kind: "AMBIGUOUS";
          readonly intentId: string;
          readonly createdAtMs: number;
          readonly reason: string;
      }
    | {
          readonly kind: "UNMATCHED";
          readonly intentId: string;
          readonly createdAtMs: number;
          readonly reason: string;
      }
    | { readonly kind: "EXPIRED"; readonly intentId: string }
    | {
          readonly kind: "APPROVED";
          readonly reference: string;
          readonly approvedAt: string;
          readonly approvedVia: string;
      };

// Para evitar refetchear al reabrir el modal con la misma venta_temp_id
// mientras un proceso previo seguía vivo. También nos aseguramos de que
// `onApproved` se dispare una sola vez (ver guard `approvedFiredRef`).

export default function ModalPagoBoldQR({
    isOpen,
    onOpenChange,
    monto,
    ventaTempId,
    cajaId,
    onApproved,
    onEnqueueAndClose,
    onCancel,
    reopened = false,
    mixedChannelsSummary,
}: ModalPagoBoldQRProps): JSX.Element | null {
    const { user } = useAuth();
    const token = user?.token;

    const [phase, setPhase] = useState<ModalPhase>({ kind: "INIT" });
    const [qrImageMissing, setQrImageMissing] = useState<boolean>(false);
    const [enqueueBusy, setEnqueueBusy] = useState<boolean>(false);
    const [cancelBusy, setCancelBusy] = useState<boolean>(false);
    // 900 s = 15 min por contrato de la migración 027. El tick del
    // reloj (`msUntilExpiry`) actualiza el valor real al montar; este
    // es sólo el valor placeholder antes del primer tick.
    const [remainingSec, setRemainingSec] = useState<number>(900);
    /**
     * Pendings QR en todo el POS con EXACTAMENTE el mismo monto que la
     * intención recién iniciada (incluye otras cajas). Si llega > 0,
     * se pinta un Alert compacto como aviso operativo: cuando dos
     * clientes pagan al tiempo con el mismo valor, el backend no puede
     * desambiguar y los eventos quedan en "Pagos por asignar". No
     * bloquea el flujo; sólo informa al cajero.
     */
    const [sameAmountPending, setSameAmountPending] = useState<number>(0);

    // Guard: onApproved se dispara UNA vez por sesión del modal.
    const approvedFiredRef = useRef<boolean>(false);
    // Ventana para auto-cerrar tras aprobación (1.5s por contrato UX).
    const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ------------------------------------------------------------------
    // Reset del estado al abrir/cerrar el modal.
    // ------------------------------------------------------------------
    useEffect(() => {
        if (!isOpen) {
            // Al cerrar, limpiamos SIEMPRE el guard y los temporizadores
            // para que la próxima apertura (misma venta_temp_id u otra)
            // arranque fresca.
            approvedFiredRef.current = false;
            if (autoCloseTimerRef.current !== null) {
                clearTimeout(autoCloseTimerRef.current);
                autoCloseTimerRef.current = null;
            }
            setEnqueueBusy(false);
            setCancelBusy(false);
            setPhase({ kind: "INIT" });
            setRemainingSec(900);
            setQrImageMissing(false);
            setSameAmountPending(0);
            return;
        }
    }, [isOpen]);

    // ------------------------------------------------------------------
    // Disparar POST /api/pos/pagos-qr/iniciar al abrir.
    // ------------------------------------------------------------------
    useEffect(() => {
        if (!isOpen) return;
        if (!token) return;
        let cancelled = false;

        const start = async () => {
            setPhase({ kind: "INIT" });
            const payload = buildIniciarPayload({
                caja_id: cajaId,
                monto,
                venta_temp_id: ventaTempId,
            });
            if (!payload) {
                if (!cancelled) {
                    setPhase({
                        kind: "ERROR",
                        message:
                            "No se pudo preparar el cobro QR: datos inválidos (monto o venta_temp_id).",
                    });
                }
                return;
            }
            try {
                const res = await apiFetch<IniciarResponse>(
                    "/pos/pagos-qr/iniciar",
                    {
                        method: "POST",
                        body: JSON.stringify(payload),
                        fallbackError: "No se pudo iniciar el cobro QR",
                        timeoutMs: 10000,
                    },
                );
                if (cancelled) return;
                // --- Rama "ya pagada": `/iniciar` responde con la venta
                // canónica materializada. NO abrimos stream ni countdown;
                // pasamos directo a APPROVED y disparamos onApproved con
                // el saleId/amountCop del backend. Esta rama cierra el
                // bug 2026-10-23 (reapertura de QR ya pagado al abrir
                // cobros de otra cuenta).
                const alreadyPaid = isAlreadyPaidResponse(res);
                if (alreadyPaid) {
                    if (approvedFiredRef.current) return;
                    approvedFiredRef.current = true;
                    const approvedAt = new Date().toISOString();
                    setPhase({
                        kind: "APPROVED",
                        reference: "",
                        approvedAt,
                        approvedVia: "ALREADY_PAID",
                    });
                    if (autoCloseTimerRef.current !== null) {
                        clearTimeout(autoCloseTimerRef.current);
                    }
                    autoCloseTimerRef.current = setTimeout(() => {
                        try {
                            onApproved({
                                reference: "",
                                approvedAt,
                                approvedVia: "ALREADY_PAID",
                                saleId: alreadyPaid.saleId,
                                amountCop: alreadyPaid.amountCop,
                            });
                        } finally {
                            autoCloseTimerRef.current = null;
                        }
                    }, 0);
                    return;
                }
                // El backend Go emite `intentId` como uint64 → JSON number.
                // Aceptamos también string para resistir gateways que
                // serialicen números grandes como texto; vacío/null → error.
                const rawIntentId = res?.intentId;
                const intentId =
                    typeof rawIntentId === "number" && Number.isFinite(rawIntentId)
                        ? String(rawIntentId)
                        : typeof rawIntentId === "string" && rawIntentId.trim()
                            ? rawIntentId.trim()
                            : "";
                if (!intentId) {
                    setPhase({
                        kind: "ERROR",
                        message:
                            "El backend aceptó la intención pero no devolvió identificador.",
                    });
                    return;
                }
                setPhase({
                    kind: "PENDING",
                    intentId,
                    createdAtMs: Date.now(),
                });
                // sameAmountPending: aviso compacto si hay otras
                // intenciones pendientes del mismo monto (otras cajas
                // o la misma caja). Nunca bloquea el flujo.
                const rawSameAmount = (res as { sameAmountPending?: unknown })?.sameAmountPending;
                const sameAmount =
                    typeof rawSameAmount === "number" && Number.isFinite(rawSameAmount) && rawSameAmount > 0
                        ? Math.floor(rawSameAmount)
                        : 0;
                setSameAmountPending(sameAmount);
            } catch (err) {
                if (cancelled) return;
                const message =
                    err instanceof ApiError || err instanceof Error
                        ? err.message
                        : "Error inesperado al iniciar el cobro QR";
                setPhase({ kind: "ERROR", message });
            }
        };

        void start();
        return () => {
            cancelled = true;
        };
    }, [isOpen, token, cajaId, monto, ventaTempId]);

    // ------------------------------------------------------------------
    // Reloj de expiración (contador MM:SS) y transición a EXPIRED.
    // ------------------------------------------------------------------
    useEffect(() => {
        if (!isOpen) return;
        if (phase.kind !== "PENDING" && phase.kind !== "AMBIGUOUS" && phase.kind !== "UNMATCHED") {
            return;
        }
        const createdAtMs = phase.createdAtMs;
        const tick = () => {
            const left = msUntilExpiry(createdAtMs, Date.now());
            setRemainingSec(Math.ceil(left / 1000));
            if (left <= 0) {
                setPhase((prev) => {
                    if (prev.kind === "APPROVED") return prev;
                    if (prev.kind === "EXPIRED") return prev;
                    const intentId =
                        prev.kind === "PENDING" || prev.kind === "AMBIGUOUS" || prev.kind === "UNMATCHED"
                            ? prev.intentId
                            : "";
                    return { kind: "EXPIRED", intentId };
                });
            }
        };
        tick();
        const id = window.setInterval(tick, 1000);
        return () => window.clearInterval(id);
    }, [isOpen, phase.kind, phase]);

    // ------------------------------------------------------------------
    // Handler único para transiciones de estado desde la stream SSE
    // o desde la respuesta de confirmación manual.
    // ------------------------------------------------------------------
    const applyStreamPayload = useCallback(
        (payload: StreamIntentPayload) => {
            const classification = classifyStreamEvent({
                status: payload.status,
                reason: payload.reason,
            });
            switch (classification.action) {
                case "approve": {
                    if (approvedFiredRef.current) return;
                    approvedFiredRef.current = true;
                    const reference =
                        typeof payload.reference === "string" && payload.reference.trim()
                            ? payload.reference.trim()
                            : "";
                    const approvedAt =
                        typeof payload.approvedAt === "string" && payload.approvedAt.trim()
                            ? payload.approvedAt.trim()
                            : new Date().toISOString();
                    // `approvedVia` del backend puede ser:
                    //   - BOLD_OFFICIAL  (webhook oficial Bold, HMAC)
                    //   - BRIDGE_NOTIFICATION  (puente MacroDroid)
                    //   - MANUAL  (confirmación manual admin-only, de emergencia)
                    // Si por algún motivo viene vacío (p.ej. snapshot
                    // histórico sin el campo poblado), caemos a
                    // BOLD_OFFICIAL como default razonable para no
                    // romper el callback. El fallback NUNCA cambia el
                    // comportamiento del flujo de impresión.
                    const approvedVia =
                        typeof payload.approvedVia === "string" && payload.approvedVia.trim()
                            ? payload.approvedVia.trim()
                            : "BOLD_OFFICIAL";
                    // `saleId` y `amountCop` del QREvent de la 027.
                    // El dispatcher los emite SÓLO después del commit
                    // de SaleService.CreateSale → recibir saleId > 0
                    // es la señal canónica de "backend ya cerró la
                    // venta, el POS NO debe duplicar". Toleramos
                    // string por gateways que serializan uint64
                    // grandes como texto.
                    const rawSaleId = (payload as { saleId?: unknown }).saleId;
                    let saleId: number | undefined;
                    if (typeof rawSaleId === "number" && Number.isFinite(rawSaleId) && Number.isInteger(rawSaleId) && rawSaleId > 0) {
                        saleId = rawSaleId;
                    } else if (typeof rawSaleId === "string" && /^[1-9]\d*$/.test(rawSaleId.trim())) {
                        const parsed = Number.parseInt(rawSaleId.trim(), 10);
                        if (Number.isFinite(parsed) && parsed > 0) saleId = parsed;
                    }
                    const rawAmountCop = (payload as { amountCop?: unknown }).amountCop;
                    const amountCop = typeof rawAmountCop === "number" && Number.isFinite(rawAmountCop) && rawAmountCop > 0
                        ? Math.round(rawAmountCop)
                        : undefined;
                    setPhase({ kind: "APPROVED", reference, approvedAt, approvedVia });
                    try {
                        playNotificationSound("success");
                    } catch {
                        // El audio no es crítico. Honramos mute global vía
                        // playNotificationSound; cualquier excepción se
                        // silencia para no romper el flujo UX.
                    }
                    if (autoCloseTimerRef.current !== null) {
                        clearTimeout(autoCloseTimerRef.current);
                    }
                    autoCloseTimerRef.current = setTimeout(() => {
                        try {
                            onApproved({
                                reference,
                                approvedAt,
                                approvedVia,
                                saleId,
                                amountCop,
                            });
                        } finally {
                            autoCloseTimerRef.current = null;
                        }
                    }, 1500);
                    return;
                }
                case "require-manual": {
                    setPhase((prev) => {
                        const createdAtMs =
                            prev.kind === "PENDING" ||
                            prev.kind === "AMBIGUOUS" ||
                            prev.kind === "UNMATCHED"
                                ? prev.createdAtMs
                                : Date.now();
                        const intentId =
                            prev.kind === "PENDING" ||
                            prev.kind === "AMBIGUOUS" ||
                            prev.kind === "UNMATCHED"
                                ? prev.intentId
                                : prev.kind === "EXPIRED"
                                    ? prev.intentId
                                    : "";
                        const reason = classification.reason || "AMBIGUOUS";
                        return reason === BOLD_QR_STATUS.UNMATCHED
                            ? { kind: "UNMATCHED", intentId, createdAtMs, reason }
                            : { kind: "AMBIGUOUS", intentId, createdAtMs, reason };
                    });
                    return;
                }
                case "expire": {
                    setPhase((prev) => {
                        const intentId =
                            prev.kind === "PENDING" ||
                            prev.kind === "AMBIGUOUS" ||
                            prev.kind === "UNMATCHED" ||
                            prev.kind === "EXPIRED"
                                ? prev.intentId
                                : "";
                        return { kind: "EXPIRED", intentId };
                    });
                    return;
                }
                case "cancel": {
                    setPhase({ kind: "ERROR", message: "La intención fue cancelada." });
                    return;
                }
                case "error": {
                    setPhase({
                        kind: "ERROR",
                        message: classification.reason || "El servidor reportó un error en la intención.",
                    });
                    return;
                }
                case "wait":
                case "ignore":
                default:
                    return;
            }
        },
        [onApproved],
    );

    // ------------------------------------------------------------------
    // SSE: /pos/pagos-qr/stream?venta_temp_id=...
    // Autenticado con fetch streaming + Authorization. NUNCA token en query.
    // Reintento exponencial con computeSSERetryDelay si cae la red.
    // ------------------------------------------------------------------
    useEffect(() => {
        if (!isOpen) return;
        if (phase.kind !== "PENDING" && phase.kind !== "AMBIGUOUS" && phase.kind !== "UNMATCHED") {
            return;
        }
        if (!token) return;
        if (!ventaTempId) return;

        let cancelled = false;
        let retryAttempt = 0;
        let retryTimer: number | null = null;
        let controller: AbortController | null = null;

        const scheduleReconnect = () => {
            if (cancelled) return;
            const delay = computeSSERetryDelay(retryAttempt++);
            retryTimer = window.setTimeout(() => void connect(), delay);
        };

        const consumeStream = async (response: Response) => {
            if (!response.body) throw new Error("El navegador no entregó el stream SSE");
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
                    // El backend emite `event: ping\ndata: {"heartbeat":"..."}` cada
                    // 15 s. Lo saltamos antes del JSON.parse para no gastar
                    // ciclos ni ruido en los logs del dev. Los eventos reales
                    // viajan como `event: qr_intent_update`.
                    if (frame && frame.event !== "ping") {
                        try {
                            const parsed = JSON.parse(frame.data) as StreamIntentPayload;
                            applyStreamPayload(parsed);
                        } catch {
                            // Frame malformado: lo ignoramos (defensa).
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
                    `${API_URL}/pos/pagos-qr/stream?venta_temp_id=` +
                    encodeURIComponent(ventaTempId);
                const response = await fetch(url, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: "text/event-stream",
                    },
                    cache: "no-store",
                    signal: controller.signal,
                });
                if (response.status === 401) {
                    // Delegamos la recuperación al flujo global; nosotros
                    // mantenemos el modal en estado ERROR hasta que el
                    // cajero reintente desde el padre.
                    throw new Error("Sesión expirada durante el cobro QR.");
                }
                if (!response.ok) throw new Error(`SSE HTTP ${response.status}`);
                retryAttempt = 0;
                await consumeStream(response);
                if (!cancelled) throw new Error("El stream SSE se cerró");
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
    }, [isOpen, phase.kind, token, ventaTempId, applyStreamPayload]);

    // ------------------------------------------------------------------
    // DEJAR EN ESPERA Y SEGUIR ATENDIENDO (migración 027).
    //
    // El padre (sales/new/page.tsx) encola el carrito al backend via
    // POST /api/pos/pagos-qr/encolar y, al confirmar, limpia SÓLO el
    // carrito activo. La bandeja global muestra las intenciones
    // encoladas vivas y las aprobadas emiten alerta grande + sonido +
    // impresión única sin tocar el carrito del siguiente cliente.
    //
    // El antiguo botón de confirmación manual se eliminó del modal del
    // cajero por mandato de la migración 027: la ruta residual admin-only
    // de emergencia operativa queda del lado del backend (ver backend
    // main.go subgrupo posQrAdmin).
    //
    // **Contrato exacto**: pasamos `ventaTempId` y `monto` de las props
    // al callback para que el padre nunca regenere identificadores y la
    // bandeja no acumule dos pendientes por el mismo monto.
    // ------------------------------------------------------------------
    const handleEnqueueAndClose = useCallback(async () => {
        if (enqueueBusy) return;
        if (approvedFiredRef.current) return;
        if (typeof onEnqueueAndClose !== "function") return;
        setEnqueueBusy(true);
        try {
            await onEnqueueAndClose(ventaTempId, Math.round(monto));
            // El padre ya cerró el modal via onOpenChange(false) tras
            // confirmar el encolado. Aquí no tocamos phase.
        } catch (err) {
            const message =
                err instanceof ApiError || err instanceof Error
                    ? err.message
                    : "Error inesperado al dejar en espera el cobro QR";
            setPhase({ kind: "ERROR", message });
        } finally {
            setEnqueueBusy(false);
        }
    }, [enqueueBusy, onEnqueueAndClose, ventaTempId, monto]);

    // ------------------------------------------------------------------
    // Cancelar/cambiar método: POST /api/pos/pagos-qr/cancelar
    // Si falla, igual cerramos la UI (el backend reconciliará con la
    // expiración de 15 min); el cajero no debe quedar atrapado.
    // ------------------------------------------------------------------
    const handleCancel = useCallback(() => {
        if (cancelBusy) return;
        if (approvedFiredRef.current) return;

        // QR reabierto desde la bandeja: sólo cerrar la vista. Cancelar
        // aquí borraría un cobro que ya está en espera con su carrito.
        if (reopened) {
            onCancel?.();
            onOpenChange(false);
            return;
        }

        // Liberar la interfaz ANTES de esperar red. El cajero vuelve de
        // inmediato al modal principal y puede elegir efectivo/Nequi/etc.
        // `ventaTempId` queda capturado por este callback aunque el padre
        // limpie su ref al ejecutar onCancel.
        setCancelBusy(true);
        onCancel?.();
        onOpenChange(false);

        // Cancelación best-effort en segundo plano. Si falla, la intención
        // expira sola a los 15 minutos y nunca bloquea la interfaz.
        void apiFetch("/pos/pagos-qr/cancelar", {
            method: "POST",
            body: JSON.stringify({ venta_temp_id: ventaTempId }),
            fallbackError: "No se pudo cancelar el cobro QR",
            timeoutMs: 10000,
            skipSessionRecovery: true,
        })
            .catch(() => undefined)
            .finally(() => setCancelBusy(false));
    }, [cancelBusy, ventaTempId, onCancel, onOpenChange, reopened]);

    if (!isOpen) return null;

    const isWaiting = phase.kind === "PENDING";
    const isManualGate =
        phase.kind === "AMBIGUOUS" ||
        phase.kind === "UNMATCHED" ||
        phase.kind === "EXPIRED";
    const isApproved = phase.kind === "APPROVED";
    const canEnqueue = (isWaiting || isManualGate) && typeof onEnqueueAndClose === "function";

    return (
        <div
            className="flex h-full min-h-0 w-full items-center justify-center bg-black/75 p-2 md:p-4"
            data-testid="bold-qr-payment-view"
        >
            <section
                aria-labelledby="bold-qr-modal-title"
                aria-describedby="bold-qr-modal-description"
                className="relative w-[calc(100vw-1rem)] max-w-[520px] max-h-full overflow-y-auto overscroll-contain bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/5 rounded-2xl p-4 md:p-5 shadow-[0_18px_60px_rgb(0,0,0,0.24)]"
            >
                <button
                    type="button"
                    onClick={handleCancel}
                    disabled={cancelBusy || isApproved}
                    aria-label="Cerrar QR y cambiar método"
                    className="absolute right-3 top-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-white"
                >
                    <X className="h-4 w-4" aria-hidden="true" />
                </button>

                <header className="flex flex-col text-center gap-2 pr-8">
                    {/* Nombre del negocio visible: al escanear, el QR de Bold
                        muestra "Surtifamiliar", así el cliente confirma que
                        paga al comercio correcto. */}
                    <h2
                        id="bold-qr-modal-title"
                        className="text-xl md:text-2xl font-bold uppercase tracking-tight leading-tight text-zinc-900 dark:text-white"
                    >
                        {BOLD_MERCHANT.businessName}
                    </h2>
                    <p
                        id="bold-qr-modal-description"
                        className="mx-auto inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide leading-tight"
                    >
                        <QrCode className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {BOLD_QR_METHOD_BADGE}
                    </p>
                </header>

                <div className="flex flex-col items-center gap-1.5 py-2.5">
                    {mixedChannelsSummary ? (
                        <div
                            className="mb-1 inline-flex items-center gap-2 rounded-xl bg-sky-500/10 border border-sky-500/30 px-3 py-1.5 text-[11px] font-semibold text-sky-700 dark:text-sky-300 leading-tight max-w-full"
                            data-testid="bold-qr-mixed-channels-summary"
                            aria-label="Desglose del pago mixto"
                        >
                            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-sky-500" aria-hidden="true" />
                            <span className="truncate">{mixedChannelsSummary}</span>
                        </div>
                    ) : null}
                    <p className="text-[10px] uppercase font-semibold tracking-widest text-zinc-500 dark:text-zinc-400">
                        Digita este valor exacto en tu app
                    </p>
                    <p
                        className="text-4xl md:text-5xl font-bold tracking-tight tabular-nums leading-none text-zinc-900 dark:text-white"
                        aria-live="polite"
                    >
                        ${formatCurrency(monto)}
                    </p>
                    <p className="text-[10px] text-zinc-500 dark:text-zinc-400 text-center max-w-sm leading-tight">
                        {BOLD_MERCHANT.subheader}
                    </p>

                    {/* Asset QR-only: recorte nativo 561×561 sin interpolación.
                        Los módulos ocupan 481×481 y conservan 40 px de quiet
                        zone blanca en los cuatro lados. Se muestra como máximo
                        a 320 px, de modo que el navegador sólo reduce y nunca
                        amplía una captura borrosa. */}
                    <div
                        className="relative flex items-center justify-center rounded-xl border border-zinc-200 bg-white overflow-hidden shadow-[0_8px_24px_rgb(0,0,0,0.12)]"
                        style={{
                            width: `min(68vw, ${BOLD_QR_PREFERRED_SIDE_PX}px)`,
                            maxWidth: "100%",
                            minWidth: `min(${BOLD_QR_CSS_MIN}, 100%)`,
                            aspectRatio: "1 / 1",
                        }}
                        role="img"
                        aria-label={`Código QR Daviplata para pagar $${formatCurrency(monto)}`}
                    >
                        {!qrImageMissing ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                src={BOLD_QR_IMAGE_PATH}
                                width={BOLD_QR_ASSET_SIDE_PX}
                                height={BOLD_QR_ASSET_SIDE_PX}
                                alt="QR Daviplata"
                                className="block h-full w-full object-contain"
                                decoding="sync"
                                onError={() => setQrImageMissing(true)}
                            />
                        ) : (
                            <div
                                className="flex flex-col items-center justify-center gap-2 text-center p-4 bg-white dark:bg-zinc-950 h-full w-full"
                                role="alert"
                                aria-live="assertive"
                            >
                                <AlertTriangle
                                    className="h-10 w-10 text-rose-500"
                                    aria-hidden="true"
                                />
                                <p className="text-[11px] uppercase font-bold tracking-widest text-rose-600 dark:text-rose-400">
                                    QR_IMAGE_MISSING
                                </p>
                                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-tight">
                                    Pide al administrador cargar
                                    <br />
                                    <code className="font-mono text-[11px] text-zinc-700 dark:text-zinc-200">
                                        /qr-daviplata.png
                                    </code>
                                    <br />
                                    antes de usar este método.
                                </p>
                            </div>
                        )}
                    </div>
                </div>
                {DAVIPLATA_KEY ? (
                    <p className="mt-2 text-center text-sm font-semibold text-zinc-800 dark:text-zinc-100" data-testid="daviplata-key">
                        Llave Daviplata: <span className="font-mono tabular-nums">{DAVIPLATA_KEY}</span>
                    </p>
                ) : null}

                {/* Advertencia opcional: hay otra intención pendiente con
                    el MISMO monto en curso (misma u otra caja). Si pagan al
                    tiempo, el backend no puede desambiguar y los pagos irán
                    a "Pagos por asignar". No bloquea el flujo. */}
                {sameAmountPending > 0 && (phase.kind === "PENDING" || phase.kind === "AMBIGUOUS" || phase.kind === "UNMATCHED") ? (
                    <Alert
                        className="w-full border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200 py-2"
                        data-testid="bold-qr-same-amount-pending-alert"
                    >
                        <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" />
                        <AlertDescription className="text-[11px] leading-tight">
                            Hay otro cobro QR de ${formatCurrency(monto)} en espera. Si pagan al
                            tiempo, asigna el pago en la bandeja QR en espera.
                        </AlertDescription>
                    </Alert>
                ) : null}

                {/* Estado animado */}
                <div className="min-h-[56px] flex items-center justify-center py-1">
                    {phase.kind === "INIT" && (
                        <StatusChip
                            tone="muted"
                            icon={<Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />}
                            label="Preparando cobro QR..."
                        />
                    )}
                    {phase.kind === "ERROR" && (
                        <Alert variant="destructive" className="w-full">
                            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                            <AlertTitle>No se pudo procesar el cobro QR</AlertTitle>
                            <AlertDescription>{phase.message}</AlertDescription>
                        </Alert>
                    )}
                    {isWaiting && (
                        <StatusChip
                            tone="info"
                            icon={<Smartphone className="h-5 w-5 animate-pulse" aria-hidden="true" />}
                            label="Esperando confirmación de pago..."
                            trailing={
                                <span
                                    className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-300"
                                    aria-live="polite"
                                >
                                    <Timer className="h-3 w-3" aria-hidden="true" />
                                    <span className="tabular-nums">
                                        {formatCountdown(remainingSec * 1000)}
                                    </span>
                                </span>
                            }
                        />
                    )}
                    {phase.kind === "AMBIGUOUS" && (
                        <Alert variant="destructive" className="w-full">
                            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                            <AlertTitle>Pago ambiguo — Verificar con otra caja</AlertTitle>
                            <AlertDescription>
                                Hay otra caja esperando el mismo monto. Deja este cobro en
                                espera para que la bandeja global lo resuelva, o cancela y
                                vuelve a intentar con un canal distinto.
                            </AlertDescription>
                        </Alert>
                    )}
                    {phase.kind === "UNMATCHED" && (
                        <Alert variant="destructive" className="w-full">
                            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                            <AlertTitle>Pago no identificado</AlertTitle>
                            <AlertDescription>
                                Llegó un pago sin un cobro pendiente de este monto. Puedes
                                dejar en espera (la bandeja global reconciliará si el pago
                                aparece) o cancelar para cambiar de método.
                            </AlertDescription>
                        </Alert>
                    )}
                    {phase.kind === "EXPIRED" && (
                        <Alert variant="destructive" className="w-full">
                            <Timer className="h-4 w-4" aria-hidden="true" />
                            <AlertTitle>La intención expiró</AlertTitle>
                            <AlertDescription>
                                Pasaron 15 minutos sin confirmación. Puedes dejar en espera
                                (la bandeja global sigue escuchando por si el pago llega) o
                                cancelar y usar otro método.
                            </AlertDescription>
                        </Alert>
                    )}
                    {isApproved && (
                        <div
                            className="flex flex-col items-center gap-2 text-center"
                            aria-live="assertive"
                            role="status"
                        >
                            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/20 ring-4 ring-emerald-500/30 animate-in zoom-in-50 duration-500">
                                <Check className="h-8 w-8 text-emerald-500" strokeWidth={3.5} aria-hidden="true" />
                            </div>
                            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
                                ¡Pago recibido!
                            </p>
                            {phase.reference ? (
                                <p className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400">
                                    Ref. {phase.reference}
                                </p>
                            ) : null}
                        </div>
                    )}
                </div>

                <footer className="grid gap-2 border-t border-zinc-200 dark:border-white/10 pt-3 mt-2">
                    <div className="text-[10px] text-zinc-500 dark:text-zinc-400 flex items-center justify-center gap-1.5 text-center leading-tight">
                        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
                        {BOLD_MERCHANT.footer}
                    </div>
                    <div className={`grid grid-cols-1 ${reopened ? "" : "sm:grid-cols-2"} gap-2 w-full`}>
                        {reopened ? null : (
                        <Button
                            variant="outline"
                            onClick={handleCancel}
                            // Cancelar NUNCA se bloquea por qrImageMissing:
                            // el cajero debe poder salir siempre del flujo.
                            disabled={cancelBusy || isApproved}
                            aria-label="Cancelar cobro QR y cambiar método de pago"
                            className="h-12 w-full rounded-xl border-2 border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-950 text-zinc-800 dark:text-zinc-100 hover:border-rose-400 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-500/10 dark:hover:text-rose-300 font-bold text-xs uppercase tracking-wide"
                        >
                            {cancelBusy ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : (
                                <X className="h-4 w-4" aria-hidden="true" />
                            )}
                            Cancelar y cambiar
                        </Button>
                        )}
                        {reopened ? (
                        <Button
                            onClick={handleCancel}
                            aria-label="Cerrar el QR; el cobro sigue en espera"
                            data-testid="bold-qr-reopened-close"
                            className="h-12 w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs uppercase tracking-wide shadow-sm"
                        >
                            <Timer className="h-4 w-4" aria-hidden="true" />
                            CERRAR Y SEGUIR ATENDIENDO
                        </Button>
                        ) : (
                        <Button
                            onClick={handleEnqueueAndClose}
                            // El botón principal del flujo asíncrono. Se
                            // bloquea si falta el QR, si el padre no
                            // proveyó callback (no hay forma de encolar),
                            // o si otra operación ya está en vuelo.
                            disabled={!canEnqueue || enqueueBusy || qrImageMissing}
                            aria-label="Dejar en espera y seguir atendiendo este cobro QR"
                            className="h-12 w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs uppercase tracking-wide shadow-sm"
                        >
                            {enqueueBusy ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : (
                                <Timer className="h-4 w-4" aria-hidden="true" />
                            )}
                            DEJAR EN ESPERA Y SEGUIR ATENDIENDO
                        </Button>
                        )}
                    </div>
                </footer>
            </section>
        </div>
    );
}

interface StatusChipProps {
    readonly tone: "info" | "muted";
    readonly icon: React.ReactNode;
    readonly label: string;
    readonly trailing?: React.ReactNode;
}

function StatusChip({ tone, icon, label, trailing }: StatusChipProps): JSX.Element {
    const toneClasses =
        tone === "info"
            ? "bg-sky-500/10 border-sky-500/30 text-sky-700 dark:text-sky-300"
            : "bg-zinc-500/10 border-zinc-300 dark:border-white/10 text-zinc-600 dark:text-zinc-300";
    return (
        <div
            className={`inline-flex items-center gap-3 rounded-2xl border px-4 py-2 ${toneClasses}`}
            role="status"
        >
            {icon}
            <span className="text-sm font-semibold uppercase tracking-widest">
                {label}
            </span>
            {trailing}
        </div>
    );
}
