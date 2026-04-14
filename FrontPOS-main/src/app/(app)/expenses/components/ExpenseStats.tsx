"use client";

import React, { memo } from 'react';
import { TrendingDown, CreditCard, Activity, DollarSign } from 'lucide-react';

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
          className="group bg-white dark:bg-zinc-900 p-5 border border-gray-200 dark:border-white/5 rounded-2xl flex items-center justify-between shadow-sm transition-all hover:bg-rose-500/5 hover:border-rose-500/20 hover:scale-[1.02] cursor-pointer"
        >
          <div className="flex flex-col min-w-0 pr-1">
            <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none mb-2">{k.label}</span>
            <div className="flex items-baseline gap-2">
              <span className={`text-2xl font-black tabular-nums ${
                k.color === 'rose' ? 'text-rose-500' : 
                k.color === 'sky' ? 'text-sky-500' : 
                k.color === 'emerald' ? 'text-emerald-500' : 'text-amber-500'
              } italic leading-none tracking-tighter uppercase truncate max-w-[140px]`}>
                {k.val}
              </span>
            </div>
            <p className="text-[9px] font-bold text-gray-400 dark:text-zinc-600 uppercase tracking-wider mt-2 italic group-hover:text-rose-500/60 transition-colors">
              {k.desc}
            </p>
          </div>
          <div className={`p-3 rounded-xl ${
            k.color === 'rose' ? 'bg-rose-500/10 text-rose-500' : 
            k.color === 'sky' ? 'bg-sky-500/10 text-sky-500' : 
            k.color === 'emerald' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
          } group-hover:scale-110 transition-transform`}>
            <k.icon size={24} />
          </div>
        </div>
      ))}
    </div>
  );
});

ExpenseStats.displayName = 'ExpenseStats';
export default ExpenseStats;
