"use client";

import { useState, useMemo, useEffect, useCallback } from 'react';
import { Button, Input, Spinner } from "@heroui/react";
import { 
    Package, Search, AlertTriangle, PlusCircle, RefreshCw, Barcode, Warehouse, ShoppingBag, ShieldCheck
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useToast } from '@/hooks/use-toast';
import { useApi } from '@/hooks/use-api';
import { Product, Category } from '@/lib/definitions';
import { applyRounding, formatCurrency, parseCurrency, sanitizeProductPayload, getCriticalThreshold } from '@/lib/utils';
import Cookies from 'js-cookie';
import { apiFetch, ApiError } from '@/lib/api-error';
import { useAuth } from '@/lib/auth';

// COMPONENTES DINÁMICOS PREMIUM
const ProductStats = dynamic(() => import('./components/ProductStats'), { ssr: false });
const ProductTable = dynamic(() => import('./components/ProductTable'), { ssr: false });
const ProductFormModal = dynamic(() => import('./components/ProductFormModal'), { ssr: false });
const InventoryAlertsModal = dynamic(() => import('./components/InventoryAlertsModal'), { ssr: false });
const DeleteProtocolModal = dynamic(() => import('./components/DeleteProtocolModal'), { ssr: false });
const ScannerOverlay = dynamic(() => import('@/components/ScannerOverlay').then(m => m.ScannerOverlay), { ssr: false });

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
    const { data: categoriesData } = useApi<Category[]>('/categories/all-categories');
    const { data: suppliersData, mutate: mutateSuppliers } = useApi<any[]>('/suppliers/all-suppliers');
    const { data: allProductsData } = useApi<Product[]>('/products/all-products');

    // --- ESTADOS ---
    const [addDialogOpen, setAddDialogOpen] = useState(false);
    const [editDialogOpen, setEditDialogOpen] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [alertsDialogOpen, setAlertsDialogOpen] = useState(false);
    const [isScannerOpen, setIsScannerOpen] = useState(false);

    const [newProduct, setNewProduct] = useState<Omit<Product, 'id'>>({
        barcode: '', productName: '', quantity: undefined as any, isWeighted: false,
        purchasePrice: 0, salePrice: 0, categoryId: 0, marginPercentage: 20,
        minStock: undefined as any,
        packMultiplier: undefined as any
    });
    const [newMargin, setNewMargin] = useState(20);
    const [editingProduct, setEditingProduct] = useState<Product | null>(null);
    const [editMargin, setEditMargin] = useState(20);
    const [deletingBarcode, setDeletingBarcode] = useState<string | null>(null);
    const [apiFieldErrors, setApiFieldErrors] = useState<Record<string, string>>({});

    // Paginación y Filtrado 
    const products: Product[] = useMemo(() => productsData?.items || [], [productsData]);
    const totalItems = productsData?.total || 0;
    const totalPages = productsData?.totalPages || 1;

    const stats = useMemo(() => {
        const cost = products.reduce((acc, p) => acc + (p.isWeighted ? 0 : (p.quantity * p.purchasePrice)), 0);
        const retail = products.reduce((acc, p) => acc + (p.isWeighted ? 0 : (p.quantity * p.salePrice)), 0);
        
        // Semáforo dinámico: contar críticos (rojo) y advertencias (ámbar) por separado
        const criticalCount = products.filter(p => {
            if (p.isWeighted) return false;
            const threshold = getCriticalThreshold(p.minStock || 5);
            return p.quantity <= threshold;
        }).length;
        
        const warningCount = products.filter(p => {
            if (p.isWeighted) return false;
            const minStock = p.minStock || 5;
            const threshold = getCriticalThreshold(minStock);
            return p.quantity <= minStock && p.quantity > threshold;
        }).length;
        
        return { 
            totalCost: cost, 
            totalRetail: retail, 
            criticalStock: criticalCount,
            warningStock: warningCount,
            totalItems: products.length 
        };
    }, [products]);

    const handleAddProduct = async () => {
        const token = Cookies.get('org-pos-token');
        setApiFieldErrors({}); // Limpiar errores previos
        try {
            // Sanitizar payload: limpiar formato de moneda antes de enviar
            const rawData = { 
                ...newProduct, 
                productName: newProduct.productName.toUpperCase(), 
                barcode: newProduct.barcode.toUpperCase(),
                suppliers: (newProduct as any).suppliers || []
            };
            const data = sanitizeProductPayload(rawData);
            
            // DEBUG: Ver qué se está enviando
            console.log('PAYLOAD ENVIADO AL BACKEND:', JSON.stringify(data, null, 2));
            
            await apiFetch('/products/create-products', {
                method: 'POST', body: JSON.stringify(data), fallbackError: 'FALLO AL CREAR PRODUCTO'
            }, token!);
            toast({ variant: 'success', title: 'ÉXITO', description: 'REFERENCIA SINCRONIZADA.' });
            setAddDialogOpen(false);
            setNewProduct({ barcode: '', productName: '', quantity: undefined as any, isWeighted: false, purchasePrice: 0, salePrice: 0, categoryId: 0, marginPercentage: 20, minStock: undefined as any, packMultiplier: undefined as any });
            mutateProducts();
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
            
            // DEBUG: Ver qué se está enviando
            console.log('PAYLOAD ENVIADO AL BACKEND:', JSON.stringify(payload, null, 2));
            
            await apiFetch(`/products/update-products/${editingProduct.barcode}`, {
                method: 'PUT', body: JSON.stringify(payload), fallbackError: 'FALLO AL ACTUALIZAR'
            }, token!);
            toast({ variant: 'success', title: 'ÉXITO', description: 'REGISTRO ACTUALIZADO' });
            setEditDialogOpen(false);
            mutateProducts();
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
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message });
        }
    };

    const handleQuickStockUpdate = useCallback(async (barcode: string, amount: number) => {
        const token = Cookies.get('org-pos-token');
        try {
            await apiFetch(`/products/adjust/${barcode}`, {
                method: 'PATCH', body: JSON.stringify({ amount }), fallbackError: 'FALLO AL AJUSTAR'
            }, token!);
            mutateProducts();
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message });
        }
    }, [toast, mutateProducts]);

    // Handler estable para editar producto (normaliza datos)
    const handleEdit = useCallback((p: Product) => {
        const productAny = p as any;
        const normalizedProduct = {
            ...p,
            categoryId: p.categoryId || (productAny.Category?.id ? Number(productAny.Category.id) : 0) || (productAny.category?.id ? Number(productAny.category.id) : 0) || 0,
            supplierId: p.supplierId || (productAny.Supplier?.id ? Number(productAny.Supplier.id) : 0) || (productAny.supplier?.id ? Number(productAny.supplier.id) : 0) || 0,
        };
        setEditingProduct(normalizedProduct);
        setEditDialogOpen(true);
    }, []);

    // Handlers estables para scanner
    const handleScannerResult = useCallback((b: string) => {
        if (addDialogOpen) setNewProduct(p => ({ ...p, barcode: b }));
        else if (editDialogOpen) setEditingProduct(p => p ? ({ ...p, barcode: b }) : null);
        setIsScannerOpen(false);
    }, [addDialogOpen, editDialogOpen]);

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
            <div className="shrink-0 px-4 pt-2 pb-2 flex flex-col gap-2 bg-white dark:bg-zinc-950 border-b border-gray-200 dark:border-white/5">
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
                        {isAdmin && (
                            <Button 
                                onPress={() => setAddDialogOpen(true)} 
                                className="h-9 px-3 md:px-4 bg-emerald-500 text-white font-black text-[9px] uppercase tracking-widest italic rounded-xl shadow-lg shadow-emerald-500/20 active:scale-95 transition-all"
                            >
                                <PlusCircle size={16} />
                                <span className="hidden sm:inline ml-2">nuevo producto</span>
                                <span className="sm:hidden ml-1.5 uppercase font-black">nuevo</span>
                            </Button>
                        )}
                    </div>
                </div>

                <div className="flex flex-col md:flex-row items-center gap-2">
                    <div className="relative flex-1 w-full group/search">
                        <Input 
                            placeholder="ESCANEÉ O BUSQUE POR REFERENCIA O CATEGORÍA..." 
                            value={searchTerm} 
                            onValueChange={setSearchTerm} 
                            startContent={<Search size={16} className="text-emerald-500 ml-2" />}
                            endContent={<Barcode size={16} className="text-gray-400 mr-2" />}
                            classNames={{ 
                                inputWrapper: "h-11 bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 shadow-inner rounded-xl group-data-[focus=true]:border-emerald-500 transition-all", 
                                input: "text-[11px] font-black tracking-widest italic uppercase ml-2" 
                            }} 
                        />
                    </div>
                    <Button 
                        variant="flat"
                        onPress={() => setAlertsDialogOpen(true)}
                        className={`h-11 w-full md:w-auto px-6 rounded-xl font-black text-[10px] uppercase tracking-widest italic border transition-all ${
                            stats.criticalStock > 0 
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
            <div className="flex-1 min-h-0 overflow-hidden px-1 md:px-2 py-1 bg-gray-100 dark:bg-[#09090b] relative flex flex-col">
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
                    if(!open) { 
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
                allProducts={allProductsData || []}
                onConfirm={handleModalConfirm}
                onScan={() => setIsScannerOpen(true)}
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
                products={products.filter(p => !p.isWeighted && p.quantity <= (p.minStock || 5))}
            />

            <ScannerOverlay 
                isOpen={isScannerOpen}
                onResult={handleScannerResult}
                onClose={handleScannerClose}
            />
        </div>
    );
}