"use client";

import React, { memo } from 'react';
import { Zap, TrendingDown, Sparkles, AlertTriangle } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area } from 'recharts';

interface StatsProps {
  totalCost: number;
  totalRetail: number;
  criticalStock: number;
  warningStock: number;
  totalItems: number;
}

const SPARKLINE_DATA_1 = [{val: 40}, {val: 30}, {val: 45}, {val: 20}, {val: 50}];
const SPARKLINE_DATA_2 = [{val: 10}, {val: 25}, {val: 15}, {val: 40}, {val: 35}];
const SPARKLINE_DATA_3 = [{val: 50}, {val: 45}, {val: 55}, {val: 60}, {val: 40}];
const SPARKLINE_DATA_4 = [{val: 20}, {val: 35}, {val: 25}, {val: 45}, {val: 50}];

const ProductStats = memo(({ totalCost, totalRetail, criticalStock, warningStock, totalItems }: StatsProps) => {
  const kpis = [
    { 
      label: "INVERSIÓN", 
      val: `$${totalCost.toLocaleString()}`, 
      color: "#0ea5e9", // sky-500
      icon: TrendingDown,
      desc: "Capital total",
      data: SPARKLINE_DATA_1
    },
    { 
      label: "POTENCIAL", 
      val: `$${totalRetail.toLocaleString()}`, 
      color: "#10b981", // emerald-500
      icon: Zap,
      desc: "Recaudo",
      data: SPARKLINE_DATA_2
    },
    { 
      label: "STOCK CRÍTICO", 
      val: criticalStock, 
      color: "#f43f5e", // rose-500
      icon: AlertTriangle,
      desc: "Urgente",
      data: SPARKLINE_DATA_3,
      alert: criticalStock > 0
    },
    { 
      label: "BAJO STOCK", 
      val: warningStock, 
      color: "#f59e0b", // amber-500
      icon: AlertTriangle,
      desc: "Atención",
      data: SPARKLINE_DATA_4,
      alert: warningStock > 0
    },
    { 
      label: "CATÁLOGO", 
      val: totalItems, 
      color: "#64748b", // slate-500
      icon: Sparkles,
      desc: "Referencias",
      data: [{val: totalItems}, {val: totalItems * 0.8}, {val: totalItems * 1.2}, {val: totalItems}, {val: totalItems * 0.9}]
    }
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5 w-full mb-0.5">
      {kpis.map((k, i) => (
        <div 
          key={i} 
          className={`relative overflow-hidden group border p-2 px-3 rounded-lg flex flex-col justify-between shadow-sm transition-all active:scale-95 cursor-pointer h-[66px] ${
            k.alert 
              ? 'bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 hover:border-rose-500/30' 
              : 'bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 hover:border-emerald-500/30'
          }`}
        >
          {/* Fondo Sparkline */}
          <div className="absolute inset-x-0 bottom-0 h-8 opacity-10 pointer-events-none transition-all group-hover:opacity-20 group-hover:scale-y-110 origin-bottom">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={k.data}>
                <Area type="monotone" dataKey="val" stroke={k.color} fill={k.color} fillOpacity={1} strokeWidth={2}/>
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="flex justify-between items-start z-10">
             <div className="flex flex-col">
                <span className="text-[8px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest leading-none mb-0.5 italic">{k.label}</span>
                <span className="text-base md:text-xl font-black tabular-nums tracking-tighter leading-none text-gray-900 dark:text-white italic">
                  {k.val}
                </span>
             </div>
             <div className="p-1 rounded-md" style={{ backgroundColor: `${k.color}20`, color: k.color }}>
                <k.icon size={14} />
             </div>
          </div>

          <div className="flex items-center gap-1 mt-auto z-10">
             <div className="h-1 w-1 rounded-full animate-pulse" style={{ backgroundColor: k.color }} />
             <p className="text-[8px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-widest italic leading-none">{k.desc}</p>
          </div>
        </div>
      ))}
    </div>
  );
});

ProductStats.displayName = 'ProductStats';
export default ProductStats;
