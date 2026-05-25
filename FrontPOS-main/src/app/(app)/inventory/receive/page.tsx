
"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Badge, Spinner, Select, SelectItem, Autocomplete, AutocompleteItem, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Switch, Tooltip, Checkbox } from "@heroui/react";
import Link from 'next/link';
import {
    Search, Plus, Camera, Truck, RefreshCw,
    Trash2, Package, ShieldCheck, Gift, ArrowDownLeft, Barcode, Loader2, Zap, TrendingDown, AlertTriangle, Sparkles, ChevronDown, Check, X,
    ShoppingBag, Info, Wallet, Landmark, HandCoins, Building2, History
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Product, Supplier, Category } from '@/lib/definitions';
import { formatCurrency, applyRounding, sanitizeProductPayload, normalizeText } from "@/lib/utils";
import { broadcastRevalidate, setupSyncListener } from '@/lib/revalidate';
import Cookies from 'js-cookie';
import dynamic from 'next/dynamic';
import { useAuth } from '@/lib/auth';
import { apiFetch, ApiError } from '@/lib/api-error';

const ScannerOverlay = dynamic(() => import('@/components/ScannerOverlay').then(m => m.ScannerOverlay), { ssr: false });
const ReceptionRow = dynamic(() => import('./components/ReceptionRow'), { ssr: false });
const SupplierFormModal = dynamic(() => import('../../suppliers/components/SupplierFormModal'), { ssr: false });
const ProductFormModal = dynamic(() => import('../../products/components/ProductFormModal'), { ssr: false });

// Stats Component inline (mismo patrón que ProductStats)
const SPARKLINE_DATA_1 = [{ val: 40 }, { val: 30 }, { val: 45 }, { val: 20 }, { val: 50 }];
const SPARKLINE_DATA_2 = [{ val: 10 }, { val: 25 }, { val: 15 }, { val: 40 }, { val: 35 }];
const SPARKLINE_DATA_3 = [{ val: 50 }, { val: 45 }, { val: 55 }, { val: 60 }, { val: 40 }];
const SPARKLINE_DATA_4 = [{ val: 20 }, { val: 35 }, { val: 25 }, { val: 45 }, { val: 50 }];

import { ResponsiveContainer, AreaChart, Area } from 'recharts';

export interface ReceiveItem {
    lineId: string;
    barcode: string;
    productName: string;
    addedQuantity: number;
    newPurchasePrice: number; // Precio Unitario BASE
    newSalePrice: number;
    marginPercentage: number;
    entryType: 'purchase' | 'gift' | 'return';
    iva: number; // Porcentaje (%)
    icui: number; // Porcentaje (%)
    ibua: number; // Porcentaje (%)
    discount: number;
    currentStock: number;
    unit: 'UND' | 'KG' | 'LB';
    isWeighted: boolean;
    actualPhysicalStock?: number;
}

export default function ReceiveInventoryPage() {
    const router = useRouter();
    const { toast } = useToast();
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [notFoundDialogOpen, setNotFoundDialogOpen] = useState(false);
    const [scannedNotFoundCode, setScannedNotFoundCode] = useState('');

    const [products, setProducts] = useState<Product[]>([]);
    const [suppliers, setSuppliers] = useState<Supplier[]>([]);
    const [selectedGlobalSupplier, setSelectedGlobalSupplier] = useState<string>('');
    const [receiveList, setReceiveList] = useState<ReceiveItem[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [supplierSearchTerm, setSupplierSearchTerm] = useState('');
    const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
    const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
    const [pendingOrders, setPendingOrders] = useState<any[]>([]);
    const [isLoadingOrders, setIsLoadingOrders] = useState(false);
    const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
    const [isAddSupplierOpen, setIsAddSupplierOpen] = useState(false);
    const { user, loading: authLoading } = useAuth();
    const [bypassExpense, setBypassExpense] = useState(false);
    const [mixedPayments, setMixedPayments] = useState<{ [key: string]: number }>({
        'EFECTIVO': 0,
        'FONDO': 0,
        'NEQUI': 0,
        'DAVIPLATA': 0,
        'PRESTAMO': 0
    });
    const [isSyncConfirmOpen, setIsSyncConfirmOpen] = useState(false);
    const [totalWeight, setTotalWeight] = useState<number>(0);
    const [freightCost, setFreightCost] = useState<number>(0);
    
    // ESTADOS PARA CREACIÓN RÁPIDA DE PRODUCTO
    const [isProductModalOpen, setIsProductModalOpen] = useState(false);
    const [categories, setCategories] = useState<Category[]>([]);
    const [apiFieldErrors, setApiFieldErrors] = useState<Record<string, string>>({});
    const [newProduct, setNewProduct] = useState<Omit<Product, 'id'>>({
        barcode: '', productName: '', quantity: '' as any, isWeighted: false,
        purchasePrice: '' as any, salePrice: '' as any, categoryId: 0, marginPercentage: 20,
        minStock: '' as any, packMultiplier: '' as any
    });

    // ESTADOS PARA EL ESCÁNER DE CÁMARA
    const [isScannerOpen, setIsScannerOpen] = useState(false);
    const [scanMode, setScanMode] = useState<'main' | 'alternate' | 'search' | 'baseProduct'>('main');

    const paymentMethods = [
        { id: 'EFECTIVO', label: 'Caja', icon: Wallet },
        { id: 'FONDO', label: 'Fondo', icon: Landmark },
        { id: 'NEQUI', label: 'Nequi', icon: Zap },
        { id: 'DAVIPLATA', label: 'Davi', icon: Zap },
        { id: 'PRESTAMO', label: 'Prest.', icon: HandCoins }
    ];

    // FASE 3: Blindaje de Rol Estricto - Cargando desde Contexto Centralizado
    // FASE 3: Blindaje de Rol Estricto - Cargando desde Contexto Centralizado
    const isAdmin = useMemo(() => {
        const role = (user?.role || user?.Role || '').toLowerCase();
        return ['admin', 'administrador', 'superadmin'].includes(role);
    }, [user]);

    // Si estamos cargando la sesión, asumimos admin temporalmente para no ocultar la UI si el usuario lo es
    const showAdminControls = authLoading || isAdmin;

    // Forzar false si definitivamente no es admin y ya terminó de cargar
    useEffect(() => {
        if (!authLoading && !isAdmin && bypassExpense) setBypassExpense(false);
    }, [authLoading, isAdmin, bypassExpense]);

    // LÓGICA DE RECARGA PARA EDICIÓN (Viene del Historial)
    useEffect(() => {
        const toEdit = localStorage.getItem('reception_to_edit');
        if (toEdit) {
            try {
                const items = JSON.parse(toEdit);
                if (Array.isArray(items) && items.length > 0) {
                    setReceiveList(items);
                    if (items[0].supplierId) {
                        setSelectedGlobalSupplier(String(items[0].supplierId));
                    }
                    toast({ 
                        title: "MODO EDICIÓN", 
                        description: "Se cargaron los productos para corregir la recepción eliminada." 
                    });
                }
            } catch (e) {
                console.error("Error loading reception to edit", e);
            } finally {
                localStorage.removeItem('reception_to_edit');
            }
        }
    }, [toast]);


    const searchRef = useRef<HTMLInputElement>(null);
    const hiddenScannerRef = useRef<HTMLInputElement>(null);
    const [barcodeInput, setBarcodeInput] = useState('');

    const loadData = useCallback(async () => {
        const token = Cookies.get('org-pos-token');
        if (!token) { router.push('/login'); return; }
        try {
            const [pData, sData, catData] = await Promise.all([
                apiFetch<Product[]>('/products/all-products', {}, token),
                apiFetch<Supplier[]>('/suppliers/all-suppliers', {}, token),
                apiFetch<Category[]>('/categories/all-categories', {}, token)
            ]);

            // FILTRAR "SIN PROVEEDOR" PARA QUE NO APAREZCA NUNCA
            const cleanSuppliers = (sData || []).filter((s: any) =>
                s.name && !s.name.toUpperCase().includes('SIN PROVEEDOR')
            );

            const freshProducts = pData || [];
            setProducts(freshProducts);
            setSuppliers(cleanSuppliers);
            setCategories(catData || []);

            // ACTUALIZAR REACTIVAMENTE EL STOCK DE LA LISTA DE RECEPCIÓN LOCAL
            setReceiveList(prevList => {
                if (prevList.length === 0) return prevList;
                return prevList.map(item => {
                    const matchedProduct = freshProducts.find(p => p.barcode === item.barcode);
                    if (matchedProduct) {
                        return {
                            ...item,
                            currentStock: Number(matchedProduct.quantity || 0)
                        };
                    }
                    return item;
                });
            });
        } catch (err: any) {
            console.error(err);
            toast({ variant: 'destructive', title: "ERROR DE CARGA", description: err.message });
        } finally {
            setLoading(false);
        }
    }, [router, toast]);

    const suppliersList = useMemo(() => suppliers, [suppliers]);

    // FILTRO MANUAL BLINDADO (IDÉNTICO A EGRESOS)
    const filteredSuppliers = useMemo(() => {
        if (!suppliers) return [];
        // FILTRAR "SIN PROVEEDOR" POR SEGURIDAD
        const cleanSuppliers = suppliers.filter(s => s.name && !s.name.toUpperCase().includes('SIN PROVEEDOR'));

        const search = (supplierSearchTerm || '').toLowerCase().trim();
        if (!search) return cleanSuppliers;

        // Prioridad 1: Empieza con el nombre (STRICT)
        const startsWithName = cleanSuppliers.filter(s => s.name.toLowerCase().startsWith(search));

        // Prioridad 2: Contiene el nombre pero no empieza con él
        const containsName = cleanSuppliers.filter(s =>
            s.name.toLowerCase().includes(search) && !s.name.toLowerCase().startsWith(search)
        );

        // Prioridad 3: Coincide con el ID/NIT
        const matchesId = cleanSuppliers.filter(s =>
            String(s.id).includes(search) &&
            !startsWithName.some(i => i.id === s.id) &&
            !containsName.some(i => i.id === s.id)
        );

        return [...startsWithName, ...containsName, ...matchesId];
    }, [suppliers, supplierSearchTerm]);

    useEffect(() => {
        loadData();

        // Escuchar actualizaciones de otros paneles (Productos o Proveedores o Stock)
        const cleanup = setupSyncListener(async (event) => {
            if (event === 'PRODUCT_UPDATE' || event === 'STOCK_UPDATE') {
                const token = Cookies.get('org-pos-token');
                if (!token) return;
                try {
                    const freshProducts = await apiFetch<Product[]>('/products/all-products', {}, token);
                    if (freshProducts) {
                        setProducts(freshProducts);
                        setReceiveList(prevList => {
                            if (prevList.length === 0) return prevList;
                            return prevList.map(item => {
                                const matchedProduct = freshProducts.find(p => p.barcode === item.barcode);
                                if (matchedProduct) {
                                    return {
                                        ...item,
                                        currentStock: Number(matchedProduct.quantity || 0),
                                        productName: matchedProduct.productName
                                    };
                                }
                                return item;
                            });
                        });
                    }
                } catch (err) {
                    console.error("Error silently syncing products", err);
                }
            } else if (event === 'SUPPLIER_UPDATE') {
                loadData();
            }
        });
        return cleanup;
    }, [loadData]);

    // Sincronizar el término de búsqueda con el proveedor seleccionado (IDÉNTICO A EGRESOS)
    useEffect(() => {
        if (selectedGlobalSupplier && suppliers.length > 0) {
            const sup = suppliers.find(s => String(s.id) === String(selectedGlobalSupplier));
            if (sup) setSupplierSearchTerm(sup.name);
        }
    }, [selectedGlobalSupplier, suppliers]);

    // --- PESISTENCIA ---
    useEffect(() => {
        const savedList = localStorage.getItem('org-pos-reception-list');
        const savedSupplier = localStorage.getItem('org-pos-reception-supplier');
        if (savedList) {
            try {
                const parsed = JSON.parse(savedList);
                if (Array.isArray(parsed)) {
                    // Limpieza de IDs duplicados o corruptos (Blindaje de Reactividad)
                    const sanitized = parsed.map(item => ({
                        ...item,
                        lineId: Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4)
                    }));
                    setReceiveList(sanitized);
                }
            } catch (e) { console.error("Error loading saved reception list", e); }
        }
        if (savedSupplier && savedSupplier !== 'none') setSelectedGlobalSupplier(savedSupplier);
        else setSelectedGlobalSupplier('');
    }, []);

    useEffect(() => {
        if (receiveList.length > 0) {
            localStorage.setItem('org-pos-reception-list', JSON.stringify(receiveList));
        } else {
            localStorage.removeItem('org-pos-reception-list');
        }
    }, [receiveList]);

    useEffect(() => {
        localStorage.setItem('org-pos-reception-supplier', selectedGlobalSupplier);
    }, [selectedGlobalSupplier]);

    // --- SONIDOS ---
    const playScanSound = (type: 'success' | 'error') => {
        try {
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);

            if (type === 'success') {
                // Tono máximo impacto - Doble pulso rápido
                osc.type = 'sine';
                osc.frequency.setValueAtTime(1000, ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(1500, ctx.currentTime + 0.1);
                gain.gain.setValueAtTime(1.0, ctx.currentTime); // Volumen al máximo
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
                osc.start();
                osc.stop(ctx.currentTime + 0.3);
            } else {
                // Tono de error muy agresivo
                osc.type = 'sawtooth'; // Onda de sierra para más rudeza
                osc.frequency.setValueAtTime(120, ctx.currentTime);
                gain.gain.setValueAtTime(0.8, ctx.currentTime); // Alto volumen
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
                osc.start();
                osc.stop(ctx.currentTime + 0.4);
            }
        } catch (e) {
            console.warn("Audio feedback not supported or blocked", e);
        }
    };

    const filteredProductsSearch = useMemo(() => {
        if (!searchQuery) return [];
        const normSearch = normalizeText(searchQuery);
        return products.filter(p =>
            normalizeText(p.productName).includes(normSearch) ||
            p.barcode.includes(normSearch)
        ).slice(0, 10);
    }, [products, searchQuery]);

    const addFreeItem = useCallback(() => {
        setReceiveList(prev => {
            const newLineId = Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4);
            return [{
                lineId: newLineId,
                barcode: `FREE-ITEM-${Date.now()}`,
                productName: "Ítem Genérico/Libre",
                addedQuantity: 1,
                newPurchasePrice: 0,
                newSalePrice: 0,
                marginPercentage: 0,
                entryType: 'purchase',
                iva: 0,
                icui: 0,
                ibua: 0,
                discount: 0,
                currentStock: 0,
                unit: 'UND',
                isWeighted: false
            }, ...prev];
        });
    }, []);

    const addToReceive = useCallback((product: Product, customQty?: number, customPrice?: number) => {
        setReceiveList(prev => {
            const newLineId = Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4);
            const basePrice = customPrice || Number(product.purchasePrice);
            const iva = Number(product.iva || 0);
            const icui = Number(product.icui || 0);
            const ibua = Number(product.ibua || 0);
            const discount = 0; // El descuento varía semanalmente, se inicia en 0 por defecto
            
            // Neto inicial para calcular margen real (Secuencial: Base * (1+IVA) * (1+ICUI) * (1+IBUA) * (1+DTO))
            const neto = basePrice * (1 + iva/100) * (1 + icui/100) * (1 + ibua/100);
            const salePrice = applyRounding(Number(product.salePrice));
            const margin = neto > 0 ? ((salePrice / neto) - 1) * 100 : 30;

            return [{
                lineId: newLineId,
                barcode: product.barcode,
                productName: product.productName,
                addedQuantity: customQty !== undefined ? customQty : 1,
                newPurchasePrice: basePrice,
                newSalePrice: salePrice,
                marginPercentage: margin,
                entryType: 'purchase',
                iva: iva,
                icui: icui,
                ibua: ibua,
                discount: 0,
                currentStock: Number(product.quantity || 0),
                unit: product.isWeighted ? 'KG' : 'UND',
                isWeighted: Boolean(product.isWeighted)
            }, ...prev];
        });
        setSearchQuery('');
    }, []);


    const fetchPendingOrders = async () => {
        if (!selectedGlobalSupplier) {
            toast({ title: "Error", description: "Selecciona un proveedor primero", variant: "destructive" });
            return;
        }
        setIsLoadingOrders(true);
        setIsOrderModalOpen(true);
        try {
            const token = Cookies.get('org-pos-token');
            const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/inventory/orders?supplier_id=${selectedGlobalSupplier}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setPendingOrders(data);
            }
        } catch (err) {
            console.error(err);
        } finally {
            setIsLoadingOrders(false);
        }
    };

    const handleCreateSupplier = async (data: Partial<Supplier>) => {
        const token = Cookies.get('org-pos-token');
        const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/suppliers/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(data)
        });
        if (res.ok) {
            const created = await res.json();
            setSuppliers(prev => [...prev, created]);
            setSelectedGlobalSupplier(String(created.id));
            setIsAddSupplierOpen(false);

            // Notificar a todo el sistema que hay un nuevo proveedor
            broadcastRevalidate('SUPPLIER_UPDATE');

            toast({ variant: 'success', title: "ÉXITO", description: "PROVEEDOR CREADO Y SELECCIONADO" });
        }
    };

    const handleCreateProduct = async () => {
        const token = Cookies.get('org-pos-token');
        setApiFieldErrors({});
        try {
            const rawData = {
                ...newProduct,
                productName: normalizeText(newProduct.productName),
                barcode: normalizeText(newProduct.barcode),
            };
            const data = sanitizeProductPayload(rawData);

            const createdProduct = await apiFetch<Product>('/products/create-products', {
                method: 'POST', body: JSON.stringify(data), fallbackError: 'FALLO AL CREAR PRODUCTO'
            }, token!);

            toast({ variant: 'success', title: 'ÉXITO', description: 'PRODUCTO CREADO Y AGREGADO A LA LISTA.' });
            
            // Cerrar modal y limpiar
            setIsProductModalOpen(false);
            setNewProduct({ 
                barcode: '', productName: '', quantity: '' as any, isWeighted: false, 
                purchasePrice: '' as any, salePrice: '' as any, categoryId: 0, 
                marginPercentage: 20, minStock: '' as any, packMultiplier: '' as any 
            });

            // 1. Agregar a la lista local de productos para que las búsquedas funcionen
            setProducts(prev => [...prev, createdProduct]);
            
            // 2. AGREGAR AUTOMÁTICAMENTE A LA RECEPCIÓN
            addToReceive(createdProduct);

            broadcastRevalidate('PRODUCT_UPDATE');
        } catch (err: any) {
            if (err instanceof ApiError && err.status === 409) {
                toast({ variant: 'destructive', title: 'PRODUCTO DUPLICADO', description: 'El código ya pertenece a un producto activo.' });
                return;
            }
            if (err instanceof ApiError && err.status === 400 && err.data?.error?.fields) {
                setApiFieldErrors(err.data.error.fields);
                toast({ variant: 'destructive', title: 'ERROR DE VALIDACIÓN', description: 'Revisa los campos marcados en rojo' });
            } else {
                toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO EN OPERACIÓN' });
            }
        }
    };

    // --- SCANNER SIEMPRE ACTIVO HANDLERS ---
    const handleCodeSubmit = useCallback((code: string) => {
        const finalCode = code.trim().toUpperCase();
        if (!finalCode) return;

        const product = products.find(p => p.barcode === finalCode);
        if (product) {
            addToReceive(product);
            toast({ variant: 'success', title: 'AGREGADO', description: product.productName });
            playScanSound('success');
            if (navigator.vibrate) navigator.vibrate(50);
        } else {
            setScannedNotFoundCode(finalCode);
            setNotFoundDialogOpen(true);
            playScanSound('error');
        }
        setBarcodeInput('');
    }, [products, addToReceive, toast]);

    const handleScannerResult = useCallback((code: string) => {
        const b = code.toUpperCase().trim();
        if (scanMode === 'search') {
            setSearchQuery(b);
        } else if (scanMode === 'main') {
            if (isProductModalOpen) {
                setNewProduct(prev => ({ ...prev, barcode: b }));
                setIsScannerOpen(false);
            } else {
                handleCodeSubmit(b);
            }
        } else if (scanMode === 'alternate') {
            if (isProductModalOpen) {
                setNewProduct(prev => ({ 
                    ...prev, 
                    alternateCodes: prev.alternateCodes ? `${prev.alternateCodes}, ${b}` : b 
                }));
            }
            setIsScannerOpen(false);
        } else if (scanMode === 'baseProduct') {
            if (isProductModalOpen) {
                setNewProduct(prev => ({ ...prev, baseProductBarcode: b }));
            }
            setIsScannerOpen(false);
        }
    }, [isProductModalOpen, scanMode, handleCodeSubmit]);

    const loadOrderIntoList = (order: any) => {
        order.orderItems.forEach((item: any) => {
            const p = products.find(prod => prod.barcode === item.productBarcode);
            if (p) {
                addToReceive(p, item.quantity, item.unitPrice);
            }
        });
        setSelectedOrderId(order.id);
        setIsOrderModalOpen(false);
        toast({ title: "Orden Cargada", description: `Se han añadido los productos de la orden #${order.id}` });
    };

    // Función para confirmar borrado de lista
    const handleClearList = useCallback(() => {
        setReceiveList([]);
        localStorage.removeItem('org-pos-reception-list');
        toast({ variant: 'success', title: 'LISTA VACIADA', description: 'Todos los productos han sido eliminados' });
        setIsClearConfirmOpen(false);
    }, [setReceiveList, toast]);

    // Efecto para procesar barcodeInput
    useEffect(() => {
        if (barcodeInput.length >= 5) {
            const timeout = setTimeout(() => {
                handleCodeSubmit(barcodeInput);
            }, 100);
            return () => clearTimeout(timeout);
        }
    }, [barcodeInput, handleCodeSubmit]);

    // Mantener foco en scanner oculto
    useEffect(() => {
        const interval = setInterval(() => {
            if (typeof window === 'undefined') return;
            const target = document.activeElement as HTMLElement;
            const isRealInput = (
                target?.tagName === 'INPUT' ||
                target?.tagName === 'TEXTAREA' ||
                target?.tagName === 'BUTTON' ||
                target?.closest('button') ||
                target?.closest('[role="combobox"]') ||
                target?.closest('[role="listbox"]') ||
                target?.closest('[role="menu"]') ||
                target?.closest('[role="option"]') ||
                target?.closest('[role="dialog"]') ||
                target?.closest('.heroui-select') ||
                target?.closest('[data-slot="input-wrapper"]') ||
                target?.hasAttribute('data-slot')
            ) && !target.classList.contains('scanner-gate');

            // Also check if any autocomplete popover is open
            const hasOpenPopover = document.querySelector('[data-slot="popover"][data-open="true"]') ||
                document.querySelector('.heroui-autocomplete-listbox') ||
                document.querySelector('[role="listbox"]');

            const isModalOpen = isScannerOpen || submitting || isProductModalOpen || isAddSupplierOpen || isSyncConfirmOpen;

            if (!isRealInput && !isModalOpen && !hasOpenPopover && hiddenScannerRef.current) {
                hiddenScannerRef.current.focus();
            }
        }, 2000);
        return () => clearInterval(interval);
    }, [isScannerOpen, submitting]);

    const updateItem = useCallback((lineId: string, updates: Partial<ReceiveItem>) => {
        setReceiveList(prev => prev.map(item => item.lineId === lineId ? { ...item, ...updates } : item));
    }, []);

    const deleteItem = useCallback((lineId: string) => {
        setReceiveList(prev => prev.filter(item => item.lineId !== lineId));
    }, []);

    const sumPayments = Object.values(mixedPayments).reduce((a, b) => a + (Number(b) || 0), 0);
    const expectedTotal = useMemo(() => {
        const total = receiveList.reduce((sum, item) => {
            const basePrice = Number(item.newPurchasePrice);
            const ivaPct = Number(item.iva || 0);
            const icuiPct = Number(item.icui || 0);
            const ibuaPct = Number(item.ibua || 0);
            const discountPct = Number(item.discount || 0);

            const totalUnit = basePrice 
                * (1 + (ivaPct / 100)) 
                * (1 + (icuiPct / 100)) 
                * (1 + (ibuaPct / 100)) 
                * (1 - (discountPct / 100));
            
            const lineTotal = totalUnit * item.addedQuantity;

            if (item.entryType === 'purchase') return sum + lineTotal;
            if (item.entryType === 'return') return sum - lineTotal;
            if (item.entryType === 'gift') return sum;
            return sum;
        }, 0);
        return total + freightCost;
    }, [receiveList, freightCost]);
    
    const isPaymentsValid = Math.abs(sumPayments - expectedTotal) < 1;

    const totalOrderValue = useMemo(() => {
        return receiveList.reduce((sum, item) => {
            const basePrice = Number(item.newPurchasePrice);
            const ivaPct = Number(item.iva || 0);
            const icuiPct = Number(item.icui || 0);
            const ibuaPct = Number(item.ibua || 0);
            const discountPct = Number(item.discount || 0);

            const totalUnit = basePrice 
                * (1 + (ivaPct / 100)) 
                * (1 + (icuiPct / 100)) 
                * (1 + (ibuaPct / 100)) 
                * (1 - (discountPct / 100));
            
            const lineTotal = totalUnit * item.addedQuantity;

            if (item.entryType === 'purchase') return sum + lineTotal;
            if (item.entryType === 'return') return sum - lineTotal;
            if (item.entryType === 'gift') return sum;
            return sum;
        }, 0);
    }, [receiveList]);

    const handleConfirmReceive = async () => {
        console.log("🚀 INICIANDO PROCESO DE SINCRONIZACIÓN...");
        
        if (receiveList.length === 0) {
            console.warn("⚠️ ABORTO: La lista de recepción está vacía.");
            toast({ variant: 'destructive', title: "LISTA VACÍA", description: "No hay productos para sincronizar" });
            return;
        }

        if (!selectedGlobalSupplier) {
            console.warn("⚠️ ABORTO: No se ha seleccionado proveedor.");
            toast({
                variant: 'destructive',
                title: "PROVEEDOR REQUERIDO",
                description: "Debes seleccionar un proveedor antes de sincronizar la carga maestra."
            });
            return;
        }

        setSubmitting(true);
        const token = Cookies.get('org-pos-token');
        try {
            const entries = receiveList.map(item => {
                const basePrice = Number(item.newPurchasePrice);
                const ivaPct = Number(item.iva || 0);
                const icuiPct = Number(item.icui || 0);
                const ibuaPct = Number(item.ibua || 0);
                const discountPct = Number(item.discount || 0);

                // Cálculo Secuencial de montos para trazabilidad
                const priceAfterIVA = basePrice * (1 + (ivaPct / 100));
                const priceAfterICUI = priceAfterIVA * (1 + (icuiPct / 100));
                const priceAfterIBUA = priceAfterICUI * (1 + (ibuaPct / 100));
                const priceAfterDTO = priceAfterIBUA * (1 - (discountPct / 100));

                const unitIvaAmount = priceAfterIVA - basePrice;
                const unitIcuiAmount = priceAfterICUI - priceAfterIVA;
                const unitIbuaAmount = priceAfterIBUA - priceAfterICUI;
                const unitDiscountAmount = priceAfterIBUA - priceAfterDTO;

                // Conversión de Libras a Kilos (LB -> KG): 1 LB = 0.5 KG.
                const quantityModifier = item.unit === 'LB' ? 0.5 : 1;
                const finalQuantity = Number(item.addedQuantity) * quantityModifier;

                return {
                    barcode: item.barcode,
                    addedQuantity: item.entryType === 'return' ? -finalQuantity : finalQuantity,
                    newPurchasePrice: (item.entryType === 'gift') ? 0 : basePrice,
                    newSalePrice: Number(item.newSalePrice),
                    supplierId: selectedGlobalSupplier !== 'none' ? Number(selectedGlobalSupplier) : null,
                    iva: unitIvaAmount,
                    icui: unitIcuiAmount,
                    ibua: unitIbuaAmount,
                    ivaPct: ivaPct,
                    icuiPct: icuiPct,
                    ibuaPct: ibuaPct,
                    discountPct: discountPct,
                    discount: unitDiscountAmount,
                    actualPhysicalStock: (item.actualPhysicalStock !== undefined && item.actualPhysicalStock !== null) ? Number(item.actualPhysicalStock) : null
                };
            });

            const payload = {
                orderId: selectedOrderId,
                entries,
                bypassExpense: bypassExpense,
                paymentSource: JSON.stringify(mixedPayments),
                freightCost: freightCost,
                totalWeight: totalWeight,
                supplierId: selectedGlobalSupplier ? Number(selectedGlobalSupplier) : null
            };

            console.log("🚀 INTENTANDO SINCRONIZAR. PAYLOAD BRUTO:", payload);

            const result = await apiFetch('/products/bulk-receive', {
                method: 'POST',
                body: JSON.stringify(payload),
                fallbackError: 'ERROR AL SINCRONIZAR INVENTARIO'
            }, token);

            console.log("✅ SINCRONIZACIÓN EXITOSA:", result);

            toast({
                variant: 'success',
                title: "OPERACIÓN EXITOSA",
                description: bypassExpense ? "INVENTARIO ACTUALIZADO (SIN EGRESO)" : "INVENTARIO Y EGRESO SINCRONIZADOS"
            });
            localStorage.removeItem('org-pos-reception-list');
            localStorage.removeItem('org-pos-reception-supplier');
            setReceiveList([]);

            // SINCRONIZACIÓN GLOBAL: Notificar que productos y dashboard cambiaron
            broadcastRevalidate('PRODUCT_UPDATE');
            broadcastRevalidate('DASHBOARD_UPDATE');
            if (!bypassExpense) broadcastRevalidate('EXPENSE_UPDATE');

            router.push('/dashboard');
        } catch (err: any) {
            console.error("💥 ERROR CAPTURADO EN CATCH:", err);
            
            // Error details logged to console above (L659)
            const errorRaw = err.data || err.response?.data || err.message || err;

            const errorData = err.data || {};
            const errorMsg = errorData.error?.message || errorData.message || err.message || "Fallo desconocido en el cliente";
            
            toast({ 
                variant: 'destructive', 
                title: "FALLO DE SINCRONIZACIÓN", 
                description: errorMsg.toUpperCase(),
                duration: 15000 
            });
        } finally {
            setSubmitting(false);
        }
    };

    if (loading) {
        return (
            <div className="h-screen flex items-center justify-center bg-gray-100 dark:bg-[#09090b] transition-colors duration-500">
                <Loader2 className="h-10 w-10 animate-spin text-zinc-900 dark:text-zinc-100" />
            </div>
        );
    }

    const totalItems = receiveList.length;
    const totalUnits = receiveList.reduce((sum, item) => sum + (item.addedQuantity || 0), 0);
    const totalDiscountAmount = receiveList.reduce((sum, item) => {
        const base = Number(item.newPurchasePrice) * item.addedQuantity;
        return sum + (base * (Number(item.discount || 0) / 100));
    }, 0);
    const avgMargin = totalItems > 0 ? receiveList.reduce((sum, item) => sum + (item.marginPercentage || 0), 0) / totalItems : 0;

    const stats = [
        { label: "INVERSIÓN", val: `$${formatCurrency(totalOrderValue)}`, color: "#0ea5e9", icon: TrendingDown, desc: "Total orden", data: SPARKLINE_DATA_1 },
        { label: "UNIDADES", val: totalUnits % 1 === 0 ? totalUnits : totalUnits.toFixed(2), color: "#10b981", icon: Package, desc: "Total de carga", data: SPARKLINE_DATA_2 },
        { label: "DESCUENTOS", val: `$${formatCurrency(totalDiscountAmount)}`, color: "#8b5cf6", icon: Zap, desc: "Ahorro total", data: SPARKLINE_DATA_3 },
        { label: "MARGEN", val: `${avgMargin.toFixed(0)}%`, color: "#f43f5e", icon: AlertTriangle, desc: "Ganancia promedio", data: SPARKLINE_DATA_4 }
    ];

    return (
        <div className="flex flex-col w-full max-w-[1600px] mx-auto h-[calc(100vh-70px)] min-h-0 overflow-hidden bg-gray-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50 transition-all duration-500 relative">
            <input
                ref={hiddenScannerRef}
                type="text"
                value={barcodeInput}
                onChange={(e) => setBarcodeInput(e.target.value)}
                inputMode="none"
                className="scanner-gate absolute opacity-0 w-0 h-0 pointer-events-none"
                autoFocus
                aria-label="Scanner input"
            />

            {/* HEADER COMPACTO PREMIUM */}
            <div className="shrink-0 px-4 py-3 flex items-center justify-between card-base border-none border-b border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] z-10">
                <div className="flex items-center gap-3">
                    <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 h-10 w-10 rounded-2xl text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center justify-center transform -rotate-3 transition-transform hover:rotate-0">
                        <Truck size={20} />
                    </div>
                    <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                            <h1 className="text-sm md:text-base font-medium text-zinc-900 dark:text-zinc-50 tracking-tight uppercase tracking-tight leading-none">
                                Carga <span className="text-zinc-900 dark:text-zinc-100">Maestra</span>
                            </h1>
                            <span className="text-[9px] font-medium px-2 py-0.5 rounded-2xl bg-white/5 text-zinc-900 dark:text-zinc-100 border border-emerald-500/20 tracking-tight">V9.0</span>
                        </div>
                        <p className="text-[10px] text-gray-500 dark:text-zinc-400 font-bold uppercase tracking-widest mt-0.5">Sincronización de Inventario</p>
                    </div>
                </div>
                
                <div className="flex items-center gap-2">
                    <Button
                        isIconOnly
                        variant="flat"
                        onPress={() => loadData()}
                        className="h-10 w-10 bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-100 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 hidden md:flex"
                    >
                        <RefreshCw size={16} />
                    </Button>
                    <Link href="/inventory/history">
                        <Button
                            variant="flat"
                            className="h-10 px-4 bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 flex items-center gap-2"
                        >
                            <History size={16} />
                            <span className="font-medium uppercase text-[10px] tracking-tight">Historial</span>
                        </Button>
                    </Link>
                    <Button
                        onPress={() => setIsScannerOpen(true)}
                        className="h-10 px-4 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 flex items-center gap-2 hidden md:flex"
                    >
                        <Barcode size={16} />
                        <span className="font-medium uppercase text-[10px] tracking-tight">Cámara</span>
                    </Button>
                </div>
            </div>

            {/* GRID PRINCIPAL: REORDENADO PARA MOBILE FIRST */}
            <div className="flex-1 overflow-hidden flex flex-col lg:flex-row p-2 md:p-4 gap-3 md:gap-4">
                
                {/* COLUMNA DE CONTROL (IZQUIERDA EN DESKTOP, ARRIBA EN MÓVIL) */}
                <div className="w-full lg:w-[400px] xl:w-[450px] shrink-0 flex flex-col gap-3 md:gap-4 overflow-y-auto lg:overflow-y-auto custom-scrollbar pb-2 lg:pb-0">
                    
                    {/* TARJETA 1: PROVEEDOR Y ACCIÓN (Layout 2 Columnas) */}
                    <div className="card-base border-none rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-2 flex flex-col gap-2">
                        <div className="grid grid-cols-2 gap-2 items-center">
                            {/* COL IZQUIERDA: SELECTOR */}
                            <div className="flex flex-col gap-1">
                                <div className="flex justify-between items-center px-1">
                                    <label className="text-[9px] font-medium text-gray-400 uppercase tracking-widest">Proveedor</label>
                                    <button onClick={() => setIsAddSupplierOpen(true)} className="text-[9px] font-medium text-zinc-900 dark:text-zinc-100 uppercase">+ NUEVO</button>
                                </div>
                                <div className="flex items-center gap-1">
                                    <Autocomplete
                                        size="sm"
                                        placeholder="BUSCAR..."
                                        className="flex-1"
                                        items={filteredSuppliers}
                                        selectedKey={selectedGlobalSupplier || undefined}
                                        inputValue={supplierSearchTerm}
                                        onInputChange={setSupplierSearchTerm}
                                        onSelectionChange={(key) => {
                                            setSelectedGlobalSupplier(key ? String(key) : '');
                                            setSelectedOrderId(null);
                                        }}
                                        classNames={{
                                            listbox: "bg-white dark:bg-zinc-950 p-1",
                                            popoverContent: "bg-white dark:bg-zinc-950 border-2 border-emerald-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-1 rounded-2xl"
                                        }}
                                        inputProps={{
                                            classNames: {
                                                inputWrapper: "h-9 bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-inner focus-within:border-emerald-500 transition-all",
                                                input: "font-medium text-[9px] uppercase"
                                            }
                                        }}
                                    >
                                        {(item) => (
                                            <AutocompleteItem key={String(item.id)} textValue={item.name} className="dark:text-white rounded-2xl data-[hover=true]:bg-white/5">
                                                <div className="flex flex-col py-1">
                                                    <span className="text-[10px] font-medium uppercase">{item.name}</span>
                                                    <span className="text-[8px] font-bold text-zinc-500 uppercase">NIT: {item.id}</span>
                                                </div>
                                            </AutocompleteItem>
                                        )}
                                    </Autocomplete>
                                    <Button
                                        isIconOnly
                                        size="sm"
                                        className={`h-9 w-9 min-w-9 rounded-2xl transition-all ${selectedGlobalSupplier ? 'bg-amber-500 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-amber-500/30' : 'bg-gray-100 dark:bg-zinc-800 text-gray-400'}`}
                                        onPress={fetchPendingOrders}
                                        isDisabled={!selectedGlobalSupplier}
                                    >
                                        <ShoppingBag size={14} />
                                    </Button>
                                </div>
                            </div>

                            {/* COL DERECHA: TOGGLE EGRESO (Más pequeño) */}
                            <div className="flex flex-col gap-1 items-end pr-1">
                                <label className="text-[9px] font-medium text-gray-400 uppercase tracking-widest mr-1">Caja</label>
                                <button
                                    onClick={() => setBypassExpense(!bypassExpense)}
                                    className={`relative w-[90%] h-9 rounded-2xl border-2 transition-all flex items-center px-2 gap-1.5 ${
                                        !bypassExpense 
                                        ? 'bg-white/5 border-emerald-500/40 text-zinc-900 dark:text-zinc-100 dark:text-zinc-300' 
                                        : 'bg-orange-500/10 border-orange-500/40 text-orange-600 dark:text-orange-500'
                                    }`}
                                >
                                    <div className={`w-3.5 h-3.5 rounded-2xl border-2 flex items-center justify-center transition-all ${!bypassExpense ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 border-emerald-500 text-white' : 'bg-white border-orange-500'}`}>
                                        {!bypassExpense && <Check size={8} strokeWidth={5} />}
                                    </div>
                                    <span className="text-[9px] font-medium uppercase tracking-tighter leading-none">
                                        {!bypassExpense ? "EGRESO" : "BYPASS"}
                                    </span>
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* RESUMEN FINANCIERO (Stats Row movido arriba) */}
                    <div className="shrink-0 grid grid-cols-2 lg:grid-cols-2 gap-2">
                        {stats.map((k, i) => (
                            <div key={i} className="relative overflow-hidden card-base border-none p-2 md:p-3 rounded-2xl flex flex-col justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                <div className="flex justify-between items-start z-10 w-full">
                                    <div className="flex flex-col min-w-0">
                                        <span className="text-[7px] md:text-[8px] font-medium text-gray-400 uppercase tracking-tight truncate">{k.label}</span>
                                        <span className="text-sm md:text-lg font-medium tabular-nums tracking-tighter text-zinc-900 dark:text-zinc-50 tracking-tight truncate">{k.val}</span>
                                    </div>
                                    <div className="p-1 md:p-2 rounded-2xl shrink-0" style={{ backgroundColor: `${k.color}15`, color: k.color }}>
                                        <k.icon size={12} />
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* TARJETA 2: BÚSQUEDA Y ESCÁNER (Sticky en Mobile) */}
                    <div className="sticky top-0 z-50 bg-white dark:bg-zinc-950 rounded-2xl border border-emerald-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-3 md:p-4 flex flex-col gap-3">
                        <div className="flex justify-between items-center px-1">
                            <label className="text-[9px] font-medium text-gray-400 uppercase tracking-widest tracking-tight">Buscar Producto</label>
                            <div className="flex gap-2">
                                <button 
                                    onClick={() => addFreeItem()}
                                    className="text-[10px] font-medium text-blue-500 hover:text-blue-600 transition-colors uppercase tracking-tight flex items-center gap-1"
                                >
                                    <Plus size={12} strokeWidth={3} /> Ítem Libre
                                </button>
                                <button 
                                    onClick={() => setIsProductModalOpen(true)}
                                    className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 hover:text-zinc-900 dark:text-zinc-100 transition-colors uppercase tracking-tight flex items-center gap-1"
                                >
                                    <Plus size={12} strokeWidth={3} /> Nuevo Producto
                                </button>
                            </div>
                        </div>
                        <div className="relative">
                            <Autocomplete
                                ref={searchRef}
                                placeholder="CÓDIGO O NOMBRE..."
                                className="w-full"
                                items={filteredProductsSearch}
                                inputValue={searchQuery}
                                onInputChange={setSearchQuery}
                                onSelectionChange={(key) => {
                                    if (!key) return;
                                    const p = products.find(prod => prod.barcode === String(key));
                                    if (p) {
                                        addToReceive(p);
                                        toast({ variant: 'success', title: 'AGREGADO', description: p.productName });
                                    }
                                    setSearchQuery('');
                                }}
                                startContent={<Barcode size={16} className="text-gray-400" />}
                                endContent={
                                    <button 
                                        onClick={() => { setScanMode('search'); setIsScannerOpen(true); }}
                                        className="p-2 text-zinc-900 dark:text-zinc-100 hover:bg-white/5 rounded-2xl transition-all"
                                    >
                                        <Camera size={20} />
                                    </button>
                                }
                                inputProps={{
                                    classNames: {
                                        inputWrapper: "h-12 md:h-14 bg-[var(--bg-elevated)] border border-[var(--border)] shadow-inner rounded-2xl focus-within:border-[var(--accent)] transition-all px-4",
                                        input: "text-xs md:text-sm font-medium tracking-widest tracking-tight uppercase text-[var(--text-primary)]"
                                    }
                                }}
                                popoverProps={{
                                    placement: "bottom",
                                    triggerScaleOnOpen: false,
                                    offset: 10,
                                    className: "z-[9999]"
                                }}
                            >
                                {(item) => (
                                    <AutocompleteItem key={item.barcode} textValue={item.productName} className="text-[var(--text-primary)] rounded-2xl data-[hover=true]:bg-[var(--bg-card-hover)]">
                                        <div className="flex justify-between items-center w-full">
                                            <div className="flex items-center gap-2">
                                                <Package size={14} className="text-gray-400" />
                                                <div className="flex flex-col">
                                                    <span className="text-[10px] font-medium uppercase">{item.productName}</span>
                                                    <span className="text-[8px] font-mono opacity-50">#{item.barcode}</span>
                                                </div>
                                            </div>
                                            <div className="flex flex-col items-end">
                                                <span className="text-[10px] font-medium tracking-tight text-zinc-900 dark:text-zinc-100">${formatCurrency(Number(item.purchasePrice))}</span>
                                                <span className={`text-[7px] font-medium px-1 rounded-2xl mt-0.5 ${item.quantity <= 0 ? 'bg-rose-500/20 text-rose-500' : 'bg-white/5 text-zinc-900 dark:text-zinc-100'}`}>
                                                    S: {item.quantity}
                                                </span>
                                            </div>
                                        </div>
                                    </AutocompleteItem>
                                )}
                            </Autocomplete>
                        </div>
                        <Button
                            onPress={() => setIsScannerOpen(true)}
                            className="h-10 w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 flex items-center justify-center gap-2 md:hidden"
                        >
                            <Camera size={16} />
                            <span className="font-medium uppercase text-[10px] tracking-tight">Escanear</span>
                        </Button>
                    </div>

                </div>

                {/* COLUMNA DE LISTA (DERECHA EN DESKTOP, ABAJO EN MÓVIL) */}
                <div className="flex-1 flex flex-col gap-4 overflow-hidden min-h-[300px] bg-white/50 dark:bg-[#18181b]/30 rounded-2xl border border-gray-200/50 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-2 md:p-3">
                    
                    {/* TARJETA 3: LISTA DE PRODUCTOS */}
                    <div className="flex-1 card-base border-none rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden flex flex-col relative">
                        <div className="px-3 md:px-4 py-2 md:py-3 border-b border-gray-100 dark:border-white/5 flex justify-between items-center bg-gray-50 dark:bg-zinc-950/50">
                            <div className="flex items-center gap-2">
                                <div className="w-1.5 h-1.5 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 animate-pulse" />
                                <h2 className="text-[10px] font-medium uppercase tracking-widest text-gray-500 dark:text-zinc-400">Referencias en Lista ({receiveList.length})</h2>
                            </div>
                            {receiveList.length > 0 && (
                                <Button size="sm" variant="light" color="danger" onPress={() => setIsClearConfirmOpen(true)} className="h-6 text-[8px] font-medium uppercase tracking-tight bg-rose-500/10 rounded-2xl">
                                    <Trash2 size={10} className="mr-1"/> Limpiar
                                </Button>
                            )}
                        </div>
                        
                        {receiveList.length === 0 ? (
                            <div className="flex-1 flex flex-col items-center justify-center opacity-40 text-gray-500 dark:text-zinc-500 p-10">
                                <Package size={48} strokeWidth={1} />
                                <p className="text-[10px] font-medium uppercase tracking-[0.3em] mt-4 tracking-tight text-gray-800 dark:text-zinc-300 text-center">Inicie el ingreso de productos</p>
                            </div>
                        ) : (
                            <div className="flex-1 overflow-y-auto custom-scrollbar bg-gray-50/50 dark:bg-zinc-950/20 p-2 md:p-4">
                                <div className="bg-white dark:bg-zinc-950/50 p-4 rounded-2xl border border-zinc-800/80 shadow-inner flex flex-col gap-4 pb-24 md:pb-20">
                                    {receiveList.map((item) => (
                                        <ReceptionRow
                                            key={item.lineId}
                                            item={item}
                                            onUpdate={updateItem}
                                            onDelete={deleteItem}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}
                        
                        {/* BOTTOM ACTION BAR (Desktop) */}
                        <div className="hidden md:flex p-4 border-t border-gray-100 dark:border-white/5 bg-gray-50 dark:bg-zinc-950 items-center justify-between">
                            <div className="flex flex-col">
                                <span className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">Total a Pagar</span>
                                <span className="text-2xl font-medium tracking-tight text-zinc-900 dark:text-zinc-50">${formatCurrency(totalOrderValue)}</span>
                            </div>
                            <Button 
                                onPress={() => setIsSyncConfirmOpen(true)} 
                                isDisabled={receiveList.length === 0 || !selectedGlobalSupplier || submitting} 
                                className={`h-14 px-8 rounded-2xl font-medium uppercase text-xs tracking-widest shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all active:scale-95 flex items-center gap-2 ${receiveList.length > 0 ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5' : 'bg-gray-200 dark:bg-zinc-800 text-gray-400'}`}
                            >
                                {submitting ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
                                SINCRONIZAR CARGA {receiveList.length > 0 && `(${receiveList.length})`}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>

            {/* BARRA DE ACCIÓN FIJA INFERIOR - Compacta para Mobile */}
            <div className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-between gap-3 p-2 bg-white/95 dark:bg-zinc-950/95 border-t border-gray-200 dark:border-white/10 shadow-[0_-5px_20px_rgba(0,0,0,0.1)] md:hidden">
                <div className="flex flex-col pl-2">
                    <span className="text-[8px] text-gray-400 font-medium uppercase tracking-tighter tracking-tight">Total Pagar</span>
                    <span className="text-lg font-medium tracking-tight text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 leading-tight">${formatCurrency(totalOrderValue)}</span>
                </div>
                <div className="flex items-center gap-2">
                    <Button 
                        onPress={() => setIsSyncConfirmOpen(true)} 
                        isDisabled={receiveList.length === 0 || !selectedGlobalSupplier || submitting} 
                        className={`h-10 px-6 rounded-2xl font-medium uppercase text-[10px] tracking-tight ${receiveList.length > 0 ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)]' : 'bg-gray-200 dark:bg-zinc-800 text-gray-500'}`}
                    >
                        {submitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={16} />}
                        SINCRONIZAR
                    </Button>
                </div>
            </div>

            {submitting && (
                <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center card-base border-none dark:bg-zinc-950 transition-all">
                    <Spinner color="success" size="lg" />
                    <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-[0.4em] mt-6 animate-pulse tracking-tight">Procesando Carga...</p>
                </div>
            )}

            <ScannerOverlay
                isOpen={isScannerOpen}
                onClose={() => { setIsScannerOpen(false); setScannedNotFoundCode(''); }}
                errorTitle={scannedNotFoundCode ? "Producto Desconocido" : undefined}
                errorMessage={scannedNotFoundCode ? `Código #${scannedNotFoundCode} no identificado.` : undefined}
                onIgnoreError={() => {
                    setScannedNotFoundCode('');
                    setIsScannerOpen(false);
                    setTimeout(() => setIsScannerOpen(true), 10);
                }}
                onCreateProduct={() => {
                    setIsProductModalOpen(true);
                    setNewProduct(prev => ({ ...prev, barcode: scannedNotFoundCode }));
                    setScannedNotFoundCode('');
                    setIsScannerOpen(false);
                }}
                onResult={handleScannerResult}
            />

            <Modal isOpen={isClearConfirmOpen} onOpenChange={setIsClearConfirmOpen} backdrop="blur">
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="font-medium uppercase tracking-tight">Limpiar Lista</ModalHeader>
                            <ModalBody className="text-sm font-medium">¿Estás seguro de que deseas eliminar todos los productos de la lista actual? Esta acción no se puede deshacer.</ModalBody>
                            <ModalFooter>
                                <Button variant="flat" onPress={onClose} className="font-medium uppercase tracking-tight text-xs">Cancelar</Button>
                                <Button color="danger" onPress={handleClearList} className="font-medium uppercase tracking-tight text-xs">Limpiar Todo</Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

            {/* MODAL DE ÓRDENES PENDIENTES (Rediseño Bottom Sheet Aesthetic) */}
            <Modal 
                isOpen={isOrderModalOpen} 
                onOpenChange={setIsOrderModalOpen} 
                placement="bottom-center"
                scrollBehavior="inside" 
                backdrop="blur"
                classNames={{
                    base: "m-0 sm:m-2 bg-white dark:bg-zinc-950 border-t border-gray-200 dark:border-white/10 rounded-t-3xl sm:rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] max-h-[90vh]",
                    backdrop: "bg-[#18181b] ",
                    closeButton: "top-4 right-4 bg-gray-100 dark:bg-zinc-800 p-2 rounded-2xl active:scale-90 transition-all"
                }}
            >
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex flex-col gap-1 p-6 pb-2">
                                <div className="w-12 h-1 bg-gray-200 dark:bg-zinc-800 rounded-2xl mx-auto mb-4 md:hidden" />
                                <div className="flex items-center gap-3">
                                    <div className="bg-white/5 p-2 rounded-2xl text-zinc-900 dark:text-zinc-100 shadow-[0_8px_30px_rgb(0,0,0,0.12)]"><ShoppingBag size={24} /></div>
                                    <div className="flex flex-col">
                                        <h2 className="text-xl font-medium uppercase tracking-tight tracking-tighter text-zinc-900 dark:text-zinc-50 leading-tight">Órdenes <span className="text-zinc-900 dark:text-zinc-100">Pendientes</span></h2>
                                        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest tracking-tight">Carga de Documentos Existentes</p>
                                    </div>
                                </div>
                            </ModalHeader>
                            <ModalBody className="p-6 pt-2">
                                {isLoadingOrders ? (
                                    <div className="h-60 flex flex-col items-center justify-center gap-4">
                                        <Spinner color="success" size="lg" />
                                        <p className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-[0.4em] animate-pulse tracking-tight">Consultando Base de Datos...</p>
                                    </div>
                                ) : pendingOrders.length === 0 ? (
                                    <div className="h-60 flex flex-col items-center justify-center text-gray-400 gap-6 text-center animate-in fade-in zoom-in duration-300">
                                        <div className="relative">
                                            <div className="absolute inset-0 bg-gray-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 rounded-2xl scale-150 animate-pulse" />
                                            <div className="relative card-base border-none p-6 rounded-2xl shadow-inner border border-gray-100 dark:border-white/5">
                                                <Package size={60} strokeWidth={0.5} className="opacity-20" />
                                            </div>
                                        </div>
                                        <div className="flex flex-col gap-2 max-w-[250px]">
                                            <p className="text-xs font-medium uppercase tracking-tight text-gray-900 dark:text-zinc-300 leading-tight">No hay órdenes pendientes para este proveedor</p>
                                            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-tighter">Puedes iniciar la carga manual de productos cerrando este panel.</p>
                                        </div>
                                        <Button 
                                            variant="flat" 
                                            onPress={onClose} 
                                            className="h-12 w-full max-w-[200px] rounded-2xl font-medium uppercase text-xs tracking-widest bg-gray-100 dark:bg-[#18181b] hover:bg-gray-200 dark:hover:bg-zinc-100 dark:bg-zinc-800 transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
                                        >
                                            Cerrar y Continuar
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="grid gap-3 py-2">
                                        {pendingOrders.map((order) => (
                                            <button 
                                                key={order.id} 
                                                onClick={() => loadOrderIntoList(order)} 
                                                className="w-full flex items-center justify-between p-4 rounded-2xl border border-gray-100 dark:border-white/5 hover:border-emerald-500 hover:shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:shadow-emerald-500/10 transition-all bg-gray-50/50 dark:bg-[#18181b]/50 group active:scale-[0.98]"
                                            >
                                                <div className="flex items-center gap-3">
                                                    <div className="w-10 h-10 rounded-2xl bg-white dark:bg-zinc-950 flex items-center justify-center shadow-inner group-hover:text-zinc-900 dark:text-zinc-100 transition-colors">
                                                        <span className="text-[10px] font-medium tracking-tight">#{order.id}</span>
                                                    </div>
                                                    <div className="flex flex-col text-left">
                                                        <span className="text-xs font-medium uppercase tracking-tight text-gray-900 dark:text-zinc-200">Factura de Compra</span>
                                                        <span className="text-[9px] text-gray-400 font-bold uppercase tracking-tighter">{new Date(order.createdAt).toLocaleDateString()} • {order.orderItems.length} Referencias</span>
                                                    </div>
                                                </div>
                                                <div className="flex flex-col items-end">
                                                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-300 tabular-nums tracking-tight">${formatCurrency(order.estimatedCost)}</span>
                                                    <div className="flex items-center gap-1 text-[8px] text-gray-400 font-medium uppercase group-hover:text-zinc-900 dark:text-zinc-100 transition-colors tracking-tighter">
                                                        <span>Importar</span><Plus size={10} strokeWidth={3} />
                                                    </div>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </ModalBody>
                            <ModalFooter className="bg-gray-50/50 dark:bg-zinc-950/50 p-6 border-t border-gray-100 dark:border-white/5 md:hidden">
                                <Button variant="flat" onPress={onClose} className="h-12 w-full rounded-2xl font-medium uppercase text-xs tracking-widest">Cerrar Panel</Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

            <SupplierFormModal isOpen={isAddSupplierOpen} onOpenChange={setIsAddSupplierOpen} onSave={handleCreateSupplier} isEdit={false} />

            <ProductFormModal 
                isOpen={isProductModalOpen}
                onOpenChange={setIsProductModalOpen}
                addDialogOpen={isProductModalOpen}
                newProduct={newProduct}
                setNewProduct={setNewProduct}
                editingProduct={null}
                setEditingProduct={() => {}}
                categories={categories}
                suppliers={suppliers}
                onConfirm={handleCreateProduct}
                onScan={() => { setScanMode('main'); setIsScannerOpen(true); }}
                onScanAlternate={() => { setScanMode('alternate'); setIsScannerOpen(true); }}
                onScanBase={() => { setScanMode('baseProduct'); setIsScannerOpen(true); }}
                allProducts={products}
                apiFieldErrors={apiFieldErrors}
            />

            {/* MODAL DE CONFIRMACIÓN DE SINCRONIZACIÓN */}
            <Modal isOpen={isSyncConfirmOpen} onOpenChange={setIsSyncConfirmOpen} backdrop="blur" classNames={{ base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl" }}>
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex flex-col gap-1 p-6">
                                <div className="flex items-center gap-3">
                                    <div className="bg-white/5 p-2 rounded-2xl text-zinc-900 dark:text-zinc-100"><Package size={24} /></div>
                                    <div className="flex flex-col">
                                        <span className="text-xl font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tight">Confirmar Sincronización</span>
                                        <span className="text-[10px] text-zinc-500 dark:text-zinc-400 uppercase font-bold tracking-widest tracking-tight">Carga Maestra v9.0</span>
                                    </div>
                                </div>
                            </ModalHeader>
                            <ModalBody className="p-6 pb-2">
                                <div className="flex flex-col gap-4">
                                    <div className="p-4 bg-gray-50 dark:bg-[#18181b]/50 rounded-2xl border border-gray-100 dark:border-white/5">
                                        <p className="text-sm text-gray-600 dark:text-zinc-400 leading-relaxed font-medium">
                                            Estás a punto de sincronizar la carga de <span className="text-zinc-900 dark:text-zinc-50 font-medium underline decoration-emerald-500/30 underline-offset-4">{receiveList.length} referencias</span> al inventario global.
                                        </p>
                                    </div>

                                    {bypassExpense && (
                                        <div className="p-4 bg-rose-500/10 border-2 border-rose-500/50 rounded-2xl flex items-start gap-3 animate-pulse shadow-[0_0_15px_rgba(244,63,94,0.1)]">
                                            <AlertTriangle className="text-rose-500 shrink-0 mt-0.5" size={24} />
                                            <div className="flex flex-col">
                                                <span className="text-[12px] font-medium text-rose-600 dark:text-rose-500 uppercase tracking-tight tracking-wider">⚠️ ALERTA DE CAJA: BYPASS ACTIVADO</span>
                                                <p className="text-[11px] font-bold text-rose-600/90 dark:text-rose-400 leading-tight mt-1">
                                                    Solo se actualizará el inventario físico. <span className="underline decoration-2">NO se registrará salida de dinero</span> ni egresos en la contabilidad.
                                                </p>
                                            </div>
                                        </div>
                                    )}

                                    {!bypassExpense && (
                                        <div className="flex flex-col gap-3">
                                            <div className="p-4 bg-white/5 border border-emerald-500/20 rounded-2xl flex items-start gap-3 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                                <ShieldCheck className="text-zinc-900 dark:text-zinc-100 shrink-0 mt-0.5" size={24} />
                                                <div className="flex flex-col">
                                                    <span className="text-[12px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 uppercase tracking-tight">CONTABILIDAD SINCRONIZADA</span>
                                                    <p className="text-[11px] font-bold text-zinc-900 dark:text-zinc-100/80 dark:text-zinc-100/70 leading-tight mt-1">
                                                        Se generará un egreso automático en caja por el valor total. Flujo contable estándar activo.
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="flex flex-col gap-2 p-4 bg-gray-50 dark:bg-[#18181b]/50 border border-gray-100 dark:border-white/5 rounded-2xl">
                                                <span className="text-[10px] font-medium uppercase text-gray-500 tracking-widest tracking-tight mb-1">Medio de Pago</span>
                                                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                                                    {paymentMethods.map(method => (
                                                        <div key={method.id} className="relative flex flex-col bg-[#18181b] border border-zinc-200 dark:border-white/10 rounded-2xl p-2 gap-1 focus-within:border-emerald-500 transition-all">
                                                            <div className="flex items-center gap-1 mb-1">
                                                                <method.icon size={12} className="text-gray-400" />
                                                                <span className="text-[9px] font-medium uppercase text-gray-300">{method.label}</span>
                                                            </div>
                                                            <div className="flex items-center gap-1">
                                                                <span className="text-zinc-900 dark:text-zinc-100 font-medium text-xs">$</span>
                                                                <input 
                                                                    type="number"
                                                                    value={mixedPayments[method.id] || ''}
                                                                    onChange={(e) => setMixedPayments(prev => ({...prev, [method.id]: Number(e.target.value) || 0}))}
                                                                    className="bg-transparent w-full text-xs font-medium text-white outline-none"
                                                                    placeholder="0"
                                                                />
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                                <div className="flex justify-between items-center px-2 py-1 mt-1 bg-white dark:bg-zinc-950 rounded-2xl">
                                                    <span className="text-[10px] font-bold text-gray-400">Total Ingresado:</span>
                                                    <span className={`text-[11px] font-medium ${isPaymentsValid ? 'text-zinc-900 dark:text-zinc-100' : 'text-rose-500'}`}>${formatCurrency(sumPayments)} / ${formatCurrency(expectedTotal)}</span>
                                                </div>
                                            </div>

                                            <div className="flex flex-col gap-2 p-4 bg-gray-50 dark:bg-[#18181b]/50 border border-gray-100 dark:border-white/5 rounded-2xl">
                                                <div className="flex items-center justify-between mb-1">
                                                    <span className="text-[10px] font-medium uppercase text-gray-500 tracking-widest tracking-tight">Costo de Flete (Opcional)</span>
                                                    <span className="text-[10px] font-medium text-amber-500 tracking-tight">Suma al Egreso</span>
                                                </div>
                                                <Input
                                                    type="number"
                                                    variant="flat"
                                                    placeholder="0.00"
                                                    startContent={<span className="text-gray-400 font-medium text-xs">$</span>}
                                                    value={String(freightCost)}
                                                    onValueChange={(v) => setFreightCost(Number(v) || 0)}
                                                    classNames={{
                                                        inputWrapper: "h-11 card-base border-none border border-gray-100 dark:border-white/5 rounded-2xl",
                                                        input: "font-medium text-sm text-zinc-900 dark:text-zinc-50"
                                                    }}
                                                />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </ModalBody>
                            <ModalFooter className="p-6 pt-4 gap-3">
                                <Button variant="flat" onPress={onClose} className="h-12 flex-1 rounded-2xl font-medium uppercase text-[11px] tracking-widest text-gray-400 bg-gray-100 dark:bg-[#18181b] transition-all hover:bg-gray-200 dark:hover:bg-zinc-100 dark:bg-zinc-800">Cancelar</Button>
                                <Button onPress={() => { onClose(); handleConfirmReceive(); }} isDisabled={!bypassExpense && !isPaymentsValid} className="h-12 flex-1 rounded-2xl font-medium uppercase text-[11px] tracking-widest bg-emerald-500 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:bg-emerald-600 transition-all active:scale-95">Sincronizar Ahora</Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

            <Modal isOpen={notFoundDialogOpen} onOpenChange={setNotFoundDialogOpen} backdrop="blur" classNames={{ base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/5 rounded-2xl" }}>
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex items-center gap-2 p-6">
                                <AlertTriangle className="text-amber-500" />
                                <span className="font-medium uppercase tracking-tight text-lg">Producto no encontrado</span>
                            </ModalHeader>
                            <ModalBody className="px-6 pb-6">
                                <p className="text-sm font-medium text-gray-600 dark:text-zinc-400">
                                    El código <span className="font-mono font-medium text-zinc-900 dark:text-zinc-50 px-2 py-1 bg-gray-100 dark:bg-zinc-800 rounded-2xl">{scannedNotFoundCode}</span> no está registrado en el inventario global.
                                </p>
                            </ModalBody>
                            <ModalFooter className="p-6 pt-0 gap-3">
                                <Button variant="flat" onPress={onClose} className="h-12 flex-1 rounded-2xl font-medium uppercase text-xs tracking-widest">Cerrar</Button>
                                <Button color="primary" onPress={() => { 
                                    onClose(); 
                                    setIsProductModalOpen(true);
                                    setNewProduct(prev => ({ ...prev, barcode: scannedNotFoundCode }));
                                }} className="h-12 flex-1 rounded-2xl font-medium uppercase text-xs tracking-widest bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)]">Crear Producto</Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>
        </div>
    );
}
