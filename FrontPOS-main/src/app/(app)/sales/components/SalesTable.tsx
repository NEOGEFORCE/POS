"use client";

import React, { useRef } from 'react';
import { 
    Chip, Button, Tooltip 
} from "@heroui/react";
import { Eye, Edit3, Calendar, User, DollarSign, Trash2, Landmark, Shuffle, Printer } from 'lucide-react';
import { Sale } from '@/lib/definitions';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAuth } from '@/lib/auth';
import { getPaymentDescription, getPaymentColor } from '@/lib/payment-helpers';
import { formatTime } from '@/lib/utils';
import { PackagePlus } from 'lucide-react';
import { resolvePaymentCorrectionEndpoint } from '@/lib/payment-correction.mjs';

interface SalesTableProps {
    sales: Sale[];
    onOpenPreview: (sale: Sale) => void;
    onOpenEdit: (sale: Sale) => void;
    onOpenAddItems: (sale: Sale) => void;
    onOpenDelete: (sale: Sale) => void;
    /**
     * Reimpresión explícita de la factura desde la fila. El padre
     * (`sales/page.tsx`) usa `printThermalTicketAuto(saleToTicket(sale))`
     * para honrar el `deliveryMode` persistido: con `bridge` imprime
     * directo sin diálogo, con `browser` abre el diálogo del navegador.
     * El handler es async para poder esperar al bridge y mostrar un toast
     * accionable si el bridge rechaza. La firma pública acepta
     * `Promise<void>` o `void` porque React permite callbacks fire-and-forget.
     * La reimpresión también sigue disponible dentro de `SaleDetailModal`
     * (vía ojo → modal) con botones separados bridge/navegador.
     */
    onOpenReprint: (sale: Sale) => void | Promise<void>;
}

const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: 'COP',
        maximumFractionDigits: 0
    }).format(amount);
};

// COMPONENTE MEMOIZADO: Evita re-renders en el historial inmutable
const SaleRow = React.memo(({ 
    sale, 
    style, 
    onPreview, 
    onEdit,
    onAddItems,
    onDelete,
    onReprint,
    isAdmin,
    canCorrectPayment,
}: { 
    sale: Sale, 
    style: React.CSSProperties, 
    onPreview: (s: Sale) => void, 
    onEdit: (s: Sale) => void,
    onAddItems: (s: Sale) => void,
    onDelete: (s: Sale) => void,
    onReprint: (s: Sale) => void | Promise<void>,
    isAdmin: boolean,
    canCorrectPayment: boolean,
}) => {
    return (
        <div
            className="absolute top-0 left-0 w-full flex items-center px-4 border-b border-gray-100 dark:border-white/5 hover:bg-zinc-50 dark:hover:bg-white/5 bg-white dark:bg-transparent border border-zinc-200 dark:border-white/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-black/5 dark:active:bg-white/10 group cursor-default"
            style={style}
        >
            <div className="flex-1 min-h-0 h-full w-[180px]">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-black/5 dark:bg-white/5 text-zinc-900 dark:text-zinc-100 rounded-2xl group-hover:scale-110 transition-transform">
                        <Calendar size={20} strokeWidth={2.5} />
                    </div>
                    <div className="flex flex-col">
                        <span className="text-zinc-900 dark:text-white uppercase tracking-tight font-medium text-xs">{format(new Date(sale.date), "dd MMM yyyy", { locale: es })}</span>
                        <span className="text-[10px] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 font-medium font-mono">{formatTime(sale.date)}</span>
                    </div>
                </div>
            </div>
            <div className="w-[230px]">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-500 dark:text-zinc-400 rounded-2xl">
                        <User size={20} strokeWidth={2.5} />
                    </div>
                    <div className="flex flex-col">
                        <span className="text-zinc-900 dark:text-white uppercase truncate max-w-[150px] font-medium text-xs">{sale.client?.name || 'CONSUMIDOR FINAL'}</span>
                        <span className="text-[10px] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 font-medium font-mono">#{sale.client?.dni || '888888888'}</span>
                    </div>
                </div>
            </div>
            <div className="w-[110px]">
                <Chip 
                    size="sm" 
                    variant="flat"
                    color={getPaymentColor(sale)}
                    className="px-2 py-1 rounded-2xl text-[9px] font-medium tracking-[0.1em] border border-current/20 uppercase tracking-tight shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
                    startContent={
                        <div className="mr-1">
                            {sale.transferAmount > 0 && <Landmark size={10} strokeWidth={3} />}
                            {sale.transferAmount <= 0 && sale.creditAmount > 0 && <User size={10} strokeWidth={3} />}
                            {sale.transferAmount <= 0 && sale.creditAmount <= 0 && sale.cashAmount > 0 && <DollarSign size={10} strokeWidth={3} />}
                        </div>
                    }
                >
                    {getPaymentDescription(sale)}
                </Chip>
            </div>
            <div className="flex-1 text-right pr-8">
                <span className="text-zinc-900 dark:text-white font-medium tracking-tight text-sm tracking-tighter tabular-nums">
                    {formatCurrency(sale.total)}
                </span>
            </div>
            <div className="w-[170px] flex items-center justify-center gap-1">
                <Tooltip content="AUDITAR DETALLE" closeDelay={0} classNames={{ content: "font-medium text-[10px] uppercase tracking-widest bg-zinc-900 dark:bg-[#18181b] text-white border border-zinc-200 dark:border-white/10 rounded-2xl" }}>
                    <Button isIconOnly size="sm" variant="light" className="text-gray-400 hover:text-emerald-600 dark:text-zinc-500 dark:hover:text-gray-600 dark:text-zinc-300 transition-colors p-2" onPress={() => onPreview(sale)}>
                        <Eye size={20} strokeWidth={2.5} />
                    </Button>
                </Tooltip>
                {/* Reimpresión explícita: queda disponible SIEMPRE (empleado y
                    admin), sin esperar a abrir el detalle. El contrato con la
                    caja es el mismo helper térmico. */}
                <Tooltip content="REIMPRIMIR FACTURA" closeDelay={0} classNames={{ content: "font-medium text-[10px] uppercase tracking-widest bg-zinc-900 dark:bg-[#18181b] text-white border border-zinc-200 dark:border-white/10 rounded-2xl" }}>
                    <Button
                        isIconOnly size="sm" variant="light"
                        aria-label={`Reimprimir factura ${sale.id}`}
                        className="text-gray-400 hover:text-sky-500 dark:text-zinc-500 dark:hover:text-sky-400 transition-colors p-2"
                        onPress={() => onReprint(sale)}
                    >
                        <Printer size={20} strokeWidth={2.5} />
                    </Button>
                </Tooltip>
                {isAdmin && (
                    <Tooltip content="AÑADIR/QUITAR PRODUCTOS" closeDelay={0} classNames={{ content: "font-medium text-[10px] uppercase tracking-widest bg-zinc-900 dark:bg-[#18181b] text-white border border-zinc-200 dark:border-white/10 rounded-2xl" }}>
                        <Button isIconOnly size="sm" variant="light" className="text-gray-400 hover:text-indigo-500 dark:text-zinc-500 dark:hover:text-indigo-400 transition-colors p-2" onPress={() => onAddItems(sale)}>
                            <PackagePlus size={20} strokeWidth={2.5} />
                        </Button>
                    </Tooltip>
                )}
                <Tooltip content="CORREGIR REGISTRO" closeDelay={0} classNames={{ content: "font-medium text-[10px] uppercase tracking-widest bg-zinc-900 dark:bg-[#18181b] text-white border border-zinc-200 dark:border-white/10 rounded-2xl" }}>
                    <Button
                        isIconOnly size="sm" variant="light"
                        aria-label={`Corregir medio de pago de la factura ${sale.id}`}
                        isDisabled={!canCorrectPayment}
                        className={`transition-colors p-2 ${canCorrectPayment ? "text-gray-400 hover:text-amber-500 dark:text-zinc-500 dark:hover:text-amber-400" : "text-gray-200 dark:text-zinc-700 cursor-not-allowed"}`}
                        onPress={() => onEdit(sale)}
                    >
                        <Edit3 size={20} strokeWidth={2.5} />
                    </Button>
                </Tooltip>
                {isAdmin && (
                    <Tooltip content="ANULAR VENTA" closeDelay={0} classNames={{ content: "font-medium text-[10px] uppercase tracking-widest bg-rose-600 text-white border border-zinc-200 dark:border-white/10 rounded-2xl" }}>
                        <Button isIconOnly size="sm" variant="light" className="text-gray-400 hover:text-rose-600 dark:text-zinc-500 dark:hover:text-rose-400 transition-colors p-2" onPress={() => onDelete(sale)}>
                            <Trash2 size={20} strokeWidth={2.5} />
                        </Button>
                    </Tooltip>
                )}
            </div>
        </div>
    );
});

SaleRow.displayName = 'SaleRow';

export default function SalesTable({ sales, onOpenPreview, onOpenEdit, onOpenAddItems, onOpenDelete, onOpenReprint }: SalesTableProps) {
    const parentRef = useRef<HTMLDivElement>(null);
    const { user } = useAuth();
    
    const isAdmin = React.useMemo(() => {
        const role = user?.role?.toLowerCase() || "";
        return role === "admin" || role === "superadmin" || role === "administrador";
    }, [user]);

    // Mapa de elegibilidad por venta. El empleado solo puede corregir SU
    // propia venta en su turno activo; el admin puede siempre. Precalcular
    // acá evita que cada fila ejecute la resolución en render.
    const canCorrectBySaleId = React.useMemo(() => {
        const map = new Map<string, boolean>();
        if (!user) return map;
        for (const sale of sales) {
            // shiftOpen=true: la pantalla principal se encarga de ocultar el
            // acceso cuando el turno está cerrado, y el backend valida el
            // actor real. Aquí sólo evitamos pintar la acción cuando ni
            // siquiera hay elegibilidad por rol/dueño/fiado/devoluciones.
            const resolution = resolvePaymentCorrectionEndpoint(sale, user, { shiftOpen: true });
            map.set(sale.id, resolution !== null);
        }
        return map;
    }, [sales, user]);

    const rowVirtualizer = useVirtualizer({
        count: sales.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 60,
        overscan: 10,
    });

    return (
        <div className="flex-1 min-h-0 h-full w-full flex-1 flex flex-col overflow-hidden bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-colors">
            {/* Cabecera Fija */}
            <div className="flex items-center bg-gray-50/80 dark:bg-zinc-950/80 h-10 border-b border-gray-200 dark:border-white/5 px-4 text-center">
                <div className="w-[180px] font-medium uppercase text-[9px] tracking-widest text-gray-500 dark:text-zinc-500 dark:text-zinc-400 text-left">Fecha / Hora</div>
                <div className="w-[230px] font-medium uppercase text-[9px] tracking-widest text-gray-500 dark:text-zinc-500 dark:text-zinc-400 text-left">Cliente / DNI</div>
                <div className="w-[110px] font-medium uppercase text-[9px] tracking-widest text-gray-500 dark:text-zinc-500 dark:text-zinc-400">Metodo</div>
                <div className="flex-1 font-medium uppercase text-[9px] tracking-widest text-gray-500 dark:text-zinc-500 dark:text-zinc-400 text-right pr-8">Total</div>
                <div className="w-[170px] text-center font-medium uppercase text-[9px] tracking-widest text-gray-500 dark:text-zinc-500 dark:text-zinc-400">Acciones</div>
            </div>

            {/* Contenedor Virtual */}
            <div 
                ref={parentRef}
                className="overflow-auto custom-scrollbar min-h-[400px] flex-1 min-h-0 h-full [scrollbar-gutter:stable]"
            >
                <div
                    style={{
                        height: `${rowVirtualizer.getTotalSize()}px`,
                        width: '100%',
                        position: 'relative',
                    }}
                >
                    {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                        const sale = sales[virtualRow.index];
                        return (
                            <SaleRow 
                                key={virtualRow.key}
                                sale={sale}
                                style={{
                                    height: `${virtualRow.size}px`,
                                    transform: `translateY(${virtualRow.start}px)`,
                                }}
                                onPreview={onOpenPreview}
                                onEdit={onOpenEdit}
                                onAddItems={onOpenAddItems}
                                onDelete={onOpenDelete}
                                onReprint={onOpenReprint}
                                isAdmin={isAdmin}
                                canCorrectPayment={canCorrectBySaleId.get(sale.id) ?? false}
                            />
                        );
                    })}
                </div>
                {sales.length === 0 && (
                    <div className="flex flex-col items-center py-20 gap-2 opacity-50">
                        <HistoryIcon size={40} className="text-gray-300 dark:text-zinc-600"/>
                        <p className="text-[10px] font-medium uppercase tracking-widest text-gray-500 dark:text-zinc-500 dark:text-zinc-400">No se encontraron registros de ventas</p>
                    </div>
                )}
            </div>
        </div>
    );
}

const HistoryIcon = ({ size, className }: { size: number, className: string }) => (
    <div className={className}><DollarSign size={size} /></div>
);



