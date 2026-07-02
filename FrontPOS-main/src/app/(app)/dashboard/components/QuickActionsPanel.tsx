"use client";

import { Card, CardBody, Button } from "@heroui/react";
import {
    PlusCircle, ShoppingBag, Landmark, ReceiptText,
    ArrowUpRight, Calculator, PackageSearch
} from "lucide-react";
import Link from "next/link";

export default function QuickActionsPanel() {
    const actions = [
        {
            label: "Nueva Venta",
            icon: ShoppingBag,
            href: "/sales/new",
            color: "emerald",
            shadow: ""
        },
        {
            label: "Añadir Producto",
            icon: PlusCircle,
            href: "/products",
            color: "amber",
            shadow: "shadow-amber-500/20"
        },
        {
            label: "Cuadrar Caja",
            icon: Calculator,
            href: "/dashboard/closure",
            color: "sky",
            shadow: "shadow-sky-500/20"
        },
        {
            label: "Nuevo Egreso",
            icon: ReceiptText,
            href: "/expenses",
            color: "rose",
            shadow: "shadow-rose-500/20"
        },
        {
            label: "Pedidos Inteligentes",
            icon: PackageSearch,
            href: "/inventory/orders",
            color: "purple",
            shadow: "shadow-purple-500/20"
        }
    ];

    return (
        <Card className="card-base border-none dark:bg-[#18181b]/50 border border-gray-200/80 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] h-full" radius="lg">
            <CardBody className="p-4 md:p-6">
                <div className="flex items-center gap-2 mb-6">
                    <div className="p-2 bg-black/5 dark:bg-white/5 rounded-2xl">
                        <Landmark size={20} strokeWidth={2.5} className="text-zinc-900 dark:text-zinc-100" />
                    </div>
                    <div>
                        <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tighter">Acciones Rapidas</h3>
                        <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest">Gestion Inmediata</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 gap-3">
                    {actions.map((action, i) => (
                        <Link key={i} href={action.href} className="block group">
                            <div className={`
                                flex items-center justify-between p-3.5 rounded-2xl border border-transparent 
                                bg-gray-50 dark:bg-[#18181b] hover:bg-white dark:hover:bg-white/5 dark:bg-transparent 
                                hover:border-gray-200 dark:hover:border-zinc-200 dark:border-white/10 
                                transition-all duration-300 ${action.shadow} hover:shadow-[0_8px_30px_rgb(0,0,0,0.12)]
                            `}>
                                <div className="flex items-center gap-3">
                                    <div className={`p-2.5 rounded-2xl bg-${action.color}-500/10 text-${action.color}-500 group-hover:scale-110 transition-transform`}>
                                        <action.icon size={20} strokeWidth={2.5} />
                                    </div>
                                    <span className="text-xs font-bold text-gray-700 dark:text-zinc-300 uppercase tracking-wide">
                                        {action.label}
                                    </span>
                                </div>
                                <ArrowUpRight size={20} strokeWidth={2.5} className="text-gray-400 dark:text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>
                        </Link>
                    ))}
                </div>

                <div className="mt-6 p-4 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 border border-emerald-500/10">
                    <p className="text-[9px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 uppercase tracking-[0.2em] mb-1">Tip de Eficiencia</p>
                    <p className="text-[11px] text-gray-500 dark:text-zinc-400 leading-relaxed tracking-tight">
                        Usa las acciones rapidas para reducir el tiempo de atencion en caja. "Zero-Friction" es la clave.
                    </p>
                </div>
            </CardBody>
        </Card>
    );
}
