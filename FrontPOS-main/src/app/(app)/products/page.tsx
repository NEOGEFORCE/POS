"use client";

import { useState, useMemo, useEffect, useCallback } from 'react';
import { Button, Input, Spinner, Autocomplete, AutocompleteItem } from "@heroui/react";
import {
    Package, Search, AlertTriangle, PlusCircle, RefreshCw, Barcode, Warehouse, ShoppingBag, ShieldCheck, Camera, FileUp, FileDown
} from 'lucide-react';
import nextDynamic from 'next/dynamic';
import { broadcastRevalidate, setupSyncListener } from '@/lib/revalidate';
import { useToast } from '@/hooks/use-toast';
import { useApi } from '@/hooks/use-api';
import { Product, Category } from '@/lib/definitions';
import { applyRounding, formatCurrency, parseCurrency, sanitizeProductPayload, getStockStatus, normalizeText } from '@/lib/utils';
import Cookies from 'js-cookie';
import { apiFetch, ApiError } from '@/lib/api-error';
import { useAuth } from '@/lib/auth';

// COMPONENTES DINAMICOS PREMIUM
const ProductStats = nextDynamic(() => import('./components/ProductStats'), { ssr: false });
const ProductTable = nextDynamic(() => import('./components/ProductTable'), { ssr: false });
const ProductFormModal = nextDynamic(() => import('./components/ProductFormModal'), { ssr: false });
const InventoryAlertsModal = nextDynamic(() => import('./components/InventoryAlertsModal'), { ssr: false });
const DeleteProtocolModal = nextDynamic(() => import('./components/DeleteProtocolModal'), { ssr: false });
const ScannerOverlay = nextDynamic(() => import('@/components/ScannerOverlay').then(m => m.ScannerOverlay), { ssr: false });
const ConfirmDialog = nextDynamic(() => import('@/components/ConfirmDialog').then(m => m.ConfirmDialog), { ssr: false });
import { ErrorBoundary } from '@/components/ErrorBoundary';

const formatCOP = (val: number | string): string => {
    if (val === undefined || val === null || val === '') return '0';
    const num = typeof val === 'string' ? parseFloat(val.replace(/[^\d.]/g, '')) : val;
    return isNaN(num) ? '0' : num.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};

export default function ProductsPage() {
    const { user } = useAuth();
    const isAdmin = useMemo(() => {
        const role = user?.role?.toLowerCase() || user?.Role?.toLowerCase() || "";
        return role === "admin" || role === "superadmin" || role === "administrador";
    }, [user]);

    const canManage = useMemo(() => {
        const role = user?.role?.toLowerCase() || user?.Role?.toLowerCase() || "";
        return role === "admin" || role === "superadmin" || role === "administrador" || role === "empleado" || role === "employee";
    }, [user]);

    const { toast } = useToast();
    const [pageSize, setPageSize] = useState(25);
    const [currentPage, setCurrentPage] = useState(1);
    const [filter, setFilter] = useState('');
    const [searchTerm, setSearchTerm] = useState('');

    // DEBOUNCE LOGIC: Evita que la pantalla parpadee por cada letra presionada
    useEffect(() => {
        const handler = setTimeout(() => {
            const normalized = searchTerm.toUpperCase()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, (match) => (match === '\u0303' ? match : ''))
                .normalize("NFC");
            setFilter(normalized);
            setCurrentPage(1);
        }, 500);
        return () => clearTimeout(handler);
    }, [searchTerm]);

    const [selectedSupplierId, setSelectedSupplierId] = useState<string>('');
    const [stockFilter, setStockFilter] = useState<'all' | 'critical' | 'warning'>('all');

    // Resetear pagina al cambiar proveedor o filtro de stock
    useEffect(() => {
        setCurrentPage(1);
    }, [selectedSupplierId, stockFilter]);

    const { data: productsData, isLoading: productsLoading, mutate: mutateProducts } = useApi<any>(
        `/products/paginated?page=${currentPage}&pageSize=${pageSize}${filter ? `&q=${filter}` : ''}${selectedSupplierId ? `&supplierId=${selectedSupplierId}` : ''}${stockFilter !== 'all' ? `&stockFilter=${stockFilter}` : ''}`
    );
    const { data: categoriesData, mutate: mutateCategories } = useApi<Category[]>('/categories/all-categories');
    const { data: suppliersData, mutate: mutateSuppliers } = useApi<any[]>('/suppliers/all-suppliers');
    
    // --- ESTADOS ---
    const [addDialogOpen, setAddDialogOpen] = useState(false);
    const [editDialogOpen, setEditDialogOpen] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [alertsDialogOpen, setAlertsDialogOpen] = useState(false);
    const [isScannerOpen, setIsScannerOpen] = useState(false);
    const [scanMode, setScanMode] = useState<'main' | 'alternate' | 'search' | 'baseProduct'>('main');

    // Solo descargar los 1275+ productos cuando se abra el modal de edicion/creacion para autocompletado
    const { data: allProductsData, mutate: mutateAllProducts } = useApi<Product[]>(
        addDialogOpen || editDialogOpen ? '/products/all-products' : null
    );
    const { data: statsData, mutate: mutateStats } = useApi<any>('/products/stats');

    const [newProduct, setNewProduct] = useState<Omit<Product, 'id'>>({
        barcode: '', productName: '', quantity: '' as any, isWeighted: false,
        purchasePrice: '' as any, salePrice: '' as any, categoryId: 0, marginPercentage: 20,
        minStock: '' as any,
        packMultiplier: '' as any
    });
    const [editingProduct, setEditingProduct] = useState<Product | null>(null);
    const [originalBarcode, setOriginalBarcode] = useState<string | null>(null);
    const [deletingBarcode, setDeletingBarcode] = useState<string | null>(null);
    const [apiFieldErrors, setApiFieldErrors] = useState<Record<string, string>>({});

    // --- ESTADO CONFIRMACION PERSONALIZADA ---
    const [isBulkConfirmOpen, setIsBulkConfirmOpen] = useState(false);
    const [bulkProductToOpen, setBulkProductToOpen] = useState<Product | null>(null);

    // --- PERSISTENCIA DE BORRADORES ---
    useEffect(() => {
        const saved = localStorage.getItem('product-form-draft');
        if (saved) {
            try {
                const draft = JSON.parse(saved);
                setNewProduct(prev => ({ ...prev, ...draft }));
            } catch (e) {
                console.error("Error loading product draft", e);
            }
        }
    }, []);

    // SINCRONIZACION ZERO-F5
    useEffect(() => {
        let timeout: NodeJS.Timeout;
        const cleanup = setupSyncListener((event) => {
            if (event === 'PRODUCT_UPDATE' || event === 'SALE_MADE' || event === 'DASHBOARD_UPDATE' || event === 'CATEGORY_UPDATE' || event === 'SUPPLIER_UPDATE' || event === 'STOCK_UPDATE') {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    mutateProducts();
                    mutateAllProducts();
                    mutateStats();
                }, 800);
            }
        });
        return () => {
            cleanup();
            clearTimeout(timeout);
        };
    }, [mutateProducts, mutateAllProducts, mutateStats]);

    useEffect(() => {
        if (addDialogOpen) {
            localStorage.setItem('product-form-draft', JSON.stringify(newProduct));
        }
    }, [newProduct, addDialogOpen]);

    const products: Product[] = useMemo(() => productsData?.items || [], [productsData]);
    const totalItems = productsData?.total || 0;
    const totalPages = Math.ceil(totalItems / pageSize) || 1;

    const stats = useMemo(() => {
        if (statsData) {
            return statsData;
        }
        return {
            totalCost: 0,
            totalRetail: 0,
            criticalStock: 0,
            warningStock: 0,
            totalItems: productsData?.total || 0
        };
    }, [statsData, productsData]);
    
    useEffect(() => {
        if (addDialogOpen && editingProduct) {
            setAddDialogOpen(false);
            setEditDialogOpen(true);
        }
    }, [addDialogOpen, editingProduct]);

    const handleAddProduct = async () => {
        const token = Cookies.get('org-pos-token');
        setApiFieldErrors({});
        try {
            const rawData = {
                ...newProduct,
                productName: normalizeText(newProduct.productName),
                barcode: normalizeText(newProduct.barcode),
            };
            const data = sanitizeProductPayload(rawData);

            await apiFetch('/products/create-products', {
                method: 'POST', body: JSON.stringify(data), fallbackError: 'FALLO AL CREAR PRODUCTO'
            }, token!);
            toast({ variant: 'success', title: 'EXITO', description: 'REFERENCIA SINCRONIZADA.' });
            setAddDialogOpen(false);
            localStorage.removeItem('product-form-draft');
            setNewProduct({ barcode: '', productName: '', quantity: '' as any, isWeighted: false, purchasePrice: '' as any, salePrice: '' as any, categoryId: 0, marginPercentage: 20, minStock: '' as any, packMultiplier: '' as any });
            mutateProducts();
            mutateAllProducts();
            mutateStats();
            broadcastRevalidate('PRODUCT_UPDATE');
        } catch (err: any) {
            if (err instanceof ApiError && err.status === 409) {
                toast({ variant: 'destructive', title: 'PRODUCTO DUPLICADO', description: 'El codigo ya pertenece a un producto activo.' });
                return;
            }
            if (err instanceof ApiError && err.status === 400 && err.data?.error?.fields) {
                setApiFieldErrors(err.data.error.fields);
                toast({ variant: 'destructive', title: 'ERROR DE VALIDACION', description: 'Revisa los campos marcados en rojo' });
            } else {
                toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO EN OPERACION' });
            }
        }
    };

    const handleEditProduct = async () => {
        if (!editingProduct) return;
        const token = Cookies.get('org-pos-token');
        setApiFieldErrors({});
        try {
            const payloadToSanitize = {
                ...editingProduct,
                productName: normalizeText(editingProduct.productName),
                barcode: normalizeText(editingProduct.barcode),
            };
            const payload = sanitizeProductPayload(payloadToSanitize);
            const urlBarcode = originalBarcode || editingProduct.barcode;

            await apiFetch(`/products/update-products/${urlBarcode}`, {
                method: 'PUT', body: JSON.stringify(payload), fallbackError: 'FALLO AL ACTUALIZAR'
            }, token!);
            toast({ variant: 'success', title: 'EXITO', description: 'REGISTRO ACTUALIZADO' });
            setEditDialogOpen(false);
            setEditingProduct(null);
            mutateProducts();
            mutateAllProducts();
            mutateStats();
            broadcastRevalidate('PRODUCT_UPDATE');
        } catch (err: any) {
            if (err instanceof ApiError && err.status === 400 && err.data?.error?.fields) {
                setApiFieldErrors(err.data.error.fields);
                toast({ variant: 'destructive', title: 'ERROR DE VALIDACION', description: 'Revisa los campos marcados en rojo' });
            } else {
                toast({ variant: 'destructive', title: 'ERROR', description: err.message });
            }
        }
    };

    const handleDelete = async () => {
        if (!deletingBarcode) return;
        const token = Cookies.get('org-pos-token');
        try {
            await apiFetch(`/products/delete-products/${deletingBarcode}`, {
                method: 'DELETE', fallbackError: 'FALLO AL ELIMINAR'
            }, token!);
            toast({ variant: 'success', title: 'EXITO', description: 'PRODUCTO ELIMINADO' });
            setDeleteDialogOpen(false);
            mutateProducts();
            mutateAllProducts();
            mutateStats();
            broadcastRevalidate('PRODUCT_UPDATE');
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message });
        }
    };

    const [loadingBarcodes, setLoadingBarcodes] = useState<Set<string>>(new Set());

    const handleQuickStockUpdate = useCallback(async (barcode: string, amount: number) => {
        const token = Cookies.get('org-pos-token');
        setLoadingBarcodes(prev => new Set(prev).add(barcode));

        try {
            await apiFetch(`/products/adjust/${barcode}`, {
                method: 'PATCH', body: JSON.stringify({ amount }), fallbackError: 'FALLO AL AJUSTAR'
            }, token!);
            mutateProducts();
            mutateStats();
            broadcastRevalidate('PRODUCT_UPDATE');
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message });
        } finally {
            setLoadingBarcodes(prev => {
                const next = new Set(prev);
                next.delete(barcode);
                return next;
            });
        }
    }, [toast, mutateProducts, mutateStats]);

    const handleOpenBulk = useCallback(async (product: Product) => {
        setBulkProductToOpen(product);
        setIsBulkConfirmOpen(true);
    }, []);

    const confirmOpenBulk = async () => {
        if (!bulkProductToOpen) return;
        const token = Cookies.get('org-pos-token');
        try {
            await apiFetch(`/products/open-bulk/${bulkProductToOpen.barcode}`, { method: 'POST' }, token!);
            toast({ variant: 'success', title: 'PACA ABIERTA', description: 'STOCK AJUSTADO.' });
            mutateProducts();
            mutateAllProducts();
            mutateStats();
            broadcastRevalidate('PRODUCT_UPDATE');
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message });
        } finally {
            setBulkProductToOpen(null);
        }
    };

    const handleExportCSV = async () => {
        const token = Cookies.get('org-pos-token');
        try {
            const response = await fetch(`${(process.env.NEXT_PUBLIC_API_URL || '/api')}/products/export-csv`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) throw new Error("Fallo la exportacion");
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `catalogo_${new Date().toISOString().split('T')[0]}.csv`;
            a.click();
            toast({ variant: 'success', title: 'EXITO', description: 'CATALOGO DESCARGADO.' });
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message });
        }
    };

    const handleImportCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const token = Cookies.get('org-pos-token');
        const formData = new FormData();
        formData.append('file', file);

        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/import-csv`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            });

            const result = await response.json();
            if (!response.ok) throw new Error(result.error?.message || "Fallo en importacion");

            toast({ 
                variant: 'success', 
                title: 'IMPORTACION COMPLETADA', 
                description: `Se procesaron ${result.total} productos. EXITOs: ${result.success}.` 
            });

            if (result.errors && result.errors.length > 0) {
                console.error("Errores de importacion:", result.errors);
                toast({
                    variant: 'destructive',
                    title: 'ADVERTENCIA',
                    description: `Hubo ${result.errors.length} errores. Revisa la consola para mas detalles.`
                });
            }

            mutateProducts();
            mutateAllProducts();
            broadcastRevalidate('PRODUCT_UPDATE');
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message });
        }
        
        // Limpiar el input para permitir importar el mismo archivo de nuevo
        e.target.value = '';
    };

    const handleEdit = useCallback((p: Product) => {
        setOriginalBarcode(p.barcode);
        setEditingProduct(p);
        setEditDialogOpen(true);
    }, []);

    const handleScannerResult = useCallback((code: string) => {
        const b = code.toUpperCase().trim();
        if (scanMode === 'search') {
            setSearchTerm(b);
            setFilter(b);
        } else if (scanMode === 'main') {
            if (addDialogOpen) setNewProduct(p => ({ ...p, barcode: b }));
            else if (editDialogOpen) setEditingProduct(p => p ? ({ ...p, barcode: b }) : null);
        } else if (scanMode === 'alternate') {
            if (addDialogOpen) {
                setNewProduct(prev => ({ ...prev, alternateCodes: prev.alternateCodes ? `${prev.alternateCodes}, ${b}` : b }));
            } else if (editDialogOpen) {
                setEditingProduct(prev => prev ? ({ ...prev, alternateCodes: prev.alternateCodes ? `${prev.alternateCodes}, ${b}` : b }) : null);
            }
        } else if (scanMode === 'baseProduct') {
            if (addDialogOpen) {
                setNewProduct(prev => ({ ...prev, baseProductBarcode: b }));
            } else if (editDialogOpen) {
                setEditingProduct(prev => prev ? ({ ...prev, baseProductBarcode: b }) : null);
            }
        }
        setIsScannerOpen(false);
    }, [addDialogOpen, editDialogOpen, scanMode]);

    return (
        <div className="flex flex-col flex-1 min-h-0 h-full w-full max-w-[1600px] mx-auto overflow-hidden bg-transparent text-zinc-900 dark:text-zinc-50 relative">
            <div className="shrink-0 px-4 pt-1 pb-1 flex flex-col gap-1.5 bg-white dark:bg-zinc-950 border-b border-gray-200 dark:border-white/5">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 h-10 w-10 rounded-2xl text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center justify-center transform -rotate-3">
                            <Package size={20} />
                        </div>
                        <div className="flex flex-col">
                            <h1 className="text-[14px] font-medium tracking-tighter uppercase tracking-tight leading-none">
                                Catalogo <span className="text-zinc-900 dark:text-zinc-100">Maestro</span>
                            </h1>
                            <p className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest tracking-tight mt-1 flex items-center gap-1.5">
                                <ShieldCheck size={12} className="text-zinc-900 dark:text-zinc-100" /> Auditoria de Patrimonio V4.5
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <Button isIconOnly variant="flat" onPress={() => mutateProducts()} className="h-10 w-10 bg-gray-100 dark:bg-[#18181b] text-zinc-900 dark:text-zinc-100 rounded-2xl border border-gray-200 dark:border-white/5">
                            <RefreshCw size={16} />
                        </Button>
                        {canManage && (
                            <div className="flex items-center gap-2">
                                <input
                                    type="file"
                                    id="csv-import"
                                    className="hidden"
                                    accept=".csv"
                                    onChange={handleImportCSV}
                                />
                                <Button variant="flat" onPress={handleExportCSV} className="h-9 px-3 bg-black/5 dark:bg-white/5 text-zinc-900 dark:text-zinc-100 font-medium text-[9px] uppercase tracking-widest tracking-tight rounded-2xl border border-emerald-500/20">
                                    <FileDown size={16} />
                                    <span className="hidden sm:inline ml-2">Exportar CSV</span>
                                </Button>
                                <Button variant="flat" onPress={() => document.getElementById('csv-import')?.click()} className="h-9 px-3 bg-blue-500/10 text-blue-500 font-medium text-[9px] uppercase tracking-widest tracking-tight rounded-2xl border border-blue-500/20">
                                    <FileUp size={16} />
                                    <span className="hidden sm:inline ml-2">Importar CSV</span>
                                </Button>
                                <Button onPress={() => setAddDialogOpen(true)} className="h-9 px-4 bg-emerald-500 text-white font-medium text-[9px] uppercase tracking-widest tracking-tight rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                    <PlusCircle size={16} />
                                    <span className="ml-2">NUEVO PRODUCTO</span>
                                </Button>
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex flex-col md:flex-row items-center gap-1.5">
                    <div className="relative flex-1 w-full group/search">
                        <Input
                            placeholder="ESCANEE O BUSQUE POR REFERENCIA O CATEGORIA..."
                            value={searchTerm}
                            onValueChange={(val) => setSearchTerm(normalizeText(val))}
                            startContent={<Search size={16} className="text-zinc-900 dark:text-zinc-100 ml-2" />}
                            endContent={
                                <div className="flex items-center gap-2 mr-2">
                                    <button onClick={() => { setScanMode('search'); setIsScannerOpen(true); }} className="p-1.5 text-zinc-900 dark:text-zinc-100"><Camera size={18} /></button>
                                    <Barcode size={18} className="text-gray-400" />
                                </div>
                            }
                            classNames={{
                                inputWrapper: "h-11 bg-gray-50 dark:bg-[#18181b] border border-gray-200 dark:border-white/10 rounded-2xl",
                                input: "text-[11px] font-medium tracking-widest tracking-tight uppercase ml-2"
                            }}
                        />
                    </div>

                    <div className="w-full md:w-64">
                        <Autocomplete
                            placeholder="FILTRAR POR PROVEEDOR..."
                            aria-label="Filtrar por proveedor"
                            selectedKey={selectedSupplierId || null}
                            onSelectionChange={(key) => setSelectedSupplierId(key ? String(key) : '')}
                            startContent={<ShoppingBag size={14} className="text-blue-500" />}
                            isClearable
                            onClear={() => setSelectedSupplierId('')}
                            classNames={{
                                base: "h-11",
                                listboxWrapper: "max-h-[300px]",
                                selectorButton: "text-gray-400"
                            }}
                            inputProps={{
                                classNames: {
                                    inputWrapper: "h-11 bg-gray-50 dark:bg-[#18181b] border border-gray-200 dark:border-white/10 rounded-2xl",
                                    input: "text-[10px] font-medium tracking-widest tracking-tight uppercase"
                                }
                            }}
                        >
                            {(suppliersData || []).map((s: any) => (
                                <AutocompleteItem key={String(s.id)} textValue={s.name}>
                                    <div className="flex flex-col">
                                        <span className="text-[10px] font-bold uppercase">{s.name}</span>
                                        <span className="text-[8px] text-gray-400 font-medium">{s.contact || 'Sin contacto'}</span>
                                    </div>
                                </AutocompleteItem>
                            ))}
                        </Autocomplete>
                    </div>

                    <Button
                        variant="flat"
                        onPress={() => setStockFilter(prev => prev === 'critical' ? 'all' : 'critical')}
                        className={`h-11 w-full md:w-auto px-6 rounded-2xl font-medium text-[10px] uppercase tracking-widest tracking-tight border transition-all ${
                            stockFilter === 'critical' 
                              ? 'bg-rose-500 text-white border-rose-600 shadow-lg shadow-rose-500/30' 
                              : stats.criticalStock > 0 
                              ? 'bg-rose-500/10 text-rose-500 border-rose-500/30 hover:bg-rose-500/20' 
                              : 'bg-gray-50 dark:bg-[#18181b] text-gray-400 border-gray-200'
                        }`}
                    >
                        <AlertTriangle size={16} className="mr-2" />
                        {stats.criticalStock > 0 ? `${stats.criticalStock} critico${stats.criticalStock > 1 ? 's' : ''}` : 'Sin alertas'}
                    </Button>
                </div>
            </div>

            <div className="px-2 py-1 bg-gray-100 dark:bg-[#09090b] flex flex-col flex-1 min-h-0 overflow-hidden relative">
                {productsLoading && !productsData && (
                    <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center card-base border-none dark:bg-black/90 gap-4">
                        <Spinner color="success" size="lg" />
                        <p className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-widest animate-pulse tracking-tight">Sincronizando Catalogo...</p>
                    </div>
                )}
                <div className="flex flex-col flex-1 min-h-0 overflow-hidden gap-2">
                    <ProductStats {...stats} activeFilter={stockFilter} onSelectFilter={setStockFilter} />
                    
                    {stockFilter !== 'all' && (
                        <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/90 dark:bg-zinc-900 border border-white/10 rounded-xl text-xs shrink-0 animate-in fade-in slide-in-from-top-1 duration-200">
                            <div className="flex items-center gap-2">
                                {stockFilter === 'critical' ? (
                                    <span className="flex items-center gap-1.5 text-rose-400 font-bold uppercase text-[11px] tracking-wider">
                                        <AlertTriangle size={14} className="animate-bounce" />
                                        FILTRO ACTIVO: STOCK CRÍTICO ({totalItems} REFERENCIAS)
                                    </span>
                                ) : (
                                    <span className="flex items-center gap-1.5 text-amber-400 font-bold uppercase text-[11px] tracking-wider">
                                        <AlertTriangle size={14} className="animate-bounce" />
                                        FILTRO ACTIVO: BAJO STOCK ({totalItems} REFERENCIAS)
                                    </span>
                                )}
                            </div>
                            <Button
                                size="sm"
                                variant="flat"
                                onPress={() => setStockFilter('all')}
                                className="h-7 px-3 bg-white/10 hover:bg-white/20 text-white font-semibold text-[10px] uppercase rounded-lg border border-white/10"
                            >
                                ✕ VER TODO EL CATÁLOGO
                            </Button>
                        </div>
                    )}

                    <ProductTable
                        products={products}
                        currentPage={currentPage}
                        totalPages={totalPages}
                        pageSize={pageSize}
                        totalFiltered={totalItems}
                        onEdit={handleEdit}
                        onDelete={(b) => { setDeletingBarcode(b); setDeleteDialogOpen(true); }}
                        onQuickUpdate={handleQuickStockUpdate}
                        onOpenBulk={handleOpenBulk}
                        loadingBarcodes={loadingBarcodes}
                        onPageChange={setCurrentPage}
                        onPageSizeChange={(s) => { setPageSize(s); setCurrentPage(1); }}
                        formatCOP={formatCOP}
                    />
                </div>
            </div>

            <ErrorBoundary>
                <ProductFormModal
                    isOpen={addDialogOpen || editDialogOpen}
                    onOpenChange={(open) => { if (!open) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingProduct(null); setApiFieldErrors({}); } }}
                    addDialogOpen={addDialogOpen}
                    newProduct={newProduct}
                    setNewProduct={setNewProduct}
                    editingProduct={editingProduct}
                    setEditingProduct={setEditingProduct as any}
                    categories={categoriesData || []}
                    suppliers={suppliersData || []}
                    mutateSuppliers={mutateSuppliers}
                    mutateCategories={mutateCategories}
                    allProducts={allProductsData || []}
                    onConfirm={() => addDialogOpen ? handleAddProduct() : handleEditProduct()}
                    onScan={() => { setScanMode('main'); setIsScannerOpen(true); }}
                    onScanAlternate={() => { setScanMode('alternate'); setIsScannerOpen(true); }}
                    onScanBase={() => { setScanMode('baseProduct'); setIsScannerOpen(true); }}
                    apiFieldErrors={apiFieldErrors}
                />
            </ErrorBoundary>

            <DeleteProtocolModal isOpen={deleteDialogOpen} onOpenChange={setDeleteDialogOpen} deletingBarcode={deletingBarcode} onDelete={handleDelete} />
            <InventoryAlertsModal isOpen={alertsDialogOpen} onOpenChange={setAlertsDialogOpen} products={products.filter(p => getStockStatus(p.quantity, p.minStock || 0) === 'CRITICAL')} />
            <ScannerOverlay isOpen={isScannerOpen} onResult={handleScannerResult} onClose={() => setIsScannerOpen(false)} />
            
            <ConfirmDialog 
                isOpen={isBulkConfirmOpen}
                onOpenChange={setIsBulkConfirmOpen}
                title="Confirmar Apertura de Paca"
                description={`Â¿ESTAS SEGURO DE DESTAPAR 1 UNIDAD DE "${bulkProductToOpen?.productName}" PARA VENTA LIBRE?`}
                onConfirm={confirmOpenBulk}
                type="warning"
                confirmText="SI, DESTAPAR"
            />
        </div>
    );
}





