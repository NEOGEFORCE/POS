"use client";

// LinkPaymentToSale.tsx
//
// "Buscar venta" para un pago QR sin asignar (sólo admin). Muestra las
// ventas registradas cerca de la hora del pago cuyo efectivo cubre el
// monto (exactas primero) y permite ENLAZAR: el monto pasa de efectivo a
// Bold en esa venta, sin tocar productos ni inventario. El backend valida
// rol, ventana de 24 h, monto y efectivo disponible.
//
//   GET  /pos/pagos-qr/pagos-sin-asignar/:eventId/ventas
//   POST /pos/pagos-qr/enlazar-venta {event_id, sale_id}

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Link2, Search } from "lucide-react";
import { apiFetch } from "@/lib/api-error";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";

export interface SaleCandidate {
    readonly saleId: number;
    readonly saleDate: string;
    readonly totalAmount: number;
    readonly cashAmount: number;
    readonly transferAmount: number;
    readonly paymentMethod: string;
    readonly employeeName?: string;
    readonly clientName?: string;
    readonly minutesFromPayment: number;
    readonly exactAmount: boolean;
}

interface Props {
    readonly eventId: number;
    readonly amountCop: number;
    /** Se llama tras enlazar con éxito (p.ej. recargar la bandeja). */
    readonly onLinked?: () => void | Promise<void>;
}

/** "2 h 5 min antes del pago" / "15 min después del pago". */
export function describeOffset(minutes: number): string {
    const abs = Math.abs(Math.round(minutes));
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    const span = h > 0 ? (m > 0 ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
    if (abs === 0) return "a la misma hora del pago";
    return minutes < 0 ? `${span} antes del pago` : `${span} después del pago`;
}

function formatSaleTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
}

export default function LinkPaymentToSale({ eventId, amountCop, onLinked }: Props) {
    const { toast } = useToast();
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [items, setItems] = useState<SaleCandidate[] | null>(null);
    const [confirmId, setConfirmId] = useState<number | null>(null);
    const [linkingId, setLinkingId] = useState<number | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await apiFetch<{ items?: SaleCandidate[] }>(`/pos/pagos-qr/pagos-sin-asignar/${eventId}/ventas`, {
                fallbackError: "No se pudieron buscar ventas",
                timeoutMs: 10000,
            });
            setItems(Array.isArray(res?.items) ? res.items : []);
        } catch (err) {
            setItems([]);
            toast({ variant: "destructive", title: "No se pudo buscar", description: err instanceof Error ? err.message : "Intenta de nuevo." });
        } finally {
            setLoading(false);
        }
    }, [eventId, toast]);

    const toggle = useCallback(() => {
        const next = !open;
        setOpen(next);
        setConfirmId(null);
        if (next) void load();
    }, [open, load]);

    const link = useCallback(async (saleId: number) => {
        setLinkingId(saleId);
        try {
            await apiFetch("/pos/pagos-qr/enlazar-venta", {
                method: "POST",
                body: JSON.stringify({ event_id: eventId, sale_id: saleId }),
                fallbackError: "No se pudo enlazar el pago",
                timeoutMs: 15000,
            });
            toast({ title: "PAGO ENLAZADO", description: `$${formatCurrency(amountCop)} quedó como Daviplata en la venta #${saleId}.` });
            setOpen(false);
            setItems(null);
            await onLinked?.();
        } catch (err) {
            toast({ variant: "destructive", title: "No se pudo enlazar", description: err instanceof Error ? err.message : "Intenta de nuevo." });
        } finally {
            setLinkingId(null);
            setConfirmId(null);
        }
    }, [eventId, amountCop, toast, onLinked]);

    return (
        <div className="flex flex-col gap-1.5" data-testid="bold-qr-link-sale">
            <Button
                size="sm"
                variant="outline"
                className="h-8 w-full justify-start gap-2 px-3 text-[11px] font-semibold uppercase"
                onClick={toggle}
                aria-expanded={open}
                data-testid="bold-qr-link-sale-toggle"
            >
                <Search className="h-3.5 w-3.5" aria-hidden="true" />
                {open ? "Ocultar ventas" : "Buscar venta registrada"}
            </Button>
            {open ? (
                loading ? (
                    <p className="flex items-center gap-2 text-[11px] text-zinc-500">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Buscando ventas…
                    </p>
                ) : items && items.length === 0 ? (
                    <p className="text-[11px] italic text-zinc-500 dark:text-zinc-400">
                        Ninguna venta cercana tiene ${formatCurrency(amountCop)} en efectivo para pasar a Bold.
                    </p>
                ) : (
                    <ul className="flex flex-col gap-1.5" aria-label="Ventas sugeridas">
                        {(items ?? []).map((s) => (
                            <li key={s.saleId} className="rounded-lg border border-zinc-200 dark:border-white/10 px-2.5 py-2" data-testid="bold-qr-link-sale-item">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-[12px] font-semibold tabular-nums">
                                        #{s.saleId} · ${formatCurrency(s.totalAmount)}
                                    </span>
                                    {s.exactAmount ? (
                                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-700 dark:text-emerald-300">Monto exacto</span>
                                    ) : null}
                                </div>
                                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                                    {formatSaleTime(s.saleDate)} · {describeOffset(s.minutesFromPayment)}
                                </p>
                                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                                    {s.paymentMethod || "EFECTIVO"} · efectivo ${formatCurrency(s.cashAmount)}
                                    {s.employeeName ? ` · ${s.employeeName}` : ""}
                                    {s.clientName ? ` · ${s.clientName}` : ""}
                                </p>
                                {confirmId === s.saleId ? (
                                    <div className="mt-1.5 flex flex-col gap-1">
                                        <p className="text-[11px] text-amber-700 dark:text-amber-300">
                                            ¿Pasar ${formatCurrency(amountCop)} de efectivo a Bold en la venta #{s.saleId}?
                                        </p>
                                        <div className="flex gap-1.5">
                                            <Button size="sm" className="h-7 flex-1 text-[11px] font-semibold bg-amber-600 hover:bg-amber-500 text-white"
                                                disabled={linkingId !== null} onClick={() => void link(s.saleId)} data-testid="bold-qr-link-sale-confirm">
                                                {linkingId === s.saleId ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : "Sí, enlazar"}
                                            </Button>
                                            <Button size="sm" variant="ghost" className="h-7 flex-1 text-[11px]" disabled={linkingId !== null} onClick={() => setConfirmId(null)}>
                                                Cancelar
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <Button size="sm" variant="secondary" className="mt-1.5 h-7 w-full gap-1.5 text-[11px] font-semibold uppercase"
                                        onClick={() => setConfirmId(s.saleId)} data-testid="bold-qr-link-sale-button">
                                        <Link2 className="h-3.5 w-3.5" aria-hidden="true" /> Enlazar a esta venta
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                )
            ) : null}
        </div>
    );
}
