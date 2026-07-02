"use client";

import React from 'react';
import { Card, CardBody, Progress, Chip } from "@heroui/react";
import { Wallet, ArrowUpRight, ArrowDownRight, Smartphone, Coins } from 'lucide-react';
import { formatCurrency } from "@/lib/utils";
import { MoneyDigits } from "@/components/ui/motion";

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
        <Card className="card-featured h-full" radius="none" style={{ borderRadius: '1rem' }}>
            <CardBody className="p-5">
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 flex items-center justify-center rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-white/8 text-gray-500 dark:text-zinc-500 dark:text-zinc-400 shrink-0">
                            <Wallet size={18} />
                        </div>
                        <div>
                            <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-50 tracking-tight">Flujo <span className="text-zinc-900 dark:text-zinc-100">Hoy</span></h3>
                            <p className="text-[11px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest leading-none mt-1">Ventas vs Egresos</p>
                        </div>
                    </div>
                    <Chip 
                        size="sm" 
                        variant="flat" 
                        color={balance >= 0 ? "success" : "danger"} 
                        className="font-medium text-[9px] uppercase tracking-tight tracking-widest"
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
                            <div key={method.key} className="p-3 rounded-2xl bg-zinc-100 dark:bg-zinc-800/30 border border-zinc-200 dark:border-white/5">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                        <method.icon size={14} className="text-gray-500 dark:text-zinc-500 dark:text-zinc-400" />
                                        <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-tight">{method.label}</span>
                                    </div>
                                    <span className={`text-[11px] font-medium tracking-tight font-['DM_Mono'] ${mBalance >= 0 ? 'text-zinc-900 dark:text-zinc-100' : 'text-rose-500'}`}>
                                        <MoneyDigits value={mBalance} />
                                    </span>
                                </div>
                                <div className="flex justify-between items-center text-[9px] font-bold uppercase tracking-tight font-['DM_Mono']">
                                    <div className="flex items-center gap-1 text-zinc-900 dark:text-zinc-100/50">
                                        <ArrowUpRight size={10} />
                                        <span>+<MoneyDigits value={mIncome} /></span>
                                    </div>
                                    <div className="flex items-center gap-1 text-rose-500/50">
                                        <ArrowDownRight size={10} />
                                        <span>-<MoneyDigits value={mExpense} /></span>
                                    </div>
                                </div>
                            </div>
                        );
                    })}

                    <div className="pt-4 border-t border-zinc-200 dark:border-white/5">
                        <div className="flex justify-between items-end mb-2">
                            <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-tight">Gasto vs Ingreso</span>
                            <span className="text-[10px] font-medium text-rose-500 tracking-tight">{progressRatio.toFixed(1)}%</span>
                        </div>
                        <Progress 
                            value={progressRatio} 
                            color={progressRatio > 80 ? "danger" : "success"}
                            className="h-1.5"
                        />
                    </div>

                    <div className="flex flex-col items-center justify-center p-4 bg-zinc-100 dark:bg-zinc-800/50 border border-zinc-200 dark:border-white/5 rounded-xl">
                        <span className="text-[11px] font-medium tracking-widest uppercase text-gray-500 dark:text-zinc-500 mb-1">Balance Neto del Dia</span>
                        <span className="text-3xl font-light tracking-tight text-zinc-900 dark:text-zinc-50 tabular-nums font-['DM_Mono']">
                            <MoneyDigits value={balance} duration={1.6} />
                        </span>
                    </div>
                </div>
            </CardBody>
        </Card>
    );
}
