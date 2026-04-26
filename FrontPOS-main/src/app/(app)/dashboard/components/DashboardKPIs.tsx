"use client";

import { Card, CardBody } from "@heroui/react";
import { 
    ShoppingCart, Package, Users, Tags, Clock 
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";

function KpiCard({ label, value, sub, icon: Icon, colorClass, bgClass }: {
    label: string; value: string; sub: string; icon: any; colorClass: string; bgClass: string;
}) {
    return (
        <Card className="bg-white/70 dark:bg-zinc-900/40 backdrop-blur-xl border border-gray-200 dark:border-white/5 rounded-[2rem] shadow-xl hover:shadow-emerald-500/10 hover:border-emerald-500/30 transition-all duration-500 group overflow-hidden" radius="lg">
            <CardBody className="p-6 flex flex-col justify-between relative">
                {/* Background Accent */}
                <div className={`absolute -right-4 -top-4 w-24 h-24 rounded-full ${bgClass} opacity-10 group-hover:scale-150 transition-transform duration-700 blur-2xl`} />
                
                <div className="flex items-start justify-between gap-4 relative z-10">
                    <div className="flex-1 min-w-0">
                        <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] mb-1">{label}</p>
                        <p className="text-3xl font-black text-gray-900 dark:text-white tracking-tighter tabular-nums leading-none italic">
                            {value}
                        </p>
                    </div>
                    <div className={`h-12 w-12 rounded-2xl ${bgClass} ${colorClass} flex items-center justify-center shadow-inner group-hover:rotate-12 transition-all duration-500`}>
                        <Icon size={24} />
                    </div>
                </div>

                <div className="flex items-center gap-2 border-t border-gray-100 dark:border-white/5 pt-4 mt-4 relative z-10">
                    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-gray-50 dark:bg-white/5 border border-gray-200/50 dark:border-white/5">
                        <Clock size={20} strokeWidth={2.5} className="text-zinc-400" />
                        <p className="text-[9px] font-black text-gray-500 dark:text-zinc-400 uppercase tracking-widest truncate">{sub}</p>
                    </div>
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
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <KpiCard
                label="Ventas del Día"
                value={`$${formatCurrency(data.todaySalesAmount)}`}
                sub={`${data.todaySalesCount} transacciones`}
                icon={ShoppingCart}
                colorClass="text-emerald-500"
                bgClass="bg-emerald-500/10"
            />
            <KpiCard
                label="Productos Activos"
                value={`${data.activeProducts}`}
                sub={`${data.totalProducts} total`}
                icon={Package}
                colorClass="text-amber-500"
                bgClass="bg-amber-500/10"
            />
            <KpiCard
                label="Clientes"
                value={`${data.totalClients}`}
                sub="Registrados"
                icon={Users}
                colorClass="text-sky-500"
                bgClass="bg-sky-500/10"
            />
            <KpiCard
                label="Categorías"
                value={`${data.categoriesCount}`}
                sub="Activas"
                icon={Tags}
                colorClass="text-violet-500"
                bgClass="bg-violet-500/10"
            />
        </div>
    );
}

