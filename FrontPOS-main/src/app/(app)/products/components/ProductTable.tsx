"use client";

import React, { memo, useEffect, useState, useCallback } from 'react';
import {
    Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Button, Chip, Pagination
} from "@heroui/react";
import {
    Package, Edit, Trash2, ChevronLeft, ChevronRight, Info, Plus, Minus
} from 'lucide-react';
import { Product } from '@/lib/definitions';
import { useAuth } from '@/lib/auth';
import { calculateStockHealth, formatStock, isProductWeighted } from '@/lib/utils';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPackage } from '@tabler/icons-react';

interface TableProps {
    products: Product[];
    currentPage: number;
    totalPages: number;
    pageSize: number;
    totalFiltered: number;
    onEdit: (product: Product) => void;
    onDelete: (barcode: string) => void;
    onQuickUpdate: (barcode: string, amount: number) => void;
    onOpenBulk?: (product: Product) => void;
    loadingBarcodes?: Set<string>;
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
    onOpenBulk,
    loadingBarcodes = new Set(),
    onPageChange,
    onPageSizeChange,
    formatCOP
}: TableProps) => {
    const { user } = useAuth();
    const [isMobile, setIsMobile] = useState(false);

    const role = user?.role?.toLowerCase() || user?.Role?.toLowerCase() || "";
    const isAdmin = role === "admin" || role === "administrador" || role === "superadmin";
    const canEdit = isAdmin || role === "empleado";

    const sortedProducts = React.useMemo(() => {
        if (!products) return [];
        return [...products].sort((a, b) => {
            const healthA = calculateStockHealth(a.quantity, a.minStock || 1);
            const healthB = calculateStockHealth(b.quantity, b.minStock || 1);
            
            // 1. Salud (Rojo < Amarillo < Verde)
            const wA = healthA === 'CRITICAL' ? 0 : healthA === 'WARNING' ? 1 : 2;
            const wB = healthB === 'CRITICAL' ? 0 : healthB === 'WARNING' ? 1 : 2;
            if (wA !== wB) return wA - wB;

            // 2. Urgencia: Cantidad faltante vs meta (MinStock - Cantidad)
            const diffA = (a.minStock || 0) - a.quantity;
            const diffB = (b.minStock || 0) - b.quantity;
            if (diffB !== diffA) return diffB - diffA;

            // 3. Rotación (Promedio de venta diaria)
            const rotA = (a as any).avgSoldPerDay || 0;
            const rotB = (b as any).avgSoldPerDay || 0;
            return rotB - rotA;
        });
    }, [products]);

    useEffect(() => {
        const mql = window.matchMedia("(max-width: 768px)");
        const onChange = () => setIsMobile(mql.matches);
        mql.addEventListener("change", onChange);
        setIsMobile(mql.matches);
        return () => mql.removeEventListener("change", onChange);
    }, []);

    const renderCell = useCallback((product: Product, columnKey: React.Key) => {
        const minStock = product.minStock || 1;
        const quantity = product.quantity;
        const health = calculateStockHealth(quantity, minStock);

        const isCritical = health === 'CRITICAL';
        const isWarning = health === 'WARNING';

        const stockStatusClass = isCritical
            ? 'bg-rose-500/10 border-rose-500/40 text-rose-500 animate-pulse'
            : isWarning
                ? 'bg-amber-500/10 border-amber-500/40 text-amber-500 font-medium'
                : 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 border-emerald-500/20 text-zinc-900 dark:text-zinc-100';

        const indicatorColor = isCritical ? 'bg-rose-500' : isWarning ? 'bg-amber-500' : 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5';

        switch (String(columnKey)) {
            case "identity":
                return (
                    <div className="flex items-center gap-3 py-1">
                        <div className="h-9 w-9 rounded-2xl bg-white/5 text-zinc-900 dark:text-zinc-100 flex items-center justify-center border border-emerald-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shrink-0 overflow-hidden">
                            {product.imageUrl ? (
                                <img src={product.imageUrl} className="h-full w-full object-cover" alt="" />
                            ) : (
                                <Package size={18} />
                            )}
                        </div>
                        <div className="flex flex-col min-w-0">
                            <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight leading-tight truncate max-w-[180px]">
                                {product.productName}
                            </span>
                            <span className="text-[8px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest leading-tight">BARCODE: {product.barcode}</span>
                        </div>
                    </div>
                );
            case "stock":
                return (
                    <div className="flex items-center justify-center w-full min-w-[9rem]">
                        <div
                            className={`inline-flex items-center gap-0.5 sm:gap-1 rounded-2xl border transition-all ${stockStatusClass}`}
                        >
                            {isAdmin && (
                                <Button
                                    isIconOnly
                                    size="sm"
                                    variant="light"
                                    radius="lg"
                                    className="h-9 w-9 min-w-9 shrink-0 text-current hover:bg-black/10 dark:hover:bg-zinc-100 dark:bg-zinc-800"
                                    onPress={() => onQuickUpdate(product.barcode, -1)}
                                >
                                    <Minus className="h-4 w-4" strokeWidth={2.5} />
                                </Button>
                            )}
                            <div className="flex items-center gap-1.5 min-w-[2.75rem] px-2 text-center text-[11px] font-medium tracking-tight tabular-nums leading-none">
                                <div className={`h-1.5 w-1.5 rounded-2xl ${indicatorColor} shadow-[0_8px_30px_rgb(0,0,0,0.12)]`} />
                                {formatStock(product.quantity, (product as any).isPack, isProductWeighted(product))}
                            </div>
                            {isAdmin && (
                                <Button
                                    isIconOnly
                                    size="sm"
                                    variant="light"
                                    radius="lg"
                                    className="h-9 w-9 min-w-9 shrink-0 text-current hover:bg-black/10 dark:hover:bg-zinc-100 dark:bg-zinc-800"
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
                        {isAdmin && (
                            <div className="flex items-center gap-1.5">
                                <span className="text-[7px] font-medium text-gray-400 uppercase tracking-tight">COSTO</span>
                                <span className="text-[9px] font-medium text-gray-500 tracking-tight tabular-nums">${formatCOP(product.purchasePrice)}</span>
                            </div>
                        )}
                        <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[7px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-tight">VENTA</span>
                            <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 tracking-tight tabular-nums">${formatCOP(product.salePrice)}</span>
                        </div>
                    </div>
                );
            case "margin":
                if (!isAdmin) return <div className="text-[10px] font-medium text-gray-300 tracking-tight">---</div>;
                const safeCost = parseFloat(String(product.purchasePrice)) || 0;
                const safePvp = parseFloat(String(product.salePrice)) || 0;
                
                let calculatedMargin = 100;
                if (safeCost > 0) {
                    calculatedMargin = ((safePvp / safeCost) - 1) * 100;
                }
                const isHighMargin = calculatedMargin > 35;
                return (
                    <div className="flex flex-col items-center gap-1">
                        <div className="inline-flex items-center px-2 py-1 rounded-2xl bg-gray-50/50 dark:bg-[#18181b] border border-gray-100 dark:border-white/5">
                            <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 tracking-tight tabular-nums">{(calculatedMargin || 0).toFixed(2)}%</span>
                        </div>
                        {isHighMargin && (
                            <span className="text-[7px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-tighter animate-pulse">
                                ↑ Margen Alto
                            </span>
                        )}
                    </div>
                );
            case "actions":
                if (!canEdit) return <span className="text-[7px] font-medium text-gray-400 uppercase tracking-tight opacity-30">Lectura</span>;
                return (
                    <div className="flex items-center justify-end gap-1 px-1">
                        {onOpenBulk && (
                            <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-amber-500/5 text-amber-500 rounded-2xl hover:bg-amber-500 hover:text-white transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)]" onPress={() => onOpenBulk(product)}>
                                <Package size={14} />
                            </Button>
                        )}
                        <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-emerald-500/5 text-zinc-900 dark:text-zinc-100 rounded-2xl hover:bg-emerald-500 hover:text-white transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)]" onPress={() => onEdit(product)}>
                            <Edit size={14} />
                        </Button>
                        {isAdmin && (
                            <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-rose-500/5 text-rose-500 rounded-2xl hover:bg-rose-500 hover:text-white transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)]" onPress={() => onDelete(product.barcode)}>
                                <Trash2 size={14} />
                            </Button>
                        )}
                    </div>
                );
            default:
                return null;
        }
    }, [isAdmin, onEdit, onDelete, onQuickUpdate, formatCOP]);

    return (
        <div className="flex-1 min-h-0 bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-colors">
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden min-w-0">
                {!isMobile ? (
                    <div className="flex-1 overflow-auto overscroll-contain custom-scrollbar min-h-0 w-full">
                        <Table
                            isCompact
                            removeWrapper
                            isHeaderSticky
                            aria-label="Directorio Maestro Productos"
                            classNames={{
                                base: "min-w-[720px]",
                                th: "bg-gray-50/80 dark:bg-zinc-950/80  text-zinc-500 dark:text-zinc-400 font-medium uppercase text-[9px] tracking-widest h-10 py-1 border-b border-gray-200 dark:border-white/5 sticky top-0 z-10 px-4",
                                td: "py-1.5 border-b border-gray-100 dark:border-white/5 px-4",
                                tr: "hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-white/5 cursor-default group h-10",
                            }}
                        >
                            <TableHeader columns={COLUMNS}>
                                {(column) => (
                                    <TableColumn key={column.uid} align={column.align as any}>
                                        {column.name}
                                    </TableColumn>
                                )}
                            </TableHeader>
                            <TableBody
                                items={sortedProducts}
                                emptyContent={
                                    <EmptyState
                                        title="Sin productos registrados"
                                        description="No hemos encontrado productos en este inventario. Intenta ajustar los filtros o registra uno nuevo."
                                        icon={<IconPackage size={48} className="text-gray-300" />}
                                    />
                                }
                            >
                                {(item) => (
                                    <TableRow key={item.barcode}>
                                        {(columnKey) => <TableCell>{renderCell(item, columnKey)}</TableCell>}
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </div>
                ) : (
                    <div className="flex-1 min-h-0 overflow-y-auto scroll-smooth custom-scrollbar p-2 flex flex-col gap-2 bg-gray-50/50 dark:bg-[#18181b]">
                        {sortedProducts.length > 0 ? (
                            sortedProducts.map((p) => {
                                const minStock = p.minStock || 1;
                                const health = calculateStockHealth(p.quantity, minStock);
                                
                                const isCritical = health === 'CRITICAL';
                                const isWarning = health === 'WARNING';

                                const cardBorderClass = isCritical
                                    ? "border-rose-500/40 bg-rose-500/5 shadow-rose-500/5"
                                    : isWarning
                                        ? "border-amber-500/40 bg-amber-500/5 shadow-amber-500/5"
                                        : "hover:border-emerald-500/30 shadow-emerald-500/5";

                                const indicatorClass = isCritical
                                    ? 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.4)] animate-pulse'
                                    : isWarning
                                        ? 'bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.4)]'
                                        : 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 shadow-[0_0_10px_rgba(16,185,129,0.4)]';

                                const quantityBoxClass = isCritical
                                    ? 'bg-rose-500/10 border-rose-500/30 text-rose-500'
                                    : isWarning
                                        ? 'bg-amber-500/10 border-amber-500/30 text-amber-500'
                                        : 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 border-emerald-500/20 text-zinc-900 dark:text-zinc-100';

                                return (
                                    <div key={p.barcode} className={`relative flex flex-col gap-2 p-2.5 rounded-2xl border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] card-base border-none w-full shrink-0 ${cardBorderClass} transition-transform active:scale-[0.98]`}>
                                        <div className={`absolute top-2.5 left-0 w-1 h-8 rounded-r-full z-20 ${indicatorClass}`} />
                                        
                                        <div className="flex items-center gap-2">
                                            <div className="h-9 w-9 rounded-2xl bg-gray-50 dark:bg-[#18181b] border border-gray-200 dark:border-white/10 flex items-center justify-center text-zinc-900 dark:text-zinc-100 shrink-0 shadow-inner overflow-hidden">
                                                {p.imageUrl ? <img src={p.imageUrl} className="h-full w-full object-cover" alt="" /> : <Package size={16} />}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <h3 className="text-[11px] font-medium text-gray-900 dark:text-zinc-100 uppercase tracking-tighter tracking-tight leading-none truncate">{p.productName}</h3>
                                                <span className="text-[7px] text-gray-400 font-bold tracking-widest mt-1 block uppercase leading-none">{p.barcode}</span>
                                            </div>
                                            <div className="flex flex-col items-end shrink-0 leading-none">
                                                <span className="text-[12px] font-medium text-zinc-900 dark:text-zinc-100 tracking-tight tabular-nums">${formatCOP(p.salePrice)}</span>
                                                <span className="text-[6px] font-bold text-gray-400 uppercase tracking-widest mt-0.5 tracking-tight">PVP</span>
                                            </div>
                                        </div>

                                        <div className="flex items-center justify-between gap-2 mt-1 pt-2 border-t border-gray-100 dark:border-white/5">
                                            <div className="flex-1">
                                                {canEdit ? (
                                                    <div className="flex items-center gap-1.5 w-full">
                                                        <Button
                                                            isIconOnly
                                                            radius="lg"
                                                            variant="flat"
                                                            className="h-8 w-8 min-w-8 shrink-0 bg-gray-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 dark:text-zinc-300 border border-gray-200 dark:border-white/10 active:scale-90"
                                                            onPress={() => onQuickUpdate(p.barcode, -1)}
                                                        >
                                                            <Minus size={14} strokeWidth={3} />
                                                        </Button>
                                                        <div className={`flex-1 flex items-center justify-center gap-1 h-8 rounded-2xl border ${quantityBoxClass}`}>
                                                            <span className="text-[12px] font-medium tracking-tight tabular-nums leading-none">{formatStock(p.quantity, (p as any).isPack, isProductWeighted(p))}</span>
                                                            <span className="text-[6px] font-medium opacity-70 uppercase tracking-tighter">{isProductWeighted(p) ? 'KG' : 'UN'}</span>
                                                        </div>
                                                        <Button
                                                            isIconOnly
                                                            radius="lg"
                                                            variant="flat"
                                                            className="h-8 w-8 min-w-8 shrink-0 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white border border-emerald-600/30 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-90"
                                                            onPress={() => onQuickUpdate(p.barcode, 1)}
                                                        >
                                                            <Plus size={14} strokeWidth={3} />
                                                        </Button>
                                                    </div>
                                                ) : (
                                                    <div className={`flex items-center justify-center gap-1.5 h-8 px-3 rounded-2xl border w-full ${quantityBoxClass}`}>
                                                        <span className="text-[12px] font-medium tracking-tight tabular-nums">{formatStock(p.quantity, (p as any).isPack, isProductWeighted(p))}</span>
                                                        <span className="text-[7px] font-medium opacity-60 uppercase tracking-widest">{isProductWeighted(p) ? 'KG' : 'UN'}</span>
                                                    </div>
                                                )}
                                            </div>

                                            {canEdit && (
                                                <div className="flex gap-1 shrink-0">
                                                    {onOpenBulk && (
                                                        <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-amber-500/10 text-amber-500 rounded-2xl border border-amber-500/10" onPress={() => onOpenBulk(p)}><Package size={12} /></Button>
                                                    )}
                                                    <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-emerald-500/5 text-zinc-900 dark:text-zinc-100 rounded-2xl border border-emerald-500/10" onPress={() => onEdit(p)}><Edit size={12} /></Button>
                                                    {isAdmin && (
                                                        <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-rose-500/10 text-rose-500 rounded-2xl border border-rose-500/10" onPress={() => onDelete(p.barcode)}><Trash2 size={12} /></Button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })
                        ) : (
                            <EmptyState
                                title="Sin resultados"
                                description="No hay productos que coincidan con tu búsqueda en este dispositivo."
                            />
                        )}
                    </div>
                )}
            </div>

            {totalFiltered > 0 && (
                <div className="shrink-0 px-3 py-2 flex items-center justify-between gap-2 border-t border-gray-200 dark:border-white/10 bg-gray-50/95 dark:bg-zinc-950 z-40 shadow-[0_-4px_15px_rgba(0,0,0,0.1)]">
                    <div className="flex items-center gap-2 font-medium">
                        <Button
                            isIconOnly
                            size="sm"
                            variant="flat"
                            onPress={() => onPageChange(Math.max(1, currentPage - 1))}
                            isDisabled={currentPage === 1}
                            className="h-8 w-8 min-w-0 card-base border-none text-zinc-900 dark:text-zinc-50 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-90 transition-transform"
                        >
                            <ChevronLeft size={18} />
                        </Button>

                        <div className="flex flex-col items-start px-1 leading-none">
                            <span className="text-[7px] text-zinc-500 dark:text-zinc-400 uppercase font-medium tracking-tighter">MOSTRANDO</span>
                            <p className="text-[10px] text-zinc-900 dark:text-zinc-50 uppercase tracking-widest flex items-center gap-1">
                                <span className="tracking-tight font-medium text-zinc-900 dark:text-zinc-100">{(totalFiltered === 0 ? 0 : (currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, totalFiltered)}</span>
                                <span className="opacity-20 text-[8px]">DE</span>
                                <span className="tracking-tight font-medium">{totalFiltered}</span>
                            </p>
                        </div>

                        <Button
                            isIconOnly
                            size="sm"
                            variant="flat"
                            onPress={() => onPageChange(Math.min(totalPages, currentPage + 1))}
                            isDisabled={currentPage === totalPages || totalPages === 0}
                            className="h-8 w-8 min-w-0 card-base border-none text-zinc-900 dark:text-zinc-50 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-90 transition-transform"
                        >
                            <ChevronRight size={18} />
                        </Button>
                    </div>

                    <div className="flex items-center gap-2">
                        <div className="relative">
                            <select
                                value={pageSize}
                                onChange={(e) => onPageSizeChange(Number(e.target.value))}
                                className="h-8 card-base border-none text-zinc-900 dark:text-zinc-50 text-[10px] font-medium uppercase tracking-widest px-2 pr-6 outline-none rounded-2xl border border-gray-200 dark:border-white/10 cursor-pointer shadow-[0_8px_30px_rgb(0,0,0,0.12)] appearance-none"
                            >
                                {[25, 50, 100, 10000].map(n => <option key={n} value={n}>{n === 10000 ? 'TODOS' : n}</option>)}
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