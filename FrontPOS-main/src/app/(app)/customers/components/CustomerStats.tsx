"use client";

import React, { memo } from 'react';
import { Users, Wallet, AlertCircle } from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';

const dummyData = [
    { pv: 2400 },
    { pv: 1398 },
    { pv: 9800 },
    { pv: 3908 },
    { pv: 4800 },
    { pv: 3800 },
    { pv: 4300 },
];

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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 shrink-0">
            {stats.map((k, i) => (
                <div key={i} className="relative bg-white/80 dark:bg-zinc-900/50 backdrop-blur-xl p-4 border border-gray-200 dark:border-white/5 rounded-[2rem] flex items-center justify-between shadow-lg overflow-hidden group cursor-pointer transition-all hover:scale-[1.02] hover:border-emerald-500/30">
                    {/* Background Sparkline */}
                    <div className="absolute inset-0 opacity-10 dark:opacity-20 translate-y-4 group-hover:translate-y-2 group-hover:scale-y-110 transition-all duration-700 pointer-events-none">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={dummyData}>
                                <Area 
                                    type="monotone" 
                                    dataKey="pv" 
                                    stroke={k.color === 'rose' ? '#f43f5e' : k.color === 'emerald' ? '#10b981' : '#f59e0b'} 
                                    fill={k.color === 'rose' ? '#f43f5e' : k.color === 'emerald' ? '#10b981' : '#f59e0b'}
                                    strokeWidth={2}
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>

                    <div className="flex flex-col min-w-0 relative z-10">
                        <span className="text-[10px] font-black text-gray-500 dark:text-zinc-400 uppercase tracking-[0.2em] leading-none mb-2 group-hover:text-emerald-500 transition-colors">{k.label}</span>
                        <div className="flex items-baseline gap-2">
                          <span className={`text-2xl font-black tabular-nums tracking-tighter italic ${
                              k.color === 'rose' ? 'text-rose-500' : k.color === 'emerald' ? 'text-emerald-500' : 'text-amber-500'
                          }`}>
                              {k.val}
                          </span>
                          <span className="text-[9px] font-bold text-gray-400 dark:text-zinc-500 uppercase opacity-0 group-hover:opacity-100 transition-opacity tracking-widest">{k.sub}</span>
                        </div>
                    </div>
                    <div className={`p-4 rounded-[1.2rem] shadow-xl backdrop-blur-md relative z-10 ${
                        k.color === 'rose' ? 'bg-rose-500/10 text-rose-500 shadow-rose-500/20' : k.color === 'emerald' ? 'bg-emerald-500/10 text-emerald-500 shadow-emerald-500/20' : 'bg-amber-500/10 text-amber-500 shadow-amber-500/20'
                    } transition-transform group-hover:-rotate-6`}>
                        <k.icon size={28} />
                    </div>
                </div>
            ))}
        </div>
    );
});

CustomerStats.displayName = 'CustomerStats';
export default CustomerStats;
