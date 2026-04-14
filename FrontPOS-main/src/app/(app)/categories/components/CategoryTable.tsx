"use client";

import React, { memo } from 'react';
import {
    Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Button, Chip
} from "@heroui/react";
import { 
    Edit, 
    Trash2, 
    Shapes,
    SearchX,
    ChevronLeft,
    ChevronRight,
    Layers
} from 'lucide-react';
import { Category } from '@/lib/definitions';

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
    return (
        <div className="flex-1 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col shadow-sm transition-colors">
            <div className="flex-1 overflow-x-auto w-full custom-scrollbar">
                <Table 
                    isCompact 
                    removeWrapper 
                    aria-label="Jerarquía de Categorías Maestras"
                    classNames={{ 
                        th: "bg-gray-50/80 dark:bg-zinc-950/80 backdrop-blur-md text-gray-400 dark:text-zinc-500 font-black uppercase text-[8px] md:text-[9px] tracking-widest h-12 py-1 border-b border-gray-200 dark:border-white/5 sticky top-0 z-10 px-6", 
                        td: "py-4 border-b border-gray-100 dark:border-white/5 px-6", 
                        tr: "hover:bg-emerald-500/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-emerald-500/10 cursor-pointer group" 
                    }}
                >
                    <TableHeader>
                        <TableColumn>DEPARTAMENTO MAESTRO</TableColumn>
                        <TableColumn align="center">DENSIDAD DE STOCK</TableColumn>
                        <TableColumn align="end">ACCIONES DE GESTIÓN</TableColumn>
                    </TableHeader>
                    <TableBody 
                        emptyContent={
                            <div className="py-24 flex flex-col items-center justify-center text-gray-400 dark:text-zinc-700">
                                <SearchX size={48} strokeWidth={1} className="mb-4 opacity-20" />
                                <span className="text-[10px] font-black uppercase tracking-[0.5em] italic">No hay departamentos registrados</span>
                            </div>
                        }
                    >
                        {categories.map((category) => (
                            <TableRow key={category.id}>
                                <TableCell>
                                    <div className="flex items-center gap-4">
                                        <div className="h-10 w-10 shrink-0 bg-emerald-500/10 text-emerald-500 rounded-2xl flex items-center justify-center border border-emerald-500/20 shadow-inner">
                                            <Shapes size={20} />
                                        </div>
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-sm font-black text-gray-900 dark:text-white uppercase leading-tight italic truncate max-w-[200px] md:max-w-none group-hover:text-emerald-500 transition-colors">
                                                {category.name}
                                            </span>
                                            <span className="text-[9px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest mt-1 uppercase">
                                                ID: #{category.id}
                                            </span>
                                        </div>
                                    </div>
                                </TableCell>
                                <TableCell>
                                    <div className="flex justify-center">
                                        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-xl bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/5 shadow-sm group-hover:border-emerald-500/30 transition-all">
                                            <Layers size={10} className="text-emerald-500" />
                                            <span className="text-[11px] font-black text-gray-900 dark:text-white tabular-nums tracking-widest">{category.productCount}</span>
                                            <span className="text-[8px] font-bold text-gray-400 dark:text-zinc-500 uppercase mt-0.5">REFS</span>
                                        </div>
                                    </div>
                                </TableCell>
                                <TableCell>
                                    <div className="flex justify-end gap-2">
                                        <Button 
                                            isIconOnly 
                                            size="sm" 
                                            variant="flat" 
                                            className="h-9 w-9 bg-gray-50 dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 hover:text-emerald-500 hover:bg-emerald-500/10 rounded-xl transition-all border border-gray-200 dark:border-white/5" 
                                            onPress={() => onEdit(category)}
                                        >
                                            <Edit size={14} />
                                        </Button>
                                        <Button 
                                            isIconOnly 
                                            size="sm" 
                                            variant="flat" 
                                            className="h-9 w-9 bg-gray-50 dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 hover:text-rose-500 hover:bg-rose-500/10 rounded-xl transition-all border border-gray-200 dark:border-white/5" 
                                            onPress={() => onDelete(String(category.id))}
                                        >
                                            <Trash2 size={14} />
                                        </Button>
                                    </div>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>

            {/* Pagination Premium Section */}
            {totalFiltered > 0 && (
                <div className="px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 shrink-0">
                    <div className="flex items-center gap-3 justify-center sm:justify-start">
                        <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none">
                            REGISTROS: <span className="text-gray-900 dark:text-white italic">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, totalFiltered)}</span> de <span className="text-emerald-500 italic">{totalFiltered}</span>
                        </p>
                        <div className="h-4 w-[1px] bg-gray-200 dark:border-white/10" />
                        <select 
                            value={pageSize} 
                            onChange={(e) => onPageSizeChange(Number(e.target.value))} 
                            className="bg-transparent text-gray-500 dark:text-zinc-400 text-[10px] font-black uppercase tracking-widest outline-none cursor-pointer hover:text-emerald-500 transition-colors"
                        >
                            {[10, 20, 50].map(n => <option key={n} value={n}>{n} FILAS</option>)}
                        </select>
                    </div>
                    
                    <div className="flex items-center justify-center gap-2">
                        <Button 
                            isIconOnly
                            size="sm" 
                            variant="flat" 
                            onPress={() => onPageChange(Math.max(1, currentPage - 1))} 
                            isDisabled={currentPage === 1} 
                            className="h-9 w-9 bg-white dark:bg-zinc-900 text-gray-400 dark:text-white border border-gray-200 dark:border-white/5 rounded-xl shadow-sm disabled:opacity-30"
                        >
                            <ChevronLeft size={16} />
                        </Button>
                        <div className="flex items-center gap-1 mx-2">
                           <span className="text-[11px] font-black text-emerald-500 italic tabular-nums">{currentPage}</span>
                           <span className="text-[9px] font-black text-gray-300 dark:text-zinc-700">/</span>
                           <span className="text-[11px] font-black text-gray-400 dark:text-white italic tabular-nums">{totalPages}</span>
                        </div>
                        <Button 
                            isIconOnly
                            size="sm" 
                            variant="flat" 
                            onPress={() => onPageChange(Math.min(totalPages, currentPage + 1))} 
                            isDisabled={currentPage === totalPages || totalPages === 0} 
                            className="h-9 w-9 bg-white dark:bg-zinc-900 text-gray-400 dark:text-white border border-gray-200 dark:border-white/5 rounded-xl shadow-sm disabled:opacity-30"
                        >
                            <ChevronRight size={16} />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
});

CategoryTable.displayName = 'CategoryTable';
export default CategoryTable;
