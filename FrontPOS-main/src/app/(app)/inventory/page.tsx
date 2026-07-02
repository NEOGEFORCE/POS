"use client";

import { Card, CardBody, Button, Badge, Chip, Skeleton, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Input } from "@heroui/react";
import { 
  Package, Truck, ShoppingBag, ArrowUpCircle, 
  Search, ShieldCheck, Sparkles, BarChart3, ChevronRight,
  AlertTriangle, TrendingDown, DollarSign, ArrowRight, Send, Plus, Calendar, Building2, X
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApi } from "@/hooks/use-api";
import { Product } from "@/lib/definitions";
import { formatCurrency, formatCOP, formatStock, isProductWeighted, formatTime, formatPrice } from "@/lib/utils";
import Cookies from 'js-cookie';
import React, { useMemo, useState, useEffect } from "react";
import { broadcastRevalidate, setupSyncListener } from '@/lib/revalidate';
import { useToast } from "@/hooks/use-toast";
import CreateScheduledDeliveryModal from "./components/CreateScheduledDeliveryModal";
import dynamic from "next/dynamic";
import { apiFetch, ApiError } from '@/lib/api-error';

const ProductFormModal = dynamic(() => import('../products/components/ProductFormModal'), { ssr: false });

// Interfaz unificada — igual a lo que devuelve /inventory/orders
interface OrderDetailItem {
  productName: string;
  barcode: string;
  quantity: number;
  unitCost: number;
}

interface ExpectedOrder {
  id: number | string;
  source: string;
  supplierId: number;
  supplierName: string;
  expectedDate: string;
  estimatedCost: number;
  totalEstimated?: number;
  invoiceRef?: string;      // precio real de factura (puede ser string numerico)
  itemCount: number;
  status?: string;
  items?: OrderDetailItem[];
}

export default function InventoryHub() {
  const router = useRouter();
  // Integracion de datos reales
  const { data: products, isLoading, mutate } = useApi<Product[]>("/products/all-products", {
    revalidateOnFocus: true,
  });

  const getBogotaDateStr = () => {
    return new Intl.DateTimeFormat('en-CA', { 
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  };

  const { toast } = useToast();
  const [editingStockProduct, setEditingStockProduct] = useState<Product | null>(null);
  const { data: categoriesData, mutate: mutateCategories } = useApi<any[]>('/categories/all');
  const { data: suppliersData, mutate: mutateSuppliers } = useApi<any[]>('/suppliers/all');
  
  const handleEditProduct = async () => {
    if (!editingStockProduct) return;
    const token = Cookies.get('org-pos-token');
    try {
        const payload = { ...editingStockProduct };
        const urlBarcode = encodeURIComponent(String(editingStockProduct.barcode).trim());

        await apiFetch(`/products/update-products/${urlBarcode}`, {
            method: 'PUT', body: JSON.stringify(payload), fallbackError: 'FALLO AL ACTUALIZAR'
        }, token!);
        toast({ variant: 'success', title: 'EXITO', description: 'PRODUCTO ACTUALIZADO' });
        setEditingStockProduct(null);
        mutate();
        broadcastRevalidate('PRODUCT_UPDATE');
    } catch (err: any) {
        toast({ variant: 'destructive', title: 'ERROR', description: err.message });
    }
  };

  const [selectedDate, setSelectedDate] = useState(getBogotaDateStr());
  const [isPreventaModalOpen, setIsPreventaModalOpen] = useState(false);
  const [selectedOrderDetail, setSelectedOrderDetail] = useState<ExpectedOrder | null>(null);
  const [loadingOrderDetail, setLoadingOrderDetail] = useState(false);
  const [orderDetailItems, setOrderDetailItems] = useState<OrderDetailItem[]>([]);
  const [orderSearchTerm, setOrderSearchTerm] = useState('');
  
  const [cancelConfirmId, setCancelConfirmId] = useState<number | string | null>(null);
  const [cancelConfirmSupplier, setCancelConfirmSupplier] = useState<string>('');
  const [isCanceling, setIsCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const filteredOrderItems = useMemo(() => {
    if (!orderSearchTerm) return orderDetailItems;
    const term = orderSearchTerm.toLowerCase();
    return orderDetailItems.filter(item => 
        (item.productName && item.productName.toLowerCase().includes(term)) ||
        (item.barcode && item.barcode.toLowerCase().includes(term))
    );
  }, [orderDetailItems, orderSearchTerm]);

  const API_BASE = process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api';

  const handleOpenOrderDetail = async (order: ExpectedOrder) => {
    setSelectedOrderDetail(order);
    setOrderDetailItems([]);
    setLoadingOrderDetail(true);
    try {
      const token = Cookies.get('org-pos-token');
      const res = await fetch(`${API_BASE}/inventory/orders/${order.id}/items?source=${order.source || ''}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setOrderDetailItems(Array.isArray(data) ? data : (data.items || []));
      }
    } catch (err) {
      console.error('Error loading order detail:', err);
    } finally {
      setLoadingOrderDetail(false);
    }
  };

  // Siempre derivar un YYYY-MM-DD limpio desde selectedDate en zona Bogota.
  // selectedDate ya viene del input type="date" como YYYY-MM-DD, pero parsearlo
  // con new Date() sin hora puede desplazarlo un dia por UTC. Añadimos T12:00
  // para anclar el mediodia y evitar el desfase.
  const bogotaDateStr = useMemo(() => {
    return Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(
      new Date(`${selectedDate}T12:00:00`)
    );
  }, [selectedDate]);

  // Usa el mismo endpoint que PendingOrdersView para ver TODOS los pedidos pendientes
  // (confirmed_orders + purchase_orders + expected_orders unificados).
  // Filtramos por fecha en el cliente para la vista de calendario.
  const { data: allOrdersData, isLoading: loadingOrders, mutate: mutateOrders } = useApi<ExpectedOrder[]>(`/inventory/orders`);
  const { data: allExpensesData } = useApi<any[]>("/expenses/list");

  useEffect(() => {
    console.log("Datos del Fetch Dashboard (unified):", allOrdersData);
    console.log("Fecha Buscada:", bogotaDateStr);
  }, [allOrdersData, bogotaDateStr]);

  // Filtro local: mostrar los pedidos cuya expectedDate sea menor o igual al dia
  // seleccionado y que NO esten ya completados/recibidos/descartados. Esto asegura
  // que no se pierdan pedidos pendientes/atrasados de días anteriores.
  const expectedOrders = useMemo(() => {
    const closedStatuses = new Set([
      'RECEIVED', 'COMPLETED', 'DISMISSED', 'CANCELLED', 'CANCELED',
    ]);
    
    // Mapear fechas de egresos por proveedor para saber si ya se pago
    const supplierExpenseDates = new Map<number, string[]>();
    if (allExpensesData) {
      allExpensesData.forEach(e => {
        if (e.category === 'Proveedores' && e.supplierId) {
          // Usamos formato local para evitar brincos de fecha por UTC
          const expenseDate = new Date(e.date).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
          const arr = supplierExpenseDates.get(e.supplierId) || [];
          arr.push(expenseDate);
          supplierExpenseDates.set(e.supplierId, arr);
        }
      });
    }

    return (allOrdersData || []).filter(o => {
      if (!o.expectedDate) return false;
      // Comparar solo YYYY-MM-DD (ignorar hora y timezone del string ISO)
      const orderDate = o.expectedDate.split('T')[0];
      
      // Mostrar pedidos de la fecha seleccionada y atrasados que no se han cerrado
      if (orderDate > bogotaDateStr) return false;

      // Excluir pedidos ya cerrados (case-insensitive — el backend mezcla
      // 'PENDING' uppercase de purchase_orders con 'pending' lowercase de
      // confirmed_orders).
      const status = (o.status || '').toUpperCase();
      if (closedStatuses.has(status)) return false;
      
      // Excluir si ya se pagó el egreso (fecha de egreso >= fecha esperada del pedido)
      if (o.supplierId) {
          const expenseDates = supplierExpenseDates.get(o.supplierId);
          if (expenseDates) {
              // Hay un pago el mismo dia del pedido o posterior
              const hasPaidAfterOrder = expenseDates.some((ed: string) => ed >= orderDate);
              if (hasPaidAfterOrder) {
                  return false;
              }
          }
      }
      
      return true;
    });
  }, [allOrdersData, bogotaDateStr, allExpensesData]);

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

  // Preparar cancelacion
  const handleCancelOrder = (e: React.MouseEvent, id: number | string, supplierName: string) => {
    e.stopPropagation();
    setCancelConfirmId(id);
    setCancelConfirmSupplier(supplierName);
    setCancelError(null);
  };

  // Ejecutar cancelacion
  const executeCancelOrder = async () => {
    if (!cancelConfirmId) return;
    setIsCanceling(true);
    setCancelError(null);
    try {
      const token = Cookies.get('org-pos-token');
      const baseUrl = process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api';
      const res = await fetch(`${baseUrl}/inventory/receive/pending/${cancelConfirmId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to cancel');
      setCancelConfirmId(null);
      mutateOrders();
    } catch (err) {
      console.error('Error canceling order:', err);
      setCancelError('Error al cancelar el pedido');
    } finally {
      setIsCanceling(false);
    }
  };

  // Registro de preventa ahora se maneja en el componente modal
  const handleSuccessPreventa = () => {
    mutateOrders();
  };

  // Escuchar actualizaciones globales
  useEffect(() => {
    const cleanup = setupSyncListener((event) => {
        if (['PRODUCT_UPDATE', 'STOCK_UPDATE', 'SALE_MADE', 'DASHBOARD_UPDATE', 'CATEGORY_UPDATE', 'SUPPLIER_UPDATE', 'INVENTORY_UPDATE', 'EXPENSE_UPDATE'].includes(event)) {
            mutate();
            mutateOrders();
        }
    });
    return cleanup;
  }, [mutate, mutateOrders]);
  
  // Calculos en tiempo real con useMemo
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
      criticalItems: criticalItems.slice(0, 8), // Top 8 criticos
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
            title: "Carga de Mercancia",
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
            description: "Generar ordenes de compra basadas en prediccion de stock e IA.",
            icon: ShoppingBag,
            href: "/inventory/orders",
            colorClass: "bg-amber-500",
            shadowClass: "shadow-amber-500/40",
            badgeColor: "warning",
            badge: "IA v4.5",
            shortcut: "P"
        },
        {
            title: "Auditoria & Ajustes",
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
        <div className="flex flex-col flex-1 w-full max-w-[1600px] mx-auto bg-transparent text-zinc-900 dark:text-white transition-all duration-500 relative scroll-smooth">
            <div className="flex flex-col flex-1 w-full max-w-[1200px] mx-auto p-3 md:p-4 animate-in fade-in slide-in-from-bottom-4 duration-500 gap-6">
            
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
                    <p className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.3em] tracking-tight ml-1">Master Control Ledger</p>
                </div>

                <div className="flex gap-2">
                    <Button variant="flat" size="sm" className="h-8 rounded-2xl font-medium text-[9px] uppercase tracking-tight tracking-wider card-base border-none border border-gray-200 dark:border-white/10 px-3">
                        <BarChart3 size={12} className="mr-1" /> Reporte
                    </Button>
                </div>
            </div>

            {/* DASHBOARD INTELIGENTE - DATOS EN TIEMPO REAL */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
                {/* Valorizacion Costo */}
                <Card className="bg-zinc-50 dark:bg-[#18181b]/50 border border-gray-200 dark:border-white/5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                    <CardBody className="p-3 flex flex-row items-center gap-2">
                        <div className="h-8 w-8 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] rotate-3">
                            <DollarSign size={16} />
                        </div>
                        <div className="flex flex-col min-w-0">
                            <span className="text-[8px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 uppercase tracking-wider tracking-tight">Inversion (Costo)</span>
                            {isLoading ? (
                                <Skeleton className="h-5 w-20 rounded" />
                            ) : (
                                <h3 className="text-base font-medium tracking-tight tracking-tighter truncate text-zinc-900 dark:text-zinc-50">
                                    {formatPrice(stats.totalCostValue)}
                                </h3>
                            )}
                        </div>
                    </CardBody>
                </Card>

                {/* Valorizacion Venta */}
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
                                    {formatPrice(stats.totalSaleValue)}
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
                
                {/* Items Criticos */}
                <Card className="bg-zinc-50 dark:bg-[#18181b]/50 border border-gray-200 dark:border-white/5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                    <CardBody className="p-3 flex flex-row items-center gap-2">
                        <div className="h-8 w-8 rounded-2xl bg-rose-500 text-white flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20 -rotate-3">
                            <AlertTriangle size={16} />
                        </div>
                        <div className="flex flex-col">
                            <span className="text-[8px] font-medium text-rose-600 dark:text-rose-500 uppercase tracking-wider tracking-tight">Criticos</span>
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

            {/* PANEL DE ITEMS CRITICOS - ACTIONABLE UI */}
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
                                    onClick={() => setEditingStockProduct(item)}
                                    className="flex items-center gap-2 p-2 card-base border-none rounded-2xl border border-rose-200 dark:border-rose-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)] cursor-pointer hover:scale-[1.02] hover:border-rose-400 transition-all"
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

            {/* GRID DE MODULOS */}
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

                                {/* Decoracion de fondo */}
                                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                                    <mod.icon size={60} strokeWidth={1} />
                                </div>
                            </CardBody>
                        </Card>
                    </Link>
                ))}
            </div>

            {/* PANEL LOGISTICO PANORAMICO - RECEPCION DE MERCANCIA */}
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
                                        Entregas Programadas <span className="text-amber-500">{selectedDate === getBogotaDateStr() ? 'Hoy' : selectedDate}</span>
                                    </h3>
                                    <p className="text-[9px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest">
                                        Logistica & Recepcion
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
                                            onClick={() => handleOpenOrderDetail(order)}
                                            className="flex items-center justify-between p-3 bg-zinc-50 dark:bg-[#18181b]/50 border border-gray-200 dark:border-white/5 rounded-2xl hover:bg-amber-50 dark:hover:bg-amber-950/20 hover:border-amber-500/30 transition-all group cursor-pointer"
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
                                                        {order.itemCount} items · <span className="text-amber-500 font-bold">Ver detalle →</span>
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <span className="text-xs font-medium text-zinc-900 dark:text-white tabular-nums">
                                                    {(() => {
                                                      const inv = parseFloat((order.invoiceRef || '').replace(/[^0-9.]/g, ''));
                                                      const real = !isNaN(inv) && inv > 0 ? inv : null;
                                                      return real
                                                        ? formatPrice(Math.round(real))
                                                        : formatPrice(Math.round(order.estimatedCost || order.totalEstimated || 0));
                                                    })()}
                                                </span>
                                                <Chip 
                                                    size="sm" 
                                                    variant="flat"
                                                    className="bg-amber-500/10 border border-amber-500/20 text-amber-500"
                                                    classNames={{ content: "text-[8px] font-medium uppercase tracking-wider" }}
                                                >
                                                    En camino
                                                </Chip>
                                                <Button 
                                                    isIconOnly
                                                    size="sm"
                                                    color="danger"
                                                    variant="light"
                                                    className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 z-10"
                                                    onClick={(e) => handleCancelOrder(e, order.id, order.supplierName)}
                                                >
                                                    <X size={14} />
                                                </Button>
                                            </div>
                                        </div>
                                    ))
                                ) : (
                                    <div className="flex flex-col items-center justify-center py-8 text-zinc-600">
                                        <Truck size={32} className="mb-2 opacity-20" />
                                        <p className="text-xs font-bold uppercase tracking-widest">
                                            No hay recepciones para {selectedDate === getBogotaDateStr() ? 'hoy' : selectedDate}
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* LADO DERECHO (30%) - CENTRO DE ACCION */}
                        <div className="lg:w-[30%] p-4 lg:p-5 bg-gray-50 dark:bg-[#18181b]/30 flex flex-col justify-center">
                            <h4 className="text-xs font-medium text-zinc-900 dark:text-white uppercase tracking-widest mb-4 flex items-center gap-2">
                                <Sparkles size={12} className="text-zinc-900 dark:text-zinc-100" />
                                Reporte Logistico
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
                                    <span className="text-gray-500 dark:text-zinc-500 font-medium uppercase tracking-tighter">TOTAL EN TRANSITO:</span>
                                    <span className="text-zinc-900 dark:text-white font-medium tabular-nums">
                                        {expectedOrders.length} PEDIDO{expectedOrders.length !== 1 ? 'S' : ''}
                                    </span>
                                </div>
                                <div className="flex justify-between text-[10px]">
                                    <span className="text-gray-500 dark:text-zinc-500 font-medium uppercase tracking-tighter">VALOR TOTAL:</span>
                                    <span className="text-zinc-900 dark:text-zinc-100 font-medium tabular-nums">
                                        {formatPrice(expectedOrders.reduce((acc, o) => {
                                          const inv = parseFloat((o.invoiceRef || '').replace(/[^0-9.]/g, ''));
                                          const real = !isNaN(inv) && inv > 0 ? inv : (o.estimatedCost || o.totalEstimated || 0);
                                          return acc + real;
                                        }, 0))}
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
                <span className="text-[8px] font-medium uppercase tracking-[0.4em] tracking-tight">Seguridad & Auditoria Activa</span>
            </div>

            <CreateScheduledDeliveryModal 
                isOpen={isPreventaModalOpen}
                onClose={() => setIsPreventaModalOpen(false)}
                onSuccess={handleSuccessPreventa}
            />

            {/* MODAL DETALLE DEL PEDIDO */}
            <Modal 
                isOpen={!!selectedOrderDetail} 
                onOpenChange={(open) => { if (!open) { setSelectedOrderDetail(null); setOrderSearchTerm(''); } }}
                size="2xl"
                classNames={{
                    base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl",
                    header: "border-b border-gray-200 dark:border-white/10 pb-3",
                    body: "pt-4"
                }}
            >
                <ModalContent>
                    <ModalHeader className="flex items-center justify-between gap-3 w-full pr-8">
                        <div className="flex items-center gap-3">
                            <div className="h-9 w-9 rounded-2xl bg-amber-500/10 flex items-center justify-center text-amber-500">
                                <Truck size={18} />
                            </div>
                            <div>
                                <p className="text-sm font-bold uppercase tracking-tight text-zinc-900 dark:text-white">
                                    {selectedOrderDetail?.supplierName}
                                </p>
                                <p className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest mt-0.5">
                                    Detalle del Pedido · En Camino
                                </p>
                            </div>
                        </div>
                        {orderDetailItems.length > 0 && (
                            <div className="w-[200px]">
                                <Input
                                    size="sm"
                                    placeholder="Buscar producto..."
                                    value={orderSearchTerm}
                                    onChange={(e) => setOrderSearchTerm(e.target.value)}
                                    startContent={<Search size={14} className="text-zinc-400" />}
                                    classNames={{
                                        inputWrapper: "bg-zinc-100 dark:bg-zinc-900 border-none shadow-none",
                                        input: "text-xs font-medium"
                                    }}
                                />
                            </div>
                        )}
                    </ModalHeader>
                    <ModalBody className="pb-6">
                        {/* Resumen */}
                        <div className="grid grid-cols-3 gap-3 mb-4">
                            <div className="bg-gray-50 dark:bg-zinc-900 rounded-2xl p-3 flex flex-col">
                                <span className="text-[9px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest mb-1">Items</span>
                                <span className="text-lg font-black text-zinc-900 dark:text-white">{selectedOrderDetail?.itemCount || orderDetailItems.length}</span>
                            </div>
                            <div className="bg-amber-50 dark:bg-amber-950/30 rounded-2xl p-3 flex flex-col border border-amber-200/50 dark:border-amber-500/20">
                                <span className="text-[9px] font-bold text-amber-600 uppercase tracking-widest mb-1">Valor Est.</span>
                                <span className="text-lg font-black text-amber-600 dark:text-amber-400">
                                    {formatPrice(Math.round(selectedOrderDetail?.estimatedCost || selectedOrderDetail?.totalEstimated || 0))}
                                </span>
                            </div>
                            <div className="bg-gray-50 dark:bg-zinc-900 rounded-2xl p-3 flex flex-col">
                                <span className="text-[9px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest mb-1">Llegada</span>
                                <span className="text-sm font-black text-zinc-900 dark:text-white">
                                    {selectedOrderDetail?.expectedDate?.split('T')[0] || '—'}
                                </span>
                            </div>
                        </div>

                        {/* Tabla de productos */}
                        {loadingOrderDetail ? (
                            <div className="flex flex-col gap-2">
                                {[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full rounded-xl" />)}
                            </div>
                        ) : orderDetailItems.length > 0 ? (
                            <div className="border border-gray-200 dark:border-white/10 rounded-2xl overflow-hidden">
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="bg-gray-100 dark:bg-zinc-900 border-b border-gray-200 dark:border-white/10">
                                            <th className="text-left p-3 font-bold uppercase tracking-widest text-[9px] text-gray-500 dark:text-zinc-500">Producto</th>
                                            <th className="text-center p-3 font-bold uppercase tracking-widest text-[9px] text-gray-500 dark:text-zinc-500">Cant.</th>
                                            <th className="text-right p-3 font-bold uppercase tracking-widest text-[9px] text-gray-500 dark:text-zinc-500">Costo Unit.</th>
                                            <th className="text-right p-3 font-bold uppercase tracking-widest text-[9px] text-gray-500 dark:text-zinc-500">Subtotal</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                                        {filteredOrderItems.length > 0 ? filteredOrderItems.map((item, idx) => (
                                            <tr key={idx} className="hover:bg-gray-50 dark:hover:bg-gray-50 dark:bg-zinc-900/50 transition-colors">
                                                <td className="p-3">
                                                    <p className="font-medium text-zinc-900 dark:text-white truncate max-w-[200px]">{item.productName || item.barcode}</p>
                                                    <p className="text-[9px] text-gray-500 dark:text-zinc-400 uppercase">{item.barcode}</p>
                                                </td>
                                                <td className="p-3 text-center font-bold text-amber-600 dark:text-amber-400">{item.quantity}</td>
                                                <td className="p-3 text-right text-zinc-700 dark:text-zinc-300">{formatPrice(item.unitCost || 0)}</td>
                                                <td className="p-3 text-right font-bold text-zinc-900 dark:text-white">{formatPrice((item.quantity || 0) * (item.unitCost || 0))}</td>
                                            </tr>
                                        )) : (
                                            <tr>
                                                <td colSpan={4} className="p-8 text-center">
                                                    <p className="text-xs font-bold text-zinc-500 uppercase tracking-widest">No se encontraron productos con "{orderSearchTerm}"</p>
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                    <tfoot>
                                        <tr className="bg-gray-50 dark:bg-zinc-900 border-t border-gray-200 dark:border-white/10">
                                            <td colSpan={3} className="p-3 text-right font-bold uppercase text-[9px] text-gray-500 dark:text-zinc-500 tracking-widest">TOTAL ESTIMADO</td>
                                            <td className="p-3 text-right font-black text-amber-600 dark:text-amber-400">
                                                {formatPrice(orderDetailItems.reduce((s, i) => s + (i.quantity || 0) * (i.unitCost || 0), 0))}
                                            </td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center py-10 opacity-50">
                                <Package size={32} className="mb-2" />
                                <p className="text-xs font-bold uppercase tracking-widest">Sin detalle de productos disponible</p>
                                <p className="text-[9px] text-gray-500 dark:text-zinc-500 mt-1">El pedido fue creado sin items individuales.</p>
                            </div>
                        )}
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-200 dark:border-white/10 pt-3 flex justify-end gap-2 pb-4 px-6">
                        <Button variant="flat" className="rounded-xl font-bold uppercase tracking-wider text-[10px]" onPress={() => setSelectedOrderDetail(null)}>
                            Cerrar
                        </Button>
                        <Button color="warning" className="rounded-xl font-bold uppercase tracking-wider text-[10px] text-zinc-900 dark:text-zinc-100" onPress={() => {
                            router.push(`/inventory/orders?edit_order=${selectedOrderDetail?.id}`);
                            setSelectedOrderDetail(null);
                        }}>
                            Editar Pedido
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>

            <ProductFormModal
                isOpen={editingStockProduct !== null}
                onOpenChange={(open) => { if (!open) setEditingStockProduct(null); }}
                addDialogOpen={false}
                newProduct={{} as any}
                setNewProduct={() => {}}
                editingProduct={editingStockProduct}
                setEditingProduct={setEditingStockProduct as any}
                categories={categoriesData || []}
                suppliers={suppliersData || []}
                mutateSuppliers={mutateSuppliers}
                mutateCategories={mutateCategories}
                allProducts={products || []}
                onConfirm={handleEditProduct}
                onScan={() => {}}
            />

            <Modal isOpen={cancelConfirmId !== null} onClose={() => setCancelConfirmId(null)} placement="center" backdrop="blur" classNames={{base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-2xl"}}>
                <ModalContent>
                    <ModalHeader className="flex flex-col gap-1 pb-0 pt-6 px-6">
                        <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                            <AlertTriangle className="text-rose-500" size={24} />
                            ¿Cancelar Pedido?
                        </h2>
                    </ModalHeader>
                    <ModalBody className="py-4 px-6">
                        <p className="text-gray-600 dark:text-gray-400 text-sm">
                            Estás a punto de cancelar y eliminar el pedido programado de <strong className="text-gray-900 dark:text-white uppercase tracking-wider">{cancelConfirmSupplier}</strong>.
                            Esta acción quitará el pedido del plan de entregas.
                        </p>
                        {cancelError && (
                            <div className="mt-2 p-3 bg-rose-50 dark:bg-rose-500/10 border border-rose-100 dark:border-rose-500/20 rounded-xl flex items-center gap-2">
                                <AlertTriangle className="text-rose-500 shrink-0" size={16} />
                                <p className="text-xs font-semibold text-rose-600 dark:text-rose-400">{cancelError}</p>
                            </div>
                        )}
                    </ModalBody>
                    <ModalFooter className="px-6 pb-6 pt-2 flex justify-end gap-2">
                        <Button variant="light" className="font-bold text-gray-500 rounded-xl" onPress={() => setCancelConfirmId(null)} isDisabled={isCanceling}>
                            No, Volver
                        </Button>
                        <Button color="danger" className="font-bold bg-rose-500 text-white rounded-xl" onPress={executeCancelOrder} isLoading={isCanceling}>
                            Sí, Cancelar Pedido
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>

            </div>
        </div>
    );
}


