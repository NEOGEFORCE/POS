"use client";

import React, { memo } from 'react';
import { TrendingDown, CreditCard, Activity, DollarSign, HandCoins, ChevronRight } from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import { MoneyDigits, NumberDigits } from "@/components/ui/motion";

interface StatsProps {
  totalMonth: number;
  topSource: string;
  count: number;
  totalPending: number;
  onOpenPending: () => void;
}

const dummyData = [
    { pv: 4200 },
    { pv: 7398 },
    { pv: 2800 },
    { pv: 5908 },
    { pv: 1800 },
    { pv: 6800 },
    { pv: 3300 },
];


const AnalyticalCard = ({ 
    label, 
    value, 
    subValue, 
    icon: Icon, 
    color, 
    chartData, 
    isCurrency = false,
    onClick
}: { 
    label: string, 
    value: string | number, 
    subValue: string, 
    icon: any, 
    color: string, 
    chartData?: any[],
    isCurrency?: boolean,
    onClick?: () => void
}) => {
    const isNumber = typeof value === 'number';
    return (
    <div 
        onClick={onClick}
        className={`relative group flex-1 card-base border-none dark:bg-[#18181b]/50  p-3.5 border border-gray-200 dark:border-white/5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden shadow-rose-500/5 transition-all hover:scale-[1.02] hover:border-rose-500/20 ${onClick ? 'cursor-pointer active:scale-95' : ''}`}
    >
        {/* Background Sparkline */}
        {chartData && (
            <div className="absolute inset-x-0 bottom-0 h-6 sm:h-10 opacity-30 dark:opacity-20 pointer-events-none">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                        <defs>
                            <linearGradient id={`color-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={color} stopOpacity={0.8}/>
                                <stop offset="95%" stopColor={color} stopOpacity={0}/>
                            </linearGradient>
                        </defs>
                        <Area 
                            type="monotone" 
                            dataKey="pv" 
                            stroke={color} 
                            fillOpacity={1} 
                            fill={`url(#color-${color.replace('#', '')})`} 
                            strokeWidth={2}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        )}

        <div className="relative z-10">
            <div className="flex justify-between items-start mb-2 sm:mb-3">
                <div className={`p-1.5 sm:p-2 rounded-2xl bg-opacity-10 text-white shadow-inner`} style={{ backgroundColor: `${color}20`, color: color }}>
                    <Icon size={16} className="sm:size-4" />
                </div>
                <div className="text-right pr-2">
                    <span className="text-[8px] sm:text-[9px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest leading-none block mb-1 tracking-tight">
                        {label}
                    </span>
                    <span className="text-lg sm:text-xl font-medium text-zinc-900 dark:text-zinc-50 tracking-tight leading-none tracking-tighter tabular-nums block">
                        {isCurrency && isNumber ? (
                            <MoneyDigits value={value as number} />
                        ) : isNumber ? (
                            <NumberDigits value={value as number} />
                        ) : (
                            <>
                                {isCurrency && <span className="text-[10px] mr-0.5" style={{ color }}>$</span>}
                                {value}
                            </>
                        )}
                    </span>
                </div>
            </div>

            <div className="flex flex-col gap-1">
                <div className="flex justify-between items-center text-[7px] sm:text-[9px] font-medium uppercase tracking-wider">
                    <span className="text-zinc-500 dark:text-zinc-400 truncate">{subValue}</span>
                    {onClick && (
                        <span className="text-[7px] font-medium text-rose-500 flex items-center gap-0.5 animate-pulse">
                            VER DETALLES <ChevronRight size={8} />
                        </span>
                    )}
                </div>
            </div>
        </div>
    </div>
    );
};

const ExpenseStats = memo(({ totalMonth, topSource, count, totalPending, onOpenPending }: StatsProps) => {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 shrink-0 px-1">
      <AnalyticalCard 
        label="Egreso Mensual"
        value={totalMonth}
        isCurrency={true}
        subValue="Flujo proyectado"
        icon={DollarSign}
        color="#f43f5e"
        chartData={dummyData}
      />
      <AnalyticalCard 
        label="Cuentas por Pagar"
        value={totalPending}
        isCurrency={true}
        subValue="Deudas Activas"
        icon={HandCoins}
        color="#f59e0b"
        chartData={totalPending > 0 ? dummyData : undefined}
        onClick={onOpenPending}
      />
      <AnalyticalCard 
        label="Fuente Principal"
        value={topSource}
        subValue="Canal preferente"
        icon={CreditCard}
        color="#0ea5e9"
      />
      <AnalyticalCard 
        label="Operaciones"
        value={count}
        subValue="Registros activos"
        icon={Activity}
        color="#10b981"
        chartData={dummyData.slice().reverse()}
      />
    </div>
  );
});

ExpenseStats.displayName = 'ExpenseStats';
export default ExpenseStats;
