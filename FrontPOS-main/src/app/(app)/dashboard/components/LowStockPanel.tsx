"use client";
import React from 'react';
import { Card, CardHeader, CardBody, Chip } from "@heroui/react";
import { AlertCircle } from "lucide-react";
import { calculateStockHealth } from "@/lib/utils";

type StockStatus = 'CRITICAL' | 'REORDER' | 'STABLE';

interface LowStockItem {
    barcode: string;
    name: string;
    stock: number;
    minStock: number;
    threshold?: number;
    status?: string;
}

interface LowStockPanelProps {
    items: LowStockItem[];
}

export default function LowStockPanel({ items }: LowStockPanelProps) {
    const safeItems = (Array.isArray(items) ? items : []).map(item => ({
        ...item,
        // Forzamos el estado real basado en nuestra nueva logica frontend
        currentStatus: calculateStockHealth(item.stock, item.minStock)
    }));

    // Contadores reales para el titulo
    const criticalCount = safeItems.filter(i => i.currentStatus === 'CRITICAL').length;
    const warningCount = safeItems.filter(i => i.currentStatus === 'REORDER').length;

    // FILTRO DE RENDIMIENTO (TOP 18): Ordena poniendo los criticos arriba
    const priorityItems = safeItems
        .filter(item => item.currentStatus === 'CRITICAL' || item.currentStatus === 'REORDER')
        .sort((a, b) => (a.currentStatus === 'CRITICAL' ? -1 : 1))
        .slice(0, 18);

    return (
        <Card className="card-base border-none dark:bg-[#18181b]/50 border border-gray-200/80 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-colors flex flex-col min-h-[350px] h-full w-full" radius="lg">
            <CardHeader className="px-6 pt-6 pb-3 flex-shrink-0 border-b border-gray-100/50 dark:border-white/5">
                <div className="flex items-center gap-3">
                    <div className={`p-2.5 rounded-2xl border shadow-[0_8px_30px_rgb(0,0,0,0.12)] animate-pulse ${criticalCount > 0
                        ? 'bg-rose-100 dark:bg-rose-500/10 text-rose-600 dark:text-rose-500 border-rose-200 dark:border-rose-500/20'
                        : warningCount > 0
                            ? 'bg-amber-100 dark:bg-amber-500/10 text-amber-600 dark:text-amber-500 border-amber-200 dark:border-amber-500/20'
                            : 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 dark:bg-white/5 text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 border-emerald-200 dark:border-emerald-500/20'
                        }`}>
                        <AlertCircle size={20} strokeWidth={2.5} />
                    </div>
                    <div>
                        <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight">Radar de Agotados</h2>
                        <p className={`text-[10px] font-bold uppercase tracking-widest ${criticalCount > 0 ? 'text-rose-500 dark:text-rose-400' :
                            warningCount > 0 ? 'text-amber-500 dark:text-amber-400' :
                                'text-zinc-900 dark:text-zinc-100 dark:text-zinc-300'
                            }`}>
                            {criticalCount > 0 ? `${criticalCount} critico${criticalCount > 1 ? 's' : ''}` :
                                warningCount > 0 ? `${warningCount} reorden${warningCount > 1 ? 'es' : ''}` :
                                    `0 alertas prioritarias`}
                        </p>
                    </div>
                </div>
            </CardHeader>

            <CardBody className="p-0 flex-1 flex flex-col">
                {priorityItems.length === 0 ? (
                    <div className="flex flex-col items-center justify-center flex-1 min-h-[200px] py-10 opacity-40">
                        <AlertCircle size={48} strokeWidth={1.5} className="mb-4 text-zinc-900 dark:text-zinc-100" />
                        <p className="text-[11px] font-medium uppercase tracking-widest mt-2 text-center text-gray-500 dark:text-zinc-400">
                            Inventario Sano<br />
                            <span className="text-[9px] font-bold">Todos los niveles por encima del 50%</span>
                        </p>
                    </div>
                ) : (
                    <div className="w-full">
                        <table className="w-full text-left text-sm table-fixed">
                            <thead className="bg-gray-50 dark:bg-[#18181b]/80 text-[10px] font-medium uppercase tracking-widest text-gray-500 dark:text-zinc-400">
                                <tr>
                                    <th className="w-[50%] px-4 py-3 border-b border-gray-200 dark:border-white/5">Producto</th>
                                    <th className="w-[15%] px-4 py-3 border-b border-gray-200 dark:border-white/5 text-center">Cant.</th>
                                    <th className="w-[15%] px-4 py-3 border-b border-gray-200 dark:border-white/5 text-center">Meta</th>
                                    <th className="w-[20%] px-4 py-3 border-b border-gray-200 dark:border-white/5 text-center">Radar</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                                {priorityItems.map((item) => {
                                    const isCritical = item.currentStatus === 'CRITICAL';
                                    return (
                                        <tr key={item.barcode} className="hover:bg-zinc-50 dark:hover:bg-white/5 bg-white dark:bg-transparent border border-zinc-200 dark:border-white/5 border-l-4 border-transparent hover:border-emerald-500 transition-colors">
                                            <td className="px-4 py-3 truncate">
                                                <p className="font-bold text-zinc-900 dark:text-zinc-50 uppercase tracking-tight text-xs truncate">{item.name}</p>
                                                <span className="text-[9px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 tracking-widest truncate">{item.barcode}</span>
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                <span className={`text-sm font-medium tabular-nums ${isCritical ? 'text-rose-500' : 'text-amber-500'}`}>{item.stock}</span>
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                <span className="text-sm font-bold text-gray-500 dark:text-zinc-400 tabular-nums">{item.minStock}</span>
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                <Chip size="sm" variant="flat"
                                                    className={isCritical
                                                        ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400'
                                                        : 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400'}
                                                    classNames={{ content: "text-[9px] font-medium uppercase tracking-widest px-1" }}
                                                >
                                                    {isCritical ? 'CRITICO' : 'REORDEN'}
                                                </Chip>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}