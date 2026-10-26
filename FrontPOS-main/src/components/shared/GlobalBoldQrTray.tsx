// =============================================================================
// GlobalBoldQrTray.tsx
//
// Indicador global de "QR en espera" para admin / superadmin. Vive en el
// header de (app) y se muestra en todas las pantallas EXCEPTO /sales/new
// (ahí ya corre la bandeja de la caja local).
//
// Reglas duras:
//   - Monta sólo si `enabled=true` desde el padre (admin + ruta válida).
//     El padre decide los dos predicados; aquí no re-chequeamos para
//     evitar duplicación.
//   - El hook `useBoldQrGlobalTray` consume `?scope=all` y SSE del
//     mismo endpoint sin filtro de caja.
//   - Además de "Pendientes en todas las cajas", muestra una sección
//     "Pagos por asignar" (migración 027c): el admin puede enlazar un
//     pago QR huérfano con cualquier intención pendiente del mismo
//     monto, reusando POST /pos/pagos-qr/asignar. Esto cubre el flujo
//     "la dueña corrige una venta y asigna el pago viejo que vino por
//     SMS tarde".
//   - "Confirmar manual" es admin-only; el backend lo exige y el padre
//     ya pasa el flag correcto.
//   - Sin sonido ni voz: la bandeja global es informativa, no operativa.
//     Las notificaciones sonoras siguen reservadas a la caja activa.
//
// FRONTEND_LAYOUT_RULES.md:
//   - Popover usa Radix shadcn que portaliza al body, así no necesita
//     participar de la cadena flex-1 min-h-0 del layout.
//   - La lista interna usa `max-h-[60vh] overflow-auto overscroll-contain`.
//
// Accesibilidad:
//   - El botón tiene `aria-label` con el conteo.
//   - Los diálogos de confirmación manual tienen título + descripción.
//   - Contraste suficiente en claro y oscuro (pares `dark:`).
// =============================================================================

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock, HelpCircle, QrCode, RotateCw, ShieldCheck, Store, User as UserIcon } from "lucide-react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import LinkPaymentToSale from "@/components/shared/LinkPaymentToSale";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";
import {
    canAssignToPending,
    describeAssignErrorCode,
    extractAssignErrorCode,
    type BoldQrUnassignedPayment,
} from "@/lib/bold-qr-helpers.mjs";
import {
    useBoldQrGlobalTray,
    type BoldQrGlobalPendingItem,
} from "@/hooks/useBoldQrGlobalTray";

export interface GlobalBoldQrTrayProps {
    /**
     * Padre decide si montamos el hook (ruta ≠ /sales/new + admin).
     * Si es `false`, el componente devuelve `null` sin tocar red.
     */
    readonly enabled: boolean;
    /** Admin-only para habilitar el botón "Confirmar manual". */
    readonly canConfirmManual: boolean;
}

const DEFAULT_MANUAL_NOTE = "Verificado en app Daviplata, SMS no llegó";

function formatRelativeAgo(iso: string, nowMs: number = Date.now()): string {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const diff = Math.max(0, nowMs - t);
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return "hace instantes";
    if (minutes < 60) return `hace ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    if (hours < 24) return remMinutes === 0 ? `hace ${hours} h` : `hace ${hours} h ${remMinutes} min`;
    const days = Math.floor(hours / 24);
    return `hace ${days} d`;
}

function formatReceivedAt(iso: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    try {
        return d.toLocaleTimeString("es-CO", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
        });
    } catch {
        return iso;
    }
}

interface AssignPrompt {
    readonly unassigned: BoldQrUnassignedPayment;
    readonly pending: BoldQrGlobalPendingItem;
}

export default function GlobalBoldQrTray({
    enabled,
    canConfirmManual,
}: GlobalBoldQrTrayProps): JSX.Element | null {
    const { toast } = useToast();
    // El hook interno hace su propio `if (!enabled) return` para no
    // tocar red. Igual lo invocamos siempre (regla de hooks).
    const tray = useBoldQrGlobalTray(enabled);
    const [open, setOpen] = useState(false);
    const [manualPrompt, setManualPrompt] = useState<BoldQrGlobalPendingItem | null>(null);
    const [manualNote, setManualNote] = useState(DEFAULT_MANUAL_NOTE);
    const [manualBusy, setManualBusy] = useState(false);
    const [assignPrompt, setAssignPrompt] = useState<AssignPrompt | null>(null);
    const [assignBusy, setAssignBusy] = useState(false);
    const [editConfirmId, setEditConfirmId] = useState<string | null>(null);

    const sortedPendings = useMemo(() => {
        return [...tray.pendings].sort((a, b) => {
            const ta = a.queuedAt || a.createdAt || "";
            const tb = b.queuedAt || b.createdAt || "";
            return tb.localeCompare(ta);
        });
    }, [tray.pendings]);

    const sortedUnassigned = useMemo(() => {
        return [...tray.unassignedPayments].sort((a, b) => {
            return (b.receivedAt || "").localeCompare(a.receivedAt || "");
        });
    }, [tray.unassignedPayments]);

    const totalPending = tray.pendings.length;
    const totalUnassigned = tray.unassignedPayments.length;
    const total = totalPending + totalUnassigned;

    // Al abrir el popover, refrescar pagos sin asignar para no mostrar
    // datos obsoletos del último polling.
    useEffect(() => {
        if (!open) return;
        void tray.reloadUnassigned();
    }, [open, tray]);

    const handleConfirmManual = useCallback(async () => {
        if (!manualPrompt || manualBusy) return;
        setManualBusy(true);
        try {
            await tray.confirmManualIntent(
                manualPrompt.ventaTempId,
                manualNote || DEFAULT_MANUAL_NOTE,
            );
            toast({
                variant: "success",
                title: "PAGO CONFIRMADO",
                description: `Se confirmó $${formatCurrency(manualPrompt.amountCop)}. La venta se factura en unos segundos.`,
            });
            setManualPrompt(null);
        } catch (err) {
            toast({
                variant: "destructive",
                title: "NO SE PUDO CONFIRMAR",
                description: err instanceof Error ? err.message : "Intenta nuevamente.",
            });
            void tray.reconnect();
        } finally {
            setManualBusy(false);
        }
    }, [manualPrompt, manualBusy, manualNote, tray, toast]);

    const handleConfirmAssign = useCallback(async () => {
        if (!assignPrompt || assignBusy) return;
        setAssignBusy(true);
        try {
            await tray.assignPaymentToIntent(
                assignPrompt.pending.ventaTempId,
                assignPrompt.unassigned.eventId,
            );
            toast({
                variant: "success",
                title: "PAGO ASIGNADO",
                description: `Se enlazó $${formatCurrency(assignPrompt.unassigned.amountCop)} con el cobro ${assignPrompt.pending.ventaTempId}.`,
            });
            setAssignPrompt(null);
        } catch (err) {
            const code = extractAssignErrorCode(err);
            const description = code
                ? describeAssignErrorCode(code)
                : err instanceof Error
                    ? err.message
                    : "No se pudo asignar el pago. Intenta nuevamente.";
            toast({
                variant: "destructive",
                title: "NO SE PUDO ASIGNAR",
                description,
            });
            void tray.reloadUnassigned();
            void tray.reconnect();
        } finally {
            setAssignBusy(false);
        }
    }, [assignPrompt, assignBusy, tray, toast]);

    if (!enabled) return null;
    // No mostrar nada si no hay actividad en ninguna lista: el hook sigue
    // escuchando SSE y aparecerá en cuanto haya actividad.
    if (total === 0) return null;

    return (
        <>
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        className="relative h-8 shrink-0 gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300"
                        aria-label={`Bandeja global de cobros QR (${total} pendientes)`}
                        data-testid="bold-qr-global-tray-trigger"
                    >
                        <QrCode className="h-4 w-4" aria-hidden="true" />
                        <span className="hidden md:inline text-[11px] font-semibold uppercase tracking-wider">
                            QR en espera
                        </span>
                        <Badge
                            variant="secondary"
                            className="min-w-[1.25rem] px-1.5 bg-emerald-600 text-white"
                        >
                            {total}
                        </Badge>
                        {totalUnassigned > 0 ? (
                            <Badge
                                variant="secondary"
                                className="min-w-[1.25rem] px-1.5 bg-amber-500 text-white"
                                data-testid="bold-qr-global-unassigned-badge"
                                aria-label={`${totalUnassigned} pagos por asignar`}
                            >
                                {totalUnassigned}
                            </Badge>
                        ) : null}
                    </Button>
                </PopoverTrigger>
                <PopoverContent
                    className="flex max-h-[min(70vh,36rem)] w-[min(28rem,calc(100vw-2rem))] flex-col p-0"
                    align="end"
                    sideOffset={8}
                >
                    <Card className="flex min-h-0 flex-1 flex-col border-0 shadow-none bg-white dark:bg-zinc-950">
                        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
                            <CardTitle className="text-sm font-semibold uppercase tracking-wide text-zinc-900 dark:text-zinc-50">
                                QR en espera
                            </CardTitle>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => {
                                    void tray.reconnect();
                                    void tray.reloadUnassigned();
                                }}
                                aria-label="Refrescar bandeja global"
                            >
                                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                            </Button>
                        </CardHeader>
                        <Separator />
                        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
                            <ScrollArea className="flex-1 min-h-0 overflow-auto overscroll-contain">
                                <div className="flex flex-col gap-2 p-0">
                                    {/* -------- Pendientes -------- */}
                                    <section aria-label="Cobros QR en espera a nivel global">
                                        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1.5">
                                            <h4 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                                                Pendientes en todas las cajas
                                            </h4>
                                            <Badge
                                                variant="secondary"
                                                className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                            >
                                                {totalPending}
                                            </Badge>
                                        </div>
                                        {tray.latestError ? (
                                            <div className="px-4 pb-2 text-[11px] text-rose-500" role="alert">
                                                {tray.latestError}
                                            </div>
                                        ) : null}
                                        {totalPending === 0 ? (
                                            <div className="flex flex-col items-center justify-center gap-2 px-6 py-4 text-center">
                                                <Clock className="h-5 w-5 text-zinc-400" aria-hidden="true" />
                                                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                                                    Ningún cobro QR en espera.
                                                </p>
                                            </div>
                                        ) : (
                                            <ul
                                                className="divide-y divide-zinc-200 dark:divide-white/5 pb-2"
                                                data-testid="bold-qr-global-tray-list"
                                            >
                                                {sortedPendings.map((item) => (
                                                    <li
                                                        key={item.ventaTempId}
                                                        className="flex items-start justify-between gap-3 px-4 py-3"
                                                    >
                                                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                                                            <p className="truncate text-base font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
                                                                ${formatCurrency(item.amountCop)}
                                                            </p>
                                                            <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                                                                {item.cajaId ? (
                                                                    <span className="inline-flex items-center gap-1">
                                                                        <Store className="h-3 w-3" aria-hidden="true" />
                                                                        <span className="font-mono">{item.cajaId}</span>
                                                                    </span>
                                                                ) : null}
                                                                {item.cashierName ? (
                                                                    <span className="inline-flex items-center gap-1">
                                                                        <UserIcon className="h-3 w-3" aria-hidden="true" />
                                                                        <span className="truncate max-w-[10rem]">{item.cashierName}</span>
                                                                    </span>
                                                                ) : null}
                                                            </p>
                                                            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 inline-flex items-center gap-1">
                                                                <Clock className="h-3 w-3" aria-hidden="true" />
                                                                {formatRelativeAgo(item.queuedAt || item.createdAt)}
                                                            </p>
                                                        </div>
                                                        <div className="flex shrink-0 flex-col gap-1">
                                                            {/* Editar: lleva a /sales/new, cancela el QR y
                                                                reabre la venta en una factura. */}
                                                            {editConfirmId === item.ventaTempId ? (
                                                                <div className="flex flex-col gap-1" data-testid="bold-qr-global-edit-confirm">
                                                                    <p className="max-w-[9.5rem] text-[10px] leading-tight text-amber-700 dark:text-amber-300">
                                                                        Se cancela el QR y la venta se abre en Nueva venta.
                                                                    </p>
                                                                    <Button
                                                                        size="sm"
                                                                        className="h-7 px-2 text-[11px] font-semibold uppercase bg-amber-600 hover:bg-amber-500 text-white"
                                                                        onClick={() => {
                                                                            setEditConfirmId(null);
                                                                            setOpen(false);
                                                                            window.location.href = `/sales/new?editarQr=${encodeURIComponent(item.ventaTempId)}`;
                                                                        }}
                                                                        data-testid="bold-qr-global-edit-confirm-button"
                                                                    >
                                                                        Sí, editar
                                                                    </Button>
                                                                    <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setEditConfirmId(null)}>
                                                                        No
                                                                    </Button>
                                                                </div>
                                                            ) : (
                                                                <Button
                                                                    size="sm"
                                                                    variant="outline"
                                                                    className="h-7 px-2 text-[11px] font-semibold uppercase"
                                                                    onClick={() => setEditConfirmId(item.ventaTempId)}
                                                                    data-testid="bold-qr-global-edit-button"
                                                                >
                                                                    Editar
                                                                </Button>
                                                            )}
                                                            {canConfirmManual ? (
                                                                <Button
                                                                    size="sm"
                                                                    variant="outline"
                                                                    className="h-7 px-2 text-[11px] font-semibold uppercase border-amber-500/40 text-amber-700 dark:text-amber-300"
                                                                    onClick={() => {
                                                                        setManualNote(DEFAULT_MANUAL_NOTE);
                                                                        setManualPrompt(item);
                                                                    }}
                                                                    data-testid="bold-qr-global-manual-confirm-button"
                                                                >
                                                                    Confirmar manual
                                                                </Button>
                                                            ) : null}
                                                        </div>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </section>

                                    <Separator className="mx-4" />

                                    {/* -------- Pagos por asignar -------- */}
                                    <section
                                        aria-label="Pagos por asignar en todas las cajas"
                                        data-testid="bold-qr-global-unassigned-section"
                                    >
                                        <div className="flex items-center justify-between gap-2 px-4 pt-1 pb-1.5">
                                            <h4 className="text-[11px] font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
                                                Pagos por asignar
                                            </h4>
                                            <Badge
                                                variant="secondary"
                                                className={
                                                    totalUnassigned > 0
                                                        ? "bg-amber-500 text-white"
                                                        : "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400"
                                                }
                                            >
                                                {totalUnassigned}
                                            </Badge>
                                        </div>
                                        {tray.latestUnassignedError ? (
                                            <div className="px-4 pb-2 text-[11px] text-rose-500">
                                                {tray.latestUnassignedError}
                                            </div>
                                        ) : null}
                                        {totalUnassigned === 0 ? (
                                            <div className="flex flex-col items-center justify-center gap-2 px-6 py-4 text-center">
                                                <HelpCircle className="h-5 w-5 text-zinc-400" aria-hidden="true" />
                                                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                                                    Ningún pago sin asignar en las últimas 24 h.
                                                </p>
                                            </div>
                                        ) : (
                                            <ul className="divide-y divide-zinc-200 dark:divide-white/5 pb-2">
                                                {sortedUnassigned.map((item) => {
                                                    const matches = sortedPendings.filter((p) =>
                                                        canAssignToPending(item, p),
                                                    );
                                                    return (
                                                        <li
                                                            key={item.eventId}
                                                            className="flex flex-col gap-2 px-4 py-3"
                                                            data-testid="bold-qr-global-unassigned-item"
                                                        >
                                                            <div className="flex items-start justify-between gap-3">
                                                                <div className="flex min-w-0 flex-1 flex-col gap-1">
                                                                    <p className="truncate text-base font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                                                                        ${formatCurrency(item.amountCop)}
                                                                    </p>
                                                                    <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                                                                        {formatReceivedAt(item.receivedAt)}
                                                                        {" · "}
                                                                        <span className="font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                                                                            {item.status}
                                                                        </span>
                                                                    </p>
                                                                    <p className="text-[11px] text-zinc-400 dark:text-zinc-500 inline-flex items-center gap-1">
                                                                        <Clock className="h-3 w-3" aria-hidden="true" />
                                                                        {formatRelativeAgo(item.receivedAt)}
                                                                    </p>
                                                                    {item.resumen ? (
                                                                        <p className="text-[11px] text-zinc-600 dark:text-zinc-300 leading-tight">
                                                                            {item.resumen}
                                                                        </p>
                                                                    ) : null}
                                                                </div>
                                                                <AlertTriangle
                                                                    className="h-4 w-4 shrink-0 text-amber-500"
                                                                    aria-hidden="true"
                                                                />
                                                            </div>
                                                            {matches.length === 0 ? (
                                                                <p className="text-[11px] italic text-zinc-500 dark:text-zinc-400">
                                                                    Ninguna caja tiene un cobro pendiente con este monto.
                                                                </p>
                                                            ) : (
                                                                <div className="flex flex-col gap-1.5">
                                                                    {matches.map((p) => (
                                                                        <Button
                                                                            key={p.ventaTempId}
                                                                            size="sm"
                                                                            variant="default"
                                                                            className="h-8 w-full justify-start gap-2 px-3 text-[11px] font-semibold uppercase bg-amber-600 hover:bg-amber-500 text-white"
                                                                            onClick={() =>
                                                                                setAssignPrompt({
                                                                                    unassigned: item,
                                                                                    pending: p,
                                                                                })
                                                                            }
                                                                            data-testid="bold-qr-global-assign-button"
                                                                        >
                                                                            <span className="truncate text-left">
                                                                                Enlazar con {p.cashierName ? p.cashierName : p.cajaId || p.ventaTempId}
                                                                            </span>
                                                                        </Button>
                                                                    ))}
                                                                </div>
                                                            )}
                                                            {canConfirmManual ? (
                                                                <LinkPaymentToSale
                                                                    eventId={item.eventId}
                                                                    amountCop={item.amountCop}
                                                                    onLinked={tray.reloadUnassigned}
                                                                />
                                                            ) : null}
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                        )}
                                    </section>
                                </div>
                            </ScrollArea>
                        </CardContent>
                    </Card>
                </PopoverContent>
            </Popover>

            {/* Confirmación manual (admin): sólo tras verificar el pago
                en la app Bold. Queda auditada con el DNI de la sesión. */}
            <AlertDialog
                open={!!manualPrompt}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen && !manualBusy) setManualPrompt(null);
                }}
            >
                <AlertDialogContent
                    data-testid="bold-qr-global-manual-confirm-dialog"
                    className="border-2 border-amber-500/40 bg-white dark:bg-zinc-950 rounded-2xl"
                >
                    <AlertDialogHeader className="items-center text-center space-y-2">
                        <div
                            aria-hidden
                            className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/20 ring-4 ring-amber-500/30"
                        >
                            <ShieldCheck className="h-7 w-7 text-amber-500" strokeWidth={2.5} />
                        </div>
                        <AlertDialogTitle className="text-xl md:text-2xl font-bold uppercase tracking-tight text-amber-700 dark:text-amber-300">
                            Confirmar pago manual
                        </AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div className="flex flex-col items-center gap-2 text-zinc-800 dark:text-zinc-200">
                                <p className="text-3xl md:text-4xl font-black tabular-nums tracking-tight">
                                    ${manualPrompt ? formatCurrency(manualPrompt.amountCop) : ""}
                                </p>
                                {manualPrompt?.cajaId ? (
                                    <p className="text-[11px] uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                                        Caja {manualPrompt.cajaId}
                                        {manualPrompt.cashierName ? ` · ${manualPrompt.cashierName}` : ""}
                                    </p>
                                ) : null}
                                <p className="text-xs leading-snug max-w-sm">
                                    Hazlo sólo si ya viste este pago en la app Bold. La venta se facturará y quedará registrado tu usuario.
                                </p>
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="bold-qr-global-manual-note" className="text-xs">
                            Nota
                        </Label>
                        <Input
                            id="bold-qr-global-manual-note"
                            value={manualNote}
                            maxLength={200}
                            onChange={(e) => setManualNote(e.target.value)}
                            disabled={manualBusy}
                        />
                    </div>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={manualBusy} className="rounded-xl">
                            Cancelar
                        </AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => {
                                e.preventDefault();
                                void handleConfirmManual();
                            }}
                            disabled={manualBusy}
                            className="bg-amber-600 hover:bg-amber-500 text-white font-bold uppercase tracking-wide rounded-xl"
                        >
                            {manualBusy ? "Confirmando…" : "Confirmar pago"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Enlazar un pago huérfano con un pending (admin): el backend
                exige monto exacto + rol válido. El cajero dueño del pending
                se muestra en el diálogo para evitar que el admin enlace a
                la venta equivocada por accidente. */}
            <AlertDialog
                open={!!assignPrompt}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen && !assignBusy) setAssignPrompt(null);
                }}
            >
                <AlertDialogContent
                    data-testid="bold-qr-global-assign-confirm-dialog"
                    className="border-2 border-amber-500/40 bg-white dark:bg-zinc-950 rounded-2xl"
                >
                    <AlertDialogHeader className="items-center text-center space-y-2">
                        <div
                            aria-hidden
                            className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/20 ring-4 ring-amber-500/30"
                        >
                            <AlertTriangle className="h-7 w-7 text-amber-500" strokeWidth={2.5} />
                        </div>
                        <AlertDialogTitle className="text-xl md:text-2xl font-bold uppercase tracking-tight text-amber-700 dark:text-amber-300">
                            Enlazar pago al cobro
                        </AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div className="flex flex-col items-center gap-1 text-zinc-800 dark:text-zinc-200">
                                <p className="text-3xl md:text-4xl font-black tabular-nums tracking-tight">
                                    ${assignPrompt ? formatCurrency(assignPrompt.unassigned.amountCop) : ""}
                                </p>
                                <p className="text-[11px] uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                                    {assignPrompt
                                        ? `${assignPrompt.unassigned.status} · ${formatReceivedAt(assignPrompt.unassigned.receivedAt)}`
                                        : ""}
                                </p>
                                {assignPrompt?.unassigned.resumen ? (
                                    <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-tight max-w-sm">
                                        {assignPrompt.unassigned.resumen}
                                    </p>
                                ) : null}
                                <div className="mt-2 flex flex-col gap-0.5 text-xs text-zinc-700 dark:text-zinc-300">
                                    <span className="font-semibold uppercase tracking-wider">
                                        Cobro destino
                                    </span>
                                    <span className="font-mono text-[11px]">
                                        {assignPrompt?.pending.ventaTempId ?? ""}
                                    </span>
                                    {assignPrompt?.pending.cajaId ? (
                                        <span className="text-[11px]">
                                            Caja: <span className="font-mono">{assignPrompt.pending.cajaId}</span>
                                        </span>
                                    ) : null}
                                    {assignPrompt?.pending.cashierName ? (
                                        <span className="text-[11px]">
                                            Cajero: {assignPrompt.pending.cashierName}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={assignBusy} className="rounded-xl">
                            Cancelar
                        </AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => {
                                e.preventDefault();
                                void handleConfirmAssign();
                            }}
                            disabled={assignBusy}
                            className="bg-amber-600 hover:bg-amber-500 text-white font-bold uppercase tracking-wide rounded-xl"
                        >
                            {assignBusy ? "Enlazando…" : "Confirmar enlace"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
