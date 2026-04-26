"use client";

import { Card, CardBody } from "@heroui/react";
import { TrendingDown, Clock, RotateCcw, Package, LucideIcon } from 'lucide-react';
import React from 'react';

interface KPIProps {
    label: string;
    val: string | number;
    icon: LucideIcon;
    color: string;
    desc: string;
}

const KPICard = React.memo(({ label, val, icon: Icon, color, desc }: KPIProps) => (
    <div className="bg-white dark:bg-zinc-900/40 dark:backdrop-blur-md border border-gray-200 dark:border-white/10 rounded-2xl p-4 flex items-center gap-4 relative overflow-hidden group hover:shadow-md transition-all duration-500">
        {/* Contenedor del Icono con Glow */}
        <div className="relative flex-shrink-0 flex items-center justify-center w-12 h-12">
            <div className={`absolute inset-0 bg-${color}-500/20 blur-xl rounded-full dark:block hidden group-hover:bg-${color}-500/30 transition-colors`}></div>
            <div className={`relative bg-${color}-50 text-${color}-600 dark:bg-${color}-500/20 dark:text-${color}-400 p-2.5 rounded-xl shadow-sm transition-colors`}>
                <Icon className="w-6 h-6" />
            </div>
        </div>
        {/* Textos */}
        <div className="flex flex-col">
            <span className="text-gray-500 dark:text-zinc-400 text-[10px] font-bold tracking-wider uppercase mb-0.5 leading-none">
                {label}
            </span>
            <span className="text-gray-900 dark:text-white font-bold italic text-2xl tracking-tighter tabular-nums leading-none mt-1">
                {val}
            </span>
        </div>
    </div>
));

KPICard.displayName = 'KPICard';

interface ReturnsKPIsProps {
    totalReturns: number;
    totalRefunded: string;
    itemsReturned: number;
}

export default function ReturnsKPIs({ totalReturns, totalRefunded, itemsReturned }: ReturnsKPIsProps) {
    const kpis = [
        { label: "Total Devoluciones", val: totalReturns, icon: RotateCcw, color: "rose", desc: "Histórico" },
        { label: "Dinero Reembolsado", val: totalRefunded, icon: TrendingDown, color: "rose", desc: "Capital devuelto" },
        { label: "Artículos Reingresados", val: itemsReturned, icon: Package, color: "rose", desc: "Inventario restaurado" },
        { label: "Cierres Pendientes", val: "0", icon: Clock, color: "amber", desc: "Pendientes" }
    ];

    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-1 shrink-0">
            {kpis.map((kpi, i) => (
                <KPICard key={i} {...kpi} />
            ))}
        </div>
    );
}
