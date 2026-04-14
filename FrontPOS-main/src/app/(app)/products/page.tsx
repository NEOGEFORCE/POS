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
    const { data: productsData, isLoading: productsLoading, mutate: mutateProducts } = useApi<any>('/products/paginated?page=1&pageSize=1000');
    const { data: categoriesData } = useApi<Category[]>('/categories/all-categories');

    // --- ESTADOS ---
    const [addDialogOpen, setAddDialogOpen] = useState(false);
    const [editDialogOpen, setEditDialogOpen] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [alertsDialogOpen, setAlertsDialogOpen] = useState(false);
    const [isScannerOpen, setIsScannerOpen] = useState(false);
    const [filter, setFilter] = useState('');

    const [pageSize, setPageSize] = useState(10);
    const [currentPage, setCurrentPage] = useState(1);

    const [newProduct, setNewProduct] = useState<Omit<Product, 'id'>>({
        barcode: '', productName: '', quantity: 0, isWeighted: false,
        purchasePrice: 0, salePrice: 0, categoryId: '', marginPercentage: 20
    });
    const [newMargin, setNewMargin] = useState(20);
    const [editingProduct, setEditingProduct] = useState<Product | null>(null);
    const [editMargin, setEditMargin] = useState(20);
    const [deletingBarcode, setDeletingBarcode] = useState<string | null>(null);

    const products: Product[] = useMemo(() => productsData?.items || (Array.isArray(productsData) ? productsData : []), [productsData]);

    const filteredProducts = useMemo(() => {
        const query = filter.toLowerCase();
        return products.filter((p: Product) =>
            p.productName.toLowerCase().includes(query) ||
            p.barcode.toLowerCase().includes(query)
        );
    }, [products, filter]);

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
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/create-products`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(data)
            });
            if (!res.ok) throw new Error();
            toast({ variant: 'success', title: 'ÉXITO', description: 'REFERENCIA SINCRONIZADA.' });
            setAddDialogOpen(false);
            setNewProduct({ barcode: '', productName: '', quantity: 0, isWeighted: false, purchasePrice: 0, salePrice: 0, categoryId: '', marginPercentage: 20 });
            mutateProducts();
        } catch { toast({ variant: 'destructive', title: 'ERROR', description: 'FALLO EN OPERACIÓN' }); }
    };

    const handleEditProduct = async () => {
        if (!editingProduct) return;
        const token = Cookies.get('org-pos-token');
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/update-products/${editingProduct.barcode}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(editingProduct)
            });
            if (!res.ok) throw new Error();
            toast({ variant: 'success', title: 'ÉXITO', description: 'REGISTRO ACTUALIZADO' });
            setEditDialogOpen(false);
            mutateProducts();
        } catch { toast({ variant: 'destructive', title: 'ERROR', description: 'FALLO OPERATIVO' }); }
    };

    const handleDelete = async () => {
        if (!deletingBarcode) return;
        const token = Cookies.get('org-pos-token');
        try {
            await fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/delete-products/${deletingBarcode}`, {
                method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
            });
            toast({ variant: 'success', title: 'ÉXITO', description: 'PRODUCTO ELIMINADO' });
            setDeleteDialogOpen(false);
            mutateProducts();
        } catch { toast({ variant: 'destructive', title: 'ERROR', description: 'FALLO AL ELIMINAR' }); }
    };

    if (productsLoading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="success" size="lg" /></div>;

    return (
        <div className="flex flex-col min-h-screen gap-3 p-3 bg-gray-100 dark:bg-zinc-950 transition-all duration-700 pb-20">
            {/* Header Premium Zero Friction */}
            <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl shrink-0 shadow-sm relative overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-5 text-emerald-500 scale-150 rotate-12"><Package size={120} /></div>
                
                <div className="flex items-center gap-4 relative z-10">
                    <div className="bg-emerald-500 p-3 rounded-2xl text-white shadow-lg shadow-emerald-500/20 -rotate-3">
                        <Package size={24} />
                    </div>
                    <div className="flex flex-col">
                        <h1 className="text-xl font-black dark:text-white uppercase leading-none italic tracking-tighter">
                            Catálogo <span className="text-emerald-500">Maestro</span>
                        </h1>
                        <div className="flex items-center gap-2 mt-1">
                            <span className="text-[9px] font-black text-emerald-500 uppercase tracking-[0.3em]">Gestión de Almacén</span>
                            <div className="h-1 w-1 bg-gray-300 rounded-full" />
                            <div className="flex items-center gap-1 text-[9px] font-bold text-gray-400 uppercase tracking-widest italic">
                                <Clock size={10} /> {new Date().toLocaleDateString()}
                            </div>
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-3 relative z-10">
                    <div className="relative group/search">
                        <Input 
                            size="sm" 
                            placeholder="BUSCAR REFERENCIA..." 
                            value={filter} 
                            onValueChange={(v) => { setFilter(v.toUpperCase()); setCurrentPage(1); }} 
                            startContent={<Search size={16} className="text-gray-400 group-focus-within/search:text-emerald-500 transition-colors" />} 
                            classNames={{ 
                                inputWrapper: "h-11 w-full md:w-80 bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-inner rounded-xl group-focus-within/search:border-emerald-500/50 transition-all", 
                                input: "text-[11px] font-black bg-transparent tracking-widest italic uppercase" 
                            }} 
                        />
                    </div>
                    <Button 
                        size="sm" 
                        onPress={() => setAlertsDialogOpen(true)}
                        className={`h-11 px-4 font-black text-[11px] rounded-xl transition-all italic tracking-widest uppercase border ${stats.lowStock > 0 ? 'bg-rose-500/10 text-rose-500 border-rose-500/20 animate-pulse' : 'bg-gray-50 dark:bg-zinc-900 border-gray-200 dark:border-white/10 text-gray-400'}`}
                    >
                        <AlertTriangle size={16} className="mr-1" /> ALERTA ({stats.lowStock})
                    </Button>
                    <Button 
                        size="sm" 
                        onPress={() => setAddDialogOpen(true)} 
                        className="h-11 px-6 bg-emerald-500 text-white font-black text-[11px] rounded-xl shadow-lg shadow-emerald-500/20 hover:scale-105 active:scale-95 transition-all italic tracking-widest uppercase"
                    >
                        <PlusCircle size={16} className="mr-1" /> NUEVA REF.
                    </Button>
                </div>
            </header>

            {/* KPI Section */}
            <ProductStats {...stats} />

            {/* Main Content Table */}
            <ProductTable 
                products={filteredProducts.slice((currentPage - 1) * pageSize, currentPage * pageSize)}
                currentPage={currentPage}
                totalPages={Math.ceil(filteredProducts.length / pageSize) || 1}
                pageSize={pageSize}
                totalFiltered={filteredProducts.length}
                onEdit={(p) => { setEditingProduct({ ...p }); setEditDialogOpen(true); }}
                onDelete={(b) => { setDeletingBarcode(b); setDeleteDialogOpen(true); }}
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