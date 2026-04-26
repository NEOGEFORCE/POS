"use client";

import React, { useRef } from 'react';
import { 
    Chip, Button, Tooltip 
} from "@heroui/react";
import { Eye, Edit3, Calendar, User, DollarSign } from 'lucide-react';
import { Sale } from '@/lib/definitions';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { useVirtualizer } from '@tanstack/react-virtual';

interface SalesTableProps {
    sales: Sale[];
    onOpenPreview: (sale: Sale) => void;
    onOpenEdit: (sale: Sale) => void;
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
    onEdit 
}: { 
    sale: Sale, 
    style: React.CSSProperties, 
    onPreview: (s: Sale) => void, 
    onEdit: (s: Sale) => void 
}) => {
    return (
        <div
            className="absolute top-0 left-0 w-full flex items-center px-4 border-b border-gray-100 dark:border-white/5 hover:bg-emerald-500/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-emerald-500/10 group cursor-default"
            style={style}
        >
            <div className="w-[200px]">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-emerald-500/10 text-emerald-500 rounded-lg group-hover:scale-110 transition-transform">
                        <Calendar size={20} strokeWidth={2.5} />
                    </div>
                    <div className="flex flex-col">
                        <span className="text-zinc-900 dark:text-white uppercase italic font-black text-xs">{format(new Date(sale.date), "dd MMM yyyy", { locale: es })}</span>
                        <span className="text-[10px] text-gray-400 dark:text-zinc-500 font-medium font-mono">{format(new Date(sale.date), "HH:mm:ss")}</span>
                    </div>
                </div>
            </div>
            <div className="w-[250px]">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-gray-100 dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 rounded-lg">
                        <User size={20} strokeWidth={2.5} />
                    </div>
                    <div className="flex flex-col">
                        <span className="text-zinc-900 dark:text-white uppercase truncate max-w-[150px] font-black text-xs">{sale.client?.name || 'CONSUMIDOR FINAL'}</span>
                        <span className="text-[10px] text-gray-400 dark:text-zinc-500 font-medium font-mono">#{sale.client?.dni || '888888888'}</span>
                    </div>
                </div>
            </div>
            <div className="w-[120px]">
                <Chip 
                    size="sm" 
                    variant="flat"
                    className={`px-2 py-1 rounded-md text-[10px] font-bold tracking-wide border ${
                        sale.paymentMethod === 'EFECTIVO' 
                            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20' 
                            : sale.paymentMethod === 'MIXTO' 
                                ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/10 dark:text-violet-400 border-violet-200 dark:border-violet-500/20'
                                : 'bg-rose-100 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400 border-rose-200 dark:border-rose-500/20'
                    }`}
                >
                    {sale.paymentMethod}
                </Chip>
            </div>
            <div className="flex-1 text-right pr-12">
                <span className="text-zinc-900 dark:text-white font-black italic text-sm tracking-tighter tabular-nums">
                    {formatCurrency(sale.total)}
                </span>
            </div>
            <div className="w-[100px] flex items-center justify-center gap-2">
                <Tooltip content="AUDITAR DETALLE" closeDelay={0} classNames={{ content: "font-black text-[10px] uppercase tracking-widest bg-zinc-900 text-white border border-white/10 rounded-lg" }}>
                    <Button isIconOnly size="sm" variant="light" className="text-gray-400 hover:text-emerald-600 dark:text-zinc-500 dark:hover:text-emerald-400 transition-colors p-2" onPress={() => onPreview(sale)}>
                        <Eye size={20} strokeWidth={2.5} />
                    </Button>
                </Tooltip>
                <Tooltip content="CORREGIR REGISTRO" closeDelay={0} classNames={{ content: "font-black text-[10px] uppercase tracking-widest bg-zinc-900 text-white border border-white/10 rounded-lg" }}>
                    <Button isIconOnly size="sm" variant="light" className="text-gray-400 hover:text-amber-500 dark:text-zinc-500 dark:hover:text-amber-400 transition-colors p-2" onPress={() => onEdit(sale)}>
                        <Edit3 size={20} strokeWidth={2.5} />
                    </Button>
                </Tooltip>
            </div>
        </div>
    );
});

SaleRow.displayName = 'SaleRow';

export default function SalesTable({ sales, onOpenPreview, onOpenEdit }: SalesTableProps) {
    const parentRef = useRef<HTMLDivElement>(null);

    const rowVirtualizer = useVirtualizer({
        count: sales.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 60,
        overscan: 10,
    });

    return (
        <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/5 rounded-2xl shadow-sm transition-colors">
            {/* Cabecera Fija */}
            <div className="flex items-center bg-gray-50/80 dark:bg-zinc-950/80 backdrop-blur-md h-10 border-b border-gray-200 dark:border-white/5 px-4">
                <div className="w-[200px] font-black uppercase text-[9px] tracking-widest text-gray-400 dark:text-zinc-500">Fecha / Hora</div>
                <div className="w-[250px] font-black uppercase text-[9px] tracking-widest text-gray-400 dark:text-zinc-500">Cliente / DNI</div>
                <div className="w-[120px] font-black uppercase text-[9px] tracking-widest text-gray-400 dark:text-zinc-500">Método</div>
                <div className="flex-1 font-black uppercase text-[9px] tracking-widest text-gray-400 dark:text-zinc-500 text-right pr-12">Total</div>
                <div className="w-[100px] text-center font-black uppercase text-[9px] tracking-widest text-gray-400 dark:text-zinc-500">Acciones</div>
            </div>

            {/* Contenedor Virtual */}
            <div 
                ref={parentRef}
                className="flex-1 overflow-auto custom-scrollbar min-h-[400px] [scrollbar-gutter:stable]"
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
                            />
                        );
                    })}
                </div>
                {sales.length === 0 && (
                    <div className="flex flex-col items-center py-20 gap-2 opacity-50">
                        <HistoryIcon size={40} className="text-gray-300 dark:text-zinc-600"/>
                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 dark:text-zinc-500">No se encontraron registros de ventas</p>
                    </div>
                )}
            </div>
        </div>
    );
}

const HistoryIcon = ({ size, className }: { size: number, className: string }) => (
    <div className={className}><DollarSign size={size} /></div>
);
