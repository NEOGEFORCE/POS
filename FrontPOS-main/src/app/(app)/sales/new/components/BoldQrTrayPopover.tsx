// =============================================================================
// BoldQrTrayPopover.tsx
//
// Bandeja global del flujo asíncrono QR Bold/Bre-B (migración 027 + 027b).
//
// Se monta en el header de /sales/new. No es intrusiva: un botón con
// contador que abre un Popover shadcn con DOS secciones:
//
//   1. "Cobros QR en espera" (pendings de la caja activa).
//      - Reabrir el QR (vuelve al modal con el mismo venta_temp_id).
//      - Descartar visual (dismissIntent): el pending desaparece de la
//        UI; la intención sigue viva en el backend y seguirá emitiendo
//        SSE cuando llegue el pago.
//
//   2. "Pagos por asignar" (AMBIGUOUS/UNMATCHED del backend, llegados por
//      SMS reenviado desde Automate). Por cada pago, si hay un pending
//      de la MISMA caja con el MISMO monto, aparece un botón
//      "Asignar a este cobro" que abre un AlertDialog de confirmación y
//      llama POST /pos/pagos-qr/asignar. Nunca se muestra la acción si
//      los montos difieren: el backend respondería 409 QR_AMOUNT_MISMATCH
//      y se evita el toast innecesario.
//
// Reglas de layout (FRONTEND_LAYOUT_RULES.md):
//   - La lista interna usa `flex-1 min-h-0 overflow-auto overscroll-contain`
//     para que el scroll no herede altura del viewport.
//   - El Popover shadcn ya gestiona el positioning y el escape handling.
//
// Reglas duras:
//   - El contador del trigger refleja pendings + pagos por asignar.
//   - El badge ámbar aparece sólo cuando hay pagos por asignar (señal
//     operativa fuerte: hay plata en manos del backend sin dueño).
//   - Al abrir el popover, se refresca la lista de pagos sin asignar
//     para no mostrar datos viejos.
//   - El toast de error muestra copy legible (describeAssignErrorCode).
// =============================================================================

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock, HelpCircle, QrCode, RotateCw, ShieldCheck } from "lucide-react";

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
} from "@/lib/bold-qr-helpers.mjs";
import type { BoldQrPendingItem, BoldQrUnassignedPayment } from "../hooks/useBoldQrTray";

export interface BoldQrTrayPopoverProps {
    readonly pendings: ReadonlyArray<BoldQrPendingItem>;
    readonly unassignedPayments: ReadonlyArray<BoldQrUnassignedPayment>;
    readonly latestError: string | null;
    readonly latestUnassignedError: string | null;
    readonly onReopen: (item: BoldQrPendingItem) => void;
    readonly onDismiss: (ventaTempId: string) => void;
    readonly onReconnect: () => void | Promise<void>;
    readonly onReloadUnassigned: () => void | Promise<void>;
    readonly onAssign: (ventaTempId: string, eventId: number) => Promise<void>;
    /** Sólo admin ve "Confirmar manual" (el backend también lo exige). */
    readonly canConfirmManual?: boolean;
    readonly onConfirmManual?: (ventaTempId: string, nota: string) => Promise<void>;
}

const DEFAULT_MANUAL_NOTE = "Verificado en app Bold, SMS no llegó";

interface AssignPrompt {
    readonly unassigned: BoldQrUnassignedPayment;
    readonly pending: BoldQrPendingItem;
}

function formatReceivedAt(iso: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    try {
        return d.toLocaleTimeString("es-CO", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: true,
        });
    } catch {
        return iso;
    }
}

export default function BoldQrTrayPopover({
    pendings,
    unassignedPayments,
    latestError,
    latestUnassignedError,
    onReopen,
    onDismiss,
    onReconnect,
    onReloadUnassigned,
    onAssign,
    canConfirmManual = false,
    onConfirmManual,
}: BoldQrTrayPopoverProps): JSX.Element {
    const { toast } = useToast();
    const [open, setOpen] = useState(false);
    const [assignPrompt, setAssignPrompt] = useState<AssignPrompt | null>(null);
    const [assignBusy, setAssignBusy] = useState(false);
    const [manualPrompt, setManualPrompt] = useState<BoldQrPendingItem | null>(null);
    const [manualNote, setManualNote] = useState(DEFAULT_MANUAL_NOTE);
    const [manualBusy, setManualBusy] = useState(false);
    const showManual = canConfirmManual && typeof onConfirmManual === "function";

    const handleConfirmManual = useCallback(async () => {
        if (!manualPrompt || manualBusy || !onConfirmManual) return;
        setManualBusy(true);
        try {
            await onConfirmManual(manualPrompt.ventaTempId, manualNote || DEFAULT_MANUAL_NOTE);
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
            void onReconnect();
        } finally {
            setManualBusy(false);
        }
    }, [manualPrompt, manualBusy, manualNote, onConfirmManual, onReconnect, toast]);

    const totalPending = pendings.length;
    const totalUnassigned = unassignedPayments.length;
    const total = totalPending + totalUnassigned;

    const sortedPendings = useMemo(() => {
        return [...pendings].sort((a, b) => {
            const ta = a.queuedAt || a.createdAt || "";
            const tb = b.queuedAt || b.createdAt || "";
            return tb.localeCompare(ta);
        });
    }, [pendings]);

    const sortedUnassigned = useMemo(() => {
        return [...unassignedPayments].sort((a, b) => {
            return (b.receivedAt || "").localeCompare(a.receivedAt || "");
        });
    }, [unassignedPayments]);

    // Al abrir el popover, refrescar pagos sin asignar para no mostrar
    // datos obsoletos del último polling.
    useEffect(() => {
        if (!open) return;
        void onReloadUnassigned();
    }, [open, onReloadUnassigned]);

    const handleConfirmAssign = useCallback(async () => {
        if (!assignPrompt || assignBusy) return;
        setAssignBusy(true);
        try {
            await onAssign(
                assignPrompt.pending.ventaTempId,
                assignPrompt.unassigned.eventId,
            );
            toast({
                variant: "success",
                title: "PAGO ASIGNADO",
                description: `Se asignó $${formatCurrency(assignPrompt.unassigned.amountCop)} al cobro ${assignPrompt.pending.ventaTempId}.`,
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
            // Refrescar listas por si la fuente de verdad cambió.
            void onReloadUnassigned();
            void onReconnect();
        } finally {
            setAssignBusy(false);
        }
    }, [assignPrompt, assignBusy, onAssign, onReconnect, onReloadUnassigned, toast]);

    return (
        <>
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        className="relative h-8 shrink-0 gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300"
                        aria-label={`Bandeja de cobros QR (${totalPending} pendientes, ${totalUnassigned} por asignar)`}
                    >
                        <QrCode className="h-4 w-4" aria-hidden="true" />
                        <span className="hidden xl:inline text-xs font-semibold uppercase tracking-wide">
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
                                data-testid="bold-qr-tray-unassigned-badge"
                                aria-label={`${totalUnassigned} pagos por asignar`}
                            >
                                {totalUnassigned}
                            </Badge>
                        ) : null}
                    </Button>
                </PopoverTrigger>
                <PopoverContent
                    className="flex max-h-[min(75vh,36rem)] w-[min(28rem,calc(100vw-2rem))] flex-col p-0"
                    align="end"
                    sideOffset={8}
                >
                    <Card className="flex min-h-0 flex-1 flex-col border-0 shadow-none">
                        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
                            <CardTitle className="text-sm font-semibold uppercase tracking-wide">
                                Bandeja QR
                            </CardTitle>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => {
                                    void onReconnect();
                                    void onReloadUnassigned();
                                }}
                                aria-label="Refrescar bandeja"
                            >
                                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                            </Button>
                        </CardHeader>
                        <Separator />
                        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
                            <ScrollArea className="flex-1 min-h-0 overflow-auto overscroll-contain">
                                <div className="flex flex-col gap-3 p-0">
                                    {/* -------- Cobros en espera -------- */}
                                    <section aria-label="Cobros QR en espera">
                                        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1.5">
                                            <h4 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                                                Cobros en espera
                                            </h4>
                                            <Badge
                                                variant="secondary"
                                                className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                            >
                                                {totalPending}
                                            </Badge>
                                        </div>
                                        {latestError ? (
                                            <div className="px-4 pb-2 text-[11px] text-rose-500">
                                                {latestError}
                                            </div>
                                        ) : null}
                                        {totalPending === 0 ? (
                                            <div className="flex flex-col items-center justify-center gap-2 px-6 py-4 text-center">
                                                <Clock className="h-5 w-5 text-zinc-400" aria-hidden="true" />
                                                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                                                    No hay cobros QR en espera en esta caja.
                                                </p>
                                            </div>
                                        ) : (
                                            <ul className="divide-y divide-zinc-200 dark:divide-white/5">
                                                {sortedPendings.map((item) => (
                                                    <li
                                                        key={item.ventaTempId}
                                                        className="flex items-start justify-between gap-3 px-4 py-3"
                                                    >
                                                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                                                            <p className="truncate text-base font-semibold tabular-nums">
                                                                ${formatCurrency(item.amountCop)}
                                                            </p>
                                                            <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                                                                {item.cashierName
                                                                    ? `${item.cashierName} · `
                                                                    : ""}
                                                                {item.ventaTempId}
                                                            </p>
                                                        </div>
                                                        <div className="flex shrink-0 flex-col gap-1">
                                                            <Button
                                                                size="sm"
                                                                variant="default"
                                                                className="h-7 px-2 text-[11px] font-semibold uppercase"
                                                                onClick={() => onReopen(item)}
                                                            >
                                                                Reabrir QR
                                                            </Button>
                                                            {showManual ? (
                                                                <Button
                                                                    size="sm"
                                                                    variant="outline"
                                                                    className="h-7 px-2 text-[11px] font-semibold uppercase border-amber-500/40 text-amber-700 dark:text-amber-300"
                                                                    onClick={() => {
                                                                        setManualNote(DEFAULT_MANUAL_NOTE);
                                                                        setManualPrompt(item);
                                                                    }}
                                                                    data-testid="bold-qr-manual-confirm-button"
                                                                >
                                                                    Confirmar manual
                                                                </Button>
                                                            ) : null}
                                                            <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                className="h-7 px-2 text-[11px] text-zinc-500"
                                                                onClick={() => onDismiss(item.ventaTempId)}
                                                            >
                                                                Ocultar
                                                            </Button>
                                                        </div>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </section>

                                    <Separator className="mx-4" />

                                    {/* -------- Pagos por asignar -------- */}
                                    <section
                                        aria-label="Pagos por asignar"
                                        data-testid="bold-qr-unassigned-section"
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
                                        {latestUnassignedError ? (
                                            <div className="px-4 pb-2 text-[11px] text-rose-500">
                                                {latestUnassignedError}
                                            </div>
                                        ) : null}
                                        {totalUnassigned === 0 ? (
                                            <div className="flex flex-col items-center justify-center gap-2 px-6 py-4 text-center">
                                                <HelpCircle className="h-5 w-5 text-zinc-400" aria-hidden="true" />
                                                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                                                    Ningún pago sin asignar en los últimos 30 min.
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
                                                            data-testid="bold-qr-unassigned-item"
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
                                                                    Ningún cobro de esta caja coincide con el monto.
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
                                                                            data-testid="bold-qr-assign-button"
                                                                        >
                                                                            <span className="truncate">
                                                                                Asignar a este cobro
                                                                                {p.cashierName ? ` · ${p.cashierName}` : ""}
                                                                            </span>
                                                                        </Button>
                                                                    ))}
                                                                </div>
                                                            )}
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

            {/* AlertDialog de confirmación de asignación manual. Se cierra
                desde `onOpenChange(false)` o al confirmar. El cajero ve el
                monto, la hora, el resumen y el pending al que va a asignar. */}
            <AlertDialog
                open={!!assignPrompt}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen && !assignBusy) setAssignPrompt(null);
                }}
            >
                <AlertDialogContent
                    data-testid="bold-qr-assign-confirm-dialog"
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
                            Asignar pago al cobro
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
                        <AlertDialogCancel
                            disabled={assignBusy}
                            className="rounded-xl"
                        >
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
                            {assignBusy ? "Asignando…" : "Confirmar asignación"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Confirmación manual (admin): sólo tras verificar el pago
                en la app Bold. Queda auditada con el DNI de la sesión. */}
            <AlertDialog
                open={!!manualPrompt}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen && !manualBusy) setManualPrompt(null);
                }}
            >
                <AlertDialogContent
                    data-testid="bold-qr-manual-confirm-dialog"
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
                                <p className="text-xs leading-snug max-w-sm">
                                    Hazlo sólo si ya viste este pago en la app Bold. La venta se facturará y quedará registrado tu usuario.
                                </p>
                                <p className="text-[11px] leading-snug max-w-sm text-amber-700 dark:text-amber-400">
                                    Si después llega el SMS, aparecerá en &quot;Pagos por asignar&quot;: no lo asignes a otra venta.
                                </p>
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="bold-qr-manual-note" className="text-xs">
                            Nota
                        </Label>
                        <Input
                            id="bold-qr-manual-note"
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
        </>
    );
}
