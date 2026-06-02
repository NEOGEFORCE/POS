"use client";

import React from 'react';
import { 
    AreaChart, Area, XAxis, YAxis, CartesianGrid, 
    Tooltip, ResponsiveContainer, Legend 
} from 'recharts';
import { Card, CardBody } from "@heroui/react";
import { TrendingUp, ArrowUpRight, ArrowDownRight } from "lucide-react";

interface AdvancedAnalyticsChartProps {
    data: {
        salesByMonth: Record<string, number>;
        expensesByMonth: Record<string, number>;
    };
}

export default function AdvancedAnalyticsChart({ data }: AdvancedAnalyticsChartProps) {
    if (!data) return null;

    // Transformar datos para Recharts
    const months = Array.from(new Set([
        ...Object.keys(data.salesByMonth || {}),
        ...Object.keys(data.expensesByMonth || {})
    ])).sort();

    const chartData = months.map(month => ({
        name: month,
        Ventas: data.salesByMonth[month] || 0,
        Gastos: data.expensesByMonth[month] || 0,
    }));

    const CustomTooltip = ({ active, payload, label }: any) => {
        if (active && payload && payload.length) {
            return (
                <div className="card-base border-none dark:bg-[#18181b]/90 border border-gray-200 dark:border-white/10 p-4 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                    <p className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest mb-2">{label}</p>
                    <div className="space-y-1.5">
                        {payload.map((entry: any, i: number) => (
                            <div key={i} className="flex items-center gap-3 justify-between">
                                <div className="flex items-center gap-2">
                                    <div className="w-2 h-2 rounded-2xl" style={{ backgroundColor: entry.color }} />
                                    <span className="text-xs font-bold text-gray-700 dark:text-zinc-300">{entry.name}</span>
                                </div>
                                <span className="text-xs font-medium text-zinc-900 dark:text-zinc-50">
                                    ${entry.value.toLocaleString()}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            );
        }
        return null;
    };

    return (
        <Card className="card-base border-none dark:bg-[#18181b]/50 border border-gray-200/80 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden" radius="lg">
            <CardBody className="p-4 md:p-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
                    <div className="flex items-center gap-3">
                        <div className="p-2.5 bg-white/5 rounded-2xl">
                            <TrendingUp className="h-6 w-6 text-zinc-900 dark:text-zinc-100" />
                        </div>
                        <div>
                            <h3 className="text-lg font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tighter">Analisis Comparativo</h3>
                            <p className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest">Ingresos vs Egresos Mensuales</p>
                        </div>
                    </div>
                    
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 border border-emerald-500/10">
                            <ArrowUpRight size={14} className="text-zinc-900 dark:text-zinc-100" />
                            <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 uppercase">Ventas</span>
                        </div>
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-2xl bg-violet-500/5 border border-violet-500/10">
                            <ArrowDownRight size={14} className="text-violet-500" />
                            <span className="text-[10px] font-medium text-violet-600 dark:text-violet-500 uppercase">Gastos</span>
                        </div>
                    </div>
                </div>

                <div className="h-[350px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                            <defs>
                                <linearGradient id="colorVentas" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                                </linearGradient>
                                <linearGradient id="colorGastos" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3}/>
                                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/>
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
                            <XAxis 
                                dataKey="name" 
                                axisLine={false}
                                tickLine={false}
                                tick={{ fill: '#71717a', fontSize: 10, fontWeight: 700 }}
                                dy={10}
                            />
                            <YAxis 
                                axisLine={false}
                                tickLine={false}
                                tick={{ fill: '#71717a', fontSize: 10, fontWeight: 700 }}
                            />
                            <Tooltip content={<CustomTooltip />} />
                            <Area 
                                type="monotone" 
                                dataKey="Ventas" 
                                stroke="#10b981" 
                                strokeWidth={3}
                                fillOpacity={1} 
                                fill="url(#colorVentas)" 
                            />
                            <Area 
                                type="monotone" 
                                dataKey="Gastos" 
                                stroke="#8b5cf6" 
                                strokeWidth={3}
                                fillOpacity={1} 
                                fill="url(#colorGastos)" 
                            />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            </CardBody>
        </Card>
    );
}
