"use client";

import { useState, useMemo, useCallback } from 'react';
import { Button, Input, Spinner } from "@heroui/react";
import { 
    Package, Search, AlertTriangle, TrendingDown, PlusCircle, Clock, ShieldCheck 
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useToast } from '@/hooks/use-toast';
import { useApi } from '@/hooks/use-api';
import { Product, Category } from '@/lib/definitions';
import Cookies from 'js-cookie';
import { apiFetch } from '@/lib/api-error';

// COMPONENTES DINÁMICOS PARA OPTIMIZACIÓN
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
    const { toast } = useToast();
    const [pageSize, setPageSize] = useState(25);
    const [currentPage, setCurrentPage] = useState(1);
    const [filter, setFilter] = useState('');
    const [selectedSupplier, setSelectedSupplier] = useState<string>('ALL');

    const { data: productsData, isLoading: productsLoading, mutate: mutateProducts } = useApi<any>(
        `/products/paginated?page=${currentPage}&pageSize=${pageSize}${filter ? `&q=${filter}` : ''}`
    );
    const { data: categoriesData } = useApi<Category[]>('/categories/all-categories');
    const { data: suppliersData } = useApi<any[]>('/api/suppliers/all-suppliers');

    // --- ESTADOS ---
    const [addDialogOpen, setAddDialogOpen] = useState(false);
    const [editDialogOpen, setEditDialogOpen] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [alertsDialogOpen, setAlertsDialogOpen] = useState(false);
    const [isScannerOpen, setIsScannerOpen] = useState(false);

    const [newProduct, setNewProduct] = useState<Omit<Product, 'id'>>({
        barcode: '', productName: '', quantity: 0, isWeighted: false,
        purchasePrice: 0, salePrice: 0, categoryId: '', marginPercentage: 20
    });
    const [newMargin, setNewMargin] = useState(20);
    const [editingProduct, setEditingProduct] = useState<Product | null>(null);
    const [editMargin, setEditMargin] = useState(20);
    const [deletingBarcode, setDeletingBarcode] = useState<string | null>(null);

    // Paginación y Filtrado Server-side
    const products: Product[] = useMemo(() => productsData?.items || [], [productsData]);
    const totalItems = productsData?.total || 0;
    const totalPages = productsData?.totalPages || Math.ceil(totalItems / pageSize) || 1;

    const filteredProducts = useMemo(() => {
        if (selectedSupplier === 'ALL') return products;
        return products.filter(p => p.supplierId?.toString() === selectedSupplier);
    }, [products, selectedSupplier]);

    const stats = useMemo(() => {
        const cost = products.reduce((acc, p) => acc + (p.isWeighted ? 0 : (p.quantity * p.purchasePrice)), 0);
        const retail = products.reduce((acc, p) => acc + (p.isWeighted ? 0 : (p.quantity * p.salePrice)), 0);
        const low = products.filter(p => !p.isWeighted && p.quantity <= 5).length;
        return { totalCost: cost, totalRetail: retail, lowStock: low, totalItems: products.length };
    }, [products]);

    const handleAddProduct = async () => {
        const token = Cookies.get('org-pos-token');
        try {
            const data = { ...newProduct, productName: newProduct.productName.toUpperCase(), barcode: newProduct.barcode.toUpperCase() };
            await apiFetch('/products/create-products', {
                method: 'POST',
                body: JSON.stringify(data),
                fallbackError: 'FALLO AL CREAR PRODUCTO'
            }, token!);
            toast({ variant: 'success', title: 'ÉXITO', description: 'REFERENCIA SINCRONIZADA.' });
            setAddDialogOpen(false);
            setNewProduct({ barcode: '', productName: '', quantity: 0, isWeighted: false, purchasePrice: 0, salePrice: 0, categoryId: '', marginPercentage: 20 });
            mutateProducts();
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL CREAR PRODUCTO' });
        }
    };

    const handleEditProduct = async () => {
        if (!editingProduct) return;
        const token = Cookies.get('org-pos-token');
        try {
            await apiFetch(`/products/update-products/${editingProduct.barcode}`, {
                method: 'PUT',
                body: JSON.stringify(editingProduct),
                fallbackError: 'FALLO AL ACTUALIZAR PRODUCTO'
            }, token!);
            toast({ variant: 'success', title: 'ÉXITO', description: 'REGISTRO ACTUALIZADO' });
            setEditDialogOpen(false);
            mutateProducts();
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL ACTUALIZAR PRODUCTO' });
        }
    };

    const handleDelete = async () => {
        if (!deletingBarcode) return;
        const token = Cookies.get('org-pos-token');
        try {
            await apiFetch(`/products/delete-products/${deletingBarcode}`, {
                method: 'DELETE',
                fallbackError: 'FALLO AL ELIMINAR PRODUCTO'
            }, token!);
            toast({ variant: 'success', title: 'ÉXITO', description: 'PRODUCTO ELIMINADO' });
            setDeleteDialogOpen(false);
            mutateProducts();
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL ELIMINAR PRODUCTO' });
        }
    };

    const handleQuickStockUpdate = async (barcode: string, amount: number) => {
        const token = Cookies.get('org-pos-token');
        try {
            await apiFetch(`/products/adjust/${barcode}`, {
                method: 'PATCH',
                body: JSON.stringify({ amount }),
                fallbackError: 'FALLO AL AJUSTAR STOCK'
            }, token!);
            mutateProducts();
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL AJUSTAR STOCK' });
        }
    };

    if (productsLoading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="success" size="lg" /></div>;

    return (
        <div className="flex flex-col gap-6 md:gap-8 max-w-[1600px] mx-auto px-4 md:px-6 pb-20 w-full min-h-[100dvh]">
            
            {/* HEADER TACTICO */}
            <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 pt-6">
                <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-4">
                        <div className="bg-emerald-500 w-14 h-14 rounded-[1.5rem] text-white shadow-2xl shadow-emerald-500/20 flex items-center justify-center transform -rotate-6 group hover:rotate-0 transition-all">
                            <Package size={32} />
                        </div>
                        <div className="flex flex-col">
                            <h1 className="text-3xl md:text-5xl font-black text-gray-900 dark:text-white tracking-tighter uppercase italic leading-none">
                                Catálogo <span className="text-emerald-500">Maestro</span>
                            </h1>
                            <p className="text-[10px] md:text-xs font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.4em] italic ml-1 mt-2 flex items-center gap-2">
                                <ShieldCheck size={12} className="text-emerald-500" /> Control de Inventario y Assets V4.0
                            </p>
                        </div>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-md p-1.5 rounded-[1.5rem] border border-gray-200 dark:border-white/5 shadow-inner">
                    <div className="relative group/search shrink-0">
                        <Input 
                            placeholder="BUSCAR REFERENCIA..." 
                            value={filter} 
                            onValueChange={(v) => { setFilter(v.toUpperCase()); setCurrentPage(1); }} 
                            startContent={<Search size={16} className="text-gray-400 group-focus-within/search:text-emerald-500 transition-colors" />} 
                            classNames={{ 
                                inputWrapper: "h-12 w-full md:w-64 bg-gray-50/80 dark:bg-zinc-950/50 border border-transparent group-focus-within/search:!border-emerald-500/50 transition-all shadow-inner rounded-2xl", 
                                input: "text-[10px] font-black bg-transparent tracking-[0.2em] italic uppercase" 
                            }} 
                        />
                    </div>
                    
                    <Button 
                        onPress={() => setAlertsDialogOpen(true)}
                        className={`h-12 px-6 rounded-2xl font-black text-[10px] uppercase tracking-widest italic transition-all ${stats.lowStock > 0 ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20 animate-pulse' : 'bg-transparent text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5'}`}
                    >
                        <AlertTriangle size={16} className="mr-2" /> ALERTA ({stats.lowStock})
                    </Button>

                    <Button 
                        onPress={() => setAddDialogOpen(true)} 
                        className="h-12 px-8 bg-emerald-500 text-white font-black text-[10px] uppercase tracking-widest italic rounded-2xl shadow-xl shadow-emerald-500/20 hover:scale-105 transition-transform"
                    >
                        <PlusCircle size={16} className="mr-2" /> NUEVA REF.
                    </Button>
                </div>
            </header>

            {/* KPI Section */}
            <ProductStats {...stats} />

            {/* Main Content Table */}
            <ProductTable 
                products={filteredProducts}
                currentPage={currentPage}
                totalPages={totalPages}
                pageSize={pageSize}
                totalFiltered={totalItems}
                onEdit={(p) => { setEditingProduct({ ...p }); setEditDialogOpen(true); }}
                onDelete={(b) => { setDeletingBarcode(b); setDeleteDialogOpen(true); }}
                onQuickUpdate={handleQuickStockUpdate}
                onPageChange={setCurrentPage}
                onPageSizeChange={setPageSize}
                formatCOP={formatCOP}
            />

            {/* Modals */}
            <ProductFormModal 
                isOpen={addDialogOpen || editDialogOpen}
                onOpenChange={(open) => { if(!open) { setAddDialogOpen(false); setEditDialogOpen(false); } }}
                newProduct={newProduct}
                setNewProduct={setNewProduct}
                newMargin={newMargin}
                setNewMargin={setNewMargin}
                editingProduct={editingProduct}
                setEditingProduct={setEditingProduct}
                editMargin={editMargin}
                setEditMargin={setEditMargin}
                addDialogOpen={addDialogOpen}
                categories={categoriesData || []}
                suppliers={suppliersData || []}
                onConfirm={addDialogOpen ? handleAddProduct : handleEditProduct}
                onScan={() => setIsScannerOpen(true)}
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
                products={products.filter(p => !p.isWeighted && p.quantity <= 5)}
            />

            {isScannerOpen && <ScannerOverlay onResult={b => { if(addDialogOpen) setNewProduct(p => ({ ...p, barcode: b })); else if(editDialogOpen) setEditingProduct(p => p ? ({ ...p, barcode: b }) : null); setIsScannerOpen(false); }} onClose={() => setIsScannerOpen(false)} />}
        </div>
    );
}