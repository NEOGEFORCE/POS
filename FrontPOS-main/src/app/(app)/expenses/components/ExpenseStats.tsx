"use client";

import React, { memo } from 'react';
import { TrendingDown, CreditCard, Activity, DollarSign } from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';

const dummyData = [
    { pv: 4200 },
    { pv: 7398 },
    { pv: 2800 },
    { pv: 5908 },
    { pv: 1800 },
    { pv: 6800 },
    { pv: 3300 },
];


interface StatsProps {
  totalMonth: number;
  topSource: string;
  count: number;
}

const ExpenseStats = memo(({ totalMonth, topSource, count }: StatsProps) => {
  const kpis = [
    {
      label: "TOTAL EGRESOS (MES)",
      val: `$${totalMonth.toLocaleString()}`,
      color: "rose",
      icon: DollarSign,
      desc: "Flujo de salida mensual"
    },
    {
      label: "FUENTE PRINCIPAL",
      val: topSource,
      color: "sky",
      icon: CreditCard,
      desc: "Canal de mayor movimiento"
    },
    {
      label: "OPERACIONES",
      val: count,
      color: "emerald",
      icon: Activity,
      desc: "Registros de gasto"
    },
    {
      label: "ESTADO CAJA",
      val: "CONCILIADO",
      color: "amber",
      icon: TrendingDown,
      desc: "Sincronización auditoría"
    }
  ];

  return (
    <div className="grid grid-cols-1 xs:grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
      {kpis.map((k, i) => (
        <div 
          key={i} 
          className="relative bg-white/80 dark:bg-zinc-900/50 backdrop-blur-xl p-5 border border-gray-200 dark:border-white/5 rounded-[2rem] flex items-center justify-between shadow-lg overflow-hidden group cursor-pointer transition-all hover:scale-[1.02] hover:border-rose-500/30"
        >
          {/* Background Sparkline */}
          <div className="absolute inset-0 opacity-10 dark:opacity-20 translate-y-4 group-hover:translate-y-2 group-hover:scale-y-110 transition-all duration-700 pointer-events-none">
              <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={dummyData}>
                      <Area 
                          type="monotone" 
                          dataKey="pv" 
                          stroke={k.color === 'rose' ? '#f43f5e' : k.color === 'sky' ? '#0ea5e9' : k.color === 'emerald' ? '#10b981' : '#f59e0b'} 
                          fill={k.color === 'rose' ? '#f43f5e' : k.color === 'sky' ? '#0ea5e9' : k.color === 'emerald' ? '#10b981' : '#f59e0b'}
                          strokeWidth={2}
                      />
                  </AreaChart>
              </ResponsiveContainer>
          </div>

          <div className="flex flex-col min-w-0 pr-1 relative z-10">
            <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none mb-2">{k.label}</span>
            <div className="flex items-baseline gap-2">
              <span className={`text-3xl font-black tabular-nums ${
                k.color === 'rose' ? 'text-rose-500' : 
                k.color === 'sky' ? 'text-sky-500' : 
                k.color === 'emerald' ? 'text-emerald-500' : 'text-amber-500'
              } italic leading-none tracking-tighter uppercase truncate max-w-[140px]`}>
                {k.val}
              </span>
            </div>
            <p className="text-[9px] font-bold text-gray-400 dark:text-zinc-600 uppercase tracking-wider mt-2 italic opacity-0 group-hover:opacity-100 transition-opacity">
              {k.desc}
            </p>
          </div>
          <div className={`p-4 rounded-[1.2rem] shadow-xl backdrop-blur-md relative z-10 ${
            k.color === 'rose' ? 'bg-rose-500/10 text-rose-500 shadow-rose-500/20' : 
            k.color === 'sky' ? 'bg-sky-500/10 text-sky-500 shadow-sky-500/20' : 
            k.color === 'emerald' ? 'bg-emerald-500/10 text-emerald-500 shadow-emerald-500/20' : 'bg-amber-500/10 text-amber-500 shadow-amber-500/20'
          } transition-transform group-hover:-rotate-6`}>
            <k.icon size={28} />
          </div>
        </div>
      ))}
    </div>
  );
});

ExpenseStats.displayName = 'ExpenseStats';
export default ExpenseStats;
