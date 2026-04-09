"use client";

import { useState, useEffect, useRef } from 'react';
import { Search, RotateCcw, CheckCircle2, AlertCircle, ShoppingCart, Camera, History } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Sale, Product } from '@/lib/definitions';
import { ScannerOverlay } from '@/components/ScannerOverlay';

// Importaciones de HeroUI
import {
    Button, Input, Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Select, SelectItem, Pagination, Chip, Card, CardHeader, CardBody
} from "@heroui/react";

export default function ReturnsPage() {
    const [searchId, setSearchId] = useState('');
    const [searchDate, setSearchDate] = useState('');
    const [searchResults, setSearchResults] = useState<Sale[]>([]);
    const [searchResultsPage, setSearchResultsPage] = useState(1);
    const [searchResultsTotal, setSearchResultsTotal] = useState(0);
    const [recentSales, setRecentSales] = useState<Sale[]>([]);
    const [isResultsDialogOpen, setIsResultsDialogOpen] = useState(false);
    const [sale, setSale] = useState<Sale | null>(null);
    const [loading, setLoading] = useState(false);
    const [returningItems, setReturningItems] = useState<any[]>([]);
    const [exchangeItems, setExchangeItems] = useState<any[]>([]);
    const [productSearch, setProductSearch] = useState('');
    const [products, setProducts] = useState<Product[]>([]);
    const [allProducts, setAllProducts] = useState<Product[]>([]);
    const [returnDialogOpen, setReturnDialogOpen] = useState(false);
    const [returnReason, setReturnReason] = useState('');
    const [returnType, setReturnType] = useState('REFUND'); // 'REFUND' or 'EXCHANGE'

    const searchRef = useRef<HTMLInputElement>(null);
    const directSearchRef = useRef<HTMLInputElement>(null);
    const hiddenScannerRef = useRef<HTMLInputElement>(null);
    const [isScannerOpen, setIsScannerOpen] = useState(false);
    const [barcodeInput, setBarcodeInput] = useState('');
    const { toast } = useToast();

    // --- LÓGICA DE NEGOCIO (Intacta) ---
    const fetchRecentSales = async () => {
        const token = localStorage.getItem('org-pos-token');
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/sales/history?pageSize=10`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setRecentSales(data.items || []);
            }
        } catch (error) {
            console.error("Error fetching recent sales", error);
        }
    };

    const fetchAllProducts = async () => {
        const token = localStorage.getItem('org-pos-token');
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/all-products`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setAllProducts(data || []);
            }
        } catch (error) {
            console.error("Error fetching products", error);
        }
    };

    useEffect(() => {
        searchRef.current?.focus();
        fetchRecentSales();
        fetchAllProducts();
    }, []);

    const handleSearch = async (isDateSearch = false, page = 1) => {
        if (!searchId && !isDateSearch) return;
        if (isDateSearch && !searchDate) return;

        setLoading(true);
        const token = localStorage.getItem('org-pos-token');
        try {
            if (isDateSearch) {
                const pageSize = 10;
                const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/sales/history?from=${searchDate}T00:00:00&to=${searchDate}T23:59:59&page=${page}&pageSize=${pageSize}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (!res.ok) throw new Error('Error al buscar ventas por fecha');
                const data = await res.json();

                if (!data.items || data.items.length === 0) {
                    toast({ variant: 'destructive', title: 'Sin resultados', description: 'No se encontraron ventas para esa fecha.' });
                } else if (data.items.length === 1 && page === 1 && data.total === 1) {
                    loadSale(data.items[0]);
                } else {
                    setSearchResults(data.items);
                    setSearchResultsTotal(data.total || 0);
                    setSearchResultsPage(page);
                    setIsResultsDialogOpen(true);
                }
            } else {
                let res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/sales/history/${searchId}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (res.ok) {
                    const data = await res.json();
                    loadSale(data);
                } else {
                    const p = allProducts.find(x => x.barcode === searchId);
                    if (p) {
                        toast({ title: 'Producto Detectado', description: 'Buscando ventas que contengan este producto...' });
                        const resByProd = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/sales/history?barcode=${searchId}&page=1&pageSize=20`, {
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        if (resByProd.ok) {
                            const data = await resByProd.json();
                            if (data.items && data.items.length > 0) {
                                setSearchResults(data.items);
                                setSearchResultsTotal(data.total || 0);
                                setSearchResultsPage(1);
                                setIsResultsDialogOpen(true);
                                return;
                            }
                        }
                    }
                    throw new Error('No se encontró venta con ese ID o DNI');
                }
            }
        } catch (error: any) {
            toast({ variant: 'destructive', title: 'Error', description: error.message });
            setSale(null);
        } finally {
            setLoading(false);
        }
    };

    const loadSale = (saleData: Sale) => {
        const fullyReturned = saleData.details.every((d: any) => (d.quantity - (d.returnedQty || 0)) <= 0);
        if (fullyReturned) {
            toast({ variant: 'destructive', title: 'Factura ya devuelta', description: 'Todos los artículos de esta factura ya han sido retornados.' });
        }
        setSale(saleData);
        setReturningItems(saleData.details.map((d: any) => ({
            ...d,
            returnQty: 0,
            productName: d.product?.productName || 'Producto'
        })));
        setSearchId(saleData.id.toString());
        setIsResultsDialogOpen(false);
    };

    const handleQtyChange = (barcode: string, qty: number, isExchange = false) => {
        const updater = isExchange ? setExchangeItems : setReturningItems;
        updater(prev => prev.map(item => {
            if (item.barcode === barcode) {
                let max = 999999;

                if (isExchange) {
                    const prod = allProducts.find(p => p.barcode === barcode);
                    max = prod ? prod.quantity : 999999;
                } else {
                    if (item.isManual) {
                        const prod = allProducts.find(p => p.barcode === barcode);
                        max = prod ? prod.quantity : 999999;
                    } else {
                        const alreadyReturned = item.returnedQty || 0;
                        max = (item.quantity || 0) - alreadyReturned;
                    }
                }

                const finalQty = Math.min(Math.max(0, qty), max);

                if (!isExchange && finalQty > max && max >= 0) {
                    toast({ variant: 'destructive', title: 'Límite excedido', description: `Solo puedes devolver hasta ${max} unidades.` });
                }

                return { ...item, returnQty: finalQty, cartQuantity: finalQty };
            }
            return item;
        }).filter(item => (item.returnQty > 0 || item.cartQuantity > 0 || !item.isManual)));
    };

    const addProductToReturn = (p: any, isExchange = false) => {
        if (sale && !isExchange) {
            const isInSale = sale.details.some((d: any) => d.barcode === p.barcode);
            if (!isInSale) {
                toast({ variant: 'destructive', title: 'Producto no válido', description: 'Este producto no forma parte de la factura seleccionada.' });
                return;
            }
        }

        const updater = isExchange ? setExchangeItems : setReturningItems;
        updater(prev => {
            const existing = prev.find(i => i.barcode === p.barcode);
            if (existing) {
                let max = 999999;
                if (isExchange) {
                    max = p.quantity || 999999;
                } else if (sale) {
                    const alreadyReturned = existing.returnedQty || 0;
                    max = (existing.quantity || 0) - alreadyReturned;
                } else {
                    max = p.quantity || 999999;
                }

                if (!isExchange && (existing.returnQty || 0) >= max) {
                    toast({ variant: 'destructive', title: 'Límite alcanzado', description: `No puedes devolver más de ${max} unidades.` });
                    return prev;
                }
                return prev.map(i => i.barcode === p.barcode ? { ...i, returnQty: (i.returnQty || 0) + 1, cartQuantity: (i.cartQuantity || 0) + 1 } : i);
            }

            return [...prev, {
                ...p,
                returnQty: 1,
                cartQuantity: 1,
                isManual: !sale || isExchange,
                unitPrice: isExchange ? p.salePrice : (p.salePrice || 0),
                productName: p.productName
            }];
        });
        setProductSearch('');
        setProducts([]);
        setExchangeSearch('');
        setExchangeProducts([]);
    };

    const totalReturned = returningItems.reduce((acc, item) => acc + (item.unitPrice * (item.returnQty || 0)), 0);
    const totalExchange = exchangeItems.reduce((acc, item) => acc + (item.unitPrice * (item.cartQuantity || 0)), 0);
    const balance = totalReturned - totalExchange;

    const isTransfer = sale?.paymentMethod?.toUpperCase().includes('TRANSFER') || sale?.paymentMethod?.toUpperCase().includes('MIXTO');

    useEffect(() => {
        if (returnDialogOpen && isTransfer && balance > 0) {
            setReturnType('EXCHANGE');
        }
    }, [returnDialogOpen, isTransfer, balance]);

    const processReturn = async () => {
        if (returningItems.every(i => i.returnQty === 0)) {
            toast({ variant: 'destructive', title: 'Error', description: 'Selecciona artículos para devolver.' });
            return;
        }

        const token = localStorage.getItem('org-pos-token');
        const allDetails = [
            ...returningItems.filter(i => i.returnQty > 0).map(i => {
                let max = 999999;
                if (sale) {
                    max = (i.quantity || 0) - (i.returnedQty || 0);
                } else {
                    const prod = allProducts.find(p => p.barcode === i.barcode);
                    max = prod ? prod.quantity : 999999;
                }

                if (i.returnQty > max) {
                    throw new Error(`La cantidad de ${i.productName} excede el límite permitido (${max}).`);
                }

                return {
                    barcode: i.barcode,
                    quantity: i.returnQty,
                    price: i.unitPrice,
                    subtotal: i.unitPrice * i.returnQty,
                    isExchange: false
                };
            }),
            ...exchangeItems.map(i => ({
                barcode: i.barcode,
                quantity: i.cartQuantity,
                price: i.unitPrice,
                subtotal: i.unitPrice * i.cartQuantity,
                isExchange: true
            }))
        ];

        const returnData = {
            saleId: Number(sale?.id) || 0,
            totalReturned: totalReturned,
            reason: returnReason,
            returnType: returnType,
            details: allDetails
        };

        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/returns/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(returnData)
            });

            if (!res.ok) {
                const errorData = await res.json().catch(() => ({}));
                throw new Error(errorData.error || 'Error al procesar la devolución');
            }

            toast({ 
                title: 'Éxito', 
                description: returnType === 'EXCHANGE' 
                    ? 'Cambio procesado. Se ha generado un nuevo registro de venta.' 
                    : 'Devolución procesada correctamente.' 
            });
            setReturnDialogOpen(false);
            setSale(null);
            setSearchId('');
            setReturningItems([]);
            setExchangeItems([]);
            fetchRecentSales();
        } catch (error: any) {
            toast({ variant: 'destructive', title: 'Error', description: error.message });
        }
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const activeElement = document.activeElement as HTMLElement;
            const isInput = activeElement?.tagName === 'INPUT' && !activeElement.classList.contains('scanner-gate');
            if (e.code === 'Space' && (returningItems.length > 0 || exchangeItems.length > 0) && !isInput && !returnDialogOpen) {
                e.preventDefault();
                setReturnDialogOpen(true);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [returningItems.length, exchangeItems.length, returnDialogOpen]);

    useEffect(() => {
        if (productSearch.length >= 8 && /^\d+$/.test(productSearch)) {
            const p = allProducts.find(x => x.barcode === productSearch);
            if (p) {
                addProductToReturn(p);
                setProductSearch('');
                return;
            }
        }

        if (productSearch.length > 0) {
            const filtered = allProducts.filter((p: Product) =>
                p.productName.toLowerCase().includes(productSearch.toLowerCase()) ||
                p.barcode.includes(productSearch)
            );
            setProducts(filtered);
        } else {
            setProducts([]);
        }
    }, [productSearch, allProducts]);

    const [exchangeSearch, setExchangeSearch] = useState('');
    const [exchangeProducts, setExchangeProducts] = useState<Product[]>([]);

    useEffect(() => {
        if (exchangeSearch.length >= 8 && /^\d+$/.test(exchangeSearch)) {
            const p = allProducts.find(x => x.barcode === exchangeSearch);
            if (p) {
                addProductToReturn(p, true);
                setExchangeSearch('');
                return;
            }
        }

        if (exchangeSearch.length > 0) {
            setExchangeProducts(allProducts.filter((p: Product) =>
                p.productName.toLowerCase().includes(exchangeSearch.toLowerCase()) ||
                p.barcode.includes(exchangeSearch)
            ));
        } else {
            setExchangeProducts([]);
        }
    }, [exchangeSearch, allProducts]);

    const handleCodeSubmit = (code: string) => {
        if (!code) return;
        const p = allProducts.find(x => x.barcode === code);
        if (p) addProductToReturn(p);
        else toast({ variant: 'destructive', title: 'Error', description: 'Producto no encontrado' });
    };

    return (
        <div className="flex flex-col gap-6 p-4 md:p-8 w-full min-h-screen bg-gray-50 dark:bg-zinc-950 transition-colors duration-500 font-sans">

            {/* Header (Soporta Claro/Oscuro) */}
            <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-8 py-6 bg-white dark:bg-zinc-900/60 backdrop-blur-xl rounded-[2.5rem] border border-gray-200 dark:border-white/5 shadow-xl">
                <div className="flex items-center gap-5">
                    <div className="h-16 w-16 rounded-[1.5rem] bg-emerald-100 dark:bg-emerald-500/10 flex items-center justify-center border border-emerald-200 dark:border-emerald-500/20 shadow-inner">
                        <RotateCcw className="h-8 w-8 text-emerald-600 dark:text-emerald-500" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-black text-gray-900 dark:text-white uppercase tracking-tighter">
                            Gestión de <span className="text-emerald-600 dark:text-emerald-500">Devoluciones</span>
                        </h1>
                        <p className="text-[10px] text-gray-500 dark:text-zinc-400 font-black uppercase tracking-[0.2em] mt-1">
                            Retornos, cambios y garantías
                        </p>
                    </div>
                </div>
            </header>

            <div className="flex-1 overflow-y-auto space-y-6 pb-40 md:pb-32 custom-scrollbar">

                {/* SECCIÓN DE PRODUCTOS SELECCIONADOS */}
                {(returningItems.length > 0 || exchangeItems.length > 0) && (
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 animate-in fade-in slide-in-from-bottom-8 duration-700">

                        {/* TABLA: PRODUCTOS A DEVOLVER */}
                        <Card className="rounded-[2rem] bg-white dark:bg-zinc-900/60 backdrop-blur-xl border-gray-200 dark:border-white/5 shadow-xl overflow-hidden">
                            <CardHeader className="px-6 py-5 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-transparent">
                                <h3 className="text-emerald-600 dark:text-emerald-500 text-sm font-black uppercase tracking-widest flex items-center gap-3">
                                    <RotateCcw className="h-4 w-4" /> PRODUCTOS A DEVOLVER
                                </h3>
                            </CardHeader>
                            <CardBody className="p-0">
                                <div className="max-h-[300px] overflow-y-auto custom-scrollbar">
                                    <Table aria-label="Devoluciones" isCompact removeWrapper classNames={{ th: "bg-gray-100 dark:bg-zinc-800/80 text-gray-500 dark:text-zinc-400 font-bold uppercase text-[10px] tracking-widest sticky top-0 z-10", td: "py-4 border-b border-gray-100 dark:border-white/5" }}>
                                        <TableHeader>
                                            <TableColumn>ARTÍCULO</TableColumn>
                                            <TableColumn align="center">CANT.</TableColumn>
                                            <TableColumn align="end">TOTAL</TableColumn>
                                        </TableHeader>
                                        <TableBody>
                                            {returningItems.map((item) => (
                                                <TableRow key={item.barcode}>
                                                    <TableCell>
                                                        <div className="font-bold text-gray-900 dark:text-white text-xs uppercase">{item.productName}</div>
                                                        <div className="text-[10px] text-gray-400 dark:text-zinc-500 font-mono mt-1">{item.barcode}</div>
                                                    </TableCell>
                                                    <TableCell>
                                                        <div className="flex items-center justify-center gap-2">
                                                            <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white" onClick={() => handleQtyChange(item.barcode, (item.returnQty || 0) - 1)}>-</Button>
                                                            <span className="font-black text-sm text-gray-900 dark:text-white min-w-[1.5rem] text-center tabular-nums">{item.returnQty}</span>
                                                            <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white" onClick={() => handleQtyChange(item.barcode, (item.returnQty || 0) + 1)}>+</Button>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <div className="font-black text-gray-900 dark:text-white text-sm tabular-nums">
                                                            ${(item.unitPrice * (item.returnQty || 0)).toLocaleString()}
                                                        </div>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
                                <div className="p-6 bg-gray-50 dark:bg-zinc-900/30 border-t border-gray-100 dark:border-white/5 flex justify-between items-center">
                                    <span className="text-xs font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Total Devolución</span>
                                    <span className="text-2xl font-black text-emerald-600 dark:text-emerald-500 tracking-tighter tabular-nums">${totalReturned.toLocaleString()}</span>
                                </div>
                            </CardBody>
                        </Card>

                        {/* TABLA: PRODUCTOS A LLEVAR (CAMBIOS) */}
                        <Card className="rounded-[2rem] bg-white dark:bg-zinc-900/60 backdrop-blur-xl border-gray-200 dark:border-white/5 shadow-xl overflow-hidden">
                            <CardHeader className="px-6 py-5 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-transparent flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                                <h3 className="text-emerald-600 dark:text-emerald-500 text-sm font-black uppercase tracking-widest">PRODUCTOS A LLEVAR (CAMBIO)</h3>
                                <div className="relative w-full sm:w-64">
                                    <Input
                                        size="sm"
                                        placeholder="Escanear o buscar..."
                                        value={exchangeSearch}
                                        onValueChange={setExchangeSearch}
                                        classNames={{ inputWrapper: "bg-gray-100 dark:bg-zinc-800 border-gray-200 dark:border-white/10" }}
                                    />
                                    {exchangeSearch.length > 2 && exchangeProducts.length > 0 && (
                                        <div className="absolute z-50 left-0 right-0 top-12 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-white/10 rounded-2xl shadow-2xl p-2 max-h-60 overflow-y-auto custom-scrollbar">
                                            {exchangeProducts.map(p => (
                                                <button key={p.barcode} className="w-full p-3 text-left hover:bg-emerald-50 dark:hover:bg-emerald-500/20 rounded-xl flex justify-between items-center group transition-colors" onClick={() => { addProductToReturn(p, true); setExchangeSearch(''); }}>
                                                    <div className="flex flex-col">
                                                        <span className="font-bold text-xs uppercase text-gray-900 dark:text-white">{p.productName}</span>
                                                        <span className="text-[10px] text-gray-400 dark:text-zinc-500 font-mono">{p.barcode}</span>
                                                    </div>
                                                    <span className="font-black text-emerald-600 dark:text-emerald-500 text-xs tabular-nums">${p.salePrice.toLocaleString()}</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </CardHeader>
                            <CardBody className="p-0">
                                <div className="max-h-[300px] overflow-y-auto custom-scrollbar">
                                    <Table aria-label="Cambios" isCompact removeWrapper classNames={{ th: "bg-gray-100 dark:bg-zinc-800/80 text-gray-500 dark:text-zinc-400 font-bold uppercase text-[10px] tracking-widest sticky top-0 z-10", td: "py-4 border-b border-gray-100 dark:border-white/5" }}>
                                        <TableHeader>
                                            <TableColumn>ARTÍCULO</TableColumn>
                                            <TableColumn align="center">CANT.</TableColumn>
                                            <TableColumn align="end">SUBTOTAL</TableColumn>
                                        </TableHeader>
                                        <TableBody>
                                            {exchangeItems.map((item) => (
                                                <TableRow key={item.barcode}>
                                                    <TableCell>
                                                        <div className="font-bold text-gray-900 dark:text-white text-xs uppercase">{item.productName}</div>
                                                        <div className="text-[10px] text-gray-400 dark:text-zinc-500 font-mono mt-1">{item.barcode}</div>
                                                    </TableCell>
                                                    <TableCell>
                                                        <div className="flex items-center justify-center gap-2">
                                                            <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white" onClick={() => handleQtyChange(item.barcode, (item.cartQuantity || 0) - 1, true)}>-</Button>
                                                            <span className="font-black text-sm text-gray-900 dark:text-white min-w-[1.5rem] text-center tabular-nums">{item.cartQuantity}</span>
                                                            <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white" onClick={() => handleQtyChange(item.barcode, (item.cartQuantity || 0) + 1, true)}>+</Button>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <div className="font-black text-gray-900 dark:text-white text-sm tabular-nums">
                                                            ${(item.unitPrice * (item.cartQuantity || 0)).toLocaleString()}
                                                        </div>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                    {exchangeItems.length === 0 && <div className="text-center py-12 text-gray-400 dark:text-zinc-600 font-bold uppercase text-xs">Sin productos para cambio</div>}
                                </div>
                                <div className="p-6 bg-gray-50 dark:bg-zinc-900/30 border-t border-gray-100 dark:border-white/5 flex justify-between items-center">
                                    <span className="text-xs font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Total a Llevar</span>
                                    <span className="text-2xl font-black text-gray-900 dark:text-white tracking-tighter tabular-nums">${totalExchange.toLocaleString()}</span>
                                </div>
                            </CardBody>
                        </Card>
                    </div>
                )}

                {/* BUSCADORES PRINCIPALES */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <Card className="rounded-[2rem] bg-white dark:bg-zinc-900/60 backdrop-blur-xl border-gray-200 dark:border-white/5 shadow-xl">
                        <CardHeader className="px-6 py-5 border-b border-gray-100 dark:border-white/5">
                            <h3 className="text-emerald-600 dark:text-emerald-500 flex items-center gap-3 text-sm font-bold uppercase tracking-widest">
                                <Search className="h-5 w-5" /> LOCALIZAR FACTURA
                            </h3>
                        </CardHeader>
                        <CardBody className="p-6">
                            <div className="flex gap-3">
                                <Input
                                    ref={searchRef}
                                    placeholder="ID de venta o DNI de cliente..."
                                    value={searchId}
                                    onValueChange={setSearchId}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                                    variant="faded"
                                    classNames={{ inputWrapper: "h-14 bg-gray-100 dark:bg-zinc-800 border-gray-200 dark:border-white/10 group-hover:border-emerald-500/50 transition-all font-bold text-sm" }}
                                />
                                <Button
                                    className="h-14 px-8 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase tracking-widest text-xs rounded-2xl shadow-lg hover:scale-105 active:scale-95 transition-all"
                                    onPress={() => handleSearch(false)}
                                    isLoading={loading}
                                >
                                    LOCALIZAR
                                </Button>
                            </div>
                        </CardBody>
                    </Card>

                    <Card className="rounded-[2rem] bg-white dark:bg-zinc-900/60 backdrop-blur-xl border-gray-200 dark:border-white/5 shadow-xl overflow-visible">
                        <CardHeader className="px-6 py-5 border-b border-gray-100 dark:border-white/5 flex items-center justify-between">
                            <h3 className="text-emerald-600 dark:text-emerald-500 flex items-center gap-3 text-sm font-bold uppercase tracking-widest">
                                <ShoppingCart className="h-5 w-5" /> DEVOLUCIÓN DIRECTA
                            </h3>
                            <Button
                                variant="flat"
                                size="sm"
                                className={`font-black uppercase tracking-widest text-[10px] ${isScannerOpen ? "bg-emerald-500 text-white" : "bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400"}`}
                                onPress={() => setIsScannerOpen(!isScannerOpen)}
                            >
                                <Camera className="h-4 w-4 mr-2" /> SCANNER
                            </Button>
                        </CardHeader>
                        <CardBody className="p-6 relative overflow-visible">
                            <Input
                                ref={directSearchRef}
                                placeholder="ESCANEÉ O BUSQUE POR NOMBRE..."
                                value={productSearch}
                                onValueChange={setProductSearch}
                                variant="faded"
                                classNames={{ inputWrapper: "h-14 bg-gray-100 dark:bg-zinc-800 border-gray-200 dark:border-white/10 group-hover:border-emerald-500/50 transition-all font-bold text-sm" }}
                            />
                            {products.length > 0 && (
                                <div className="absolute z-[100] left-6 right-6 top-[85px] bg-white dark:bg-zinc-800 border border-gray-200 dark:border-white/10 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-3xl">
                                    {products.slice(0, 5).map(p => (
                                        <button
                                            key={p.barcode}
                                            className="w-full p-4 flex justify-between hover:bg-emerald-50 dark:hover:bg-emerald-500/20 group transition-colors text-left border-b border-gray-100 dark:border-white/5 last:border-0"
                                            onClick={() => addProductToReturn(p)}
                                        >
                                            <div>
                                                <div className="font-bold text-xs text-gray-900 dark:text-white uppercase">{p.productName}</div>
                                                <div className="text-[10px] text-gray-400 dark:text-zinc-500 font-mono mt-1">{p.barcode}</div>
                                            </div>
                                            <div className="font-black text-emerald-600 dark:text-emerald-500 text-sm tabular-nums">${p.salePrice.toLocaleString()}</div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </CardBody>
                    </Card>
                </div>

                {/* HISTORIAL RECIENTE */}
                {!sale && recentSales.length > 0 && (
                    <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
                        <Card className="rounded-[2.5rem] bg-white dark:bg-zinc-900/40 border-gray-200 dark:border-white/5 shadow-2xl overflow-hidden">
                            <CardHeader className="px-8 py-6 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-transparent">
                                <h3 className="text-gray-500 dark:text-zinc-400 flex items-center gap-3 text-xs font-black uppercase tracking-widest">
                                    <History className="h-4 w-4 text-emerald-600 dark:text-emerald-500" /> HISTORIAL RECIENTE
                                </h3>
                            </CardHeader>
                            <CardBody className="p-0">
                                <div className="flex flex-col">
                                    {recentSales.map((s) => (
                                        <button
                                            key={s.id}
                                            onClick={() => loadSale(s)}
                                            className="py-5 px-8 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-white/[0.02] transition-colors border-b border-gray-100 dark:border-white/5 last:border-0 group text-left"
                                        >
                                            <div className="flex items-center gap-6">
                                                <span className="font-black text-sm text-gray-400 dark:text-zinc-500 group-hover:text-emerald-600 dark:group-hover:text-emerald-500 w-12 transition-colors">#{s.id}</span>
                                                <div className="flex flex-col">
                                                    <span className="font-bold text-sm text-gray-900 dark:text-white uppercase">
                                                        {s.client?.name || 'Consumidor Final'}
                                                    </span>
                                                    <span className="text-[10px] text-gray-400 dark:text-zinc-500 font-bold uppercase tracking-widest mt-1">
                                                        {new Date(s.date).toLocaleDateString()} · {new Date(s.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-6">
                                                <span className="font-black text-lg text-gray-900 dark:text-white tabular-nums tracking-tighter">
                                                    ${s.total.toLocaleString()}
                                                </span>
                                                <Chip size="sm" variant="flat" className="font-bold tracking-widest text-[9px] uppercase bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 group-hover:bg-gray-900 group-hover:text-white dark:group-hover:bg-white dark:group-hover:text-black transition-all">
                                                    Gestionar
                                                </Chip>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </CardBody>
                        </Card>
                    </div>
                )}
            </div>

            {/* BARRA INFERIOR DE ACCIÓN (FIXED) - Adaptable a Claro/Oscuro */}
            {(returningItems.length > 0 || exchangeItems.length > 0) && (
                <div className="fixed bottom-0 left-0 right-0 md:left-4 md:right-4 md:bottom-6 z-40 animate-in slide-in-from-bottom-full duration-500">
                    <div className="bg-white dark:bg-zinc-950/90 backdrop-blur-xl p-5 md:p-6 rounded-t-[2.5rem] md:rounded-[2.5rem] shadow-[0_-10px_40px_rgba(0,0,0,0.1)] dark:shadow-2xl border border-gray-200 dark:border-white/10 flex flex-col md:flex-row items-center justify-between gap-6 max-w-7xl mx-auto w-full transition-colors">
                        <div className="flex items-center justify-between w-full md:w-auto gap-8">
                            <div className="space-y-2">
                                <div className="flex items-center gap-3">
                                    <h3 className="font-black text-base md:text-lg tracking-tight text-gray-500 dark:text-zinc-400 uppercase">RESUMEN</h3>
                                    {sale && (
                                        <div className="flex gap-2">
                                            <Chip size="sm" color={isTransfer ? "warning" : "default"} variant="flat" className="font-bold uppercase tracking-widest text-[10px]">
                                                {sale.paymentMethod}
                                            </Chip>
                                            {sale.details.every((d: any) => (d.quantity - (d.returnedQty || 0)) <= 0) && (
                                                <Chip size="sm" color="danger" variant="shadow" className="font-black uppercase tracking-widest text-[10px] animate-pulse">
                                                    YA DEVUELTA COMPLETAMENTE
                                                </Chip>
                                            )}
                                        </div>
                                    )}
                                </div>
                                <div className="flex items-center gap-6">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest">Devueltos:</span>
                                        <span className="text-sm font-bold text-gray-900 dark:text-white tabular-nums">{returningItems.reduce((acc, i) => acc + (i.returnQty || 0), 0)}</span>
                                    </div>
                                    <div className="w-px h-4 bg-gray-200 dark:bg-white/10" />
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest">Cambios:</span>
                                        <span className="text-sm font-bold text-gray-900 dark:text-white tabular-nums">{exchangeItems.reduce((acc, i) => acc + (i.cartQuantity || 0), 0)}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="text-right flex flex-col justify-center">
                                <div className={`text-[10px] font-black uppercase tracking-widest mb-1 flex items-center justify-end gap-2 ${balance >= 0 ? 'text-emerald-600 dark:text-emerald-500' : 'text-rose-500'}`}>
                                    <div className={`h-2 w-2 rounded-full animate-pulse ${balance >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                                    {balance >= 0 ? "Saldo a favor cliente" : "Diferencia a cobrar"}
                                </div>
                                <div className={`text-3xl md:text-4xl font-black tabular-nums tracking-tighter ${balance >= 0 ? 'text-gray-900 dark:text-white' : 'text-rose-500 animate-pulse'}`}>
                                    {balance >= 0 ? `$${balance.toLocaleString()}` : `-$${Math.abs(balance).toLocaleString()}`}
                                </div>
                            </div>
                        </div>

                        <Button
                            className={`h-16 md:h-20 px-8 md:px-12 text-lg font-black rounded-[2rem] shadow-xl w-full md:w-auto transition-all ${balance >= 0
                                    ? "bg-emerald-500 text-white hover:bg-emerald-600 hover:shadow-emerald-500/30"
                                    : "bg-gray-900 dark:bg-white text-white dark:text-black hover:scale-105"
                                }`}
                            onPress={() => setReturnDialogOpen(true)}
                            isDisabled={(returningItems.length === 0 && exchangeItems.length === 0) || (sale?.details.every((d: any) => (d.quantity - (d.returnedQty || 0)) <= 0))}
                            startContent={<CheckCircle2 className="h-6 w-6" />}
                        >
                            <span className="uppercase tracking-widest">{balance >= 0 ? 'FINALIZAR DEVOLUCIÓN' : 'COBRAR SALDO'}</span>
                        </Button>
                    </div>
                </div>
            )}

            {/* MODAL: CONFIRMAR DEVOLUCIÓN */}
            <Modal isOpen={returnDialogOpen} onOpenChange={setReturnDialogOpen} backdrop="blur" classNames={{ base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-[2.5rem] shadow-2xl", header: "border-b border-gray-100 dark:border-white/5 p-8", body: "p-8", footer: "border-t border-gray-100 dark:border-white/5 p-8" }}>
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex flex-col gap-2">
                                <div className="h-12 w-12 rounded-2xl bg-emerald-100 dark:bg-emerald-500/10 flex items-center justify-center border border-emerald-200 dark:border-emerald-500/20 mb-2">
                                    <RotateCcw className="h-6 w-6 text-emerald-600 dark:text-emerald-500" />
                                </div>
                                <h2 className="text-2xl font-black text-gray-900 dark:text-white uppercase tracking-tight">Confirmar Devolución</h2>
                                <p className="text-[10px] text-gray-500 dark:text-zinc-400 font-bold uppercase tracking-widest leading-relaxed">
                                    Verifique la modalidad y justificación contable.
                                </p>

                                <div className="mt-4 p-4 rounded-xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 flex gap-3 items-start">
                                    <AlertCircle className="h-5 w-5 text-rose-500 shrink-0 mt-0.5" />
                                    <div className="space-y-1">
                                        <p className="text-[10px] font-black text-rose-600 dark:text-rose-500 uppercase tracking-widest">AVISO SANITARIO</p>
                                        <p className="text-[10px] font-bold text-rose-600/80 dark:text-rose-200/80 leading-tight">
                                            Productos cárnicos o lácteos NO tienen cambio por normativas de salubridad.
                                        </p>
                                    </div>
                                </div>
                            </ModalHeader>
                            <ModalBody className="flex flex-col gap-5">
                                {isTransfer && (
                                    <div className={`p-4 rounded-xl flex items-start gap-3 border ${balance > 0 ? 'bg-gray-50 dark:bg-zinc-900 border-gray-200 dark:border-white/5' : 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20'}`}>
                                        <AlertCircle className={`h-5 w-5 shrink-0 mt-0.5 ${balance > 0 ? 'text-gray-500 dark:text-zinc-500' : 'text-amber-500'}`} />
                                        <div className="space-y-1">
                                            <p className={`text-xs font-black uppercase ${balance > 0 ? 'text-gray-900 dark:text-white' : 'text-amber-600 dark:text-amber-500'}`}>
                                                Venta por Transferencia
                                            </p>
                                            <p className={`text-[10px] font-bold leading-relaxed ${balance > 0 ? 'text-gray-500 dark:text-zinc-400' : 'text-amber-700 dark:text-amber-200/80'}`}>
                                                {balance > 0
                                                    ? `No se permite reintegro en efectivo. Cliente debe llevar productos por $${balance.toLocaleString()}.`
                                                    : "Sin devoluciones parciales por transferencia."}
                                            </p>
                                        </div>
                                    </div>
                                )}

                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest pl-1">Modalidad de Reintegro</label>
                                    <Select
                                        selectedKeys={new Set([returnType])}
                                        onSelectionChange={(keys) => setReturnType(Array.from(keys)[0] as string)}
                                        isDisabled={balance > 0 && isTransfer}
                                        variant="faded"
                                        classNames={{ trigger: "h-14 bg-gray-50 dark:bg-zinc-900 border-gray-200 dark:border-white/10" }}
                                    >
                                        {(!(balance > 0 && isTransfer)) ? (
                                            <SelectItem key="REFUND" textValue="Reembolso Efectivo" className="font-bold uppercase text-xs">
                                                💵 Reembolso Efectivo
                                            </SelectItem>
                                        ) : <SelectItem key="HIDDEN" className="hidden">Oculto</SelectItem>}
                                        <SelectItem key="EXCHANGE" textValue="Cambio de Artículo" className="font-bold uppercase text-xs">
                                            🔄 Cambio de Artículo
                                        </SelectItem>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest pl-1">Motivo</label>
                                    <Input
                                        value={returnReason}
                                        onValueChange={setReturnReason}
                                        placeholder="Ej. Defecto de fábrica..."
                                        variant="faded"
                                        classNames={{ inputWrapper: "h-14 bg-gray-50 dark:bg-zinc-900 border-gray-200 dark:border-white/10 text-sm font-bold" }}
                                    />
                                </div>

                                {balance < 0 && (
                                    <div className="p-5 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 rounded-2xl text-center">
                                        <div className="text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase tracking-widest mb-1">Excedente a Cobrar</div>
                                        <div className="text-3xl font-black text-gray-900 dark:text-white tracking-tighter tabular-nums">${Math.abs(balance).toLocaleString()}</div>
                                    </div>
                                )}
                            </ModalBody>
                            <ModalFooter>
                                <Button variant="light" color="danger" onPress={onClose} className="font-bold uppercase text-[10px] tracking-widest h-12 px-8">
                                    Cancelar
                                </Button>
                                <Button
                                    onPress={processReturn}
                                    isDisabled={balance > 0 && isTransfer}
                                    className={`h-12 px-8 font-black uppercase text-[10px] tracking-widest rounded-2xl shadow-xl transition-all ${balance > 0 && isTransfer
                                            ? "bg-gray-200 text-gray-400 dark:bg-zinc-800 dark:text-zinc-500"
                                            : "bg-emerald-500 text-white hover:bg-emerald-600"
                                        }`}
                                >
                                    {balance > 0 && isTransfer ? 'Falta Saldo' : (balance >= 0 ? 'Procesar Retorno' : 'Cobrar y Finalizar')}
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

            {/* MODAL: RESULTADOS BÚSQUEDA */}
            <Modal isOpen={isResultsDialogOpen} onOpenChange={setIsResultsDialogOpen} backdrop="blur" size="4xl" classNames={{ base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-[2.5rem] shadow-2xl", header: "border-b border-gray-100 dark:border-white/5 p-8", body: "p-8", footer: "border-t border-gray-100 dark:border-white/5 p-8" }}>
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex flex-col gap-1">
                                <h2 className="text-2xl font-black text-gray-900 dark:text-white uppercase tracking-tight flex items-center gap-3">
                                    <History className="h-6 w-6 text-emerald-600 dark:text-emerald-500" /> Resultados
                                </h2>
                                <p className="text-gray-500 dark:text-zinc-500 font-bold uppercase tracking-widest text-[10px] mt-1">
                                    Selecciona la venta para iniciar el proceso
                                </p>
                            </ModalHeader>
                            <ModalBody>
                                <div className="rounded-[2rem] border border-gray-200 dark:border-white/5 overflow-hidden shadow-sm">
                                    <Table aria-label="Resultados búsqueda" removeWrapper isCompact classNames={{ th: "bg-gray-100 dark:bg-zinc-900 text-gray-500 dark:text-zinc-400 font-black uppercase text-[10px] tracking-widest h-12", td: "py-4 border-b border-gray-100 dark:border-white/5 bg-white dark:bg-transparent", tr: "hover:bg-gray-50 dark:hover:bg-white/[0.02] cursor-pointer transition-colors group" }}>
                                        <TableHeader>
                                            <TableColumn>ID</TableColumn>
                                            <TableColumn>CLIENTE</TableColumn>
                                            <TableColumn align="end">TOTAL</TableColumn>
                                            <TableColumn align="center">ACCIÓN</TableColumn>
                                        </TableHeader>
                                        <TableBody>
                                            {searchResults.map((s) => (
                                                <TableRow key={s.id} onClick={() => loadSale(s)}>
                                                    <TableCell className="font-black text-sm text-gray-400 dark:text-zinc-500 group-hover:text-emerald-500 transition-colors">#{s.id}</TableCell>
                                                    <TableCell>
                                                        <div className="font-bold text-sm text-gray-900 dark:text-white uppercase">{s.client?.name || 'Consumidor Final'}</div>
                                                        <div className="text-[10px] text-gray-400 dark:text-zinc-500 font-bold uppercase tracking-widest mt-1">
                                                            {new Date(s.date).toLocaleDateString()} · {new Date(s.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="font-black text-base text-gray-900 dark:text-white tabular-nums">${s.total.toLocaleString()}</TableCell>
                                                    <TableCell>
                                                        <Button size="sm" variant="flat" className="font-bold text-[9px] uppercase tracking-widest bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 group-hover:bg-gray-900 group-hover:text-white dark:group-hover:bg-white dark:group-hover:text-black transition-all" onPress={() => loadSale(s)}>
                                                            Gestionar
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>

                                {searchResultsTotal > 10 && (
                                    <div className="flex justify-between items-center mt-6">
                                        <span className="text-[10px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest hidden sm:block">
                                            Total: {searchResultsTotal}
                                        </span>
                                        <Pagination
                                            isCompact
                                            showControls
                                            color="success"
                                            page={searchResultsPage}
                                            total={Math.max(1, Math.ceil(searchResultsTotal / 10))}
                                            onChange={(page) => handleSearch(true, page)}
                                            classNames={{
                                                wrapper: "gap-2",
                                                item: "w-10 h-10 min-w-10 rounded-xl font-black text-xs bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5",
                                                cursor: "bg-emerald-600 dark:bg-emerald-500 text-white shadow-lg shadow-emerald-500/30",
                                                next: "bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-white/5",
                                                prev: "bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-white/5"
                                            }}
                                        />
                                    </div>
                                )}
                            </ModalBody>
                            <ModalFooter>
                                <Button variant="light" onPress={onClose} className="font-bold uppercase text-[10px] tracking-widest text-gray-500 dark:text-zinc-400 h-12 px-8">
                                    Cerrar
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

            {/* SCANNER OVERLAY (Este se mantiene oscuro por diseño de UI de cámaras) */}
            {isScannerOpen && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md">
                    <div className="relative w-full max-w-2xl aspect-video bg-zinc-950 rounded-[2.5rem] overflow-hidden border border-white/10 shadow-2xl">
                        <div className="absolute top-0 left-0 right-0 p-6 flex justify-between items-center z-10 pointer-events-none">
                            <h2 className="text-white font-black uppercase tracking-widest text-sm flex items-center gap-2">
                                <Camera className="h-5 w-5 text-emerald-500" /> Escáner Activo
                            </h2>
                        </div>
                        <ScannerOverlay
                            isOpen={isScannerOpen}
                            onClose={() => setIsScannerOpen(false)}
                            title=""
                            onResult={(barcode) => {
                                const p = allProducts.find(x => x.barcode === barcode);
                                if (p) {
                                    addProductToReturn(p);
                                    setIsScannerOpen(false);
                                } else {
                                    toast({ variant: 'destructive', title: 'No encontrado', description: 'El producto escaneado no existe.' });
                                }
                            }}
                        />
                        <Button
                            isIconOnly
                            variant="flat"
                            className="absolute top-6 right-6 h-10 w-10 rounded-xl bg-black/50 hover:bg-rose-500 text-white border border-white/10 backdrop-blur-md transition-all z-20"
                            onPress={() => setIsScannerOpen(false)}
                        >
                            X
                        </Button>
                    </div>
                </div>
            )}

            {/* INPUT INVISIBLE DEL LECTOR */}
            <input
                ref={hiddenScannerRef}
                type="text"
                className="scanner-gate absolute opacity-0 pointer-events-none -z-50 h-0 w-0 overflow-hidden"
                value={barcodeInput}
                autoComplete="off"
                onChange={(e) => setBarcodeInput(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        handleCodeSubmit(barcodeInput);
                        setBarcodeInput('');
                        setTimeout(() => hiddenScannerRef.current?.focus(), 10);
                    }
                }}
            />
        </div>
    );
}