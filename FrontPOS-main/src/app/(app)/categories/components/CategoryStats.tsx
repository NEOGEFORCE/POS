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
            desc: "Taxonomia vigente",
            data: SPARKLINE_DATA_1
        },
        { 
            label: "CATEGORIA LIDER", 
            val: topCat, 
            color: "#0ea5e9", // sky
            icon: Zap,
            desc: "Densidad maxima",
            data: SPARKLINE_DATA_2
        },
        { 
            label: "CATALOGO TOTAL", 
            val: totalProds, 
            color: "#6366f1", // indigo
            icon: FolderTree,
            desc: "Refs vinculadas",
            data: SPARKLINE_DATA_3
        },
        { 
            label: "SISTEMA TAXONOMICO", 
            val: "ACTIVO", 
            color: "#f59e0b", // amber
            icon: Sparkles,
            desc: "Distribucion V4.0",
            data: SPARKLINE_DATA_4
        }
    ];

    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 shrink-0 w-full">
            {kpis.map((k, i) => (
                <div 
                    key={i} 
                    className="relative overflow-hidden group card-base border-none p-2 md:p-2.5 border border-gray-200 dark:border-white/5 rounded-2xl flex items-center justify-between shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all hover:bg-white dark:hover:bg-[#18181b] active:scale-95 cursor-pointer"
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
                        <span className="text-[7px] md:text-[8px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-tighter tracking-tight leading-none mb-1">{k.label}</span>
                        <div className="flex items-baseline gap-1">
                            <span className="text-xs md:text-sm font-medium tabular-nums tracking-tight leading-none truncate pr-1" style={{ color: k.color }}>
                                {k.val}
                            </span>
                        </div>
                        <p className="text-[6px] font-bold text-gray-400 dark:text-zinc-600 mt-1.5 uppercase tracking-widest">{k.desc}</p>
                    </div>
                    <div className="relative z-10 p-1 rounded-2xl group-hover:scale-110 transition-transform shadow-[0_8px_30px_rgb(0,0,0,0.12)] shrink-0" style={{ backgroundColor: `${k.color}15`, color: k.color }}>
                        <k.icon size={14} className="md:size-3.5" strokeWidth={2.5} />
                    </div>
                </div>
            ))}
        </div>
    );
});

CategoryStats.displayName = 'CategoryStats';
export default CategoryStats;
