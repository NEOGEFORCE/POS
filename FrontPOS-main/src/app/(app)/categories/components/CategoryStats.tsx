"use client";

import React, { memo } from 'react';
import { Shapes, Zap, FolderTree } from 'lucide-react';

interface StatsProps {
    total: number;
    topCat: string;
    totalProds: number;
}

const CategoryStats = memo(({ total, topCat, totalProds }: StatsProps) => {
    const kpis = [
        { label: "DEPARTAMENTOS", val: total, color: "emerald", icon: Shapes, sub: "TAXONOMÍA ACTIVA" },
        { label: "DENSIDAD MÁXIMA", val: topCat, color: "sky", icon: Zap, sub: "CATEGORÍA LÍDER" },
        { label: "CATÁLOGO TOTAL", val: totalProds, color: "indigo", icon: FolderTree, sub: "REFS ASIGNADAS" }
    ];

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-1 shrink-0">
            {kpis.map((k, i) => (
                <div key={i} className="bg-white dark:bg-zinc-900 p-3 border border-gray-200 dark:border-white/5 rounded-xl flex items-center justify-between shadow-sm transition-all hover:border-emerald-500/30 group cursor-pointer">
                    <div className="flex flex-col min-w-0 pr-2">
                        <span className="text-[8px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] leading-none mb-1 group-hover:text-emerald-500 transition-colors">{k.label}</span>
                        <div className="flex items-baseline gap-2">
                          <span className={`text-lg font-black tabular-nums tracking-tighter italic ${
                              k.color === 'emerald' ? 'text-emerald-500' : k.color === 'sky' ? 'text-sky-500' : 'text-indigo-500'
                          } truncate`}>
                              {k.val}
                          </span>
                          <span className="text-[7px] font-bold text-gray-400 dark:text-zinc-600 uppercase opacity-0 group-hover:opacity-100 transition-opacity tracking-widest">{k.sub}</span>
                        </div>
                    </div>
                    <div className={`p-2 rounded-lg ${
                        k.color === 'emerald' ? 'bg-emerald-500/10 text-emerald-500' : k.color === 'sky' ? 'bg-sky-500/10 text-sky-500' : 'bg-indigo-500/10 text-indigo-500'
                    } transition-transform group-hover:scale-110 shrink-0`}>
                        <k.icon size={16} />
                    </div>
                </div>
            ))}
        </div>
    );
});

CategoryStats.displayName = 'CategoryStats';
export default CategoryStats;
