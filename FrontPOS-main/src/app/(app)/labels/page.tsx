"use client";

import { useState, useMemo } from 'react';
import { Button, Input, Table, TableHeader, TableColumn, TableBody, TableRow, TableCell, Spinner } from "@heroui/react";
import { Search, Printer, PlusCircle, Minus, Plus, Trash2, Tag, Store, Layers, Barcode } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Product } from '@/lib/definitions';
import { formatCurrency } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

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
            {/* TRUCO CSS: ELIMINA TEXTOS DEL NAVEGADOR Y PREPARA MULTIPÁGINA */}
            <style dangerouslySetInnerHTML={{
                __html: `
                @media print {
                    @page { margin: 0.5cm; } /* Margen pequeño para evitar cortes, pero sin que salgan textos de URL */
                    body { -webkit-print-color-adjust: exact; }
                }
            `}} />

            {/* ================================================================= */}
            {/* UI DE LA APLICACIÓN (SE OCULTA AL IMPRIMIR CON print:hidden)      */}
            {/* ================================================================= */}
            <div className="flex flex-col h-screen gap-2 p-2 bg-gray-50 dark:bg-zinc-950 text-gray-900 dark:text-white overflow-hidden print:hidden transition-colors duration-500">

                {/* HEADER ADAPTABLE */}
                <header className="flex flex-col md:flex-row items-center justify-between gap-4 p-4 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl shrink-0 shadow-sm transition-colors">
                    <div className="flex items-center gap-3 w-full md:w-auto">
                        <div className="h-12 w-12 rounded-xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center shadow-inner">
                            <Tag size={24} />
                        </div>
                        <div className="flex flex-col">
                            <span className="text-xl font-black uppercase italic tracking-tighter leading-none">ETIQUETAS</span>
                            <span className="text-[9px] font-black text-emerald-500 uppercase tracking-widest mt-1">Generador B&N</span>
                        </div>
                    </div>

                    <div className="flex items-center gap-3 w-full md:w-auto">
                        <Button
                            onPress={handlePrint}
                            isDisabled={printQueue.length === 0}
                            className="bg-emerald-500 text-white font-black uppercase text-[10px] h-10 px-8 rounded-xl shrink-0 shadow-lg shadow-emerald-500/20 hover:scale-105 transition-transform italic tracking-widest"
                        >
                            <Printer size={16} className="mr-2" />
                            IMPRIMIR ({totalLabels})
                        </Button>
                    </div>
                </header>

                <div className="flex flex-col md:flex-row gap-2 flex-1 min-h-0">
                    {/* PANEL IZQUIERDO: BÚSQUEDA */}
                    <div className="w-full md:w-1/3 flex flex-col gap-2">
                        <div className="bg-white dark:bg-zinc-900 p-4 border border-gray-200 dark:border-white/5 rounded-2xl shadow-sm flex flex-col transition-colors">
                            <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mb-2 flex items-center gap-2"><Search size={12} /> Buscar Producto</label>
                            <Input
                                placeholder="NOMBRE O CÓDIGO..."
                                value={filter} onValueChange={setFilter}
                                classNames={{ inputWrapper: "h-12 bg-gray-50 dark:bg-black border border-gray-200 dark:border-white/5 rounded-xl shadow-inner focus-within:border-emerald-500/50", input: "font-black text-xs uppercase italic text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600" }}
                            />
                        </div>

                        {filter && (
                            <div className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl shadow-sm overflow-hidden flex flex-col transition-colors">
                                {filteredProducts.map(p => (
                                    <div key={p.barcode} className="p-3 border-b border-gray-100 dark:border-white/5 flex justify-between items-center hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-xs font-black text-gray-900 dark:text-white uppercase italic truncate">{p.productName}</span>
                                            <span className="text-[9px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest mt-0.5">${formatCurrency(p.salePrice)}</span>
                                        </div>
                                        <Button isIconOnly size="sm" className="bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 min-w-8 rounded-lg" onPress={() => addToQueue(p)}>
                                            <PlusCircle size={16} />
                                        </Button>
                                    </div>
                                ))}
                                {filteredProducts.length === 0 && (
                                    <div className="p-6 text-center text-[10px] font-bold text-gray-400 dark:text-zinc-600 uppercase tracking-widest">No hay resultados</div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* PANEL DERECHO: COLA DE IMPRESIÓN */}
                    <div className="w-full md:w-2/3 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl shadow-sm flex flex-col min-h-0 transition-colors">
                        <div className="p-4 border-b border-gray-100 dark:border-white/5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-gray-50/50 dark:bg-zinc-950/50 rounded-t-2xl">
                            <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">Lista de Impresión</span>
                            <div className="flex items-center gap-2">
                                <Button size="sm" className="bg-emerald-500 text-white text-[9px] font-black uppercase tracking-widest rounded-lg shadow-lg shadow-emerald-500/20" onPress={addAllToQueue}>
                                    <Layers size={14} className="mr-1" /> Añadir Todos
                                </Button>
                                <Button size="sm" variant="flat" color="danger" className="text-[9px] font-black uppercase tracking-widest rounded-lg bg-rose-50 dark:bg-rose-500/10 text-rose-500" onPress={() => setPrintQueue([])}>
                                    Limpiar Todo
                                </Button>
                            </div>
                        </div>

                        <div className="flex-1 overflow-auto custom-scrollbar p-2">
                            {printQueue.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center opacity-30 text-gray-500 dark:text-zinc-500">
                                    <Tag size={60} strokeWidth={1} className="mb-4" />
                                    <span className="text-[11px] font-black uppercase tracking-widest">Añade productos para imprimir</span>
                                </div>
                            ) : (
                                <Table removeWrapper aria-label="Cola" classNames={{ th: "bg-transparent text-gray-400 dark:text-zinc-500 font-black uppercase text-[9px] tracking-widest", td: "py-2 border-b border-gray-100 dark:border-white/5", tr: "hover:bg-gray-50 dark:hover:bg-white/5 transition-colors" }}>
                                    <TableHeader>
                                        <TableColumn>PRODUCTO</TableColumn>
                                        <TableColumn align="center">ETIQUETAS</TableColumn>
                                        <TableColumn align="end">ACCIONES</TableColumn>
                                    </TableHeader>
                                    <TableBody>
                                        {printQueue.map((item) => (
                                            <TableRow key={item.product.barcode}>
                                                <TableCell>
                                                    <div className="flex flex-col">
                                                        <span className="text-xs font-black text-gray-900 dark:text-white uppercase italic truncate max-w-[200px] md:max-w-[300px]">{item.product.productName}</span>
                                                        <span className="text-[9px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest mt-0.5">#{item.product.barcode} - ${formatCurrency(item.product.salePrice)}</span>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex items-center justify-center gap-3">
                                                        <Button isIconOnly size="sm" variant="flat" className="h-7 w-7 rounded-lg bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-400 border border-gray-200 dark:border-white/5" onPress={() => updateQuantity(item.product.barcode, -1)}><Minus size={12} /></Button>
                                                        <span className="font-black text-sm tabular-nums w-4 text-center text-gray-900 dark:text-white">{item.quantity}</span>
                                                        <Button isIconOnly size="sm" variant="flat" className="h-7 w-7 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 border border-emerald-200 dark:border-emerald-500/20" onPress={() => updateQuantity(item.product.barcode, 1)}><Plus size={12} /></Button>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex justify-end">
                                                        <Button isIconOnly size="sm" variant="flat" className="bg-rose-50 dark:bg-rose-500/10 text-rose-500 rounded-lg hover:bg-rose-500 hover:text-white transition-all" onPress={() => removeFromQueue(item.product.barcode)}>
                                                            <Trash2 size={14} />
                                                        </Button>
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* ================================================================= */}
            {/* MODO IMPRESIÓN: CUADRÍCULA 2 COLUMNAS, MULTIPÁGINA AUTOMÁTICO     */}
            {/* ================================================================= */}
            {/* print:grid y grid-cols-2 obligan a 2 columnas. w-full asegura ocupar la hoja */}
            <div className="hidden print:grid grid-cols-2 gap-x-4 gap-y-6 pt-4 bg-white w-full max-w-full justify-items-center">
                {printQueue.flatMap(item =>
                    Array(item.quantity).fill(0).map((_, i) => (
                        <div
                            key={`${item.product.barcode}-${i}`}
                            // break-inside-avoid es MAGIA: evita que se corte por la mitad al cambiar de hoja
                            className="w-[9.5cm] h-[5.5cm] border-4 border-black flex flex-col items-center justify-between p-2 bg-white text-black break-inside-avoid relative box-border"
                        >

                            {/* Nombre del Producto (Arriba) */}
                            <div className="w-full text-center flex-1 flex items-center justify-center border-b-2 border-black/20 pb-1">
                                <h1 className="text-[14px] font-black uppercase text-center leading-tight line-clamp-2 text-black">
                                    {item.product.productName}
                                </h1>
                            </div>

                            {/* Precio Gigante (Centro) */}
                            <div className="flex items-start justify-center flex-none py-2 w-full">
                                <span className="text-3xl font-black mt-1 mr-1 text-black">$</span>
                                <span className="text-6xl font-black tracking-tighter leading-none text-black" style={{ fontSize: String(item.product.salePrice).length > 5 ? '3.5rem' : '4rem' }}>
                                    {formatCurrency(item.product.salePrice)}
                                </span>
                            </div>

                            {/* Código y detalles (Abajo) */}
                            <div className="w-full flex items-end justify-between pt-1 border-t-2 border-black/20">
                                <div className="flex items-center gap-1">
                                    <Barcode size={12} className="text-black" />
                                    <span className="text-[10px] font-black tracking-widest font-mono text-black">{item.product.barcode}</span>
                                </div>
                                <span className="text-[8px] font-bold tracking-widest uppercase text-black">PVP</span>
                            </div>

                        </div>
                    ))
                )}
            </div>
        </>
    );
}