"use client";

import React, { memo } from 'react';
import { TrendingDown, CreditCard, Activity, DollarSign } from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';

interface StatsProps {
  totalMonth: number;
  topSource: string;
  count: number;
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
    isCurrency = false
}: { 
    label: string, 
    value: string | number, 
    subValue: string, 
    icon: any, 
    color: string, 
    chartData?: any[],
    isCurrency?: boolean
}) => (
    <div className="relative group flex-1 bg-white/80 dark:bg-zinc-900/50 backdrop-blur-xl p-3.5 border border-gray-200 dark:border-white/5 rounded-2xl shadow-xl overflow-hidden shadow-rose-500/5 transition-all hover:scale-[1.02] hover:border-rose-500/20">
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
                <div className={`p-1.5 sm:p-2 rounded-xl bg-opacity-10 text-white shadow-inner`} style={{ backgroundColor: `${color}20`, color: color }}>
                    <Icon size={16} className="sm:size-4" />
                </div>
                <div className="text-right pr-2">
                    <span className="text-[8px] sm:text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none block mb-1 italic">
                        {label}
                    </span>
                    <span className="text-lg sm:text-xl font-black text-gray-900 dark:text-white italic leading-none tracking-tighter tabular-nums block">
                        {isCurrency && <span className="text-[10px] mr-0.5" style={{ color }}>$</span>}
                        {value}
                    </span>
                </div>
            </div>

            <div className="flex flex-col gap-1">
                <div className="flex justify-between items-center text-[7px] sm:text-[9px] font-black uppercase tracking-wider">
                    <span className="text-gray-400 dark:text-zinc-500 truncate">{subValue}</span>
                </div>
            </div>
        </div>
    </div>
);

const ExpenseStats = memo(({ totalMonth, topSource, count }: StatsProps) => {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-2 shrink-0 px-1">
      <AnalyticalCard 
        label="Egreso Mensual"
        value={totalMonth.toLocaleString()}
        isCurrency={true}
        subValue="Flujo proyectado"
        icon={DollarSign}
        color="#f43f5e"
        chartData={dummyData}
      />
      <AnalyticalCard 
        label="Fuente Principal"
        value={topSource}
        subValue="Canal preferente"
        icon={CreditCard}
        color="#0ea5e9"
      />
      <div className="col-span-2 md:col-span-1">
        <AnalyticalCard 
          label="Operaciones"
          value={count}
          subValue="Registros activos"
          icon={Activity}
          color="#10b981"
          chartData={dummyData.slice().reverse()}
        />
      </div>
    </div>
  );
});

ExpenseStats.displayName = 'ExpenseStats';
export default ExpenseStats;
