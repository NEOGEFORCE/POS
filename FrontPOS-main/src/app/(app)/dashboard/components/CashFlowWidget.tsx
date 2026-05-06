"use client";

import React from 'react';
import { Card, CardBody, Progress, Chip } from "@heroui/react";
import { Wallet, ArrowUpRight, ArrowDownRight, Smartphone, Coins } from 'lucide-react';
import { formatCurrency } from "@/lib/utils";

interface CashFlowWidgetProps {
    data?: {
        income: Record<string, number>;
        expense: Record<string, number>;
        balance: number;
    };
}

export default function CashFlowWidget({ data }: CashFlowWidgetProps) {
    const income = data?.income || {};
    const expense = data?.expense || {};
    const balance = data?.balance || 0;

    const totalIncome = Object.values(income).reduce((a, b) => a + b, 0);
    const totalExpense = Object.values(expense).reduce((a, b) => a + b, 0);
    const progressRatio = totalIncome > 0 ? (totalExpense / totalIncome) * 100 : 0;

    const methods = [
        { key: 'EFECTIVO', label: 'Efectivo', icon: Coins, color: 'emerald' },
        { key: 'NEQUI', label: 'Nequi', icon: Smartphone, color: 'purple' },
        { key: 'DAVIPLATA', label: 'Daviplata', icon: Smartphone, color: 'rose' },
    ];

    return (
        <Card className="bg-white/90 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200 dark:border-white/5 shadow-xl h-full" radius="lg">
            <CardBody className="p-5">
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-emerald-500/10 rounded-xl">
                            <Wallet size={20} strokeWidth={2.5} className="text-emerald-500" />
                        </div>
                        <div>
                            <h3 className="text-sm font-black text-gray-900 dark:text-white uppercase tracking-tighter italic">Flujo <span className="text-emerald-500">Hoy</span></h3>
                            <p className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic leading-none">Ventas vs Egresos</p>
                        </div>
                    </div>
                    <Chip 
                        size="sm" 
                        variant="flat" 
                        color={balance >= 0 ? "success" : "danger"} 
                        className="font-black text-[9px] uppercase italic tracking-widest"
                    >
                        {balance >= 0 ? "POSITIVO" : "NEGATIVO"}
                    </Chip>
                </div>

                <div className="space-y-4">
                    {methods.map((method) => {
                        const mIncome = income[method.key] || 0;
                        const mExpense = expense[method.key] || 0;
                        const mBalance = mIncome - mExpense;

                        if (mIncome === 0 && mExpense === 0) return null;

                        return (
                            <div key={method.key} className="p-3 rounded-2xl bg-gray-50 dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                        <method.icon size={14} className={`text-${method.color}-500`} />
                                        <span className="text-[10px] font-black text-gray-700 dark:text-zinc-400 uppercase italic">{method.label}</span>
                                    </div>
                                    <span className={`text-[11px] font-black italic ${mBalance >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                        ${formatCurrency(mBalance)}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center text-[9px] font-bold uppercase italic">
                                    <div className="flex items-center gap-1 text-emerald-600/70 dark:text-emerald-500/50">
                                        <ArrowUpRight size={10} />
                                        <span>+${formatCurrency(mIncome)}</span>
                                    </div>
                                    <div className="flex items-center gap-1 text-rose-600/70 dark:text-rose-500/50">
                                        <ArrowDownRight size={10} />
                                        <span>-${formatCurrency(mExpense)}</span>
                                    </div>
                                </div>
                            </div>
                        );
                    })}

                    <div className="pt-4 border-t border-gray-100 dark:border-white/5">
                        <div className="flex justify-between items-end mb-2">
                            <span className="text-[10px] font-black text-gray-400 uppercase italic">Gasto vs Ingreso</span>
                            <span className="text-[10px] font-black text-rose-500 italic">{progressRatio.toFixed(1)}%</span>
                        </div>
                        <Progress 
                            value={progressRatio} 
                            color={progressRatio > 80 ? "danger" : "success"}
                            className="h-1.5"
                        />
                    </div>

                    <div className="flex flex-col items-center justify-center p-4 bg-emerald-500/5 rounded-2xl border border-emerald-500/10">
                        <span className="text-[8px] font-black text-emerald-600 dark:text-emerald-500 uppercase tracking-[0.3em] mb-1 italic">Balance Neto del Día</span>
                        <span className="text-2xl font-black text-gray-900 dark:text-white italic tracking-tighter">
                            ${formatCurrency(balance)}
                        </span>
                    </div>
                </div>
            </CardBody>
        </Card>
    );
}
