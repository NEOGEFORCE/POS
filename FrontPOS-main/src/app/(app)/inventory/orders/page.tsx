"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { 
  Button, Card, CardBody, Autocomplete, AutocompleteItem, Table, TableHeader, 
  TableColumn, TableBody, TableRow, TableCell, Input, Chip, Select, SelectItem,
  Divider, Skeleton
} from "@heroui/react";
import { 
  ShoppingBag, Truck, Calendar, DollarSign, Plus, FileText, 
  Trash2, ChevronRight, Sparkles, Filter, CheckCircle2, AlertCircle, Send, Building2,
  PackageSearch, Clock, User, CheckCircle
} from 'lucide-react';
import Cookies from 'js-cookie';
import { Supplier } from '@/lib/definitions';
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";
import SupplierFormModal from "@/app/(app)/suppliers/components/SupplierFormModal";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '';

function authHeaders(json = false): HeadersInit {
  let token = Cookies.get('org-pos-token');
  // BLINDAJE DEFENSIVO: Limpiar token si tiene Bearer duplicado
  if (token) {
    token = token.replace(/^Bearer\s+/i, '').trim();
  }
  // CRITICAL FIX: Debug del token
  if (!token) {
    console.error("🔥 AUTH ERROR: No se encontró la cookie 'org-pos-token'. El usuario debe iniciar sesión.");
  }
  const h: Record<string, string> = {
    Authorization: `Bearer ${token ?? ''}`,
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

interface ExpectedOrder {
  id: number;
  supplierName: string;
  expectedDate: string;
  totalEstimated: number;
  status: 'PENDING' | 'IN_TRANSIT' | 'RECEIVED';
  itemCount: number;
}

export default function SmartOrdersPage() {
  const { toast } = useToast();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplier, setSelectedSupplier] = useState<string>("global");
  const [loading, setLoading] = useState(false);
  const [orderItems, setOrderItems] = useState<any[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [daysCoverage, setDaysCoverage] = useState<number>(7);
  const [selectedMethod, setSelectedMethod] = useState<string>("default");
  const [selectedSupplierData, setSelectedSupplierData] = useState<Supplier | null>(null);

  // Estado para pedidos esperados (Preventa)
  const [expectedOrders, setExpectedOrders] = useState<ExpectedOrder[]>([]);
  const [newPreventa, setNewPreventa] = useState({ 
    supplierId: 0 as number | null, 
    supplierName: '', 
    date: '', 
    total: '' // Valor raw sin formato para envío
  });
  // FASE 2: Estado para display formateado del precio (con separadores de miles)
  const [totalDisplay, setTotalDisplay] = useState('');
  const [isSubmittingPreventa, setIsSubmittingPreventa] = useState(false);
  const [supplierSearchTerm, setSupplierSearchTerm] = useState('');
  const [isNewSupplier, setIsNewSupplier] = useState(false);

  // Estado para reportes de faltantes (caja)
  const [missingItems, setMissingItems] = useState<any[]>([]);
  const [loadingMissingItems, setLoadingMissingItems] = useState(false);

  // FASE 2: Estado para opciones de fechas calculadas
  const [dateOptions, setDateOptions] = useState<Array<{ label: string; value: string }>>([]);
  const [selectedSupplierForDates, setSelectedSupplierForDates] = useState<Supplier | null>(null);
  const [showManualDate, setShowManualDate] = useState(false);

  // FASE 3: Estado para modal de creación rápida de proveedor
  const [isSupplierModalOpen, setIsSupplierModalOpen] = useState(false);

  // Opciones filtradas para el Autocomplete de proveedores
  const filteredSupplierOptions = React.useMemo(() => {
    const filtered = suppliers.filter(s => 
      s.name.toLowerCase().includes(supplierSearchTerm.toLowerCase()) ||
      (s.vendorName && s.vendorName.toLowerCase().includes(supplierSearchTerm.toLowerCase()))
    );
    
    // Agregar opción de crear nuevo si hay texto y no coincide exacto
    const hasExactMatch = suppliers.some(s => 
      s.name.toLowerCase() === supplierSearchTerm.toLowerCase()
    );
    
    if (supplierSearchTerm && !hasExactMatch) {
      return [
        ...filtered,
        { id: '__new__', name: supplierSearchTerm, vendorName: null, isNew: true } as any
      ];
    }
    
    return filtered;
  }, [suppliers, supplierSearchTerm]);

  // Fetch missing items (reportes de faltantes)
  const fetchMissingItems = useCallback(async () => {
    setLoadingMissingItems(true);
    try {
      const res = await fetch(`${apiUrl}/missing-items`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setMissingItems(data || []);
      }
    } catch (error) {
      console.error("Error fetching missing items:", error);
    } finally {
      setLoadingMissingItems(false);
    }
  }, []);

  const fetchSuppliers = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/suppliers/all-suppliers`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      // Validar que la respuesta sea un array
      if (Array.isArray(data)) {
        setSuppliers(data);
      } else if (data && Array.isArray(data.suppliers)) {
        // Si viene envuelto en un objeto { suppliers: [...] }
        setSuppliers(data.suppliers);
      } else {
        setSuppliers([]);
        console.error('Respuesta de proveedores no es un array:', data);
      }
    } catch (error) {
       toast({ title: "Error", description: "Error al cargar proveedores", variant: "destructive" });
       setSuppliers([]);
    }
  }, [toast]);

  // Fetch suppliers on mount y cargar Radar Global por defecto
  useEffect(() => {
    fetchSuppliers();
    fetchMissingItems();
  }, [fetchSuppliers, fetchMissingItems]);

  // Fetch pedidos esperados para hoy
  // BLINDAJE DEFENSIVO: Siempre retornar array vacío si hay error, nunca colapsar
  useEffect(() => {
    const fetchExpectedOrders = async () => {
      try {
        const token = Cookies.get('org-pos-token');
        const res = await fetch(`${apiUrl}/orders/expected-today`, {
          headers: {
            'Authorization': `Bearer ${token}`
          },
        });
        if (res.ok) {
          const data = await res.json();
          // Asegurar que siempre sea un array
          setExpectedOrders(Array.isArray(data) ? data : []);
        } else {
          // BLINDAJE: Si no es ok, setear array vacío silenciosamente
          console.warn('⚠️ Expected orders fetch no-OK, usando array vacío:', res.status);
          setExpectedOrders([]);
        }
      } catch (err) {
        // BLINDAJE DEFENSIVO: Nunca propagar error, siempre retornar array vacío
        console.error('🔥 Error fetching expected orders (silenciado):', err);
        setExpectedOrders([]);
      }
    };
    fetchExpectedOrders();
  }, []);

  // Cargar Radar Global automáticamente cuando los proveedores estén listos
  useEffect(() => {
    if (suppliers.length > 0 && selectedSupplier === "global") {
      loadGlobalSuggestions();
    }
  }, [suppliers, selectedSupplier]);

  // FASE 2: Cobertura automática basada en frecuencia de visita del proveedor
  useEffect(() => {
    if (selectedSupplier && selectedSupplier !== 'none' && selectedSupplier !== 'global') {
      const supplier = suppliers.find(s => String(s.id) === selectedSupplier);
      if (supplier) {
        // Determinar días de visita (usar deliveryDays o visitDays)
        const visitDays = supplier.deliveryDays || supplier.visitDays || [];
        const dayCount = visitDays.length;

        // Lógica de cobertura según frecuencia
        let newCoverage = 7; // Default
        if (dayCount === 1) newCoverage = 7;
        else if (dayCount === 2) newCoverage = 4;
        else if (dayCount >= 3) newCoverage = 3;

        setDaysCoverage(newCoverage);
        setSelectedSupplierData(supplier);
      }
    } else if (selectedSupplier === 'global') {
      // Para Radar Global, usar cobertura por defecto
      setDaysCoverage(7);
    }
  }, [selectedSupplier, suppliers]);

  // FASE 1 Fix: Función para calcular status basado en matemática pura (stock vs min_stock)
  const calculateStatus = (stock: number, minStock: number): 'CRITICAL' | 'WARNING' | 'OPTIMAL' => {
    if (stock < minStock) return 'CRITICAL';
    if (stock === minStock) return 'WARNING';
    return 'OPTIMAL';
  };

  const loadSuggestions = async (supplierId: string) => {
    if (!supplierId || supplierId === "none") return;
    setLoading(true);
    try {
      const res = await fetch(
        `${apiUrl}/inventory/suggested-orders?supplier_id=${encodeURIComponent(supplierId)}`,
        { headers: authHeaders() }
      );
      const data = await res.json();
      // FASE 1 Fix: Calcular status localmente para consistencia entre vistas
      setOrderItems(data.map((item: any) => ({
        ...item,
        quantity: item.totalIdeal || 0,
        unitPrice: item.purchasePrice || 0,
        status: calculateStatus(item.stock, item.minStock)
      })));
    } catch (error) {
      toast({ title: "Error", description: "Error al cargar sugerencias inteligentes", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleSupplierChange = (key: React.Key | null) => {
    const id = String(key ?? "none");
    setSelectedSupplier(id);
    setSelectedMethod("default"); // Resetear método al cambiar proveedor
    
    if (id === "none" || id === "global") {
      if (id === "none") {
        setOrderItems([]);
        setSelectedSupplierData(null);
      } else {
        // Cargar Radar Global
        loadGlobalSuggestions();
        // Limpiar formulario de preventa cuando es Radar Global
        setNewPreventa({ supplierId: 0, supplierName: '', date: '', total: '' });
        setTotalDisplay(''); // FASE 2: Limpiar display formateado
        setSupplierSearchTerm('');
        setIsNewSupplier(false);
      }
      return;
    }
    
    // Buscar datos del proveedor seleccionado
    const supplier = suppliers.find(s => String(s.id) === id);
    setSelectedSupplierData(supplier || null);
    
    loadSuggestions(id);
  };

  const loadGlobalSuggestions = async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `${apiUrl}/inventory/global-restock`,
        { headers: authHeaders() }
      );
      const data = await res.json();
      // FASE 1 Fix: Calcular status localmente para consistencia entre vistas
      setOrderItems(data.map((item: any) => ({
        ...item,
        isOrphan: item.supplierId === 0 || !item.supplierId,
        quantity: item.totalIdeal || 0,
        unitPrice: item.purchasePrice || 0,
        status: calculateStatus(item.stock, item.minStock)
      })));
    } catch (error) {
      toast({ title: "Error", description: "Error al cargar Radar Global", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  // Recalcular sugerencias cuando cambia daysCoverage o método
  const recalculateSuggestions = useCallback(() => {
    if (orderItems.length === 0) return;
    
    // Calcular lead time según método seleccionado
    let leadTimeDays = 0;
    if (selectedMethod !== "default" && selectedSupplierData?.orderMethods) {
      const method = selectedSupplierData.orderMethods.find(m => String(m.id) === selectedMethod);
      if (method) {
        leadTimeDays = method.leadTimeDays;
      }
    }
    
    // FÓRMULA MAESTRA: (Velocidad × (Días Cobertura + Lead Time)) + SafetyStock - Stock Actual
    const totalCoverageDays = daysCoverage + leadTimeDays;
    
    setOrderItems(prev => prev.map(item => {
      const avgDaily = item.avgDailySales || 0;
      const safetyStock = item.safetyStock || 0;
      // FÓRMULA MAESTRA: (Velocidad * (Cobertura + Lead Time)) + SafetyStock - Stock
      const newQty = Math.max(0, Math.ceil((avgDaily * totalCoverageDays) + safetyStock - item.stock));
      return { ...item, quantity: newQty };
    }));
  }, [daysCoverage, orderItems.length, selectedMethod, selectedSupplierData]);

  // Efecto para recalcular cuando cambia daysCoverage o método
  useEffect(() => {
    recalculateSuggestions();
  }, [daysCoverage, selectedMethod, recalculateSuggestions]);

  // FASE 2: Función para calcular próximas fechas de entrega basadas en deliveryDays del proveedor
  const calculateDeliveryDates = (supplier: Supplier) => {
    // Si el proveedor usa APP o no tiene días configurados, dejar opciones abiertas
    if (supplier.restockMethod === 'APP' || (!supplier.deliveryDays || supplier.deliveryDays.length === 0)) {
      setDateOptions([]);
      return;
    }

    const today = new Date();
    const currentDayIndex = today.getDay(); // 0=Domingo, 1=Lunes, ..., 6=Sábado
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const dayNamesShort = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    
    const options: Array<{ label: string; value: string }> = [];
    const addedDates = new Set<string>();

    // Mapear nombres de días a índices
    const deliveryDayIndices = supplier.deliveryDays?.map(day => {
      const dayLower = day.toLowerCase();
      if (dayLower.includes('lun')) return 1;
      if (dayLower.includes('mar')) return 2;
      if (dayLower.includes('mié') || dayLower.includes('mie')) return 3;
      if (dayLower.includes('jue')) return 4;
      if (dayLower.includes('vie')) return 5;
      if (dayLower.includes('sáb') || dayLower.includes('sab')) return 6;
      if (dayLower.includes('dom')) return 0;
      return -1;
    }).filter(d => d !== -1) || [];

    // Buscar próximas 4 fechas de entrega (hasta 30 días en el futuro)
    for (let i = 0; i <= 30; i++) {
      const futureDate = new Date(today);
      futureDate.setDate(today.getDate() + i);
      const futureDayIndex = futureDate.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
      
      if (deliveryDayIndices.includes(futureDayIndex)) {
        const dateStr = futureDate.toISOString().split('T')[0];
        if (!addedDates.has(dateStr)) {
          addedDates.add(dateStr);
          
          // Formatear etiqueta amigable
          let labelPrefix = '';
          if (i === 0) labelPrefix = 'Hoy';
          else if (i === 1) labelPrefix = 'Mañana';
          else labelPrefix = `Próximo ${dayNames[futureDayIndex]}`;
          
          const dayShort = dayNamesShort[futureDayIndex];
          const dayNum = futureDate.getDate();
          const monthShort = futureDate.toLocaleDateString('es-CO', { month: 'short' });
          
          options.push({
            label: `${labelPrefix} (${dayShort} ${dayNum} ${monthShort})`,
            value: dateStr
          });
          
          if (options.length >= 4) break; // Limitar a 4 opciones
        }
      }
    }

    setDateOptions(options);
    // Auto-seleccionar la primera fecha si hay opciones
    if (options.length > 0 && !newPreventa.date) {
      setNewPreventa(prev => ({ ...prev, date: options[0].value }));
    }
  };

  // FASE 1: Sincronizar selector superior con formulario de preventa
  useEffect(() => {
    // Si se seleccionó un proveedor específico (no global ni none), sincronizar con formulario
    if (selectedSupplier && selectedSupplier !== 'none' && selectedSupplier !== 'global') {
      const supplier = suppliers.find(s => String(s.id) === selectedSupplier);
      if (supplier) {
        setNewPreventa(prev => ({
          ...prev,
          supplierId: typeof supplier.id === 'string' ? parseInt(supplier.id) : supplier.id,
          supplierName: supplier.name
        }));
        setSupplierSearchTerm(supplier.name);
        setIsNewSupplier(false);
        // FASE 1: Calcular fechas de entrega para el proveedor seleccionado
        setSelectedSupplierForDates(supplier);
        calculateDeliveryDates(supplier);
      }
    }
  }, [selectedSupplier, suppliers]);

  const totalEstimated = orderItems.reduce((acc, item) => acc + (item.quantity * item.unitPrice), 0);

  const handleSaveOrder = async () => {
    if (selectedSupplier === "none") {
      toast({ title: "Error", description: "Selecciona un proveedor", variant: "destructive" });
      return;
    }
    if (orderItems.length === 0) {
      toast({ title: "Error", description: "No hay productos en la orden", variant: "destructive" });
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetch(`${apiUrl}/inventory/orders`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          supplierId: parseInt(selectedSupplier),
          estimatedCost: totalEstimated,
          status: 'PENDING',
          items: orderItems.map(item => ({
            productBarcode: item.barcode,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            subtotal: item.quantity * item.unitPrice
          }))
        })
      });

      if (res.ok) {
        toast({ title: "Éxito", description: "¡Orden Maestra generada con éxito!" });
      } else {
        toast({ title: "Error", description: "Error al guardar la orden", variant: "destructive" });
      }
    } catch (error) {
      toast({ title: "Error", description: "Error de conexión", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="h-full w-full overflow-y-auto custom-scrollbar pb-32 bg-transparent text-gray-900 dark:text-white transition-all duration-500 relative">
      <div className="flex flex-col gap-6 min-h-max w-full max-w-[1400px] mx-auto p-4 md:p-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* HEADER SECTION */}
      <div className="px-3 pt-1.5 pb-2 flex flex-col gap-3 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50 backdrop-blur-md rounded-2xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-500 h-10 w-10 rounded-xl text-white shadow-lg shadow-emerald-500/20 flex items-center justify-center transform -rotate-3">
              <ShoppingBag size={20} />
            </div>
            <div className="flex flex-col">
              <h1 className="text-[13px] font-black text-gray-900 dark:text-white tracking-tighter uppercase italic leading-none">
                Smart <span className="text-emerald-500">Restock</span>
              </h1>
              <p className="text-[8px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.4em] italic mt-1 flex items-center gap-1">
                <Sparkles size={10} className="text-emerald-500" /> Abastecimiento IA V4.5
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 min-w-0">
            <div className="flex items-center gap-2 bg-gray-100/50 dark:bg-zinc-900/50 rounded-xl px-2 py-1 border border-gray-200/50 dark:border-white/5">
              <span className="text-[9px] font-black uppercase italic text-gray-500 dark:text-zinc-400">COBERTURA</span>
              <Input
                type="number"
                size="sm"
                value={daysCoverage.toString()}
                onValueChange={(v) => setDaysCoverage(Math.max(1, parseInt(v) || 7))}
                classNames={{
                  inputWrapper: "w-14 h-8 bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-lg",
                  input: "text-[10px] font-black text-center text-emerald-600 dark:text-emerald-400"
                }}
                min={1}
                max={90}
              />
              <span className="text-[9px] font-black uppercase italic text-gray-400 dark:text-zinc-500">DÍAS</span>
            </div>
            <div className="flex items-center gap-2">
              {/* Selector de Método de Abastecimiento (solo cuando hay proveedor seleccionado) */}
              {selectedSupplier !== "none" && selectedSupplier !== "global" && selectedSupplierData?.orderMethods && selectedSupplierData.orderMethods.length > 0 && (
                <Select
                  size="sm"
                  aria-label="Seleccionar método de abastecimiento"
                  selectedKeys={[selectedMethod]}
                  onSelectionChange={(keys) => setSelectedMethod(Array.from(keys)[0] as string)}
                  classNames={{
                    trigger: "h-9 w-32 bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-xl",
                    value: "text-[9px] font-black uppercase italic text-emerald-600 dark:text-emerald-400"
                  }}
                >
                  <SelectItem key="default" textValue="Canal por defecto">
                    <span className="text-[10px] font-black uppercase italic">Canal por defecto</span>
                  </SelectItem>
                  {selectedSupplierData.orderMethods.map((method) => (
                    <SelectItem 
                      key={String(method.id)} 
                      textValue={`${method.type === 'ROUTE' ? 'Ruta' : method.platformName} (${method.leadTimeDays}d)`}
                    >
                      <span className="text-[10px] font-black uppercase italic">
                        {method.type === 'ROUTE' ? 'Ruta' : method.platformName} ({method.leadTimeDays}d)
                      </span>
                    </SelectItem>
                  )) as any}
                </Select>
              )}
              
              <div className="w-full max-w-[min(100%,20rem)] translate-y-[1px]">
                <Autocomplete
                  aria-label="Proveedor para pedido sugerido"
                  size="sm"
                  placeholder="PROV..."
                  defaultItems={[{ id: "none", name: "PROVEEDOR" }, { id: "global", name: "🌍 RADAR GLOBAL" }, ...suppliers]}
                  selectedKey={selectedSupplier || "none"}
                  onSelectionChange={(key) => handleSupplierChange(key)}
                  startContent={<Truck size={14} className="text-emerald-500 hidden sm:block" />}
                  inputProps={{
                    classNames: {
                      inputWrapper:
                        "h-10 bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 shadow-inner rounded-xl data-[focused=true]:border-emerald-500 transition-all px-2 sm:px-3 !mask-none",
                      input:
                        "text-[8.5px] md:text-[10px] font-black uppercase italic text-emerald-700 dark:text-emerald-400 !overflow-visible",
                    },
                  }}
                  popoverProps={{
                    classNames: {
                      content:
                        "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-2xl p-1 rounded-xl",
                    },
                  }}
                  listboxProps={{
                    itemClasses: {
                      base: "rounded-lg gap-3 data-[hover=true]:bg-emerald-500 data-[hover=true]:text-white",
                      title: "text-[11px] font-black uppercase italic",
                    },
                  }}
                >
                  {(item) => (
                    <AutocompleteItem key={String(item.id)} textValue={item.name} className="dark:text-white">
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-6 h-6 rounded-lg flex items-center justify-center ${
                            item.id === "none" ? "bg-gray-100 dark:bg-zinc-800" : 
                            item.id === "global" ? "bg-rose-100 dark:bg-rose-900/30" :
                            "bg-emerald-100 dark:bg-emerald-900/30"
                          }`}
                        >
                          {item.id === "none" ? (
                            <span className="text-[10px] text-gray-400">-</span>
                          ) : item.id === "global" ? (
                            <span className="text-[10px]">🌍</span>
                          ) : (
                            <Truck size={12} className="text-emerald-500" />
                          )}
                        </div>
                        <span className={`font-bold ${item.id === "global" ? "text-rose-500" : ""}`}>{item.name}</span>
                      </div>
                    </AutocompleteItem>
                  )}
                </Autocomplete>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* CONTENT SECTION */}
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* COLUMNA IZQUIERDA: Tabla + Faltantes */}
            <div className="col-span-1 lg:col-span-8 flex flex-col gap-3">
            {/* MAIN ORDER TABLE - SOLO LECTURA */}
            <Card className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-sm overflow-hidden">
          <CardBody className="p-0">
              <div className="p-4 border-b border-gray-200 dark:border-white/5 flex items-center justify-between bg-white dark:bg-zinc-950">
                <div className="flex items-center gap-2">
                  <FileText size={16} className="text-emerald-500" />
                  <h3 className="font-black text-zinc-900 dark:text-white uppercase italic tracking-tighter text-sm">Recomendaciones por Ventas</h3>
                </div>
                <Chip size="sm" variant="flat" className="font-black text-[9px] uppercase italic tracking-widest px-3 py-3 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  {orderItems.length} RECOMENDADOS
                </Chip>
              </div>

            <div className="overflow-x-auto w-full">

            <Table 
              aria-label="Order items table - Solo Lectura"
              className="p-4"
              classNames={{
                th: "bg-gray-100 dark:bg-zinc-950/80 h-10 font-black text-xs uppercase tracking-wider border-b border-gray-200 dark:border-white/5 text-gray-500 dark:text-zinc-400",
                td: "py-3 text-sm h-10 border-l-4 border-l-transparent",
                tbody: "divide-y divide-gray-100 dark:divide-white/5",
                tr: "hover:bg-emerald-500/5 hover:border-l-emerald-500 transition-all text-zinc-900 dark:text-white"
              }}
              removeWrapper
            >
              <TableHeader>
                <TableColumn width={360}>PRODUCTO / BARCODE</TableColumn>
                <TableColumn width={100}>STOCK</TableColumn>
                <TableColumn width={120}>FALTANTE MÍNIMO</TableColumn>
                <TableColumn width={120}>PROYECCIÓN VENTAS</TableColumn>
              </TableHeader>
              <TableBody emptyContent={loading ? <Skeleton className="h-32 w-full rounded-3xl" /> : "No hay productos en estado crítico o bajo stock"}>
                {orderItems.map((item) => (
                  <TableRow key={item.barcode}>
                    <TableCell>
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span className="font-black text-zinc-900 dark:text-white uppercase italic truncate max-w-[300px] text-xs">{item.productName}</span>
                          {item.isOrphan && (
                            <Chip 
                              size="sm" 
                              variant="flat"
                              className="text-[8px] font-black uppercase italic px-2 h-5 bg-rose-100 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-500/20"
                            >
                              SIN PROVEEDOR
                            </Chip>
                          )}
                        </div>
                        <span className="text-[10px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest">{item.barcode}</span>
                        <span className="text-[8px] text-gray-500 dark:text-zinc-500/80 font-black uppercase tracking-wider">
                          Venta: {Math.round(item.avgDailySales || 0)}/día
                          {item.isPack && item.packMultiplier > 1 && (
                            <span className="text-blue-600 dark:text-blue-400/80 ml-1">
                              | 📦 Pacas: {item.packMultiplier} und
                            </span>
                          )}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Chip 
                          size="sm" 
                          variant="flat"
                          className={`font-black text-[10px] border ${
                            item.status === 'CRITICAL' 
                              ? 'bg-rose-100 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-500/20' 
                              : item.status === 'WARNING' 
                                ? 'bg-amber-100 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-500/20'
                                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          }`}
                        >
                          {item.stock} und
                        </Chip>
                        <span className="text-[10px] text-zinc-500 italic">mín: {item.minStock}</span>
                      </div>
                    </TableCell>
                    {/* FASE 1: FALTANTE MÍNIMO - Cálculo estricto: max(0, min_stock - stock) */}
                    <TableCell>
                      {(() => {
                        const missingMin = Math.max(0, (item.minStock || 0) - item.stock);
                        return missingMin > 0 ? (
                          <div className="flex flex-col">
                            <span className="text-lg font-black text-rose-500">
                              {missingMin} UND
                            </span>
                            <span className="text-[9px] text-rose-400/70 font-medium uppercase tracking-wider">
                              Requerido
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-emerald-500/60">
                            <CheckCircle size={18} />
                            <span className="text-sm text-zinc-500">—</span>
                          </div>
                        );
                      })()}
                    </TableCell>
                    {/* FASE 1: PROYECCIÓN VENTAS - Sugerencia adicional de la IA */}
                    <TableCell>
                      {(() => {
                        const missingMin = Math.round(Math.max(0, (item.minStock || 0) - item.stock));
                        // La proyección de ventas es la cantidad sugerida ADICIONAL después del mínimo
                        const salesProjection = Math.round(Math.max(0, item.quantity - missingMin));
                        return salesProjection > 0 ? (
                          <div className="flex flex-col">
                            <span className="text-lg font-black text-emerald-500">
                              +{salesProjection} UND
                            </span>
                            <span className="text-[9px] text-emerald-400/70 font-medium uppercase tracking-wider">
                              Sugerido
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-zinc-600">
                            <span className="text-sm">—</span>
                          </div>
                        );
                      })()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          </CardBody>
        </Card>

        {/* 📦 REPORTES DE CAJA (FALTANTES) - En la columna izquierda */}
        <Card className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-lg overflow-hidden">
          <CardBody className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 bg-rose-500/20 text-rose-500 dark:text-rose-400 flex items-center justify-center rounded-xl shadow-lg shadow-rose-500/20">
                  <PackageSearch size={18} />
                </div>
                <div>
                  <h3 className="text-xs font-black text-zinc-900 dark:text-white uppercase italic tracking-tighter leading-none">
                    📦 Reportes de <span className="text-rose-500">Caja</span>
                  </h3>
                  <p className="text-[9px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest mt-0.5 leading-none">
                    Faltantes reportados
                  </p>
                </div>
              </div>
              <Chip 
                variant="flat" 
                color="danger" 
                className="h-5 font-black text-[8px] uppercase tracking-wider px-2 border-none bg-rose-100 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400"
              >
                {missingItems?.length || 0} PENDIENTES
              </Chip>
            </div>

            {loadingMissingItems ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full rounded-lg" />
                <Skeleton className="h-8 w-full rounded-lg" />
              </div>
            ) : missingItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-4 text-center">
                <div className="h-10 w-10 bg-emerald-500/10 rounded-full flex items-center justify-center mb-2">
                  <CheckCircle size={20} className="text-emerald-500" />
                </div>
                <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">
                  Todo bajo control
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-white/5">
                <table className="w-full">
                  <thead className="bg-gray-100 dark:bg-zinc-900/80">
                    <tr>
                      <th className="px-3 py-2 text-left text-[8px] font-black text-zinc-400 uppercase tracking-wider">
                        Producto
                      </th>
                      <th className="px-3 py-2 text-left text-[8px] font-black text-zinc-400 uppercase tracking-wider">
                        Estado
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                    {missingItems.slice(0, 4).map((item) => (
                      <tr 
                        key={item.id} 
                        className="hover:bg-rose-500/5 transition-colors group border-l-4 border-transparent hover:border-rose-500"
                      >
                        <td className="px-3 py-2">
                          <span className="font-black text-xs text-zinc-900 dark:text-white uppercase italic truncate block max-w-[120px]">
                            {item.product_name}
                          </span>
                          <span className="text-[8px] text-gray-500 dark:text-zinc-500">
                            {item.reporter?.name || "Cajero"} • {new Date(item.created_at).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' })}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <Chip 
                            size="sm" 
                            variant="flat"
                            className={`text-[8px] font-black uppercase px-2 h-5 ${
                              item.status === 'PENDING' 
                                ? 'bg-amber-100 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-500/20' 
                                : item.status === 'COMPLETED'
                                ? 'bg-emerald-100 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20'
                                : 'bg-gray-100 dark:bg-zinc-500/10 text-gray-600 dark:text-zinc-400 border border-gray-200 dark:border-zinc-500/20'
                            }`}
                          >
                            {item.status === 'PENDING' ? 'PENDIENTE' : item.status === 'COMPLETED' ? 'RESUELTO' : item.status}
                          </Chip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {missingItems.length > 4 && (
                  <div className="px-3 py-1.5 bg-gray-50 dark:bg-zinc-900/50 border-t border-gray-100 dark:border-white/5 text-center">
                    <span className="text-[8px] text-gray-500 dark:text-zinc-500">
                      +{missingItems.length - 4} más...
                    </span>
                  </div>
                )}
              </div>
            )}
          </CardBody>
        </Card>
      </div> {/* FIN COLUMNA IZQUIERDA */}

      {/* COLUMNA DERECHA: Registrar Pedido Esperado */}
      <div className="col-span-1 lg:col-span-4">
          <Card className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-lg overflow-hidden">
            <CardBody className="p-5">
              <div className="flex items-center gap-2 mb-4">
                <div className="h-8 w-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
                  <Calendar size={16} className="text-amber-500" />
                </div>
                <h3 className="font-black text-zinc-900 dark:text-white uppercase italic tracking-tight text-xs">Registrar Pedido Esperado</h3>
              </div>
                
                <div className="space-y-3">
                  <div>
                    <label className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">
                      <Building2 size={9} className="inline mr-1" /> Proveedor
                    </label>
                    <div className="flex gap-2">
                      <Autocomplete
                        aria-label="Seleccionar o crear proveedor"
                        placeholder="Buscar proveedor..."
                        className="flex-1"
                      size="sm"
                      allowsCustomValue
                      items={filteredSupplierOptions}
                      inputValue={supplierSearchTerm}
                      onInputChange={(value) => {
                        setSupplierSearchTerm(value);
                        setNewPreventa(prev => ({ ...prev, supplierName: value }));
                        setIsNewSupplier(true);
                      }}
                      onSelectionChange={(key) => {
                        if (key) {
                          if (key === "__new__") {
                            // Opción de crear nuevo
                            setNewPreventa({ 
                              supplierId: 0, 
                              supplierName: supplierSearchTerm, 
                              date: '', 
                              total: newPreventa.total 
                            });
                            setIsNewSupplier(true);
                            setDateOptions([]); // Limpiar opciones de fechas
                            setSelectedSupplierForDates(null);
                          } else {
                            const selected = suppliers.find(s => String(s.id) === String(key));
                            if (selected) {
                              setNewPreventa({ 
                                supplierId: typeof selected.id === 'string' ? parseInt(selected.id) : selected.id, 
                                supplierName: selected.name, 
                                date: '', 
                                total: newPreventa.total 
                              });
                              setSupplierSearchTerm(selected.name);
                              setIsNewSupplier(false);
                              // FASE 2: Calcular fechas de entrega para el proveedor seleccionado
                              setSelectedSupplierForDates(selected);
                              calculateDeliveryDates(selected);
                            }
                          }
                        }
                      }}
                      classNames={{
                        base: "w-full",
                      }}
                      inputProps={{
                        classNames: {
                          inputWrapper: "h-9 bg-gray-100 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-lg data-[focused=true]:border-emerald-500",
                          input: "text-xs text-zinc-900 dark:text-white",
                        }
                      }}
                      popoverProps={{
                        classNames: {
                          content: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-2xl p-1 rounded-xl",
                        }
                      }}
                      listboxProps={{
                        itemClasses: {
                          base: "rounded-lg data-[hover=true]:bg-emerald-500/10 data-[hover=true]:text-emerald-500 text-zinc-900 dark:text-white",
                          title: "text-xs font-black uppercase italic",
                        }
                      }}
                    >
                      {(item: any) => {
                        const isNew = item.id === "__new__";
                        return (
                          <AutocompleteItem
                            key={String(item.id)}
                            textValue={isNew ? `+ Crear nuevo: "${item.name}"` : item.name}
                            className={isNew ? "text-emerald-500" : "text-zinc-900 dark:text-white"}
                          >
                            <div className={`flex items-center gap-2 ${isNew ? "border-t border-white/5 pt-1 mt-1" : ""}`}>
                              <div className={`w-6 h-6 rounded-lg flex items-center justify-center ${isNew ? "bg-emerald-500/20" : "bg-emerald-500/20"}`}>
                                {isNew ? (
                                  <Plus size={12} className="text-emerald-500" />
                                ) : (
                                  <Truck size={12} className="text-emerald-500" />
                                )}
                              </div>
                              <div className="flex flex-col">
                                <span className={`font-black text-xs uppercase italic ${isNew ? "text-emerald-500" : ""}`}>
                                  {isNew ? `+ Crear nuevo proveedor: "${item.name}"` : item.name}
                                </span>
                                {!isNew && item.vendorName && (
                                  <span className="text-[9px] text-zinc-500">{item.vendorName}</span>
                                )}
                              </div>
                            </div>
                          </AutocompleteItem>
                        );
                      }}
                    </Autocomplete>
                    {/* FASE 3: Botón [+] para crear proveedor rápido */}
                    <Button
                      isIconOnly
                      size="sm"
                      variant="flat"
                      onPress={() => setIsSupplierModalOpen(true)}
                      className="h-9 w-9 bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 text-gray-400 dark:text-zinc-400 hover:text-emerald-400 hover:border-emerald-500/50 shrink-0"
                    >
                      <Plus size={16} />
                    </Button>
                  </div>
                  {isNewSupplier && newPreventa.supplierName && (
                    <p className="text-[8px] text-emerald-500/80 mt-1 italic">
                      Se creará nuevo proveedor: {newPreventa.supplierName}
                    </p>
                  )}
                  </div>
                  <div>
                    <label className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">
                      <Calendar size={9} className="inline mr-1" /> Fecha Esperada
                    </label>
                    {/* FASE 2: Select inteligente con fechas calculadas + opción manual */}
                    {dateOptions.length > 0 && !showManualDate ? (
                      <Select
                        size="sm"
                        aria-label="Seleccionar fecha de entrega"
                        placeholder="Seleccionar fecha..."
                        selectedKeys={newPreventa.date ? [newPreventa.date] : []}
                        onSelectionChange={(keys) => {
                          const selectedDate = Array.from(keys)[0] as string;
                          if (selectedDate === '__manual__') {
                            setShowManualDate(true);
                            setNewPreventa(prev => ({ ...prev, date: '' }));
                          } else {
                            setNewPreventa(prev => ({ ...prev, date: selectedDate }));
                          }
                        }}
                        classNames={{
                          trigger: "h-9 bg-gray-100 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-lg data-[focused=true]:border-emerald-500",
                          value: "text-xs text-zinc-900 dark:text-white font-medium",
                          listbox: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-xl",
                          popoverContent: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-xl shadow-2xl",
                        }}
                        listboxProps={{
                          itemClasses: {
                            base: "text-xs text-zinc-900 dark:text-white data-[selected=true]:bg-emerald-500/20 data-[selected=true]:text-emerald-400 hover:bg-gray-100 dark:hover:bg-white/5",
                          }
                        }}
                      >
                        {[...dateOptions, { value: '__manual__', label: 'Otra fecha (Manual)...' }].map((option) => (
                          <SelectItem 
                            key={option.value} 
                            textValue={option.label}
                            className={option.value === '__manual__' ? 'text-zinc-400 italic' : ''}
                          >
                            <span className={`text-xs font-medium ${option.value === '__manual__' ? 'text-zinc-400 italic' : ''}`}>
                              {option.label}
                            </span>
                          </SelectItem>
                        ))}
                      </Select>
                    ) : (
                      <div className="flex gap-2">
                        <Input
                          type="date"
                          value={newPreventa.date}
                          onChange={(e) => setNewPreventa({ ...newPreventa, date: e.target.value })}
                          className="h-9 flex-1"
                          classNames={{
                            inputWrapper: "h-9 bg-gray-100 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-lg",
                            input: "text-xs text-zinc-900 dark:text-white"
                          }}
                        />
                        {dateOptions.length > 0 && (
                          <Button
                            size="sm"
                            variant="flat"
                            onPress={() => {
                              setShowManualDate(false);
                              setNewPreventa(prev => ({ ...prev, date: '' }));
                            }}
                            className="h-9 px-2 bg-gray-200 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white"
                          >
                            ←
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">
                      <DollarSign size={9} className="inline mr-1" /> Total Estimado (COP)
                    </label>
                    <Input
                      type="text"
                      placeholder="0"
                      value={totalDisplay}
                      onChange={(e) => {
                        // FASE 2: Formato de moneda en vivo - extraer solo números
                        const rawValue = e.target.value.replace(/[^0-9]/g, '');
                        // Guardar valor raw para el payload
                        setNewPreventa({ ...newPreventa, total: rawValue });
                        // Formatear con separadores de miles para display
                        if (rawValue) {
                          const numValue = parseInt(rawValue, 10);
                          setTotalDisplay(numValue.toLocaleString('es-CO'));
                        } else {
                          setTotalDisplay('');
                        }
                      }}
                      className="h-9"
                      classNames={{
                        inputWrapper: "h-9 bg-gray-100 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-lg",
                        input: "text-xs text-zinc-900 dark:text-white"
                      }}
                      startContent={<span className="text-gray-400 dark:text-zinc-500 text-xs">$</span>}
                    />
                  </div>
                  <Button
                    onPress={async () => {
                      if (!newPreventa.supplierName || !newPreventa.date) {
                        toast({ title: "Error", description: "Proveedor y fecha son requeridos", variant: "destructive" });
                        return;
                      }
                      setIsSubmittingPreventa(true);
                      try {
                        // FASE 1: Limpieza estricta del payload
                        const cleanTotal = parseFloat(String(newPreventa.total).replace(/\D/g, '')) || 0;
                        const payload = {
                          supplierId: newPreventa.supplierId || 0,
                          supplierName: newPreventa.supplierName.trim(),
                          expectedDate: newPreventa.date, // Ya viene como YYYY-MM-DD
                          totalEstimated: cleanTotal,
                          itemCount: 0
                        };
                        // DEBUG: Ver payload en consola
                        console.log("🚀 Payload enviado:", payload);
                        console.log("📅 Fecha formato:", payload.expectedDate, "¿Es válida ISO?", /^\d{4}-\d{2}-\d{2}$/.test(payload.expectedDate));
                        console.log("💰 Total limpio:", cleanTotal, "¿Es número?", typeof cleanTotal === 'number');

                        const res = await fetch(`${apiUrl}/orders/expected`, {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${Cookies.get('org-pos-token')}`
                          },
                          body: JSON.stringify(payload)
                        });
                        if (res.ok) {
                          toast({ 
                            title: "✅ REGISTRO EXITOSO", 
                            description: "La preventa ha sido sincronizada correctamente.",
                            className: "bg-zinc-900 border border-emerald-500/50 text-white shadow-2xl shadow-emerald-500/10"
                          });
                          setNewPreventa({ supplierId: 0, supplierName: '', date: '', total: '' });
                          setTotalDisplay(''); // FASE 2: Limpiar display formateado
                          setSupplierSearchTerm('');
                          setIsNewSupplier(false);
                          // Refresh list
                          const refreshRes = await fetch(`${apiUrl}/orders/expected-today`, { 
                            headers: {
                              'Authorization': `Bearer ${Cookies.get('org-pos-token')}`
                            } 
                          });
                          if (refreshRes.ok) {
                            const data = await refreshRes.json();
                            setExpectedOrders(data || []);
                          }
                        } else {
                          toast({ title: "Error", description: "No se pudo registrar", variant: "destructive" });
                        }
                      } catch (err) {
                        toast({ title: "Error", description: "Error de conexión", variant: "destructive" });
                      } finally {
                        setIsSubmittingPreventa(false);
                      }
                    }}
                    isDisabled={!newPreventa.supplierName || !newPreventa.date || isSubmittingPreventa}
                    className="w-full h-10 bg-emerald-500 hover:bg-emerald-600 text-white font-black uppercase text-[10px] tracking-wider rounded-xl mt-1"
                    startContent={<Plus size={14} />}
                  >
                    Guardar Preventa
                  </Button>
                </div>
              </CardBody>
            </Card>
        </div> {/* FIN COLUMNA DERECHA */}
      </div> {/* FIN GRID */}
    </div> {/* FIN CONTENT SECTION (579) */}
  </div> {/* FIN INNER WRAPPER (454) */}

    {/* FASE 3: Modal para creación rápida de proveedor */}
    <SupplierFormModal
      isOpen={isSupplierModalOpen}
      onOpenChange={setIsSupplierModalOpen}
      supplier={null}
      isEdit={false}
      onSave={async (savedSupplier: Partial<Supplier>) => {
        // Recargar proveedores
        await fetchSuppliers();
        // Auto-seleccionar el nuevo proveedor en el formulario
        if (savedSupplier && savedSupplier.id) {
          setNewPreventa({
            supplierId: typeof savedSupplier.id === 'string' ? parseInt(savedSupplier.id) : savedSupplier.id,
            supplierName: savedSupplier.name || '',
            date: '',
            total: newPreventa.total
          });
          setSupplierSearchTerm(savedSupplier.name || '');
          setIsNewSupplier(false);
          // Calcular fechas si tiene días configurados
          if (savedSupplier.deliveryDays && savedSupplier.deliveryDays.length > 0) {
            setSelectedSupplierForDates(savedSupplier as Supplier);
            calculateDeliveryDates(savedSupplier as Supplier);
          }
        }
        setIsSupplierModalOpen(false);
      }}
    />
    </div>
  );
}
