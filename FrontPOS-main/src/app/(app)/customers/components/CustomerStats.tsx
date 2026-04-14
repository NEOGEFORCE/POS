"use client";

import React, { memo } from 'react';
import { Users, Wallet, AlertCircle } from 'lucide-react';

interface StatsProps {
    totalDebt: number;
    totalClients: number;
    withDebt: number;
}

const CustomerStats = memo(({ totalDebt, totalClients, withDebt }: StatsProps) => {
    const stats = [
        { label: "CARTERA TOTAL", val: `$${totalDebt.toLocaleString()}`, color: "rose", icon: Wallet, sub: "SALDO PENDIENTE" },
        { label: "BASE DE DATOS", val: totalClients, color: "emerald", icon: Users, sub: "CLIENTES ACTIVOS" },
        { label: "EN MORA", val: withDebt, color: "amber", icon: AlertCircle, sub: "CUENTAS ABIERTAS" }
    ];

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-1 shrink-0">
            {stats.map((k, i) => (
                <div key={i} className="bg-white dark:bg-zinc-900 p-3 border border-gray-200 dark:border-white/5 rounded-xl flex items-center justify-between shadow-sm transition-all hover:border-emerald-500/30 group cursor-pointer">
                    <div className="flex flex-col min-w-0">
                        <span className="text-[8px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none mb-1 group-hover:text-emerald-500 transition-colors tracking-tighter">{k.label}</span>
                        <div className="flex items-baseline gap-2">
                          <span className={`text-lg font-black tabular-nums tracking-tighter italic ${
                              k.color === 'rose' ? 'text-rose-500' : k.color === 'emerald' ? 'text-emerald-500' : 'text-amber-500'
                          }`}>
                              {k.val}
                          </span>
                          <span className="text-[7px] font-bold text-gray-400 dark:text-zinc-600 uppercase opacity-0 group-hover:opacity-100 transition-opacity tracking-widest">{k.sub}</span>
                        </div>
                    </div>
                    <div className={`p-2 rounded-lg ${
                        k.color === 'rose' ? 'bg-rose-500/10 text-rose-500' : k.color === 'emerald' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
                    } transition-transform group-hover:scale-110`}>
                        <k.icon size={16} />
                    </div>
                </div>
            ))}
        </div>
    );
});

CustomerStats.displayName = 'CustomerStats';
export default CustomerStats;
