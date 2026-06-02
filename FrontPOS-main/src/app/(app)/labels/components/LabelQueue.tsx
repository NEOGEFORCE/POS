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
        <Card className="card-base border-none shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col h-full rounded-2xl" radius="sm">
            <CardBody className="p-0 flex flex-col h-full">
                {/* Header de la Cola */}
                <div className="p-4 border-b border-gray-100 dark:border-white/5 flex items-center justify-between bg-gray-50/50 dark:bg-zinc-950/20">
                    <div className="flex flex-col">
                        <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest tracking-tight flex items-center gap-2">
                             LISTA DE IMPRESION
                        </span>
                        <div className="flex items-center gap-2 mt-1">
                            <Chip size="sm" color="success" variant="flat" className="h-4 font-medium text-[8px] uppercase tracking-[0.2em] tracking-tight">
                                {printQueue.length} PRODUCTOS
                            </Chip>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button 
                            size="sm" 
                            variant="flat"
                            className="bg-white/5 text-zinc-900 dark:text-zinc-100 text-[9px] font-medium uppercase tracking-widest rounded-2xl h-8 px-4 border border-emerald-500/20 hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 hover:text-white transition-all tracking-tight" 
                            onPress={onAddAll}
                        >
                            <Layers size={14} className="mr-2" /> anadir todos
                        </Button>
                        <Button 
                            size="sm" 
                            variant="flat"
                            color="danger" 
                            className="text-[9px] font-medium uppercase tracking-widest rounded-2xl h-8 px-4 bg-rose-500/10 text-rose-500 border border-rose-500/10 tracking-tight" 
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
                                <span className="text-xl font-medium uppercase tracking-tighter tracking-tight">Cola Vacia</span>
                                <span className="text-[10px] font-bold uppercase tracking-widest">Busca productos para empezar</span>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {printQueue.map((item) => (
                                <div key={item.product.barcode} className="group p-2.5 rounded-2xl border border-gray-100 dark:border-white/5 bg-gray-50 dark:bg-[#18181b] flex items-center justify-between gap-3 hover:border-emerald-500/30 transition-all">
                                    <div className="flex items-center gap-4 min-w-0">
                                        <div className="h-10 w-10 rounded-2xl bg-white dark:bg-zinc-800 border border-gray-200 dark:border-white/10 flex items-center justify-center text-gray-400 font-medium text-[8px] shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                            #{item.product.barcode.slice(-4)}
                                        </div>
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-xs font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight truncate tracking-tight">
                                                {item.product.productName}
                                            </span>
                                            <div className="flex items-center gap-2 mt-0.5">
                                                <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 tabular-nums tracking-tighter tracking-tight">${formatCurrency(item.product.salePrice)}</span>
                                                <span className="h-1 w-1 rounded-2xl bg-gray-300 dark:bg-zinc-700" />
                                                <span className="text-[9px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest">PVP</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-4 shrink-0">
                                        <div className="flex items-center card-base border-none rounded-2xl border border-gray-200 dark:border-white/5 p-1 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                            <Button 
                                                isIconOnly 
                                                size="sm" 
                                                variant="light" 
                                                className="h-7 w-7 min-w-0 rounded-2xl text-gray-500 hover:bg-rose-500/10 hover:text-rose-500" 
                                                onPress={() => onUpdateQuantity(item.product.barcode, -1)}
                                            >
                                                <Minus size={14} />
                                            </Button>
                                            <div className="w-10 flex flex-col items-center">
                                                <span className="text-xs font-medium tabular-nums text-zinc-900 dark:text-zinc-50">{item.quantity}</span>
                                                <span className="text-[6px] font-bold text-gray-400 dark:text-zinc-600 uppercase tracking-tighter mt-[-2px]">CANT</span>
                                            </div>
                                            <Button 
                                                isIconOnly 
                                                size="sm" 
                                                variant="light" 
                                                className="h-7 w-7 min-w-0 rounded-2xl text-zinc-900 dark:text-zinc-100 hover:bg-white/5" 
                                                onPress={() => onUpdateQuantity(item.product.barcode, 1)}
                                            >
                                                <Plus size={14} />
                                            </Button>
                                        </div>
                                        <Button 
                                            isIconOnly 
                                            size="sm" 
                                            variant="flat" 
                                            className="h-9 w-9 bg-rose-500/10 text-rose-500 border border-rose-500/10 rounded-2xl hover:bg-rose-500 hover:text-white transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)]" 
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
