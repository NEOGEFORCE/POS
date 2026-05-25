"use client";

import { Card, CardBody, Button, Badge, Chip, Skeleton, Modal, ModalContent, ModalHeader, ModalBody, Input } from "@heroui/react";
import { 
  Package, Truck, ShoppingBag, ArrowUpCircle, 
  Search, ShieldCheck, Sparkles, BarChart3, ChevronRight,
  AlertTriangle, TrendingDown, DollarSign, ArrowRight, Send, Plus, Calendar, Building2
} from 'lucide-react';
import Link from 'next/link';
import { useApi } from "@/hooks/use-api";
import { Product } from "@/lib/definitions";
import { formatCurrency, formatCOP, formatStock, isProductWeighted, formatTime } from "@/lib/utils";
import Cookies from 'js-cookie';
import React, { useMemo, useState, useEffect } from "react";
import { broadcastRevalidate, setupSyncListener } from '@/lib/revalidate';
import CreateScheduledDeliveryModal from "./components/CreateScheduledDeliveryModal";

interface ExpectedOrder {
  id: number;
  supplierName: string;
  expectedDate: string;
  totalEstimated: number;
  status: 'PENDING' | 'IN_TRANSIT' | 'RECEIVED';
  itemCount: number;
}

export default function InventoryHub() {
  // Integración de datos reales
  const { data: products, isLoading, mutate } = useApi<Product[]>("/products/all-products", {
    revalidateOnFocus: true,
  });

  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [isPreventaModalOpen, setIsPreventaModalOpen] = useState(false);

  // Fetch pedidos esperados para hoy con SWR (Reactividad Global)
  const { 
    data: expectedOrdersData, 
    isLoading: loadingOrders, 
    mutate: mutateOrders 
  } = useApi<ExpectedOrder[]>(`/orders/expected-today?date=${selectedDate}`);

  const expectedOrders = expectedOrdersData || [];

  // Enviar fila a Telegram
  const sendToTelegram = async () => {
    if (expectedOrders.length === 0) return;
    try {
      const token = Cookies.get('org-pos-token');
      await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/telegram/send-delivery-summary`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ orders: expectedOrders })
      });
    } catch (err) {
      console.error('Error sending to Telegram:', err);
    }
  };

  // Registro de preventa ahora se maneja en el componente modal
  const handleSuccessPreventa = () => {
    mutateOrders();
  };

  // Escuchar actualizaciones globales
  useEffect(() => {
    const cleanup = setupSyncListener((event) => {
        if (['PRODUCT_UPDATE', 'STOCK_UPDATE', 'SALE_MADE', 'DASHBOARD_UPDATE', 'CATEGORY_UPDATE', 'SUPPLIER_UPDATE'].includes(event)) {
            mutate();
            mutateOrders();
        }
    });
    return cleanup;
  }, [mutate, mutateOrders]);
  
  // Cálculos en tiempo real con useMemo
  const stats = useMemo(() => {
    if (!products || products.length === 0) {
      return {
        totalCostValue: 0,
        totalSaleValue: 0,
        totalItems: 0,
        criticalItems: [],
        healthPercentage: 0
      };
    }

    let totalCostValue = 0;
    let totalSaleValue = 0;
    const criticalItems: Product[] = [];
    let healthyCount = 0;

    products.forEach((p) => {
      const purchasePrice = Number(p.purchasePrice ?? 0) || 0;
      const salePrice = Number(p.salePrice ?? 0) || 0;
      const quantity = Number(p.quantity ?? 0) || 0;
      const minStock = Number(p.minStock ?? 0) || 0;
      
      // Skip weighted products (like cheese sold by weight) from ALL calculations
      // They have infinite/placeholder stock that skews valuation
      if (isProductWeighted(p)) {
        healthyCount++;
        return;
      }
      
      totalCostValue += purchasePrice * quantity;
      totalSaleValue += salePrice * quantity;

      if (quantity <= minStock) {
        criticalItems.push(p);
      } else {
        healthyCount++;
      }
    });

    const healthPercentage = products.length > 0 
      ? Math.round((healthyCount / products.length) * 100) 
      : 0;

    return {
      totalCostValue: Math.round(totalCostValue),
      totalSaleValue: Math.round(totalSaleValue),
      totalItems: products.length,
      criticalItems: criticalItems.slice(0, 8), // Top 8 críticos
      healthPercentage
    };
  }, [products]);
    type ModuleConfig = {
      title: string;
      description: string;
      icon: typeof Truck;
      href: string;
      colorClass: string;
      shadowClass: string;
      badgeColor: "success" | "warning" | "primary";
      badge: string;
      shortcut: string;
    };

    const modules: ModuleConfig[] = [
        {
            title: "Carga de Mercancía",
            description: "Registrar entradas de productos y facturas de proveedores.",
            icon: Truck,
            href: "/inventory/receive",
            colorClass: "bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5",
            shadowClass: "shadow-emerald-500/40",
            badgeColor: "success",
            badge: "Sincronizado",
            shortcut: "C"
        },
        {
            title: "Pedidos Inteligentes",
            description: "Generar órdenes de compra basadas en predicción de stock e IA.",
            icon: ShoppingBag,
            href: "/inventory/orders",
            colorClass: "bg-amber-500",
            shadowClass: "shadow-amber-500/40",
            badgeColor: "warning",
            badge: "IA v4.5",
            shortcut: "P"
        },
        {
            title: "Auditoría & Ajustes",
            description: "Corregir niveles de stock y realizar conteos manuales.",
            icon: ShieldCheck,
            href: "/audit",
            colorClass: "bg-sky-500",
            shadowClass: "shadow-sky-500/40",
            badgeColor: "primary",
            badge: "Seguro",
            shortcut: "A"
        }
    ];

    return (
        <div className="h-full w-full overflow-y-auto bg-transparent text-zinc-900 dark:text-white transition-all duration-500 relative scroll-smooth custom-scrollbar">
            <div className="flex flex-col gap-6 min-h-max w-full max-w-[1200px] mx-auto p-3 md:p-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
            
            {/* HEADER HUB */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                <div className="flex flex-col">
                    <div className="flex items-center gap-2 mb-1">
                        <div className="h-8 w-8 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white rounded-2xl flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] rotate-3">
                            <Package size={16} />
                        </div>
                        <h1 className="text-xl md:text-2xl font-medium text-zinc-900 dark:text-zinc-50 tracking-tighter tracking-tight uppercase">
                            Consola de <span className="text-zinc-900 dark:text-zinc-100">Inventario</span>
                        </h1>
                    </div>
                    <p className="text-[9px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.3em] tracking-tight ml-1">Master Control Ledger</p>
                </div>

                <div className="flex gap-2">
                    <Button variant="flat" size="sm" className="h-8 rounded-2xl font-medium text-[9px] uppercase tracking-tight tracking-wider card-base border-none border border-gray-200 dark:border-white/10 px-3">
                        <BarChart3 size={12} className="mr-1" /> Reporte
                    </Button>
                </div>
            </div>

            {/* DASHBOARD INTELIGENTE - DATOS EN TIEMPO REAL */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
                {/* Valorización Costo */}
                <Card className="bg-zinc-50 dark:bg-[#18181b]/50 border border-gray-200 dark:border-white/5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                    <CardBody className="p-3 flex flex-row items-center gap-2">
                        <div className="h-8 w-8 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] rotate-3">
                            <DollarSign size={16} />
                        </div>
                        <div className="flex flex-col min-w-0">
                            <span className="text-[8px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 uppercase tracking-wider tracking-tight">Inversión (Costo)</span>
                            {isLoading ? (
                                <Skeleton className="h-5 w-20 rounded" />
                            ) : (
                                <h3 className="text-base font-medium tracking-tight tracking-tighter truncate text-zinc-900 dark:text-zinc-50">
                                    ${formatCOP(stats.totalCostValue)}
                                </h3>
                            )}
                        </div>
                    </CardBody>
                </Card>

                {/* Valorización Venta */}
                <Card className="bg-blue-500/5 dark:bg-[#18181b] border border-blue-500/10 dark:border-white/5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                    <CardBody className="p-3 flex flex-row items-center gap-2">
                        <div className="h-8 w-8 rounded-2xl bg-blue-500 text-white flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-blue-500/20 -rotate-3">
                            <TrendingDown className="rotate-180" size={16} />
                        </div>
                        <div className="flex flex-col min-w-0">
                            <span className="text-[8px] font-medium text-blue-600 dark:text-blue-500 uppercase tracking-wider tracking-tight">Valor Proyectado</span>
                            {isLoading ? (
                                <Skeleton className="h-5 w-20 rounded" />
                            ) : (
                                <h3 className="text-base font-medium tracking-tight tracking-tighter truncate text-zinc-900 dark:text-zinc-50">
                                    ${formatCOP(stats.totalSaleValue)}
                                </h3>
                            )}
                        </div>
                    </CardBody>
                </Card>

                {/* Salud del Stock */}
                <Card className="bg-zinc-50 dark:bg-[#18181b]/50 border border-gray-200 dark:border-white/5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                    <CardBody className="p-3 flex flex-row items-center gap-2">
                        <div className={`h-8 w-8 rounded-2xl flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] rotate-3 ${stats.healthPercentage >= 80 ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5' : stats.healthPercentage >= 50 ? 'bg-amber-500' : 'bg-rose-500'} text-white`}>
                            <ShieldCheck size={16} />
                        </div>
                        <div className="flex flex-col">
                            <span className="text-[8px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-wider tracking-tight">Salud de Stock</span>
                            {isLoading ? (
                                <Skeleton className="h-5 w-14 rounded" />
                            ) : (
                                <h3 className={`text-base font-medium tracking-tight tracking-tighter ${stats.healthPercentage >= 80 ? 'text-zinc-900 dark:text-zinc-100' : stats.healthPercentage >= 50 ? 'text-amber-500' : 'text-rose-500'}`}>
                                    {stats.healthPercentage}%
                                </h3>
                            )}
                        </div>
                    </CardBody>
                </Card>
                
                {/* Ítems Críticos */}
                <Card className="bg-zinc-50 dark:bg-[#18181b]/50 border border-gray-200 dark:border-white/5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                    <CardBody className="p-3 flex flex-row items-center gap-2">
                        <div className="h-8 w-8 rounded-2xl bg-rose-500 text-white flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20 -rotate-3">
                            <AlertTriangle size={16} />
                        </div>
                        <div className="flex flex-col">
                            <span className="text-[8px] font-medium text-rose-600 dark:text-rose-500 uppercase tracking-wider tracking-tight">Críticos</span>
                            {isLoading ? (
                                <Skeleton className="h-5 w-10 rounded" />
                            ) : (
                                <h3 className="text-base font-medium tracking-tight tracking-tighter text-rose-500">
                                    {stats.criticalItems.length}
                                </h3>
                            )}
                        </div>
                    </CardBody>
                </Card>

                {/* Total Referencias */}
                <Card className="bg-zinc-50 dark:bg-[#18181b]/50 border border-gray-200 dark:border-white/5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                    <CardBody className="p-3 flex flex-row items-center gap-2">
                        <div className="h-8 w-8 rounded-2xl bg-slate-500 text-white flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-slate-500/20">
                            <Package size={16} />
                        </div>
                        <div className="flex flex-col">
                            <span className="text-[8px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-wider tracking-tight">SKU</span>
                            {isLoading ? (
                                <Skeleton className="h-5 w-12 rounded" />
                            ) : (
                                <h3 className="text-base font-medium tracking-tight tracking-tighter text-zinc-900 dark:text-zinc-50">
                                    {stats.totalItems}
                                </h3>
                            )}
                        </div>
                    </CardBody>
                </Card>
            </div>

            {/* PANEL DE ÍTEMS CRÍTICOS - ACTIONABLE UI */}
            {stats.criticalItems.length > 0 && (
                <Card className="bg-rose-50 dark:bg-rose-950/20 border-2 border-rose-500/10 dark:border-rose-500/20 rounded-2xl overflow-hidden animate-pulse-subtle shrink-0 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/5">
                    <CardBody className="p-3">
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                                <div className="h-6 w-6 rounded-2xl bg-rose-500 text-white flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/30">
                                    <TrendingDown size={12} />
                                </div>
                                <div>
                                    <h3 className="text-xs font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tight">
                                        Reabastecimiento <span className="text-rose-500">Urgente</span>
                                    </h3>
                                </div>
                            </div>
                            <Link href="/inventory/orders">
                                <Button 
                                    className="bg-rose-500 text-white font-medium uppercase text-[9px] tracking-wider rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20 hover:scale-105 transition-all h-7 px-3"
                                    endContent={<ArrowRight size={12} />}
                                >
                                    Pedido
                                </Button>
                            </Link>
                        </div>
                        
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                            {stats.criticalItems.map((item) => (
                                <div 
                                    key={item.barcode || item.id} 
                                    className="flex items-center gap-2 p-2 card-base border-none rounded-2xl border border-rose-200 dark:border-rose-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
                                >
                                    <div className="flex-1 min-w-0">
                                        <p className="text-[10px] font-bold text-zinc-900 dark:text-zinc-50 truncate">
                                            {item.productName}
                                        </p>
                                        <p className="text-[8px] text-gray-400">
                                            {item.barcode}
                                        </p>
                                    </div>
                                    <div className="flex flex-col items-end">
                                        <Chip 
                                            size="sm" 
                                            variant="flat" 
                                            color="danger"
                                            className="font-bold text-[8px] h-5"
                                        >
                                            {formatStock(item.quantity || 0, item.isPack, isProductWeighted(item))}
                                        </Chip>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </CardBody>
                </Card>
            )}

            {/* GRID DE MÓDULOS */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {modules.map((mod) => (
                    <Link key={mod.href} href={mod.href} className="group">
                        <Card className="h-full card-base border-none border border-gray-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:border-emerald-500/50 dark:hover:border-emerald-500/30 transition-all duration-300 group-hover:scale-[1.02] overflow-hidden">
                            <CardBody className="p-4 flex flex-col items-start gap-2 h-full relative">
                                <div className={`h-10 w-10 rounded-2xl ${mod.colorClass} text-white flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] ${mod.shadowClass} relative z-10 group-hover:rotate-6 transition-transform`}>
                                    <mod.icon size={20} />
                                </div>

                                <div className="flex flex-col gap-0.5">
                                    <div className="flex items-center gap-2">
                                        <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tighter">{mod.title}</h2>
                                        <Badge color={mod.badgeColor} variant="flat" size="sm" className="font-bold text-[7px] tracking-wider border-none px-1.5 py-0">{mod.badge}</Badge>
                                    </div>
                                    <p className="text-[9px] font-medium text-gray-500 dark:text-zinc-400 leading-tight">
                                        {mod.description}
                                    </p>
                                </div>

                                <div className="mt-2 flex items-center gap-1 text-zinc-900 dark:text-zinc-100 font-bold text-[9px] uppercase tracking-wider tracking-tight">
                                    Acceder <ChevronRight size={12} />
                                </div>

                                {/* Decoración de fondo */}
                                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                                    <mod.icon size={60} strokeWidth={1} />
                                </div>
                            </CardBody>
                        </Card>
                    </Link>
                ))}
            </div>

            {/* PANEL LOGÍSTICO PANORÁMICO - RECEPCIÓN DE MERCANCÍA */}
            <Card className="w-full bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden">
                <CardBody className="p-0">
                    <div className="flex flex-col lg:flex-row">
                        {/* LADO IZQUIERDO (70%) - FILA DE LLEGADAS */}
                        <div className="flex-1 lg:w-[70%] p-4 lg:p-5 border-b lg:border-b-0 lg:border-r border-gray-200 dark:border-white/10 flex flex-col h-fit">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 text-white flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-amber-500/20 relative">
                                    <Truck size={20} className="relative z-10" />
                                    <div className="absolute inset-0 rounded-2xl bg-amber-500 blur-xl opacity-30" />
                                </div>
                                <div className="flex-1">
                                    <h3 className="text-sm font-medium text-zinc-900 dark:text-white uppercase tracking-tight tracking-tight flex items-center gap-2">
                                        Entregas Programadas <span className="text-amber-500">{selectedDate === new Date().toISOString().split('T')[0] ? 'Hoy' : selectedDate}</span>
                                    </h3>
                                    <p className="text-[9px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest">
                                        Logística & Recepción
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <div className="relative">
                                        <Calendar size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                                        <input 
                                            type="date" 
                                            value={selectedDate}
                                            onChange={(e) => setSelectedDate(e.target.value)}
                                            className="h-9 pl-9 pr-3 bg-zinc-100 dark:bg-[#18181b] border border-gray-200 dark:border-white/10 rounded-2xl text-[10px] font-medium uppercase tracking-wider focus:ring-2 focus:ring-amber-500/20 outline-none transition-all cursor-pointer"
                                        />
                                    </div>
                                    <Button 
                                        isIconOnly 
                                        size="sm" 
                                        variant="flat" 
                                        className="bg-amber-500/10 text-amber-500 rounded-2xl"
                                        onPress={() => setIsPreventaModalOpen(true)}
                                    >
                                        <Plus size={16} />
                                    </Button>
                                </div>
                            </div>

                            {/* Lista de pedidos esperados */}
                            <div className="mt-4 space-y-3">
                                {loadingOrders ? (
                                    <div className="flex gap-2">
                                        <Skeleton className="h-14 flex-1 rounded-2xl" />
                                        <Skeleton className="h-14 flex-1 rounded-2xl" />
                                    </div>
                                ) : expectedOrders.length > 0 ? (
                                    expectedOrders.map((order) => (
                                        <div 
                                            key={order.id}
                                            className="flex items-center justify-between p-3 bg-zinc-50 dark:bg-[#18181b]/50 border border-gray-200 dark:border-white/5 rounded-2xl hover:bg-gray-100 dark:hover:bg-zinc-100 dark:bg-zinc-800/50 hover:border-amber-500/20 transition-all group"
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className="h-8 w-8 rounded-2xl bg-gray-100 dark:bg-zinc-800 flex items-center justify-center text-gray-500 dark:text-zinc-400 group-hover:text-amber-500 group-hover:bg-amber-500/10 transition-colors">
                                                    <Building2 size={14} />
                                                </div>
                                                <div>
                                                    <p className="text-xs font-bold text-zinc-900 dark:text-white uppercase tracking-tight">
                                                        {order.supplierName}
                                                    </p>
                                                    <p className="text-[9px] text-gray-500 dark:text-zinc-500 font-medium">
                                                        {order.itemCount} ítems Â· {formatTime(order.expectedDate)}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <span className="text-xs font-medium text-zinc-900 dark:text-white tabular-nums">
                                                    {formatCurrency(Math.round(order.totalEstimated || 0))}
                                                </span>
                                                <Chip 
                                                    size="sm" 
                                                    variant="flat"
                                                    className="bg-amber-500/10 border border-amber-500/20 text-amber-500"
                                                    classNames={{ content: "text-[8px] font-medium uppercase tracking-wider" }}
                                                >
                                                    En camino
                                                </Chip>
                                            </div>
                                        </div>
                                    ))
                                ) : (
                                    <div className="flex flex-col items-center justify-center py-8 text-zinc-600">
                                        <Truck size={32} className="mb-2 opacity-20" />
                                        <p className="text-xs font-bold uppercase tracking-widest">
                                            No hay recepciones para {selectedDate === new Date().toISOString().split('T')[0] ? 'hoy' : selectedDate}
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* LADO DERECHO (30%) - CENTRO DE ACCIÓN */}
                        <div className="lg:w-[30%] p-4 lg:p-5 bg-gray-50 dark:bg-[#18181b]/30 flex flex-col justify-center">
                            <h4 className="text-xs font-medium text-zinc-900 dark:text-white uppercase tracking-widest mb-4 flex items-center gap-2">
                                <Sparkles size={12} className="text-zinc-900 dark:text-zinc-100" />
                                Reporte Logístico
                            </h4>
                            
                            <Button
                                onPress={sendToTelegram}
                                isDisabled={expectedOrders.length === 0}
                                className="w-full h-16 bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 text-white rounded-2xl font-bold text-[11px] uppercase tracking-wider shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-sky-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
                                startContent={<Send size={20} />}
                            >
                                Enviar Resumen a Telegram
                            </Button>

                            {/* Stats mini */}
                            <div className="mt-6 pt-4 border-t border-gray-200 dark:border-white/10 space-y-2">
                                <div className="flex justify-between text-[10px]">
                                    <span className="text-gray-500 dark:text-zinc-500 font-medium uppercase tracking-tighter">TOTAL EN TRÁNSITO:</span>
                                    <span className="text-zinc-900 dark:text-white font-medium tabular-nums">
                                        {expectedOrders.length} PEDIDO{expectedOrders.length !== 1 ? 'S' : ''}
                                    </span>
                                </div>
                                <div className="flex justify-between text-[10px]">
                                    <span className="text-gray-500 dark:text-zinc-500 font-medium uppercase tracking-tighter">VALOR ESTIMADO:</span>
                                    <span className="text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 font-medium tabular-nums">
                                        {formatCurrency(Math.round(expectedOrders.reduce((acc, o) => acc + o.totalEstimated, 0)))}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </CardBody>
            </Card>

            {/* FOOTER INFO */}
            <div className="flex items-center justify-center gap-2 py-4 opacity-30">
                <ShieldCheck size={12} />
                <span className="text-[8px] font-medium uppercase tracking-[0.4em] tracking-tight">Seguridad & Auditoría Activa</span>
            </div>

            <CreateScheduledDeliveryModal 
                isOpen={isPreventaModalOpen}
                onClose={() => setIsPreventaModalOpen(false)}
                onSuccess={handleSuccessPreventa}
            />

            </div>
        </div>
    );
}


