"use client";

import { Card, CardHeader, CardBody, Chip } from "@heroui/react";
import { AlertCircle } from "lucide-react";
import React from 'react';

type StockStatus = 'CRITICAL' | 'WARNING' | 'OPTIMAL';

interface LowStockItem {
    barcode: string;
    name: string;
    stock: number;
    minStock: number;
    threshold: number;
    status: StockStatus;
}

interface LowStockPanelProps {
    items: LowStockItem[];
}

export default function LowStockPanel({ items }: LowStockPanelProps) {
    if (!items || items.length === 0) return null;

    const criticalCount = items.filter(i => i.status === 'CRITICAL').length;
    const warningCount = items.filter(i => i.status === 'WARNING').length;

    return (
    <Card className="bg-white/90 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200/80 dark:border-white/5 shadow-lg dark:shadow-2xl transition-colors shrink-0 flex flex-col h-fit" radius="lg">
        <CardHeader className="px-6 pt-6 pb-3 flex-shrink-0">
            <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl border shadow-sm animate-pulse ${
                    criticalCount > 0 
                        ? 'bg-rose-100 dark:bg-rose-500/10 text-rose-600 dark:text-rose-500 border-rose-200 dark:border-rose-500/20'
                        : warningCount > 0
                            ? 'bg-amber-100 dark:bg-amber-500/10 text-amber-600 dark:text-amber-500 border-amber-200 dark:border-amber-500/20'
                            : 'bg-emerald-100 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 border-emerald-200 dark:border-emerald-500/20'
                }`}>
                    <AlertCircle size={20} strokeWidth={2.5} />
                </div>
                <div>
                    <h2 className="text-base font-black text-gray-900 dark:text-white uppercase tracking-tight">Alertas de Stock</h2>
                    <p className={`text-[10px] font-bold uppercase tracking-widest ${
                        criticalCount > 0 ? 'text-rose-500 dark:text-rose-400' : 
                        warningCount > 0 ? 'text-amber-500 dark:text-amber-400' : 
                        'text-emerald-500 dark:text-emerald-400'
                    }`}>
                        {criticalCount > 0 ? `${criticalCount} crítico${criticalCount > 1 ? 's' : ''}` : 
                         warningCount > 0 ? `${warningCount} advertencia${warningCount > 1 ? 's' : ''}` : 
                         `${items.length} producto${items.length !== 1 ? 's' : ''}`}
                    </p>
                </div>
            </div>
        </CardHeader>
        <CardBody className="px-6 pb-6 pt-0 flex-1 min-h-0">
            <div className="hidden md:block">
                <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 dark:bg-zinc-900/80 text-[10px] font-black uppercase tracking-widest text-gray-500 dark:text-zinc-400 sticky top-0 z-20">
                        <tr>
                            <th className="px-4 py-3 rounded-l-xl">Producto</th>
                            <th className="px-4 py-3 text-center">Stock Actual</th>
                            <th className="px-4 py-3 text-center">Stock Mínimo</th>
                            <th className="px-4 py-3 text-center rounded-r-xl">Estado</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                        {items.slice(0, 10).map((item) => {
                            const isCritical = item.status === 'CRITICAL';
                            const isWarning = item.status === 'WARNING';
                            return (
                                <tr key={item.barcode} className="hover:bg-emerald-500/5 border-l-4 border-transparent hover:border-emerald-500 transition-colors">
                                    <td className="px-4 py-3">
                                        <p className="font-bold text-gray-900 dark:text-white uppercase tracking-tight text-xs truncate max-w-[200px]">{item.name}</p>
                                        <span className="text-[9px] font-bold text-gray-400 dark:text-zinc-500 tracking-widest">{item.barcode}</span>
                                    </td>
                                    <td className="px-4 py-3 text-center">
                                        <span className={`text-sm font-black tabular-nums ${isCritical ? 'text-rose-500' : 'text-amber-500'}`}>{item.stock}</span>
                                    </td>
                                    <td className="px-4 py-3 text-center">
                                        <span className="text-sm font-bold text-gray-500 dark:text-zinc-400 tabular-nums">{item.minStock}</span>
                                    </td>
                                    <td className="px-4 py-3 text-center">
                                        <Chip size="sm" variant="flat"
                                            className={isCritical
                                                ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400'
                                                : 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400'}
                                            classNames={{ content: "text-[9px] font-black uppercase tracking-widest" }}
                                        >
                                            {isCritical ? 'CRÍTICO' : 'BAJO'}
                                        </Chip>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Mobile View: Vertical Cards */}
            <div className="md:hidden space-y-3">
                {items.slice(0, 10).map((item) => {
                    const isCritical = item.status === 'CRITICAL';
                    return (
                        <div key={item.barcode} className="p-4 rounded-2xl bg-gray-50 dark:bg-zinc-900/50 border border-gray-100 dark:border-white/5 flex flex-col gap-2">
                            <div className="flex justify-between items-start">
                                <div className="min-w-0">
                                    <p className="font-black text-gray-900 dark:text-white uppercase tracking-tight text-[11px] truncate leading-none">{item.name}</p>
                                    <span className="text-[9px] font-bold text-gray-400 dark:text-zinc-500 tracking-widest uppercase">{item.barcode}</span>
                                </div>
                                <Chip size="sm" variant="flat"
                                    className={isCritical
                                        ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400'
                                        : 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400'}
                                    classNames={{ content: "text-[8px] font-black uppercase tracking-widest px-1" }}
                                >
                                    {isCritical ? 'CRÍTICO' : 'BAJO'}
                                </Chip>
                            </div>
                            <div className="flex items-center justify-between border-t border-gray-100 dark:border-white/5 pt-2">
                                <div className="flex flex-col">
                                    <span className="text-[8px] font-black text-gray-400 uppercase tracking-widest">Actual</span>
                                    <span className={`text-sm font-black tabular-nums ${isCritical ? 'text-rose-500' : 'text-amber-500'}`}>{item.stock}</span>
                                </div>
                                <div className="flex flex-col items-end">
                                    <span className="text-[8px] font-black text-gray-400 uppercase tracking-widest">Mínimo</span>
                                    <span className="text-sm font-bold text-gray-900 dark:text-white tabular-nums">{item.minStock}</span>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </CardBody>
    </Card>
    );
}
