"use client";

import React, { memo } from 'react';
import { Zap, TrendingDown, Sparkles, AlertTriangle } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area } from 'recharts';
import { MoneyDigits, NumberDigits } from "@/components/ui/motion";

interface StatsProps {
  totalCost: number;
  totalRetail: number;
  criticalStock: number;
  warningStock: number;
  totalItems: number;
  activeFilter?: 'all' | 'critical' | 'warning';
  onSelectFilter?: (filter: 'all' | 'critical' | 'warning') => void;
}

const SPARKLINE_DATA_1 = [{val: 40}, {val: 30}, {val: 45}, {val: 20}, {val: 50}];
const SPARKLINE_DATA_2 = [{val: 10}, {val: 25}, {val: 15}, {val: 40}, {val: 35}];
const SPARKLINE_DATA_3 = [{val: 50}, {val: 45}, {val: 55}, {val: 60}, {val: 40}];
const SPARKLINE_DATA_4 = [{val: 20}, {val: 35}, {val: 25}, {val: 45}, {val: 50}];

const ProductStats = memo(({ totalCost, totalRetail, criticalStock, warningStock, totalItems, activeFilter = 'all', onSelectFilter }: StatsProps) => {
  const kpis = [
    { 
      id: 'all',
      label: "INVERSION", 
      val: totalCost, 
      isCurrency: true,
      color: "#0ea5e9", // sky-500
      icon: TrendingDown,
      desc: "Capital total",
      data: SPARKLINE_DATA_1,
      clickable: false
    },
    { 
      id: 'all',
      label: "POTENCIAL", 
      val: totalRetail, 
      isCurrency: true,
      color: "#10b981", // emerald-500
      icon: Zap,
      desc: "Recaudo",
      data: SPARKLINE_DATA_2,
      clickable: false
    },
    { 
      id: 'critical',
      label: "STOCK CRITICO", 
      val: criticalStock, 
      isCurrency: false,
      color: "#f43f5e", // rose-500
      icon: AlertTriangle,
      desc: activeFilter === 'critical' ? '🔴 FILTRADO (Clic para limpiar)' : 'Urgente (Clic para filtrar)',
      data: SPARKLINE_DATA_3,
      alert: criticalStock > 0,
      clickable: true
    },
    { 
      id: 'warning',
      label: "BAJO STOCK", 
      val: warningStock, 
      isCurrency: false,
      color: "#f59e0b", // amber-500
      icon: AlertTriangle,
      desc: activeFilter === 'warning' ? '⚠️ FILTRADO (Clic para limpiar)' : 'Atención (Clic para filtrar)',
      data: SPARKLINE_DATA_4,
      alert: warningStock > 0,
      clickable: true
    },
    { 
      id: 'all',
      label: "CATALOGO", 
      val: totalItems, 
      isCurrency: false,
      color: "#64748b", // slate-500
      icon: Sparkles,
      desc: activeFilter !== 'all' ? 'Ver todos (Clic)' : 'Referencias',
      data: [{val: totalItems}, {val: totalItems * 0.8}, {val: totalItems * 1.2}, {val: totalItems}, {val: totalItems * 0.9}],
      clickable: true
    }
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5 w-full mb-0.5">
      {kpis.map((k, i) => {
        const isActive = (k.id === 'critical' && activeFilter === 'critical') || 
                         (k.id === 'warning' && activeFilter === 'warning') ||
                         (k.id === 'all' && activeFilter === 'all' && k.label === 'CATALOGO');

        return (
          <div 
            key={i} 
            onClick={() => {
              if (!onSelectFilter || !k.clickable) return;
              if (k.id === 'critical') {
                onSelectFilter(activeFilter === 'critical' ? 'all' : 'critical');
              } else if (k.id === 'warning') {
                onSelectFilter(activeFilter === 'warning' ? 'all' : 'warning');
              } else if (k.label === 'CATALOGO') {
                onSelectFilter('all');
              }
            }}
            className={`relative overflow-hidden group p-2 px-3 rounded-2xl flex flex-col justify-between shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all active:scale-95 h-[66px] ${
              k.clickable ? 'cursor-pointer' : 'cursor-default'
            } ${
              isActive
                ? k.id === 'critical'
                  ? 'bg-rose-500/15 border-2 border-rose-500 ring-2 ring-rose-500/30 scale-[1.02]'
                  : k.id === 'warning'
                  ? 'bg-amber-500/15 border-2 border-amber-500 ring-2 ring-amber-500/30 scale-[1.02]'
                  : 'bg-emerald-500/15 border-2 border-emerald-500 ring-2 ring-emerald-500/30 scale-[1.02]'
                : k.alert 
                ? 'card-base border border-gray-200 dark:border-white/5 hover:border-rose-500/40 hover:bg-rose-500/5' 
                : 'card-base border border-gray-200 dark:border-white/5 hover:border-emerald-500/40 hover:bg-emerald-500/5'
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
                  <span className="text-[8px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest leading-none mb-0.5 tracking-tight">{k.label}</span>
                  <span className="text-base md:text-xl font-medium tabular-nums tracking-tighter leading-none text-zinc-900 dark:text-zinc-50 tracking-tight">
                    {k.isCurrency ? (
                      <MoneyDigits value={k.val as number} />
                    ) : (
                      <NumberDigits value={k.val as number} />
                    )}
                  </span>
               </div>
               <div className="p-1 rounded-2xl" style={{ backgroundColor: `${k.color}20`, color: k.color }}>
                  <k.icon size={14} />
               </div>
            </div>

            <div className="flex items-center gap-1 mt-auto z-10">
               <div className="h-1 w-1 rounded-2xl animate-pulse" style={{ backgroundColor: k.color }} />
               <p className={`text-[8px] font-medium uppercase tracking-widest tracking-tight leading-none ${isActive ? 'text-zinc-900 dark:text-zinc-100 font-bold' : 'text-gray-400 dark:text-zinc-600'}`}>{k.desc}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
});

ProductStats.displayName = 'ProductStats';
export default ProductStats;
