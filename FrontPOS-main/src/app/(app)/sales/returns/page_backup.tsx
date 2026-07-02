"use client";

import { useState, useEffect, useRef } from 'react';
import { mutate } from 'swr';
import Cookies from 'js-cookie';
import { broadcastRevalidate } from '@/lib/revalidate';
import { Search, RotateCcw, CheckCircle2, AlertCircle, ShoppingCart, Camera, History, FileText } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { extractApiError } from '@/lib/api-error';
import { Sale, Product, SaleDetail } from '@/lib/definitions';
import { ScannerOverlay } from '@/components/ScannerOverlay';
import { getPaymentDescription, getPaymentColor } from '@/lib/payment-helpers';

// Importaciones de HeroUI
import {
    Button, Input, Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Select, SelectItem, Pagination, Chip, Card, CardHeader, CardBody, CardFooter, Spinner, Avatar
} from "@heroui/react";

import { Banknote, RefreshCw, Truck, Check, ChevronDown, ChevronRight } from 'lucide-react';
import UniversalPaymentModal from '@/components/shared/UniversalPaymentModal';
import ReturnsKPIs from './components/ReturnsKPIs';

import { Suspense } from 'react';
import { isProductWeighted, formatShortDateTime, formatDateTime } from "@/lib/utils";

function ReturnsContent() {
    const [searchId, setSearchId] = useState('');
    const [searchDate, setSearchDate] = useState('');
    const [searchResults, setSearchResults] = useState<Sale[]>([]);
    const [searchResultsPage, setSearchResultsPage] = useState(1);
    const [searchResultsTotal, setSearchResultsTotal] = useState(0);
    const [recentSales, setRecentSales] = useState<Sale[]>([]);
    const [recentReturns, setRecentReturns] = useState<any[]>([]);
    const [isHistoryLoading, setIsHistoryLoading] = useState(false);
    const [isResultsDialogOpen, setIsResultsDialogOpen] = useState(false);
    const [sale, setSale] = useState<Sale | null>(null);
    const [loading, setLoading] = useState(false);
    const [returningItems, setReturningItems] = useState<any[]>([]);
    const [exchangeItems, setExchangeItems] = useState<any[]>([]);
    const [productSearch, setProductSearch] = useState('');
    const [products, setProducts] = useState<Product[]>([]);
    const [allProducts, setAllProducts] = useState<Product[]>([]);
    const [returnReason, setReturnReason] = useState('');
    const [returnType, setReturnType] = useState('REFUND'); // 'REFUND' or 'EXCHANGE'
    const [productSoldStats, setProductSoldStats] = useState<{ cash: number, transfer: number, lastSaleId?: number }>({ cash: 0, transfer: 0 });
    const [selectedProductMain, setSelectedProductMain] = useState<Product | null>(null);
    const [returnDialogOpen, setReturnDialogOpen] = useState(false);
    const [exchangeSearch, setExchangeSearch] = useState('');
    const [exchangeProducts, setExchangeProducts] = useState<Product[]>([]);

    // Estados para el Motor Universal de Pagos
    const [submittingPayment, setSubmittingPayment] = useState(false);
    const [showSuccessScreen, setShowSuccessScreen] = useState(false);
    const [lastChange, setLastChange] = useState(0);

    const searchRef = useRef<HTMLInputElement>(null);
    const directSearchRef = useRef<HTMLInputElement>(null);
    const hiddenScannerRef = useRef<HTMLInputElement>(null);
    const [isScannerOpen, setIsScannerOpen] = useState(false);
    const [barcodeInput, setBarcodeInput] = useState('');
    const [mounted, setMounted] = useState(false);
    const { toast } = useToast();


    const paymentLabel = sale ? getPaymentDescription(sale) : 'EFECTIVO';
    const paymentColor = sale ? getPaymentColor(sale) : 'default';

    // --- TRADUCCIONES DE ESTADOS ---
    const getReturnTypeLabel = (type: string) => {
        if (type === 'REFUND') return 'EFECTIVO / REEMBOLSO';
        if (type === 'EXCHANGE') return 'CAMBIO POR PRODUCTO';
        return type;
    };

    // --- LOGICA DE NEGOCIO (Intacta) ---
    const fetchRecentSales = async () => {
        const token = Cookies.get('org-pos-token');
        try {
            const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/sales/history?pageSize=20`, {
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

    const fetchRecentReturns = async () => {
        const token = Cookies.get('org-pos-token');
        if (!token) return;
        setIsHistoryLoading(true);
        try {
            // Correct backend route is /returns/all for both list and history
            const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/returns/all`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                const items = Array.isArray(data) ? data : (data.items || []);
                // Frontend sorting: newest first
                setRecentReturns([...items].sort((a: any, b: any) => b.id - a.id));
            }
        } catch (error) {
            console.error("Error fetching returns:", error);
        } finally {
            setIsHistoryLoading(false);
        }
    };

    const fetchAllProducts = async () => {
        const token = Cookies.get('org-pos-token');
        try {
            const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/products/all-products`, {
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
        setMounted(true);
        searchRef.current?.focus();
        fetchRecentSales();
        fetchRecentReturns();
        fetchAllProducts();
    }, []);

    const handleSearch = async (isDateSearch = false, page = 1) => {
        if (!searchId && !isDateSearch) return;
        if (isDateSearch && !searchDate) return;

        setLoading(true);
        const token = Cookies.get('org-pos-token');
        try {
            if (isDateSearch) {
                const pageSize = 10;
                const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/sales/history?from=${searchDate}T00:00:00&to=${searchDate}T23:59:59&page=${page}&pageSize=${pageSize}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (!res.ok) throw new Error('Error al buscar ventas por fecha');
                const data = await res.json();

                if (!data.items || data.items.length === 0) {
                    toast({ variant: 'destructive', title: 'SISTEMA', description: 'SIN RESULTADOS' });
                } else if (data.items.length === 1 && page === 1 && data.total === 1) {
                    loadSale(data.items[0]);
                } else {
                    setSearchResults(data.items);
                    setSearchResultsTotal(data.total || 0);
                    setSearchResultsPage(page);
                    setIsResultsDialogOpen(true);
                }
            } else {
                let res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/sales/history/${searchId}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (res.ok) {
                    const data = await res.json();
                    loadSale(data);
                } else {
                    const p = allProducts.find(x =>
                        x.barcode === searchId ||
                        x.productName.toLowerCase().includes(searchId.toLowerCase())
                    );
                    if (p) {
                        toast({ variant: 'success', title: 'SISTEMA', description: 'PRODUCTO DETECTADO' });
                        // Backend sales/history doesn't support barcode filter, so we fetch latest and filter locally
                        const resByProd = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/sales/history?pageSize=50`, {
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        if (resByProd.ok) {
                            const data = await resByProd.json();
                            const allSales = data.items || [];
                            // Filter sales that contain this product
                            const filteredSales = allSales.filter((s: Sale) =>
                                s.details.some(d => d.barcode === p.barcode)
                            );

                            if (filteredSales.length > 0) {
                                setSearchResults(filteredSales);
                                setSearchResultsTotal(filteredSales.length);
                                setSearchResultsPage(1);
                                setIsResultsDialogOpen(true);
                                return;
                            }
                        }
                    }
                    throw new Error('No se encontro venta ni producto recientemente vendido');
                }
            }
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'FALLO', description: err.message });
            setSale(null);
        } finally {
            setLoading(false);
        }
    };

    const loadSale = (saleData: Sale) => {
        const fullyReturned = saleData.details.every((d: SaleDetail) => (d.quantity - (d.returnedQty || 0)) <= 0);
        if (fullyReturned) {
            toast({ variant: 'destructive', title: 'AVISO', description: 'FACTURA YA DEVUELTA' });
        }
        setSale(saleData);
        setReturningItems(saleData.details.map((d: any) => ({
            ...d,
            returnQty: 0,
            productName: d.product?.productName || 'Producto'
        })));
        setSearchId(saleData.id.toString());
        setIsResultsDialogOpen(false);
        // Al cargar una venta, asumimos que estamos en un retorno especifico de esa factura
        // Pero el usuario quiere que sea "general". Si cargamos una venta, nos limitamos solo a esa por seguridad,
        // pero limpiaremos la seleccion global para evitar confusiones.
        setSelectedProductMain(null);
    };

    const fetchSoldStats = async (product: Product): Promise<{ cash: number, transfer: number, lastSaleId?: number }> => {
        const token = Cookies.get('org-pos-token');
        try {
            // We fetch last 100 sales and filter locally because backend doesn't support barcode query
            const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/sales/history?pageSize=100`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                const allSales = data.items || [];

                // Filter sales that contain the product barcode
                const productSales = allSales.filter((s: Sale) =>
                    s.details.some(d => d.barcode === product.barcode)
                );

                let cash = 0;
                let transfer = 0;
                let lastSaleId = 0;

                if (productSales.length > 0) {
                    // Get latest sale ID for association
                    lastSaleId = productSales[0].id;
                }

                productSales.forEach((s: Sale) => {
                    const detail = s.details.find(d => d.barcode === product.barcode);
                    if (detail) {
                        const available = detail.quantity - (detail.returnedQty || 0);
                        if (available > 0) {
                            const isCash = s.paymentMethod?.toUpperCase().includes('EFECTIVO') || s.cashAmount > 0;
                            const isTransfer = s.paymentMethod?.toUpperCase().includes('TRANSFERENCIA') || s.transferAmount > 0;

                            if (isCash && !isTransfer) cash += available;
                            else if (isTransfer && !isCash) transfer += available;
                            else if (isCash && isTransfer) cash += available;
                        }
                    }
                });

                setProductSoldStats({ cash, transfer, lastSaleId });
                return { cash, transfer, lastSaleId };
            }
        } catch (error) {
            console.error("Error fetching sold stats", error);
        }
        return { cash: 0, transfer: 0 };
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
                        // El limite para retorno manual es el total de unidades vendidas historicamente detectadas
                        max = item.totalAvailable || (item.cashAvailable || 0) + (productSoldStats?.transfer || 0);
                    } else {
                        const alreadyReturned = item.returnedQty || 0;
                        max = (item.quantity || 0) - alreadyReturned;
                    }
                }

                const finalQty = Math.min(Math.max(0, qty), max);

                if (!isExchange && qty > max && max >= 0) {
                    toast({ variant: 'destructive', title: 'ERROR', description: 'LIMITE EXCEDIDO' });
                }

                return { ...item, returnQty: finalQty, cartQuantity: finalQty };
            }
            return item;
        }).filter(item => (item.returnQty > 0 || item.cartQuantity > 0 || !item.isManual)));
    };

    const addProductToReturn = async (p: any, isExchange = false) => {
        let cashAvailableForThisProduct = 999999;
        let totalAvailableForThisProduct = 999999;

        if (!isExchange && !sale) {
            setLoading(true);
            const stats = await fetchSoldStats(p);
            setLoading(false);
            cashAvailableForThisProduct = stats.cash;
            totalAvailableForThisProduct = stats.cash + stats.transfer;
            p.lastSaleId = stats.lastSaleId || 0;
            setSelectedProductMain(p);

            if (totalAvailableForThisProduct <= 0) {
                toast({ variant: 'destructive', title: 'SISTEMA', description: 'SIN VENTAS PREVIAS' });
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
                    max = existing.totalAvailable || totalAvailableForThisProduct;
                }

                const newQty = (existing.returnQty || existing.cartQuantity || 0) + 1;
                if (!isExchange && newQty > max) {
                    toast({ variant: 'destructive', title: 'ERROR', description: 'LIMITE ALCANZADO' });
                    return prev;
                }
                return prev.map(i => i.barcode === p.barcode ?
                    { ...i, returnQty: isExchange ? 0 : newQty, cartQuantity: isExchange ? newQty : 0 } : i
                );
            }

            return [...prev, {
                ...p,
                barcode: p.barcode,
                productName: p.productName,
                unitPrice: p.salePrice || 0,
                returnQty: isExchange ? 0 : 1,
                cartQuantity: isExchange ? 1 : 0,
                isManual: !sale,
                cashAvailable: cashAvailableForThisProduct,
                totalAvailable: totalAvailableForThisProduct
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

    // Calculo del pool de efectivo disponible para reembolso
    const cashRefundablePool = returningItems.reduce((acc, item) => {
        if (sale) {
            // En una venta especifica, el limite es el monto pagado en efectivo en esa venta
            const saleCashAmount = Number(sale.cashAmount) || 0;
            const saleTotal = Number(sale.total) || 1;
            // Proporcionalmente o simplemente el total de efectivo de la factura
            return saleCashAmount;
        } else {
            // En modo global, sumamos el valor de las unidades que fueron historicamente en efectivo
            return acc + (item.unitPrice * Math.min(item.returnQty || 0, item.cashAvailable || 0));
        }
    }, 0);

    const isTransfer = sale?.paymentMethod?.toUpperCase().includes('TRANSFER') ||
        sale?.paymentMethod?.toUpperCase().includes('MIXTO') ||
        (balance > cashRefundablePool && !sale);

    useEffect(() => {
        if (returnDialogOpen && isTransfer && balance > cashRefundablePool) {
            setReturnType('EXCHANGE');
        }
    }, [returnDialogOpen, isTransfer, balance, cashRefundablePool]);

    const handleFinalPayment = async (paymentData: {
        cash: number;
        transfer: number;
        transferSource: string;
        credit: number;
        totalPaid: number;
        change: number;
    }) => {
        if (returningItems.every(i => i.returnQty === 0)) {
            toast({ variant: 'destructive', title: 'SISTEMA', description: 'SELECCIONA ARTICULOS' });
            return;
        }

        setSubmittingPayment(true);
        const token = Cookies.get('org-pos-token');

        try {
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
                        throw new Error(`La cantidad de ${i.productName} excede el limite permitido (${max}).`);
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

            const effectiveSaleId = Number(sale?.id) || returningItems.find(i => (i.lastSaleId || 0) > 0)?.lastSaleId || 0;
            const returnData = {
                saleId: effectiveSaleId,
                totalReturned: totalReturned,
                reason: returnReason,
                returnType: returnType,
                details: allDetails,
                // Inyectamos la informacion del motor de pagos
                cashAmount: paymentData.cash,
                transferAmount: paymentData.transfer,
                transferSource: paymentData.transferSource,
                creditAmount: paymentData.credit,
                change: paymentData.change
            };

            const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/returns/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(returnData)
            });

            if (!res.ok) {
                const errorData = await res.json().catch(() => ({}));
                throw new Error(errorData.error || 'Error al procesar la devolucion');
            }

            setLastChange(paymentData.change);
            setReturnDialogOpen(false);
            setShowSuccessScreen(false);
            toast({ variant: 'success', description: '✅ Devolucion procesada: Inventario y caja actualizados' });

            // Auto-reset y revalidacion inmediata
            fetchRecentSales();
            fetchRecentReturns();
            setSale(null);
            setSearchId('');
            setReturningItems([]);
            setExchangeItems([]);
            setReturnReason('');
            
            // Emitir señales de sincronizacion y revalidacion inmediata
            broadcastRevalidate('PRODUCT_UPDATE');
            broadcastRevalidate('STOCK_UPDATE');

            // SWR asynchronous revalidation
            mutate('/returns/all');
            mutate('/api/returns/all');
            mutate('/products/all-products');
            mutate('/inventory/stock');
        } catch (err: any) {
            toast({ variant: 'destructive', title: 'FALLO', description: err.message });
        } finally {
            setSubmittingPayment(false);
        }
    };

    const handleClosePaymentModal = () => {
        if (showSuccessScreen) {
            setReturnDialogOpen(false);
            setSale(null);
            setSearchId('');
            setReturningItems([]);
            setExchangeItems([]);
            setReturnReason('');
            setShowSuccessScreen(false);
            fetchRecentSales();
            fetchRecentReturns();
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
        const checkSearch = async () => {
            if (productSearch.length >= 8 && /^\d+$/.test(productSearch)) {
                const p = allProducts.find(x => x.barcode === productSearch);
                if (p) {
                    await addProductToReturn(p);
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
        };
        checkSearch();
    }, [productSearch, allProducts]);

    useEffect(() => {
        const checkExchangeSearch = async () => {
            if (exchangeSearch.length >= 8 && /^\d+$/.test(exchangeSearch)) {
                const p = allProducts.find(x => x.barcode === exchangeSearch);
                if (p) {
                    await addProductToReturn(p, true);
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
        };
        checkExchangeSearch();
    }, [exchangeSearch, allProducts]);

    const handleCodeSubmit = async (code: string) => {
        if (!code) return;
        const p = allProducts.find(x => x.barcode === code);
        if (p) await addProductToReturn(p);
        else toast({ variant: 'destructive', title: 'Error', description: 'Producto no encontrado' });
    };

    if (!mounted) return (
        <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-zinc-950">
            <Spinner color="success" size="lg" />
        </div>
    );

    return (
        <div className="flex flex-col h-screen gap-1 p-1 bg-gray-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50 overflow-hidden select-none transition-all duration-500">
            {/* HEADER SECTION: FIXED (TOP) */}
            <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 border-b border-gray-200 dark:border-white/5 card-base border-none dark:bg-zinc-950/80 relative z-[150]">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="bg-rose-600 h-10 w-10 rounded-2xl text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20 flex items-center justify-center transform -rotate-3">
                            <RotateCcw size={20} />
                        </div>
                        <div className="flex flex-col">
                            <h1 className="text-[13px] font-medium text-zinc-900 dark:text-white tracking-tighter uppercase tracking-tight leading-none">
                                Gestion de <span className="text-rose-500">Devoluciones</span>
                            </h1>
                            <p className="text-[8px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-[0.4em] tracking-tight mt-1 flex items-center gap-1">
                                <History size={10} className="text-rose-500" /> Auditoria de Reintegros
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <Button
                            isIconOnly
                            variant="flat"
                            className={`h-10 w-10 min-w-0 rounded-2xl border transition-all ${isScannerOpen ? "bg-rose-500/20 text-rose-500 border-rose-500/50" : "bg-gray-100 dark:bg-[#18181b]/50 text-gray-500 dark:text-zinc-500 dark:text-zinc-400 border-gray-200 dark:border-white/5"}`}
                            onPress={() => setIsScannerOpen(!isScannerOpen)}
                        >
                            <Camera size={16} />
                        </Button>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <div className="relative group/search">
                        <Input
                            placeholder="ESCRIBIR ID DE FACTURA..."
                            aria-label="Buscar factura por ID"
                            value={searchId}
                            onValueChange={setSearchId}
                            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                            classNames={{
                                inputWrapper: "h-12 bg-gray-50 dark:bg-[#18181b] border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl group-focus-within/search:border-rose-500/50 group-focus-within/search:ring-2 group-focus-within/search:ring-rose-500/20 transition-all",
                                input: "font-medium text-xs uppercase text-zinc-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 tracking-widest tracking-tight"
                            }}
                            startContent={<FileText size={18} className="text-gray-500 dark:text-zinc-500 dark:text-zinc-400 group-focus-within/search:text-rose-500" />}
                        />
                    </div>
                    <div className="relative group/date">
                        <Input
                            type="date"
                            placeholder="FECHA..."
                            aria-label="Filtrar por fecha"
                            value={searchDate}
                            onValueChange={(val) => {
                                setSearchDate(val);
                                if (val) handleSearch(true);
                            }}
                            classNames={{
                                inputWrapper: "h-12 bg-gray-50 dark:bg-[#18181b] border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl group-focus-within/date:border-rose-500/50 group-focus-within/date:ring-2 group-focus-within/date:ring-rose-500/20 transition-all",
                                input: "font-medium text-xs uppercase text-zinc-900 dark:text-white tracking-widest tracking-tight"
                            }}
                        />
                    </div>
                    <div className="relative group/prod z-[200]">
                        <Input
                            placeholder="PRODUCTO O BARCODE..."
                            aria-label="Buscar producto o codigo de barras"
                            value={productSearch}
                            onValueChange={setProductSearch}
                            classNames={{
                                inputWrapper: "h-12 bg-gray-50 dark:bg-[#18181b] border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl group-focus-within/prod:border-rose-500/50 group-focus-within/prod:ring-2 group-focus-within/prod:ring-rose-500/20 transition-all",
                                input: "font-medium text-xs uppercase text-zinc-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 tracking-widest tracking-tight"
                            }}
                            startContent={<Search size={18} className="text-gray-500 dark:text-zinc-500 dark:text-zinc-400 group-focus-within/prod:text-rose-500" />}
                        />
                        {productSearch.length > 0 && products.length > 0 && (
                            <div className="absolute z-[300] left-0 right-0 top-14 card-base border-none border border-gray-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden">
                                {products.slice(0, 5).map(p => (
                                    <button
                                        key={p.barcode}
                                        className="w-full p-3 flex justify-between hover:bg-rose-500/10 transition-colors text-left border-b border-gray-100 dark:border-white/5 last:border-0 group"
                                        onClick={() => addProductToReturn(p)}
                                    >
                                        <div className="flex flex-col">
                                            <span className="font-bold text-xs text-zinc-900 dark:text-zinc-50 uppercase group-hover:text-rose-500 transition-colors">{p.productName}</span>
                                            <span className="text-[9px] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 font-mono">{p.barcode}</span>
                                        </div>
                                        <span className="font-medium text-rose-500 text-xs tabular-nums">${p.salePrice.toLocaleString()}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* CONTENT SECTION (SCROLLABLE) */}
            <div className="flex-1 overflow-y-auto custom-scrollbar pb-4 px-1">
                <div className="px-2 pt-3 pb-3 shrink-0">
                    <ReturnsKPIs
                        totalReturns={recentReturns.length}
                        totalRefunded={`$${recentReturns.reduce((acc, curr) => acc + (curr.totalReturned || 0), 0).toLocaleString()}`}
                        itemsReturned={recentReturns.reduce((acc, curr) => acc + (curr.details || []).reduce((sum: number, d: any) => sum + (d.quantity || 0), 0), 0)}
                    />
                </div>
                {/* Banner de Contexto de Venta Activa */}
                {sale && (
                    <div className="flex items-center gap-4 p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl animate-in fade-in zoom-in-95 duration-300">
                        <div className="h-12 w-12 rounded-2xl bg-rose-500 flex items-center justify-center text-white shrink-0 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20">
                            <CheckCircle2 size={24} />
                        </div>
                        <div className="flex-1 flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div>
                                <div className="flex items-center gap-3 mb-2">
                                    <span className="text-[10px] font-medium text-rose-600 dark:text-rose-500 uppercase tracking-[0.2em]">FACTURA ACTIVA</span>
                                    <Chip size="sm" variant="shadow" color={paymentColor as any} className="h-5 text-[8px] font-medium uppercase tracking-widest px-2">
                                        PAGADO EN: {paymentLabel}
                                    </Chip>
                                </div>
                                <h2 className="text-xl font-medium text-zinc-900 dark:text-zinc-50 uppercase leading-tight">
                                    #{sale.id} Â· {sale.client?.name || 'CONSUMIDOR FINAL'}
                                </h2>
                            </div>
                            <div className="flex items-center gap-8">
                                <div className="text-right">
                                    <p className="text-[8px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest mb-1">TOTAL VENTA</p>
                                    <p className="text-lg font-medium text-zinc-900 dark:text-zinc-50 tabular-nums leading-none tracking-tighter">${sale.total.toLocaleString()}</p>
                                </div>
                                <Button isIconOnly size="sm" variant="flat" color="danger" className="h-8 w-8 rounded-2xl" onPress={() => setSale(null)}>X</Button>
                            </div>
                        </div>
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 p-1">
                    {/* COLUMNA IZQUIERDA: LO QUE EL CLIENTE TRAE */}
                    <div className="space-y-2">
                        <Card className="rounded-2xl card-base border-none shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-black/5 overflow-hidden min-h-[450px]">
                            <CardHeader className="px-4 py-3 flex flex-col gap-1 items-start bg-gray-50/30 dark:bg-zinc-800/20 border-b border-gray-100 dark:border-white/5">
                                <h3 className="text-zinc-900 dark:text-zinc-100 text-[12px] font-medium uppercase tracking-[0.2em] flex items-center gap-2">
                                    <RotateCcw size={16} /> REINGRESANDO
                                </h3>
                                <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest leading-none">Articulos para stock</p>
                            </CardHeader>
                            <CardBody className="p-0">
                                {returningItems.length > 0 ? (
                                    <Table aria-label="Devoluciones" isHeaderSticky isCompact removeWrapper classNames={{
                                        th: "bg-white dark:bg-zinc-950/80  text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-wider text-xs h-10 py-0.5 px-3 border-b border-zinc-200 dark:border-white/5",
                                        td: "px-3 py-0.5",
                                        tr: "border-b border-zinc-200 dark:border-white/5 hover:bg-rose-500/5 border-l-4 border-transparent hover:border-rose-500 transition-colors h-12"
                                    }}>
                                        <TableHeader>
                                            <TableColumn>PRODUCTO</TableColumn>
                                            <TableColumn align="center">CANT</TableColumn>
                                            <TableColumn align="end">SUBTOTAL</TableColumn>
                                        </TableHeader>
                                        <TableBody>
                                            {returningItems.map((item) => (
                                                <TableRow key={item.barcode}>
                                                    <TableCell>
                                                        <div className="font-bold text-zinc-900 dark:text-zinc-50 text-[9px] uppercase leading-tight truncate max-w-[120px]">{item.productName}</div>
                                                        <div className="text-[7px] text-gray-400 dark:text-zinc-600 font-mono font-bold tracking-tight">{item.barcode}</div>
                                                    </TableCell>
                                                    <TableCell>
                                                        <div className="flex items-center justify-center gap-1.5">
                                                            {isProductWeighted(item) || isProductWeighted(item.product) ? (
                                                                <Input
                                                                    type="number"
                                                                    size="sm"
                                                                    step="0.001"
                                                                    aria-label="Cantidad a devolver"
                                                                    value={(item.returnQty || 0).toString()}
                                                                    onValueChange={(val) => handleQtyChange(item.barcode, parseFloat(val) || 0)}
                                                                    className="w-20"
                                                                    classNames={{
                                                                        inputWrapper: "h-6 bg-gray-100 dark:bg-zinc-800 border-none rounded-2xl px-1 min-h-unit-5",
                                                                        input: "text-[10px] font-medium tabular-nums text-center"
                                                                    }}
                                                                />
                                                            ) : (
                                                                <>
                                                                    <Button isIconOnly size="sm" variant="flat" className="h-5 w-5 bg-gray-100 dark:bg-zinc-800 text-gray-500 rounded-2xl min-w-unit-5" onClick={() => handleQtyChange(item.barcode, (item.returnQty || 0) - 1)}>-</Button>
                                                                    <span className="font-medium text-[10px] tabular-nums min-w-[0.8rem] text-center">{item.returnQty}</span>
                                                                    <Button isIconOnly size="sm" variant="flat" className="h-5 w-5 bg-gray-100 dark:bg-zinc-800 text-gray-500 rounded-2xl min-w-unit-5" onClick={() => handleQtyChange(item.barcode, (item.returnQty || 0) + 1)}>+</Button>
                                                                </>
                                                            )}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <div className="font-medium text-zinc-900 dark:text-zinc-50 text-[10px] tabular-nums tracking-tighter tracking-tight">
                                                            ${(item.unitPrice * (item.returnQty || 0)).toLocaleString()}
                                                        </div>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                ) : (
                                    <div className="flex flex-col items-center justify-center py-20 opacity-20 tracking-tight font-medium text-gray-400 uppercase tracking-[0.4em] text-center">
                                        <RotateCcw size={64} className="mb-4" />
                                        <span>Buscando Devolucion</span>
                                    </div>
                                )}
                            </CardBody>
                            {returningItems.length > 0 && (
                                <div className="p-3 bg-gray-50/50 dark:bg-[#18181b]/30 border-t border-gray-100 dark:border-white/5">
                                    <div className="flex justify-between items-end">
                                        <div>
                                            <p className="text-[8px] font-medium text-gray-400 dark:text-zinc-600 uppercase tracking-widest mb-1">TOTAL REINGRESO</p>
                                            <p className="text-xl font-medium text-rose-500 tracking-tighter tracking-tight leading-none tabular-nums">${totalReturned.toLocaleString()}</p>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </Card>
                    </div>

                    {/* COLUMNA DERECHA: LO QUE EL CLIENTE SE LLEVA / REEMBOLSO */}
                    <div className="space-y-2">
                        <Card className={`rounded-2xl card-base border-none border transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-black/5 overflow-hidden min-h-[450px] ${returnType === 'EXCHANGE' ? 'border-blue-500/10' : 'border-rose-500/10'}`}>
                            <CardHeader className="px-4 py-3 flex flex-col gap-1 items-start bg-gray-50/30 dark:bg-zinc-800/20 border-b border-gray-100 dark:border-white/5">
                                <h3 className={`text-[12px] font-medium uppercase tracking-[0.2em] flex items-center gap-2 ${returnType === 'EXCHANGE' ? 'text-blue-500' : 'text-rose-500'}`}>
                                    {returnType === 'EXCHANGE' ? <ShoppingCart size={16} /> : <RotateCcw size={16} className="rotate-180" />}
                                    {returnType === 'EXCHANGE' ? "PRODUCTOS QUE SE LLEVA" : "REEMBOLSO DINERO / SALDO"}
                                </h3>
                                <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest leading-none">
                                    {returnType === 'EXCHANGE' ? "Salida de inventario nuevo" : "Dinero a entregar al cliente"}
                                </p>
                            </CardHeader>
                            <CardBody className="p-2 space-y-2">
                                <div className="space-y-1">
                                    <label className="text-[8px] font-medium text-gray-400 dark:text-zinc-600 uppercase tracking-[0.2em] pl-1 block tracking-tight">Gestion</label>
                                    <Select
                                        size="sm"
                                        aria-label="Tipo de retorno"
                                        selectedKeys={new Set([returnType])}
                                        onSelectionChange={(keys) => setReturnType(Array.from(keys)[0] as string)}
                                        variant="flat"
                                        labelPlacement="outside"
                                        selectorIcon={<ChevronDown size={14} />}
                                        popoverProps={{
                                            classNames: {
                                                content: "card-base border-none border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl p-2",
                                            }
                                        }}
                                        classNames={{
                                            trigger: "h-9 bg-gray-100 dark:bg-zinc-800 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] px-3 min-h-unit-8 pr-10",
                                            value: "text-[10px] font-medium uppercase tracking-tight",
                                            selectorIcon: "absolute right-3 text-gray-500",
                                            popoverContent: "card-base border-none border border-gray-200 dark:border-zinc-800 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl"
                                        }}
                                        renderValue={(items) => {
                                            return items.map((item) => (
                                                <div key={item.key} className="flex items-center gap-2">
                                                    {item.key === 'REFUND' ? <Banknote size={14} className="text-rose-500" /> : <RefreshCw size={14} className="text-blue-500" />}
                                                    <span className="text-[10px] font-medium tracking-tight">{item.textValue}</span>
                                                </div>
                                            ));
                                        }}
                                    >
                                        <SelectItem
                                            key="REFUND"
                                            textValue="Reembolso de Dinero"
                                            className="group p-2 rounded-2xl hover:bg-rose-500/10 transition-colors"
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className="h-8 w-8 rounded-2xl bg-rose-100 dark:bg-rose-500/10 flex items-center justify-center text-rose-600 dark:text-rose-500">
                                                    <Banknote size={16} />
                                                </div>
                                                <div className="flex flex-col">
                                                    <span className="font-medium uppercase text-[10px] dark:text-white tracking-tight">Reembolso</span>
                                                    <span className="text-[8px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 tracking-widest leading-none">PAGO EN EFECTIVO</span>
                                                </div>
                                            </div>
                                        </SelectItem>
                                        <SelectItem
                                            key="EXCHANGE"
                                            textValue="Cambio por Articulo"
                                            className="group p-2 rounded-2xl hover:bg-blue-500/10 transition-colors"
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className="h-8 w-8 rounded-2xl bg-blue-100 dark:bg-blue-500/10 flex items-center justify-center text-blue-600 dark:text-blue-500">
                                                    <RefreshCw size={16} />
                                                </div>
                                                <div className="flex flex-col">
                                                    <span className="font-medium uppercase text-[10px] dark:text-white tracking-tight">Cambio</span>
                                                    <span className="text-[8px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 tracking-widest leading-none">NUEVO PRODUCTO</span>
                                                </div>
                                            </div>
                                        </SelectItem>
                                    </Select>
                                </div>
                                {returnType === 'EXCHANGE' && (
                                    <div className="space-y-2 animate-in slide-in-from-top-2 duration-300">
                                        <div className="relative z-[200]">
                                            <Input
                                                size="sm"
                                                placeholder="BUSCAR ARTICULO..."
                                                aria-label="Buscar articulo para cambio"
                                                label="PRODUCTO PARA CAMBIO"
                                                labelPlacement="outside"
                                                value={exchangeSearch}
                                                onValueChange={setExchangeSearch}
                                                classNames={{
                                                    label: "hidden",
                                                    inputWrapper: "h-7 bg-blue-50/50 dark:bg-blue-900/10 border border-blue-500/10 rounded-2xl font-bold text-[9px] uppercase min-h-unit-6"
                                                }}
                                                startContent={<Search size={14} className="text-blue-500/50" />}
                                            />
                                            {exchangeSearch.length > 2 && exchangeProducts.length > 0 && (
                                                <div className="absolute z-[300] left-0 right-0 top-8 card-base border-none border border-gray-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-1 max-h-48 overflow-y-auto custom-scrollbar">
                                                    {exchangeProducts.map(p => (
                                                        <button key={p.barcode} className="w-full p-2 text-left hover:bg-blue-500/10 rounded-2xl flex justify-between items-center group transition-colors border-b border-gray-100 dark:border-white/5 last:border-none" onClick={() => { addProductToReturn(p, true); setExchangeSearch(''); }}>
                                                            <div className="flex flex-col">
                                                                <span className="font-bold text-[10px] uppercase text-zinc-900 dark:text-zinc-50 leading-tight">{p.productName}</span>
                                                                <span className="text-[8px] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 font-mono font-bold">{p.barcode}</span>
                                                            </div>
                                                            <div className="text-right">
                                                                <span className="font-medium text-blue-500 text-[10px] tabular-nums">${p.salePrice.toLocaleString()}</span>
                                                                <p className="text-[7px] text-gray-400 uppercase font-medium tracking-widest">STK: {p.quantity}</p>
                                                            </div>
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        <div className="rounded-2xl border border-gray-100 dark:border-white/5 overflow-hidden">
                                            <Table isCompact removeWrapper aria-label="Items Cambio" classNames={{ th: "bg-white dark:bg-zinc-950/80  text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-wider text-[8px] h-8 px-4 border-b border-zinc-200 dark:border-white/5", td: "px-4 py-1", tr: "border-b border-zinc-200 dark:border-white/5 hover:bg-blue-500/5 transition-colors" }}>
                                                <TableHeader>
                                                    <TableColumn>PRODUCTO</TableColumn>
                                                    <TableColumn align="center">CANT</TableColumn>
                                                    <TableColumn align="end">SUBTOTAL</TableColumn>
                                                </TableHeader>
                                                <TableBody emptyContent={<div className="text-center py-10 text-[10px] uppercase font-medium text-gray-300 tracking-tight">No hay productos añadidos para el cambio</div>}>
                                                    {exchangeItems.map(item => (
                                                        <TableRow key={item.barcode}>
                                                            <TableCell className="text-[10px] font-bold uppercase leading-tight">{item.productName}</TableCell>
                                                            <TableCell>
                                                                <div className="flex items-center justify-center gap-1.5">
                                                                    {isProductWeighted(item) || isProductWeighted(item.product) ? (
                                                                        <Input
                                                                            type="number"
                                                                            size="sm"
                                                                            step="0.001"
                                                                            aria-label="Cantidad para cambio"
                                                                            value={(item.cartQuantity || 0).toString()}
                                                                            onValueChange={(val) => handleQtyChange(item.barcode, parseFloat(val) || 0, true)}
                                                                            className="w-16"
                                                                            classNames={{
                                                                                inputWrapper: "h-6 bg-blue-50/50 dark:bg-blue-900/10 border-none rounded-2xl px-1 min-h-unit-5",
                                                                                input: "text-[10px] font-medium tabular-nums text-center text-blue-500"
                                                                            }}
                                                                        />
                                                                    ) : (
                                                                        <>
                                                                            <Button isIconOnly size="sm" variant="flat" className="h-6 w-6 rounded-2xl" onClick={() => handleQtyChange(item.barcode, (item.cartQuantity || 0) - 1, true)}>-</Button>
                                                                            <span className="text-xs font-medium tabular-nums">{item.cartQuantity}</span>
                                                                            <Button isIconOnly size="sm" variant="flat" className="h-6 w-6 rounded-2xl" onClick={() => handleQtyChange(item.barcode, (item.cartQuantity || 0) + 1, true)}>+</Button>
                                                                        </>
                                                                    )}
                                                                </div>
                                                            </TableCell>
                                                            <TableCell className="text-right text-[10px] font-medium tracking-tight tabular-nums">${(item.unitPrice * (item.cartQuantity || 0)).toLocaleString()}</TableCell>
                                                        </TableRow>
                                                    ))}
                                                </TableBody>
                                            </Table>
                                        </div>
                                    </div>
                                )}

                                {returnType === 'REFUND' && (
                                    <div className="h-full flex flex-col items-center justify-center space-y-4 py-10 bg-rose-500/5 rounded-[2.5rem] border border-dashed border-rose-500/20 animate-in fade-in duration-500">
                                        <div className="h-16 w-16 rounded-2xl bg-rose-500/10 flex items-center justify-center text-rose-500">
                                            <RotateCcw size={32} />
                                        </div>
                                        <div className="text-center">
                                            <p className="text-xs font-medium uppercase text-zinc-900 dark:text-zinc-50 tracking-widest tracking-tight">MODALIDAD DE REEMBOLSO ACTIVA</p>
                                            <p className="text-[10px] font-bold text-gray-400 dark:text-zinc-600 uppercase tracking-widest mt-1 max-w-[200px] mx-auto">El valor de los items retornados se reintegrara al pool de caja.</p>
                                        </div>
                                    </div>
                                )}
                            </CardBody>
                            <CardFooter className="px-4 py-3 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-transparent">
                                <div className="w-full flex justify-between items-end">
                                    <div>
                                        <p className="text-[8px] font-medium text-gray-400 dark:text-zinc-600 uppercase tracking-widest mb-1">TOTAL SALIDA / CAMBIO</p>
                                        <p className={`text-xl font-medium tracking-tighter tracking-tight leading-none tabular-nums ${returnType === 'EXCHANGE' ? 'text-blue-500' : 'text-zinc-900 dark:text-zinc-100/50'}`}>
                                            ${totalExchange.toLocaleString()}
                                        </p>
                                    </div>
                                </div>
                            </CardFooter>
                        </Card>
                    </div>
                </div>

                {/* HISTORIAL RECIENTE DOBLE COLUMNA: VENTAS VS DEVOLUCIONES */}
                {!sale && (recentSales.length > 0 || recentReturns.length > 0) && (
                    <div className="mt-4 px-1 pb-4 animate-in fade-in slide-in-from-bottom-5 duration-700">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                            {/* COLUMNA IZQUIERDA: VENTAS PARA GESTION */}
                            <div className="space-y-4">
                                <div className="flex items-center gap-3 pl-1">
                                    <div className="h-6 w-6 rounded-2xl bg-black/5 dark:bg-white/5 flex items-center justify-center text-zinc-900 dark:text-zinc-100 shadow-inner">
                                        <History size={14} />
                                    </div>
                                    <h3 className="text-[10px] font-medium uppercase tracking-[0.3em] text-gray-500 dark:text-zinc-500 dark:text-zinc-400">Ventas para Gestion</h3>
                                    <div className="h-px flex-1 bg-gradient-to-r from-gray-100 to-transparent dark:from-zinc-800" />
                                </div>

                                <Card className="rounded-[1.5rem] card-base border-none border border-gray-100 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-black/5 overflow-hidden">
                                    <Table isCompact removeWrapper aria-label="Ventas Recientes" classNames={{
                                        th: "bg-white dark:bg-zinc-950/80  text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-wider text-[8px] h-10 py-1 px-4 border-b border-zinc-200 dark:border-white/5",
                                        td: "py-2 px-4 whitespace-nowrap",
                                        tr: "border-b border-zinc-200 dark:border-white/5 hover:bg-zinc-50 dark:hover:bg-white/5 bg-white dark:bg-transparent border border-zinc-200 dark:border-white/5 transition-colors cursor-pointer group border-l-4 border-transparent hover:border-emerald-500"
                                    }}>
                                        <TableHeader>
                                            <TableColumn>FACTURA</TableColumn>
                                            <TableColumn>CLIENTE</TableColumn>
                                            <TableColumn align="end">TOTAL</TableColumn>
                                            <TableColumn align="center" width={60}>ACCION</TableColumn>
                                        </TableHeader>
                                        <TableBody emptyContent="SIN VENTAS">
                                            {recentSales.slice(0, 10).map((s) => (
                                                <TableRow key={s.id} onClick={() => loadSale(s)}>
                                                    <TableCell>
                                                        <div className="flex flex-col">
                                                            <span className="font-medium text-[10px] dark:text-white">#{s.id}</span>
                                                            <span className="text-[7px] font-bold text-gray-400 uppercase">{new Date(s.date).toLocaleDateString('es-CO')}</span>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell>
                                                        <span className="text-[9px] font-medium uppercase tracking-tight dark:text-zinc-300 max-w-[120px] truncate block">
                                                            {s.client?.name || 'CONSU. FINAL'}
                                                        </span>
                                                    </TableCell>
                                                    <TableCell>
                                                        <span className="text-[11px] font-medium tracking-tight tabular-nums dark:text-white">
                                                            ${s.total.toLocaleString()}
                                                        </span>
                                                    </TableCell>
                                                    <TableCell>
                                                        <div className="flex justify-center">
                                                            <Button size="sm" variant="flat" className="h-6 px-3 rounded-2xl font-medium text-[9px] uppercase tracking-widest bg-black/5 dark:bg-white/5 text-emerald-600 dark:text-zinc-300 hover:bg-emerald-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0">
                                                                GESTIONAR <ChevronRight size={12} className="shrink-0" />
                                                            </Button>
                                                        </div>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </Card>
                            </div>

                            {/* COLUMNA DERECHA: AUDITORIA DEVOLUCIONES */}
                            <div className="space-y-4">
                                <div className="flex items-center gap-3 pl-1">
                                    <div className="h-6 w-6 rounded-2xl bg-rose-500/10 flex items-center justify-center text-rose-500 shadow-inner">
                                        <RotateCcw size={14} className="rotate-180" />
                                    </div>
                                    <h3 className="text-[10px] font-medium uppercase tracking-[0.3em] text-gray-500 dark:text-zinc-500 dark:text-zinc-400">Auditoria Devoluciones</h3>
                                    <div className="h-px flex-1 bg-gradient-to-r from-gray-100 to-transparent dark:from-zinc-800" />
                                </div>

                                <Card className="rounded-[1.5rem] card-base border-none border border-gray-100 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-black/5 overflow-hidden">
                                    <div className="overflow-x-auto w-full">
                                        <Table isCompact removeWrapper aria-label="Devoluciones Recientes" classNames={{
                                        th: "bg-white dark:bg-zinc-950/80  text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-wider text-[8px] h-10 py-1 px-4 border-b border-zinc-200 dark:border-white/5",
                                        td: "py-2 px-4 whitespace-nowrap",
                                        tr: "border-b border-zinc-200 dark:border-white/5 hover:bg-rose-500/5 transition-colors cursor-default group border-l-4 border-transparent hover:border-rose-500"
                                    }}>
                                        <TableHeader>
                                            <TableColumn>FECHA/HORA</TableColumn>
                                            <TableColumn>TICKET/FACTURA</TableColumn>
                                            <TableColumn>PRODUCTO</TableColumn>
                                            <TableColumn align="center">CANTIDAD</TableColumn>
                                            <TableColumn align="end">TOTAL REEMBOLSADO</TableColumn>
                                            <TableColumn>MOTIVO</TableColumn>
                                            <TableColumn>USUARIO</TableColumn>
                                        </TableHeader>
                                        <TableBody emptyContent={isHistoryLoading ? <Spinner size="sm" color="danger" /> : (
                                            <div className="flex flex-col items-center justify-center py-12 opacity-30">
                                                <RotateCcw size={40} className="mb-3 text-rose-400" />
                                                <span className="text-[10px] font-medium uppercase tracking-[0.3em] text-gray-400 tracking-tight">Sin devoluciones registradas</span>
                                            </div>
                                        )}>
                                            {recentReturns.slice(0, 15).map((r: any) => (
                                                <TableRow key={r.id}>
                                                    <TableCell>
                                                        <span className="text-[9px] font-bold text-gray-500 dark:text-zinc-400 uppercase leading-none">{formatShortDateTime(r.date || r.createdAt)}</span>
                                                    </TableCell>
                                                    <TableCell>
                                                        <div className="flex flex-col">
                                                            <span className="font-medium text-[10px] dark:text-white">#{r.id}</span>
                                                            <span className="text-[8px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-tight">INV #{r.saleId || r.sale_id}</span>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell>
                                                        <div className="flex flex-col">
                                                            {(r.details || []).length > 0 ? (
                                                                (r.details || []).map((d: any, idx: number) => (
                                                                    <span key={idx} className="text-[9px] text-gray-700 dark:text-zinc-300 font-bold uppercase leading-tight truncate max-w-[150px]">
                                                                        {d.product?.productName || d.productName || '...'}
                                                                    </span>
                                                                ))
                                                            ) : (
                                                                <span className="text-[8px] text-gray-400 tracking-tight">—</span>
                                                            )}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell align="center">
                                                        <div className="flex flex-col items-center">
                                                            {(r.details || []).length > 0 ? (
                                                                (r.details || []).map((d: any, idx: number) => (
                                                                    <span key={idx} className="text-[9px] text-gray-600 dark:text-zinc-400 font-mono font-bold leading-tight">
                                                                        {d.quantity}
                                                                    </span>
                                                                ))
                                                            ) : (
                                                                <span className="text-[8px] text-gray-400 tracking-tight">—</span>
                                                            )}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell align="right">
                                                        <div className="flex flex-col items-end gap-1">
                                                            <span className="text-[11px] font-medium tracking-tight tabular-nums dark:text-white">
                                                                ${(r.totalReturned || r.amount || 0).toLocaleString()}
                                                            </span>
                                                            <Chip size="sm" variant="flat" className={`h-4 text-[7px] font-medium uppercase tracking-widest ${r.returnType === 'EXCHANGE' ? 'bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400' : 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 dark:bg-white/5 dark:text-zinc-300'}`}>
                                                                {getReturnTypeLabel(r.returnType || 'REFUND')}
                                                            </Chip>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell>
                                                        <span className="text-[8px] font-bold text-gray-500 dark:text-zinc-400 uppercase truncate max-w-[100px] block">
                                                            {r.reason || '—'}
                                                        </span>
                                                    </TableCell>
                                                    <TableCell>
                                                        <span className="text-[8px] font-bold text-gray-500 dark:text-zinc-400 uppercase truncate max-w-[100px] block">
                                                            {r.employee?.name || r.employeeDni || '—'}
                                                        </span>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                    </div>
                                </Card>
                            </div>

                        </div>
                    </div>
                )}

                {/* BARRA INFERIOR DE ACCION (FIXED) */}
                {(returningItems.length > 0 || exchangeItems.length > 0) && (
                    <div className="fixed bottom-0 left-0 right-0 z-40 animate-in slide-in-from-bottom-full duration-500 px-2 pb-2">
                        <div className="card-base border-none dark:bg-zinc-950/90 p-2 border border-gray-200 dark:border-white/10 flex items-center justify-between max-w-7xl mx-auto w-full rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all">
                            <div className="flex items-center gap-6 pl-4">
                                <div className="flex flex-col">
                                    <span className={`text-[8px] font-medium uppercase tracking-[0.2em] mb-1 flex items-center gap-2 ${balance >= 0 ? 'text-zinc-900 dark:text-zinc-100' : 'text-rose-500'}`}>
                                        <div className={`h-1.5 w-1.5 rounded-2xl animate-pulse ${balance >= 0 ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5' : 'bg-rose-500'}`} />
                                        {balance >= 0 ? "REINTEGRO" : "EXCEDENTE"}
                                    </span>
                                    <div className={`text-2xl font-medium tabular-nums tracking-tighter leading-none ${balance >= 0 ? 'text-zinc-900 dark:text-zinc-50' : 'text-rose-500'} tracking-tight`}>
                                        {balance >= 0 ? `$${balance.toLocaleString()}` : `-$${Math.abs(balance).toLocaleString()}`}
                                    </div>
                                </div>

                                <div className="hidden md:flex flex-col gap-0.5 border-l border-gray-100 dark:border-white/5 pl-6">
                                    <p className="text-[7px] font-medium text-gray-400 uppercase tracking-widest">Resumen</p>
                                    <div className="flex gap-3">
                                        <div className="flex items-center gap-1.5">
                                            <div className="h-1 w-1 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5" />
                                            <span className="text-[9px] font-extrabold text-gray-500 tracking-tight tabular-nums">+{totalReturned.toLocaleString()}</span>
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <div className="h-1 w-1 rounded-2xl bg-blue-500" />
                                            <span className="text-[9px] font-extrabold text-gray-500 tracking-tight tabular-nums">-{totalExchange.toLocaleString()}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <Button
                                className={`h-14 px-10 text-xs font-medium rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all hover:scale-[1.02] active:scale-95 ${balance >= 0
                                    ? "bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white "
                                    : "bg-rose-600 text-white shadow-rose-500/20"
                                    }`}
                                onPress={() => setReturnDialogOpen(true)}
                                isDisabled={(returningItems.length === 0 && exchangeItems.length === 0)}
                            >
                                <span className="uppercase tracking-[0.2em]">{balance >= 0 ? 'PROCESAR DEVOLUCION' : 'COBRAR EXCEDENTE Y FINALIZAR'}</span>
                            </Button>
                        </div>
                    </div>
                )}

                {/* MODAL: CONFIRMAR DEVOLUCION (Optimizado Mobile) */}
                <UniversalPaymentModal
                    isOpen={returnDialogOpen}
                    onOpenChange={setReturnDialogOpen}
                    title="DINERO A DEVOLVER AL CLIENTE"
                    client={sale?.client || null}
                    totalToPay={Math.abs(balance)}
                    showSuccessScreen={showSuccessScreen}
                    submittingPayment={submittingPayment}
                    lastChange={lastChange}
                    onPay={handleFinalPayment}
                    onCloseComplete={handleClosePaymentModal}
                    reason={returnReason}
                    onReasonChange={setReturnReason}
                    showCreditTab={false}
                    flowType="out"
                />

                {/* MODAL: RESULTADOS BUSQUEDA */}
                <Modal isOpen={isResultsDialogOpen} onOpenChange={setIsResultsDialogOpen} backdrop="blur" size="4xl" classNames={{ base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-[2.5rem] shadow-[0_8px_30px_rgb(0,0,0,0.12)]", header: "border-b border-gray-100 dark:border-white/5 p-8", body: "p-8", footer: "border-t border-gray-100 dark:border-white/5 p-8" }}>
                    <ModalContent>
                        {(onClose) => (
                            <>
                                <ModalHeader className="flex flex-col gap-1">
                                    <h2 className="text-2xl font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight flex items-center gap-3">
                                        <History className="h-6 w-6 text-rose-600 dark:text-rose-500" /> Resultados
                                    </h2>
                                    <p className="text-gray-500 dark:text-zinc-500 font-bold uppercase tracking-widest text-[10px] mt-1">
                                        Selecciona la venta para iniciar el proceso
                                    </p>
                                </ModalHeader>
                                <ModalBody>
                                    <div className="rounded-[2rem] border border-gray-200 dark:border-white/5 overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                        <Table aria-label="Resultados busqueda" removeWrapper isCompact classNames={{ th: "bg-gray-100 dark:bg-[#18181b] text-gray-500 dark:text-zinc-400 font-medium uppercase text-[10px] tracking-widest h-12", td: "py-4 border-b border-gray-100 dark:border-white/5 bg-white dark:bg-transparent", tr: "hover:bg-zinc-50 dark:hover:bg-white/5 bg-white dark:bg-transparent border border-zinc-200 dark:border-white/5 border-l-4 border-transparent hover:border-emerald-500 cursor-pointer transition-colors group" }}>
                                            <TableHeader>
                                                <TableColumn>ID</TableColumn>
                                                <TableColumn>CLIENTE</TableColumn>
                                                <TableColumn align="end">TOTAL</TableColumn>
                                                <TableColumn align="center">ACCION</TableColumn>
                                            </TableHeader>
                                            <TableBody>
                                                {searchResults.map((s) => (
                                                    <TableRow key={s.id} onClick={() => loadSale(s)}>
                                                        <TableCell className="font-medium text-sm text-gray-500 dark:text-zinc-500 dark:text-zinc-400 group-hover:text-zinc-900 dark:text-zinc-100 transition-colors">#{s.id}</TableCell>
                                                        <TableCell>
                                                             <div className="font-bold text-sm text-zinc-900 dark:text-zinc-50 uppercase leading-none mb-1">{s.client?.name || 'Consumidor Final'}</div>
                                                             <div className="text-[10px] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 font-bold uppercase tracking-widest leading-none">
                                                                {formatShortDateTime(s.date)}
                                                             </div>
                                                        </TableCell>
                                                        <TableCell className="font-medium text-base text-zinc-900 dark:text-zinc-50 tabular-nums">${s.total.toLocaleString()}</TableCell>
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
                                            <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest hidden sm:block">
                                                Total: {searchResultsTotal}
                                            </span>
                                            <Pagination
                                                isCompact
                                                showControls
                                                color="danger"
                                                page={searchResultsPage}
                                                total={Math.max(1, Math.ceil(searchResultsTotal / 10))}
                                                onChange={(page) => handleSearch(true, page)}
                                                classNames={{
                                                    wrapper: "gap-2",
                                                    item: "w-10 h-10 min-w-10 rounded-2xl font-medium text-xs card-base border-none",
                                                    cursor: "bg-rose-600 dark:bg-rose-500 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/30",
                                                    next: "card-base border-none rounded-2xl border border-gray-200 dark:border-white/5",
                                                    prev: "card-base border-none rounded-2xl border border-gray-200 dark:border-white/5"
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

                {/* SCANNER OVERLAY (Este se mantiene oscuro por diseño de UI de camaras) */}
                {isScannerOpen && (
                    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/90">
                        <div className="relative w-full max-w-2xl aspect-video bg-white dark:bg-zinc-950 rounded-[2.5rem] overflow-hidden border border-zinc-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                            <div className="absolute top-0 left-0 right-0 p-6 flex justify-between items-center z-10 pointer-events-none">
                                <h2 className="text-white font-medium uppercase tracking-widest text-sm flex items-center gap-2">
                                    <Camera className="h-5 w-5 text-rose-500" /> Escaner Activo
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
                                className="absolute top-6 right-6 h-10 w-10 rounded-2xl bg-[#18181b] hover:bg-rose-500 text-white border border-zinc-200 dark:border-white/10 transition-all z-20"
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
        </div>
    );
}

export default function ReturnsPage() {
    return (
        <Suspense fallback={
            <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950">
                <Spinner color="success" size="lg" />
            </div>
        }>
            <ReturnsContent />
        </Suspense>
    );
}


