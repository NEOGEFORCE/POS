"use client";

import { useState, useMemo, useEffect, useCallback } from 'react';
import { Button, Input, Spinner } from "@heroui/react";
import {
    Package, Search, AlertTriangle, PlusCircle, RefreshCw, Barcode, Warehouse, ShoppingBag, ShieldCheck, Camera, FileUp, FileDown
} from 'lucide-react';
import nextDynamic from 'next/dynamic';
import { broadcastRevalidate, setupSyncListener } from '@/lib/revalidate';
import { useToast } from '@/hooks/use-toast';
import { useApi } from '@/hooks/use-api';
import { Product, Category } from '@/lib/definitions';
import { applyRounding, formatCurrency, parseCurrency, sanitizeProductPayload, getStockStatus } from '@/lib/utils';
import Cookies from 'js-cookie';
import { apiFetch, ApiError } from '@/lib/api-error';
import { useAuth } from '@/lib/auth';

// COMPONENTES DINÁMICOS PREMIUM
const ProductStats = nextDynamic(() => import('./components/ProductStats'), { ssr: false });
const ProductTable = nextDynamic(() => import('./components/ProductTable'), { ssr: false });
const ProductFormModal = nextDynamic(() => import('./components/ProductFormModal'), { ssr: false });
const InventoryAlertsModal = nextDynamic(() => import('./components/InventoryAlertsModal'), { ssr: false });
const DeleteProtocolModal = nextDynamic(() => import('./components/DeleteProtocolModal'), { ssr: false });
const ScannerOverlay = nextDynamic(() => import('@/components/ScannerOverlay').then(m => m.ScannerOverlay), { ssr: false });

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
            setFilter(searchTerm.toUpperCase());
            setCurrentPage(1);
        }, 500);
        return () => clearTimeout(handler);
    }, [searchTerm]);

    const { data: productsData, isLoading: productsLoading, mutate: mutateProducts } = useApi<any>(
        `/products/paginated?page=${currentPage}&pageSize=${pageSize}${filter ? `&q=${filter}` : ''}`
    );
    const { data: categoriesData, mutate: mutateCategories } = useApi<Category[]>('/categories/all-categories');
    const { data: suppliersData, mutate: mutateSuppliers } = useApi<any[]>('/suppliers/all-suppliers');
    const { data: allProductsData, mutate: mutateAllProducts } = useApi<Product[]>('/products/all-products');

    // --- ESTADOS ---
    const [addDialogOpen, setAddDialogOpen] = useState(false);
    const [editDialogOpen, setEditDialogOpen] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [alertsDialogOpen, setAlertsDialogOpen] = useState(false);
    const [isScannerOpen, setIsScannerOpen] = useState(false);
    const [scanMode, setScanMode] = useState<'main' | 'alternate' | 'search'>('main');

    const [newProduct, setNewProduct] = useState<Omit<Product, 'id'>>({
        barcode: '', productName: '', quantity: '' as any, isWeighted: false,
        purchasePrice: '' as any, salePrice: '' as any, categoryId: 0, marginPercentage: 20,
        minStock: '' as any,
        packMultiplier: '' as any
    });
    const [newMargin, setNewMargin] = useState(20);
    const [editingProduct, setEditingProduct] = useState<Product | null>(null);
    const [editMargin, setEditMargin] = useState(20);
    const [originalBarcode, setOriginalBarcode] = useState<string | null>(null);
    const [deletingBarcode, setDeletingBarcode] = useState<string | null>(null);
    const [apiFieldErrors, setApiFieldErrors] = useState<Record<string, string>>({});

    // --- PERSISTENCIA DE BORRADORES (Tarea 4) ---
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

    // SINCRONIZACIÓN ZERO-F5: Escuchar cambios globales (con blindaje contra parpadeo)
    useEffect(() => {
        let timeout: NodeJS.Timeout;
        const cleanup = setupSyncListener((event) => {
            if (event === 'PRODUCT_UPDATE' || event === 'SALE_MADE' || event === 'DASHBOARD_UPDATE' || event === 'CATEGORY_UPDATE' || event === 'SUPPLIER_UPDATE' || event === 'STOCK_UPDATE') {
                // Pequeño delay de 800ms para evitar que la revalidación SSE 
                // "pise" a una mutación optimista local que aún está en vuelo.
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    mutateProducts();
                    mutateAllProducts();
                }, 800);
            }
        });
        return () => {
            cleanup();
            clearTimeout(timeout);
        };
    }, [mutateProducts, mutateAllProducts]);

    useEffect(() => {
        if (addDialogOpen) {
            localStorage.setItem('product-form-draft', JSON.stringify(newProduct));
        }
    }, [newProduct, addDialogOpen]);

    // Paginación y Filtrado 
    const products: Product[] = useMemo(() => productsData?.items || [], [productsData]);
    const totalItems = productsData?.total || 0;
    const totalPages = Math.ceil(totalItems / pageSize) || 1;

    const stats = useMemo(() => {
        const source = allProductsData || [];
        const cost = source.reduce((acc, p) => acc + (p.isWeighted ? 0 : (p.quantity * p.purchasePrice)), 0);
        const retail = source.reduce((acc, p) => acc + (p.isWeighted ? 0 : (p.quantity * p.salePrice)), 0);
        const margin = cost > 0 ? ((retail - cost) / retail) * 100 : 0;
        const totalItems = productsData?.total || source.length;

        // Semáforo dinámico v2.0: contar críticos (rojo) y advertencias (reorden)
        const criticalCount = products.filter(p => {
            if (p.isWeighted) return false;
            return getStockStatus(p.quantity, p.minStock || 0) === 'CRITICAL';
        }).length;

        const warningCount = products.filter(p => {
            if (p.isWeighted) return false;
            return getStockStatus(p.quantity, p.minStock || 0) === 'REORDER';
        }).length;

        return {
            totalCost: cost,
            totalRetail: retail,
            criticalStock: criticalCount,
            warningStock: warningCount,
            totalItems: totalItems
        };
    }, [products]);
    
    // Switch automático de Crear -> Editar si se detecta producto existente
    useEffect(() => {
        if (addDialogOpen && editingProduct) {
            setAddDialogOpen(false);
            setEditDialogOpen(true);
            // Sincronizar margen
            setEditMargin(editingProduct.marginPercentage || 20);
        }
    }, [addDialogOpen, editingProduct]);

    const handleAddProduct = async () => {
        const token = Cookies.get('org-pos-token');
        setApiFieldErrors({}); // Limpiar errores previos
        try {
            const rawData = {
                ...newProduct,
                productName: newProduct.productName.toUpperCase().trim(),
                barcode: newProduct.barcode.toUpperCase().trim(),
                alternateCodes: newProduct.alternateCodes,
                suppliers: (newProduct as any).suppliers || []
            };
            const data = sanitizeProductPayload(rawData);

            await apiFetch('/products/create-products', {
                method: 'POST', body: JSON.stringify(data), fallbackError: 'FALLO AL CREAR PRODUCTO'
            }, token!);
            toast({ variant: 'success', title: 'ÉXITO', description: 'REFERENCIA SINCRONIZADA.' });
            setAddDialogOpen(false);
            localStorage.removeItem('product-form-draft'); // Limpieza estricta solo tras éxito
            setNewProduct({ barcode: '', productName: '', quantity: '' as any, isWeighted: false, purchasePrice: '' as any, salePrice: '' as any, categoryId: 0, marginPercentage: 20, minStock: '' as any, packMultiplier: '' as any });
            mutateProducts();
            mutateAllProducts();
            broadcastRevalidate('PRODUCT_UPDATE');
        } catch (err: any) {
            console.error('ERROR EN CREACIÓN:', err);

            // Manejar Conflict (Duplicado o Inactivo)
            if (err instanceof ApiError && err.status === 409) {
                const existingData = err.data?.error?.data || err.data || {};
                const isActive = existingData.is_active ?? true;
                const barcode = existingData.barcode || newProduct.barcode;

                toast({
                    variant: 'destructive',
                    title: 'PRODUCTO DUPLICADO',
                    description: isActive
                        ? `El código "${barcode}" ya pertenece a un producto activo.`
                        : `Existe un registro inactivo para "${barcode}". ¿Deseas reactivarlo?`,
                    action: !isActive ? (
                        <Button
                            size="sm"
                            color="success"
                            className="font-black text-[9px] uppercase"
                            onPress={async () => {
                                try {
                                    await apiFetch(`/products/update-products/${barcode}`, {
                                        method: 'PUT',
                                        body: JSON.stringify({ barcode, isActive: true }),
                                    }, token!);
                                    toast({ title: 'ÉXITO', description: 'PRODUCTO REACTIVADO' });
                                    setAddDialogOpen(false);
                                    mutateProducts();
                                    mutateAllProducts();
                                    broadcastRevalidate('PRODUCT_UPDATE');
                                } catch (e: any) {
                                    toast({ variant: 'destructive', title: 'ERROR', description: 'FALLO AL REACTIVAR' });
                                }
                            }}
                        >
                            REACTIVAR
                        </Button>
                    ) : undefined
                });
                return;
            }

            // Manejar errores de validación del backend (400 con campos específicos)
            if (err instanceof ApiError && err.status === 400 && err.data?.error?.fields) {
                setApiFieldErrors(err.data.error.fields);
                toast({ variant: 'destructive', title: 'ERROR DE VALIDACIÓN', description: 'Revisa los campos marcados en rojo' });
            } else {
                toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO EN OPERACIÓN' });
            }
        }
    };

    const handleEditProduct = async () => {
        if (!editingProduct) return;
        const token = Cookies.get('org-pos-token');
        setApiFieldErrors({}); // Limpiar errores previos
        try {
            // Limpiar payload: remover objetos anidados y sanitizar números
            const rawPayload = {
                barcode: editingProduct.barcode,
                productName: editingProduct.productName,
                quantity: editingProduct.quantity,
                isWeighted: editingProduct.isWeighted,
                purchasePrice: editingProduct.purchasePrice,
                marginPercentage: editingProduct.marginPercentage,
                salePrice: editingProduct.salePrice,
                categoryId: Number(editingProduct.categoryId) || 0,
                supplierId: Number(editingProduct.supplierId) || 0,
                imageUrl: editingProduct.imageUrl,
                alternateCodes: editingProduct.alternateCodes, // Nuevo campo
                minStock: editingProduct.minStock,
                iva: editingProduct.iva,
                icui: editingProduct.icui,
                ibua: editingProduct.ibua,
                isActive: editingProduct.isActive ?? true,
                isPack: editingProduct.isPack,
                baseProductBarcode: editingProduct.baseProductBarcode,
                packMultiplier: editingProduct.packMultiplier,
                suppliers: (editingProduct as any).suppliers || []
            };
            // Sanitizar números formateados como moneda
            const payload = sanitizeProductPayload(rawPayload);

            const urlBarcode = originalBarcode || editingProduct.barcode;

            await apiFetch(`/products/update-products/${urlBarcode}`, {
                method: 'PUT', body: JSON.stringify(payload), fallbackError: 'FALLO AL ACTUALIZAR'
            }, token!);
            toast({ variant: 'success', title: 'ÉXITO', description: 'REGISTRO ACTUALIZADO' });
            setOriginalBarcode(null);
            setEditDialogOpen(false);
            mutateProducts();
            mutateAllProducts();
            broadcastRevalidate('PRODUCT_UPDATE');
        } catch (err: any) {
            // DEBUG: Ver el error real
            console.error('ERROR REAL ATRAPADO:', err);

            // Manejar errores de validación del backend (400 con campos específicos)
            if (err instanceof ApiError && err.status === 400 && err.data?.error?.fields) {
                setApiFieldErrors(err.data.error.fields);
                toast({ variant: 'destructive', title: 'ERROR DE VALIDACIÓN', description: 'Revisa los campos marcados en rojo' });
            } else if (err instanceof ApiError && err.status >= 500) {
                // Solo mostrar mensaje genérico para errores 500
                toast({ variant: 'destructive', title: 'ERROR', description: err.message });
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
            toast({ variant: 'success', title: 'ÉXITO', description: 'PRODUCTO ELIMINADO' });
            setDeleteDialogOpen(false);
            mutateProducts();
            mutateAllProducts();
            broadcastRevalidate('PRODUCT_UPDATE');
            broadcastRevalidate('DASHBOARD_UPDATE');
            broadcastRevalidate('PRODUCT_UPDATE');
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message });
        }
    };

    const [loadingBarcodes, setLoadingBarcodes] = useState<Set<string>>(new Set());

    const handleQuickStockUpdate = useCallback(async (barcode: string, amount: number) => {
        const token = Cookies.get('org-pos-token');
        setLoadingBarcodes(prev => new Set(prev).add(barcode));

        // Optimistic UI Update (v2.1: Functional Update to prevent race conditions)
        if (productsData) {
            mutateProducts((current: any) => {
                if (!current || !current.items) return current;
                return {
                    ...current,
                    items: current.items.map((p: any) => 
                        p.barcode === barcode 
                            ? { ...p, quantity: p.quantity + amount } 
                            : p
                    )
                };
            }, false);
        }

        try {
            await apiFetch(`/products/adjust/${barcode}`, {
                method: 'PATCH', body: JSON.stringify({ amount }), fallbackError: 'FALLO AL AJUSTAR'
            }, token!);
            
            // Ya no emitimos broadcastRevalidate localmente porque el backend 
            // ya lo hace a través de SSE en el repositorio.
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message });
            // Revertir en caso de error (mutate sin data revalida del servidor)
            mutateProducts();
        } finally {
            setLoadingBarcodes(prev => {
                const next = new Set(prev);
                next.delete(barcode);
                return next;
            });
        }
    }, [toast, mutateProducts, productsData]);

    const handleOpenBulk = useCallback(async (product: Product) => {
        if (!window.confirm(`¿DESTAPAR 1 UNIDAD DE "${product.productName}" PARA VENTA LIBRE?\n\nEl stock bajará en 1, pero se justificará en el reporte como apertura de paca.`)) {
            return;
        }

        const token = Cookies.get('org-pos-token');
        const barcode = product.barcode;
        setLoadingBarcodes(prev => new Set(prev).add(barcode));

        // Optimistic UI Update (Zero-F5)
        if (productsData) {
            const optimisticData = {
                ...productsData,
                items: productsData.items.map((p: any) => 
                    p.barcode === barcode 
                        ? { ...p, quantity: p.quantity - 1 } 
                        : p
                )
            };
            mutateProducts(optimisticData, false);
        }

        try {
            await apiFetch(`/products/open-bulk/${barcode}`, {
                method: 'POST', fallbackError: 'FALLO AL ABRIR PACA'
            }, token!);
            
            toast({ variant: 'success', title: 'PACA ABIERTA', description: 'STOCK AJUSTADO Y JUSTIFICADO EN EL KÁRDEX.' });
            
            // Revalidación global
            broadcastRevalidate('PRODUCT_UPDATE');
            mutateAllProducts();
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message });
            // Revertir
            mutateProducts();
        } finally {
            setLoadingBarcodes(prev => {
                const next = new Set(prev);
                next.delete(barcode);
                return next;
            });
        }
    }, [toast, mutateProducts, productsData, mutateAllProducts]);

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
            if (!response.ok) throw new Error(result.error?.message || "Fallo en importación");

            toast({ 
                variant: 'success', 
                title: 'IMPORTACIÓN COMPLETADA', 
                description: `Se procesaron ${result.total} productos. Éxitos: ${result.success}.` 
            });

            if (result.errors && result.errors.length > 0) {
                console.error("Errores de importación:", result.errors);
                toast({
                    variant: 'destructive',
                    title: 'AVISO: ALGUNOS ERRORES',
                    description: `${result.errors.length} líneas fallaron. Revisa la consola.`
                });
            }

            mutateProducts();
            mutateAllProducts();
            broadcastRevalidate('PRODUCT_UPDATE');
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message });
        } finally {
            e.target.value = ''; // Reset input
        }
    };

    const handleExportCSV = async () => {
        const token = Cookies.get('org-pos-token');
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/export-csv`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!response.ok) throw new Error("Falló la exportación");

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `catalogo_productos_${new Date().toISOString().split('T')[0]}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            
            toast({ variant: 'success', title: 'ÉXITO', description: 'CATÁLOGO DESCARGADO.' });
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message });
        }
    };

    // Handler estable para editar producto (normaliza datos)
    const handleEdit = useCallback((p: Product) => {
        const productAny = p as any;
        const normalizedProduct = {
            ...p,
            categoryId: p.categoryId || (productAny.Category?.id ? Number(productAny.Category.id) : 0) || (productAny.category?.id ? Number(productAny.category.id) : 0) || 0,
            supplierId: p.supplierId || (productAny.Supplier?.id ? Number(productAny.Supplier.id) : 0) || (productAny.supplier?.id ? Number(productAny.supplier.id) : 0) || 0,
        };
        setOriginalBarcode(p.barcode); // Capturar código original para el URL del PUT
        setEditingProduct(normalizedProduct);
        setEditDialogOpen(true);
    }, []);

    // Handlers estables para scanner
    const handleScannerResult = useCallback((b: string) => {
        const code = b.toUpperCase().trim();
        if (scanMode === 'search') {
            setSearchTerm(code);
            setFilter(code);
        } else if (scanMode === 'main') {
            if (addDialogOpen) setNewProduct(p => ({ ...p, barcode: code }));
            else if (editDialogOpen) setEditingProduct(p => p ? ({ ...p, barcode: code }) : null);
        } else {
            // Modo alterno: concatenar con coma
            if (addDialogOpen) {
                setNewProduct(p => {
                    const current = p.alternateCodes || "";
                    const codes = current.split(',').map(c => c.trim()).filter(Boolean);
                    if (!codes.includes(code)) codes.push(code);
                    return { ...p, alternateCodes: codes.join(', ') };
                });
            } else if (editDialogOpen) {
                setEditingProduct(p => {
                    if (!p) return null;
                    const current = p.alternateCodes || "";
                    const codes = current.split(',').map(c => c.trim()).filter(Boolean);
                    if (!codes.includes(code)) codes.push(code);
                    return { ...p, alternateCodes: codes.join(', ') };
                });
            }
        }
        setIsScannerOpen(false);
    }, [addDialogOpen, editDialogOpen, scanMode]);

    const handleScannerClose = useCallback(() => setIsScannerOpen(false), []);

    // Handler estable para confirmar modal
    const handleModalConfirm = useCallback(() => {
        if (addDialogOpen) handleAddProduct();
        else handleEditProduct();
    }, [addDialogOpen, handleAddProduct, handleEditProduct]);

    // Ya no usamos el return condicional aquí para que el buscador nunca se desmonte
    // El Spinner se mostrará como un overlay si es necesario

    return (
        <div className="flex flex-col w-full max-w-[1600px] mx-auto h-full min-h-0 bg-transparent text-gray-900 dark:text-white transition-all duration-500 overflow-hidden relative">

            {/* HEADER COMPACTO PREMIUM "STOCKS" */}
            <div className="shrink-0 px-4 pt-1 pb-1 flex flex-col gap-1.5 bg-white dark:bg-zinc-950 border-b border-gray-200 dark:border-white/5">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="bg-emerald-500 h-10 w-10 rounded-xl text-white shadow-lg shadow-emerald-500/20 flex items-center justify-center transform -rotate-3">
                            <Package size={20} />
                        </div>
                        <div className="flex flex-col">
                            <h1 className="text-[14px] font-black text-gray-900 dark:text-white tracking-tighter uppercase italic leading-none">
                                Catálogo <span className="text-emerald-500">Maestro</span>
                            </h1>
                            <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mt-1 flex items-center gap-1.5 opacity-80">
                                <ShieldCheck size={12} className="text-emerald-500" /> Auditoría de Patrimonio V4.5
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <Button
                            isIconOnly
                            variant="flat"
                            onPress={() => mutateProducts()}
                            className="h-10 w-10 min-w-0 bg-gray-100 dark:bg-zinc-900 text-gray-400 dark:text-emerald-500 rounded-xl border border-gray-200 dark:border-white/5 shadow-sm active:scale-95"
                        >
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
                                <Button
                                    variant="flat"
                                    onPress={handleExportCSV}
                                    className="h-9 px-3 bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 font-black text-[9px] uppercase tracking-widest italic rounded-xl border border-emerald-500/20 active:scale-95 transition-all"
                                >
                                    <FileDown size={16} />
                                    <span className="hidden sm:inline ml-2">Exportar CSV</span>
                                </Button>
                                <Button
                                    variant="flat"
                                    onPress={() => document.getElementById('csv-import')?.click()}
                                    className="h-9 px-3 bg-blue-500/10 text-blue-500 font-black text-[9px] uppercase tracking-widest italic rounded-xl border border-blue-500/20 active:scale-95 transition-all"
                                >
                                    <FileUp size={16} />
                                    <span className="hidden sm:inline ml-2">Importar CSV</span>
                                </Button>
                                <Button
                                    onPress={() => setAddDialogOpen(true)}
                                    className="h-9 px-3 md:px-4 bg-emerald-500 text-white font-black text-[9px] uppercase tracking-widest italic rounded-xl shadow-lg shadow-emerald-500/20 active:scale-95 transition-all"
                                >
                                    <PlusCircle size={16} />
                                    <span className="hidden sm:inline ml-2">nuevo producto</span>
                                    <span className="sm:hidden ml-1.5 uppercase font-black">nuevo</span>
                                </Button>
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex flex-col md:flex-row items-center gap-1.5">
                    <div className="relative flex-1 w-full group/search">
                        <Input
                            placeholder="ESCANEÉ O BUSQUE POR REFERENCIA O CATEGORÍA..."
                            value={searchTerm}
                            onValueChange={setSearchTerm}
                            startContent={<Search size={16} className="text-emerald-500 ml-2" />}
                            endContent={
                                <div className="flex items-center gap-2 mr-2">
                                    <button 
                                        onClick={() => { setScanMode('search'); setIsScannerOpen(true); }}
                                        className="p-1.5 hover:bg-emerald-500/10 rounded-lg text-emerald-500 transition-all active:scale-90"
                                        title="Escanear con Cámara"
                                    >
                                        <Camera size={18} />
                                    </button>
                                    <Barcode size={18} className="text-gray-400" />
                                </div>
                            }
                            classNames={{
                                inputWrapper: "h-11 bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 shadow-inner rounded-xl group-data-[focus=true]:border-emerald-500 transition-all",
                                input: "text-[11px] font-black tracking-widest italic uppercase ml-2"
                            }}
                        />
                    </div>
                    <Button
                        variant="flat"
                        onPress={() => setAlertsDialogOpen(true)}
                        className={`h-11 w-full md:w-auto px-6 rounded-xl font-black text-[10px] uppercase tracking-widest italic border transition-all ${stats.criticalStock > 0
                            ? 'bg-rose-500/10 text-rose-500 border-rose-500/20 shadow-lg shadow-rose-500/10 ring-2 ring-rose-500/20'
                            : stats.warningStock > 0
                                ? 'bg-amber-500/10 text-amber-500 border-amber-500/20 shadow-lg shadow-amber-500/10 ring-2 ring-amber-500/20'
                                : 'bg-gray-50 dark:bg-zinc-900 text-gray-400 dark:text-zinc-600 border-gray-200 dark:border-white/10'
                            }`}
                    >
                        <AlertTriangle size={16} className="mr-2" />
                        {stats.criticalStock > 0 ? `${stats.criticalStock} crítico${stats.criticalStock > 1 ? 's' : ''}` :
                            stats.warningStock > 0 ? `${stats.warningStock} advertencia${stats.warningStock > 1 ? 's' : ''}` :
                                'Sin alertas'}
                    </Button>
                </div>
            </div>

            {/* CONTENT: misma cadena flex que categorías — solo la tabla hace scroll interno */}
            <div className="flex-1 min-h-0 overflow-hidden px-1 md:px-2 py-0.5 bg-gray-100 dark:bg-[#09090b] relative flex flex-col">
                {productsLoading && !productsData && (
                    <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-white/80 dark:bg-black/90 backdrop-blur-sm gap-4 transition-all">
                        <Spinner color="success" size="lg" />
                        <p className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.4em] animate-pulse italic">Sincronizando Catálogo...</p>
                    </div>
                )}
                <div className="flex-1 min-h-0 flex flex-col gap-2 min-w-0">
                    <div className="shrink-0">
                        <ProductStats {...stats} />
                    </div>
                    <div className="flex-1 min-h-0 flex flex-col overflow-hidden min-w-0">
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
            </div>

            {/* MODALS */}
            <ProductFormModal
                isOpen={addDialogOpen || editDialogOpen}
                onOpenChange={(open) => {
                    if (!open) {
                        setAddDialogOpen(false);
                        setEditDialogOpen(false);
                        setApiFieldErrors({}); // Limpiar errores al cerrar
                    }
                }}
                addDialogOpen={addDialogOpen}
                newProduct={newProduct}
                setNewProduct={setNewProduct}
                newMargin={newMargin}
                setNewMargin={setNewMargin}
                editingProduct={editingProduct}
                setEditingProduct={setEditingProduct}
                editMargin={editMargin}
                setEditMargin={setEditMargin}
                categories={categoriesData || []}
                suppliers={suppliersData || []}
                mutateSuppliers={mutateSuppliers}
                mutateCategories={mutateCategories}
                allProducts={allProductsData || []}
                onConfirm={handleModalConfirm}
                onScan={() => { setScanMode('main'); setIsScannerOpen(true); }}
                onScanAlternate={() => { setScanMode('alternate'); setIsScannerOpen(true); }}
                apiFieldErrors={apiFieldErrors}
            />

            <DeleteProtocolModal
                isOpen={deleteDialogOpen}
                onOpenChange={setDeleteDialogOpen}
                deletingBarcode={deletingBarcode}
                onDelete={handleDelete}
            />

            <InventoryAlertsModal
                isOpen={alertsDialogOpen}
                onOpenChange={setAlertsDialogOpen}
                products={products.filter(p => {
                    if (p.isWeighted) return false;
                    const status = getStockStatus(p.quantity, p.minStock || 0);
                    return status === 'CRITICAL' || status === 'REORDER';
                })}
            />

            <ScannerOverlay
                isOpen={isScannerOpen}
                onResult={handleScannerResult}
                onClose={handleScannerClose}
            />
        </div>
    );
}