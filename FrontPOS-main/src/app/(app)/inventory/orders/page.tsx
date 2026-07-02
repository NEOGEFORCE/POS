"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  ShoppingBag, Truck, Building2, FileText, Calendar, DollarSign, PackageSearch, Check, ChevronDown, CheckCircle, AlertTriangle, Edit2, X, Package, Trash2, Search
} from 'lucide-react';
import {
  Card, CardBody, Button, Input, Autocomplete, AutocompleteItem, Pagination, Skeleton, Badge, Popover, PopoverTrigger, PopoverContent, Tooltip
} from "@heroui/react";
import { useAuth } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import Cookies from 'js-cookie';
import { Supplier } from '@/lib/definitions';
import { formatPrice } from "@/lib/utils";
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

const getFrontendStatus = (item: SuggestedOrder) => {
  const ratio = item.minStock > 0 ? (item.stock / item.minStock) : 0;
  if (item.stock <= 0 || ratio <= 0.25) return 0; // CRITICO
  if (ratio > 0.25 && ratio <= 0.50) return 1; // ADVERTENCIA
  return 2; // OPTIMO
};

const sortOrderItems = (a: SuggestedOrder, b: SuggestedOrder) => {
  const inTransitA = (a.pendingOrderQty || 0) > 0;
  const inTransitB = (b.pendingOrderQty || 0) > 0;
  
  if (inTransitA && !inTransitB) return 1;
  if (!inTransitA && inTransitB) return -1;

  const statusA = getFrontendStatus(a);
  const statusB = getFrontendStatus(b);

  const priorityA = a.isHighRotation ? 0 : statusA;
  const priorityB = b.isHighRotation ? 0 : statusB;

  if (priorityA !== priorityB) return priorityA - priorityB;

  if (a.isHighRotation && !b.isHighRotation) return -1;
  if (!a.isHighRotation && b.isHighRotation) return 1;
  if (statusA !== statusB) return statusA - statusB;
  if (b.suggested !== a.suggested) return (b.suggested || 0) - (a.suggested || 0);
  return (b.avgDailySales || 0) - (a.avgDailySales || 0);
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
  const [radarSearch, setRadarSearch] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [supplierSearch, setSupplierSearch] = useState('');
  
  const filteredSuppliers = useMemo(() => {
    if (!supplierSearch) return suppliers;
    return suppliers.filter(s => s.name.toLowerCase().includes(supplierSearch.toLowerCase()));
  }, [suppliers, supplierSearch]);
  
  const [missingItems, setMissingItems] = useState<MissingItem[]>([]);
  const [loadingMissingItems, setLoadingMissingItems] = useState(true);

  // Form states per supplier
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  // Cargar quantities desde localStorage al montar
  useEffect(() => {
    try {
      const saved = localStorage.getItem('pos_order_quantities');
      if (saved) {
        setQuantities(JSON.parse(saved));
      }
    } catch (e) {
      console.error('Error loading saved order quantities', e);
    }
  }, []);

  // Guardar quantities en localStorage cada vez que cambia
  useEffect(() => {
    try {
      localStorage.setItem('pos_order_quantities', JSON.stringify(quantities));
    } catch (e) {
      console.error('Error saving order quantities', e);
    }
  }, [quantities]);

  const [groupForms, setGroupForms] = useState<Record<string, { date: string, invoiceRef: string }>>({});
  const [submittingGroups, setSubmittingGroups] = useState<Record<string, boolean>>({});

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(1000);

  const [editingMinStock, setEditingMinStock] = useState<string | null>(null);
  const [editMinStockValue, setEditMinStockValue] = useState<string>("");
  const [savingMinStock, setSavingMinStock] = useState<string | null>(null);

  const [supplierProducts, setSupplierProducts] = useState<any[]>([]);
  const [productSearch, setProductSearch] = useState('');

  useEffect(() => {      
    if (selectedSupplier !== "global" && selectedSupplier) {
      fetch(`${apiUrl}/inventory/suggested-orders?supplier_id=${selectedSupplier}&all=true`, { headers: authHeaders() })
        .then(res => res.json())
        .then(data => {
          setSupplierProducts(data || []);
        })
        .catch(err => console.error(err));
    } else {
      setSupplierProducts([]);
    }
    setProductSearch('');
  }, [selectedSupplier, apiUrl, authHeaders]);

  const handleAddManualProduct = (product: any) => {
    if (!orderItems.some(item => item.barcode === product.barcode)) {
      const newItem: SuggestedOrder = {
        barcode: product.barcode,
        productName: product.productName || product.product_name || "Desconocido",
        stock: product.stock !== undefined ? product.stock : (product.quantity || 0),
        minStock: product.minStock || product.min_stock || 0,
        avgDailySales: 0,
        suggested: 0,
        purchasePrice: product.purchasePrice || product.purchase_price || 0,
        bestSupplierId: product.bestSupplierId || Number(selectedSupplier),
        bestSupplierName: product.bestSupplierName || suppliers.find(s => s.id.toString() === selectedSupplier)?.name || "Desconocido",
        lowestPrice: product.lowestPrice
      };
      setOrderItems(prev => [newItem, ...prev]);
    }
    
    // Iniciar el input en 0 de todas formas, pero el item ya aparece en la lista
    if (quantities[product.barcode] === undefined) {
      setQuantities(prev => ({ ...prev, [product.barcode]: 0 }));
    }
    setProductSearch('');
  };

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
      const res = await fetch(`${apiUrl}/inventory/restock/suggestions?all=true`, { headers: authHeaders(), cache: 'no-store' });
      if (res.ok) {
        const groups = await res.json();
        // Flatten the categorized data
        let allItems: SuggestedOrder[] = [];
        (groups || []).forEach((g: any) => {
            allItems = [...allItems, ...g.items];
        });
        
        // Remove duplicates by barcode since an item might be in multiple categories
        const uniqueItems = Array.from(new Map(allItems.map(item => [item.barcode, item])).values());
        
        // Filtrar para mostrar SOLO los que no tienen proveedor asignado
        const orphanedItems = uniqueItems.filter(item => !item.bestSupplierId || item.bestSupplierId === 0);
        
        setItems(orphanedItems);
        
        // Do not wipe quantities on reload to preserve user selections
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
      // 1. Traer TODOS los productos vinculados a este proveedor
      const [allRes, restockRes] = await Promise.all([
        fetch(`${apiUrl}/products/all-products?supplier=${supplierId}`, { headers: authHeaders(), cache: 'no-store' }),
        fetch(`${apiUrl}/inventory/restock/suggestions?all=true`, { headers: authHeaders(), cache: 'no-store' })
      ]);

      if (!allRes.ok) {
        console.error("Error fetching supplier products");
        return;
      }

      const allProducts: any[] = await allRes.json();
      const supplierObj = suppliers.find(s => s.id.toString() === supplierId);
      const supplierName = supplierObj?.name || '';

      // 2. Construir mapa de restock data (sugerencias) por barcode
      const restockMap: Record<string, any> = {};
      if (restockRes.ok) {
        const groups = await restockRes.json();
        const group = (groups || []).find((g: any) => g.supplierId.toString() === supplierId);
        if (group) {
          group.items.forEach((item: any) => {
            restockMap[item.barcode] = item;
          });
        }
      }

      // 3. Mapear TODOS los productos a SuggestedOrder, enriquecidos con datos de restock
      let data: SuggestedOrder[] = allProducts.map((p: any) => {
        const restock = restockMap[p.barcode];
        if (restock) {
          return {
            ...restock,
            bestSupplierId: Number(supplierId),
            bestSupplierName: supplierName
          } as SuggestedOrder;
        }
        return {
          barcode: p.barcode,
          productName: p.productName || p.product_name || 'Desconocido',
          stock: p.quantity ?? p.stock ?? 0,
          minStock: p.minStock ?? p.min_stock ?? 0,
          avgDailySales: 0,
          suggested: 0,
          purchasePrice: p.purchasePrice ?? p.purchase_price ?? 0,
          bestSupplierId: Number(supplierId),
          bestSupplierName: supplierName,
          status: (p.quantity ?? 0) <= 0 ? 0 : ((p.quantity ?? 0) <= (p.minStock ?? p.min_stock ?? 0) ? 1 : 2),
        } as SuggestedOrder;
      });

      if (editingOrderData && String(editingOrderData.supplierId) === supplierId) {
        const newQuantities: Record<string, number> = {};
        const mergedData = [...data];

        editingOrderData.items?.forEach((orderItem: any) => {
          const barcode = orderItem.product_id || orderItem.productId;
          newQuantities[barcode] = orderItem.quantity;

          if (!mergedData.some(item => item.barcode === barcode)) {
            mergedData.push({
              barcode: barcode,
              productName: orderItem.product?.product_name || orderItem.product?.productName || 'Producto Desconocido',
              stock: orderItem.product?.quantity || 0,
              minStock: orderItem.product?.min_stock || orderItem.product?.minStock || 0,
              avgDailySales: 0,
              suggested: orderItem.quantity,
              purchasePrice: orderItem.estimated_price || orderItem.estimatedPrice || orderItem.product?.purchase_price || orderItem.product?.purchasePrice || 0,
              bestSupplierId: editingOrderData.supplierId || editingOrderData.supplier_id,
              bestSupplierName: editingOrderData.supplier?.name || ''
            });
          }
        });

        setOrderItems(mergedData);
        setQuantities(prev => ({ ...prev, ...newQuantities }));

        const sName = editingOrderData.supplier?.name || 'Sin Proveedor';
        setGroupForms(prev => ({
          ...prev,
          [sName]: {
            date: editingOrderData.expectedDate ? editingOrderData.expectedDate.split('T')[0] : '',
            invoiceRef: editingOrderData.invoiceRef || ''
          }
        }));
      } else {
        setOrderItems(data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, authHeaders, editingOrderData, suppliers]);

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

  const [productToUnlink, setProductToUnlink] = useState<{barcode: string, supplierId: string} | null>(null);
  const [productToLink, setProductToLink] = useState<{barcode: string, productName: string} | null>(null);
  const [selectedSupplierToLink, setSelectedSupplierToLink] = useState<string>("");
  const handleQtyChange = (barcode: string, val: string | number) => {
    if (typeof val === 'string') {
      // Allow empty, strings ending in dot, etc., while typing
      if (val === '') {
        setQuantities(prev => ({ ...prev, [barcode]: 0 }));
        return;
      }
      if (/^\d*\.?\d*$/.test(val)) {
        setQuantities(prev => ({ ...prev, [barcode]: val as any }));
      }
    } else {
      setQuantities(prev => ({ ...prev, [barcode]: Math.max(0, val) }));
    }
  };

  const handleUnlinkSupplier = (barcode: string, supplierId: string) => {
    setProductToUnlink({ barcode, supplierId });
  };

  const executeUnlinkSupplier = async () => {
    if (!productToUnlink) return;
    const { barcode, supplierId } = productToUnlink;
    try {
      const res = await fetch(`${apiUrl}/inventory/products/${barcode}/unlink-supplier`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ supplierId: parseInt(supplierId) })
      });
      if (res.ok) {
        toast({ title: "Exito", description: "Producto desvinculado del proveedor" });
        setItems(prev => prev.filter(item => item.barcode !== barcode));
        setOrderItems(prev => prev.filter(item => item.barcode !== barcode));
        setSupplierProducts(prev => prev.filter(p => p.barcode !== barcode));
      } else {
        toast({ title: "Error", description: "No se pudo desvincular", variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Error", description: "Fallo de red", variant: "destructive" });
    }
    setProductToUnlink(null);
  };

  const handleLinkSupplier = (barcode: string, productName: string) => {
    setProductToLink({ barcode, productName });
    setSelectedSupplierToLink("");
  };

  const executeLinkSupplier = async () => {
    if (!productToLink || !selectedSupplierToLink) return;
    try {
      const res = await fetch(`${apiUrl}/inventory/products/${productToLink.barcode}/link-supplier`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ supplierId: parseInt(selectedSupplierToLink) })
      });
      if (res.ok) {
        toast({ title: "Exito", description: "Producto vinculado al proveedor" });
        setItems(prev => prev.filter(item => item.barcode !== productToLink.barcode));
        // Recargar si estamos en global
        if (selectedSupplier === "global") {
          loadGlobalSuggestions();
        }
      } else {
        toast({ title: "Error", description: "No se pudo vincular el proveedor", variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Error", description: "Fallo de red", variant: "destructive" });
    }
    setProductToLink(null);
  };

  const handleUpdateMinStock = async (barcode: string) => {
    if (!editMinStockValue) return;
    setSavingMinStock(barcode);
    try {
      const res = await fetch(`${apiUrl}/products/update-min-stock/${barcode}`, {
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
    return [...arr].sort(sortOrderItems);
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

    return Object.values(groups).sort((a, b) => b.items.length - a.items.length);
  }, [paginatedItems, selectedSupplier, suppliers]);

  const filteredGroups = useMemo(() => {
    if (selectedSupplier === "global") {
      if (!radarSearch) return groupedBySupplier;
      const searchLower = radarSearch.toLowerCase();
      return groupedBySupplier.map(g => ({
        ...g,
        items: g.items.filter(item =>
          (item.productName && String(item.productName).toLowerCase().includes(searchLower)) ||
          (item.barcode && String(item.barcode).toLowerCase().includes(searchLower))
        )
      })).filter(g => g.items.length > 0);
    } else {
      return groupedBySupplier.map(g => {
        const searchLower = itemSearch ? itemSearch.toLowerCase() : "";
        
        const filteredSuggested = g.items.filter(item => 
          (!searchLower || (item.productName && String(item.productName).toLowerCase().includes(searchLower)) || 
          (item.barcode && String(item.barcode).toLowerCase().includes(searchLower)))
        );

        // BUSQUEDA EN CATÁLOGO MAESTRO DEL PROVEEDOR
        const matchingFromCatalog = supplierProducts.filter(p => 
          (!searchLower || (String(p.productName || p.product_name || "")).toLowerCase().includes(searchLower) || 
          (String(p.barcode || "")).toLowerCase().includes(searchLower))
        );

        // OPTIMIZACION: Usar un Set para busquedas O(1) y evitar lag al teclear
        const suggestedSet = new Set(filteredSuggested.map(item => item.barcode));

        // Solo agregar los que no estén ya en filteredSuggested
        let missingItems = matchingFromCatalog
          .filter(p => !suggestedSet.has(p.barcode))
          .map(p => {
             const stock = p.quantity || 0;
             const minStock = p.minStock || 0;
             const status = stock <= 0 ? 0 : (stock <= minStock ? 1 : 2);
             
             return {
               barcode: p.barcode,
               productName: p.productName || p.product_name || "Desconocido",
               stock: stock,
               minStock: minStock,
               avgDailySales: 0,
               purchasePrice: p.purchasePrice || p.purchase_price || 0,
               suggested: 0,
               alert: "",
               alertType: "",
               isHighRotation: false,
               bestSupplierId: Number(selectedSupplier),
               bestSupplierName: g.supplierName,
               isFromCatalog: true,
               status: status
             } as SuggestedOrder;
          });

          // Se eliminó la optimización de slice(0, 200) a petición del usuario para ver todo el catálogo del proveedor

        const combinedItems = [...filteredSuggested, ...missingItems].sort(sortOrderItems);

        return {
          ...g,
          items: combinedItems
        };
      });
    }
  }, [groupedBySupplier, radarSearch, selectedSupplier, itemSearch, supplierProducts]);

  // Manejar el submit de un grupo especifico
  const handleConfirmGroup = async (groupName: string, supplierId: number) => {
    const form = groupForms[groupName] || { date: '', invoiceRef: '' };
    
    if (!form.date) {
      toast({ title: "Atencion", description: "Debes seleccionar una Fecha de Entrega.", variant: "destructive" });
      return;
    }

    // Include ALL items for this supplier, not just the paginated ones
    const allSupplierItems = (selectedSupplier === "global" ? items : orderItems).filter(item => {
      const sName = item.bestSupplierName || "Sin Proveedor";
      if (selectedSupplier !== "global") return true; // Single supplier view
      return sName === groupName;
    });

    const itemsToOrder: any[] = [];
    
    // Primero, agregamos todos los sugeridos por la IA que estén en la lista, si tienen cantidad > 0.
    // También procesamos cualquier producto que tenga cantidad > 0 en el objeto quantities.
    Object.entries(quantities).forEach(([barcode, rawQty]) => {
      const qty = parseFloat(rawQty as any) || 0;
      if (qty <= 0) return;
      let unitCost = 0;

      // Buscar en items sugeridos
      const suggestedMatch = allSupplierItems.find(i => i.barcode === barcode);
      if (suggestedMatch) {
        unitCost = suggestedMatch.purchasePrice || 0;
      } else {
        // Si no es un sugerido, debe venir de la búsqueda en el catálogo
        const catalogMatch = supplierProducts.find(p => p.barcode === barcode);
        if (catalogMatch) {
          unitCost = catalogMatch.purchasePrice || catalogMatch.purchase_price || 0;
        } else {
          return; // No se encontró en ningún lado
        }
      }

      itemsToOrder.push({
        product_id: barcode,
        barcode: barcode,
        quantity: qty,
        unit_cost: unitCost
      });
    });

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
          allSupplierItems.forEach(item => {
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
            <p className="text-xs text-gray-500 dark:text-zinc-500 uppercase tracking-widest mt-1">Radar Global y Generacion de Ordenes</p>
          </div>

          <div className="flex items-center gap-2 bg-white dark:bg-zinc-950 p-1.5 rounded-2xl border border-gray-200 dark:border-white/10 shadow-[0_4px_20px_rgb(0,0,0,0.05)] w-full md:w-auto">
            <button
              onClick={() => setSelectedSupplier("global")}
              className={`px-4 py-2 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all h-10 ${selectedSupplier === "global" ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100' : 'text-gray-500 dark:text-zinc-500 hover:bg-gray-100 dark:hover:bg-gray-50 dark:bg-zinc-900'}`}
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
                inputProps={{ classNames: { inputWrapper: "bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-gray-100 dark:bg-zinc-800 border-none shadow-none h-10 rounded-xl transition-colors", input: "text-[11px] font-bold uppercase" } }}
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
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 dark:text-zinc-500">Faltantes en Caja</h3>
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
                ) : <div className="p-2 text-[9px] font-bold text-gray-500 dark:text-zinc-500 uppercase">Sin pendientes</div>}
              </div>
            </CardBody>
          </Card>
        </div>

        {/* CENTRAL AREA: Grouped Suggestions */}
        <div className="flex flex-col h-full gap-4">
            {/* BUSCADOR RADAR */}
            {selectedSupplier === "global" ? (
                <Input 
                    placeholder="BUSCAR PRODUCTO POR NOMBRE O REFERENCIA..."
                      value={radarSearch}
                      onValueChange={setRadarSearch}
                      startContent={<Search size={16} className="text-gray-500 dark:text-zinc-400" />}
                    classNames={{ inputWrapper: "h-12 bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]" }}
                />
            ) : (
                <Input 
                    placeholder="BUSCAR PRODUCTO POR NOMBRE O REFERENCIA..."
                    value={itemSearch}
                    onValueChange={setItemSearch}
                    startContent={<Search size={16} className="text-gray-500 dark:text-zinc-400" />}
                    classNames={{ inputWrapper: "h-12 bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]" }}
                />
            )}

            <Card className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col flex-1">
              <CardBody className="p-0 flex flex-col">
                <div className="p-3 md:p-6 flex flex-col gap-8">
                  
                  {loading ? (
                    <div className="flex justify-center p-10"><Skeleton className="h-8 w-32 rounded-lg" /></div>
                  ) : filteredGroups.length === 0 ? (
                    <div className="flex flex-col justify-center items-center h-full opacity-50 p-10">
                      <CheckCircle size={48} className="text-emerald-500 mb-4" />
                      <p className="text-sm font-bold uppercase tracking-widest">Stock Optimo o Sin Coincidencias</p>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {filteredGroups.map((group) => {
                        const groupTotal = group.items.reduce((acc, item) => acc + (parseFloat(quantities[item.barcode] as any) || 0) * (item.purchasePrice || 0), 0);
                        const form = groupForms[group.supplierName] || { date: '', invoiceRef: '' };
                        const isSubmitting = submittingGroups[group.supplierName] || false;
                        
                        return (
                          <div key={group.supplierName} className="border border-gray-200 dark:border-white/10 rounded-2xl overflow-hidden shadow-sm">
                            <div className="bg-gray-100 dark:bg-zinc-900 p-4 border-b border-gray-200 dark:border-white/10 flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <Building2 className="text-amber-500" size={20} />
                                <h3 className="font-bold text-sm uppercase tracking-tight">{group.supplierName}</h3>
                                <Badge color="default" className="text-[10px] uppercase">{group.items.length} artículos</Badge>
                              </div>
                            </div>
                            
                            <div className="divide-y divide-gray-100 dark:divide-white/5">
                              {group.items.length === 0 ? (
                                <div className="flex flex-col justify-center items-center opacity-70 p-10">
                                  <CheckCircle size={40} className="text-emerald-500 mb-3" />
                                  <p className="text-sm font-bold uppercase tracking-widest text-emerald-600">
                                    {itemSearch ? "Sin Coincidencias en Catalogo" : "Stock Optimo"}
                                  </p>
                                  <p className="text-[10px] text-gray-500 dark:text-zinc-500 mt-2 text-center max-w-xs">
                                    {itemSearch ? "No se encontro ningun producto en el catalogo maestro con ese termino." : "Puedes programar una entrega manualmente asignando la fecha abajo."}
                                  </p>
                                </div>
                              ) : (
                                  group.items.map((item) => {
                                  const ratio = item.minStock > 0 ? (item.stock / item.minStock) : 0;
                                  const isCritical = item.stock <= 0 || ratio <= 0.25;
                                  const isWarning = ratio > 0.25 && ratio <= 0.50;
                                  const isOptimal = ratio > 0.50;
                                  const inTransit = (item.pendingOrderQty || 0) > 0;
                                  const effectiveStock = item.stock + (item.pendingOrderQty || 0);
                                  const coveredByTransit = inTransit && effectiveStock >= item.minStock;
                                  return (
                                    <div key={item.barcode} className={`p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-white dark:bg-zinc-950 transition-colors hover:bg-gray-50/50 dark:hover:bg-zinc-900/50 ${isCritical && !inTransit ? 'border-l-[4px] border-red-500' : ''} ${isWarning && !inTransit ? 'border-l-[4px] border-yellow-500' : ''} ${isOptimal && !inTransit ? 'border-l-[4px] border-green-500' : ''} ${coveredByTransit ? 'border-l-[4px] border-green-500' : (!isCritical && !isWarning && !isOptimal ? 'border-l-[4px] border-transparent' : '')}`}>
                                      <div className="flex-1 min-w-0">
                                        <div className="flex flex-wrap items-center gap-2 mb-1">
                                          <p className="font-medium text-sm w-full md:w-auto">{item.productName}</p>
                                          {isCritical && !inTransit && <span className="h-5 text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400 font-bold uppercase tracking-wider shrink-0">Critico</span>}
                                          {isWarning && !inTransit && <span className="h-5 text-[10px] px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400 font-bold uppercase tracking-wider shrink-0">Advertencia</span>}
                                          {isOptimal && !inTransit && <span className="h-5 text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400 font-bold uppercase tracking-wider shrink-0">Optimo</span>}
                                          {item.isHighRotation && !inTransit && <span className="h-5 text-[10px] px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400 font-bold uppercase tracking-wider shrink-0">Ventas Altas</span>}
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
                                            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl shadow-sm border ${item.alertType === "SLOW_MOVER" ? "bg-amber-100/80 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-500/30" : "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-400 border-indigo-300 dark:border-indigo-500/30"}`}>
                                              <span className="text-[10px] font-bold uppercase tracking-wider whitespace-nowrap">
                                                {item.alert}
                                              </span>
                                            </div>
                                          )}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500 dark:text-zinc-500 uppercase font-medium">
                                          <span>REF: {item.barcode}</span>
                                          <span>Stock: <strong className={item.stock <= 0 ? "text-red-500" : "text-zinc-900 dark:text-zinc-100"}>{item.stock}</strong></span>
                                          {inTransit && <span className="text-amber-600 dark:text-amber-400 font-bold">Proyectado: {effectiveStock} (con transito)</span>}
                                          {editingMinStock === item.barcode ? (
                                            <div className="flex items-center gap-1 bg-white dark:bg-zinc-950 px-2 py-0.5 rounded-md border border-amber-500/50">
                                              <span className="text-[10px]">Stock Base:</span>
                                              <input 
                                                autoFocus
                                                type="number"
                                                className="w-12 text-center bg-transparent border-b border-amber-50 outline-none text-zinc-900 dark:text-white font-bold"
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
                                              <button onClick={() => setEditingMinStock(null)} className="text-gray-500 dark:text-zinc-400 hover:text-zinc-600">
                                                <X size={14} />
                                              </button>
                                            </div>
                                          ) : (
                                            <div className="flex items-center gap-1 group cursor-pointer" onClick={() => { setEditingMinStock(item.barcode); setEditMinStockValue(String(item.minStock || 0)); }}>
                                              <span>Stock Base: <strong className="text-amber-600 dark:text-amber-400">{item.minStock}</strong></span>
                                              <Edit2 size={10} className="text-gray-500 dark:text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                                            </div>
                                          )}
                                          <span>Venta prom.: {Number(item.avgDailySales || 0).toFixed(1)}/dia</span>
                                        </div>
                                        
                                        {(selectedSupplier !== "global" && item.bestSupplierId && item.bestSupplierId.toString() !== selectedSupplier && !item.isFromCatalog && (
                                          <div className="mt-2.5 flex items-start sm:items-center gap-3 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-500/10 dark:to-orange-500/5 border border-amber-200/60 dark:border-amber-500/20 p-2.5 rounded-xl shadow-sm w-full md:w-fit transition-all hover:shadow-md">
                                            <div className="bg-amber-100 dark:bg-amber-500/20 p-1.5 rounded-lg shrink-0 mt-0.5 sm:mt-0">
                                              <AlertTriangle size={15} className="text-amber-600 dark:text-amber-400" />
                                            </div>
                                            <p className="text-[11px] md:text-xs font-medium text-amber-800 dark:text-amber-300/90 m-0 leading-snug">
                                              <span className="font-bold text-amber-900 dark:text-amber-400 mr-1">OFERTA MEJOR:</span> 
                                              Te sugerimos pedir con <span className="font-bold uppercase text-amber-900 dark:text-amber-200 bg-amber-200/50 dark:bg-amber-500/30 px-1.5 py-0.5 rounded-md mx-0.5">{item.bestSupplierName}</span> a <span className="font-bold tracking-tight text-emerald-700 dark:text-emerald-400">{formatPrice(item.lowestPrice || 0)}</span>.
                                            </p>
                                          </div>
                                        ))}
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
                                                  <span className="text-[10px] text-indigo-500 dark:text-indigo-400 font-bold ml-1 tracking-wide">IA Sugiere: {item.suggested || 0}</span>
                                                  <div className="flex items-center gap-1 bg-gray-100 dark:bg-zinc-900 rounded-lg p-1 border border-gray-200 dark:border-white/5 shadow-inner">
                                                  <button 
                                                      onClick={() => handleQtyChange(item.barcode, (quantities[item.barcode] !== undefined ? quantities[item.barcode] : 0) - 1)}
                                                      className="w-7 h-7 flex items-center justify-center text-gray-500 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-gray-100 dark:hover:bg-gray-100 dark:bg-zinc-800 rounded-md transition-all font-bold"
                                                  >
                                                      -
                                                  </button>
                                                  <input 
                                                      type="number" 
                                                      min={0}
                                                      placeholder="0"
                                                      value={quantities[item.barcode] === undefined ? "" : quantities[item.barcode]}
                                                      onChange={(e) => handleQtyChange(item.barcode, e.target.value)}
                                                      className="w-10 text-center text-xs font-bold bg-transparent outline-none"
                                                      style={{ appearance: 'textfield', WebkitAppearance: 'none' }}
                                                  />
                                                  <button 
                                                      onClick={() => handleQtyChange(item.barcode, (quantities[item.barcode] !== undefined ? quantities[item.barcode] : 0) + 1)}
                                                      className="w-7 h-7 flex items-center justify-center text-gray-500 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-gray-100 dark:hover:bg-gray-100 dark:bg-zinc-800 rounded-md transition-all font-bold"
                                                  >
                                                      +
                                                  </button>
                                                  </div>
                                              </div>
                                            </div>
                                          </div>
                                        )}
                                        
                                        {(item.bestSupplierId === 0 || !item.bestSupplierId) ? (
                                          <Tooltip content="Vincular a proveedor" placement="top" color="primary">
                                            <button
                                              onClick={() => handleLinkSupplier(item.barcode, item.productName)}
                                              className="p-2 ml-2 rounded-xl text-gray-400 dark:text-zinc-500 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors border border-transparent hover:border-blue-200 dark:hover:border-blue-500/20"
                                            >
                                              <Building2 size={16} />
                                            </button>
                                          </Tooltip>
                                        ) : (
                                          <Tooltip content="Desvincular producto" placement="top" color="danger">
                                            <button
                                              onClick={() => handleUnlinkSupplier(item.barcode, selectedSupplier === "global" ? String(item.bestSupplierId) : selectedSupplier)}
                                              className="p-2 ml-2 rounded-xl text-gray-400 dark:text-zinc-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors border border-transparent hover:border-red-200 dark:hover:border-red-500/20"
                                            >
                                              <Trash2 size={16} />
                                            </button>
                                          </Tooltip>
                                        )}
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
                                  <label className="text-[9px] font-bold uppercase text-gray-500 dark:text-zinc-500 tracking-widest pl-1">Fecha Entrega</label>
                                  <Popover placement="top">
                                    <PopoverTrigger>
                                      <button className="h-10 w-full md:w-40 bg-white dark:bg-zinc-900 rounded-xl flex items-center px-3 gap-2 hover:bg-zinc-50 dark:hover:bg-gray-100 dark:bg-zinc-800 transition-colors border border-gray-200 dark:border-white/5 shadow-sm text-left">
                                        <Calendar size={14} className="text-gray-500 dark:text-zinc-500 shrink-0" />
                                        <div className="flex flex-col overflow-hidden">
                                          <span className="text-[11px] font-bold text-zinc-900 dark:text-zinc-100 truncate uppercase">
                                            {form.date === new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Bogota'}).format(new Date()) ? "HOY" : form.date}
                                          </span>
                                        </div>
                                      </button>
                                    </PopoverTrigger>
                                    <PopoverContent className="p-3 w-72 bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-2xl">
                                      <div className="flex flex-col gap-3 w-full">
                                        <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest text-center mt-1">Dias de Llegada</p>
                                        <div className="grid grid-cols-3 gap-2">
                                          {getNextDays(6).map(d => (
                                            <button
                                              key={d.date}
                                              onClick={() => setGroupForms(prev => ({ ...prev, [group.supplierName]: { ...form, date: d.date } }))}
                                              className={`flex flex-col items-center justify-center p-2 rounded-xl transition-all border ${form.date === d.date ? 'bg-amber-500 border-amber-500 text-white shadow-md shadow-amber-500/20 scale-105' : 'bg-gray-50 dark:bg-zinc-900 border-gray-200 dark:border-white/5 text-zinc-600 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-gray-100 dark:bg-zinc-800'}`}
                                            >
                                              <span className={`text-[14px] font-black leading-none mb-1 ${form.date === d.date ? 'text-white' : 'text-zinc-900 dark:text-zinc-100'}`}>{d.dayNumber}</span>
                                              <span className="text-[9px] uppercase tracking-widest font-medium">{d.label}</span>
                                            </button>
                                          ))}
                                        </div>
                                        <div className="w-full h-[1px] bg-gray-100 dark:bg-zinc-800 my-2" />
                                        <div className="flex flex-col gap-1 w-full relative">
                                          <label className="text-[9px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest px-1">Otra Fecha</label>
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
                                  <label className="text-[9px] font-bold uppercase text-gray-500 dark:text-zinc-500 tracking-widest pl-1">Ref / Factura Real</label>
                                  <Input
                                    type="text"
                                    size="sm"
                                    placeholder="Opcional..."
                                    value={form.invoiceRef}
                                    onChange={(e) => setGroupForms(prev => ({ ...prev, [group.supplierName]: { ...form, invoiceRef: e.target.value } }))}
                                    startContent={<FileText size={14} className="text-gray-500 dark:text-zinc-500" />}
                                    classNames={{ inputWrapper: "h-10 w-full md:w-40 bg-white dark:bg-zinc-900 border-none" }}
                                  />
                                </div>
                              </div>
                              
                              <div className="flex items-center gap-4 w-full md:w-auto justify-between md:justify-end">
                                <div className="text-right">
                                  <p className="text-[9px] font-bold uppercase text-gray-500 dark:text-zinc-500 tracking-widest">WAC Estimado</p>
                                  <p className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{formatPrice(groupTotal)}</p>
                                </div>
                                <Button
                                  color="warning"
                                  className="h-11 px-6 font-bold uppercase tracking-widest text-[11px] shadow-lg shadow-amber-500/20"
                                  isLoading={isSubmitting}
                                  onPress={() => handleConfirmGroup(group.supplierName, group.supplierId)}
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
      {productToLink && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white dark:bg-zinc-950 p-6 rounded-2xl shadow-2xl max-w-sm w-full mx-4 border border-gray-200 dark:border-white/10 animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 mb-4 text-blue-500">
              <div className="p-3 bg-blue-100 dark:bg-blue-500/20 rounded-full">
                <Building2 size={24} className="text-blue-600 dark:text-blue-400" />
              </div>
              <h3 className="text-lg font-black text-zinc-900 dark:text-zinc-100">Vincular Proveedor</h3>
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 font-medium mb-4">
              Selecciona un proveedor para asignar al producto <strong className="text-zinc-900 dark:text-white uppercase">{productToLink.productName}</strong>.
            </p>
            <div className="mb-6">
              <select 
                value={selectedSupplierToLink}
                onChange={(e) => setSelectedSupplierToLink(e.target.value)}
                className="w-full h-12 bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-xl px-4 outline-none focus:border-blue-500 font-bold uppercase text-sm"
              >
                <option value="">Seleccionar Proveedor...</option>
                {suppliers.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-3 justify-end">
              <button 
                onClick={() => setProductToLink(null)}
                className="px-4 py-2 rounded-xl text-sm font-bold text-zinc-600 dark:text-zinc-400 bg-gray-100 dark:bg-zinc-900 hover:bg-gray-200 dark:hover:bg-zinc-800 transition-colors"
              >
                Cancelar
              </button>
              <button 
                onClick={executeLinkSupplier}
                disabled={!selectedSupplierToLink}
                className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-blue-500 hover:bg-blue-600 shadow-md shadow-blue-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Vincular
              </button>
            </div>
          </div>
        </div>
      )}
      {productToUnlink && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white dark:bg-zinc-950 p-6 rounded-2xl shadow-2xl max-w-sm w-full mx-4 border border-gray-200 dark:border-white/10 animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 mb-4 text-red-500">
              <AlertTriangle size={24} />
              <h3 className="font-bold text-lg text-zinc-900 dark:text-white uppercase tracking-tight">¿Desvincular producto?</h3>
            </div>
            <p className="text-sm text-gray-600 dark:text-zinc-400 mb-6">
              No volvera a aparecer en las sugerencias de este proveedor.
            </p>
            <div className="flex gap-3 justify-end">
              <button 
                onClick={() => setProductToUnlink(null)}
                className="px-4 py-2 rounded-xl text-sm font-bold text-zinc-600 dark:text-zinc-400 bg-gray-100 dark:bg-zinc-900 hover:bg-gray-200 dark:hover:bg-zinc-800 transition-colors"
              >
                Cancelar
              </button>
              <button 
                onClick={executeUnlinkSupplier}
                className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-red-500 hover:bg-red-600 shadow-md shadow-red-500/20 transition-colors"
              >
                Desvincular
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
