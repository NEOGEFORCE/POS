"use client";

import { Card, CardHeader, CardBody } from "@heroui/react";
import { BarChart3, DollarSign } from "lucide-react";
import { 
    Area, AreaChart, CartesianGrid, XAxis, YAxis, ResponsiveContainer, 
    PieChart, Pie, Cell, Tooltip 
} from "recharts";
import { formatCurrency } from "@/lib/utils";
import React from 'react';

// internal component for reuse
function ProgressRing({ percentage, size = 80, strokeWidth = 8, color = "#10b981", label }: {
    percentage: number; size?: number; strokeWidth?: number; color?: string; label: string;
}) {
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (percentage / 100) * circumference;

    return (
        <div className="flex flex-col items-center gap-2">
            <div className="relative" style={{ width: size, height: size }}>
                <svg width={size} height={size} className="transform -rotate-90">
                    <circle cx={size / 2} cy={size / 2} r={radius} stroke="currentColor" strokeWidth={strokeWidth}
                        fill="none" className="text-gray-200 dark:text-zinc-800" />
                    <circle cx={size / 2} cy={size / 2} r={radius} stroke={color} strokeWidth={strokeWidth}
                        fill="none" strokeDasharray={circumference} strokeDashoffset={offset}
                        strokeLinecap="round" className="transition-all duration-1000 ease-out" />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-lg font-medium text-zinc-900 dark:text-zinc-50 tabular-nums">{Math.round(percentage)}%</span>
                </div>
            </div>
            <span className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest text-center leading-tight">{label}</span>
        </div>
    );
}

interface DashboardChartsProps {
    dailySalesLast7: any[];
    salesByPayment: Record<string, number>;
    stockHealth: number;
    stockHealthColor: string;
}

const PAYMENT_COLORS: Record<string, string> = {
    'EFECTIVO': '#10b981',
    'NEQUI': '#8b5cf6',
    'DAVIPLATA': '#f43f5e',
    'TRANSFERENCIA': '#f59e0b',
    'FIADO': '#ef4444',
};

const getPaymentColor = (method: string) => PAYMENT_COLORS[method] || '#6b7280';

export default function DashboardCharts({ 
    dailySalesLast7, 
    salesByPayment, 
    stockHealth, 
    stockHealthColor 
}: DashboardChartsProps) {
    
    const dailyChartData = dailySalesLast7?.map((d) => ({
        day: new Date(d.date + 'T12:00:00').toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric' }).toUpperCase(),
        ventas: d.amount,
    })) || [];

    const paymentDonutData = salesByPayment
        ? Object.entries(salesByPayment)
            .filter(([method]) => method !== 'MIXTO' && method !== 'MIXED')
            .map(([method, amount]) => ({
                name: method,
                value: amount,
                color: getPaymentColor(method),
            }))
        : [];

    const totalPayments = paymentDonutData.reduce((s, d) => s + d.value, 0);

    return (
        <div className="grid gap-6 grid-cols-1 shrink-0">
            {/* --- Donut Metodos de Pago + Progress Rings --- */}
            <Card className="col-span-1 card-base border-none dark:bg-[#18181b]/50 border border-gray-200/80 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-colors" radius="lg">
                <CardHeader className="px-6 pt-6 pb-2">
                    <div className="flex items-center gap-3">
                        <div className="bg-violet-100 dark:bg-violet-500/10 p-2.5 rounded-2xl text-violet-600 dark:text-violet-500 border border-violet-200 dark:border-violet-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)]"><DollarSign size={18} /></div>
                        <div>
                            <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight">Metodos de Pago</h2>
                            <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Distribucion del mes</p>
                        </div>
                    </div>
                </CardHeader>
                <CardBody className="px-6 pb-6 pt-0">
                    {paymentDonutData.length > 0 ? (
                        <div className="flex flex-col items-center gap-4 mt-2">
                            <div className="relative h-[160px] w-[160px]">
                                <ResponsiveContainer width="100%" height="100%">
                                    <PieChart>
                                        <Pie
                                            data={paymentDonutData}
                                            cx="50%" cy="50%"
                                            innerRadius={50} outerRadius={72}
                                            paddingAngle={3}
                                            dataKey="value"
                                            stroke="none"
                                        >
                                            {paymentDonutData.map((entry, idx) => (
                                                <Cell key={idx} fill={entry.color} />
                                            ))}
                                        </Pie>
                                        <Tooltip
                                            contentStyle={{ background: 'rgba(0,0,0,0.85)', border: 'none', borderRadius: '12px', padding: '8px 12px', fontSize: 11 }}
                                            formatter={(value: number) => [`$${formatCurrency(value)}`, '']}
                                        />
                                    </PieChart>
                                </ResponsiveContainer>
                                <div className="absolute inset-0 flex flex-col items-center justify-center">
                                    <span className="text-lg font-medium text-zinc-900 dark:text-zinc-50 tabular-nums tracking-tighter">${formatCurrency(totalPayments)}</span>
                                    <span className="text-[8px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest">Total</span>
                                </div>
                            </div>

                            {/* Legend */}
                            <div className="flex flex-wrap gap-x-4 gap-y-1.5 justify-center">
                                {paymentDonutData.map((d) => (
                                    <div key={d.name} className="flex items-center gap-1.5">
                                        <div className="w-2.5 h-2.5 rounded-2xl" style={{ background: d.color }} />
                                        <span className="text-[9px] font-bold text-gray-600 dark:text-zinc-400 uppercase tracking-wider">{d.name}</span>
                                    </div>
                                ))}
                            </div>

                            {/* Progress Ring - Stock Health */}
                            <div className="border-t border-gray-100 dark:border-white/5 pt-4 w-full flex justify-center">
                                <ProgressRing percentage={stockHealth} color={stockHealthColor} label="Salud del Inventario" />
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center h-40 gap-2">
                            <DollarSign className="h-8 w-8 text-gray-300 dark:text-zinc-700" />
                            <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest">Sin datos de pago</p>
                        </div>
                    )}
                </CardBody>
            </Card>
        </div>
    );
}
