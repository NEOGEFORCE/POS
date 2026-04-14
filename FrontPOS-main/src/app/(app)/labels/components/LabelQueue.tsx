"use client";

import React, { memo } from 'react';
import { Table, TableHeader, TableColumn, TableBody, TableRow, TableCell, Button } from "@heroui/react";
import { Layers, Tag, Minus, Plus, Trash2 } from 'lucide-react';
import { Product } from '@/lib/definitions';
import { formatCurrency } from '@/lib/utils';

interface PrintItem {
    product: Product;
    quantity: number;
}

interface QueueProps {
    printQueue: PrintItem[];
    onAddAll: () => void;
    onClearAll: () => void;
    onUpdateQuantity: (barcode: string, delta: number) => void;
    onRemove: (barcode: string) => void;
}

const LabelQueue = memo(({ printQueue, onAddAll, onClearAll, onUpdateQuantity, onRemove }: QueueProps) => {
    return (
        <div className="w-full md:w-2/3 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl shadow-sm flex flex-col min-h-0 transition-colors">
            <div className="p-4 border-b border-gray-100 dark:border-white/5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-gray-50/50 dark:bg-zinc-950/50 rounded-t-2xl">
                <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">Lista de Impresión</span>
                <div className="flex items-center gap-2">
                    <Button 
                        size="sm" 
                        className="bg-emerald-500 text-white text-[9px] font-black uppercase tracking-widest rounded-lg shadow-lg shadow-emerald-500/20" 
                        onPress={onAddAll}
                    >
                        <Layers size={14} className="mr-1" /> Añadir Todos
                    </Button>
                    <Button 
                        size="sm" 
                        variant="flat" 
                        color="danger" 
                        className="text-[9px] font-black uppercase tracking-widest rounded-lg bg-rose-50 dark:bg-rose-500/10 text-rose-500" 
                        onPress={onClearAll}
                    >
                        Limpiar Todo
                    </Button>
                </div>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar p-2">
                {printQueue.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center opacity-30 text-gray-500 dark:text-zinc-500">
                        <Tag size={60} strokeWidth={1} className="mb-4" />
                        <span className="text-[11px] font-black uppercase tracking-widest">Añade productos para imprimir</span>
                    </div>
                ) : (
                    <Table 
                        isCompact
                        removeWrapper 
                        aria-label="Cola" 
                        classNames={{ 
                            th: "bg-transparent text-gray-400 dark:text-zinc-500 font-black uppercase text-[9px] tracking-widest", 
                            td: "py-3 border-b border-gray-100 dark:border-white/5", 
                            tr: "hover:bg-gray-50 dark:hover:bg-white/5 transition-colors" 
                        }}
                    >
                        <TableHeader>
                            <TableColumn>PRODUCTO</TableColumn>
                            <TableColumn align="center">ETIQUETAS</TableColumn>
                            <TableColumn align="end">ACCIONES</TableColumn>
                        </TableHeader>
                        <TableBody>
                            {printQueue.map((item) => (
                                <TableRow key={item.product.barcode}>
                                    <TableCell>
                                        <div className="flex flex-col">
                                            <span className="text-xs font-black text-gray-900 dark:text-white uppercase italic truncate max-w-[200px] md:max-w-[300px]">
                                                {item.product.productName}
                                            </span>
                                            <span className="text-[9px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest mt-0.5">
                                                #{item.product.barcode} - ${formatCurrency(item.product.salePrice)}
                                            </span>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex items-center justify-center gap-3">
                                            <Button 
                                                isIconOnly 
                                                size="sm" 
                                                variant="flat" 
                                                className="h-8 w-8 rounded-lg bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-400 border border-gray-200 dark:border-white/5" 
                                                onPress={() => onUpdateQuantity(item.product.barcode, -1)}
                                            >
                                                <Minus size={12} />
                                            </Button>
                                            <span className="font-black text-sm tabular-nums w-4 text-center text-gray-900 dark:text-white">{item.quantity}</span>
                                            <Button 
                                                isIconOnly 
                                                size="sm" 
                                                variant="flat" 
                                                className="h-8 w-8 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 border border-emerald-200 dark:border-emerald-500/20" 
                                                onPress={() => onUpdateQuantity(item.product.barcode, 1)}
                                            >
                                                <Plus size={12} />
                                            </Button>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex justify-end">
                                            <Button 
                                                isIconOnly 
                                                size="sm" 
                                                variant="flat" 
                                                className="h-9 w-9 bg-rose-50 dark:bg-rose-500/10 text-rose-500 rounded-xl hover:bg-rose-500 hover:text-white transition-all shadow-sm" 
                                                onPress={() => onRemove(item.product.barcode)}
                                            >
                                                <Trash2 size={14} />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </div>
        </div>
    );
});

LabelQueue.displayName = 'LabelQueue';

export default LabelQueue;
