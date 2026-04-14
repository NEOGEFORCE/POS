"use client";

import { useState, useMemo } from 'react';
import { Button, Spinner } from "@heroui/react";
import { Printer, Tag } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Product } from '@/lib/definitions';
import { useToast } from '@/hooks/use-toast';
import dynamic from 'next/dynamic';

const LabelSearch = dynamic(() => import('./components/LabelSearch'), { ssr: false });
const LabelQueue = dynamic(() => import('./components/LabelQueue'), { ssr: false });
const PrintableLabels = dynamic(() => import('./components/PrintableLabels'), { ssr: false });

// Estructura para la cola de impresión
interface PrintItem {
    product: Product;
    quantity: number;
}

export default function LabelsPage() {
    const { toast } = useToast();
    const { data: productsData, isLoading } = useApi<any>('/products/paginated?page=1&pageSize=1000');

    const [filter, setFilter] = useState('');
    const [printQueue, setPrintQueue] = useState<PrintItem[]>([]);

    const products: Product[] = useMemo(() => productsData?.items || (Array.isArray(productsData) ? productsData : []), [productsData]);

    const filteredProducts = useMemo(() => {
        if (!filter) return [];
        const query = filter.toLowerCase();
        return products.filter((p: Product) =>
            p.productName.toLowerCase().includes(query) ||
            p.barcode.includes(query.toUpperCase())
        ).slice(0, 5);
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

        toast({ title: "Lista Actualizada", description: `Se añadieron ${products.length} referencias a la cola de impresión.` });
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
        window.print();
    };

    const totalLabels = printQueue.reduce((acc, item) => acc + item.quantity, 0);

    if (isLoading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="success" size="lg" /></div>;

    return (
        <>
            <style dangerouslySetInnerHTML={{
                __html: `
                @media print {
                    @page { margin: 0.5cm; }
                    body { -webkit-print-color-adjust: exact; }
                }
            `}} />

            <div className="flex flex-col h-screen gap-2 p-2 bg-gray-50 dark:bg-zinc-950 text-gray-900 dark:text-white overflow-hidden print:hidden transition-colors duration-500">
                <header className="flex flex-col md:flex-row items-center justify-between gap-4 p-4 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-lg shrink-0 shadow-sm transition-colors">
                    <div className="flex items-center gap-3 w-full md:w-auto">
                        <div className="h-10 w-10 rounded-xl bg-emerald-500 text-white flex items-center justify-center shadow-sm">
                            <Tag size={20} strokeWidth={3} />
                        </div>
                        <div className="flex flex-col">
                            <h1 className="text-sm font-black uppercase italic tracking-tighter leading-none">ETIQUETAS</h1>
                            <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest mt-0.5 opacity-80 italic">CENTRAL DE IMPRESIÓN</p>
                        </div>
                    </div>

                    <div className="flex items-center gap-3 w-full md:w-auto">
                        <Button
                            onPress={handlePrint}
                            isDisabled={printQueue.length === 0}
                            className="bg-emerald-500 text-white font-black uppercase text-[10px] h-10 px-8 rounded-lg shrink-0 shadow-md hover:scale-105 transition-transform italic tracking-widest"
                        >
                            <Printer size={16} className="mr-2" />
                            IMPRIMIR ({totalLabels})
                        </Button>
                    </div>
                </header>

                <div className="flex flex-col md:flex-row gap-2 flex-1 min-h-0">
                    <LabelSearch 
                        filter={filter}
                        onFilterChange={setFilter}
                        filteredProducts={filteredProducts}
                        onAddToQueue={addToQueue}
                    />

                    <LabelQueue 
                        printQueue={printQueue}
                        onAddAll={addAllToQueue}
                        onClearAll={() => setPrintQueue([])}
                        onUpdateQuantity={updateQuantity}
                        onRemove={removeFromQueue}
                    />
                </div>
            </div>

            <PrintableLabels printQueue={printQueue} />
        </>
    );
}
