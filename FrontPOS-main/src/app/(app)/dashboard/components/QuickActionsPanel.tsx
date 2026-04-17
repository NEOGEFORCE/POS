"use client";

import { Card, CardBody, Button } from "@heroui/react";
import { 
    PlusCircle, ShoppingBag, Landmark, ReceiptText, 
    ArrowUpRight, Calculator
} from "lucide-react";
import Link from "next/link";

export default function QuickActionsPanel() {
    const actions = [
        {
            label: "Nueva Venta",
            icon: ShoppingBag,
            href: "/sales/new",
            color: "emerald",
            shadow: "shadow-emerald-500/20"
        },
        {
            label: "Añadir Producto",
            icon: PlusCircle,
            href: "/inventory",
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
            label: "Registrar Gasto",
            icon: ReceiptText,
            href: "/dashboard/closure", // Placeholder o redirección a caja
            color: "rose",
            shadow: "shadow-rose-500/20"
        }
    ];

    return (
        <Card className="bg-white/90 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200/80 dark:border-white/5 shadow-xl h-full" radius="lg">
            <CardBody className="p-4 md:p-6">
                <div className="flex items-center gap-2 mb-6">
                    <div className="p-2 bg-emerald-500/10 rounded-xl">
                        <Landmark className="h-5 w-5 text-emerald-500" />
                    </div>
                    <div>
                        <h3 className="text-sm font-black text-gray-900 dark:text-white uppercase tracking-tighter">Acciones Rápidas</h3>
                        <p className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest">Gestión Inmediata</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 gap-3">
                    {actions.map((action, i) => (
                        <Link key={i} href={action.href} className="block group">
                            <div className={`
                                flex items-center justify-between p-3.5 rounded-2xl border border-transparent 
                                bg-gray-50 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 
                                hover:border-gray-200 dark:hover:border-white/10 
                                transition-all duration-300 ${action.shadow} hover:shadow-lg
                            `}>
                                <div className="flex items-center gap-3">
                                    <div className={`p-2.5 rounded-xl bg-${action.color}-500/10 text-${action.color}-500 group-hover:scale-110 transition-transform`}>
                                        <action.icon size={20} />
                                    </div>
                                    <span className="text-xs font-bold text-gray-700 dark:text-zinc-300 uppercase tracking-wide">
                                        {action.label}
                                    </span>
                                </div>
                                <ArrowUpRight size={16} className="text-gray-400 dark:text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>
                        </Link>
                    ))}
                </div>

                <div className="mt-6 p-4 rounded-2xl bg-emerald-500/5 border border-emerald-500/10">
                    <p className="text-[9px] font-black text-emerald-600 dark:text-emerald-500 uppercase tracking-[0.2em] mb-1">Tip de Eficiencia</p>
                    <p className="text-[11px] text-gray-500 dark:text-zinc-400 leading-relaxed italic">
                        Usa las acciones rápidas para reducir el tiempo de atención en caja. "Zero-Friction" es la clave.
                    </p>
                </div>
            </CardBody>
        </Card>
    );
}
