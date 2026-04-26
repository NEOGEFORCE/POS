"use client";

import React, { memo } from 'react';
import { Table, TableHeader, TableColumn, TableBody, TableRow, TableCell, Button, Card, CardBody, Chip } from "@heroui/react";
import { Layers, Tag, Minus, Plus, Trash2, Printer } from 'lucide-react';
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
        <Card className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 shadow-sm flex flex-col h-full rounded-lg" radius="sm">
            <CardBody className="p-0 flex flex-col h-full">
                {/* Header de la Cola */}
                <div className="p-4 border-b border-gray-100 dark:border-white/5 flex items-center justify-between bg-gray-50/50 dark:bg-zinc-950/20">
                    <div className="flex flex-col">
                        <span className="text-[10px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest italic flex items-center gap-2">
                             LISTA DE IMPRESIÓN
                        </span>
                        <div className="flex items-center gap-2 mt-1">
                            <Chip size="sm" color="success" variant="flat" className="h-4 font-black text-[8px] uppercase tracking-[0.2em] italic">
                                {printQueue.length} PRODUCTOS
                            </Chip>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button 
                            size="sm" 
                            variant="flat"
                            className="bg-emerald-500/10 text-emerald-500 text-[9px] font-black uppercase tracking-widest rounded-lg h-8 px-4 border border-emerald-500/20 hover:bg-emerald-500 hover:text-white transition-all italic" 
                            onPress={onAddAll}
                        >
                            <Layers size={14} className="mr-2" /> añadir todos
                        </Button>
                        <Button 
                            size="sm" 
                            variant="flat"
                            color="danger" 
                            className="text-[9px] font-black uppercase tracking-widest rounded-lg h-8 px-4 bg-rose-500/10 text-rose-500 border border-rose-500/10 italic" 
                            onPress={onClearAll}
                        >
                           limpiar
                        </Button>
                    </div>
                </div>

                {/* Lista de Productos */}
                <div className="flex-1 overflow-auto custom-scrollbar p-3">
                    {printQueue.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center gap-4 py-20 grayscale opacity-20">
                            <Printer size={80} strokeWidth={1} />
                            <div className="flex flex-col items-center">
                                <span className="text-xl font-black uppercase tracking-tighter italic">Cola Vacía</span>
                                <span className="text-[10px] font-bold uppercase tracking-widest">Busca productos para empezar</span>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {printQueue.map((item) => (
                                <div key={item.product.barcode} className="group p-2.5 rounded-xl border border-gray-100 dark:border-white/5 bg-gray-50 dark:bg-black/30 flex items-center justify-between gap-3 hover:border-emerald-500/30 transition-all">
                                    <div className="flex items-center gap-4 min-w-0">
                                        <div className="h-10 w-10 rounded-lg bg-white dark:bg-zinc-800 border border-gray-200 dark:border-white/10 flex items-center justify-center text-gray-400 font-black text-[8px] shadow-sm">
                                            #{item.product.barcode.slice(-4)}
                                        </div>
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-xs font-black text-gray-900 dark:text-white uppercase italic truncate tracking-tight">
                                                {item.product.productName}
                                            </span>
                                            <div className="flex items-center gap-2 mt-0.5">
                                                <span className="text-[10px] font-black text-emerald-500 tabular-nums tracking-tighter italic">${formatCurrency(item.product.salePrice)}</span>
                                                <span className="h-1 w-1 rounded-full bg-gray-300 dark:bg-zinc-700" />
                                                <span className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">PVP</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-4 shrink-0">
                                        <div className="flex items-center bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-white/5 p-1 shadow-sm">
                                            <Button 
                                                isIconOnly 
                                                size="sm" 
                                                variant="light" 
                                                className="h-7 w-7 min-w-0 rounded-lg text-gray-500 hover:bg-rose-500/10 hover:text-rose-500" 
                                                onPress={() => onUpdateQuantity(item.product.barcode, -1)}
                                            >
                                                <Minus size={14} />
                                            </Button>
                                            <div className="w-10 flex flex-col items-center">
                                                <span className="text-xs font-black tabular-nums text-gray-900 dark:text-white">{item.quantity}</span>
                                                <span className="text-[6px] font-bold text-gray-400 dark:text-zinc-600 uppercase tracking-tighter mt-[-2px]">CANT</span>
                                            </div>
                                            <Button 
                                                isIconOnly 
                                                size="sm" 
                                                variant="light" 
                                                className="h-7 w-7 min-w-0 rounded-lg text-emerald-500 hover:bg-emerald-500/10" 
                                                onPress={() => onUpdateQuantity(item.product.barcode, 1)}
                                            >
                                                <Plus size={14} />
                                            </Button>
                                        </div>
                                        <Button 
                                            isIconOnly 
                                            size="sm" 
                                            variant="flat" 
                                            className="h-9 w-9 bg-rose-500/10 text-rose-500 border border-rose-500/10 rounded-xl hover:bg-rose-500 hover:text-white transition-all shadow-sm" 
                                            onPress={() => onRemove(item.product.barcode)}
                                        >
                                            <Trash2 size={16} />
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </CardBody>
        </Card>
    );
});

LabelQueue.displayName = 'LabelQueue';

export default LabelQueue;
