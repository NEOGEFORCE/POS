"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Badge, Spinner, Select, SelectItem, Autocomplete, AutocompleteItem, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Switch, Tooltip } from "@heroui/react";
import {
    Search, Plus, Camera, Truck, RefreshCw,
    Trash2, Package, ShieldCheck, Gift, ArrowDownLeft, Barcode, Loader2, Zap, TrendingDown, AlertTriangle, Sparkles, ChevronDown, Check, X,
    ShoppingBag, Info
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Product, Supplier } from '@/lib/definitions';
import { formatCurrency, applyRounding } from "@/lib/utils";
import Cookies from 'js-cookie';
import dynamic from 'next/dynamic';
import { useAuth } from '@/lib/auth';

const ScannerOverlay = dynamic(() => import('@/components/ScannerOverlay').then(m => m.ScannerOverlay), { ssr: false });
const ReceptionRow = dynamic(() => import('./components/ReceptionRow'), { ssr: false });
const SupplierFormModal = dynamic(() => import('../../suppliers/components/SupplierFormModal'), { ssr: false });

// Stats Component inline (mismo patrón que ProductStats)
const SPARKLINE_DATA_1 = [{val: 40}, {val: 30}, {val: 45}, {val: 20}, {val: 50}];
const SPARKLINE_DATA_2 = [{val: 10}, {val: 25}, {val: 15}, {val: 40}, {val: 35}];
const SPARKLINE_DATA_3 = [{val: 50}, {val: 45}, {val: 55}, {val: 60}, {val: 40}];
const SPARKLINE_DATA_4 = [{val: 20}, {val: 35}, {val: 25}, {val: 45}, {val: 50}];

import { ResponsiveContainer, AreaChart, Area } from 'recharts';

export interface ReceiveItem {
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
    discount: number; // Porcentaje (%) de descuento del proveedor
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
    const [selectedGlobalSupplier, setSelectedGlobalSupplier] = useState<string>('none');
    const [receiveList, setReceiveList] = useState<ReceiveItem[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [isScannerOpen, setIsScannerOpen] = useState(false);
    const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
    const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
    const [pendingOrders, setPendingOrders] = useState<any[]>([]);
    const [isLoadingOrders, setIsLoadingOrders] = useState(false);
    const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
    const [isAddSupplierOpen, setIsAddSupplierOpen] = useState(false);
    const { user, loading: authLoading } = useAuth();
    const [bypassExpense, setBypassExpense] = useState(false);
    const [isSyncConfirmOpen, setIsSyncConfirmOpen] = useState(false);
    
    // FASE 3: Blindaje de Rol Estricto - Cargando desde Contexto Centralizado
    const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPERADMIN'; 
    
    // Si estamos cargando la sesión, asumimos admin temporalmente para no ocultar la UI si el usuario lo es
    const showAdminControls = authLoading || isAdmin;
    
    // Forzar false si definitivamente no es admin y ya terminó de cargar
    useEffect(() => {
        if (!authLoading && !isAdmin && bypassExpense) setBypassExpense(false);
    }, [authLoading, isAdmin, bypassExpense]);
    

    const searchRef = useRef<HTMLInputElement>(null);
    const hiddenScannerRef = useRef<HTMLInputElement>(null);
    const [barcodeInput, setBarcodeInput] = useState('');

    const loadData = useCallback(async () => {
        const token = Cookies.get('org-pos-token');
        if (!token) { router.push('/login'); return; }
        try {
            const [pRes, sRes] = await Promise.all([
                fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/all-products`, { headers: { 'Authorization': `Bearer ${token}` } }),
                fetch(`${process.env.NEXT_PUBLIC_API_URL}/suppliers/all-suppliers`, { headers: { 'Authorization': `Bearer ${token}` } })
            ]);
            if (pRes.ok) setProducts(await pRes.json());
            if (sRes.ok) setSuppliers(await sRes.json());
        } catch (err) { console.error(err); } finally { setLoading(false); }
    }, [router]);

    useEffect(() => { 
        loadData(); 
    }, [loadData]);

    // --- PESISTENCIA ---
    useEffect(() => {
        const savedList = localStorage.getItem('org-pos-reception-list');
        const savedSupplier = localStorage.getItem('org-pos-reception-supplier');
        if (savedList) {
            try {
                const parsed = JSON.parse(savedList);
                if (Array.isArray(parsed)) setReceiveList(parsed);
            } catch (e) { console.error("Error loading saved reception list", e); }
        }
        if (savedSupplier) setSelectedGlobalSupplier(savedSupplier);
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
        return products.filter(p =>
            p.productName.toLowerCase().includes(searchQuery.toLowerCase()) ||
            p.barcode.includes(searchQuery)
        ).slice(0, 6);
    }, [products, searchQuery]);

    const addToReceive = useCallback((product: Product, customQty?: number, customPrice?: number) => {
        setReceiveList(prev => {
            const existing = prev.find(item => item.barcode === product.barcode);
            if (existing && !customQty) {
                return prev.map(item => item.barcode === product.barcode
                    ? { ...item, addedQuantity: item.addedQuantity + 1 } : item
                );
            }
            return [{
                barcode: product.barcode,
                productName: product.productName,
                addedQuantity: customQty || 1,
                newPurchasePrice: customPrice || Number(product.purchasePrice),
                newSalePrice: applyRounding(Number(product.salePrice)),
                marginPercentage: (customPrice || product.purchasePrice) > 0 ? ((product.salePrice / (customPrice || product.purchasePrice)) - 1) * 100 : 30,
                entryType: 'purchase',
                iva: Number(product.iva || 0),
                icui: Number(product.icui || 0),
                ibua: Number(product.ibua || 0),
                discount: 0
            }, ...prev];
        });
        setSearchQuery('');
    }, []);

    const fetchPendingOrders = async () => {
        if (selectedGlobalSupplier === 'none') {
            toast({ title: "Error", description: "Selecciona un proveedor primero", variant: "destructive" });
            return;
        }
        setIsLoadingOrders(true);
        setIsOrderModalOpen(true);
        try {
            const token = Cookies.get('org-pos-token');
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/inventory/orders?supplier_id=${selectedGlobalSupplier}`, {
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
        const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/suppliers/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(data)
        });
        if (res.ok) {
            const created = await res.json();
            setSuppliers(prev => [...prev, created]);
            setSelectedGlobalSupplier(String(created.id));
            setIsAddSupplierOpen(false);
            toast({ variant: 'success', title: "ÉXITO", description: "PROVEEDOR CREADO Y SELECCIONADO" });
        }
    };

    const loadOrderIntoList = (order: any) => {
        // Limpiar lista actual o preguntar? El sprint sugiere "poblar automáticamente"
        // Vamos a acumular pero marcar el ID de la orden vinculada
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
                target?.hasAttribute('data-slot')
            ) && !target.classList.contains('scanner-gate');
            const isModalOpen = isScannerOpen || submitting;
            
            if (!isRealInput && !isModalOpen && hiddenScannerRef.current) {
                hiddenScannerRef.current.focus();
            }
        }, 1500); // Aumentado a 1.5s para dar más tiempo a las transiciones de UI
        return () => clearInterval(interval);
    }, [isScannerOpen, submitting]);

    const updateItem = useCallback((barcode: string, updates: Partial<ReceiveItem>) => {
        setReceiveList(prev => prev.map(item => item.barcode === barcode ? { ...item, ...updates } : item));
    }, []);

    const deleteItem = useCallback((barcode: string) => {
        setReceiveList(prev => prev.filter(item => item.barcode !== barcode));
    }, []);

    const totalOrderValue = useMemo(() => {
        return receiveList.reduce((sum, item) => {
            // Calcular: base × (1 + desc%) × (1 + iva% + icui% + ibua%)
            const basePrice = Number(item.newPurchasePrice);
            const discount = Number(item.discount || 0);
            const iva = Number(item.iva || 0);
            const icui = Number(item.icui || 0);
            const ibua = Number(item.ibua || 0);
            
            // Descuento SUMA al costo (no resta)
            const withDiscount = basePrice * (1 + discount / 100);
            const totalUnit = withDiscount * (1 + iva / 100 + icui / 100 + ibua / 100);
            const lineTotal = totalUnit * item.addedQuantity;
            
            if (item.entryType === 'purchase') return sum + lineTotal;
            if (item.entryType === 'return') return sum - lineTotal;
            if (item.entryType === 'gift') return sum; // Gratis = 0
            return sum;
        }, 0);
    }, [receiveList]);

    const handleConfirmReceive = async () => {
        if (receiveList.length === 0) return;
        
        if (selectedGlobalSupplier === 'none') {
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
                const discountPct = Number(item.discount || 0);
                const ivaPct = Number(item.iva || 0);
                const icuiPct = Number(item.icui || 0);
                const ibuaPct = Number(item.ibua || 0);
                
                const afterDiscount = basePrice * (1 - discountPct / 100);
                const unitDiscountAmount = basePrice * (discountPct / 100);
                const unitIvaAmount = afterDiscount * (ivaPct / 100);
                const unitIcuiAmount = afterDiscount * (icuiPct / 100);
                const unitIbuaAmount = afterDiscount * (ibuaPct / 100);
                
                return {
                    barcode: item.barcode,
                    addedQuantity: item.entryType === 'return' ? -Number(item.addedQuantity) : Number(item.addedQuantity),
                    newPurchasePrice: (item.entryType === 'gift') ? 0 : basePrice,
                    newSalePrice: Number(item.newSalePrice),
                    supplierId: selectedGlobalSupplier !== 'none' ? Number(selectedGlobalSupplier) : null,
                    iva: unitIvaAmount,
                    icui: unitIcuiAmount,
                    ibua: unitIbuaAmount,
                    discount: unitDiscountAmount
                };
            });

            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/bulk-receive`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ 
                    orderId: selectedOrderId,
                    entries,
                    bypassExpense: bypassExpense,
                    paymentSource: 'EFECTIVO'
                })
            });

            if (res.ok) {
                toast({ 
                    variant: 'success', 
                    title: "OPERACIÓN EXITOSA", 
                    description: bypassExpense ? "INVENTARIO ACTUALIZADO (SIN EGRESO)" : "INVENTARIO Y EGRESO SINCRONIZADOS" 
                });
                localStorage.removeItem('org-pos-reception-list');
                localStorage.removeItem('org-pos-reception-supplier');
                setReceiveList([]);
                router.push('/dashboard'); 
            } else {
                const errData = await res.json();
                toast({ variant: 'destructive', title: "ERROR EN SINCRONIZACIÓN", description: errData.error?.message || "No se pudo completar la operación." });
            }
        } catch (err) { 
            console.error(err); 
            toast({ variant: 'destructive', title: "ERROR DE RED", description: "No se pudo conectar con el servidor." });
        } finally { 
            setSubmitting(false); 
        }
    };

    if (loading) {
        return (
            <div className="h-screen flex items-center justify-center bg-gray-100 dark:bg-[#09090b] transition-colors duration-500">
                <Loader2 className="h-10 w-10 animate-spin text-emerald-500" />
            </div>
        );
    }

    const totalItems = receiveList.length;
    const totalUnits = receiveList.reduce((sum, item) => sum + item.addedQuantity, 0);
    const totalDiscount = receiveList.reduce((sum, item) => sum + (item.discount || 0), 0);
    const avgMargin = totalItems > 0 ? receiveList.reduce((sum, item) => sum + (item.marginPercentage || 0), 0) / totalItems : 0;

    const stats = [
        { label: "INVERSIÓN", val: `$${formatCurrency(totalOrderValue)}`, color: "#0ea5e9", icon: TrendingDown, desc: "Total orden", data: SPARKLINE_DATA_1 },
        { label: "ÍTEMS", val: totalItems, color: "#10b981", icon: Package, desc: "Referencias", data: SPARKLINE_DATA_2 },
        { label: "DTO% TOTAL", val: `${totalDiscount.toFixed(0)}%`, color: "#8b5cf6", icon: Zap, desc: "Desc. acumulado", data: SPARKLINE_DATA_3 },
        { label: "MARGEN", val: `${avgMargin.toFixed(0)}%`, color: "#f43f5e", icon: AlertTriangle, desc: "Ganancia promedio", data: SPARKLINE_DATA_4 }
    ];

    return <div className="flex flex-col w-full max-w-[1600px] mx-auto h-svh min-h-0 bg-transparent text-gray-900 dark:text-white transition-all duration-500 overflow-visible relative">
            {/* SCANNER SIEMPRE ACTIVO - Input oculto */}
            <input
                ref={hiddenScannerRef}
                type="text"
                value={barcodeInput}
                onChange={(e) => setBarcodeInput(e.target.value)}
                className="scanner-gate absolute opacity-0 w-0 h-0 pointer-events-none"
                autoFocus
                aria-label="Scanner input"
            />

            {/* MAIN CONTENT WRAPPER */}
            <div className="flex flex-col h-svh max-h-svh overflow-hidden bg-gray-100 dark:bg-zinc-950">
                {/* HEADER COMPACTO PREMIUM */}
                <div className="shrink-0 px-3 pt-1.5 pb-1.5 flex flex-col gap-1.5 bg-white dark:bg-zinc-950 border-b border-gray-200 dark:border-white/5">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="bg-emerald-500 h-8 w-8 rounded-lg text-white shadow-lg shadow-emerald-500/20 flex items-center justify-center transform -rotate-3 transition-transform hover:rotate-0">
                                <Truck size={16} />
                            </div>
                            <div className="flex flex-col">
                                <div className="flex items-center gap-1.5">
                                    <h1 className="text-[12px] font-black text-gray-900 dark:text-white tracking-tight uppercase italic leading-none">
                                        Carga <span className="text-emerald-500">Maestra</span>
                                    </h1>
                                    <span className="text-[8px] font-black px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/10 italic">V9.0</span>
                                    
                                    {showAdminControls && (
                                        <div className="ml-2 flex items-center gap-2 px-2 py-1 bg-gray-100 dark:bg-white/5 rounded-full border border-gray-200 dark:border-white/5">
                                            <Switch 
                                                size="sm"
                                                color="warning"
                                                isSelected={bypassExpense}
                                                onValueChange={setBypassExpense}
                                                classNames={{
                                                    wrapper: "h-3 w-7 bg-gray-300 dark:bg-zinc-800",
                                                    thumb: "h-2.5 w-2.5"
                                                }}
                                            />
                                            <span className={`text-[7px] font-black uppercase italic leading-none ${bypassExpense ? 'text-orange-500' : 'text-gray-400'}`}>
                                                Egreso
                                            </span>
                                        </div>
                                    )}

                                    {selectedGlobalSupplier === 'none' && receiveList.length > 0 && (
                                        <div className="ml-2 flex items-center gap-1 px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded-full animate-bounce">
                                            <AlertTriangle size={8} className="text-amber-500" />
                                            <span className="text-[7px] font-black uppercase text-amber-600 dark:text-amber-500 italic">Escoge Proveedor</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                        
                        {/* BOTONES DE ACCIÓN - Desktop only */}
                        <div className="hidden md:flex items-center gap-2">
                            <Button 
                                isIconOnly
                                variant="flat"
                                onPress={() => loadData()}
                                className="h-8 w-8 bg-gray-100 dark:bg-zinc-900 text-gray-400 dark:text-emerald-500 rounded-lg border border-gray-200 dark:border-white/5 shadow-sm active:scale-95"
                            >
                                <RefreshCw size={14} />
                            </Button>
                            
                            {receiveList.length > 0 && (
                                <Button 
                                    isIconOnly
                                    variant="flat" 
                                    color="danger" 
                                    onPress={() => setIsClearConfirmOpen(true)}
                                    className="h-8 w-8 bg-rose-50 dark:bg-rose-500/10 text-rose-500 rounded-lg border border-rose-500/20"
                                >
                                    <Trash2 size={14} />
                                </Button>
                            )}

                            <Button 
                                onPress={() => setIsScannerOpen(true)} 
                                className="h-8 px-3 bg-emerald-500 text-white rounded-lg shadow-md active:scale-95 flex items-center gap-1.5"
                            >
                                <Barcode size={14} />
                                <span className="font-black uppercase text-[9px] italic">Cámara</span>
                            </Button>

                            {showAdminControls && (
                                <div className={`flex items-center gap-3 px-4 py-2 rounded-xl border transition-all ${bypassExpense ? 'bg-orange-500/10 border-orange-500/40 shadow-lg shadow-orange-500/5' : 'bg-gray-50 dark:bg-zinc-900 border-gray-100 dark:border-white/5'}`}>
                                    <label className="flex items-center gap-2 cursor-pointer group">
                                        <div className="relative flex items-center">
                                            <input 
                                                type="checkbox" 
                                                className="peer sr-only"
                                                checked={bypassExpense}
                                                onChange={(e) => setBypassExpense(e.target.checked)}
                                            />
                                            <div className="w-10 h-5 bg-gray-300 dark:bg-zinc-700 rounded-full peer-checked:bg-orange-500 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-5 shadow-inner"></div>
                                        </div>
                                        <span className={`text-[10px] font-black uppercase italic tracking-tighter transition-colors ${bypassExpense ? 'text-orange-600 dark:text-orange-500' : 'text-gray-400'}`}>
                                            {bypassExpense ? "SOLO STOCK (SIN EGRESO)" : "REGISTRAR EGRESO"}
                                        </span>
                                        <Tooltip 
                                            content={
                                                <div className="flex flex-col gap-1">
                                                    <p className="font-bold text-gray-900 dark:text-white uppercase italic text-[10px] tracking-tight">Información de Contabilidad</p>
                                                    <p className="font-medium text-[11px] leading-relaxed text-gray-500 dark:text-zinc-400">
                                                        Al activar esta opción, el sistema sumará el stock sin generar salida de dinero en caja. 
                                                        Úsalo si el pago ya fue gestionado <span className="text-emerald-500 font-bold">(efectivo, transferencia, etc).</span>
                                                    </p>
                                                </div>
                                            }
                                            showArrow
                                            placement="bottom"
                                            classNames={{
                                                content: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-[0_10px_40px_rgba(0,0,0,0.1)] rounded-2xl p-4 w-72 z-[100]",
                                                base: "before:bg-white dark:before:bg-zinc-950"
                                            }}
                                        >
                                            <div className="cursor-help text-gray-400 hover:text-emerald-500 transition-colors p-1 rounded-full hover:bg-gray-100 dark:hover:bg-white/5">
                                                <Info size={14} />
                                            </div>
                                        </Tooltip>
                                    </label>
                                </div>
                             )}

                            <Button
                                onPress={() => setIsSyncConfirmOpen(true)}
                                isDisabled={receiveList.length === 0 || selectedGlobalSupplier === 'none' || submitting}
                                className={`h-8 px-4 rounded-lg font-black uppercase text-[10px] tracking-widest shadow-lg transition-all active:scale-95 flex items-center gap-1.5 ${
                                    receiveList.length > 0 
                                    ? 'bg-gray-900 dark:bg-white text-white dark:text-black' 
                                    : 'bg-gray-100 dark:bg-zinc-800 text-gray-400'
                                }`}
                            >
                                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                                <span>{submitting ? "..." : `SINCRONIZAR ${receiveList.length > 0 ? `(${receiveList.length})` : ""}`}</span>
                            </Button>
                        </div>
                    </div>

                    <div className="grid grid-cols-12 gap-2">
                        <div className="relative col-span-6 md:col-span-8 group/search">
                            <Input 
                                ref={searchRef}
                                placeholder="BUSCAR" 
                                value={searchQuery} 
                                onValueChange={setSearchQuery} 
                                startContent={<Search size={14} className="text-emerald-500 hidden sm:block" />}
                                classNames={{ 
                                    inputWrapper: "h-10 bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 shadow-inner rounded-xl group-data-[focus=true]:border-emerald-500 transition-all px-2 sm:px-3", 
                                    input: "text-[8.5px] md:text-[10px] font-black tracking-widest italic uppercase" 
                                }} 
                            />
                            {/* Dropdown de búsqueda */}
                            {filteredProductsSearch.length > 0 && searchQuery && (
                                <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden shadow-2xl z-50 max-h-60 overflow-hidden">
                                    {filteredProductsSearch.map(p => (
                                        <button key={p.barcode} onClick={() => addToReceive(p)} className="w-full p-3 flex justify-between items-center hover:bg-emerald-500 hover:text-white border-b border-gray-50 dark:border-white/5 last:border-none transition-all group">
                                            <div className="text-left flex items-center gap-3">
                                                <div className="h-8 w-8 rounded-lg bg-gray-100 dark:bg-zinc-900 flex items-center justify-center group-hover:bg-white/20"><Package size={14} /></div>
                                                <div>
                                                    <p className="text-[11px] font-black uppercase italic">{p.productName}</p>
                                                    <p className="text-[9px] font-mono opacity-50">#{p.barcode}</p>
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <p className="text-[11px] font-black italic">${formatCurrency(Number(p.purchasePrice))}</p>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        
                        <div className="col-span-6 md:col-span-4">
                            <div className="bg-emerald-500/5 dark:bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-2 h-full shadow-inner flex flex-col gap-1.5">
                                <div className="flex justify-between items-center px-1">
                                    <span className="text-[7px] font-black text-emerald-600 dark:text-emerald-400 uppercase italic tracking-widest leading-none">Proveedor Seleccionado</span>
                                    <Button
                                        isIconOnly
                                        variant="light"
                                        size="sm"
                                        className="h-5 w-5 min-w-unit-0 bg-emerald-500/10 text-emerald-500 rounded-lg"
                                        onPress={() => setIsAddSupplierOpen(true)}
                                    >
                                        <Plus size={12} />
                                    </Button>
                                </div>
                                
                                <div className="flex items-center gap-2">
                                    <Autocomplete
                                        size="sm"
                                        placeholder="SELECCIONAR PROVEEDOR..."
                                        className="flex-1"
                                        defaultItems={[{id: 'none', name: 'SIN PROVEEDOR'}, ...suppliers]}
                                        selectedKey={selectedGlobalSupplier || 'none'}
                                        onSelectionChange={(key) => {
                                            setSelectedGlobalSupplier(String(key || 'none'));
                                            setSelectedOrderId(null);
                                        }}
                                        startContent={<Truck size={14} className="text-emerald-500" />}
                                        inputProps={{
                                            classNames: {
                                                inputWrapper: "h-9 bg-white dark:bg-zinc-900 border-2 border-emerald-500/30 shadow-none rounded-xl data-[focused=true]:border-emerald-500 transition-all px-2 !mask-none",
                                                input: "text-[10px] font-black uppercase italic text-gray-900 dark:text-white !overflow-visible placeholder:text-gray-400"
                                            }
                                        }}
                                        popoverProps={{
                                            classNames: {
                                                content: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-2xl p-1 rounded-xl"
                                            }
                                        }}
                                        listboxProps={{
                                            itemClasses: {
                                                base: "rounded-lg gap-3 data-[hover=true]:bg-emerald-500 data-[hover=true]:text-white",
                                                title: "text-[11px] font-black uppercase italic"
                                            }
                                        }}
                                    >
                                        {(item) => (
                                            <AutocompleteItem key={String(item.id)} textValue={item.name} className="dark:text-white">
                                                <div className="flex items-center gap-2">
                                                    <div className={`w-6 h-6 rounded-lg flex items-center justify-center ${item.id === 'none' ? 'bg-gray-100 dark:bg-zinc-800' : 'bg-emerald-100 dark:bg-emerald-900/30'}`}>
                                                        {item.id === 'none' ? <span className="text-[10px] text-gray-400">-</span> : <Truck size={12} className="text-emerald-500" />}
                                                    </div>
                                                    <span className="font-bold text-[10px]">{item.name}</span>
                                                </div>
                                            </AutocompleteItem>
                                        )}
                                    </Autocomplete>
                                
                                    <Button
                                        isIconOnly
                                        variant="flat"
                                        className={`h-9 w-9 min-w-unit-0 rounded-xl border transition-all ${selectedGlobalSupplier !== 'none' ? 'bg-amber-500/10 text-amber-500 border-amber-500/20 shadow-lg shadow-amber-500/10' : 'bg-gray-100 dark:bg-zinc-800 text-gray-400 border-transparent opacity-50'}`}
                                        onPress={fetchPendingOrders}
                                        isDisabled={selectedGlobalSupplier === 'none'}
                                    >
                                        <ShoppingBag size={16} />
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* BARRA DE ACCIÓN FIJA INFERIOR - Solo móvil */}
                <div className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-between gap-2 p-2.5 px-3 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-2xl border-t border-gray-200 dark:border-white/10 shadow-[0_-15px_40px_rgba(0,0,0,0.2)] md:hidden">
                    <div className="flex items-center gap-1.5 bg-gray-100/50 dark:bg-white/5 p-1 rounded-2xl border border-gray-200 dark:border-white/5">
                        <Button isIconOnly variant="light" onPress={() => loadData()} className="h-9 w-9 text-gray-400 dark:text-emerald-500 rounded-xl">
                            <RefreshCw size={16} />
                        </Button>
                        {receiveList.length > 0 && (
                            <Button isIconOnly variant="light" onPress={() => setIsClearConfirmOpen(true)} className="h-9 w-9 text-rose-500 rounded-xl">
                                <Trash2 size={16} />
                            </Button>
                        )}
                    </div>

                    <Button onPress={() => setIsScannerOpen(true)} className="h-10 px-4 bg-emerald-500 text-white rounded-2xl shadow-lg flex-1 max-w-[120px] gap-2">
                        <Camera size={18} />
                        <span className="font-black uppercase text-[10px] italic">Cámara</span>
                    </Button>

                    {/* SINCRONIZAR (DERECHA) */}
                    <div className="flex items-center gap-2">
                        <Button onPress={() => setIsSyncConfirmOpen(true)} isDisabled={receiveList.length === 0 || selectedGlobalSupplier === 'none' || submitting} className={`h-10 px-4 rounded-2xl font-black uppercase text-[10px] gap-2 ${receiveList.length > 0 ? 'bg-gray-900 dark:bg-white text-white dark:text-black' : 'bg-gray-200 dark:bg-zinc-800 text-gray-500'}`}>
                            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={16} />}
                            <span className="flex flex-col items-start leading-none">
                                <span>SINCRONIZAR</span>
                                {receiveList.length > 0 && <span className="text-[7px] opacity-60">({receiveList.length})</span>}
                            </span>
                        </Button>
                    </div>
                </div>

                {/* CONTENT AREA */}
                <div className="flex-1 min-h-0 px-2 pt-1.5 pb-0 bg-gray-100 dark:bg-[#09090b] relative overflow-hidden flex flex-col">
                    {submitting && (
                        <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-white/80 dark:bg-black/90 backdrop-blur-sm gap-4 transition-all">
                            <Spinner color="success" size="lg" />
                            <p className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.4em] animate-pulse italic">Sincronizando Inventario...</p>
                        </div>
                    )}
                    
                    <div className="flex-1 flex flex-col gap-2 min-h-0 relative">
                        {/* STATS ROW */}
                        <div className="shrink-0 p-1.5 lg:p-0 grid grid-cols-2 md:grid-cols-4 gap-1.5">
                            {stats.map((k, i) => (
                                <div 
                                    key={i} 
                                    className="relative overflow-hidden group bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 p-1.5 px-2 rounded-lg flex flex-col justify-center shadow-sm transition-all hover:border-emerald-500/30 active:scale-95 cursor-pointer h-[62px]"
                                >
                                    <div className="absolute inset-x-0 bottom-0 h-4 opacity-10 pointer-events-none">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <AreaChart data={k.data}>
                                                <Area type="monotone" dataKey="val" stroke={k.color} fill={k.color} fillOpacity={1} strokeWidth={2}/>
                                            </AreaChart>
                                        </ResponsiveContainer>
                                    </div>

                                    <div className="flex justify-between items-start z-10 w-full mb-0.5">
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-[7px] font-black text-gray-400 dark:text-zinc-500 uppercase italic leading-none mb-0.5 truncate">{k.label}</span>
                                            <span className="text-[13px] md:text-sm font-black tabular-nums tracking-tighter leading-none text-gray-900 dark:text-white italic truncate">
                                                {k.val}
                                            </span>
                                        </div>
                                        <div className="p-1 rounded-md shrink-0 ml-1" style={{ backgroundColor: `${k.color}20`, color: k.color }}>
                                            <k.icon size={10} />
                                        </div>
                                    </div>

                                    <div className="z-10 flex items-center gap-1">
                                         <div className="h-0.5 w-0.5 rounded-full" style={{ backgroundColor: k.color }} />
                                         <p className="text-[6px] font-black text-gray-500 dark:text-zinc-500 uppercase italic leading-none truncate tracking-tighter">{k.desc}</p>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* TABLE AREA */}
                        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                            <div className="flex-1 bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-white/5 shadow-sm overflow-hidden flex flex-col">
                                {receiveList.length === 0 ? (
                                    <div className="flex-1 flex flex-col items-center justify-center opacity-20 text-zinc-500">
                                        <Package size={80} strokeWidth={0.5} />
                                        <p className="text-[12px] font-black uppercase tracking-[0.5em] mt-4 italic">Lista Vacía</p>
                                        <p className="text-[9px] font-medium uppercase tracking-wider mt-2">Escanee o busque productos para iniciar</p>
                                    </div>
                                ) : (
                                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar scroll-smooth">
                                        <div className="divide-y divide-gray-100 dark:divide-white/5 pb-[180px]">
                                            {receiveList.map((item) => (
                                                <ReceptionRow 
                                                    key={item.barcode}
                                                    item={item}
                                                    onUpdate={updateItem}
                                                    onDelete={deleteItem}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

            <ScannerOverlay
                isOpen={isScannerOpen}
                onClose={() => {
                    setIsScannerOpen(false);
                    setScannedNotFoundCode('');
                }}
                errorTitle={scannedNotFoundCode ? "Producto Desconocido" : undefined}
                errorMessage={scannedNotFoundCode ? `Código #${scannedNotFoundCode} no identificado.` : undefined}
                onIgnoreError={() => {
                    setScannedNotFoundCode('');
                    setIsScannerOpen(false);
                    setTimeout(() => setIsScannerOpen(true), 10);
                }}
                onCreateProduct={() => {
                    router.push(`/products?action=new&barcode=${scannedNotFoundCode}`);
                }}
                onResult={(res) => {
                    const p = products.find(prod => prod.barcode === res);
                    if (p) { 
                        addToReceive(p); 
                        playScanSound('success');
                    } else {
                        setScannedNotFoundCode(res);
                        playScanSound('error');
                    }
                }}
            />

            <Modal isOpen={isClearConfirmOpen} onOpenChange={setIsClearConfirmOpen} backdrop="blur">
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="font-black uppercase italic">Limpiar Lista</ModalHeader>
                            <ModalBody className="text-sm font-medium">¿Estás seguro de que deseas eliminar todos los productos de la lista actual? Esta acción no se puede deshacer.</ModalBody>
                            <ModalFooter>
                                <Button variant="flat" onPress={onClose} className="font-black uppercase italic text-xs">Cancelar</Button>
                                <Button color="danger" onPress={handleClearList} className="font-black uppercase italic text-xs">Limpiar Todo</Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

            {/* MODAL DE ÓRDENES PENDIENTES */}
            <Modal 
                isOpen={isOrderModalOpen} 
                onOpenChange={setIsOrderModalOpen} 
                size="xl"
                scrollBehavior="inside"
                backdrop="blur"
            >
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex flex-col gap-1 p-6">
                                <div className="flex items-center gap-2">
                                    <ShoppingBag className="text-emerald-500" size={24} />
                                    <h2 className="text-xl font-black uppercase italic">Órdenes Pendientes</h2>
                                </div>
                                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">Selecciona una orden para cargar productos</p>
                            </ModalHeader>
                            <ModalBody className="p-6">
                                {isLoadingOrders ? (
                                    <div className="h-40 flex items-center justify-center">
                                        <Spinner color="success" />
                                    </div>
                                ) : pendingOrders.length === 0 ? (
                                    <div className="h-40 flex flex-col items-center justify-center text-gray-400 gap-4">
                                        <div className="bg-gray-100 dark:bg-zinc-900 p-4 rounded-full">
                                            <Package size={40} strokeWidth={1} />
                                        </div>
                                        <p className="text-xs font-black uppercase italic">No hay órdenes pendientes para este proveedor</p>
                                    </div>
                                ) : (
                                    <div className="grid gap-3">
                                        {pendingOrders.map((order) => (
                                            <button 
                                                key={order.id}
                                                onClick={() => loadOrderIntoList(order)}
                                                className="w-full flex items-center justify-between p-4 rounded-2xl border border-gray-200 dark:border-white/5 hover:border-emerald-500 transition-all bg-white dark:bg-zinc-900 group"
                                            >
                                                <div className="flex flex-col text-left">
                                                    <span className="text-xs font-black uppercase italic">Orden #{order.id}</span>
                                                    <span className="text-[10px] text-gray-400 font-bold">
                                                        {new Date(order.createdAt).toLocaleDateString()} - {order.orderItems.length} ítems
                                                    </span>
                                                </div>
                                                <div className="flex flex-col items-end">
                                                    <span className="text-sm font-black text-emerald-500 italic">${formatCurrency(order.estimatedCost)}</span>
                                                    <div className="flex items-center gap-1 text-[9px] text-gray-400 group-hover:text-emerald-500 transition-colors">
                                                        <span className="uppercase font-bold">Cargar</span>
                                                        <Plus size={12} />
                                                    </div>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </ModalBody>
                            <ModalFooter className="bg-gray-50/50 dark:bg-zinc-900/50 p-4 border-t border-gray-100 dark:border-white/5">
                                <Button 
                                    variant="flat" 
                                    onPress={onClose}
                                    className="bg-gray-100 dark:bg-zinc-800 text-gray-700 dark:text-zinc-300 font-black uppercase text-xs"
                                >
                                    Cerrar
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>
            <SupplierFormModal 
                isOpen={isAddSupplierOpen} 
                onOpenChange={setIsAddSupplierOpen} 
                onSave={handleCreateSupplier} 
                isEdit={false} 
            />
            {/* MODAL DE CONFIRMACIÓN DE SINCRONIZACIÓN */}
            <Modal 
                isOpen={isSyncConfirmOpen} 
                onOpenChange={setIsSyncConfirmOpen}
                backdrop="blur"
                classNames={{
                    base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/5 shadow-2xl rounded-3xl",
                    header: "border-b border-gray-100 dark:border-white/5",
                    footer: "border-t border-gray-100 dark:border-white/5",
                }}
            >
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex flex-col gap-1 p-6">
                                <div className="flex items-center gap-3">
                                    <div className="bg-emerald-500/10 p-2 rounded-xl text-emerald-500">
                                        <Package size={24} />
                                    </div>
                                    <div className="flex flex-col">
                                        <span className="text-xl font-black text-gray-900 dark:text-white uppercase italic tracking-tight">Confirmar Sincronización</span>
                                        <span className="text-[10px] text-gray-400 dark:text-zinc-500 uppercase font-bold tracking-widest italic">Carga Maestra v9.0</span>
                                    </div>
                                </div>
                            </ModalHeader>
                            <ModalBody className="p-6 pb-2">
                                <div className="flex flex-col gap-4">
                                    <div className="p-4 bg-gray-50 dark:bg-zinc-900/50 rounded-2xl border border-gray-100 dark:border-white/5">
                                        <p className="text-sm text-gray-600 dark:text-zinc-400 leading-relaxed font-medium">
                                            Estás a punto de sincronizar la carga de <span className="text-gray-900 dark:text-white font-black underline decoration-emerald-500/30 underline-offset-4">{receiveList.length} referencias</span> al inventario global.
                                        </p>
                                    </div>

                                    {bypassExpense && (
                                        <div className="p-4 bg-rose-500/10 border-2 border-rose-500/50 rounded-2xl flex items-start gap-3 animate-pulse shadow-[0_0_15px_rgba(244,63,94,0.1)]">
                                            <AlertTriangle className="text-rose-500 shrink-0 mt-0.5" size={24} />
                                            <div className="flex flex-col">
                                                <span className="text-[12px] font-black text-rose-600 dark:text-rose-500 uppercase italic tracking-wider">⚠️ ALERTA DE CAJA: BYPASS ACTIVADO</span>
                                                <p className="text-[11px] font-bold text-rose-600/90 dark:text-rose-400 leading-tight mt-1">
                                                    Solo se actualizará el inventario físico. <span className="underline decoration-2">NO se registrará salida de dinero</span> ni egresos en la contabilidad.
                                                </p>
                                            </div>
                                        </div>
                                    )}

                                    {!bypassExpense && (
                                        <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl flex items-start gap-3 shadow-sm">
                                            <ShieldCheck className="text-emerald-500 shrink-0 mt-0.5" size={24} />
                                            <div className="flex flex-col">
                                                <span className="text-[12px] font-black text-emerald-600 dark:text-emerald-500 uppercase italic">CONTABILIDAD SINCRONIZADA</span>
                                                <p className="text-[11px] font-bold text-emerald-600/80 dark:text-emerald-500/70 leading-tight mt-1">
                                                    Se generará un egreso automático en caja por el valor total. Flujo contable estándar activo.
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </ModalBody>
                            <ModalFooter className="p-6 pt-4 gap-3">
                                <Button 
                                    variant="flat" 
                                    onPress={onClose}
                                    className="h-12 flex-1 rounded-2xl font-black uppercase text-[11px] tracking-widest text-gray-400 bg-gray-100 dark:bg-zinc-900 transition-all hover:bg-gray-200 dark:hover:bg-zinc-800"
                                >
                                    Cancelar
                                </Button>
                                <Button 
                                    onPress={() => {
                                        onClose();
                                        handleConfirmReceive();
                                    }}
                                    className="h-12 flex-1 rounded-2xl font-black uppercase text-[11px] tracking-widest bg-gray-900 dark:bg-white text-white dark:text-black shadow-xl transition-all active:scale-95"
                                >
                                    Sincronizar Ahora
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>
        </div>
    </div>
}