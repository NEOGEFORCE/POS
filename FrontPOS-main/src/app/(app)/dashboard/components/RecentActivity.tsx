"use client";

import { Card, CardHeader, CardBody, Chip } from "@heroui/react";
import { Clock, ReceiptText } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import React from 'react';

interface RecentSale {
    id: string;
    total: number;
    date: string;
    client: string;
    payment_method?: string;
    transfer_source?: string;
}

interface RecentActivityProps {
    sales: RecentSale[];
}

export default function RecentActivity({ sales }: RecentActivityProps) {
    // 1. Protección Anti-Crash
    const safeSales = Array.isArray(sales) ? sales : [];
    const hasSales = safeSales.length > 0;

    return (
        <Card className="bg-white/90 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200/80 dark:border-white/5 shadow-lg dark:shadow-2xl transition-colors flex flex-col min-h-[350px] h-full w-full" radius="lg">
            <CardHeader className="px-6 py-5 border-b border-gray-100 dark:border-white/5 flex justify-between items-center bg-gray-50/50 dark:bg-transparent shrink-0">
                <div className="flex items-center gap-3">
                    <div className="bg-sky-100 dark:bg-sky-500/10 p-2.5 rounded-xl text-sky-600 dark:text-sky-500 border border-sky-200 dark:border-sky-500/20 shadow-sm"><Clock size={18} /></div>
                    <div>
                        <h2 className="text-base font-black text-gray-900 dark:text-white uppercase tracking-tight">Últimos Movimientos</h2>
                        <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Actividad en tiempo real</p>
                    </div>
                </div>
            </CardHeader>

            {/* flex-1 y min-h-0 aseguran que el scroll interno funcione sin romper el grid */}
            <CardBody className="p-0 flex-1 flex flex-col min-h-0">
                {!hasSales ? (
                    <div className="flex flex-col items-center justify-center flex-1 py-10 opacity-40 grayscale hover:grayscale-0 transition-all">
                        <ReceiptText size={48} strokeWidth={1.5} className="mb-4 text-sky-500" />
                        <p className="text-[11px] font-black uppercase tracking-widest mt-2 text-center text-gray-500 dark:text-zinc-400">
                            Sin movimientos hoy<br />
                            <span className="text-[9px] font-bold">Esperando nuevas transacciones</span>
                        </p>
                    </div>
                ) : (
                    <div className="flex-1 overflow-y-auto custom-scrollbar w-full">
                        <table className="table-fixed w-full text-left text-sm">
                            <thead className="bg-gray-50 dark:bg-zinc-900/80 text-[10px] font-black uppercase tracking-widest text-gray-500 dark:text-zinc-400 sticky top-0 z-10 backdrop-blur-md">
                                <tr>
                                    <th className="w-[45%] px-6 py-3 border-b border-gray-200 dark:border-white/5 truncate">Cliente</th>
                                    <th className="w-[25%] px-4 py-3 border-b border-gray-200 dark:border-white/5 text-center truncate">Método</th>
                                    <th className="w-[30%] px-6 py-3 border-b border-gray-200 dark:border-white/5 text-right truncate">Total</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                                {/* 2. Límite a 18 para igualar tu panel de Stock */}
                                {safeSales.slice(0, 18).map((sale) => {
                                    const method = sale.transfer_source || sale.payment_method || 'EFECTIVO';
                                    const chipColor = method === 'EFECTIVO' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400'
                                        : method === 'NEQUI' ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-400'
                                            : method === 'DAVIPLATA' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400'
                                                : 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-zinc-300';

                                    // 3. Blindaje al formatear la fecha
                                    let displayDate = "Fecha N/A";
                                    let displayTime = "";
                                    try {
                                        if (sale.date) {
                                            const d = new Date(sale.date);
                                            displayDate = d.toLocaleDateString();
                                            displayTime = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                                        }
                                    } catch (e) { }

                                    return (
                                        <tr key={sale.id || Math.random().toString()} className="hover:bg-sky-500/5 border-l-4 border-transparent hover:border-sky-500 transition-colors group">
                                            <td className="px-6 py-3 truncate">
                                                <p className="font-bold text-gray-900 dark:text-white uppercase tracking-tight truncate group-hover:text-sky-600 dark:group-hover:text-sky-400 transition-colors text-xs">
                                                    {sale.client || 'Consumidor Final'}
                                                </p>
                                                <span className="text-[9px] font-bold text-gray-400 dark:text-zinc-500 tracking-widest">
                                                    {displayDate} {displayTime}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-center truncate">
                                                <Chip size="sm" variant="flat" className={chipColor} classNames={{ content: "text-[9px] font-black uppercase tracking-widest" }}>
                                                    {method}
                                                </Chip>
                                            </td>
                                            <td className="px-6 py-3 text-right font-black text-gray-900 dark:text-white tabular-nums tracking-tighter text-sm truncate">
                                                ${formatCurrency(sale.total || 0)}
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