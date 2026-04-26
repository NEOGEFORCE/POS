"use client";

import React, { memo } from 'react';
import { Shapes, Zap, FolderTree, Sparkles } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area } from 'recharts';

interface StatsProps {
    total: number;
    topCat: string;
    totalProds: number;
}

const SPARKLINE_DATA_1 = [{val: 10}, {val: 20}, {val: 15}, {val: 25}, {val: 30}];
const SPARKLINE_DATA_2 = [{val: 5}, {val: 10}, {val: 12}, {val: 8}, {val: 15}];
const SPARKLINE_DATA_3 = [{val: 50}, {val: 45}, {val: 55}, {val: 60}, {val: 58}];
const SPARKLINE_DATA_4 = [{val: 40}, {val: 35}, {val: 45}, {val: 40}, {val: 50}];

const CategoryStats = memo(({ total, topCat, totalProds }: StatsProps) => {
    const kpis = [
        { 
            label: "DEPARTAMENTOS ACTIVOS", 
            val: total, 
            color: "#10b981", // emerald
            icon: Shapes,
            desc: "Taxonomía vigente",
            data: SPARKLINE_DATA_1
        },
        { 
            label: "CATEGORÍA LÍDER", 
            val: topCat, 
            color: "#0ea5e9", // sky
            icon: Zap,
            desc: "Densidad máxima",
            data: SPARKLINE_DATA_2
        },
        { 
            label: "CATÁLOGO TOTAL", 
            val: totalProds, 
            color: "#6366f1", // indigo
            icon: FolderTree,
            desc: "Refs vinculadas",
            data: SPARKLINE_DATA_3
        },
        { 
            label: "SISTEMA TAXONÓMICO", 
            val: "ACTIVO", 
            color: "#f59e0b", // amber
            icon: Sparkles,
            desc: "Distribución V4.0",
            data: SPARKLINE_DATA_4
        }
    ];

    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 shrink-0 w-full">
            {kpis.map((k, i) => (
                <div 
                    key={i} 
                    className="relative overflow-hidden group bg-white/80 dark:bg-zinc-900/50 backdrop-blur-md p-2 md:p-2.5 border border-gray-200 dark:border-white/5 rounded-2xl flex items-center justify-between shadow-sm transition-all hover:bg-white dark:hover:bg-zinc-900 active:scale-95 cursor-pointer"
                >
                    {/* Fondo Sparkline */}
                    <div className="absolute inset-x-0 bottom-0 h-10 opacity-10 pointer-events-none transition-all group-hover:opacity-20 group-hover:scale-y-110 origin-bottom">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={k.data}>
                                <Area type="monotone" dataKey="val" stroke={k.color} fill={k.color} fillOpacity={1} strokeWidth={2}/>
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>

                    <div className="relative z-10 flex flex-col min-w-0 pr-1">
                        <span className="text-[7px] md:text-[8px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-tighter italic leading-none mb-1">{k.label}</span>
                        <div className="flex items-baseline gap-1">
                            <span className="text-xs md:text-sm font-black tabular-nums italic leading-none truncate pr-1" style={{ color: k.color }}>
                                {k.val}
                            </span>
                        </div>
                        <p className="text-[6px] font-bold text-gray-400 dark:text-zinc-600 mt-1.5 uppercase tracking-widest">{k.desc}</p>
                    </div>
                    <div className="relative z-10 p-1 rounded-lg group-hover:scale-110 transition-transform shadow-sm shrink-0" style={{ backgroundColor: `${k.color}15`, color: k.color }}>
                        <k.icon size={14} className="md:size-3.5" strokeWidth={2.5} />
                    </div>
                </div>
            ))}
        </div>
    );
});

CategoryStats.displayName = 'CategoryStats';
export default CategoryStats;
