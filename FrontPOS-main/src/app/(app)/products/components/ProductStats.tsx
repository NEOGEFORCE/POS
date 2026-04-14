"use client";

import React, { memo } from 'react';
import { Zap, TrendingDown, Sparkles, AlertTriangle } from 'lucide-react';

interface StatsProps {
  totalCost: number;
  totalRetail: number;
  lowStock: number;
  totalItems: number;
}

const ProductStats = memo(({ totalCost, totalRetail, lowStock, totalItems }: StatsProps) => {
  const kpis = [
    { 
      label: "TOTAL COSTO", 
      val: `$${totalCost.toLocaleString()}`, 
      color: "sky", 
      icon: TrendingDown,
      desc: "Capital total"
    },
    { 
      label: "TOTAL VENTA", 
      val: `$${totalRetail.toLocaleString()}`, 
      color: "emerald", 
      icon: Zap,
      desc: "Recaudo estimado"
    },
    { 
      label: "STOCK BAJO", 
      val: lowStock, 
      color: "rose", 
      icon: AlertTriangle,
      desc: "Items críticos"
    },
    { 
      label: "CATÁLOGO", 
      val: totalItems, 
      color: "amber", 
      icon: Sparkles,
      desc: "Referencias"
    }
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-1.5 shrink-0">
      {kpis.map((k, i) => (
        <div 
          key={i} 
          className="group bg-white dark:bg-zinc-900 p-2 md:p-3 border border-gray-200 dark:border-white/5 rounded-xl flex items-center justify-between shadow-sm transition-all hover:bg-emerald-500/5 hover:border-emerald-500/20 active:scale-95 cursor-pointer"
        >
          <div className="flex flex-col min-w-0 pr-1">
            <span className="text-[7px] md:text-[8px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none mb-1 md:mb-1.5">{k.label}</span>
            <div className="flex items-baseline gap-2">
              <span className={`text-xs md:text-sm font-black tabular-nums ${
                k.color === 'emerald' ? 'text-emerald-500' : 
                k.color === 'sky' ? 'text-sky-500' : 
                k.color === 'rose' ? 'text-rose-500' : 'text-amber-500'
              } italic leading-none tracking-tighter truncate font-mono`}>
                {k.val}
              </span>
            </div>
          </div>
          <div className={`p-1.5 md:p-2 rounded-lg ${
            k.color === 'emerald' ? 'bg-emerald-500/10 text-emerald-500' : 
            k.color === 'sky' ? 'bg-sky-500/10 text-sky-500' : 
            k.color === 'rose' ? 'bg-rose-500/10 text-rose-500' : 'bg-amber-500/10 text-amber-500'
          } group-hover:scale-110 transition-transform`}>
            <k.icon size={14} />
          </div>
        </div>
      ))}
    </div>
  );
});

ProductStats.displayName = 'ProductStats';
export default ProductStats;
