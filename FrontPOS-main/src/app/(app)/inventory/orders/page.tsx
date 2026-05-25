"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ShoppingBag, Truck, Calendar, DollarSign, Plus, FileText,
  Sparkles, CheckCircle, Building2, PackageSearch, Check,
  ChevronLeft, ChevronRight, Info, ChevronDown, RefreshCw
} from 'lucide-react';
import {
  Card, CardBody, Button, Input, Table, TableHeader,
  TableColumn, TableBody, TableRow, TableCell, Chip,
  Autocomplete, AutocompleteItem, Select, SelectItem,
  Pagination, Skeleton
} from "@heroui/react";
import { setupSyncListener } from '@/lib/revalidate';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import Cookies from 'js-cookie';
import { Supplier } from '@/lib/definitions';
import SupplierFormModal from '../../suppliers/components/SupplierFormModal';
import { formatCurrency, applyRounding, calculateStockHealth } from "@/lib/utils";
import { API_URL } from '@/lib/constants';
import { extractApiError } from '@/lib/api-error';



interface SuggestedOrder {
  barcode: string;
  productName: string;
  stock: number;
  minStock: number;
  isPack: boolean;
  packMultiplier: number;
  orderMultiple: number;
  requiredMin: number;
  projectedSales: number;
  totalIdeal: number;
  recentSales: number;
  avgDailySales: number;
  suggested: number;
  purchasePrice: number;
  supplierId: number;
  threshold: number;
  status: string;
  bestSupplierId: number;
  bestSupplierName: string;
  lowestPrice: number;
  worstPrice: number;
  worstSupplierName: string;
  isHighRotation: boolean;
  quantity: number;
  alert?: string;
  alertType?: string;
  sales30d?: number;
  suggestedMinStock?: number;
  pendingOrderQty?: number;
  transitDetail?: string;
}

interface MissingItem {
  id: number;
  product_name: string;
  status: string;
}

export default function SmartRestockPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const apiUrl = API_URL;
  const authHeaders = useCallback((isJson = true) => {
    const token = Cookies.get('org-pos-token');
    const headers: any = { 'Authorization': `Bearer ${token}` };
    if (isJson) headers['Content-Type'] = 'application/json';
    return headers;
  }, []);

  // States
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [items, setItems] = useState<SuggestedOrder[]>([]);
  const [orderItems, setOrderItems] = useState<SuggestedOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSupplier, setSelectedSupplier] = useState<string>("global");

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Computed pagination values
  const totalItemsCount = useMemo(() => {
    return selectedSupplier === "global" ? items.length : orderItems.length;
  }, [selectedSupplier, items, orderItems]);

  const totalPagesCount = useMemo(() => {
    return Math.ceil(totalItemsCount / pageSize) || 1;
  }, [totalItemsCount, pageSize]);

  // Preventa Form
  const [isSubmittingPreventa, setIsSubmittingPreventa] = useState(false);
  const [newPreventa, setNewPreventa] = useState({ supplierId: 0, supplierName: '', date: '', total: '' });
  const [dateOptions, setDateOptions] = useState<{ label: string, value: string }[]>([]);
  const [totalDisplay, setTotalDisplay] = useState('');
  const [supplierSearchTerm, setSupplierSearchTerm] = useState("");
  const [isSupplierModalOpen, setIsSupplierModalOpen] = useState(false);
  
  // Custom Requested Quantities
  const [orderedQuantities, setOrderedQuantities] = useState<Record<string, number>>({});

  // Missing Items
  const [missingItems, setMissingItems] = useState<MissingItem[]>([]);
  const [loadingMissingItems, setLoadingMissingItems] = useState(false);
  const [discardedSavings, setDiscardedSavings] = useState<string[]>([]);
  const [ignoredBarcodes, setIgnoredBarcodes] = useState<string[]>([]);
  const [productSearchTerm, setProductSearchTerm] = useState('');

  // Client-side pagination and filtering for the table
  const categorizedItems = useMemo(() => {
    // MASTER SPRINT: Filtrar productos que no necesitan reabastecimiento (sugerido <= 0) excepto los slow movers con alertas
    const raw = (selectedSupplier === "global" ? items : orderItems).filter(item => !ignoredBarcodes.includes(item.barcode) && (item.suggested > 0 || item.alertType === 'SLOW_MOVER' || item.alertType === 'INCREASE_MIN_STOCK'));

    const sortFn = (a: SuggestedOrder, b: SuggestedOrder) => {
      const healthA = calculateStockHealth(a.stock, a.minStock);
      const healthB = calculateStockHealth(b.stock, b.minStock);
      
      // 1. Salud (Rojo < Amarillo < Verde)
      const wA = healthA === 'CRITICAL' ? 0 : healthA === 'WARNING' ? 1 : 2;
      const wB = healthB === 'CRITICAL' ? 0 : healthB === 'WARNING' ? 1 : 2;
      if (wA !== wB) return wA - wB;

      // 2. Lo que más se necesita (Sugerido mayor)
      const sugA = a.suggested || 0;
      const sugB = b.suggested || 0;
      if (sugB !== sugA) return sugB - sugA;

      // 3. Los más vendidos (Rotación mayor)
      const rotA = a.avgDailySales || 0;
      const rotB = b.avgDailySales || 0;
      return rotB - rotA;
    };
    
    return {
      highRotation: raw.filter(item => item.alertType === 'HIGH_MOVER' || (item.avgDailySales > 1.5 && item.stock <= (item.minStock * 2))).sort(sortFn),
      predictive: raw.filter(item => item.alertType === 'PREDICTIVE').sort(sortFn),
      mandatory: raw.filter(item => item.stock <= item.minStock && item.alertType !== 'SLOW_MOVER' && item.alertType !== 'PREDICTIVE').sort(sortFn),
      stagnant: raw.filter(item => item.alertType === 'SLOW_MOVER' || (item.avgDailySales === 0 && item.stock > 0 && item.purchasePrice > 0)).sort(sortFn),
      others: raw.filter(item => {
        const isHigh = item.alertType === 'HIGH_MOVER' || (item.avgDailySales > 1.5 && item.stock <= (item.minStock * 2));
        const isPredictive = item.alertType === 'PREDICTIVE';
        const isMandatory = item.stock <= item.minStock && item.alertType !== 'SLOW_MOVER';
        const isStagnant = item.alertType === 'SLOW_MOVER' || (item.avgDailySales === 0 && item.stock > 0);
        return !isHigh && !isPredictive && !isMandatory && !isStagnant;
      }).sort(sortFn)
    };
  }, [items, orderItems, selectedSupplier, ignoredBarcodes]);

  const displayedItems = useMemo(() => {
    let all: SuggestedOrder[] = [];
    const baseItems = selectedSupplier === "global" ? items : orderItems;
    
    // MASTER SPRINT: Filtrar productos que no necesitan reabastecimiento (sugerido > 0) o slow movers
    all = baseItems.filter(item => !ignoredBarcodes.includes(item.barcode) && (item.suggested > 0 || item.alertType === 'SLOW_MOVER' || item.alertType === 'INCREASE_MIN_STOCK'));

    // Filtro de búsqueda por producto
    if (productSearchTerm.trim()) {
      const search = productSearchTerm.toLowerCase().trim();
      all = all.filter(item =>
        item.productName.toLowerCase().includes(search) ||
        item.barcode.toLowerCase().includes(search) ||
        (item.bestSupplierName && item.bestSupplierName.toLowerCase().includes(search))
      );
    }

    // --- ALGORITMO DE ORDENAMIENTO PONDERADO POS Pro v4.5 (Triple Criterio) ---
    all.sort((a, b) => {
      const healthA = calculateStockHealth(a.stock, a.minStock);
      const healthB = calculateStockHealth(b.stock, b.minStock);
      
      // 1. Salud (Rojo < Amarillo < Verde)
      const wA = healthA === 'CRITICAL' ? 0 : healthA === 'WARNING' ? 1 : 2;
      const wB = healthB === 'CRITICAL' ? 0 : healthB === 'WARNING' ? 1 : 2;
      if (wA !== wB) return wA - wB;

      // 2. Urgencia: Lo que más unidades pide (Sugerido mayor)
      const sugA = a.suggested || 0;
      const sugB = b.suggested || 0;
      if (sugB !== sugA) return sugB - sugA;

      // 3. Rotación: Los más vendidos (Demanda diaria mayor)
      const rotA = a.avgDailySales || 0;
      const rotB = b.avgDailySales || 0;
      return rotB - rotA;
    });
    
    const start = (page - 1) * pageSize;
    return all.slice(start, start + pageSize);
  }, [selectedSupplier, items, orderItems, page, pageSize, ignoredBarcodes, productSearchTerm]);
  const fetchSuppliers = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/suppliers/all-suppliers`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Error al cargar proveedores');
      const data = await res.json();
      const suppliersList = Array.isArray(data) ? data : (data?.items || []);
      setSuppliers(suppliersList);
    } catch (err) {
      console.error(err);
    }
  }, [apiUrl, authHeaders]);

  // Lista completa para el Autocomplete
    const suppliersList = useMemo(() => [{id: 'none', name: 'SIN PROVEEDOR'}, ...suppliers], [suppliers]);

    // FILTRO MANUAL BLINDADO (Copiado de Egresos)
  const filteredSuppliers = useMemo(() => {
    if (!suppliers) return [];
    if (!supplierSearchTerm) return suppliersList;
    const search = supplierSearchTerm.toLowerCase();
    return suppliersList.filter(s => s.name.toLowerCase().includes(search));
  }, [suppliersList, supplierSearchTerm, suppliers]);

  const fetchMissingItems = useCallback(async () => {
    setLoadingMissingItems(true);
    try {
      const res = await fetch(`${apiUrl}/missing-items`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        const itemsList = Array.isArray(data) ? data : (data?.items || []);
        setMissingItems(itemsList.filter((i: any) => i.status === 'PENDIENTE'));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMissingItems(false);
    }
  }, [apiUrl, authHeaders]);

  const loadGlobalSuggestions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/inventory/global-restock`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Error al cargar radar global');
      const data = await res.json();
      const groups = Array.isArray(data) ? data : [];
      const flatItems: any[] = [];
      groups.forEach((group: any) => {
        const items = Array.isArray(group.items) ? group.items : [];
        items.forEach((item: any) => {
          flatItems.push({
            barcode: item.barcode,
            productName: item.productName || item.product_name,
            stock: Number(item.stock) || 0,
            requiredMin: Number(item.requiredMin) || Number(item.required_min) || 0,
            suggested: Number(item.suggested) || 0,
            totalIdeal: Number(item.totalIdeal) || Number(item.total_ideal) || 0,
            purchasePrice: Number(item.purchasePrice) || Number(item.purchase_price) || 0,
            status: item.status || 'NORMAL',
            quantity: Number(item.suggested) || Number(item.total_ideal) || 0,
            bestSupplierId: Number(item.bestSupplierId) || 0,
            bestSupplierName: item.bestSupplierName || '',
            lowestPrice: Number(item.lowestPrice) || 0,
            worstPrice: Number(item.worstPrice) || 0,
            worstSupplierName: item.worstSupplierName || item.worstSupplier || '',
            minStock: Number(item.minStock) || Number(item.min_stock) || 0,
            supplierId: Number(group.supplierId) || Number(item.supplierId) || Number(item.supplier_id) || 0,
            isHighRotation: !!item.isHighRotation,
            avgDailySales: Number(item.avgDailySales) || Number(item.avg_daily_sales) || 0,
            isPack: !!item.isPack,
            packMultiplier: Number(item.packMultiplier) || Number(item.pack_multiplier) || 0,
            projectedSales: Number(item.projectedSales) || Number(item.projected_sales) || 0,
            recentSales: Number(item.recentSales) || Number(item.recent_sales) || 0,
            threshold: Number(item.threshold) || 0,
            alert: item.alert || '',
            alertType: item.alertType || '',
            sales30d: Number(item.sales30d) || 0,
            suggestedMinStock: Number(item.suggestedMinStock) || Number(item.suggested_min_stock) || 0,
            pendingOrderQty: Number(item.pendingOrderQty) || 0,
            transitDetail: item.transitDetail || ''
          });
        });
      });
      setItems(flatItems);
    } catch (err) {
    } finally {
      setLoading(false);
    }
  }, [apiUrl, authHeaders]);

  const loadSuggestions = useCallback(async (supplierId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/inventory/suggested-orders?supplier_id=${supplierId}`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Error al cargar sugerencias');
      const data = await res.json();
      const itemsList = Array.isArray(data) ? data : (data?.items || []);
      const mapped = itemsList.map((item: any) => ({
        barcode: item.barcode,
        productName: item.productName || item.product_name,
        stock: Number(item.stock) || 0,
        requiredMin: Number(item.requiredMin) || Number(item.required_min) || 0,
        suggested: Number(item.suggested) || 0,
        totalIdeal: Number(item.totalIdeal) || Number(item.total_ideal) || 0,
        purchasePrice: Number(item.purchasePrice) || Number(item.purchase_price) || 0,
        status: item.status || 'NORMAL',
        quantity: Number(item.suggested) || Number(item.total_ideal) || 0,
        bestSupplierId: Number(item.bestSupplierId) || 0,
        bestSupplierName: item.bestSupplierName || '',
        minStock: Number(item.minStock) || Number(item.min_stock) || 0,
        supplierId: Number(supplierId),
        lowestPrice: Number(item.lowestPrice) || Number(item.lowest_price) || 0,
        worstPrice: Number(item.worstPrice) || Number(item.worst_price) || 0,
        worstSupplierName: item.worstSupplierName || item.worstSupplier || '',
        isHighRotation: !!item.isHighRotation,
        avgDailySales: Number(item.avgDailySales) || Number(item.avg_daily_sales) || 0,
        isPack: !!item.isPack,
        packMultiplier: Number(item.packMultiplier) || Number(item.pack_multiplier) || 0,
        projectedSales: Number(item.projectedSales) || Number(item.projected_sales) || 0,
        recentSales: Number(item.recentSales) || Number(item.recent_sales) || 0,
        threshold: Number(item.threshold) || 0,
        alert: item.alert || '',
        alertType: item.alertType || '',
        sales30d: Number(item.sales30d) || 0,
        suggestedMinStock: Number(item.suggestedMinStock) || Number(item.suggested_min_stock) || 0,
        pendingOrderQty: Number(item.pendingOrderQty) || 0,
        transitDetail: item.transitDetail || ''
      }));
      setOrderItems(mapped);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, authHeaders]);

  const calculateDeliveryDates = (supplier: Supplier) => {
    if (!supplier.deliveryDays || supplier.deliveryDays.length === 0) {
      setDateOptions([]);
      return;
    }
    const today = new Date();
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const options: any[] = [];
    const deliveryIndices = (supplier.deliveryDays || []).map(d => {
      const dl = d.toLowerCase();
      if (dl.includes('lun')) return 1; if (dl.includes('mar')) return 2; if (dl.includes('mié')) return 3;
      if (dl.includes('jue')) return 4; if (dl.includes('vie')) return 5; if (dl.includes('sáb')) return 6;
      if (dl.includes('dom')) return 0; return -1;
    }).filter(i => i !== -1);

    for (let i = 1; i < 15 && options.length < 4; i++) {
      const d = new Date(today); d.setDate(today.getDate() + i);
      if ((deliveryIndices as number[]).includes(d.getDay())) {
        options.push({ label: `${dayNames[d.getDay()]} ${d.getDate()}`, value: d.toISOString().split('T')[0] });
      }
    }
    setDateOptions(options);
    if (options.length > 0) setNewPreventa(prev => ({ ...prev, date: options[0].value }));
  };

  const handleSupplierChange = (key: any) => {
    if (!key || key === "none") return;
    const id = String(key);

    if (id === "global") {
      setSelectedSupplier("global");
      loadGlobalSuggestions();
      setNewPreventa(p => ({ ...p, supplierId: 0, supplierName: '', date: '' }));
      setSupplierSearchTerm("");
      setDateOptions([]);
      return;
    }

    const s = suppliers.find(sup => String(sup.id) === id);
    if (s) {
      setSelectedSupplier(id);
      loadSuggestions(id);
      calculateDeliveryDates(s);
      setNewPreventa(p => ({
        ...p,
        supplierId: Number(s.id),
        supplierName: s.name
      }));
      setSupplierSearchTerm(s.name);
    }
  };

  useEffect(() => {
    fetchSuppliers();
    fetchMissingItems();

    const cleanup = setupSyncListener((event) => {
        if (['PRODUCT_UPDATE', 'STOCK_UPDATE', 'SALE_MADE', 'DASHBOARD_UPDATE', 'CATEGORY_UPDATE'].includes(event as string)) {
            fetchSuppliers();
            fetchMissingItems();
            if (selectedSupplier === "global") loadGlobalSuggestions();
            else loadSuggestions(selectedSupplier);
        }
    });
    return cleanup;
  }, [fetchSuppliers, fetchMissingItems, selectedSupplier, loadGlobalSuggestions, loadSuggestions]);

  useEffect(() => {
    if (selectedSupplier === "global") {
      loadGlobalSuggestions();
    } else {
      loadSuggestions(selectedSupplier);
    }
  }, [selectedSupplier, loadGlobalSuggestions, loadSuggestions]);

  const handleResolveMissingItem = async (id: number) => {
    try {
      const res = await fetch(`${apiUrl}/admin/missing-items/status`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ id, status: 'RESUELTO' })
      });
      if (res.ok) {
        setMissingItems(prev => prev.filter(item => item.id !== id));
        toast({ title: "Éxito", description: "Faltante marcado como resuelto" });
        fetchMissingItems();
      }
    } catch (err) { }
  };

  const handleIgnoreBarcode = (barcode: string) => {
    setIgnoredBarcodes(prev => [...prev, barcode]);
    toast({
      title: "SUGERENCIA IGNORADA",
      description: "El producto se ha ocultado del radar temporalmente.",
      duration: 3000
    });
  };

  const handleReduceMinStock = async (barcode: string, newMin: number) => {
    try {
      const res = await fetch(`${apiUrl}/products/update-min-stock/${barcode}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ minStock: newMin })
      });
      if (!res.ok) {
        throw new Error('Error al actualizar el stock mínimo');
      }
      
      // Actualizar localmente en memoria silenciando el item al vaciar su alerta
      setItems(prev => prev.map(item => item.barcode === barcode ? { ...item, minStock: newMin, alertType: "", alert: "" } : item));
      setOrderItems(prev => prev.map(item => item.barcode === barcode ? { ...item, minStock: newMin, alertType: "", alert: "" } : item));
      
      toast({
        title: "STOCK MÍNIMO ACTUALIZADO",
        description: `Se redujo el stock mínimo a ${newMin} unidades.`,
        duration: 3000
      });
    } catch (err: any) {
      console.error(err);
      toast({
        variant: "destructive",
        title: "ERROR",
        description: err.message || "No se pudo actualizar el stock mínimo",
        duration: 5000
      });
    }
  };

  const handleSaveOrder = async () => {
    if (!newPreventa.supplierName || !newPreventa.date) {
      toast({
        title: "Proveedor Requerido",
        description: "Debe seleccionar un proveedor para completar esta acción",
        variant: "destructive"
      });
      return;
    }

    // Preparar ítems usando las cantidades personalizadas (o sugeridas por defecto)
    const itemsToOrder = categorizedItems.mandatory.concat(categorizedItems.predictive).map(item => {
      const customQty = orderedQuantities[item.barcode];
      const finalQty = customQty !== undefined ? customQty : item.suggested;
      return {
        barcode: item.barcode,
        productName: item.productName,
        expectedQuantity: finalQty
      };
    }).filter(i => i.expectedQuantity > 0);

    setIsSubmittingPreventa(true);
    try {
      const res = await fetch(`${apiUrl}/orders/expected`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          supplierId: newPreventa.supplierId || 0,
          supplierName: newPreventa.supplierName,
          expectedDate: newPreventa.date,
          totalEstimated: parseFloat(newPreventa.total) || 0,
          itemCount: itemsToOrder.length,
          items: itemsToOrder
        })
      });
      if (res.ok) {
        toast({ title: "Éxito", description: "Preventa guardada y en seguimiento" });
        setOrderedQuantities({});

        // Actualizar días de entrega del proveedor si es necesario
        if (newPreventa.supplierId) {
          const supplier = suppliers.find(s => Number(s.id) === newPreventa.supplierId);
          if (supplier) {
            const date = new Date(newPreventa.date + 'T12:00:00'); // Asegurar parsing local correcto
            const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
            const dayName = dayNames[date.getDay()];

            const currentDays = supplier.deliveryDays || [];
            if (!currentDays.includes(dayName)) {
              try {
                await fetch(`${apiUrl}/suppliers/update-suppliers/${supplier.id}`, {
                  method: 'PUT',
                  headers: authHeaders(true),
                  body: JSON.stringify({ ...supplier, deliveryDays: [...currentDays, dayName] })
                });
                await fetchSuppliers();
              } catch (err) {
                console.error("Error al actualizar días del proveedor:", err);
              }
            }
          }
        }

        setNewPreventa({ supplierId: 0, supplierName: '', date: '', total: '' });
        setTotalDisplay('');
        setSupplierSearchTerm("");
        setSelectedSupplier("global");
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setIsSubmittingPreventa(false);
    }
  };

  const handleSaveSupplier = async (data: any) => {
    try {
      const res = await fetch(`${apiUrl}/suppliers/create-suppliers`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify(data)
      });
      if (res.ok) {
        toast({ title: "Éxito", description: "Proveedor creado correctamente" });
        await fetchSuppliers();
        setIsSupplierModalOpen(false);
      }
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const supplierOptionsWithGlobal = useMemo(() => {
    const list = [{ id: 'global', name: 'RADAR GLOBAL' }, { id: '__new__', name: '+ NUEVO PROVEEDOR' }, ...suppliers];
    return list;
  }, [suppliers]);

  const SmartSourcingAlerts = () => {
    const allItems = selectedSupplier === "global" ? items : orderItems;

    const savingOpportunities = allItems.filter(item =>
      item.worstPrice > 0 && 
      item.lowestPrice > 0 &&
      item.worstPrice > item.lowestPrice &&
      !discardedSavings.includes(item.barcode)
    );

    if (savingOpportunities.length === 0) return null;

    const topOpportunities = savingOpportunities
      .sort((a, b) => (b.purchasePrice - b.lowestPrice) - (a.purchasePrice - a.lowestPrice))
      .slice(0, 15);

    const handleDiscardSaving = (barcode: string) => {
      setDiscardedSavings(prev => [...prev, barcode]);
    };

    return (
      <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 border border-emerald-500/50 rounded-2xl p-4 mt-4 flex flex-col gap-4 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-emerald-500/5 animate-in fade-in slide-in-from-top-2 duration-500">
        <div className="flex items-center gap-2">
          <span className="text-lg">💡</span>
          <h3 className="text-[11px] font-medium uppercase tracking-widest text-zinc-300">Oportunidades de Ahorro</h3>
        </div>
        <div className="flex flex-col gap-3 max-h-[400px] overflow-y-auto custom-scrollbar pr-2">
          {topOpportunities.length > 0 ? topOpportunities.map(item => (
            <div key={item.barcode} className="flex items-center gap-2 group">
              <div className="flex-1 flex flex-col gap-1.5 border-l-2 border-emerald-500/30 pl-3 py-1 hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 transition-colors rounded-r-md">
                <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 uppercase leading-none tracking-tight">
                  {item.productName}
                </span>
                <p className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100/90 leading-tight">
                  Cómpralo con <span className="text-zinc-300 font-medium uppercase tracking-tight underline decoration-emerald-500/30">{item.bestSupplierName}</span> y ahorra <span className="text-zinc-300 font-medium">${(item.worstPrice - item.lowestPrice).toLocaleString()}</span> frente a <span className="text-zinc-900 dark:text-zinc-100 font-bold uppercase">{item.worstSupplierName}</span>.
                </p>
              </div>
              <Button 
                isIconOnly 
                size="sm" 
                variant="light" 
                className="opacity-0 group-hover:opacity-100 h-7 w-7 text-zinc-900 dark:text-zinc-100/50 hover:text-rose-500 transition-all"
                onPress={() => handleDiscardSaving(item.barcode)}
              >
                <Plus className="rotate-45" size={14} />
              </Button>
            </div>
          )) : (
            <div className="py-4 text-center">
              <p className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100/40 uppercase tracking-tight tracking-widest leading-relaxed">
                No hay oportunidades de comparación de precios en este momento.
              </p>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-black overflow-y-auto md:overflow-hidden select-none text-zinc-900 dark:text-zinc-100">

      {/* HEADER SUPERIOR (FIJO) */}
      <div className="p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between bg-white dark:bg-zinc-950 border-b border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] gap-4 shrink-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 h-10 w-10 rounded-2xl flex items-center justify-center text-zinc-900 dark:text-zinc-100 shadow-[0_8px_30px_rgb(0,0,0,0.12)] transform -rotate-3">
            <ShoppingBag size={20} />
          </div>
          <div>
            <h1 className="text-sm font-medium uppercase tracking-tight tracking-tighter leading-none">Smart <span className="text-zinc-900 dark:text-zinc-100">Restock</span></h1>
            <p className="text-[9px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest mt-0.5">IA y Radar de Abastecimiento</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            isIconOnly
            variant="flat"
            onPress={() => {
                if (selectedSupplier === "global") loadGlobalSuggestions();
                else loadSuggestions(selectedSupplier);
            }}
            className="h-10 w-10 bg-gray-100 dark:bg-[#18181b] text-zinc-900 dark:text-zinc-100 rounded-2xl border border-gray-200 dark:border-white/5 active:scale-95"
          >
            <RefreshCw size={18} />
          </Button>
        </div>
      </div>

      {/* BUSCADOR UNIVERSAL DE PRODUCTOS */}
      <div className="px-1 md:px-2 pb-2">
        <Input
          placeholder="🔍 Buscar producto por nombre, código o proveedor..."
          size="sm"
          value={productSearchTerm}
          onChange={(e) => setProductSearchTerm(e.target.value)}
          isClearable
          onClear={() => setProductSearchTerm('')}
          classNames={{
            inputWrapper: "card-base border-none border border-gray-200 dark:border-white/10 rounded-2xl h-10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]",
            input: "text-xs font-bold placeholder:text-zinc-500 dark:text-zinc-400"
          }}
        />
      </div>

      {/* CONTENIDO PRINCIPAL */}
      <div className="flex-1 p-1 md:p-2 min-h-0 md:overflow-hidden">
        <div className="flex flex-col lg:grid lg:grid-cols-12 gap-4 h-full min-h-0 md:overflow-hidden">

          {/* COLUMNA DERECHA (AHORA PRIMERA EN MÓVIL): REGISTRO Y FALTANTES */}
          <div className="order-1 lg:order-2 lg:col-span-4 flex flex-col gap-3 md:gap-4 overflow-y-auto lg:overflow-y-auto custom-scrollbar shrink-0 min-h-0">
            <Card className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] relative overflow-hidden shrink-0">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-amber-500 to-amber-600" />
              <CardBody className="p-3 md:p-5 flex flex-col gap-3 md:gap-4">
                <div className="flex items-center gap-2">
                  <Calendar size={18} className="text-amber-500" />
                  <h3 className="text-xs font-medium uppercase tracking-tight tracking-tight">Registrar Preventa</h3>
                </div>

                <div className="flex flex-col gap-3 md:gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[9px] font-medium uppercase text-zinc-500 dark:text-zinc-400 tracking-widest pl-1">Proveedor</label>
                    <div className="flex gap-2">
                      <Autocomplete
                        size="sm"
                        placeholder="Buscar..."
                        className="flex-1"
                        items={filteredSuppliers}
                        inputValue={supplierSearchTerm}
                        onInputChange={setSupplierSearchTerm}
                        defaultSelectedKey={newPreventa.supplierId ? String(newPreventa.supplierId) : undefined}
                        allowsCustomValue
                        onSelectionChange={(key) => {
                          if (!key) return;
                          if (key === '__new__') {
                            setIsSupplierModalOpen(true);
                          } else {
                            handleSupplierChange(String(key));
                            const name = suppliersList.find(s => String(s.id) === String(key))?.name || '';
                            if (name) setSupplierSearchTerm(name);
                          }
                        }}
                        inputProps={{ classNames: { inputWrapper: "bg-gray-100 dark:bg-[#18181b] border-none rounded-2xl", input: "text-[10px] font-bold" } }}
                        popoverProps={{
                          classNames: {
                            content: "bg-[#18181b] border border-zinc-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-1 rounded-2xl"
                          }
                        }}
                        listboxProps={{
                          itemClasses: {
                            base: "data-[hover=true]:bg-white/5 data-[hover=true]:text-zinc-300 text-[11px] uppercase font-bold",
                          }
                        }}
                      >
                        {(item: any) => (
                          <AutocompleteItem key={String(item.id)} textValue={item.name}>
                            <span className="text-[11px] font-bold uppercase">{item.name}</span>
                          </AutocompleteItem>
                        )}
                      </Autocomplete>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[9px] font-medium uppercase text-zinc-500 dark:text-zinc-400 tracking-widest pl-1">Entrega Estimada</label>
                    <div className="flex flex-col gap-2">
                      <Input
                        type="date"
                        size="sm"
                        value={newPreventa.date}
                        onChange={(e) => setNewPreventa(p => ({ ...p, date: e.target.value }))}
                        startContent={<Calendar size={14} className="text-zinc-500 dark:text-zinc-400" />}
                        classNames={{ 
                          inputWrapper: "bg-gray-100 dark:bg-[#18181b] border-none rounded-2xl h-11", 
                          input: "text-[11px] font-bold uppercase" 
                        }}
                      />
                      
                      {dateOptions.length > 0 && (
                        <div className="flex flex-col gap-1">
                          <span className="text-[8px] font-medium text-amber-500 uppercase tracking-tighter tracking-tight pl-1 flex items-center gap-1">
                            <Sparkles size={8} /> Sugerencias Inteligentes (Ruta)
                          </span>
                          <div className="flex gap-1.5 overflow-x-auto pb-1 custom-scrollbar no-scrollbar scroll-smooth">
                            {dateOptions.map(o => (
                              <button
                                key={o.value}
                                onClick={() => setNewPreventa(p => ({ ...p, date: o.value }))}
                                className={`shrink-0 px-3 py-1.5 rounded-2xl text-[9px] font-medium uppercase transition-all active:scale-95 border ${
                                  newPreventa.date === o.value 
                                  ? 'bg-amber-500 text-white border-amber-500 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-amber-500/20' 
                                  : 'card-base border-none text-zinc-500 border-zinc-200 dark:border-white/5 hover:border-amber-500/50'
                                }`}
                              >
                                {o.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[9px] font-medium uppercase text-zinc-500 dark:text-zinc-400 tracking-widest pl-1">Monto Estimado</label>
                    <Input
                      type="text"
                      size="sm"
                      placeholder="$ 0"
                      value={totalDisplay}
                      onChange={(e) => {
                        const val = e.target.value.replace(/\D/g, '');
                        setTotalDisplay(new Intl.NumberFormat('es-CO').format(Number(val)));
                        setNewPreventa(prev => ({ ...prev, total: val }));
                      }}
                      classNames={{ inputWrapper: "bg-gray-100 dark:bg-[#18181b] border-none rounded-2xl", input: "text-lg font-medium tracking-tight text-zinc-900 dark:text-zinc-100" }}
                      startContent={<DollarSign size={16} className="text-zinc-900 dark:text-zinc-100" />}
                    />
                  </div>

                  <Button
                    className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 font-medium uppercase tracking-tight tracking-widest py-6 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95"
                    isLoading={isSubmittingPreventa}
                    onPress={handleSaveOrder}
                    startContent={<CheckCircle size={18} />}
                  >
                    Confirmar Registro
                  </Button>
                </div>
              </CardBody>
            </Card>

            <Card className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden shrink-0">
              <CardBody className="p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <PackageSearch size={16} className="text-rose-500" />
                    <h3 className="text-[10px] font-medium uppercase tracking-tight text-zinc-500 tracking-wider">Faltantes en Caja</h3>
                  </div>
                </div>
                <div className="flex flex-col gap-2 max-h-[200px] md:max-h-[300px] overflow-y-auto custom-scrollbar">
                  {loadingMissingItems ? <Skeleton className="h-10 w-full rounded-2xl" /> : missingItems.length > 0 ? (
                    missingItems.map(m => (
                      <div key={m.id} className="flex items-center justify-between p-2.5 bg-rose-500/[0.03] rounded-2xl border border-rose-500/10">
                        <div className="flex items-center gap-3 min-w-0">
                          <Button isIconOnly size="sm" variant="flat" onPress={() => handleResolveMissingItem(m.id)} className="h-8 w-8 rounded-2xl card-base border-none border border-zinc-200 dark:border-white/10 hover:bg-emerald-500 hover:text-white transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)]"><Check size={14} /></Button>
                          <div className="flex flex-col min-w-0">
                            <span className="font-bold uppercase truncate text-[10px]">{m.product_name}</span>
                            <span className="text-[8px] text-zinc-500 dark:text-zinc-400 uppercase font-bold tracking-tight tracking-tighter">Pendiente</span>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : <div className="p-8 text-center text-[9px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-tight tracking-widest">Sin pendientes</div>}
                </div>
              </CardBody>
            </Card>

            <SmartSourcingAlerts />
          </div>

          {/* COLUMNA IZQUIERDA (AHORA SEGUNDA): RECOMENDACIONES */}
          <div className="order-2 lg:order-1 lg:col-span-8 flex flex-col min-h-0 flex-1">
            <Card className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden h-full flex flex-col">
              <CardBody className="p-0 flex flex-col flex-1 min-h-0 overflow-hidden">

                {/* ÁREA DE DATOS (BLOQUES DE PRIORIDAD TASK 2) */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-3 md:p-6 flex flex-col gap-8 min-h-0">
                  
                  {/* SECCIÓN 1: 🔥 ALTA ROTACIÓN */}
                  {categorizedItems.highRotation.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex items-center justify-between border-b border-orange-500/20 pb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xl">🔥</span>
                          <h2 className="text-[12px] font-medium uppercase tracking-widest text-orange-500 tracking-tight">Productos Estrella (Alta Rotación)</h2>
                        </div>
                        <span className="text-[10px] font-bold text-orange-500/60 uppercase">{categorizedItems.highRotation.length} items</span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {categorizedItems.highRotation.map(item => (
                          <div key={item.barcode} className="group relative card-base border-none border border-zinc-200 dark:border-white/5 rounded-2xl p-4 shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:shadow-orange-500/5 transition-all hover:-translate-y-1">
                            <div className="absolute top-0 right-0 p-3">
                              <div className="bg-orange-500 text-white text-[9px] font-medium px-2 py-0.5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-orange-500/20 uppercase">Top Venta</div>
                            </div>
                            <div className="flex flex-col gap-3">
                              <div className="flex flex-col">
                                <span className="text-xs font-medium uppercase text-zinc-800 dark:text-zinc-100 leading-tight group-hover:text-orange-500 transition-colors truncate pr-12">{item.productName}</span>
                                <span className="text-[9px] font-mono text-zinc-500 dark:text-zinc-400 uppercase tracking-tighter">REF: {item.barcode}</span>
                                {item.alert && (
                                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                                    <span className={`text-[9px] font-medium uppercase tracking-tighter ${item.alertType === 'INCREASE_MIN_STOCK' ? 'text-zinc-900 dark:text-zinc-100 bg-white/5' : 'text-orange-500 bg-orange-500/10'} px-2 py-0.5 rounded-2xl self-start`}>
                                      {item.alertType === 'INCREASE_MIN_STOCK' ? '📈' : '⚠️'} {item.alert}
                                    </span>
                                    {item.alertType === 'INCREASE_MIN_STOCK' && item.suggestedMinStock !== undefined && item.suggestedMinStock > item.minStock && (
                                      <Button
                                        size="sm"
                                        color="success"
                                        variant="flat"
                                        className="text-[9px] h-6 px-2 font-bold uppercase tracking-tighter"
                                        onPress={() => handleReduceMinStock(item.barcode, item.suggestedMinStock!)}
                                      >
                                        Subir mín a {item.suggestedMinStock}
                                      </Button>
                                    )}
                                  </div>
                                )}
                                {(item.pendingOrderQty ?? 0) > 0 && (
                                  <span className="text-[9px] font-medium text-blue-500 bg-blue-500/10 px-2 py-0.5 rounded-2xl uppercase tracking-tight mt-1 self-start">
                                    🚚 En tránsito: {item.pendingOrderQty} und ({item.transitDetail})
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center justify-between mt-1">
                                <div className="flex flex-col">
                                  <span className="text-[9px] font-medium text-zinc-500 dark:text-zinc-400 uppercase leading-none">Stock Actual</span>
                                  <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100 tabular-nums">{item.stock}</span>
                                </div>
                                <div className="flex flex-col items-end">
                                  <span className="text-[9px] font-medium text-orange-500 uppercase leading-none">Sugerido</span>
                                  <span className="text-sm font-medium text-orange-500 tabular-nums">+{item.suggested}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 pt-2 border-t border-zinc-100 dark:border-white/5">
                                <span className="text-[9px] font-bold text-zinc-500 uppercase">📈 {item.avgDailySales} un/día</span>
                                {item.orderMultiple > 1 && (
                                  <span className="text-[9px] font-medium text-orange-500/70 uppercase bg-orange-500/10 px-2 py-0.5 rounded-2xl">
                                    {Math.ceil(item.suggested / item.orderMultiple)} pacas
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* SECCIÓN IA PREDICTIVA */}
                  {categorizedItems.predictive.length > 0 && (
                     <div className="flex flex-col gap-4">
                      <div className="flex items-center justify-between border-b border-emerald-500/20 pb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xl">✨</span>
                          <h2 className="text-[12px] font-medium uppercase tracking-widest text-emerald-500 tracking-tight">IA Predictiva</h2>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        {categorizedItems.predictive.map(item => {
                          const customQty = orderedQuantities[item.barcode];
                          const displayQty = customQty !== undefined ? customQty : item.suggested;
                          
                          return (
                          <div key={item.barcode} className="bg-emerald-50 dark:bg-emerald-500/5 border border-emerald-200 dark:border-emerald-500/20 rounded-2xl p-3 flex flex-col items-start justify-between gap-3 group transition-all border-l-4 border-l-emerald-500 h-full">
                            <div className="flex flex-col min-w-0 w-full">
                              <span className="text-[12px] md:text-sm font-bold uppercase text-emerald-800 dark:text-emerald-400 truncate">{item.productName}</span>
                              <div className="flex flex-wrap items-center gap-2 mt-1">
                                <span className="text-[10px] font-bold text-emerald-600/70 uppercase">IA Predictiva</span>
                                <span className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 uppercase">Min: {item.minStock} | Real: {item.stock}</span>
                                {(item.pendingOrderQty ?? 0) > 0 && (
                                  <span className="text-[9px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full uppercase">
                                    🚚 En tránsito: {item.pendingOrderQty}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between w-full mt-auto pt-2 border-t border-black/5 dark:border-white/5">
                              <span className="text-[10px] font-bold text-zinc-500 uppercase">Pedir:</span>
                              <div className="flex items-center gap-1 bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-white/10 rounded-lg p-0.5 shadow-sm">
                                <button 
                                  onClick={() => setOrderedQuantities(prev => ({ ...prev, [item.barcode]: Math.max(0, displayQty - 1) }))}
                                  className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 hover:text-emerald-600 rounded-md transition-colors font-bold text-lg"
                                >
                                  -
                                </button>
                                <input 
                                  type="number" 
                                  min="0"
                                  value={displayQty}
                                  onChange={(e) => setOrderedQuantities(prev => ({ ...prev, [item.barcode]: parseInt(e.target.value) || 0 }))}
                                  className="w-10 bg-transparent text-center font-bold text-zinc-900 dark:text-zinc-100 text-sm outline-none"
                                />
                                <button 
                                  onClick={() => setOrderedQuantities(prev => ({ ...prev, [item.barcode]: displayQty + 1 }))}
                                  className="w-7 h-7 flex items-center justify-center bg-emerald-500 text-white hover:bg-emerald-600 rounded-md transition-colors font-bold text-lg"
                                >
                                  +
                                </button>
                              </div>
                            </div>
                          </div>
                        )})}
                      </div>
                     </div>
                  )}

                  {/* SECCIÓN 2: ⚠️ PEDIDO OBLIGATORIO */}
                  {categorizedItems.mandatory.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex items-center justify-between border-b border-rose-500/20 pb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xl">⚠️</span>
                          <h2 className="text-[12px] font-medium uppercase tracking-widest text-rose-500 tracking-tight">Pedido Obligatorio (Stock Crítico)</h2>
                        </div>
                        <span className="text-[10px] font-bold text-rose-500/60 uppercase">{categorizedItems.mandatory.length} items</span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        {categorizedItems.mandatory.map(item => {
                          const health = calculateStockHealth(item.stock, item.minStock);
                          const isCritical = health === 'CRITICAL';
                          const bgColor = isCritical ? 'bg-rose-50 dark:bg-rose-500/5' : 'bg-amber-50 dark:bg-amber-500/5';
                          const borderColor = isCritical ? 'border-rose-200 dark:border-rose-500/20' : 'border-amber-200 dark:border-amber-500/20';
                          const accentColor = isCritical ? 'border-l-rose-500' : 'border-l-amber-500';
                          const textColor = isCritical ? 'text-rose-800 dark:text-rose-400' : 'text-amber-800 dark:text-amber-400';
                          
                          const customQty = orderedQuantities[item.barcode];
                          const displayQty = customQty !== undefined ? customQty : item.suggested;

                          return (
                            <div key={item.barcode} className={`${bgColor} ${borderColor} border rounded-2xl p-3 flex flex-col items-start justify-between gap-3 group transition-all border-l-4 ${accentColor} h-full`}>
                              <div className="flex flex-col min-w-0 w-full">
                                <span className={`text-[12px] md:text-sm font-bold uppercase ${textColor} truncate`}>{item.productName}</span>
                                <div className="flex flex-wrap items-center gap-2 mt-1">
                                  <span className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 uppercase">Min: {item.minStock} | Real: {item.stock}</span>
                                  {(item.pendingOrderQty ?? 0) > 0 && (
                                    <span className="text-[9px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full uppercase">
                                      🚚 En tránsito: {item.pendingOrderQty}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center justify-between w-full mt-auto pt-2 border-t border-black/5 dark:border-white/5">
                                <span className="text-[10px] font-bold text-zinc-500 uppercase">Pedir:</span>
                                <div className="flex items-center gap-1 bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-white/10 rounded-lg p-0.5 shadow-sm">
                                  <button 
                                    onClick={() => setOrderedQuantities(prev => ({ ...prev, [item.barcode]: Math.max(0, displayQty - 1) }))}
                                    className={`w-7 h-7 flex items-center justify-center text-zinc-500 hover:${isCritical ? 'bg-rose-50 dark:hover:bg-rose-500/10 hover:text-rose-600' : 'bg-amber-50 dark:hover:bg-amber-500/10 hover:text-amber-600'} rounded-md transition-colors font-bold text-lg`}
                                  >
                                    -
                                  </button>
                                  <input 
                                    type="number" 
                                    min="0"
                                    value={displayQty}
                                    onChange={(e) => setOrderedQuantities(prev => ({ ...prev, [item.barcode]: parseInt(e.target.value) || 0 }))}
                                    className="w-10 bg-transparent text-center font-bold text-zinc-900 dark:text-zinc-100 text-sm outline-none"
                                  />
                                  <button 
                                    onClick={() => setOrderedQuantities(prev => ({ ...prev, [item.barcode]: displayQty + 1 }))}
                                    className={`w-7 h-7 flex items-center justify-center ${isCritical ? 'bg-rose-500 hover:bg-rose-600' : 'bg-amber-500 hover:bg-amber-600'} text-white rounded-md transition-colors font-bold text-lg`}
                                  >
                                    +
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* SECCIÓN 3: 🧊 STOCK ESTANCADO */}
                  {categorizedItems.stagnant.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex items-center justify-between border-b border-zinc-500/20 pb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xl">🧊</span>
                          <h2 className="text-[12px] font-medium uppercase tracking-widest text-zinc-500 dark:text-zinc-400 tracking-tight">Stock Estancado (Sin Ventas)</h2>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
                        {categorizedItems.stagnant.slice(0, 18).map(item => (
                          <div key={item.barcode} className="bg-gray-100 dark:bg-[#18181b]/50 border border-transparent rounded-2xl p-3 flex flex-col gap-2 grayscale opacity-60 hover:grayscale-0 hover:opacity-100 hover:border-zinc-300 dark:hover:border-zinc-700 transition-all">
                            <span className="text-[10px] font-medium uppercase truncate text-zinc-600 dark:text-zinc-400">{item.productName}</span>
                            <div className="flex flex-col">
                              <span className="text-[11px] font-medium text-rose-500 uppercase leading-none">NO PEDIR</span>
                              <span className="text-[9px] font-bold text-zinc-500 dark:text-zinc-400 uppercase mt-1">Stock: {item.stock}</span>
                              {item.alert && (
                                <span className="text-[8px] font-medium text-rose-500/80 uppercase mt-1 leading-tight block">
                                  {item.alert}
                                </span>
                              )}
                            </div>
                            <div className="flex flex-col gap-1 mt-auto pt-2 border-t border-zinc-200/50 dark:border-white/5">
                              {item.suggestedMinStock !== undefined && item.suggestedMinStock !== item.minStock && (
                                <Button
                                  size="sm"
                                  color="warning"
                                  variant="flat"
                                  className="text-[9px] h-7 px-1 font-bold uppercase tracking-tighter"
                                  onPress={() => handleReduceMinStock(item.barcode, item.suggestedMinStock!)}
                                >
                                  Reducir a {item.suggestedMinStock}
                                </Button>
                              )}
                              <Button
                                size="sm"
                                color="default"
                                variant="light"
                                className="text-[9px] h-7 px-1 font-bold uppercase tracking-tighter text-zinc-500 dark:text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                                onPress={() => handleIgnoreBarcode(item.barcode)}
                              >
                                Ignorar
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                      {categorizedItems.stagnant.length > 18 && (
                        <p className="text-[9px] font-medium text-zinc-500 dark:text-zinc-400 text-center uppercase tracking-widest">+ {categorizedItems.stagnant.length - 18} productos estancados adicionales</p>
                      )}
                    </div>
                  )}

                  {/* SELECTOR GLOBAL ABAJO */}
                  <div className="mt-auto pt-6">
                    <div className="flex flex-col sm:flex-row items-center gap-4 card-base border-none p-2 rounded-2xl border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] w-full">
                      <button
                        onClick={() => handleSupplierChange("global")}
                        className={`flex-1 px-6 py-3 rounded-2xl text-[11px] font-medium uppercase tracking-widest transition-all h-12 ${selectedSupplier === "global" ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 shadow-[0_8px_30px_rgb(0,0,0,0.12)] ' : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-600 hover:bg-gray-100 dark:hover:bg-zinc-100 dark:bg-zinc-800'}`}
                      >
                        RADAR GLOBAL
                      </button>
                      <div className="hidden sm:block w-[1px] h-6 bg-gray-200 dark:bg-zinc-800 mx-1" />
                      <div className="flex-[2] w-full sm:w-auto">
                        <Autocomplete
                          size="lg"
                          placeholder="FILTRAR POR PROVEEDOR..."
                          selectedKey={selectedSupplier === "global" ? "none" : selectedSupplier}
                          onSelectionChange={handleSupplierChange}
                          items={suppliers}
                          popoverProps={{
                            classNames: {
                              content: "bg-[#18181b] border border-zinc-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-1 rounded-2xl"
                            }
                          }}
                          listboxProps={{
                            itemClasses: {
                              base: "data-[hover=true]:bg-white/5 data-[hover=true]:text-zinc-300 text-[11px] uppercase font-bold",
                            }
                          }}
                          inputProps={{
                            classNames: {
                              inputWrapper: "bg-transparent border-none shadow-none h-12 hover:bg-transparent",
                              input: "text-[12px] font-medium uppercase tracking-tight tracking-tighter"
                            }
                          }}
                        >
                          {(s) => (
                            <AutocompleteItem key={String(s.id)} textValue={s.name}>
                              <div className="flex items-center gap-3 py-1">
                                <div className="h-8 w-8 rounded-2xl bg-white/5 flex items-center justify-center text-zinc-900 dark:text-zinc-100">
                                  <Building2 size={16} />
                                </div>
                                <span className="text-[12px] font-medium uppercase tracking-tight">{s.name}</span>
                              </div>
                            </AutocompleteItem>
                          )}
                        </Autocomplete>
                      </div>
                    </div>
                  </div>
                </div>

                {/* PIE DE PÁGINA (HORIZONTAL) - AHORA AL FINAL DE TODO */}
                <div className="shrink-0 bg-white dark:bg-zinc-950 border-t border-gray-200 dark:border-white/10 p-3 md:p-4 flex flex-col sm:flex-row items-center justify-center sm:justify-between gap-3">
                  <div className="flex flex-col gap-0.5 items-center sm:items-start">
                    <p className="text-[9px] md:text-[11px] text-zinc-900 dark:text-zinc-50 uppercase tracking-widest font-medium tracking-tight leading-none text-center sm:text-left">
                      Viendo <span className="text-zinc-900 dark:text-zinc-100">{totalItemsCount === 0 ? 0 : (page - 1) * pageSize + 1}-{Math.min(page * pageSize, totalItemsCount)}</span> de {totalItemsCount}
                    </p>
                    <span className="text-[8px] font-medium text-zinc-900 dark:text-zinc-100/60 uppercase tracking-widest tracking-tight leading-none">Pág {page} de {totalPagesCount}</span>
                  </div>

                  <div className="flex flex-col sm:flex-row items-center gap-3 md:gap-6">
                    <Pagination
                      key={totalPagesCount}
                      showControls
                      total={totalPagesCount}
                      page={page}
                      onChange={setPage}
                      color="success"
                      variant="flat"
                      size="sm"
                      siblings={0}
                      boundaries={1}
                      classNames={{
                        wrapper: "gap-1",
                        item: "w-7 h-7 min-w-0 text-[10px] font-bold",
                        prev: "w-7 h-7 min-w-0",
                        next: "w-7 h-7 min-w-0",
                        cursor: "bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 font-medium"
                      }}
                    />

                    <div className="flex items-center gap-2">
                      <span className="text-[8px] font-medium text-gray-400 uppercase tracking-widest tracking-tight">Ver:</span>
                      <div className="relative">
                        <select
                          value={pageSize}
                          onChange={(e) => {
                            setPageSize(Number(e.target.value));
                            setPage(1);
                          }}
                          className="h-7 card-base border-none text-zinc-900 dark:text-zinc-50 text-[9px] font-medium uppercase tracking-widest px-2 pr-6 outline-none rounded-2xl border border-gray-200 dark:border-white/10 cursor-pointer shadow-[0_8px_30px_rgb(0,0,0,0.12)] appearance-none hover:border-emerald-500/50 transition-all"
                        >
                          <option value={25}>25</option>
                          <option value={50}>50</option>
                          <option value={100}>100</option>
                          <option value={10000}>TODOS</option>
                        </select>
                        <div className="absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none opacity-30">
                          <ChevronDown size={10} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>
          </div>
        </div>
      </div>

      <SupplierFormModal
        isOpen={isSupplierModalOpen}
        onOpenChange={setIsSupplierModalOpen}
        supplier={null}
        isEdit={false}
        onSave={handleSaveSupplier}
      />
    </div>
  );
}
