"use client"

import React from 'react'
import { Card, CardHeader, CardBody, Button, Chip } from "@heroui/react"
import { Truck, Package, Clock, ShoppingCart, DollarSign, CheckCircle2, Plus } from "lucide-react"
import { formatCurrency } from "@/lib/utils"
import { Skeleton } from "@heroui/react"

import { useApi } from "@/hooks/use-api"

interface ExpectedOrder {
    id: number;
    supplierId: number;
    supplierName: string;
    expectedDate: string;
    totalEstimated: number;
    itemCount: number;
    status: string;
}

export default function IncomingOrdersWidget() {
    const { data: orders, isLoading } = useApi<ExpectedOrder[]>('/orders/expected-today', {
        refreshInterval: 300000
    });

    // Solo mostrar pedidos que estan PENDIENTES
    const todayOrders = orders?.filter(order => order.status === 'PENDING') || [];
    const totalToday = todayOrders.reduce((acc, order) => acc + (order.totalEstimated || 0), 0);

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'PENDING': return 'warning';
            case 'RECEIVED': return 'success';
            case 'CANCELLED': return 'danger';
            default: return 'default';
        }
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'PENDING': return <Clock size={14} className="animate-pulse" />;
            case 'RECEIVED': return <CheckCircle2 size={14} />;
            default: return <Package size={14} />;
        }
    };

    if (isLoading) return <Skeleton className="h-60 w-full rounded-[2.5rem]" />;

    return (
        <Card className="bg-white/70 dark:bg-[#18181b]/40 border border-gray-200 dark:border-white/5 rounded-[2.5rem] shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden transition-all duration-500 hover:shadow-emerald-500/10">
            <CardHeader className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-gray-50/50 dark:bg-[#18181b]">
                <div className="flex items-center gap-3">
                    <div className="h-12 w-12 rounded-2xl bg-white/5 text-zinc-900 dark:text-zinc-100 flex items-center justify-center border border-emerald-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)] transform -rotate-3 group-hover:rotate-0 transition-transform">
                        <Truck size={24} />
                    </div>
                    <div>
                        <h2 className="text-xl font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tighter leading-none">
                            Recepcion de <span className="text-zinc-900 dark:text-zinc-100">Pedidos</span>
                        </h2>
                        <div className="flex items-center gap-2 mt-1.5">
                             <p className="text-[9px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest">
                                Inversion Estimada:
                            </p>
                            <span className="text-[11px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-tighter tabular-nums bg-white/5 px-2 py-0.5 rounded-2xl border border-emerald-500/20">
                                ${formatCurrency(totalToday)}
                            </span>
                        </div>
                    </div>
                </div>
                <Button 
                    onPress={() => window.location.href = '/inventory/receive'}
                    className="w-full sm:w-auto bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 font-medium uppercase text-[11px] tracking-widest rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] px-8 py-6 active:scale-95 transition-all hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5"
                >
                    <Plus size={16} className="mr-2" /> RECIBIR MERCANCIA
                </Button>
            </CardHeader>
            <CardBody className="p-4 md:p-8 flex flex-col gap-4 overflow-x-hidden">
                {todayOrders.length === 0 ? (
                    <div className="py-12 flex flex-col items-center justify-center opacity-30 grayscale hover:grayscale-0 transition-all">
                        <Package size={48} className="mb-4 text-zinc-900 dark:text-zinc-100" />
                        <p className="text-[11px] font-medium uppercase tracking-widest mt-2 text-center">
                            No hay entregas pendientes<br/>
                            <span className="text-[9px] font-bold text-gray-400">Todo el stock esta al dia</span>
                        </p>
                    </div>
                ) : todayOrders.map((order) => (
                    <div 
                        key={order.id} 
                        onClick={() => window.location.href = `/inventory/receive?orderId=${order.id}`}
                        className="group flex flex-col sm:flex-row items-start sm:items-center justify-between p-5 bg-white dark:bg-zinc-950/40 border border-gray-100 dark:border-white/5 rounded-[1.5rem] hover:border-emerald-500/50 hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5/[0.02] transition-all cursor-pointer shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
                    >
                        <div className="flex items-center gap-5 w-full sm:w-auto">
                            <div className={`h-14 w-14 rounded-2xl bg-gray-100 dark:bg-[#18181b] flex items-center justify-center group-hover:bg-white/5 group-hover:text-zinc-900 dark:text-zinc-100 transition-all shadow-inner`}>
                                <Truck size={28} />
                            </div>
                            <div className="flex flex-col min-w-0 flex-1">
                                <span className="text-[15px] font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tighter truncate leading-none">
                                    {order.supplierName}
                                </span>
                                <div className="flex items-center gap-2 mt-1.5">
                                    <span className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest leading-none">
                                        {order.itemCount} productos • ID #{order.id}
                                    </span>
                                </div>
                            </div>
                        </div>
 
                        <div className="flex items-center gap-6 mt-4 sm:mt-0 w-full sm:w-auto justify-between sm:justify-end border-t sm:border-t-0 border-gray-100 dark:border-white/5 pt-4 sm:pt-0">
                            <div className="flex flex-col items-end leading-none">
                                <span className="text-[8px] font-medium text-gray-400 dark:text-zinc-600 uppercase tracking-widest mb-1.5">ESTIMADO TOTAL</span>
                                <span className="text-lg font-medium text-zinc-900 dark:text-zinc-50 uppercase tabular-nums tracking-tight tracking-tighter leading-none">
                                    ${formatCurrency(order.totalEstimated)}
                                </span>
                            </div>
                            <div className="flex flex-col gap-2 items-end">
                                <Chip 
                                    variant="flat" 
                                    color={getStatusColor(order.status) as any} 
                                    startContent={getStatusIcon(order.status)}
                                    className="font-medium text-[10px] uppercase tracking-tighter h-8 px-4 rounded-2xl border border-current/20"
                                >
                                    {order.status}
                                </Chip>
                            </div>
                        </div>
                    </div>
                ))}
            </CardBody>
        </Card>
    )
}
