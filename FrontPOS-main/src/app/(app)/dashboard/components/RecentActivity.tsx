"use client";

import { Card, CardHeader, CardBody, Chip } from "@heroui/react";
import { Clock, ReceiptText } from "lucide-react";
import { formatCurrency, formatTime } from "@/lib/utils";
import React from 'react';

interface RecentSale {
    id: string;
    total: number;
    date: string;
    client: string;
    payment_method?: string;
    transfer_source?: string;
    cash_amount?: number;
    transfer_amount?: number;
    credit_amount?: number;
}

interface RecentActivityProps {
    sales: RecentSale[];
}

export default function RecentActivity({ sales }: RecentActivityProps) {
    // 1. Proteccion Anti-Crash
    const safeSales = Array.isArray(sales) ? sales : [];
    const hasSales = safeSales.length > 0;

    return (
        <Card className="card-base border-none dark:bg-[#18181b]/50 border border-gray-200/80 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-colors flex flex-col min-h-[350px] h-full w-full" radius="lg">
            <CardHeader className="px-6 py-5 border-b border-gray-100 dark:border-white/5 flex justify-between items-center bg-gray-50/50 dark:bg-transparent shrink-0">
                <div className="flex items-center gap-3">
                    <div className="bg-sky-100 dark:bg-sky-500/10 p-2.5 rounded-2xl text-sky-600 dark:text-sky-500 border border-sky-200 dark:border-sky-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)]"><Clock size={18} /></div>
                    <div>
                        <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight">Ultimos Movimientos</h2>
                        <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Actividad en tiempo real</p>
                    </div>
                </div>
            </CardHeader>

            {/* flex-1 y min-h-0 aseguran que el scroll interno funcione sin romper el grid */}
            <CardBody className="p-0 flex-1 flex flex-col min-h-0">
                {!hasSales ? (
                    <div className="flex flex-col items-center justify-center flex-1 py-10 opacity-40 grayscale hover:grayscale-0 transition-all">
                        <ReceiptText size={48} strokeWidth={1.5} className="mb-4 text-sky-500" />
                        <p className="text-[11px] font-medium uppercase tracking-widest mt-2 text-center text-gray-500 dark:text-zinc-400">
                            Sin movimientos hoy<br />
                            <span className="text-[9px] font-bold">Esperando nuevas transacciones</span>
                        </p>
                    </div>
                ) : (
                    <div className="flex-1 overflow-y-auto custom-scrollbar w-full">
                        <table className="table-fixed w-full text-left text-sm">
                            <thead className="bg-gray-50 dark:bg-[#18181b]/80 text-[10px] font-medium uppercase tracking-widest text-gray-500 dark:text-zinc-400 sticky top-0 z-10">
                                <tr>
                                    <th className="w-[45%] px-6 py-3 border-b border-gray-200 dark:border-white/5 truncate">Cliente</th>
                                    <th className="w-[25%] px-4 py-3 border-b border-gray-200 dark:border-white/5 text-center truncate">Metodo</th>
                                    <th className="w-[30%] px-6 py-3 border-b border-gray-200 dark:border-white/5 text-right truncate">Total</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                                {/* 2. Limite a 18 para igualar tu panel de Stock */}
                                {safeSales.slice(0, 18).map((sale) => {
                                    const source = sale.transfer_source?.toUpperCase() || "NEQUI";
                                    const hasTransfer = (sale.transfer_amount || 0) > 0;
                                    const hasCash = (sale.cash_amount || 0) > 0;
                                    const hasCredit = (sale.credit_amount || 0) > 0;

                                    // Determinar Label (Sin "Mixto")
                                    let methodLabel = "EFECTIVO";
                                    if (hasTransfer && hasCash && hasCredit) methodLabel = `${source}+EFE+FIA`;
                                    else if (hasTransfer && hasCash) methodLabel = `${source}+EFE`;
                                    else if (hasTransfer && hasCredit) methodLabel = `${source}+FIA`;
                                    else if (hasCash && hasCredit) methodLabel = `EFE+FIA`;
                                    else if (hasTransfer) methodLabel = source;
                                    else if (hasCredit) methodLabel = "FIADO";

                                    // Determinar Color
                                    let chipColor = 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 dark:bg-white/5 dark:text-zinc-300';
                                    if (hasTransfer) {
                                        if (source.includes("NEQUI")) chipColor = 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-400';
                                        else if (source.includes("DAVIPLATA")) chipColor = 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400';
                                        else chipColor = 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-400';
                                    } else if (hasCredit) {
                                        chipColor = 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400';
                                    }

                                    // 3. Blindaje al formatear la fecha
                                    let displayDate = "Fecha N/A";
                                    let displayTime = "";
                                    try {
                                        if (sale.date) {
                                            const d = new Date(sale.date);
                                            displayDate = d.toLocaleDateString();
                                            displayTime = formatTime(d);
                                        }
                                    } catch (e) { }

                                    return (
                                        <tr key={sale.id || Math.random().toString()} className="hover:bg-sky-500/5 border-l-4 border-transparent hover:border-sky-500 transition-colors group">
                                            <td className="px-6 py-3 truncate">
                                                <p className="font-bold text-zinc-900 dark:text-zinc-50 uppercase tracking-tight truncate group-hover:text-sky-600 dark:group-hover:text-sky-400 transition-colors text-xs">
                                                    {sale.client || 'Consumidor Final'}
                                                </p>
                                                <span className="text-[9px] font-bold text-zinc-500 dark:text-zinc-400 tracking-widest">
                                                    {displayDate} {displayTime}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-center truncate">
                                                <Chip size="sm" variant="flat" className={chipColor} classNames={{ content: "text-[9px] font-medium uppercase tracking-widest" }}>
                                                    {methodLabel}
                                                </Chip>
                                            </td>
                                            <td className="px-6 py-3 text-right font-medium text-zinc-900 dark:text-zinc-50 tabular-nums tracking-tighter text-sm truncate">
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