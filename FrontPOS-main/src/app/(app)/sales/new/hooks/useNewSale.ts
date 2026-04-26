import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Cookies from 'js-cookie';
import { useToast } from '@/hooks/use-toast';
import { Product, Customer, Category } from '@/lib/definitions';
import { applyRounding } from "@/lib/utils";
import { useScale } from '@/hooks/useScale';
import { saveCartsToIndexedDB, loadCartsFromIndexedDB } from '@/lib/cartStorage';
import { extractApiError } from '@/lib/api-error';

export interface CartItem extends Product {
    cartQuantity: number;
}

export function useNewSale() {
    const router = useRouter();
    const { toast } = useToast();
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);

    // Core Data
    const [products, setProducts] = useState<Product[]>([]);
    const [customers, setCustomers] = useState<Customer[]>([]);
    const [categories, setCategories] = useState<Category[]>([]);

    // Cart Management
    const [carts, setCarts] = useState<Record<string, CartItem[]>>({ 'Factura 1': [] });
    const [cartKeys, setCartKeys] = useState<string[]>(['Factura 1']);
    const [activeCartKey, setActiveCartKey] = useState('Factura 1');
    const [cartCustomers, setCartCustomers] = useState<Record<string, string>>({ 'Factura 1': '0' });
    const [selectedCustomerDni, setSelectedCustomerDni] = useState<string>('0');

    // UI State
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategory, setSelectedCategory] = useState<string>('all');
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
    const [barcodeInput, setBarcodeInput] = useState('');
    const [feedbackCode, setFeedbackCode] = useState('');
    const [isFeedbackError, setIsFeedbackError] = useState(false);
    
    // Modals & Dialogs State
    const [isPaymentDialogOpen, setIsPaymentDialogOpen] = useState(false);
    const [isClientDialogOpen, setIsClientDialogOpen] = useState(false);
    const [clientSearch, setClientSearch] = useState('');
    const [isScannerOpen, setIsScannerOpen] = useState(false);
    const [isManualWeightOpen, setIsManualWeightOpen] = useState(false);
    const [manualWeightProduct, setManualWeightProduct] = useState<Product | null>(null);
    const [manualWeightValue, setManualWeightValue] = useState('');
    const [isSplitDialogOpen, setIsSplitDialogOpen] = useState(false);
    const [isCartDropdownOpen, setIsCartDropdownOpen] = useState(false);
    const [isMissingItemOpen, setIsMissingItemOpen] = useState(false);

    // Split Bill State
    const [splitItemsToPay, setSplitItemsToPay] = useState<CartItem[] | null>(null);
    const [remainingItemsAfterSplit, setRemainingItemsAfterSplit] = useState<CartItem[] | null>(null);
    const [originalCustomerDniBeforeSplit, setOriginalCustomerDniBeforeSplit] = useState<string | null>(null);

    // Success State
    const [showSuccessScreen, setShowSuccessScreen] = useState(false);
    const [lastChange, setLastChange] = useState(0);
    const [lastReceipt, setLastReceipt] = useState<any>(null);

    // Ultra-Instinto: Web Worker & Offline DB
    const workerRef = useRef<Worker | null>(null);
    const [isOffline, setIsOffline] = useState(false);
    const [workerFilteredProducts, setWorkerFilteredProducts] = useState<Product[]>([]);

    const { weight: scaleWeight, isScaleOnline } = useScale();
    const hiddenScannerRef = useRef<HTMLInputElement>(null);

    // Initializing Web Worker
    useEffect(() => {
        workerRef.current = new Worker(new URL('../../../../../workers/saleWorker.ts', import.meta.url));
        
        workerRef.current.onmessage = (e) => {
            const { type, payload } = e.data;
            if (type === 'FILTERED_PRODUCTS') {
                setWorkerFilteredProducts(payload);
            }
        };

        const handleOnline = () => { setIsOffline(false); syncOfflineQueue(); };
        const handleOffline = () => { setIsOffline(true); };

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        return () => {
            workerRef.current?.terminate();
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    // Sync Master Data to Offline DB & Worker when fetched
    useEffect(() => {
        if (products.length > 0) {
            import('@/lib/offline-db').then(db => {
                db.cacheMasterData(products, customers, categories);
            });
            workerRef.current?.postMessage({ type: 'SET_PRODUCTS', payload: products });
            // Carga inicial del grid
            workerRef.current?.postMessage({ 
                type: 'UPDATE_SEARCH', 
                payload: { query: searchQuery, category: selectedCategory } 
            });
        }
    }, [products, customers, categories]);

    // Ultra-Instinto: Offload search to worker whenever inputs change
    useEffect(() => {
        workerRef.current?.postMessage({ 
            type: 'UPDATE_SEARCH', 
            payload: { query: searchQuery, category: selectedCategory } 
        });
    }, [searchQuery, selectedCategory]);

    const syncOfflineQueue = async () => {
        const { getOfflineQueue, removeFromOfflineQueue } = await import('@/lib/offline-db');
        const queue = await getOfflineQueue();
        if (queue.length === 0) return;

        toast({ title: "SINCRONIZANDO", description: `SUBIENDO ${queue.length} VENTAS PENDIENTES...` });
        
        for (const sale of queue) {
            try {
                const token = Cookies.get('org-pos-token');
                const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/sales/register`, {
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, 
                    body: JSON.stringify(sale.saleData)
                });
                if (res.ok) await removeFromOfflineQueue(sale.id);
            } catch (err) {
                console.error("Sync failed for", sale.id, err);
            }
        }
        toast({ variant: "success", title: "SINCRO COMPLETA", description: "TODO AL DÍA" });
    };

    // Computed Values (Optimized via useMemo)
    const currentCart = useMemo(() => carts[activeCartKey] || [], [carts, activeCartKey]);
    
    const sortedCart = useMemo(() => {
        return [...currentCart].sort((a, b) => (a.productName || '').localeCompare(b.productName || ''));
    }, [currentCart]);

    const total = useMemo(() => {
        const items = splitItemsToPay || currentCart;
        if (items.length === 0) return 0;
        return items.reduce((sum, item) => {
            const price = Number(item.salePrice) || 0;
            return sum + applyRounding(price * item.cartQuantity);
        }, 0);
    }, [splitItemsToPay, currentCart]);

    const selectedCustomer = useMemo(() => {
        const found = customers.find(c => c.dni === selectedCustomerDni);
        if (found) return found;
        return { 
            id: '0', dni: '0', name: 'CONSUMIDOR FINAL', phone: '', address: '', 
            totalPurchases: 0, totalSpent: 0, lastPurchaseDate: '', 
            creditLimit: 0, currentCredit: 0 
        } as Customer;
    }, [customers, selectedCustomerDni]);

    // El grid ahora viene del Worker (Resiliencia HFT)
    const filteredProductsGrid = workerFilteredProducts;

    const filteredCustomers = useMemo(() => {
        const query = clientSearch.toLowerCase().trim();
        if (!query) return customers;
        return customers.filter(c => 
            (c.name || '').toLowerCase().includes(query) || (c.dni || '').includes(query)
        );
    }, [customers, clientSearch]);

    const sortedCategories = useMemo(() => {
        return [...categories].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }, [categories]);

    // Helpers
    const returnFocusToScanner = useCallback(() => {
        if (hiddenScannerRef.current) hiddenScannerRef.current.focus();
    }, []);

    // Actions
    const handleCartSwitch = useCallback((key: string) => { 
        setActiveCartKey(key); 
        setSelectedCustomerDni(cartCustomers[key] || '0'); 
        setTimeout(returnFocusToScanner, 50);
    }, [cartCustomers, returnFocusToScanner]);

    const handleClientSelect = (dni: string) => { 
        setSelectedCustomerDni(dni); 
        setCartCustomers(prev => ({ ...prev, [activeCartKey]: dni })); 
    };

    const addNewCart = () => {
        if (currentCart.length === 0) { 
            toast({ variant: "destructive", title: "SISTEMA", description: "CARRITO VACÍO" }); 
            returnFocusToScanner(); 
            return; 
        }
        const nextNum = cartKeys.length > 0 ? Math.max(...cartKeys.map(k => parseInt(k.split(' ')[1]) || 0)) + 1 : 1;
        const newKey = `Factura ${nextNum}`;
        setCartKeys([...cartKeys, newKey]); 
        setCarts(prev => ({ ...prev, [newKey]: [] })); 
        setCartCustomers(prev => ({ ...prev, [newKey]: '0' })); 
        handleCartSwitch(newKey);
    };

    const deleteCart = (key: string) => {
        if (cartKeys.length <= 1) return;
        const newKeys = cartKeys.filter(k => k !== key); 
        setCartKeys(newKeys);
        setCarts(prev => {
            const next = { ...prev };
            delete next[key];
            return next;
        });
        setCartCustomers(prev => {
            const next = { ...prev };
            delete next[key];
            return next;
        });
        if (activeCartKey === key) handleCartSwitch(newKeys[newKeys.length - 1]);
    };

    const updateQuantity = useCallback((barcode: string, delta: number) => {
        const item = currentCart.find(i => i.barcode === barcode);
        if (!item) return;

        const newQty = item.cartQuantity + delta;

        if (newQty <= 0) {
            setCarts(prev => {
                const current = [...(prev[activeCartKey] || [])];
                const filtered = current.filter(i => i.barcode !== barcode);
                if (barcode === selectedItemId) setSelectedItemId(filtered[0]?.barcode || null);
                return { ...prev, [activeCartKey]: filtered };
            });
            return;
        }

        if (!item.isWeighted && delta > 0 && newQty > item.quantity) {
            toast({ variant: "destructive", title: "SISTEMA", description: `STOCK INSUFICIENTE: SOLO QUEDAN ${item.quantity} UNIDADES` }); 
            return;
        }

        setCarts(prev => {
            const current = [...(prev[activeCartKey] || [])];
            const index = current.findIndex(i => i.barcode === barcode);
            if (index === -1) return prev;
            current[index] = { ...current[index], cartQuantity: newQty };
            return { ...prev, [activeCartKey]: current };
        });
    }, [activeCartKey, selectedItemId, currentCart, toast]);

    const removeFromCart = useCallback((barcode: string) => {
        setCarts(prev => {
            const current = [...(prev[activeCartKey] || [])];
            const filtered = current.filter(item => item.barcode !== barcode);
            if (barcode === selectedItemId) setSelectedItemId(filtered[0]?.barcode || null);
            return { ...prev, [activeCartKey]: filtered };
        }); 
        returnFocusToScanner();
    }, [activeCartKey, selectedItemId, returnFocusToScanner]);

    const addMiscItem = useCallback((priceStr: string) => {
        const price = parseFloat(priceStr);
        if (isNaN(price) || price <= 0) return;
        const miscProduct: Product = { 
            barcode: `MISC-${price}`, 
            productName: `PRODUCTO VARIO ($${price.toLocaleString()})`, 
            salePrice: price, 
            quantity: 999999, 
            purchasePrice: price / 1.20, 
            marginPercentage: 20, 
            categoryId: 0, 
            isWeighted: false 
        };
        setCarts(prev => {
            const current = [...(prev[activeCartKey] || [])];
            const existingIndex = current.findIndex(item => item.barcode === miscProduct.barcode);
            if (existingIndex > -1) { 
                current[existingIndex] = { ...current[existingIndex], cartQuantity: current[existingIndex].cartQuantity + 1 }; 
            } else { 
                current.push({ ...miscProduct, cartQuantity: 1 }); 
            }
            return { ...prev, [activeCartKey]: current };
        });
        setSelectedItemId(miscProduct.barcode); 
        toast({ variant: "success", title: "ÉXITO", description: "AGREGADO" }); 
        returnFocusToScanner();
    }, [activeCartKey, toast, returnFocusToScanner]);

    const addToCart = useCallback((product: Product) => {
        if (product.quantity <= 0 && !product.isWeighted) { 
            toast({ variant: "destructive", title: "SISTEMA", description: "SIN STOCK" }); 
            setSearchQuery(''); 
            return; 
        }

        const existingItem = currentCart.find(item => item.barcode === product.barcode);

        if (product.isWeighted) {
            if (scaleWeight >= 0.010 && isScaleOnline) {
                setCarts(prev => {
                    const current = [...(prev[activeCartKey] || [])];
                    const idx = current.findIndex(item => item.barcode === product.barcode);
                    if (idx > -1) current[idx] = { ...current[idx], cartQuantity: current[idx].cartQuantity + scaleWeight }; 
                    else current.push({ ...product, cartQuantity: scaleWeight });
                    return { ...prev, [activeCartKey]: current };
                }); 
                setSelectedItemId(product.barcode); 
                setSearchQuery(''); 
                returnFocusToScanner(); 
                return;
            }
            setManualWeightProduct(product); 
            setIsManualWeightOpen(true); 
            setSearchQuery(''); 
            return;
        }

        if (existingItem && !product.isWeighted && existingItem.cartQuantity >= product.quantity) {
            toast({ variant: "destructive", title: "SISTEMA", description: `MÁXIMO ALCANZADO: ${product.quantity} DISPONIBLES` });
            return;
        }

        setCarts(prev => {
            const current = [...(prev[activeCartKey] || [])];
            const idx = current.findIndex(item => item.barcode === product.barcode);
            if (idx > -1) {
                current[idx] = { ...current[idx], cartQuantity: current[idx].cartQuantity + 1 };
            } else {
                current.push({ ...product, cartQuantity: 1 });
            }
            return { ...prev, [activeCartKey]: current };
        }); 
        setSelectedItemId(product.barcode); 
        setSearchQuery(''); 
        returnFocusToScanner();
    }, [activeCartKey, scaleWeight, isScaleOnline, currentCart, returnFocusToScanner, toast]);

    const handleCodeSubmit = useCallback((code: string) => {
        let finalCode = code.trim();
        let qty = 1;
        if (finalCode.includes('*')) {
            const parts = finalCode.split('*');
            if (parts.length === 2) {
                const q = parseFloat(parts[0]);
                if (!isNaN(q) && q > 0) { qty = q; finalCode = parts[1].trim(); }
            }
        }
        if (!finalCode) return;
        const p = products.find(x => x.barcode === finalCode);
        if (p) {
            for (let i = 0; i < qty; i++) addToCart(p);
            setFeedbackCode(finalCode); setIsFeedbackError(false); setSearchQuery('');
        } else {
            const numericValue = parseFloat(finalCode);
            const isLikelyBarcode = finalCode.length >= 7;
            if (!isNaN(numericValue) && numericValue > 0 && !isLikelyBarcode) {
                for (let i = 0; i < qty; i++) addMiscItem(finalCode);
                setFeedbackCode(finalCode); setIsFeedbackError(false); setSearchQuery('');
            } else {
                setFeedbackCode(finalCode); setIsFeedbackError(true); toast({ variant: "destructive", title: "ERROR", description: "NO ENCONTRADO" });
            }
        }
        setBarcodeInput(''); returnFocusToScanner();
    }, [products, addToCart, addMiscItem, toast, returnFocusToScanner]);

    const handleScaleSync = useCallback(() => {
        if (!isScaleOnline || scaleWeight < 0.005 || !selectedItemId) return;
        
        const item = currentCart.find(i => i.barcode === selectedItemId);
        if (item && item.isWeighted) {
            setCarts(prev => {
                const current = [...(prev[activeCartKey] || [])];
                const idx = current.findIndex(i => i.barcode === selectedItemId);
                if (idx > -1) {
                    current[idx] = { ...current[idx], cartQuantity: scaleWeight };
                }
                return { ...prev, [activeCartKey]: current };
            });
            toast({ variant: "success", title: "PESO SINCRONIZADO", description: `${item.productName}: ${scaleWeight.toFixed(3)} kg` });
        }
    }, [isScaleOnline, scaleWeight, selectedItemId, activeCartKey, currentCart, toast]);

    const handleConfirmSale = async (paymentData: {
        cash: number;
        transfer: number;
        transferSource: string;
        credit: number;
        totalPaid: number;
        change: number;
    }) => {
        if (currentCart.length === 0 && !splitItemsToPay) return;
        const itemsToPay = splitItemsToPay || currentCart;

        setSubmitting(true);
        const token = Cookies.get('org-pos-token');
        const { cash, transfer, transferSource, credit, totalPaid, change } = paymentData;

        const saleData = {
            clientDni: selectedCustomerDni,
            employeeDni: "ADMIN",
            paymentMethod: credit > 0 ? "FIADO" : (cash > 0 && transfer > 0 ? "MIXTO" : transfer > 0 ? "TRANSFERENCIA" : "EFECTIVO"),
            total: total,
            amountPaid: totalPaid,
            cashAmount: cash,
            transferAmount: transfer,
            transferSource: transfer > 0 ? transferSource : '',
            creditAmount: credit,
            change: change,
            details: itemsToPay.map(item => ({
                barcode: item.barcode, quantity: item.cartQuantity, unitPrice: Number(item.salePrice), subtotal: applyRounding(Number(item.salePrice) * item.cartQuantity)
            }))
        };

        try {
            if (credit > 0 && selectedCustomerDni === '0') {
                toast({ variant: "destructive", title: "ERROR", description: "INVÁLIDO PARA C. FINAL" });
                setSubmitting(false);
                return;
            }

            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/sales/register`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify(saleData)
            });

            if (res.ok) {
                toast({ variant: 'success', title: 'VENTA REGISTRADA', description: 'TRANSACCIÓN COMPLETADA CON ÉXITO' });
                finalizeLocalSale(itemsToPay, saleData, change);
            } else {
                const errorMsg = await extractApiError(res, "ERROR AL REGISTRAR VENTA");
                throw new Error(errorMsg);
            }
        } catch (err: any) {
            // ULTRA-INSTINTO: Si falla por red, guardar en cola offline
            const { queueOfflineSale } = await import('@/lib/offline-db');
            await queueOfflineSale(saleData);
            
            toast({ 
                variant: "default", 
                title: "MODO OFFLINE", 
                description: "VENTA GUARDADA LOCALMENTE. SE SINCRONIZARÁ AL VOLVER EL INTERNET." 
            });
            
            finalizeLocalSale(itemsToPay, saleData, change);
        } finally {
            setSubmitting(false);
        }
    };

    const finalizeLocalSale = (itemsToPay: any[], saleData: any, change: number) => {
        setLastChange(change);
        setShowSuccessScreen(true);
        if (remainingItemsAfterSplit) {
            setCarts(prev => ({ ...prev, [activeCartKey]: remainingItemsAfterSplit }));
            setRemainingItemsAfterSplit(null); setSplitItemsToPay(null);
            if (originalCustomerDniBeforeSplit) {
                handleClientSelect(originalCustomerDniBeforeSplit);
                setOriginalCustomerDniBeforeSplit(null);
            }
        } else {
            setCarts(prev => ({ ...prev, [activeCartKey]: [] })); handleClientSelect('0');
        }
        setLastReceipt({
            date: new Date().toLocaleString('es-CO'),
            clientName: selectedCustomer.name,
            clientDni: selectedCustomerDni,
            total: total,
            paymentMethod: saleData.paymentMethod,
            cashAmount: saleData.cashAmount,
            transferAmount: saleData.transferAmount,
            creditAmount: saleData.creditAmount,
            change: change,
            items: itemsToPay
        });
    };

    const confirmManualWeight = () => {
        const weight = parseFloat(manualWeightValue);
        if (isNaN(weight) || weight <= 0) { toast({ variant: "destructive", title: "ERROR", description: "PESO INVÁLIDO" }); return; }
        if (manualWeightProduct) {
            setCarts(prev => {
                const current = [...(prev[activeCartKey] || [])];
                const idx = current.findIndex(item => item.barcode === manualWeightProduct.barcode);
                if (idx > -1) current[idx] = { ...current[idx], cartQuantity: current[idx].cartQuantity + weight };
                else current.push({ ...manualWeightProduct, cartQuantity: weight });
                return { ...prev, [activeCartKey]: current };
            });
            setSelectedItemId(manualWeightProduct.barcode); 
            setManualWeightValue(''); 
            setIsManualWeightOpen(false); 
            setManualWeightProduct(null); 
            returnFocusToScanner();
        }
    };

    // Effects
    useEffect(() => {
        if (feedbackCode) {
            const t = setTimeout(() => { setFeedbackCode(''); setIsFeedbackError(false); }, 1500);
            return () => clearTimeout(t);
        }
    }, [feedbackCode]);

    useEffect(() => {
        const loadData = async () => {
            const token = Cookies.get('org-pos-token');
            if (!token) { router.replace('/login'); return; }
            try {
                // Primero intentamos red
                const [pRes, cuRes, caRes] = await Promise.all([
                    fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/all-products`, { headers: { 'Authorization': `Bearer ${token}` } }).then(r => r.json()).catch(() => null),
                    fetch(`${process.env.NEXT_PUBLIC_API_URL}/clients/all-clients`, { headers: { 'Authorization': `Bearer ${token}` } }).then(r => r.json()).catch(() => null),
                    fetch(`${process.env.NEXT_PUBLIC_API_URL}/categories/all-categories`, { headers: { 'Authorization': `Bearer ${token}` } }).then(r => r.json()).catch(() => null)
                ]);

                if (pRes) {
                    setProducts(pRes); setCustomers(cuRes || []); setCategories(caRes || []);
                } else {
                    // Si falla red, cargar de Offline DB (MANDATORIO PARA RESILIENCIA HFT)
                    const { getCachedMasterData } = await import('@/lib/offline-db');
                    const cached = await getCachedMasterData();
                    if (cached) {
                        setProducts(cached.products);
                        setCustomers(cached.customers);
                        setCategories(cached.categories);
                        toast({ variant: "default", title: "MODO OFFLINE ACTIVO", description: "CARGANDO DATOS LOCALES" });
                    }
                }

                const savedData = await loadCartsFromIndexedDB();
                if (savedData && Object.keys(savedData.carts).length > 0) {
                    setCarts(savedData.carts); 
                    setCartKeys(Object.keys(savedData.carts)); 
                    setActiveCartKey(savedData.activeKey || 'Factura 1'); 
                    setSelectedCustomerDni(savedData.customerDni || '0');
                }
            } catch (err: any) {
                console.error(err);
                // Fallback a Offline DB en catch global
                const { getCachedMasterData } = await import('@/lib/offline-db');
                const cached = await getCachedMasterData();
                if (cached) {
                    setProducts(cached.products); setCustomers(cached.customers); setCategories(cached.categories);
                }
            } finally {
                setLoading(false);
            }
        };
        loadData();
    }, [router, toast]);

    useEffect(() => {
        if (!loading) saveCartsToIndexedDB(carts, activeCartKey, selectedCustomerDni);
    }, [carts, activeCartKey, selectedCustomerDni, loading]);

    return {
        // Data
        products, customers, categories: sortedCategories,
        currentCart: sortedCart, activeCartKey, cartKeys, cartCustomers,
        selectedCustomer, selectedCustomerDni,
        
        // Computed
        total, filteredProductsGrid, filteredCustomers,
        
        // UI State
        loading, submitting, searchQuery, setSearchQuery,
        selectedCategory, setSelectedCategory,
        selectedItemId, setSelectedItemId,
        barcodeInput, setBarcodeInput,
        feedbackCode, isFeedbackError,
        isOffline, // Exportamos estado de red
        
        // Modal States
        isPaymentDialogOpen, setIsPaymentDialogOpen,
        isClientDialogOpen, setIsClientDialogOpen,
        clientSearch, setClientSearch,
        isScannerOpen, setIsScannerOpen,
        isManualWeightOpen, setIsManualWeightOpen,
        manualWeightProduct, manualWeightValue, setManualWeightValue,
        isSplitDialogOpen, setIsSplitDialogOpen,
        isCartDropdownOpen, setIsCartDropdownOpen,
        isMissingItemOpen, setIsMissingItemOpen,
        
        // Split State
        splitItemsToPay, setSplitItemsToPay,
        remainingItemsAfterSplit, setRemainingItemsAfterSplit,
        setOriginalCustomerDniBeforeSplit,
        
        // Results
        showSuccessScreen, setShowSuccessScreen,
        lastChange, lastReceipt,
        
        // Helpers & Refs
        hiddenScannerRef, returnFocusToScanner,
        scaleWeight, isScaleOnline,
        
        // Handlers
        handleCartSwitch, handleClientSelect, addNewCart, deleteCart,
        updateQuantity, removeFromCart, addToCart, addMiscItem,
        handleCodeSubmit, handleScaleSync, handleConfirmSale, confirmManualWeight
    };
}
