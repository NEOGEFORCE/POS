"use client";

import React, { memo } from 'react';
import { Zap, Phone, Sparkles, Building2 } from 'lucide-react';

interface StatsProps {
  total: number;
  withPhone: number;
}

const SupplierStats = memo(({ total, withPhone }: StatsProps) => {
  const kpis = [
    { 
      label: "ABASTECEDORES ACTIVOS", 
      val: total, 
      color: "emerald", 
      icon: Zap,
      desc: "Base maestra vigente"
    },
    { 
      label: "LÍNEAS DE CONTACTO", 
      val: withPhone, 
      color: "sky", 
      icon: Phone,
      desc: "Proveedores con teléfono"
    },
    { 
      label: "ESTADO CONECTIVIDAD", 
      val: "ESTABLE", 
      color: "emerald", 
      icon: Sparkles,
      desc: "Sincronización API OK"
    },
    { 
      label: "SISTEMA AUDITORIA", 
      val: "ACTIVO", 
      color: "amber", 
      icon: Building2,
      desc: "Trazabilidad completa"
    }
  ];

  return (
    <div className="grid grid-cols-1 xs:grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
      {kpis.map((k, i) => (
        <div 
          key={i} 
          className="group bg-white dark:bg-zinc-900 p-5 border border-gray-200 dark:border-white/5 rounded-2xl flex items-center justify-between shadow-sm transition-all hover:bg-emerald-500/5 hover:border-emerald-500/20 hover:scale-[1.02] cursor-pointer"
        >
          <div className="flex flex-col min-w-0 pr-1">
            <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none mb-2">{k.label}</span>
            <div className="flex items-baseline gap-2">
              <span className={`text-2xl font-black tabular-nums ${
                k.color === 'emerald' ? 'text-emerald-500' : 
                k.color === 'sky' ? 'text-sky-500' : 'text-amber-500'
              } italic leading-none tracking-tighter`}>
                {k.val}
              </span>
            </div>
            <p className="text-[9px] font-bold text-gray-400 dark:text-zinc-600 uppercase tracking-wider mt-2 italic group-hover:text-emerald-500/60 transition-colors">
              {k.desc}
            </p>
          </div>
          <div className={`p-3 rounded-xl ${
            k.color === 'emerald' ? 'bg-emerald-500/10 text-emerald-500' : 
            k.color === 'sky' ? 'bg-sky-500/10 text-sky-500' : 'bg-amber-500/10 text-amber-500'
          } group-hover:scale-110 transition-transform`}>
            <k.icon size={24} />
          </div>
        </div>
      ))}
    </div>
  );
});

SupplierStats.displayName = 'SupplierStats';
export default SupplierStats;
