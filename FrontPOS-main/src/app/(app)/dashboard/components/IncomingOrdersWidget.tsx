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

    // Solo mostrar pedidos que están PENDIENTES
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
        <Card className="bg-white/70 dark:bg-zinc-900/40 backdrop-blur-2xl border border-gray-200 dark:border-white/5 rounded-[2.5rem] shadow-xl overflow-hidden transition-all duration-500 hover:shadow-emerald-500/10">
            <CardHeader className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-gray-50/50 dark:bg-white/5">
                <div className="flex items-center gap-3">
                    <div className="h-12 w-12 rounded-2xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center border border-emerald-500/20 shadow-sm transform -rotate-3 group-hover:rotate-0 transition-transform">
                        <Truck size={24} />
                    </div>
                    <div>
                        <h2 className="text-xl font-black text-gray-900 dark:text-white uppercase italic tracking-tighter leading-none">
                            Recepción de <span className="text-emerald-500">Pedidos</span>
                        </h2>
                        <div className="flex items-center gap-2 mt-1.5">
                             <p className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">
                                Inversión Estimada:
                            </p>
                            <span className="text-[11px] font-black text-emerald-500 uppercase tracking-tighter tabular-nums bg-emerald-500/10 px-2 py-0.5 rounded-lg border border-emerald-500/20">
                                ${formatCurrency(totalToday)}
                            </span>
                        </div>
                    </div>
                </div>
                <Button 
                    onPress={() => window.location.href = '/inventory/receive'}
                    className="w-full sm:w-auto bg-emerald-500 text-white font-black uppercase text-[11px] tracking-widest rounded-2xl shadow-lg shadow-emerald-500/30 px-8 py-6 active:scale-95 transition-all hover:bg-emerald-400"
                >
                    <Plus size={16} className="mr-2" /> RECIBIR MERCANCÍA
                </Button>
            </CardHeader>
            <CardBody className="p-4 md:p-8 flex flex-col gap-4">
                {todayOrders.length === 0 ? (
                    <div className="py-12 flex flex-col items-center justify-center opacity-30 grayscale hover:grayscale-0 transition-all">
                        <Package size={48} className="mb-4 text-emerald-500" />
                        <p className="text-[11px] font-black uppercase tracking-widest mt-2 text-center">
                            No hay entregas pendientes<br/>
                            <span className="text-[9px] font-bold text-gray-400">Todo el stock está al día</span>
                        </p>
                    </div>
                ) : todayOrders.map((order) => (
                    <div 
                        key={order.id} 
                        onClick={() => window.location.href = `/inventory/receive?orderId=${order.id}`}
                        className="group flex flex-col sm:flex-row items-start sm:items-center justify-between p-5 bg-white dark:bg-zinc-950/40 border border-gray-100 dark:border-white/5 rounded-[1.5rem] hover:border-emerald-500/50 hover:bg-emerald-500/[0.02] transition-all cursor-pointer shadow-sm hover:shadow-md"
                    >
                        <div className="flex items-center gap-5 w-full sm:w-auto">
                            <div className={`h-14 w-14 rounded-2xl bg-gray-100 dark:bg-white/5 flex items-center justify-center group-hover:bg-emerald-500/10 group-hover:text-emerald-500 transition-all shadow-inner`}>
                                <Truck size={28} />
                            </div>
                            <div className="flex flex-col min-w-0 flex-1">
                                <span className="text-[15px] font-black text-gray-900 dark:text-white uppercase italic tracking-tighter truncate leading-none">
                                    {order.supplierName}
                                </span>
                                <div className="flex items-center gap-2 mt-1.5">
                                    <span className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none">
                                        {order.itemCount} productos • ID #{order.id}
                                    </span>
                                </div>
                            </div>
                        </div>
 
                        <div className="flex items-center gap-6 mt-4 sm:mt-0 w-full sm:w-auto justify-between sm:justify-end border-t sm:border-t-0 border-gray-100 dark:border-white/5 pt-4 sm:pt-0">
                            <div className="flex flex-col items-end leading-none">
                                <span className="text-[8px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-widest mb-1.5">ESTIMADO TOTAL</span>
                                <span className="text-lg font-black text-gray-900 dark:text-white uppercase tabular-nums italic tracking-tighter leading-none">
                                    ${formatCurrency(order.totalEstimated)}
                                </span>
                            </div>
                            <div className="flex flex-col gap-2 items-end">
                                <Chip 
                                    variant="flat" 
                                    color={getStatusColor(order.status) as any} 
                                    startContent={getStatusIcon(order.status)}
                                    className="font-black text-[10px] uppercase tracking-tighter h-8 px-4 rounded-xl border border-current/20"
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
