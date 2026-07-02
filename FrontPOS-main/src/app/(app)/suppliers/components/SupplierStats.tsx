"use client";

import React, { memo } from 'react';
import { Zap, Phone, Sparkles, Building2 } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area } from 'recharts';
import { NumberDigits } from "@/components/ui/motion";

interface StatsProps {
  total: number;
  withPhone: number;
}

const SPARKLINE_DATA_1 = [{val: 10}, {val: 20}, {val: 15}, {val: 25}, {val: 30}];
const SPARKLINE_DATA_2 = [{val: 5}, {val: 10}, {val: 12}, {val: 8}, {val: 15}];
const SPARKLINE_DATA_3 = [{val: 50}, {val: 45}, {val: 55}, {val: 60}, {val: 58}];
const SPARKLINE_DATA_4 = [{val: 40}, {val: 35}, {val: 45}, {val: 40}, {val: 50}];

const SupplierStats = memo(({ total, withPhone }: StatsProps) => {
  const kpis = [
    { 
      label: "ABASTECEDORES ACTIVOS", 
      val: total, 
      color: "#10b981", // emerald
      icon: Zap,
      desc: "Base maestra vigente",
      data: SPARKLINE_DATA_1
    },
    { 
      label: "LINEAS DE CONTACTO", 
      val: withPhone, 
      color: "#0ea5e9", // sky
      icon: Phone,
      desc: "Proveedores con telefono",
      data: SPARKLINE_DATA_2
    },
    { 
      label: "ESTADO CONECTIVIDAD", 
      val: "ESTABLE", 
      color: "#10b981", // emerald
      icon: Sparkles,
      desc: "Sincronizacion API OK",
      data: SPARKLINE_DATA_3
    },
    { 
      label: "SISTEMA AUDITORIA", 
      val: "ACTIVO", 
      color: "#f59e0b", // amber
      icon: Building2,
      desc: "Trazabilidad completa",
      data: SPARKLINE_DATA_4
    }
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-6 shrink-0 w-full mb-0">
      {kpis.map((k, i) => (
        <div 
          key={i} 
          className="relative overflow-hidden group card-base border-none dark:bg-[#18181b]/50 p-2.5 md:p-3.5 border border-gray-200 dark:border-white/5 rounded-2xl flex items-center justify-between shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all hover:bg-white dark:hover:bg-[#18181b] hover:border-black/10 dark:border-white/20 active:scale-95 cursor-pointer"
        >
          {/* Fondo Sparkline */}
          <div className="absolute inset-x-0 bottom-0 h-16 opacity-10 pointer-events-none transition-all group-hover:opacity-20 group-hover:scale-y-110 origin-bottom">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={k.data}>
                <Area type="monotone" dataKey="val" stroke={k.color} fill={k.color} fillOpacity={1} strokeWidth={2}/>
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="relative z-10 flex flex-col min-w-0 pr-1">
            <span className="text-[8px] sm:text-[9px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-tight tracking-tight leading-none mb-1.5 pr-1">{k.label}</span>
            <div className="flex items-baseline gap-2">
              <span className="text-base sm:text-lg font-medium tabular-nums tracking-tight leading-none text-zinc-900 dark:text-zinc-50 pr-1" style={{ color: k.color }}>
                {typeof k.val === 'number' ? <NumberDigits value={k.val} /> : k.val}
              </span>
            </div>
            <p className="text-[8px] font-bold text-gray-400 mt-2 uppercase tracking-widest">{k.desc}</p>
          </div>
          <div className="relative z-10 p-1.5 md:p-2 rounded-2xl group-hover:scale-110 transition-transform shadow-[0_8px_30px_rgb(0,0,0,0.12)]" style={{ backgroundColor: `${k.color}20`, color: k.color }}>
            <k.icon size={14} className="md:size-4" />
          </div>
        </div>
      ))}
    </div>
  );
});

SupplierStats.displayName = 'SupplierStats';
export default SupplierStats;
