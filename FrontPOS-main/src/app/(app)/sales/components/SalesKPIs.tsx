"use client";

import { Card, CardBody } from "@heroui/react";
import { TrendingUp, Clock, User, ShoppingCart, LucideIcon } from 'lucide-react';
import React from 'react';

interface KPIProps {
    label: string;
    val: string | number;
    icon: LucideIcon;
    color: string;
    desc: string;
}

const KPICard = React.memo(({ label, val, icon: Icon, color, desc }: KPIProps) => (
    <Card className="rounded-lg bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 shadow-sm hover:shadow-md transition-all duration-500 group overflow-hidden">
        <CardBody className="p-2">
            <h3 className="text-[7px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{label}</h3>
            <div className="flex items-center justify-between">
                <div className="text-sm font-black text-gray-900 dark:text-white mt-0.5 tabular-nums leading-none">{val}</div>
                <Icon className={`h-3 w-3 text-${color}-600 dark:text-${color}-500 opacity-20 group-hover:opacity-100 transition-opacity`} />
            </div>
        </CardBody>
    </Card>
));

KPICard.displayName = 'KPICard';

interface SalesKPIsProps {
    totalItems: number;
}

export default function SalesKPIs({ totalItems }: SalesKPIsProps) {
    const kpis = [
        { label: "Ventas Totales", val: totalItems, icon: TrendingUp, color: "emerald", desc: "Acumulado histórico" },
        { label: "Cierres Pendientes", val: "0", icon: Clock, color: "amber", desc: "Ventas sin liquidar" },
        { label: "Clientes Únicos", val: "84", icon: User, color: "blue", desc: "Base de datos activa" },
        { label: "Promedio Ticket", val: "$12.450", icon: ShoppingCart, color: "purple", desc: "Valor medio de venta" }
    ];

    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-1 shrink-0">
            {kpis.map((kpi, i) => (
                <KPICard key={i} {...kpi} />
            ))}
        </div>
    );
}
