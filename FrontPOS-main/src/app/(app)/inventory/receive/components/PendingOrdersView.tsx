"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Truck, Calendar, Package, Plus, Receipt, Pencil } from "lucide-react";
import { formatCOP } from "@/lib/utils";
import Cookies from "js-cookie";
import { useApi } from "@/hooks/use-api";
import { format, differenceInDays } from "date-fns";
import { es } from "date-fns/locale";

interface UnifiedOrderItem {
    id?: number;
    barcode: string;
    productName: string;
    quantity?: number;
    expectedQuantity?: number;
    qty?: number;
    unitCost?: number;
    estimatedPrice?: number;
}

interface UnifiedOrder {
    id: number;
    source: string;
    supplierId: number;
    supplierName: string;
    expectedDate: string;
    invoiceRef?: string;
    estimatedCost: number;
    itemCount: number;
    orderItems: UnifiedOrderItem[];
}

interface PendingOrdersViewProps {
    onLoadOrder: (supplierId: number, items: any[]) => void;
    onGoToFreeMode: () => void;
}

export default function PendingOrdersView({ onLoadOrder, onGoToFreeMode }: PendingOrdersViewProps) {
    const router = useRouter();
    const { data: orders, isLoading, mutate } = useApi<UnifiedOrder[]>("/inventory/orders");

    // Agrupar ordenes por Proveedor
    const groupedOrders = useMemo(() => {
        if (!orders) return [];

        const groups: Record<string, {
            id: string;
            supplierId: number;
            supplierName: string;
            date: string;
            totalItems: number;
            totalEstimated: number;
            urgency: 'high' | 'medium' | 'low';
            invoices: string[];
            mergedItems: any[];
            originalOrders: UnifiedOrder[];
        }> = {};

        orders.forEach(order => {
            const dateStr = order.expectedDate ? order.expectedDate.split('T')[0] : 'Sin Fecha';
            const key = `${order.supplierId}_${dateStr}`;
            
            if (!groups[key]) {
                groups[key] = {
                    id: key,
                    supplierId: order.supplierId,
                    supplierName: order.supplierName || "Proveedor Desconocido",
                    date: dateStr,
                    totalItems: 0,
                    totalEstimated: 0,
                    urgency: 'low',
                    invoices: [],
                    mergedItems: [],
                    originalOrders: [],
                };
            }
            
            groups[key].originalOrders.push(order);
            groups[key].totalEstimated += order.estimatedCost || 0;
            if (order.invoiceRef && !groups[key].invoices.includes(order.invoiceRef)) {
                groups[key].invoices.push(order.invoiceRef);
            }
            
            // Merge items
            order.orderItems?.forEach(item => {
                const qty = item.quantity || item.expectedQuantity || item.qty || 0;
                groups[key].totalItems += qty;
                
                const searchBarcode = item.barcode || (item as any).product_id || (item as any).productId;
                const searchName = item.productName || (item as any).product_name || (item as any).name || "Desconocido";

                const existing = groups[key].mergedItems.find(i => i.barcode === searchBarcode);
                if (existing) {
                    existing.quantity += qty;
                } else {
                    groups[key].mergedItems.push({
                        barcode: searchBarcode,
                        productName: searchName,
                        quantity: qty,
                        unit_cost: item.unitCost || item.estimatedPrice || (item as any).unit_cost || 0
                    });
                }
            });
        });

        return Object.values(groups).sort((a, b) => {
            const urgencyWeight = { high: 3, medium: 2, low: 1 };
            if (urgencyWeight[a.urgency] !== urgencyWeight[b.urgency]) {
                return urgencyWeight[b.urgency] - urgencyWeight[a.urgency];
            }
            return new Date(a.date).getTime() - new Date(b.date).getTime();
        });
    }, [orders]);

    const handleMarkAsArrived = async (groupOrders: UnifiedOrder[]) => {
        try {
            const token = Cookies.get('org-pos-token');
            const apiUrl = process.env.NEXT_PUBLIC_API_URL || '/api';
            
            await Promise.all(groupOrders.map(order => 
                fetch(`${apiUrl}/inventory/orders/dismiss`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ id: order.id, type: order.source })
                })
            ));

            mutate((currentData: UnifiedOrder[] | undefined) => {
                if (!currentData) return [];
                const completedIds = groupOrders.map(o => o.id);
                return currentData.filter(o => !completedIds.includes(o.id));
            }, { revalidate: false });
        } catch (error) {
            console.error('Error marking order as arrived:', error);
        }
    };

    if (isLoading) {
        return (
            <div className="flex h-64 items-center justify-center">
                <Loader2 className="h-10 w-10 animate-spin text-indigo-500" />
            </div>
        );
    }

    return (
        <div className="space-y-6 max-w-7xl mx-auto py-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">Pedidos Pendientes</h2>
                    <p className="text-muted-foreground">Selecciona un pedido consolidado para iniciar la recepcion.</p>
                </div>
                <Button className="bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 shadow-md gap-2" onClick={onGoToFreeMode}>
                    <Plus className="h-4 w-4" />
                    Recepcion Libre (Sin Pedido)
                </Button>
            </div>

            {groupedOrders.length === 0 ? (
                <div className="text-center py-16 border-2 border-dashed border-gray-200 dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-950">
                    <Package className="h-12 w-12 mx-auto mb-4 text-gray-300 dark:text-zinc-700" />
                    <h3 className="text-lg font-medium">No hay pedidos pendientes</h3>
                    <p className="text-muted-foreground mt-1 mb-6">Todos los pedidos han sido recibidos o no se ha generado ninguno en Smart Restock.</p>
                    <Button variant="outline" onClick={onGoToFreeMode}>Continuar con Recepcion Libre</Button>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {groupedOrders.map((group) => {
                        // Calcular proximidad
                        let urgencyColor = "text-indigo-600 dark:text-indigo-400";
                        let bgUrgency = "bg-indigo-50 dark:bg-indigo-950/30";
                        let dateText = "Fechas mixtas";

                        if (group.date && group.date !== 'Sin Fecha') {
                            const expectedDateStr = group.date;
                            const getBogotaDateStr = (date: Date) => new Intl.DateTimeFormat('en-CA', { 
                                timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' 
                            }).format(date);
                            
                            const now = new Date();
                            const todayStr = getBogotaDateStr(now);
                            
                            const tomorrow = new Date(now);
                            tomorrow.setDate(tomorrow.getDate() + 1);
                            const tomorrowStr = getBogotaDateStr(tomorrow);

                            if (expectedDateStr < todayStr) {
                                urgencyColor = "text-red-600";
                                bgUrgency = "bg-red-50 dark:bg-red-950/30 border-red-200";
                                dateText = "¡Retrasado!";
                            } else if (expectedDateStr === todayStr) {
                                urgencyColor = "text-amber-600";
                                bgUrgency = "bg-amber-50 dark:bg-amber-950/30 border-amber-200";
                                dateText = "Llega Hoy";
                            } else if (expectedDateStr === tomorrowStr) {
                                dateText = "Llega Mañana";
                            } else {
                                // Evitar shifts UTC instanciando con mediodia
                                const [y, m, d] = expectedDateStr.split('-').map(Number);
                                const dateObj = new Date(y, m - 1, d, 12, 0, 0);
                                const dayName = dateObj.toLocaleDateString('es-CO', { weekday: 'long' });
                                const capitalizedDay = dayName.charAt(0).toUpperCase() + dayName.slice(1);
                                dateText = `Llega el ${capitalizedDay}`;
                            }
                        }

                        return (
                            <Card key={group.id} className="hover:shadow-md transition-all duration-200 border-gray-200 dark:border-zinc-800 overflow-hidden flex flex-col">
                                <CardHeader className={`${bgUrgency} border-b py-4`}>
                                    <div className="flex justify-between items-start">
                                        <div className="flex items-center gap-3">
                                            <div className={`p-2 rounded-lg bg-white/50 dark:bg-black/20 ${urgencyColor}`}>
                                                <Truck size={24} />
                                            </div>
                                            <div>
                                                <CardTitle className="text-lg">{group.supplierName}</CardTitle>
                                                <div className={`text-xs font-medium mt-1 flex items-center gap-1 ${urgencyColor}`}>
                                                    <Calendar size={12} />
                                                    {dateText}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </CardHeader>
                                <CardContent className="pt-4 flex-1 flex flex-col justify-between space-y-4">
                                    <div className="space-y-3">
                                        <div className="flex justify-between items-center text-sm">
                                            <span className="text-muted-foreground flex items-center gap-1">
                                                <Package size={14} /> Total Unidades:
                                            </span>
                                            <span className="font-semibold">{group.totalItems}</span>
                                        </div>
                                        {(() => {
                                            // Detectar si el invoice es un numero (precio real) o una referencia textual
                                            const invoiceStr = group.invoices.length > 0 ? group.invoices.join(", ") : "";
                                            const invoiceAsNumber = invoiceStr ? parseFloat(invoiceStr.replace(/[^0-9.]/g, '')) : NaN;
                                            const isRealPrice = !isNaN(invoiceAsNumber) && invoiceAsNumber > 0;

                                            return isRealPrice ? (
                                                <>
                                                    {/* Precio Real de Factura → PROMINENTE */}
                                                    <div className="pt-3 border-t flex justify-between items-center">
                                                        <span className="font-medium text-sm">Precio Real Factura</span>
                                                        <span className="font-bold text-lg text-emerald-600 dark:text-emerald-400">
                                                            ${formatCOP(invoiceAsNumber)}
                                                        </span>
                                                    </div>
                                                    {/* Costo Estimado → secundario, mas pequeno */}
                                                    <div className="flex justify-between items-center text-xs text-muted-foreground">
                                                        <span className="flex items-center gap-1"><Receipt size={12} /> Estimado:</span>
                                                        <span className="font-medium">${formatCOP(group.totalEstimated)}</span>
                                                    </div>
                                                </>
                                            ) : (
                                                <>
                                                    {/* Referencia textual */}
                                                    {invoiceStr && (
                                                        <div className="flex justify-between items-center text-sm">
                                                            <span className="text-muted-foreground flex items-center gap-1">
                                                                <Receipt size={14} /> Ref Factura:
                                                            </span>
                                                            <span className="font-medium truncate max-w-[120px] text-right" title={invoiceStr}>
                                                                {invoiceStr}
                                                            </span>
                                                        </div>
                                                    )}
                                                    {/* Costo Estimado → prominente cuando no hay precio real */}
                                                    <div className="pt-3 border-t flex justify-between items-center">
                                                        <span className="font-medium text-sm">Costo Estimado</span>
                                                        <span className="font-bold text-lg text-emerald-600 dark:text-emerald-400">
                                                            ${formatCOP(group.totalEstimated)}
                                                        </span>
                                                    </div>
                                                </>
                                            );
                                        })()}
                                    </div>
                                    <div className="flex gap-2 w-full mt-2 flex-wrap">
                                        <Button 
                                            className="flex-1" 
                                            onClick={() => onLoadOrder(group.supplierId, group.mergedItems)}
                                        >
                                            Iniciar Recepcion
                                        </Button>
                                        <Button 
                                            variant="outline"
                                            size="sm"
                                            className="text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 px-3"
                                            title="Editar este pedido en Pedidos Inteligentes"
                                            onClick={() => router.push(`/inventory/orders?edit_order=${group.originalOrders[0].id}`)}
                                        >
                                            <Pencil size={14} />
                                        </Button>
                                        <Button 
                                            variant="outline" 
                                            className="text-zinc-600 dark:text-zinc-400 whitespace-nowrap"
                                            onClick={() => handleMarkAsArrived(group.originalOrders)}
                                        >
                                            ✅ Ya Llego
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
