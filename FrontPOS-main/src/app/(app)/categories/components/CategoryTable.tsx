"use client";

import React, { memo } from 'react';
import {
    Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Button, Tooltip
} from "@heroui/react";
import { 
    Edit, 
    Trash2, 
    Shapes,
    SearchX,
    ChevronLeft,
    ChevronRight,
    Layers,
    Info,
    LayoutGrid
} from 'lucide-react';
import { Category } from '@/lib/definitions';
import { useAuth } from '@/lib/auth';

interface TableProps {
    categories: Category[];
    currentPage: number;
    totalPages: number;
    pageSize: number;
    totalFiltered: number;
    onEdit: (category: Category) => void;
    onDelete: (id: string) => void;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
}

const CategoryTable = memo(({ 
    categories, 
    currentPage, 
    totalPages, 
    pageSize, 
    totalFiltered,
    onEdit, 
    onDelete,
    onPageChange,
    onPageSizeChange
}: TableProps) => {
    const { user } = useAuth();
    const [isMobile, setIsMobile] = React.useState(false);

    const role = user?.role?.toLowerCase() || user?.Role?.toLowerCase() || "";
    const isAdmin = role === "admin" || role === "administrador" || role === "superadmin";

    React.useEffect(() => {
        const mql = window.matchMedia("(max-width: 768px)");
        const onChange = () => setIsMobile(mql.matches);
        mql.addEventListener("change", onChange);
        setIsMobile(mql.matches);
        return () => mql.removeEventListener("change", onChange);
    }, []);

    const renderCell = React.useCallback((category: Category, columnKey: string) => {
        switch (columnKey) {
            case "identity":
                return (
                    <div className="flex items-center gap-4 py-0.5">
                        <div className="h-10 w-10 shrink-0 bg-emerald-500/10 text-emerald-500 flex items-center justify-center rounded-xl border border-emerald-500/20 shadow-sm transform -rotate-2 group-hover:rotate-0 transition-transform">
                            <LayoutGrid size={20} strokeWidth={2.5} />
                        </div>
                        <div className="flex flex-col min-w-0">
                            <span className="text-xs md:text-sm font-black text-gray-900 dark:text-white uppercase leading-tight italic truncate max-w-[200px] group-hover:text-emerald-500 transition-colors">
                                {category.name}
                            </span>
                            <span className="text-[7px] text-emerald-500 font-black tracking-widest uppercase mt-0.5">
                                ID: #{category.id}
                            </span>
                        </div>
                    </div>
                );
            case "stock":
                return (
                    <div className="flex justify-center">
                        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/5 shadow-sm group-hover:border-emerald-500/30 transition-all">
                            <Layers size={10} className="text-emerald-500" />
                            <span className="text-[11px] font-black text-gray-900 dark:text-white tabular-nums tracking-widest">{category.productCount || 0}</span>
                            <span className="text-[8px] font-bold text-gray-400 dark:text-zinc-500 uppercase mt-0.5">REFS</span>
                        </div>
                    </div>
                );
            case "actions":
                if (!isAdmin) return <div className="flex justify-end pr-4"><span className="text-[7px] font-black text-gray-400 uppercase tracking-widest italic opacity-50">Solo Lectura</span></div>;
                return (
                    <div className="flex justify-end gap-1.5 md:gap-2 px-1">
                        <Tooltip content="EDITAR CATEGORÍA" delay={0} placement="top" classNames={{ content: "font-black text-[9px] uppercase tracking-widest bg-emerald-500 text-white py-1 px-2 rounded-none shadow-xl" }}>
                            <Button 
                                isIconOnly 
                                size="sm" 
                                variant="flat" 
                                className="h-9 w-9 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500 hover:text-white rounded-xl transition-all border border-emerald-500/20" 
                                onPress={() => onEdit(category)}
                            >
                                <Edit size={14} />
                            </Button>
                        </Tooltip>
                        <Tooltip content="ELIMINAR" delay={0} placement="top-end" color="danger" classNames={{ content: "font-black text-[9px] uppercase tracking-widest bg-rose-500 text-white py-1 px-2 rounded-none shadow-xl" }}>
                            <Button 
                                isIconOnly 
                                size="sm" 
                                variant="flat" 
                                className="h-9 w-9 bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white rounded-xl transition-all border border-rose-500/20" 
                                onPress={() => onDelete(String(category.id))}
                            >
                                <Trash2 size={14} />
                            </Button>
                        </Tooltip>
                    </div>
                );
            default:
                return null;
        }
    }, [isAdmin, onEdit, onDelete]);

    return (
        <div className="flex-1 min-h-0 bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col shadow-sm transition-colors">
            
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {!isMobile ? (
                    <div className="flex-1 overflow-x-auto w-full custom-scrollbar">
                        <Table 
                            isCompact 
                            removeWrapper 
                            aria-label="Jerarquía de Categorías Maestras"
                            classNames={{ 
                                base: "flex-1 overflow-hidden",
                                wrapper: "flex-1 overflow-auto bg-transparent shadow-none p-0 rounded-none",
                                th: "bg-gray-50/80 dark:bg-zinc-950/80 backdrop-blur-md text-gray-400 dark:text-zinc-500 font-black uppercase text-[9px] tracking-widest h-10 py-1 border-b border-gray-200 dark:border-white/5 sticky top-0 z-10 px-6", 
                                td: "py-1.5 border-b border-gray-100 dark:border-white/5 px-6", 
                                tr: "hover:bg-emerald-500/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-emerald-500/10 cursor-pointer group h-10" 
                            }}
                        >
                            <TableHeader>
                                <TableColumn align="start">DEPARTAMENTO MAESTRO</TableColumn>
                                <TableColumn align="center">DENSIDAD DE STOCK</TableColumn>
                                <TableColumn align="end">ACCIONES DE GESTIÓN</TableColumn>
                            </TableHeader>
                            <TableBody items={categories} emptyContent={
                                <div className="py-24 flex flex-col items-center justify-center text-gray-400 dark:text-zinc-700">
                                    <SearchX size={48} strokeWidth={1} className="mb-4 opacity-20" />
                                    <span className="text-[10px] font-black uppercase tracking-[0.5em] italic">No hay departamentos registrados</span>
                                </div>
                            }>
                                {(item) => (
                                    <TableRow key={item.id}>
                                        <TableCell>{renderCell(item, "identity")}</TableCell>
                                        <TableCell>{renderCell(item, "stock")}</TableCell>
                                        <TableCell>{renderCell(item, "actions")}</TableCell>
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </div>
                ) : (
                    <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3 bg-gray-50/50 dark:bg-zinc-950/40 custom-scrollbar">
                        {categories.length === 0 ? (
                            <div className="py-12 flex flex-col items-center justify-center text-gray-400 dark:text-zinc-700">
                                <SearchX size={32} strokeWidth={1} className="mb-2 opacity-20" />
                                <span className="text-[8px] font-black uppercase tracking-widest italic text-center">Sin resultados de búsqueda</span>
                            </div>
                        ) : (
                            categories.map((c) => (
                                <div key={c.id} className="p-3.5 rounded-2xl border bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 shadow-sm flex items-center justify-between gap-3 transform active:scale-[0.98] transition-all shrink-0">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="h-10 w-10 bg-emerald-500 text-white flex items-center justify-center rounded-xl shadow-lg shadow-emerald-500/10 shrink-0 transform -rotate-1">
                                            <LayoutGrid size={18} strokeWidth={2.5} />
                                        </div>
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-[11px] font-black text-gray-900 dark:text-white uppercase italic leading-none truncate pr-2">
                                                {c.name}
                                            </span>
                                            <div className="flex items-center gap-2 mt-1.5">
                                                <span className="text-[7px] text-emerald-500 font-black tracking-widest uppercase leading-none opacity-80">
                                                    ID: #{c.id}
                                                </span>
                                                <span className="text-[6px] text-gray-300 dark:text-zinc-700">|</span>
                                                <div className="flex items-center gap-1">
                                                    <Layers size={8} className="text-gray-400" />
                                                    <span className="text-[8px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-tighter">
                                                        {c.productCount || 0} REFS
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-1.5 pl-2 border-l border-gray-100 dark:border-white/5 shrink-0">
                                        {isAdmin ? (
                                            <>
                                                <Button 
                                                    isIconOnly
                                                    size="sm" 
                                                    variant="flat" 
                                                    className="h-9 w-9 bg-emerald-500/5 text-emerald-500 hover:bg-emerald-500 hover:text-white transition-all rounded-xl"
                                                    onPress={() => onEdit(c)}
                                                >
                                                    <Edit size={14} />
                                                </Button>
                                                <Button 
                                                    isIconOnly
                                                    size="sm" 
                                                    variant="flat" 
                                                    className="h-9 w-9 bg-rose-500/5 text-rose-500 hover:text-white hover:bg-rose-500 transition-all rounded-xl"
                                                    onPress={() => onDelete(String(c.id))}
                                                >
                                                    <Trash2 size={14} />
                                                </Button>
                                            </>
                                        ) : (
                                            <div className="h-8 w-8 bg-gray-50/50 dark:bg-white/5 rounded-full flex items-center justify-center text-gray-300 dark:text-zinc-700">
                                                <Edit size={12} className="opacity-20" />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                )}
            </div>

            {/* PAGINACIÓN FIJA - SYNCED WITH SUPPLIERS/USERS */}
            {totalFiltered > 0 && (
                <div className="shrink-0 px-3 py-2 flex items-center justify-between gap-2 border-t border-gray-200 dark:border-white/10 bg-gray-50/95 dark:bg-zinc-950 backdrop-blur-md z-40 shadow-[0_-4px_15px_rgba(0,0,0,0.1)]">
                    <div className="flex items-center gap-2 font-black">
                        <Button
                            isIconOnly
                            size="sm"
                            variant="flat"
                            onPress={() => onPageChange(Math.max(1, currentPage - 1))}
                            isDisabled={currentPage === 1}
                            className="h-8 w-8 min-w-0 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white rounded-lg border border-gray-200 dark:border-white/5 shadow-sm active:scale-90 transition-transform"
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
                            onPress={() => onPageChange(Math.min(totalPages, currentPage + 1))}
                            isDisabled={currentPage === totalPages || totalPages === 0}
                            className="h-8 w-8 min-w-0 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white rounded-lg border border-gray-200 dark:border-white/5 shadow-sm active:scale-90 transition-transform"
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
                                {[10, 20, 50].map(n => <option key={n} value={n}>{n}</option>)}
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

CategoryTable.displayName = 'CategoryTable';
export default CategoryTable;
