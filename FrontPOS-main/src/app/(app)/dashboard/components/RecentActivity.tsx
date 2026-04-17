"use client";

import { Card, CardHeader, CardBody, Chip } from "@heroui/react";
import { Clock } from "lucide-react";
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
    return (
        <Card className="bg-white/90 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200/80 dark:border-white/5 shadow-lg dark:shadow-2xl transition-colors shrink-0 h-full flex flex-col" radius="lg">
            <CardHeader className="px-6 py-5 border-b border-gray-100 dark:border-white/5 flex justify-between items-center bg-gray-50/50 dark:bg-transparent shrink-0">
                <div className="flex items-center gap-3">
                    <div className="bg-sky-100 dark:bg-sky-500/10 p-2.5 rounded-xl text-sky-600 dark:text-sky-500 border border-sky-200 dark:border-sky-500/20 shadow-sm"><Clock size={18} /></div>
                    <div>
                        <h2 className="text-base font-black text-gray-900 dark:text-white uppercase tracking-tight">Últimos Movimientos</h2>
                        <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Actividad en tiempo real</p>
                    </div>
                </div>
            </CardHeader>
            <CardBody className="p-0 flex-1 overflow-y-auto custom-scrollbar">
                <div className="hidden md:block">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-gray-50 dark:bg-zinc-900/80 text-[10px] font-black uppercase tracking-widest text-gray-500 dark:text-zinc-400 sticky top-0 z-10 backdrop-blur-md">
                            <tr>
                                <th className="px-6 py-3 border-b border-gray-200 dark:border-white/5">Cliente</th>
                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/5 text-center">Método</th>
                                <th className="px-6 py-3 border-b border-gray-200 dark:border-white/5 text-right">Total</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                            {(sales || []).slice(0, 8).map((sale) => {
                                const method = sale.transfer_source || sale.payment_method || 'EFECTIVO';
                                const chipColor = method === 'EFECTIVO' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400'
                                    : method === 'NEQUI' ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-400'
                                    : method === 'DAVIPLATA' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400'
                                    : 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-zinc-300';
                                return (
                                    <tr key={sale.id} className="hover:bg-gray-50 dark:hover:bg-white/[0.02] transition-colors group">
                                        <td className="px-6 py-3">
                                            <p className="font-bold text-gray-900 dark:text-white uppercase tracking-tight truncate max-w-[140px] group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors text-xs">{sale.client}</p>
                                            <span className="text-[9px] font-bold text-gray-400 dark:text-zinc-500 tracking-widest">{new Date(sale.date).toLocaleDateString()}</span>
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <Chip size="sm" variant="flat" className={chipColor} classNames={{ content: "text-[9px] font-black uppercase tracking-widest" }}>
                                                {method}
                                            </Chip>
                                        </td>
                                        <td className="px-6 py-3 text-right font-black text-gray-900 dark:text-white tabular-nums tracking-tighter text-sm">
                                            ${formatCurrency(sale.total)}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                {/* Mobile View: Vertical Feed */}
                <div className="md:hidden divide-y divide-gray-100 dark:divide-white/5">
                    {(sales || []).map((sale) => {
                         const method = sale.transfer_source || sale.payment_method || 'EFECTIVO';
                         const chipColor = method === 'EFECTIVO' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400'
                             : method === 'NEQUI' ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-400'
                             : method === 'DAVIPLATA' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400'
                             : 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-zinc-300';
                        return (
                            <div key={sale.id} className="p-4 flex items-center justify-between">
                                <div className="flex flex-col min-w-0">
                                    <p className="font-black text-gray-900 dark:text-white uppercase tracking-tight text-[11px] truncate leading-none">{sale.client}</p>
                                    <div className="flex items-center gap-2 mt-1">
                                        <span className="text-[8px] font-bold text-gray-400 dark:text-zinc-500 tracking-widest">{new Date(sale.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                        <Chip size="sm" variant="flat" className={`${chipColor} h-4`} classNames={{ content: "text-[7px] font-black uppercase tracking-widest px-1" }}>
                                            {method}
                                        </Chip>
                                    </div>
                                </div>
                                <span className="font-black text-gray-900 dark:text-white tabular-nums tracking-tighter text-sm">
                                    ${formatCurrency(sale.total)}
                                </span>
                            </div>
                        );
                    })}
                </div>
            </CardBody>
        </Card>
    );
}
