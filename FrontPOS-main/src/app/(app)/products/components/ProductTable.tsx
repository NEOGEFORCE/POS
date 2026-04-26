"use client";

import React, { memo, useEffect, useState, useCallback } from 'react';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Button, Chip
} from "@heroui/react";
import { 
  Package, Edit, Trash2, ChevronLeft, ChevronRight, Info, Plus, Minus
} from 'lucide-react';
import { Product } from '@/lib/definitions';
import { useAuth } from '@/lib/auth';
import { getCriticalThreshold, formatStock } from '@/lib/utils';

interface TableProps {
  products: Product[];
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalFiltered: number;
  onEdit: (product: Product) => void;
  onDelete: (barcode: string) => void;
  onQuickUpdate: (barcode: string, amount: number) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  formatCOP: (val: number | string) => string;
}

const COLUMNS = [
    { name: "PRODUCTO / IDENTIDAD", uid: "identity", align: "start" },
    { name: "STOCK", uid: "stock", align: "center" },
    { name: "PRECIO", uid: "price", align: "start" },
    { name: "MARGEN", uid: "margin", align: "center" },
    { name: "GESTIÓN", uid: "actions", align: "end" },
];

const ProductTable = memo(({
  products,
  currentPage,
  totalPages,
  pageSize,
  totalFiltered,
  onEdit,
  onDelete,
  onQuickUpdate,
  onPageChange,
  onPageSizeChange,
  formatCOP
}: TableProps) => {
    const { user } = useAuth();
    const [isMobile, setIsMobile] = useState(false);
    
    const role = user?.role?.toLowerCase() || user?.Role?.toLowerCase() || "";
    const isAdmin = role === "admin" || role === "administrador" || role === "superadmin";

    useEffect(() => {
        const mql = window.matchMedia("(max-width: 768px)");
        const onChange = () => setIsMobile(mql.matches);
        mql.addEventListener("change", onChange);
        setIsMobile(mql.matches);
        return () => mql.removeEventListener("change", onChange);
    }, []);

    const renderCell = useCallback((product: Product, columnKey: React.Key) => {
        // Semáforo dinámico por tramos de stock mínimo
        const minStock = product.minStock || 5;
        const threshold = getCriticalThreshold(minStock);
        const quantity = product.quantity;
        
        // Estados: CRÍTICO (rojo) | ADVERTENCIA (ámbar) | ÓPTIMO (verde)
        const isCritical = !product.isWeighted && quantity <= threshold;
        const isWarning = !product.isWeighted && quantity <= minStock && quantity > threshold;
        // const isOptimal = !isCritical && !isWarning; // implícito por estilos default
        
        // Determinar clase CSS según estado
        const stockStatusClass = isCritical
            ? 'bg-rose-500/10 border-rose-500/40 text-rose-500'
            : isWarning
                ? 'bg-amber-500/10 border-amber-500/40 text-amber-500'
                : 'bg-emerald-500/5 border-emerald-500/20 text-emerald-500';
        
        switch (String(columnKey)) {
            case "identity":
                return (
                    <div className="flex items-center gap-3 py-1">
                        <div className="h-9 w-9 rounded-xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center border border-emerald-500/20 shadow-sm shrink-0 overflow-hidden">
                            {product.imageUrl ? (
                                <img src={product.imageUrl} className="h-full w-full object-cover" alt="" />
                            ) : (
                                <Package size={18} />
                            )}
                        </div>
                        <div className="flex flex-col min-w-0">
                            <span className="text-[10px] font-black text-gray-900 dark:text-white uppercase italic leading-tight truncate max-w-[180px]">
                                {product.productName}
                            </span>
                            <span className="text-[8px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-tight">BARCODE: {product.barcode}</span>
                        </div>
                    </div>
                );
            case "stock":
                return (
                    <div className="flex items-center justify-center w-full min-w-[9rem]">
                        <div
                            className={`inline-flex items-center gap-0.5 sm:gap-1 rounded-xl border transition-all ${stockStatusClass}`}
                        >
                            {isAdmin && (
                                <Button
                                    isIconOnly
                                    size="sm"
                                    variant="light"
                                    radius="lg"
                                    className="h-9 w-9 min-w-9 shrink-0 text-current hover:bg-black/10 dark:hover:bg-white/10"
                                    aria-label="Disminuir cantidad"
                                    onPress={() => onQuickUpdate(product.barcode, -1)}
                                >
                                    <Minus className="h-4 w-4" strokeWidth={2.5} />
                                </Button>
                            )}
                            <span className="min-w-[2.75rem] px-1 text-center text-[11px] font-black italic tabular-nums leading-none">
                                {formatStock(product.quantity, (product as any).isPack, product.isWeighted)}
                            </span>
                            {isAdmin && (
                                <Button
                                    isIconOnly
                                    size="sm"
                                    variant="light"
                                    radius="lg"
                                    className="h-9 w-9 min-w-9 shrink-0 text-current hover:bg-black/10 dark:hover:bg-white/10"
                                    aria-label="Aumentar cantidad"
                                    onPress={() => onQuickUpdate(product.barcode, 1)}
                                >
                                    <Plus className="h-4 w-4" strokeWidth={2.5} />
                                </Button>
                            )}
                        </div>
                    </div>
                );
            case "price":
                return (
                    <div className="flex flex-col leading-tight">
                        <div className="flex items-center gap-1.5">
                            <span className="text-[7px] font-black text-gray-400 uppercase italic">COSTO</span>
                            <span className="text-[9px] font-black text-gray-500 italic tabular-nums">${formatCOP(product.purchasePrice)}</span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[7px] font-black text-emerald-500 uppercase italic">VENTA</span>
                            <span className="text-[11px] font-black text-emerald-600 dark:text-emerald-400 italic tabular-nums">${formatCOP(product.salePrice)}</span>
                        </div>
                    </div>
                );
            case "margin":
                return (
                    <div className="inline-flex items-center px-2 py-1 rounded-lg bg-gray-50/50 dark:bg-black/30 border border-gray-100 dark:border-white/5">
                        <span className="text-[10px] font-black text-emerald-500 italic tabular-nums">{product.marginPercentage}%</span>
                    </div>
                );
            case "actions":
                if (!isAdmin) return <span className="text-[7px] font-black text-gray-400 uppercase italic opacity-30">Lectura</span>;
                return (
                    <div className="flex items-center justify-end gap-1 px-1">
                        <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-emerald-500/5 text-emerald-500 rounded-lg hover:bg-emerald-500 hover:text-white transition-all shadow-sm" onPress={() => onEdit(product)}>
                            <Edit size={14} />
                        </Button>
                        <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-rose-500/5 text-rose-500 rounded-lg hover:bg-rose-500 hover:text-white transition-all shadow-sm" onPress={() => onDelete(product.barcode)}>
                            <Trash2 size={14} />
                        </Button>
                    </div>
                );
            default:
                return null;
        }
    }, [isAdmin, onEdit, onDelete, onQuickUpdate, formatCOP]);

    return (
        <div className="flex-1 min-h-[400px] bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col shadow-sm transition-colors">
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden min-w-0">
                {!isMobile ? (
                    <div className="flex-1 min-h-0 overflow-x-auto w-full custom-scrollbar">
                        <Table
                            isCompact
                            removeWrapper
                            aria-label="Directorio Maestro Productos"
                            classNames={{
                                base: "flex-1 overflow-hidden min-w-[720px]",
                                wrapper:
                                    "flex-1 overflow-auto custom-scrollbar [scrollbar-gutter:stable] bg-transparent shadow-none p-0 rounded-none",
                                th: "bg-gray-50/80 dark:bg-zinc-950/80 backdrop-blur-md text-gray-400 dark:text-zinc-500 font-black uppercase text-[9px] tracking-widest h-10 py-1 border-b border-gray-200 dark:border-white/5 sticky top-0 z-10 px-4",
                                td: "py-1.5 border-b border-gray-100 dark:border-white/5 px-4",
                                tr: "hover:bg-emerald-500/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-emerald-500/10 cursor-default group h-10",
                            }}
                        >
                            <TableHeader columns={COLUMNS}>
                                {(column) => (
                                    <TableColumn key={column.uid} align={column.align as any}>
                                        {column.name}
                                    </TableColumn>
                                )}
                            </TableHeader>
                            <TableBody items={products} emptyContent="SIN PRODUCTOS REGISTRADOS">
                                {(item) => (
                                    <TableRow key={item.barcode}>
                                        {(columnKey) => <TableCell>{renderCell(item, columnKey)}</TableCell>}
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </div>
                ) : (
                    <div className="flex-1 min-h-0 overflow-y-auto scroll-smooth custom-scrollbar p-2 flex flex-col gap-2 bg-gray-50/50 dark:bg-black/20">
                        {products.map((p) => {
                            // Semáforo dinámico por tramos de stock mínimo
                            const minStock = p.minStock || 5;
                            const threshold = getCriticalThreshold(minStock);
                            const isCritical = !p.isWeighted && p.quantity <= threshold;
                            const isWarning = !p.isWeighted && p.quantity <= minStock && p.quantity > threshold;
                            
                            // Clases según estado
                            const cardBorderClass = isCritical 
                                ? "border-rose-500/40 bg-rose-500/5 shadow-rose-500/5"
                                : isWarning
                                    ? "border-amber-500/40 bg-amber-500/5 shadow-amber-500/5"
                                    : "hover:border-emerald-500/30 shadow-emerald-500/5";
                            
                            const indicatorClass = isCritical 
                                ? 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.4)]'
                                : isWarning
                                    ? 'bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.4)]'
                                    : 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.4)]';
                            
                            const quantityBoxClass = isCritical
                                ? 'bg-rose-500/10 border-rose-500/30 text-rose-500'
                                : isWarning
                                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-500'
                                    : 'bg-emerald-500/5 border-emerald-500/20 text-emerald-500';
                            
                            return (
                                <div key={p.barcode} className={`relative flex flex-col gap-3 p-4 rounded-2xl border border-gray-200 dark:border-white/10 shadow-lg bg-white dark:bg-[#18181b] min-h-[110px] w-full shrink-0 ${cardBorderClass}`}>
                                    <div className={`absolute top-3 left-0 w-1.5 h-10 rounded-r-full z-20 ${indicatorClass}`} />
                                    <div className="flex items-center gap-3">
                                        <div className="h-10 w-10 rounded-xl bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-white/10 flex items-center justify-center text-emerald-500 shrink-0 shadow-sm overflow-hidden text-[10px] font-black uppercase italic">
                                            {p.imageUrl ? <img src={p.imageUrl} className="h-full w-full object-cover" alt="" /> : <Package size={18} />}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <h3 className="text-[13px] font-black text-gray-900 dark:text-zinc-100 uppercase tracking-tighter italic leading-none truncate">{p.productName}</h3>
                                            <span className="text-[8px] text-gray-400 font-bold tracking-widest mt-1 block uppercase leading-none">{p.barcode}</span>
                                        </div>
                                        <div className="flex flex-col items-end shrink-0">
                                            <span className="text-[13px] font-black text-emerald-500 italic leading-none">${formatCOP(p.salePrice)}</span>
                                            <span className="text-[7px] font-bold text-gray-400 uppercase tracking-widest mt-1 italic leading-none">PVP</span>
                                        </div>
                                    </div>
                                    <div className="flex flex-col gap-2 mt-auto pt-2 border-t border-gray-100 dark:border-white/5">
                                        {isAdmin ? (
                                            <div className="flex items-stretch gap-2 w-full">
                                                <Button
                                                    isIconOnly
                                                    radius="lg"
                                                    variant="flat"
                                                    className="h-12 w-12 min-w-12 shrink-0 bg-gray-100 dark:bg-zinc-800 text-emerald-600 dark:text-emerald-400 border border-gray-200 dark:border-white/10 shadow-sm active:scale-95"
                                                    aria-label="Disminuir cantidad"
                                                    onPress={() => onQuickUpdate(p.barcode, -1)}
                                                >
                                                    <Minus size={22} strokeWidth={2.5} />
                                                </Button>
                                                <div
                                                    className={`flex-1 flex flex-col items-center justify-center rounded-xl border px-2 py-2 min-w-0 ${quantityBoxClass}`}
                                                >
                                                    <span className="text-xl font-black italic tabular-nums leading-none">{formatStock(p.quantity, (p as any).isPack, p.isWeighted)}</span>
                                                    <span className="text-[8px] font-black opacity-70 uppercase tracking-widest mt-0.5">
                                                        {p.isWeighted ? 'KG' : 'UND'}
                                                    </span>
                                                </div>
                                                <Button
                                                    isIconOnly
                                                    radius="lg"
                                                    variant="flat"
                                                    className="h-12 w-12 min-w-12 shrink-0 bg-emerald-500 text-white border border-emerald-600/30 shadow-md shadow-emerald-500/20 active:scale-95"
                                                    aria-label="Aumentar cantidad"
                                                    onPress={() => onQuickUpdate(p.barcode, 1)}
                                                >
                                                    <Plus size={22} strokeWidth={2.5} />
                                                </Button>
                                            </div>
                                        ) : (
                                            <div
                                                className={`flex items-center justify-center gap-2 px-3 py-2 rounded-xl border w-full ${quantityBoxClass}`}
                                            >
                                                <span className="text-lg font-black italic tabular-nums">{formatStock(p.quantity, (p as any).isPack, p.isWeighted)}</span>
                                                <span className="text-[8px] font-black opacity-60 uppercase tracking-widest">
                                                    {p.isWeighted ? 'KG' : 'UND'}
                                                </span>
                                            </div>
                                        )}
                                        {isAdmin && (
                                            <div className="flex justify-end gap-2">
                                                <Button isIconOnly size="sm" variant="flat" className="h-9 w-9 bg-gray-100 dark:bg-zinc-800 text-emerald-500 rounded-xl" onPress={() => onEdit(p)}><Edit size={14} /></Button>
                                                <Button isIconOnly size="sm" variant="flat" className="h-9 w-9 bg-rose-500/10 text-rose-500 rounded-xl" onPress={() => onDelete(p.barcode)}><Trash2 size={14} /></Button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {totalFiltered > 0 && (
                <div className="shrink-0 px-3 py-2 flex items-center justify-between gap-2 border-t border-gray-200 dark:border-white/10 bg-gray-50/95 dark:bg-zinc-950 backdrop-blur-md z-40 shadow-[0_-4px_15px_rgba(0,0,0,0.1)] relative">
                    <div className="flex items-center gap-2 font-black">
                        <Button
                            isIconOnly
                            size="sm"
                            variant="flat"
                            type="button"
                            onPress={() => onPageChange(Math.max(1, currentPage - 1))}
                            isDisabled={currentPage === 1}
                            className="h-8 w-8 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white rounded-lg border border-gray-200 dark:border-white/5 shadow-sm active:scale-90 transition-transform"
                        >
                            <ChevronLeft size={18} />
                        </Button>

                        <div className="flex flex-col items-start px-1 leading-none">
                            <span className="text-[7px] text-gray-400 dark:text-zinc-500 uppercase font-black tracking-tighter">MOSTRANDO</span>
                            <p className="text-[10px] text-gray-900 dark:text-white uppercase tracking-widest flex items-center gap-1">
                                <span className="italic font-black text-emerald-500">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, totalFiltered)}</span>
                                <span className="opacity-20 text-[8px]">DE</span>
                                <span className="italic font-black">{totalFiltered}</span>
                            </p>
                        </div>

                        <Button
                            isIconOnly
                            size="sm"
                            variant="flat"
                            type="button"
                            onPress={() => onPageChange(Math.min(totalPages, currentPage + 1))}
                            isDisabled={currentPage === totalPages || totalPages === 0}
                            className="h-8 w-8 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white rounded-lg border border-gray-200 dark:border-white/5 shadow-sm active:scale-90 transition-transform"
                        >
                            <ChevronRight size={18} />
                        </Button>
                    </div>

                    <div className="flex items-center gap-2">
                        <div className="relative">
                            <select
                                value={pageSize}
                                onChange={(e) => onPageSizeChange(Number(e.target.value))}
                                className="h-8 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white text-[10px] font-black uppercase tracking-widest px-2 pr-6 outline-none rounded-lg border border-gray-200 dark:border-white/10 cursor-pointer shadow-sm appearance-none"
                            >
                                {[25, 50, 100].map((n) => (
                                    <option key={n} value={n}>
                                        {n}
                                    </option>
                                ))}
                            </select>
                            <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-30">
                                <Info size={10} />
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

ProductTable.displayName = 'ProductTable';
export default ProductTable;