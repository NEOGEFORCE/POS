"use client";

import { useState, useMemo } from 'react';
import {
    Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Button, Input, Spinner, Select, SelectItem, Checkbox
} from "@heroui/react";
import {
    Package, Edit, Trash2, Camera, Search,
    AlertTriangle, Zap, TrendingDown, Sparkles, BarChart3, X, Check, Barcode, PlusCircle, Shapes
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useApi } from '@/hooks/use-api';
import { Product, Category } from '@/lib/definitions';
import { applyRounding } from '@/lib/utils';
import { ScannerOverlay } from '@/components/ScannerOverlay';

const formatCOP = (val: number | string): string => {
    if (val === undefined || val === null || val === '') return '0';
    const num = typeof val === 'string' ? parseFloat(val.replace(/[^\d.]/g, '')) : val;
    return isNaN(num) ? '0' : num.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};

export default function ProductsPage() {
    const { toast } = useToast();
    const { data: productsData, isLoading: productsLoading, mutate: mutateProducts } = useApi<any>('/products/paginated?page=1&pageSize=1000');
    const { data: categoriesData, isLoading: categoriesLoading } = useApi<Category[]>('/categories/all-categories');

    // --- ESTADOS ---
    const [addDialogOpen, setAddDialogOpen] = useState(false);
    const [editDialogOpen, setEditDialogOpen] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [alertsDialogOpen, setAlertsDialogOpen] = useState(false);
    const [isScannerOpen, setIsScannerOpen] = useState(false);
    const [filter, setFilter] = useState('');

    // PAGINACIÓN
    const [pageSize, setPageSize] = useState(10);
    const [currentPage, setCurrentPage] = useState(1);

    // Estados de datos
    const [newProduct, setNewProduct] = useState<Omit<Product, 'id'>>({
        barcode: '', productName: '', quantity: 0, isWeighted: false,
        purchasePrice: 0, salePrice: 0, categoryId: '', marginPercentage: 20
    });
    const [editingProduct, setEditingProduct] = useState<Product | null>(null);
    const [deletingBarcode, setDeletingBarcode] = useState<string | null>(null);
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

    const [newMargin, setNewMargin] = useState(20);
    const [editMargin, setEditMargin] = useState(0);

    // --- DATOS DERIVADOS ---
    const products: Product[] = useMemo(() => productsData?.items || (Array.isArray(productsData) ? productsData : []), [productsData]);
    const categories: Category[] = useMemo(() => {
        const arr = Array.isArray(categoriesData) ? [...categoriesData] : [];
        return arr.sort((a, b) => a.name.localeCompare(b.name));
    }, [categoriesData]);

    const filteredProducts = useMemo(() => {
        const query = filter.toLowerCase();
        return products.filter((p: Product) =>
            p.productName.toLowerCase().includes(query) ||
            p.barcode.includes(query.toUpperCase())
        );
    }, [products, filter]);

    // Lógica Paginación
    const paginatedProducts = useMemo(() => filteredProducts.slice((currentPage - 1) * pageSize, currentPage * pageSize), [filteredProducts, currentPage, pageSize]);
    const totalPages = Math.ceil(filteredProducts.length / pageSize || 1);

    // Lógica Bajo Stock
    const lowStockProducts = useMemo(() => {
        return products.filter((p: Product) => !p.isWeighted && p.quantity <= 5);
    }, [products]);

    const stats = useMemo(() => {
        const totalCostValue = products.reduce((acc: number, p: Product) => 
            acc + (p.isWeighted === true ? 0 : (Number(p.quantity) || 0) * (Number(p.purchasePrice) || 0)), 0);
        const totalRetailValue = products.reduce((acc: number, p: Product) => 
            acc + (p.isWeighted === true ? 0 : (Number(p.quantity) || 0) * (Number(p.salePrice) || 0)), 0);
        return { totalCostValue, totalRetailValue, lowStock: lowStockProducts.length, totalItems: products.length };
    }, [products, lowStockProducts]);

    // --- ACCIONES ---
    const handleScanResult = (barcode: string) => {
        if (addDialogOpen) setNewProduct(prev => ({ ...prev, barcode }));
        else if (editDialogOpen) setEditingProduct(prev => prev ? ({ ...prev, barcode }) : null);
        setIsScannerOpen(false);
    };

    const handleAddProduct = async () => {
        const token = localStorage.getItem('org-pos-token');
        try {
            const data = {
                ...newProduct,
                marginPercentage: Number(newMargin),
                productName: newProduct.productName.toUpperCase(),
                barcode: newProduct.barcode.toUpperCase(),
                quantity: Number(newProduct.quantity),
                purchasePrice: Number(newProduct.purchasePrice),
                salePrice: Number(newProduct.salePrice),
                categoryId: Number(newProduct.categoryId)
            };
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/create-products`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(data)
            });
            if (!res.ok) throw new Error("Error al crear");
            toast({ title: 'Éxito', description: 'Referencia sincronizada.' });
            setAddDialogOpen(false);
            setNewProduct({ barcode: '', productName: '', quantity: 0, isWeighted: false, purchasePrice: 0, salePrice: 0, categoryId: '', marginPercentage: 20 });
            setNewMargin(20);
            mutateProducts();
        } catch (err) { toast({ variant: 'destructive', title: 'Error en la operación' }); }
    };

    const handleEditProduct = async () => {
        if (!editingProduct) return;
        const token = localStorage.getItem('org-pos-token');
        try {
            const data = { ...editingProduct, marginPercentage: Number(editMargin) };
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/update-products/${editingProduct.barcode}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(data)
            });
            if (!res.ok) throw new Error('Error al actualizar');
            toast({ title: 'Éxito', description: 'Registro maestro actualizado.' });
            setEditDialogOpen(false);
            mutateProducts();
        } catch (err) { toast({ variant: 'destructive', title: 'Error en la operación' }); }
    };

    const handleDelete = async () => {
        if (!deletingBarcode) return;
        const token = localStorage.getItem('org-pos-token');
        try {
            await fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/delete-products/${deletingBarcode}`, {
                method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
            });
            toast({ title: "PURGA COMPLETADA" });
            mutateProducts();
            setDeleteDialogOpen(false);
        } catch (err) { toast({ variant: 'destructive', title: 'Error al eliminar' }); }
    };

    if (productsLoading || categoriesLoading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="success" size="lg" /></div>;

    return (
        <div className="flex flex-col h-screen gap-1 p-1 bg-gray-50 dark:bg-zinc-950 text-gray-900 dark:text-white overflow-hidden select-none transition-colors duration-500">

            {/* HEADER QUE RESPETA CLARO/OSCURO */}
            <header className="flex items-center justify-between gap-2 p-2 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-lg shrink-0 shadow-sm transition-colors">
                <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-md bg-emerald-500 flex items-center justify-center text-white shadow-sm shrink-0">
                        <Package size={16} />
                    </div>
                    <div className="flex flex-col">
                        <span className="text-sm font-black uppercase tracking-tighter leading-none">INVENTARIO</span>
                        <span className="text-[9px] font-black text-emerald-500 uppercase tracking-widest mt-0.5">VAULT V4.2</span>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <Button
                        size="sm"
                        variant="flat"
                        onPress={() => setAlertsDialogOpen(true)}
                        className={`h-8 px-3 rounded-md font-black text-[10px] tracking-widest uppercase transition-all ${stats.lowStock > 0
                                ? 'bg-amber-500 text-white animate-pulse shadow-lg shadow-amber-500/20'
                                : 'bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-500'
                            }`}
                    >
                        <AlertTriangle size={12} className="mr-1" />
                        {stats.lowStock > 0 && <span className="bg-white text-amber-500 dark:bg-black px-1 rounded mr-1 leading-none">{stats.lowStock}</span>}
                        ALERTAS
                    </Button>

                    <Input
                        size="sm"
                        placeholder="BUSCAR..."
                        value={filter} onValueChange={(v) => { setFilter(v.toUpperCase()); setCurrentPage(1); }}
                        classNames={{
                            inputWrapper: "h-8 px-3 rounded-md bg-transparent border border-gray-200 dark:border-white/10 transition-colors w-40 md:w-64 shadow-none focus-within:border-emerald-500/50",
                            input: "font-black text-[10px] uppercase text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600"
                        }}
                        startContent={<Search size={14} className="text-gray-400" />}
                    />
                    <Button onPress={() => setAddDialogOpen(true)} className="bg-emerald-500 text-white font-black uppercase text-[10px] h-8 px-4 rounded-md shrink-0 shadow-sm tracking-widest transition-transform active:scale-95">
                        <PlusCircle size={14} className="mr-1" /> NUEVA REF
                    </Button>
                </div>
            </header>

            {/* KPIs */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-1 shrink-0">
                {[
                    { label: "VALOR VENTA", val: `$${formatCOP(stats.totalRetailValue)}`, color: "emerald", icon: BarChart3 },
                    { label: "VALOR COSTO", val: `$${formatCOP(stats.totalCostValue)}`, color: "sky", icon: Shapes },
                    { label: "REFERENCIAS", val: stats.totalItems, color: "emerald", icon: Zap },
                    { label: "EN ALERTA", val: stats.lowStock, color: "amber", icon: TrendingDown }
                ].map((k, i) => (
                    <div key={i} className={`bg-white dark:bg-zinc-900 p-2 border border-gray-200 dark:border-white/5 rounded-lg flex items-center justify-between shadow-sm transition-colors cursor-pointer hover:border-${k.color}-500/30`} onClick={() => i === 3 && setAlertsDialogOpen(true)}>
                        <div className="flex flex-col min-w-0 pr-1">
                            <span className="text-[8px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none">{k.label}</span>
                            <span className={`text-sm font-black tabular-nums ${k.color === 'emerald' ? 'text-emerald-500' : k.color === 'sky' ? 'text-sky-500' : 'text-amber-500'} italic leading-tight tracking-tighter truncate`}>{k.val}</span>
                        </div>
                        <k.icon size={14} className={`${k.color === 'emerald' ? 'text-emerald-500' : k.color === 'sky' ? 'text-sky-500' : 'text-amber-500'} opacity-20 shrink-0`} />
                    </div>
                ))}
            </div>

            {/* TABLA PRINCIPAL (DISEÑO SLIM) */}
            <div className="flex-1 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-lg overflow-hidden flex flex-col min-h-0 shadow-sm transition-colors">
                <div className="flex-1 overflow-x-hidden overflow-y-auto custom-scrollbar">
                    <Table isCompact removeWrapper aria-label="Inventario" classNames={{ th: "bg-gray-50 dark:bg-zinc-950 text-gray-400 dark:text-zinc-500 font-black uppercase text-[8px] md:text-[9px] tracking-widest h-10 py-1 border-b border-gray-200 dark:border-white/5 sticky top-0 z-10", td: "py-1.5 font-medium border-b border-gray-100 dark:border-white/5", tr: "hover:bg-gray-50 dark:hover:bg-white/5 transition-colors" }}>
                        <TableHeader>
                            <TableColumn className="pl-3 md:pl-6">PRODUCTO</TableColumn>
                            <TableColumn align="center">STOCK</TableColumn>
                            <TableColumn align="end">PRECIO</TableColumn>
                            <TableColumn align="end" className="pr-3 md:pr-6">ACCIONES</TableColumn>
                        </TableHeader>
                        <TableBody emptyContent={<div className="py-20 text-[11px] font-black text-gray-400 dark:text-zinc-600 uppercase text-center italic tracking-widest">Almacén vacío</div>}>
                            {paginatedProducts.map((p: Product) => {
                                const isCritical = !p.isWeighted && p.quantity <= 5;
                                return (
                                    <TableRow 
                                        key={p.barcode} 
                                        onClick={() => setSelectedItemId(p.barcode)}
                                        className={`group cursor-pointer transition-all border-l-4 ${
                                            selectedItemId === p.barcode 
                                            ? 'bg-emerald-500/10 border-emerald-500' 
                                            : 'border-transparent hover:bg-gray-50 dark:hover:bg-white/5 hover:border-emerald-500/30'
                                        }`}
                                    >
                                        <TableCell className="pl-3 md:pl-4">
                                            <div className="flex items-center gap-2">
                                                <div className="hidden sm:flex h-8 w-8 shrink-0 bg-gray-100 dark:bg-black border border-gray-200 dark:border-white/5 rounded-lg items-center justify-center text-gray-400 dark:text-zinc-600">
                                                    <Barcode size={14} />
                                                </div>
                                                <div className="flex flex-col min-w-0">
                                                    <span className="text-[11px] font-black text-gray-900 dark:text-white uppercase leading-tight italic truncate max-w-[100px] sm:max-w-[200px] md:max-w-[300px]">{p.productName}</span>
                                                    <span className="text-[8px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest mt-0.5 truncate">#{p.barcode}</span>
                                                </div>
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-center">
                                            <div className="flex flex-col items-center">
                                                <span className={`text-[13px] font-black tabular-nums italic leading-none ${isCritical ? 'text-rose-500 animate-pulse' : 'text-gray-900 dark:text-white'}`}>
                                                    {p.isWeighted ? <span className="text-emerald-500 text-[10px]">∞ ILIM</span> : p.quantity}
                                                </span>
                                                <div className="h-[2px] w-8 bg-gray-200 dark:bg-zinc-800 mt-1.5 relative overflow-hidden rounded-full">
                                                    {!p.isWeighted && <div className={`h-full transition-all rounded-full ${isCritical ? 'bg-rose-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, (p.quantity / 50) * 100)}%` }} />}
                                                    {p.isWeighted && <div className="h-full bg-emerald-500 w-full rounded-full" />}
                                                </div>
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <span className="text-sm font-black text-gray-900 dark:text-white tabular-nums italic">
                                                <span className="text-emerald-500 mr-0.5">$</span>{formatCOP(p.salePrice)}
                                            </span>
                                        </TableCell>
                                        <TableCell className="pr-6">
                                            <div className="flex justify-end gap-2">
                                                <Button isIconOnly size="sm" variant="flat" className="h-9 w-9 bg-gray-50 dark:bg-zinc-900 text-emerald-500 rounded-xl hover:bg-emerald-500 hover:text-white dark:hover:text-black border border-gray-200 dark:border-white/5 transition-all shadow-sm" onPress={() => {
                                                    setEditingProduct(p);
                                                    const margin = p.purchasePrice > 0 ? ((p.salePrice / p.purchasePrice) - 1) * 100 : 0;
                                                    setEditMargin(Number(margin.toFixed(2)));
                                                    setEditDialogOpen(true);
                                                }}>
                                                    <Edit size={14} />
                                                </Button>
                                                <Button isIconOnly size="sm" variant="flat" className="h-9 w-9 bg-gray-50 dark:bg-zinc-900 text-rose-500 rounded-xl hover:bg-rose-500 hover:text-white border border-gray-200 dark:border-white/5 transition-all shadow-sm" onPress={() => { setDeletingBarcode(p.barcode); setDeleteDialogOpen(true); }}>
                                                    <Trash2 size={14} />
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>

                {/* PAGINACIÓN */}
                {filteredProducts.length > 0 && (
                    <div className="px-6 py-3 flex items-center justify-between border-t border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-zinc-950 shrink-0 transition-colors">
                        <p className="text-[9px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest leading-none">
                            VISTA: <span className="text-gray-900 dark:text-white italic">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, filteredProducts.length)}</span> / <span className="text-emerald-500 italic">{filteredProducts.length}</span>
                        </p>
                        <div className="flex items-center gap-4">
                            <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }} className="h-8 bg-white dark:bg-zinc-900 text-gray-500 dark:text-zinc-400 text-[9px] font-black uppercase tracking-widest px-2 outline-none rounded-lg border border-gray-200 dark:border-white/5 cursor-pointer shadow-sm">
                                {[10, 20, 50, 100].map(n => <option key={n} value={n}>{n} REGISTROS</option>)}
                            </select>
                            <div className="flex items-center gap-1">
                                <Button size="sm" variant="flat" onPress={() => setCurrentPage(prev => Math.max(1, prev - 1))} isDisabled={currentPage === 1} className="h-8 px-3 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white font-black text-[9px] uppercase border border-gray-200 dark:border-white/5 rounded-lg shadow-sm hover:border-emerald-500/30">PREV</Button>
                                <span className="text-[10px] font-black text-gray-900 dark:text-white italic px-2 tabular-nums">{currentPage} / {totalPages}</span>
                                <Button size="sm" variant="flat" onPress={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))} isDisabled={currentPage === totalPages || totalPages === 0} className="h-8 px-3 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white font-black text-[9px] uppercase border border-gray-200 dark:border-white/5 rounded-lg shadow-sm hover:border-emerald-500/30">NEXT</Button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* MODAL DE ALERTAS DE STOCK */}
            <Modal isOpen={alertsDialogOpen} onOpenChange={setAlertsDialogOpen} backdrop="blur" scrollBehavior="inside" classNames={{ base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl", closeButton: "text-gray-400 dark:text-zinc-500 hover:text-amber-500 transition-colors" }}>
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex flex-col gap-1 p-8 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50">
                                <h2 className="text-2xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none flex items-center gap-4">
                                    <div className="p-3 bg-amber-50 dark:bg-amber-500/10 rounded-xl text-amber-500 shadow-inner"><AlertTriangle size={24} /></div>
                                    Alertas de Stock
                                </h2>
                                <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-2 ml-[4.5rem]">Referencias en estado crítico (≤ 5 und)</p>
                            </ModalHeader>
                            <ModalBody className="p-6">
                                {lowStockProducts.length === 0 ? (
                                    <div className="py-16 flex flex-col items-center justify-center opacity-40 text-gray-500 dark:text-zinc-500">
                                        <Check size={40} className="mb-4 text-emerald-500" />
                                        <span className="text-[10px] font-black uppercase tracking-widest">STOCK SALUDABLE</span>
                                    </div>
                                ) : (
                                    <div className="flex flex-col gap-2">
                                        {lowStockProducts.map(p => (
                                            <div key={p.barcode} className="bg-gray-50 dark:bg-zinc-900/50 p-4 rounded-xl border border-gray-200 dark:border-white/5 flex items-center justify-between gap-3 group transition-all shadow-sm">
                                                <div className="min-w-0">
                                                    <p className="font-black text-gray-900 dark:text-white text-sm uppercase tracking-tighter truncate italic">{p.productName}</p>
                                                    <p className="text-[9px] font-mono text-gray-500 dark:text-zinc-500 mt-1 uppercase tracking-widest">#{p.barcode}</p>
                                                </div>
                                                <div className="text-right bg-white dark:bg-black px-4 py-2 rounded-xl border border-gray-200 dark:border-white/5 shrink-0 shadow-inner">
                                                    <span className="text-xl font-black text-amber-500 italic tabular-nums leading-none">{p.quantity}</span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </ModalBody>
                        </>
                    )}
                </ModalContent>
            </Modal>

            {/* MODAL CREAR/EDITAR ADAPTADO CLARO/OSCURO */}
            <Modal isOpen={addDialogOpen || editDialogOpen} placement="top-center" scrollBehavior="inside" onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingProduct(null); } }} backdrop="blur" size="2xl" classNames={{ base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl", closeButton: "text-gray-400 dark:text-zinc-500 hover:text-rose-500 transition-colors" }}>
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex flex-col gap-1 p-4 md:p-6 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50">
                                <h2 className="text-2xl md:text-3xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none flex items-center gap-3 md:gap-4">
                                    <div className="h-10 w-10 md:h-12 md:w-12 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-500 flex items-center justify-center rounded-2xl shadow-inner"><Package className="h-6 w-6 md:h-7 md:w-7" /></div>
                                    <div className="flex flex-col">
                                        <span>{addDialogOpen ? "Protocolo de " : "Modificar "} <span className="text-emerald-500">Ingreso</span></span>
                                        <span className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-1 not-italic">Audit Ledger Maestro</span>
                                    </div>
                                </h2>
                            </ModalHeader>

                            <ModalBody className="p-4 md:p-6 gap-4">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="space-y-1.5">
                                        <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic ml-1 flex items-center gap-1"><Barcode size={12} /> Identificador (Barcode)</label>
                                        <div className="relative">
                                            <Input
                                                value={addDialogOpen ? newProduct.barcode : (editingProduct?.barcode || '')}
                                                onValueChange={(v) => {
                                                    if (addDialogOpen) setNewProduct(p => ({ ...p, barcode: v.toUpperCase() }));
                                                    else setEditingProduct(p => p ? { ...p, barcode: v.toUpperCase() } : null);
                                                }}
                                                classNames={{ inputWrapper: "h-12 md:h-14 bg-transparent border border-gray-200 dark:border-white/10 rounded-xl focus-within:border-emerald-500/50 shadow-none", input: "font-black text-xs md:text-sm uppercase italic text-gray-900 dark:text-white" }}
                                            />
                                            <Button isIconOnly size="sm" onPress={() => setIsScannerOpen(true)} className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 md:h-10 md:w-10 bg-emerald-500 text-white rounded-lg shadow-lg"><Camera size={16} /></Button>
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic ml-1">Nombre del Artículo</label>
                                        <Input
                                            value={addDialogOpen ? newProduct.productName : (editingProduct?.productName || '')}
                                            onValueChange={(v) => {
                                                if (addDialogOpen) setNewProduct(p => ({ ...p, productName: v.toUpperCase() }));
                                                else setEditingProduct(p => p ? { ...p, productName: v.toUpperCase() } : null);
                                            }}
                                            classNames={{ inputWrapper: "h-12 md:h-14 bg-transparent border border-gray-200 dark:border-white/10 rounded-xl focus-within:border-emerald-500/50 shadow-none", input: "font-black text-xs md:text-sm uppercase italic text-gray-900 dark:text-white" }}
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                                    <div className="space-y-1.5">
                                        <label className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic ml-1">COSTO NETO</label>
                                        <Input
                                            type="number" variant="flat"
                                            startContent={<span className="text-gray-400 font-black text-sm mr-1">$</span>}
                                            value={String(addDialogOpen ? newProduct.purchasePrice : (editingProduct?.purchasePrice || 0))}
                                            onValueChange={(v) => {
                                                const val = parseFloat(v) || 0;
                                                if (addDialogOpen) {
                                                    setNewProduct(p => ({ ...p, purchasePrice: val, salePrice: applyRounding(val * (1 + newMargin / 100)) }));
                                                } else {
                                                    setEditingProduct(p => p ? { ...p, purchasePrice: val, salePrice: applyRounding(val * (1 + editMargin / 100)) } : null);
                                                }
                                            }}
                                            classNames={{ inputWrapper: "h-12 md:h-14 bg-transparent border-b-2 border-gray-200 dark:border-white/10 rounded-xl shadow-none focus-within:border-emerald-500/50", input: "font-black text-base md:text-lg tabular-nums italic text-gray-900 dark:text-white" }}
                                        />
                                    </div>

                                    <div className="space-y-1.5">
                                        <label className="text-[9px] font-black text-sky-500 uppercase tracking-widest italic ml-1">MARGEN %</label>
                                        <Input
                                            type="number" variant="flat"
                                            endContent={<span className="text-sky-500 font-black text-sm ml-1">%</span>}
                                            value={String(addDialogOpen ? newMargin : editMargin)}
                                            onValueChange={(v) => {
                                                const val = parseFloat(v) || 0;
                                                if (addDialogOpen) {
                                                    setNewMargin(val);
                                                    setNewProduct(p => ({ ...p, marginPercentage: val, salePrice: applyRounding(p.purchasePrice * (1 + val / 100)) }));
                                                } else {
                                                    setEditMargin(val);
                                                    setEditingProduct(p => p ? { ...p, marginPercentage: val, salePrice: applyRounding(p.purchasePrice * (1 + val / 100)) } : null);
                                                }
                                            }}
                                            classNames={{ inputWrapper: "h-12 md:h-14 bg-transparent border-b-2 border-sky-500/50 rounded-xl shadow-none", input: "font-black text-base md:text-lg tabular-nums text-sky-600 dark:text-sky-400 italic text-center" }}
                                        />
                                    </div>

                                    <div className="space-y-1.5">
                                        <label className="text-[9px] font-black text-emerald-500 uppercase tracking-widest italic ml-1">PVP FINAL</label>
                                        <Input
                                            type="number" variant="flat"
                                            startContent={<span className="text-emerald-500 font-black text-sm mr-1">$</span>}
                                            value={String(addDialogOpen ? newProduct.salePrice : (editingProduct?.salePrice || 0))}
                                            onValueChange={(v) => {
                                                const val = applyRounding(parseFloat(v) || 0);
                                                if (addDialogOpen) setNewProduct(p => ({ ...p, salePrice: val }));
                                                else setEditingProduct(p => p ? { ...p, salePrice: val } : null);
                                            }}
                                            classNames={{ inputWrapper: "h-12 md:h-14 bg-transparent border-b-2 border-emerald-500/50 rounded-xl shadow-none", input: "font-black text-lg md:text-xl tabular-nums text-emerald-600 dark:text-emerald-400 italic" }}
                                        />
                                    </div>

                                    <div className="space-y-1.5">
                                        <label className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic ml-1">STOCK ACT.</label>
                                        <Input
                                            isDisabled={addDialogOpen ? newProduct.isWeighted : (editingProduct?.isWeighted || false)}
                                            type={(addDialogOpen ? newProduct.isWeighted : editingProduct?.isWeighted) ? "text" : "number"}
                                            variant="flat"
                                            value={(addDialogOpen ? newProduct.isWeighted : editingProduct?.isWeighted) ? "∞ ILIMITADO" : String(addDialogOpen ? newProduct.quantity : (editingProduct?.quantity || 0))}
                                            onValueChange={(v) => {
                                                const val = parseFloat(v) || 0;
                                                if (addDialogOpen) setNewProduct(p => ({ ...p, quantity: val }));
                                                else setEditingProduct(p => p ? { ...p, quantity: val } : null);
                                            }}
                                            classNames={{ inputWrapper: "h-12 md:h-14 bg-transparent border border-gray-200 dark:border-white/10 rounded-xl shadow-none focus-within:border-emerald-500/50", input: "font-black text-base md:text-lg tabular-nums text-center text-gray-900 dark:text-white" }}
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-1">
                                    <div className="space-y-1.5">
                                        <label className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic ml-1">CATEGORÍA</label>
                                        <Select
                                            selectedKeys={addDialogOpen ? (newProduct.categoryId ? [String(newProduct.categoryId)] : []) : (editingProduct?.categoryId ? [String(editingProduct.categoryId)] : [])}
                                            onSelectionChange={(keys) => {
                                                const v = Array.from(keys)[0] as string;
                                                if (addDialogOpen) setNewProduct(p => ({ ...p, categoryId: v }));
                                                else setEditingProduct(p => p ? { ...p, categoryId: v } : null);
                                            }}
                                            classNames={{ 
                                                trigger: "h-12 md:h-14 bg-transparent border border-gray-200 dark:border-white/10 rounded-xl shadow-none focus-within:border-emerald-500/50", 
                                                value: "font-black text-xs md:text-sm uppercase italic text-gray-900 dark:text-white",
                                                popoverContent: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-2xl rounded-xl"
                                            }}
                                        >
                                            {categories.map(c => <SelectItem key={String(c.id)} textValue={c.name.toUpperCase()}>{c.name.toUpperCase()}</SelectItem>)}
                                        </Select>
                                    </div>
                                    <div className="flex items-center gap-3 bg-transparent p-3 md:p-4 rounded-xl border border-gray-200 dark:border-white/10 shadow-none">
                                        <Checkbox
                                            size="lg"
                                            isSelected={addDialogOpen ? newProduct.isWeighted : (editingProduct?.isWeighted || false)}
                                            onValueChange={(v) => {
                                                const qty = v ? 999999 : 0;
                                                if (addDialogOpen) setNewProduct(p => ({ ...p, isWeighted: v, quantity: qty }));
                                                else setEditingProduct(p => p ? { ...p, isWeighted: v, quantity: qty } : null);
                                            }}
                                            color="success" // Emerald color
                                        />
                                        <div className="flex flex-col">
                                            <span className="text-[11px] font-black text-gray-900 dark:text-white uppercase leading-none italic">PESAJE EN BALANZA</span>
                                            <span className="text-[9px] font-bold text-gray-400 dark:text-zinc-500 uppercase mt-1 tracking-widest">Permite fracciones (Ej: 1.5 KG)</span>
                                        </div>
                                    </div>
                                </div>
                            </ModalBody>

                            <ModalFooter className="p-4 md:p-6 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50">
                                <Button
                                    className="w-full h-12 md:h-14 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-xs md:text-sm tracking-[0.2em] rounded-2xl transition-all shadow-xl hover:scale-105 active:scale-95 italic"
                                    onPress={addDialogOpen ? handleAddProduct : handleEditProduct}
                                >
                                    <Sparkles size={20} className="mr-2" />
                                    {addDialogOpen ? "Sincronizar Producto al Almacén" : "Actualizar Registro Maestro"}
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

            {/* MODAL ELIMINAR */}
            <Modal isOpen={deleteDialogOpen} onOpenChange={setDeleteDialogOpen} backdrop="blur" classNames={{ base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl", closeButton: "text-gray-400 hover:text-rose-500 transition-colors" }}>
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="text-rose-500 font-black uppercase text-xl p-8 pb-4 italic flex items-center gap-3">
                                <div className="p-3 bg-rose-50 dark:bg-rose-500/10 rounded-xl"><AlertTriangle size={24} /></div> Protocolo de Purga
                            </ModalHeader>
                            <ModalBody className="px-8 pb-8 text-center text-sm font-bold text-gray-500 dark:text-zinc-400 uppercase leading-relaxed tracking-widest italic">
                                ¿Seguro que desea eliminar permanentemente la referencia <span className="text-rose-500 font-mono">#{deletingBarcode}</span> del Vault maestro?
                            </ModalBody>
                            <ModalFooter className="p-6 border-t border-gray-100 dark:border-white/5 flex gap-3">
                                <Button variant="flat" className="flex-1 h-14 rounded-xl font-black text-[11px] tracking-widest bg-gray-100 dark:bg-zinc-900 text-gray-900 dark:text-white" onPress={onClose}>CANCELAR</Button>
                                <Button color="danger" className="flex-1 h-14 rounded-xl font-black text-[11px] tracking-widest shadow-xl shadow-rose-500/20" onPress={handleDelete}>SÍ, ELIMINAR</Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

            <ScannerOverlay isOpen={isScannerOpen} onClose={() => setIsScannerOpen(false)} onResult={handleScanResult} title="Protocolo Laser V5.0" />
        </div>
    );
}