"use client";

import { useState, useMemo } from 'react';
import { Button, Spinner } from "@heroui/react";
import { Printer, Tag, LayoutDashboard, RefreshCw } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Product } from '@/lib/definitions';
import { useToast } from '@/hooks/use-toast';
import dynamic from 'next/dynamic';

const LabelSearch = dynamic(() => import('./components/LabelSearch'), { ssr: false });
const LabelQueue = dynamic(() => import('./components/LabelQueue'), { ssr: false });
const PrintableLabels = dynamic(() => import('./components/PrintableLabels'), { ssr: false });

interface PrintItem {
    product: Product;
    quantity: number;
}

export default function LabelsPage() {
    const { toast } = useToast();
    const { data: productsData, isLoading, mutate } = useApi<any>('/products/paginated?page=1&pageSize=1000');

    const [filter, setFilter] = useState('');
    const [printQueue, setPrintQueue] = useState<PrintItem[]>([]);

    const products: Product[] = useMemo(() => productsData?.items || (Array.isArray(productsData) ? productsData : []), [productsData]);

    const filteredProducts = useMemo(() => {
        if (!filter) return [];
        const query = filter.toLowerCase();
        return products.filter((p: Product) =>
            p.productName.toLowerCase().includes(query) ||
            p.barcode.includes(query.toUpperCase())
        ).slice(0, 8);
    }, [products, filter]);

    const addToQueue = (product: Product) => {
        setPrintQueue(prev => {
            const exists = prev.find(item => item.product.barcode === product.barcode);
            if (exists) {
                return prev.map(item => item.product.barcode === product.barcode ? { ...item, quantity: item.quantity + 1 } : item);
            }
            return [{ product, quantity: 1 }, ...prev];
        });
        setFilter('');
    };

    const addAllToQueue = () => {
        if (products.length === 0) return;
        setPrintQueue(prev => {
            const newQueue = [...prev];
            const existingBarcodes = new Set(newQueue.map(item => item.product.barcode));
            products.forEach(p => {
                if (!existingBarcodes.has(p.barcode)) {
                    newQueue.push({ product: p, quantity: 1 });
                }
            });
            return newQueue;
        });
        toast({ variant: "success", title: "LISTA ACTUALIZADA", description: `Se añadieron ${products.length} referencias.` });
    };

    const updateQuantity = (barcode: string, delta: number) => {
        setPrintQueue(prev => prev.map(item => {
            if (item.product.barcode === barcode) {
                const newQuantity = Math.max(1, item.quantity + delta);
                return { ...item, quantity: newQuantity };
            }
            return item;
        }));
    };

    const removeFromQueue = (barcode: string) => {
        setPrintQueue(prev => prev.filter(item => item.product.barcode !== barcode));
    };

    const handlePrint = () => {
        if (printQueue.length === 0) return;
        window.print();
    };

    const totalLabels = printQueue.reduce((acc, item) => acc + item.quantity, 0);

    if (isLoading) return (
        <div className="flex flex-col items-center justify-center h-full min-h-[60vh] gap-4 bg-gray-50 dark:bg-[#09090b] transition-colors duration-500 rounded-[2rem] border border-gray-200 dark:border-white/5 m-4">
            <Spinner color="success" size="lg" />
            <p className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 tracking-widest uppercase animate-pulse tracking-tight">Sincronizando inventario...</p>
        </div>
    );

    return (
        <div className="flex flex-col min-h-screen gap-1 p-1 bg-gray-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50 transition-colors duration-500 pb-20">
            <style dangerouslySetInnerHTML={{
                __html: `
                @media print {
                    @page { margin: 0.5cm; }
                    body { -webkit-print-color-adjust: exact; background: white !important; }
                    .print\\:hidden { display: none !important; }
                }
            `}} />

            {/* HEADER COMPACTO PREMIUM */}
            <header className="flex items-center justify-between gap-2 p-2 card-base border-none rounded-2xl shrink-0 shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-colors sticky top-0 z-50 print:hidden">
                <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 flex items-center justify-center text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shrink-0">
                        <Tag size={16} />
                    </div>
                    <div className="flex flex-col">
                        <h1 className="text-sm font-medium uppercase tracking-tighter leading-none tracking-tight">ETIQUETAS</h1>
                        <p className="text-[9px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-widest mt-0.5 opacity-80 tracking-tight">IMPRESION CENTRAL</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        variant="flat"
                        size="sm"
                        onPress={() => mutate()}
                        className="bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-100 uppercase tracking-widest text-[9px] font-medium h-8 px-3 rounded-2xl border-none transition-transform active:scale-95"
                    >
                        <RefreshCw size={14} />
                    </Button>
                    <Button
                        color="success"
                        size="sm"
                        isDisabled={printQueue.length === 0}
                        onPress={handlePrint}
                        className={`uppercase tracking-widest text-[9px] font-medium ${printQueue.length > 0 ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] ' : 'bg-gray-200 dark:bg-zinc-800 text-gray-400'} h-8 px-4 rounded-2xl transition-all active:scale-95 tracking-tight`}
                    >
                        <Printer size={14} className="mr-1" /> IMPRIMIR ({totalLabels})
                    </Button>
                </div>
            </header>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-1 flex-1 min-h-0 print:hidden">
                {/* IZQUIERDA: Buscador y Filtros (35%) */}
                <div className="lg:col-span-4 flex flex-col gap-1 overflow-hidden">
                    <LabelSearch
                        filter={filter}
                        onFilterChange={setFilter}
                        filteredProducts={filteredProducts}
                        onAddToQueue={addToQueue}
                    />

                    <div className="mt-auto p-4 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 border border-emerald-500/10 hidden lg:block">
                        <p className="text-[9px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 uppercase tracking-[0.2em] mb-1 tracking-tight">Tip Pro</p>
                        <p className="text-[11px] text-gray-500 dark:text-zinc-400 leading-relaxed tracking-tight">
                            Agrega productos rapidamente y ajusta las cantidades antes de imprimir. El diseno esta optimizado para ahorro de tinta.
                        </p>
                    </div>
                </div>

                {/* DERECHA: Cola de Impresion (65%) */}
                <div className="lg:col-span-8 flex flex-col gap-1 overflow-hidden flex-1 w-full relative">
                    <LabelQueue
                        printQueue={printQueue}
                        onAddAll={addAllToQueue}
                        onClearAll={() => setPrintQueue([])}
                        onUpdateQuantity={updateQuantity}
                        onRemove={removeFromQueue}
                    />
                </div>
            </div>

            <div className="hidden print:block bg-white w-full">
                <PrintableLabels printQueue={printQueue} />
            </div>
        </div>
    );
}