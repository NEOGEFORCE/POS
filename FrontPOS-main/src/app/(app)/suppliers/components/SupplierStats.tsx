"use client";

import React, { memo } from 'react';
import { Zap, Phone, Sparkles, Building2 } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area } from 'recharts';

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
      label: "LÍNEAS DE CONTACTO", 
      val: withPhone, 
      color: "#0ea5e9", // sky
      icon: Phone,
      desc: "Proveedores con teléfono",
      data: SPARKLINE_DATA_2
    },
    { 
      label: "ESTADO CONECTIVIDAD", 
      val: "ESTABLE", 
      color: "#10b981", // emerald
      icon: Sparkles,
      desc: "Sincronización API OK",
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
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 xl:gap-6 shrink-0 w-full mb-6">
      {kpis.map((k, i) => (
        <div 
          key={i} 
          className="relative overflow-hidden group bg-white/80 dark:bg-zinc-900/50 backdrop-blur-xl p-5 md:p-6 border border-gray-200 dark:border-white/5 rounded-[2.5rem] flex items-center justify-between shadow-xl transition-all hover:bg-white dark:hover:bg-zinc-900 hover:border-white/20 active:scale-95 cursor-pointer"
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
            <span className="text-[9px] md:text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] italic leading-none mb-2">{k.label}</span>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl md:text-3xl font-black tabular-nums italic leading-none tracking-tighter truncate text-gray-900 dark:text-white" style={{ color: k.color }}>
                {k.val}
              </span>
            </div>
            <p className="text-[9px] font-bold text-gray-400 mt-2 uppercase tracking-widest">{k.desc}</p>
          </div>
          <div className="relative z-10 p-3 rounded-2xl group-hover:scale-110 transition-transform shadow-lg" style={{ backgroundColor: `${k.color}20`, color: k.color }}>
            <k.icon size={24} />
          </div>
        </div>
      ))}
    </div>
  );
});

SupplierStats.displayName = 'SupplierStats';
export default SupplierStats;
