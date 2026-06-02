"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  ShoppingBag, Truck, Building2, FileText, Calendar, DollarSign, PackageSearch, Check, ChevronDown, CheckCircle, AlertTriangle, Edit2, X, Package, Trash2
} from 'lucide-react';
import {
  Card, CardBody, Button, Input, Autocomplete, AutocompleteItem, Pagination, Skeleton, Badge, Popover, PopoverTrigger, PopoverContent
} from "@heroui/react";
import { useAuth } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import Cookies from 'js-cookie';
import { Supplier } from '@/lib/definitions';
import { formatCurrency } from "@/lib/utils";
import { API_URL } from '@/lib/constants';

interface SuggestedOrder {
  barcode: string;
  productName: string;
  stock: number;
  minStock: number;
  avgDailySales: number;
  suggested: number;
  purchasePrice: number;
  bestSupplierId: number;
  bestSupplierName: string;
  daysUntilNextVisit?: number;
  minShelfStock?: number;
  pendingOrderQty?: number;     // Cantidad ya en tansito (pedidos confirmados pendientes)
  transitDetail?: string;       // Nombre del proveedor del pedido en transito
  alert?: string;
  alertType?: string;
  isHighRotation?: boolean;
  lowestPrice?: number;
}

interface MissingItem {
  id: number;
  product_name: string;
  status: string;
}

const getNextDays = (count: number) => {
  const days = [];
  const today = new Date();
  const dayNames = ["Dom", "Lun", "Mar", "Mie", "Jue", "Vie", "Sab"];
  
  for (let i = 0; i < count; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    
    // Obtener la fecha en GMT-5 (Colombia) garantizando el YYYY-MM-DD correcto
    const dateStr = new Intl.DateTimeFormat('fr-CA', { 
      timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' 
    }).format(d);
    
    let label = dayNames[d.getDay()];
    if (i === 0) label = "Hoy";
    else if (i === 1) label = "Mañana";
    
    days.push({ date: dateStr, label, dayNumber: d.getDate() });
  }
  return days;
};

export default function SmartRestockPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const apiUrl = API_URL;
  const searchParams = useSearchParams();
  const router = useRouter();

  const [editOrderId, setEditOrderId] = useState<string | null>(null);
  const [editingOrderData, setEditingOrderData] = useState<any | null>(null);

  const authHeaders = useCallback((isJson = true) => {
    const token = Cookies.get('org-pos-token');
    const headers: any = { 'Authorization': `Bearer ${token}` };
    if (isJson) headers['Content-Type'] = 'application/json';
    return headers;
  }, []);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [items, setItems] = useState<SuggestedOrder[]>([]);
  const [orderItems, setOrderItems] = useState<SuggestedOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSupplier, setSelectedSupplier] = useState<string>("global");
  const [supplierSearch, setSupplierSearch] = useState("");
  
  const filteredSuppliers = useMemo(() => {
    if (!supplierSearch) return suppliers;
    return suppliers.filter(s => s.name.toLowerCase().includes(supplierSearch.toLowerCase()));
  }, [suppliers, supplierSearch]);
  
  const [missingItems, setMissingItems] = useState<MissingItem[]>([]);
  const [loadingMissingItems, setLoadingMissingItems] = useState(true);

  // Form states per supplier
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [groupForms, setGroupForms] = useState<Record<string, { date: string, invoiceRef: string }>>({});
  const [submittingGroups, setSubmittingGroups] = useState<Record<string, boolean>>({});

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(1000);

  const [editingMinStock, setEditingMinStock] = useState<string | null>(null);
  const [editMinStockValue, setEditMinStockValue] = useState<string>("");
  const [savingMinStock, setSavingMinStock] = useState<string | null>(null);

  const fetchMissingItems = useCallback(async () => {
    setLoadingMissingItems(true);
    try {
      const res = await fetch(`${apiUrl}/admin/missing-items/status?status=PENDIENTE`, { headers: authHeaders() });
      if (res.ok) setMissingItems(await res.json());
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMissingItems(false);
    }
  }, [apiUrl, authHeaders]);

  const loadSuppliers = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/suppliers/all-suppliers`, { headers: authHeaders() });
      if (res.ok) setSuppliers(await res.json());
    } catch (err) {
      console.error(err);
    }
  }, [apiUrl, authHeaders]);

  const loadGlobalSuggestions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/inventory/restock/suggestions`, { headers: authHeaders(), cache: 'no-store' });
      if (res.ok) {
        const groups = await res.json();
        // Flatten the categorized data
        let allItems: SuggestedOrder[] = [];
        groups.forEach((g: any) => {
            allItems = [...allItems, ...g.items];
        });
        
        // Remove duplicates by barcode since an item might be in multiple categories
        const uniqueItems = Array.from(new Map(allItems.map(item => [item.barcode, item])).values());
        
        setItems(uniqueItems);
        
        // El input numerico de cantidad a pedir debe inicializarse vacio
        const initialQts: Record<string, number> = {};
        setQuantities(initialQts);
      } else {
        console.error("Error fetching suggestions");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, authHeaders]);

  const loadSuggestionsBySupplier = useCallback(async (supplierId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/inventory/restock/suggestions`, { headers: authHeaders(), cache: 'no-store' });
      if (res.ok) {
        const groups = await res.json();
        const group = groups.find((g: any) => g.supplierId.toString() === supplierId);
        let data: SuggestedOrder[] = group ? group.items : [];
        
        if (editingOrderData && String(editingOrderData.supplierId) === supplierId) {
          const newQuantities: Record<string, number> = {};
          const mergedData = [...data];
          
          editingOrderData.items?.forEach((orderItem: any) => {
            const barcode = orderItem.productId;
            newQuantities[barcode] = orderItem.quantity;
            
            // Si el item del pedido no esta en las sugerencias, lo agregamos
            if (!mergedData.some(item => item.barcode === barcode)) {
              mergedData.push({
                barcode: barcode,
                productName: orderItem.product?.productName || "Producto Desconocido",
                stock: orderItem.product?.quantity || 0,
                minStock: orderItem.product?.minStock || 0,
                avgDailySales: 0,
                suggested: orderItem.quantity,
                purchasePrice: orderItem.estimatedPrice || orderItem.product?.purchasePrice || 0,
                bestSupplierId: editingOrderData.supplierId,
                bestSupplierName: editingOrderData.supplier?.name || ""
              });
            }
          });
          
          setOrderItems(mergedData);
          setQuantities(prev => ({ ...prev, ...newQuantities }));

          // Pre-llenar los formularios (fecha y ref factura) para este proveedor
          const supplierName = editingOrderData.supplier?.name || "Sin Proveedor";
          setGroupForms(prev => ({
            ...prev,
            [supplierName]: {
              date: editingOrderData.expectedDate ? editingOrderData.expectedDate.split('T')[0] : '',
              invoiceRef: editingOrderData.invoiceRef || ''
            }
          }));
        } else {
          setOrderItems(data);
          const initialQts: Record<string, number> = {};
          setQuantities(initialQts);
        }
      } else {
        console.error("Error fetching supplier suggestions");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, authHeaders, editingOrderData]);

  useEffect(() => {
    const editOrderParam = searchParams?.get('edit_order');
    if (editOrderParam) {
      setEditOrderId(editOrderParam);
    }
  }, [searchParams]);

  useEffect(() => {
    if (!editOrderId) return;
    const fetchOrder = async () => {
      try {
        const res = await fetch(`${apiUrl}/inventory/receive/pending/${editOrderId}`, { headers: authHeaders() });
        if (res.ok) {
          const order = await res.json();
          setEditingOrderData(order);
          setSelectedSupplier(String(order.supplierId));
        } else {
          toast({ title: "Error", description: "No se pudo cargar el pedido a editar", variant: "destructive" });
        }
      } catch (err) {
        console.error(err);
      }
    };
    fetchOrder();
  }, [editOrderId, apiUrl, authHeaders, toast]);

  useEffect(() => {
    loadSuppliers();
    fetchMissingItems();
  }, [loadSuppliers, fetchMissingItems]);

  // Pre-seleccionar proveedor si viene en la URL (?supplier=<id>)
  useEffect(() => {
    const supplierParam = searchParams?.get('supplier');
    if (supplierParam && supplierParam !== selectedSupplier) {
      setSelectedSupplier(supplierParam);
    }
  }, [searchParams]);

  useEffect(() => {
    if (selectedSupplier === "global") {
      loadGlobalSuggestions();
    } else {
      loadSuggestionsBySupplier(selectedSupplier);
    }
  }, [selectedSupplier, loadGlobalSuggestions, loadSuggestionsBySupplier]);

  const handleResolveMissingItem = async (id: number) => {
    try {
      const res = await fetch(`${apiUrl}/admin/missing-items/status`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ id, status: 'RESUELTO' })
      });
      if (res.ok) {
        setMissingItems(prev => prev.filter(item => item.id !== id));
        toast({ title: "Exito", description: "Faltante resuelto" });
      }
    } catch (err) { }
  };

  const handleQtyChange = (barcode: string, val: string | number) => {
    let num = typeof val === 'string' ? parseInt(val) : val;
    if (isNaN(num)) num = 0;
    setQuantities(prev => ({ ...prev, [barcode]: Math.max(0, num) }));
  };

  const handleUnlinkSupplier = async (barcode: string, supplierId: string) => {
    if (!window.confirm("¿Seguro que deseas desligar este producto de este proveedor? No volvera a aparecer en sus sugerencias.")) {
      return;
    }
    try {
      const res = await fetch(`${apiUrl}/inventory/products/${barcode}/unlink-supplier`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ supplierId: parseInt(supplierId) })
      });
      if (res.ok) {
        toast({ title: "Exito", description: "Producto desvinculado del proveedor" });
        // Update both local states to remove the item
        setItems(prev => prev.filter(item => item.barcode !== barcode));
        setOrderItems(prev => prev.filter(item => item.barcode !== barcode));
      } else {
        toast({ title: "Error", description: "No se pudo desvincular", variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Error", description: "Fallo de red", variant: "destructive" });
    }
  };

  const handleUpdateMinStock = async (barcode: string) => {
    if (!editMinStockValue) return;
    setSavingMinStock(barcode);
    try {
      const res = await fetch(`${apiUrl}/admin/products/update-min-stock/${barcode}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ minStock: parseFloat(editMinStockValue) })
      });
      if (res.ok) {
        toast({ title: "Exito", description: "Stock base actualizado" });
        const val = parseFloat(editMinStockValue);
        setItems(prev => prev.map(item => item.barcode === barcode ? { ...item, minStock: val } : item));
        setOrderItems(prev => prev.map(item => item.barcode === barcode ? { ...item, minStock: val } : item));
        setEditingMinStock(null);
        if (selectedSupplier === "global") loadGlobalSuggestions();
        else loadSuggestionsBySupplier(selectedSupplier);
      } else {
        toast({ title: "Error", description: "No se pudo actualizar", variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Error", description: "Fallo de red", variant: "destructive" });
    } finally {
      setSavingMinStock(null);
    }
  };

  const currentItems = useMemo(() => {
    const arr = selectedSupplier === "global" ? items : orderItems;
    return [...arr].sort((a, b) => {
      // 1. Determinar el estado de 'a' (1: Critico, 2: Advertencia, 3: Optimo)
      let statusA = 3;
      if (a.stock <= 0) statusA = 1;
      else if (a.stock <= (a.minStock || 0)) statusA = 2;

      // 2. Determinar el estado de 'b'
      let statusB = 3;
      if (b.stock <= 0) statusB = 1;
      else if (b.stock <= (b.minStock || 0)) statusB = 2;

      // 3. Ordenar por estado
      if (statusA !== statusB) return statusA - statusB;

      // 4. Si tienen el mismo estado, ordenar por rotacion / ventas
      if (a.isHighRotation && !b.isHighRotation) return -1;
      if (!a.isHighRotation && b.isHighRotation) return 1;
      if (b.suggested !== a.suggested) return (b.suggested || 0) - (a.suggested || 0);
      return (b.avgDailySales || 0) - (a.avgDailySales || 0);
    });
  }, [selectedSupplier, items, orderItems]);

  const totalItemsCount = currentItems.length;
  const paginatedItems = currentItems.slice(0, pageSize);

  // Agrupar sugerencias
  const groupedBySupplier = useMemo(() => {
    const groups: Record<string, { supplierId: number; supplierName: string; items: SuggestedOrder[] }> = {};
    
    // Para el radar global, agrupamos por nombre de proveedor
    paginatedItems.forEach(item => {
      const sName = item.bestSupplierName || "Sin Proveedor";
      if (!groups[sName]) {
        groups[sName] = {
          supplierId: item.bestSupplierId || 0,
          supplierName: sName,
          items: []
        };
      }
      groups[sName].items.push(item);
    });

    if (selectedSupplier !== "global" && Object.keys(groups).length === 0) {
       const supplier = suppliers.find(s => s.id.toString() === selectedSupplier);
       if (supplier) {
         groups[supplier.name] = {
           supplierId: Number(supplier.id),
           supplierName: supplier.name,
           items: []
         };
       }
    }

    // Ordenamiento de prioridades antes de retornar
    Object.values(groups).forEach(group => {
      group.items.sort((a, b) => {
        const aRisk = (a.stock <= 0 && a.avgDailySales >= 0.3) ? 1 : 0;
        const bRisk = (b.stock <= 0 && b.avgDailySales >= 0.3) ? 1 : 0;
        if (aRisk !== bRisk) return bRisk - aRisk;

        const aCrit = a.stock <= a.minStock ? 1 : 0;
        const bCrit = b.stock <= b.minStock ? 1 : 0;
        if (aCrit !== bCrit) return bCrit - aCrit;

        const aWarn = a.stock <= (a.minStock * 1.5) ? 1 : 0;
        const bWarn = b.stock <= (b.minStock * 1.5) ? 1 : 0;
        if (aWarn !== bWarn) return bWarn - aWarn;

        return 0;
      });
    });

    return Object.values(groups).sort((a, b) => b.items.length - a.items.length);
  }, [paginatedItems]);

  // Manejar el submit de un grupo especifico
  const handleConfirmGroup = async (groupName: string, supplierId: number, groupItems: SuggestedOrder[]) => {
    const form = groupForms[groupName] || { date: '', invoiceRef: '' };
    
    if (!form.date) {
      toast({ title: "Atencion", description: "Debes seleccionar una Fecha de Entrega.", variant: "destructive" });
      return;
    }

    const itemsToOrder = groupItems.map(item => {
      const qty = quantities[item.barcode] !== undefined ? quantities[item.barcode] : (item.suggested || 0);
      return {
        product_id: item.barcode, 
        barcode: item.barcode, 
        quantity: qty,
        unit_cost: item.purchasePrice || 0
      };
    }).filter(i => i.quantity > 0);

    // Se permite enviar orden con 0 items para logistica de entregas programadas

    const groupTotal = itemsToOrder.reduce((acc, item) => acc + (item.quantity * item.unit_cost), 0);

    setSubmittingGroups(prev => ({ ...prev, [groupName]: true }));
    try {
      const res = await fetch(`${apiUrl}/inventory/restock/confirm`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          supplier_id: supplierId,
          expected_date: form.date,
          invoice_ref: form.invoiceRef,
          items: itemsToOrder,
          estimated_total: groupTotal,
          real_invoice_total: groupTotal, // Por defecto asumimos que es igual al estimado inicial
          confirmed_by: user?.name || "ADMIN",
          edit_order_id: editOrderId || ""
        })
      });

      if (res.ok) {
        toast({ title: "Exito", description: `Pedido de ${groupName} confirmado.` });
        
        // Clear quantities of confirmed items from state
        setQuantities(prev => {
          const next = { ...prev };
          groupItems.forEach(item => {
            delete next[item.barcode];
          });
          return next;
        });

        // Limpiar estados de edicion
        setEditOrderId(null);
        setEditingOrderData(null);

        // Redirigir a la consola principal de inventario
        router.push('/inventory');
      } else {
        const errorData = await res.json();
        toast({ title: "Error", description: errorData.error || "Error al confirmar", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSubmittingGroups(prev => ({ ...prev, [groupName]: false }));
    }
  };

  return (
    <div className="flex flex-col bg-[#f8f9fa] dark:bg-[#09090b] relative">
      <div className="flex flex-col p-3 md:p-6 pb-24 md:pb-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 shrink-0">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-zinc-900 dark:text-white uppercase tracking-tight flex items-center gap-2">
              <ShoppingBag className="text-amber-500" size={24} />
              Pedidos Inteligentes
            </h1>
            <p className="text-xs text-zinc-500 uppercase tracking-widest mt-1">Radar Global y Generacion de Ordenes</p>
          </div>

          <div className="flex items-center gap-2 bg-white dark:bg-zinc-950 p-1.5 rounded-2xl border border-gray-200 dark:border-white/10 shadow-[0_4px_20px_rgb(0,0,0,0.05)] w-full md:w-auto">
            <button
              onClick={() => setSelectedSupplier("global")}
              className={`px-4 py-2 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all h-10 ${selectedSupplier === "global" ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100' : 'text-zinc-500 hover:bg-gray-100 dark:hover:bg-zinc-900'}`}
            >
              RADAR GLOBAL
            </button>
            <div className="w-[1px] h-6 bg-gray-200 dark:bg-zinc-800 mx-1" />
            <div className="w-[200px]">
              <Autocomplete
                size="sm"
                placeholder="PROVEEDOR..."
                selectedKey={selectedSupplier === "global" ? null : selectedSupplier}
                onSelectionChange={(key) => setSelectedSupplier((key as string) || "global")}
                onInputChange={setSupplierSearch}
                items={filteredSuppliers}
                aria-label="Filtrar por proveedor"
                inputProps={{ classNames: { inputWrapper: "bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 border-none shadow-none h-10 rounded-xl transition-colors", input: "text-[11px] font-bold uppercase" } }}
                popoverProps={{ classNames: { content: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10" } }}
              >
                {(s) => (
                  <AutocompleteItem key={String(s.id)} textValue={s.name}>
                    <div className="flex items-center gap-2 py-0.5">
                      <Truck size={14} />
                      <span className="text-[11px] font-bold uppercase">{s.name}</span>
                    </div>
                  </AutocompleteItem>
                )}
              </Autocomplete>
            </div>
          </div>
        </div>

        {/* MODO EDICION BANNER */}
        {editOrderId && (
          <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex items-center justify-between shrink-0 shadow-sm">
            <div className="flex items-center gap-2">
              <AlertTriangle className="text-amber-500" size={16} />
              <span className="text-xs font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">
                Modo Edicion Activo: Editando pedido del proveedor {editingOrderData?.supplier?.name || '...'}.
              </span>
            </div>
            <Button 
              size="sm" 
              variant="flat" 
              color="danger" 
              className="rounded-xl text-[10px] font-bold uppercase tracking-wider"
              onPress={() => {
                setEditOrderId(null);
                setEditingOrderData(null);
                setSelectedSupplier("global");
                router.push('/inventory');
              }}
            >
              Cancelar Edicion
            </Button>
          </div>
        )}

        {/* TOP AREA: Faltantes en Caja (Horizontal) */}
        <div className="mb-4 shrink-0">
          <Card className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
            <CardBody className="p-3 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <PackageSearch size={16} className="text-rose-500" />
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Faltantes en Caja</h3>
              </div>
              <div className="flex flex-row gap-2 overflow-x-auto custom-scrollbar pb-1">
                {loadingMissingItems ? <Skeleton className="h-10 w-64 rounded-2xl shrink-0" /> : missingItems.length > 0 ? (
                  missingItems.map(m => (
                    <div key={m.id} className="flex shrink-0 items-center justify-between p-2 bg-rose-500/[0.03] rounded-2xl border border-rose-500/10 min-w-[200px] max-w-[250px]">
                      <div className="flex items-center gap-2 min-w-0">
                        <Button isIconOnly size="sm" variant="flat" onPress={() => handleResolveMissingItem(m.id)} className="h-8 w-8 rounded-2xl shrink-0"><Check size={14} /></Button>
                        <span className="font-bold uppercase truncate text-[10px] leading-tight">{m.product_name}</span>
                      </div>
                    </div>
                  ))
                ) : <div className="p-2 text-[9px] font-bold text-zinc-500 uppercase">Sin pendientes</div>}
              </div>
            </CardBody>
          </Card>
        </div>

        {/* CENTRAL AREA: Grouped Suggestions */}
        <div className="flex flex-col">
            <Card className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden flex flex-col">
              <CardBody className="p-0 flex flex-col overflow-hidden">
                <div className="overflow-y-auto custom-scrollbar p-3 md:p-6 flex flex-col gap-8">
                  
                  {loading ? (
                    <div className="flex justify-center p-10"><Skeleton className="h-8 w-32 rounded-lg" /></div>
                  ) : groupedBySupplier.length === 0 ? (
                    <div className="flex flex-col justify-center items-center h-full opacity-50 p-10">
                      <CheckCircle size={48} className="text-emerald-500 mb-4" />
                      <p className="text-sm font-bold uppercase tracking-widest">Stock Optimo</p>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {groupedBySupplier.map((group) => {
                        const groupTotal = group.items.reduce((acc, item) => acc + (quantities[item.barcode] || 0) * (item.purchasePrice || 0), 0);
                        const form = groupForms[group.supplierName] || { date: '', invoiceRef: '' };
                        const isSubmitting = submittingGroups[group.supplierName] || false;
                        
                        return (
                          <div key={group.supplierName} className="border border-gray-200 dark:border-white/10 rounded-2xl overflow-hidden shadow-sm">
                            <div className="bg-gray-100 dark:bg-zinc-900 p-4 border-b border-gray-200 dark:border-white/10 flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <Building2 className="text-amber-500" size={20} />
                                <h3 className="font-bold text-sm uppercase tracking-tight">{group.supplierName}</h3>
                                <Badge color="default" className="text-[10px] uppercase">{group.items.length} items</Badge>
                              </div>
                            </div>
                            
                            <div className="divide-y divide-gray-100 dark:divide-white/5">
                              {group.items.length === 0 ? (
                                <div className="flex flex-col justify-center items-center opacity-70 p-10">
                                  <CheckCircle size={40} className="text-emerald-500 mb-3" />
                                  <p className="text-sm font-bold uppercase tracking-widest text-emerald-600">Stock Optimo</p>
                                  <p className="text-[10px] text-zinc-500 mt-2 text-center max-w-xs">Puedes programar una entrega manualmente asignando la fecha abajo.</p>
                                </div>
                              ) : (
                                group.items.map((item) => {
                                  const isCritical = item.stock <= 0;
                                  const inTransit = (item.pendingOrderQty || 0) > 0;
                                  const effectiveStock = item.stock + (item.pendingOrderQty || 0);
                                  const coveredByTransit = inTransit && effectiveStock >= item.minStock;
                                  return (
                                    <div key={item.barcode} className={`p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 transition-colors hover:bg-gray-50/50 dark:hover:bg-zinc-900/50 ${isCritical && !inTransit ? 'bg-red-50/20 dark:bg-red-950/10' : ''} ${coveredByTransit ? 'bg-amber-50/20 dark:bg-amber-950/10' : ''}`}>
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1">
                                          <p className="font-medium truncate text-sm">{item.productName}</p>
                                          {isCritical && !inTransit && <Badge color="danger" className="h-5 text-[10px] px-1.5 shrink-0">Critico</Badge>}
                                          {coveredByTransit && (
                                            <span className="inline-flex items-center gap-1 bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-500/30 text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0">
                                              <Truck size={9} />
                                              {item.pendingOrderQty} EN CAMINO
                                            </span>
                                          )}
                                          {inTransit && !coveredByTransit && (
                                            <span className="inline-flex items-center gap-1 bg-sky-100 dark:bg-sky-500/20 text-sky-700 dark:text-sky-400 border border-sky-300 dark:border-sky-500/30 text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0">
                                              <Package size={9} />
                                              {item.pendingOrderQty} EN TRANSITO
                                            </span>
                                          )}
                                          {item.alert && !coveredByTransit && (
                                            <Badge color={item.alertType === "SLOW_MOVER" ? "warning" : "success"} className="h-5 text-[10px] px-1.5 shrink-0 whitespace-nowrap">
                                              {item.alert}
                                            </Badge>
                                          )}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500 uppercase font-medium">
                                          <span>REF: {item.barcode}</span>
                                          <span>Stock: <strong className={item.stock <= 0 ? "text-red-500" : "text-zinc-900 dark:text-zinc-100"}>{item.stock}</strong></span>
                                          {inTransit && <span className="text-amber-600 dark:text-amber-400 font-bold">Efectivo: {effectiveStock} (con transito)</span>}
                                          {editingMinStock === item.barcode ? (
                                            <div className="flex items-center gap-1 bg-white dark:bg-zinc-950 px-2 py-0.5 rounded-md border border-amber-500/50">
                                              <span className="text-[10px]">Stock Base:</span>
                                              <input 
                                                autoFocus
                                                type="number"
                                                className="w-12 text-center bg-transparent border-b border-amber-500 outline-none text-zinc-900 dark:text-white font-bold"
                                                value={editMinStockValue}
                                                onChange={(e) => setEditMinStockValue(e.target.value)}
                                                onKeyDown={(e) => {
                                                  if (e.key === 'Enter') handleUpdateMinStock(item.barcode);
                                                  if (e.key === 'Escape') setEditingMinStock(null);
                                                }}
                                              />
                                              <button onClick={() => handleUpdateMinStock(item.barcode)} disabled={savingMinStock === item.barcode} className="text-emerald-500 hover:text-emerald-600 ml-1">
                                                <CheckCircle size={14} />
                                              </button>
                                              <button onClick={() => setEditingMinStock(null)} className="text-zinc-400 hover:text-zinc-600">
                                                <X size={14} />
                                              </button>
                                            </div>
                                          ) : (
                                            <div className="flex items-center gap-1 group cursor-pointer" onClick={() => { setEditingMinStock(item.barcode); setEditMinStockValue(String(item.minStock || 0)); }}>
                                              <span>Stock Base: <strong className="text-amber-600 dark:text-amber-400">{item.minStock}</strong></span>
                                              <Edit2 size={10} className="text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                                            </div>
                                          )}
                                          {item.minShelfStock !== undefined && <span>Min. Estante: {item.minShelfStock}</span>}
                                          <span>Venta prom.: {Number(item.avgDailySales || 0).toFixed(1)}/dia</span>
                                        </div>
                                        
                                        {selectedSupplier !== "global" && item.bestSupplierId && item.bestSupplierId.toString() !== selectedSupplier && (
                                          <div className="mt-2 flex items-center gap-2 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 p-2 rounded-lg w-fit">
                                            <AlertTriangle size={14} className="text-amber-500 shrink-0" />
                                            <p className="text-[10px] md:text-[11px] font-bold text-amber-700 dark:text-amber-400 m-0 leading-tight">
                                              💡 RECOMENDACION: No pidas con este proveedor. Con <span className="uppercase">{item.bestSupplierName}</span> sale mas economico ({formatCurrency(item.lowestPrice || 0)}).
                                            </p>
                                          </div>
                                        )}
                                      </div>
                                      
                                      {/* CONTROLES: Si ya esta cubierto por transito, mostrar badge. Si no, mostrar +/- */}
                                      <div className="flex items-center gap-2">
                                        {coveredByTransit ? (
                                          <div className="flex items-center gap-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-500/20 px-4 py-2 rounded-xl">
                                            <Truck size={14} className="text-amber-500" />
                                            <span className="text-[10px] font-black text-amber-700 dark:text-amber-400 uppercase tracking-wider">Stock cubierto</span>
                                          </div>
                                        ) : (
                                          <div className="flex items-center gap-3 bg-gray-50 dark:bg-zinc-900/50 p-2 rounded-xl">
                                            <div className="text-right flex flex-col justify-center">
                                              <div className="flex flex-col items-end gap-1">
                                                  <span className="text-[10px] text-zinc-400 font-bold ml-1">Sugerido: {item.suggested || 0}</span>
                                                  <div className="flex items-center gap-1 bg-gray-100 dark:bg-zinc-900 rounded-lg p-1 border border-gray-200 dark:border-white/5 shadow-inner">
                                                  <button 
                                                      onClick={() => handleQtyChange(item.barcode, (quantities[item.barcode] || 0) - 1)}
                                                      className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-md transition-all font-bold"
                                                  >
                                                      -
                                                  </button>
                                                  <input 
                                                      type="number" 
                                                      min={0}
                                                      placeholder={String(item.suggested || 0)}
                                                      value={quantities[item.barcode] === undefined ? "" : quantities[item.barcode]}
                                                      onChange={(e) => handleQtyChange(item.barcode, e.target.value)}
                                                      className="w-10 text-center text-xs font-bold bg-transparent outline-none"
                                                      style={{ appearance: 'textfield', WebkitAppearance: 'none' }}
                                                  />
                                                  <button 
                                                      onClick={() => handleQtyChange(item.barcode, (quantities[item.barcode] || 0) + 1)}
                                                      className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-md transition-all font-bold"
                                                  >
                                                      +
                                                  </button>
                                                  </div>
                                              </div>
                                            </div>
                                          </div>
                                        )}
                                        
                                        <button
                                          onClick={() => handleUnlinkSupplier(item.barcode, selectedSupplier === "global" ? String(item.bestSupplierId) : selectedSupplier)}
                                          title="Desvincular de este proveedor"
                                          className="p-2 ml-1 rounded-xl text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors border border-transparent hover:border-red-200 dark:hover:border-red-500/20"
                                        >
                                          <Trash2 size={16} />
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })
                              )}
                            </div>
                            
                            {/* BLOCK FOOTER (Date, Invoice, Confirm) */}
                            <div className="bg-amber-500/5 dark:bg-amber-500/10 p-4 border-t border-amber-500/20 flex flex-col md:flex-row items-end md:items-center justify-between gap-4">
                              <div className="flex flex-col md:flex-row items-center gap-3 w-full md:w-auto">
                                <div className="flex flex-col gap-1 w-full md:w-auto">
                                  <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest pl-1">Fecha Entrega</label>
                                  <Popover placement="top">
                                    <PopoverTrigger>
                                      <button className="h-10 w-full md:w-40 bg-white dark:bg-zinc-900 rounded-xl flex items-center px-3 gap-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors border border-gray-200 dark:border-white/5 shadow-sm text-left">
                                        <Calendar size={14} className="text-zinc-500 shrink-0" />
                                        <div className="flex flex-col overflow-hidden">
                                          <span className="text-[11px] font-bold text-zinc-900 dark:text-zinc-100 truncate uppercase">
                                            {form.date === new Date().toISOString().split('T')[0] ? "HOY" : form.date}
                                          </span>
                                        </div>
                                      </button>
                                    </PopoverTrigger>
                                    <PopoverContent className="p-3 w-72 bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-2xl">
                                      <div className="flex flex-col gap-3 w-full">
                                        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest text-center mt-1">Dias de Llegada</p>
                                        <div className="grid grid-cols-3 gap-2">
                                          {getNextDays(6).map(d => (
                                            <button
                                              key={d.date}
                                              onClick={() => setGroupForms(prev => ({ ...prev, [group.supplierName]: { ...form, date: d.date } }))}
                                              className={`flex flex-col items-center justify-center p-2 rounded-xl transition-all border ${form.date === d.date ? 'bg-amber-500 border-amber-500 text-white shadow-md shadow-amber-500/20 scale-105' : 'bg-gray-50 dark:bg-zinc-900 border-gray-200 dark:border-white/5 text-zinc-600 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800'}`}
                                            >
                                              <span className={`text-[14px] font-black leading-none mb-1 ${form.date === d.date ? 'text-white' : 'text-zinc-900 dark:text-zinc-100'}`}>{d.dayNumber}</span>
                                              <span className="text-[9px] uppercase tracking-widest font-medium">{d.label}</span>
                                            </button>
                                          ))}
                                        </div>
                                        <div className="w-full h-[1px] bg-gray-100 dark:bg-zinc-800 my-2" />
                                        <div className="flex flex-col gap-1 w-full relative">
                                          <label className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest px-1">Otra Fecha</label>
                                          <Input 
                                            type="date" 
                                            size="sm" 
                                            value={form.date}
                                            onChange={(e) => setGroupForms(prev => ({ ...prev, [group.supplierName]: { ...form, date: e.target.value } }))}
                                            classNames={{ inputWrapper: "h-10 bg-zinc-100 dark:bg-zinc-900 border-none shadow-inner rounded-xl" }}
                                          />
                                        </div>
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                </div>
                                <div className="flex flex-col gap-1 w-full md:w-auto">
                                  <label className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest pl-1">Ref / Factura Real</label>
                                  <Input
                                    type="text"
                                    size="sm"
                                    placeholder="Opcional..."
                                    value={form.invoiceRef}
                                    onChange={(e) => setGroupForms(prev => ({ ...prev, [group.supplierName]: { ...form, invoiceRef: e.target.value } }))}
                                    startContent={<FileText size={14} className="text-zinc-500" />}
                                    classNames={{ inputWrapper: "h-10 w-full md:w-40 bg-white dark:bg-zinc-900 border-none" }}
                                  />
                                </div>
                              </div>
                              
                              <div className="flex items-center gap-4 w-full md:w-auto justify-between md:justify-end">
                                <div className="text-right">
                                  <p className="text-[9px] font-bold uppercase text-zinc-500 tracking-widest">WAC Estimado</p>
                                  <p className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{formatCurrency(groupTotal)}</p>
                                </div>
                                <Button
                                  color="warning"
                                  className="h-11 px-6 font-bold uppercase tracking-widest text-[11px] shadow-lg shadow-amber-500/20"
                                  isLoading={isSubmitting}
                                  onPress={() => handleConfirmGroup(group.supplierName, group.supplierId, group.items)}
                                  startContent={!isSubmitting && <CheckCircle size={16} />}
                                >
                                  Confirmar
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                </div>

                {/* ITEMS LIMIT SELECTOR */}
                <div className="shrink-0 bg-white dark:bg-zinc-950 border-t border-gray-200 dark:border-white/10 p-3 md:p-4 flex flex-col sm:flex-row items-center justify-center sm:justify-between gap-3 backdrop-blur-md">
                  <div className="flex flex-col gap-0.5 items-center sm:items-start">
                    <p className="text-[9px] md:text-[11px] text-gray-900 dark:text-white uppercase tracking-widest font-black italic leading-none text-center sm:text-left">
                      Viendo <span className="text-emerald-500">{Math.min(pageSize, totalItemsCount)}</span> de {totalItemsCount} sugerencias
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[8px] font-black text-gray-400 uppercase tracking-widest italic">Mostrar:</span>
                    <div className="relative">
                      <select
                        value={pageSize}
                        onChange={(e) => setPageSize(Number(e.target.value))}
                        className="h-8 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white text-[10px] font-black uppercase tracking-widest px-3 pr-8 outline-none rounded-xl border border-gray-200 dark:border-white/10 cursor-pointer shadow-sm appearance-none hover:border-emerald-500/50 transition-all"
                      >
                        <option value={20}>20</option>
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                        <option value={500}>500</option>
                        <option value={1000}>1000</option>
                        <option value={2000}>2000</option>
                        <option value={10000}>TODOS</option>
                      </select>
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-40">
                        <ChevronDown size={12} />
                      </div>
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>
          </div>
      </div>
    </div>
  );
}
