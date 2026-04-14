"use client";

import { Card, CardBody } from "@heroui/react";
import { 
    ShoppingCart, Package, Users, Tags, TrendingUp, Wallet, 
    TrendingDown, Clock 
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import React from 'react';

function KpiCard({ label, value, sub, icon: Icon, colorClass, bgClass }: {
    label: string; value: string; sub: string; icon: any; colorClass: string; bgClass: string;
}) {
    return (
        <Card className="bg-white/90 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200/80 dark:border-white/5 shadow-lg dark:shadow-2xl hover:shadow-xl dark:hover:shadow-emerald-500/5 transition-all duration-300 group hover:-translate-y-0.5" radius="lg">
            <CardBody className="p-2.5 md:p-5 flex flex-col justify-between gap-1.5 md:gap-3">
                <div className="flex items-start justify-between gap-1">
                    <div className="flex-1 min-w-0">
                        <p className="text-[8px] md:text-[10px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest truncate">{label}</p>
                        <p className="text-base md:text-3xl font-black text-gray-900 dark:text-white mt-0.5 md:mt-1 tracking-tighter tabular-nums break-words leading-tight">{value}</p>
                    </div>
                    <div className={`p-1.5 md:p-3 rounded-lg md:rounded-2xl shadow-sm ${bgClass} ${colorClass} flex-shrink-0`}>
                        <Icon className="h-3.5 w-3.5 md:h-5 md:w-5" />
                    </div>
                </div>
                <div className="flex items-center gap-1 border-t border-gray-100 dark:border-white/5 pt-1.5 mt-auto">
                    <Clock className="h-2 w-2 md:h-2.5 md:w-2.5 text-gray-400 dark:text-zinc-600" />
                    <p className="text-[7px] md:text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest truncate">{sub}</p>
                </div>
            </CardBody>
        </Card>
    );
}

interface DashboardKPIsProps {
    data: any;
}

export default function DashboardKPIs({ data }: DashboardKPIsProps) {
    if (!data) return null;

    return (
        <div className="grid gap-3 grid-cols-2 min-[450px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 shrink-0">
            <KpiCard
                label="Ventas del Día"
                value={`$${formatCurrency(data.todaySalesAmount)}`}
                sub={`${data.todaySalesCount} transacciones`}
                icon={ShoppingCart}
                colorClass="text-emerald-600 dark:text-emerald-500"
                bgClass="bg-emerald-100 dark:bg-emerald-500/10"
            />
            <KpiCard
                label="Productos Activos"
                value={`${data.activeProducts}`}
                sub={`${data.totalProducts} total`}
                icon={Package}
                colorClass="text-amber-600 dark:text-amber-500"
                bgClass="bg-amber-100 dark:bg-amber-500/10"
            />
            <KpiCard
                label="Clientes"
                value={`${data.totalClients}`}
                sub="Registrados"
                icon={Users}
                colorClass="text-sky-600 dark:text-sky-500"
                bgClass="bg-sky-100 dark:bg-sky-500/10"
            />
            <KpiCard
                label="Categorías"
                value={`${data.categoriesCount}`}
                sub="Activas"
                icon={Tags}
                colorClass="text-violet-600 dark:text-violet-500"
                bgClass="bg-violet-100 dark:bg-violet-500/10"
            />
            <KpiCard
                label="Utilidad Mes"
                value={`$${formatCurrency(data.profit)}`}
                sub={`${data.totalProductsSold} Unidades`}
                icon={TrendingUp}
                colorClass={data.profit >= 0 ? "text-emerald-600 dark:text-emerald-500" : "text-rose-600 dark:text-rose-500"}
                bgClass={data.profit >= 0 ? "bg-emerald-100 dark:bg-emerald-500/10" : "bg-rose-100 dark:bg-rose-500/10"}
            />
            <KpiCard
                label="Gastos del Mes"
                value={`$${formatCurrency(data.totalExpensesAmount)}`}
                sub="Egresos operativos"
                icon={Wallet}
                colorClass="text-rose-600 dark:text-rose-500"
                bgClass="bg-rose-100 dark:bg-rose-500/10"
            />
        </div>
    );
}
