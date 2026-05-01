"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ShoppingBag, Truck, Calendar, DollarSign, Plus, FileText,
  Sparkles, CheckCircle, Building2, PackageSearch, Check,
  ChevronLeft, ChevronRight, Info
} from 'lucide-react';
import {
  Card, CardBody, Button, Input, Table, TableHeader,
  TableColumn, TableBody, TableRow, TableCell, Chip,
  Autocomplete, AutocompleteItem, Select, SelectItem,
  Pagination, Skeleton
} from "@heroui/react";
import { useAuth } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import Cookies from 'js-cookie';
import { Supplier } from '@/lib/definitions';
import SupplierFormModal from '../../suppliers/components/SupplierFormModal';



interface SuggestedOrder {
  barcode: string;
  productName: string;
  stock: number;
  minStock: number;
  isPack: boolean;
  packMultiplier: number;
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
  isHighRotation: boolean;
  quantity: number;
}

interface MissingItem {
  id: number;
  product_name: string;
  status: string;
}

export default function SmartRestockPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
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

  // Missing Items
  const [missingItems, setMissingItems] = useState<MissingItem[]>([]);
  const [loadingMissingItems, setLoadingMissingItems] = useState(false);

  // Client-side pagination for the table
  const displayedItems = useMemo(() => {
    const all = selectedSupplier === "global" ? items : orderItems;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    return all.slice(start, end);
  }, [selectedSupplier, items, orderItems, page, pageSize]);

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
        lowestPrice: Number(item.lowestPrice) || 0,
        minStock: Number(item.minStock) || 0,
        supplierId: Number(item.supplierId) || 0,
        isHighRotation: !!item.isHighRotation,
        avgDailySales: Number(item.avgDailySales) || 0,
        isPack: !!item.isPack,
        packMultiplier: Number(item.packMultiplier) || 0,
        projectedSales: Number(item.projectedSales) || 0,
        recentSales: Number(item.recentSales) || 0,
        threshold: Number(item.threshold) || 0
      }));
      setItems(mapped);
    } catch (err) {
      console.error(err);
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
        minStock: Number(item.minStock) || 0,
        supplierId: Number(supplierId),
        isHighRotation: !!item.isHighRotation,
        avgDailySales: Number(item.avgDailySales) || 0,
        isPack: !!item.isPack,
        packMultiplier: Number(item.packMultiplier) || 0,
        projectedSales: Number(item.projectedSales) || 0,
        recentSales: Number(item.recentSales) || 0,
        threshold: Number(item.threshold) || 0
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
    loadGlobalSuggestions();
  }, [page, pageSize]);

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

  const handleSaveOrder = async () => {
    if (!newPreventa.supplierName || !newPreventa.date) {
      toast({
        title: "Proveedor Requerido",
        description: "Debe seleccionar un proveedor para completar esta acción",
        variant: "destructive"
      });
      return;
    }
    setIsSubmittingPreventa(true);
    try {
      const res = await fetch(`${apiUrl}/orders/expected`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          supplierId: newPreventa.supplierId || 0,
          supplierName: newPreventa.supplierName,
          expectedDate: newPreventa.date,
          totalEstimated: parseFloat(newPreventa.total) || 0
        })
      });
      if (res.ok) {
        toast({ title: "Éxito", description: "Preventa guardada" });

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
      }
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
      } else {
        const err = await res.json();
        toast({ title: "Error", description: err.error || "No se pudo crear el proveedor", variant: "destructive" });
      }
    } catch (error) {
      console.error(error);
      toast({ title: "Error", description: "Error de conexión", variant: "destructive" });
    }
  };

  const filteredSupplierOptions = useMemo(() => {
    const filtered = suppliers.filter(s => s.name.toLowerCase().includes(supplierSearchTerm.toLowerCase()));
    return [{ id: '__new__', name: '+ NUEVO PROVEEDOR' }, ...filtered];
  }, [suppliers, supplierSearchTerm]);

  const SmartSourcingAlerts = () => {
    // SPRINT: Analizamos TODO el catálogo cargado para encontrar ahorros reales, 
    // pero limitamos la visualización a los top 15 para no romper el layout.
    const allItems = selectedSupplier === "global" ? items : orderItems;

    // Filtramos los que tienen una mejor opción de precio (Smart Sourcing)
    const savingOpportunities = allItems.filter(item =>
      item.bestSupplierId !== 0 &&
      (selectedSupplier === 'global' ? (item.bestSupplierId !== item.supplierId) : (item.bestSupplierId !== Number(selectedSupplier))) &&
      item.lowestPrice < item.purchasePrice &&
      item.purchasePrice > 0
    );

    if (savingOpportunities.length === 0) return null;

    // Ordenar por mayor ahorro potencial total (opcional, aquí por unidad)
    const topOpportunities = savingOpportunities
      .sort((a, b) => (b.purchasePrice - b.lowestPrice) - (a.purchasePrice - a.lowestPrice))
      .slice(0, 15);

    return (
      <div className="bg-emerald-950/20 border border-emerald-500/50 rounded-lg p-4 mt-4 flex flex-col gap-4 shadow-lg shadow-emerald-500/5 animate-in fade-in slide-in-from-top-2 duration-500">
        <div className="flex items-center gap-2">
          <span className="text-lg">💡</span>
          <h3 className="text-[11px] font-black uppercase tracking-widest text-emerald-400">Oportunidades de Ahorro</h3>
        </div>
        <div className="flex flex-col gap-3 max-h-[400px] overflow-y-auto custom-scrollbar pr-2">
          {topOpportunities.map(item => (
            <div key={item.barcode} className="flex flex-col gap-1.5 border-l-2 border-emerald-500/30 pl-3 py-1 hover:bg-emerald-500/5 transition-colors rounded-r-md">
              <span className="text-[10px] font-black text-emerald-500 uppercase leading-none tracking-tight">
                {item.productName}
              </span>
              <p className="text-[10px] font-medium text-emerald-100/90 leading-tight">
                Cómpralo con <span className="text-emerald-400 font-black uppercase italic underline decoration-emerald-500/30">{item.bestSupplierName}</span> y ahorra <span className="text-emerald-400 font-black">${(item.purchasePrice - item.lowestPrice).toLocaleString()}</span> por unidad.
              </p>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-black overflow-y-auto md:overflow-hidden select-none text-zinc-900 dark:text-zinc-100">

      {/* HEADER SUPERIOR (FIJO) */}
      <div className="p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between bg-white dark:bg-zinc-950 border-b border-gray-200 dark:border-white/10 shadow-sm gap-4 shrink-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-emerald-500 h-10 w-10 rounded-xl flex items-center justify-center text-white shadow-lg shadow-emerald-500/20 transform -rotate-3">
            <ShoppingBag size={20} />
          </div>
          <div>
            <h1 className="text-sm font-black uppercase italic tracking-tighter leading-none">Smart <span className="text-emerald-500">Restock</span></h1>
            <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest mt-0.5">IA y Radar de Abastecimiento</p>
          </div>
        </div>

        <div className="flex items-center gap-2 bg-gray-100 dark:bg-zinc-900 p-1 rounded-2xl border border-gray-200 dark:border-white/5">
          <button
            onClick={() => handleSupplierChange("global")}
            className={`px-4 py-1.5 rounded-xl text-[10px] font-black uppercase transition-all ${selectedSupplier === "global" ? 'bg-white dark:bg-zinc-800 text-emerald-500 shadow-sm' : 'text-zinc-400 hover:text-zinc-600'}`}
          >
            Radar Global
          </button>
          <div className="w-[1px] h-4 bg-gray-200 dark:bg-white/10 mx-1" />
          <div className="min-w-[180px]">
            <Autocomplete
              size="sm"
              placeholder="Elegir Proveedor..."
              className="max-w-xs"
              selectedKey={selectedSupplier === "global" ? "none" : selectedSupplier}
              onSelectionChange={handleSupplierChange}
              popoverProps={{
                classNames: {
                  content: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-xl"
                }
              }}
              inputProps={{
                classNames: {
                  inputWrapper: "bg-transparent border-none shadow-none h-8",
                  input: "text-[10px] font-bold uppercase"
                }
              }}
            >
              {suppliers.map((s) => (
                <AutocompleteItem key={String(s.id)} textValue={s.name}>
                  <div className="flex items-center gap-2">
                    <Building2 size={14} className="text-zinc-400" />
                    <span className="text-[11px] font-bold uppercase">{s.name}</span>
                  </div>
                </AutocompleteItem>
              ))}
            </Autocomplete>
          </div>
        </div>
      </div>

      {/* CONTENIDO PRINCIPAL */}
      <div className="flex-1 p-1 md:p-2 min-h-0 md:overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 h-full min-h-0 md:overflow-hidden">

          {/* COLUMNA IZQUIERDA: RECOMENDACIONES */}
          <div className="lg:col-span-8 flex flex-col min-h-0 flex-1">
            <Card className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-sm overflow-hidden h-full flex flex-col">
              <CardBody className="p-0 flex flex-col flex-1 min-h-0 overflow-hidden">

                {/* ÁREA DE DATOS (SCROLLABLE) */}
                <div className="flex-1 overflow-y-auto overscroll-contain pb-16 custom-scrollbar min-h-0 w-full">
                  {/* TABLA DESKTOP */}
                  <div className="hidden sm:block">
                    <Table
                      isCompact
                      removeWrapper
                      isHeaderSticky
                      aria-label="Recomendaciones"
                      classNames={{
                        base: "w-full",
                        wrapper: "flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar bg-transparent shadow-none p-0 rounded-none",
                        th: "bg-gray-50/90 dark:bg-zinc-950/90 backdrop-blur-md text-gray-400 dark:text-zinc-500 font-black uppercase text-[9px] tracking-widest h-11 py-1 border-b border-gray-200 dark:border-white/5 sticky top-0 z-20 px-4",
                        td: "py-2 border-b border-gray-100 dark:border-white/5 px-4",
                        tr: "hover:bg-emerald-500/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 h-12",
                      }}
                    >
                      <TableHeader>
                        <TableColumn>PRODUCTO</TableColumn>
                        <TableColumn align="center">STOCK ACTUAL</TableColumn>
                        <TableColumn align="center">STOCK REQUERIDO</TableColumn>
                        <TableColumn align="center">PEDIDO OBLIGATORIO</TableColumn>
                        <TableColumn align="center">SUGERIDO ROTACIÓN (IA)</TableColumn>
                      </TableHeader>
                      <TableBody emptyContent={loading ? <Skeleton className="h-32 w-full rounded-2xl" /> : "Sin recomendaciones activas"}>
                        {displayedItems.map((item) => (
                          <TableRow key={item.barcode}>
                            <TableCell>
                              <div className="flex flex-col">
                                <span className="font-bold text-zinc-900 dark:text-white uppercase truncate max-w-[300px] text-[11px] leading-none">{item.productName}</span>
                                <span className="text-[8px] font-mono text-zinc-400 mt-1 tracking-tighter leading-none">{item.barcode}</span>
                              </div>
                            </TableCell>
                            <TableCell align="center">
                              <span className="font-black text-xs tabular-nums">{Number(item.stock)}</span>
                            </TableCell>
                            <TableCell align="center">
                              <span className="font-black text-xs tabular-nums text-zinc-400">
                                {item.minStock}
                              </span>
                            </TableCell>
                            <TableCell align="center">
                              <span className={`font-black text-xs tabular-nums ${item.requiredMin > 0 ? 'text-amber-500' : 'text-zinc-500'}`}>
                                {item.requiredMin > 0 ? `+${item.requiredMin}` : '0'}
                              </span>
                            </TableCell>
                            <TableCell align="center">
                              <div className="flex flex-col items-center leading-none">
                                <span className={`font-black text-sm ${item.projectedSales > item.requiredMin ? 'text-emerald-500' : 'text-zinc-400'}`}>
                                  {item.projectedSales > 0 ? `+${Math.round(item.projectedSales)}` : '0'}
                                </span>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {/* VISTA MÓVIL (CARDS) */}
                  <div className="sm:hidden h-full overflow-y-auto p-2 flex flex-col gap-2 custom-scrollbar">
                    {displayedItems.map((item) => (
                      <div key={item.barcode} className="bg-white dark:bg-zinc-900 border border-gray-100 dark:border-white/5 p-3 rounded-xl shadow-sm flex flex-col gap-3">
                        <div className="flex flex-col">
                          <span className="font-black text-[11px] uppercase truncate text-zinc-800 dark:text-zinc-200 italic leading-none">{item.productName}</span>
                          <span className="text-[8px] font-mono text-zinc-400 mt-1">{item.barcode}</span>
                        </div>

                        <div className="grid grid-cols-2 gap-2 bg-gray-50 dark:bg-black/20 p-2 rounded-lg border border-gray-100 dark:border-white/5">
                          <div className="flex flex-col"><span className="text-[7px] font-black text-zinc-400 uppercase">STOCK</span><span className="text-[11px] font-black">{Number(item.stock)}</span></div>
                          <div className="flex flex-col items-end"><span className="text-[7px] font-black text-zinc-400 uppercase">REQUERIDO</span><span className="text-[11px] font-black">{item.minStock}</span></div>
                        </div>

                        <div className="grid grid-cols-2 gap-2 px-1">
                          <div className="flex flex-col">
                            <span className="text-[7px] font-black text-amber-500 uppercase italic">OBLIGATORIO</span>
                            <span className="text-[11px] font-black text-amber-500">+{item.requiredMin}</span>
                          </div>
                          <div className="flex flex-col items-end">
                            <span className={`text-[7px] font-black uppercase italic ${item.projectedSales > item.requiredMin ? 'text-emerald-500' : 'text-zinc-500'}`}>SUGERIDO IA</span>
                            <span className={`text-[11px] font-black ${item.projectedSales > item.requiredMin ? 'text-emerald-500' : 'text-zinc-500'}`}>+{Math.round(item.projectedSales)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* PIE DE PÁGINA (HORIZONTAL) */}
                <div className="shrink-0 bg-white dark:bg-zinc-950 border-t border-gray-200 dark:border-white/10 p-4 flex flex-wrap items-center justify-center sm:justify-between gap-4 backdrop-blur-md">
                  <div className="flex flex-col gap-1">
                    <p className="text-[11px] text-gray-900 dark:text-white uppercase tracking-widest font-black italic leading-none">
                      MOSTRANDO <span className="text-emerald-500">{totalItemsCount === 0 ? 0 : (page - 1) * pageSize + 1}-{Math.min(page * pageSize, totalItemsCount)}</span> DE {totalItemsCount} <span className="text-[8px] opacity-30 ml-2">({pageSize} por pág.)</span>
                    </p>
                    <span className="text-[9px] font-black text-emerald-500/60 uppercase tracking-widest italic">Página {page} de {totalPagesCount}</span>
                  </div>

                  <div className="flex items-center gap-6">
                    <Pagination
                      key={totalPagesCount}
                      showControls
                      total={totalPagesCount}
                      page={page}
                      onChange={setPage}
                      color="success"
                      variant="flat"
                      size="sm"
                      siblings={1}
                      boundaries={1}
                    />

                    <div className="flex items-center gap-2">
                      <span className="text-[8px] font-black text-gray-400 uppercase tracking-widest italic">Ver:</span>
                      <div className="relative">
                        <select
                          value={pageSize}
                          onChange={(e) => {
                            setPageSize(Number(e.target.value));
                            setPage(1);
                          }}
                          className="h-8 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white text-[10px] font-black uppercase tracking-widest px-3 pr-8 outline-none rounded-xl border border-gray-200 dark:border-white/10 cursor-pointer shadow-sm appearance-none hover:border-emerald-500/50 transition-all"
                        >
                          <option value={25}>25</option>
                          <option value={50}>50</option>
                          <option value={100}>100</option>
                          <option value={10000}>TODOS</option>
                        </select>
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-30">
                          <Info size={12} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>
          </div>

          {/* COLUMNA DERECHA: REGISTRO Y FALTANTES */}
          <div className="lg:col-span-4 flex flex-col gap-4 overflow-y-auto custom-scrollbar flex-1 min-h-0">
            <Card className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-lg relative overflow-hidden shrink-0">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-amber-500 to-amber-600" />
              <CardBody className="p-5 flex flex-col gap-4">
                <div className="flex items-center gap-2">
                  <Calendar size={18} className="text-amber-500" />
                  <h3 className="text-xs font-black uppercase italic tracking-tight">Registrar Preventa</h3>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[9px] font-black uppercase text-zinc-400 tracking-widest pl-1">Proveedor</label>
                    <div className="flex gap-2">
                      <Autocomplete
                        size="sm"
                        placeholder="Buscar..."
                        className="flex-1"
                        selectedKey={newPreventa.supplierId ? String(newPreventa.supplierId) : undefined}
                        inputValue={supplierSearchTerm}
                        onInputChange={setSupplierSearchTerm}
                        items={filteredSupplierOptions}
                        popoverProps={{
                          classNames: {
                            content: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-xl"
                          }
                        }}
                        onSelectionChange={(key) => {
                          if (key === '__new__') {
                            setIsSupplierModalOpen(true);
                            setSupplierSearchTerm("");
                          } else {
                            handleSupplierChange(key);
                          }
                        }}
                        inputProps={{ classNames: { inputWrapper: "bg-gray-100 dark:bg-zinc-900 border-none rounded-xl", input: "text-[10px] font-bold" } }}
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
                    <label className="text-[9px] font-black uppercase text-zinc-400 tracking-widest pl-1">Entrega Estimada</label>
                    {dateOptions.length > 0 ? (
                      <Select
                        size="sm"
                        placeholder="Fecha..."
                        selectedKeys={newPreventa.date ? [newPreventa.date] : []}
                        onSelectionChange={k => {
                          const s = Array.from(k)[0] as string;
                          setNewPreventa(p => ({ ...p, date: s }));
                        }}
                        popoverProps={{
                          classNames: {
                            content: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-xl"
                          }
                        }}
                        classNames={{ trigger: "bg-gray-100 dark:bg-zinc-900 border-none rounded-xl", value: "text-[10px] font-bold uppercase" }}
                      >
                        {dateOptions.map(o => (
                          <SelectItem key={o.value} textValue={o.label}><span className="text-[10px] font-bold uppercase">{o.label}</span></SelectItem>
                        ))}
                      </Select>
                    ) : (
                      <Input
                        type="date"
                        size="sm"
                        value={newPreventa.date}
                        onChange={(e) => setNewPreventa(p => ({ ...p, date: e.target.value }))}
                        classNames={{ inputWrapper: "bg-gray-100 dark:bg-zinc-900 border-none rounded-xl", input: "text-[10px] font-bold uppercase" }}
                      />
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[9px] font-black uppercase text-zinc-400 tracking-widest pl-1">Monto Estimado</label>
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
                      classNames={{ inputWrapper: "bg-gray-100 dark:bg-zinc-900 border-none rounded-xl", input: "text-lg font-black italic text-emerald-500" }}
                      startContent={<DollarSign size={16} className="text-emerald-500" />}
                    />
                  </div>

                  <Button
                    className="w-full bg-emerald-500 text-white font-black uppercase italic tracking-widest py-6 rounded-xl shadow-lg shadow-emerald-500/20 active:scale-95"
                    isLoading={isSubmittingPreventa}
                    onPress={handleSaveOrder}
                    startContent={<CheckCircle size={18} />}
                  >
                    Confirmar Registro
                  </Button>
                </div>
              </CardBody>
            </Card>

            <SmartSourcingAlerts />

            <Card className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-sm overflow-hidden shrink-0">
              <CardBody className="p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <PackageSearch size={16} className="text-rose-500" />
                    <h3 className="text-[10px] font-black uppercase italic text-zinc-500 tracking-wider">Faltantes en Caja</h3>
                  </div>
                </div>
                <div className="flex flex-col gap-2 max-h-[300px] overflow-y-auto custom-scrollbar">
                  {loadingMissingItems ? <Skeleton className="h-10 w-full rounded-lg" /> : missingItems.length > 0 ? (
                    missingItems.map(m => (
                      <div key={m.id} className="flex items-center justify-between p-2.5 bg-rose-500/[0.03] rounded-xl border border-rose-500/10">
                        <div className="flex items-center gap-3 min-w-0">
                          <Button isIconOnly size="sm" variant="flat" onPress={() => handleResolveMissingItem(m.id)} className="h-8 w-8 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 hover:bg-emerald-500 hover:text-white transition-all shadow-sm"><Check size={14} /></Button>
                          <div className="flex flex-col min-w-0">
                            <span className="font-bold uppercase truncate text-[10px]">{m.product_name}</span>
                            <span className="text-[8px] text-zinc-400 uppercase font-bold italic tracking-tighter">Pendiente</span>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : <div className="p-8 text-center text-[9px] font-black text-zinc-400 uppercase italic tracking-widest">Sin pendientes</div>}
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
