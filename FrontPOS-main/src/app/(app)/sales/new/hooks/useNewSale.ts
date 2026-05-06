import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Cookies from 'js-cookie';
import { useToast } from '@/hooks/use-toast';
import { Product, Customer, Category } from '@/lib/definitions';
import { applyRounding, isProductWeighted } from "@/lib/utils";
import { ScaleBridge } from '@/lib/scaleBridge';
import { useScale } from '@/hooks/useScale';
import { saveCartsToIndexedDB, loadCartsFromIndexedDB } from '@/lib/cartStorage';
import { extractApiError } from '@/lib/api-error';
import { useApi } from '@/hooks/use-api';
import { broadcastRevalidate } from '@/lib/revalidate';

export interface CartItem extends Product {
    cartQuantity: number;
    cartItemId: string; // ID único para React keys
}

export function useNewSale() {
    const router = useRouter();
    const { toast } = useToast();
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);

    // Core Data (Auto-refreshing via SWR)
    const { data: productsData, mutate: mutateProducts, isLoading: productsLoading } = useApi<Product[]>('/products/all-products', { 
        refreshInterval: 10000,
        revalidateOnFocus: true 
    });
    const { data: customersData, isLoading: customersLoading } = useApi<Customer[]>('/clients/all-clients', { refreshInterval: 60000 });
    const { data: categoriesData, isLoading: categoriesLoading } = useApi<Category[]>('/categories/all-categories', { refreshInterval: 120000 });

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
    const [feedbackCode, setFeedbackCode] = useState('');
    const [isFeedbackError, setIsFeedbackError] = useState(false);

    useEffect(() => {
        if (feedbackCode) {
            const t = setTimeout(() => setFeedbackCode(''), 1500);
            return () => clearTimeout(t);
        }
    }, [feedbackCode]);
    
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
    const [isDeleteCartConfirmOpen, setIsDeleteCartConfirmOpen] = useState(false);
    const [cartKeyToDelete, setCartKeyToDelete] = useState<string | null>(null);

    // Split Bill State
    const [splitItemsToPay, setSplitItemsToPay] = useState<CartItem[] | null>(null);
    const [remainingItemsAfterSplit, setRemainingItemsAfterSplit] = useState<CartItem[] | null>(null);
    const [originalCustomerDniBeforeSplit, setOriginalCustomerDniBeforeSplit] = useState<string | null>(null);

    // Success State
    const [showSuccessScreen, setShowSuccessScreen] = useState(false);
    const [lastChange, setLastChange] = useState(0);
    const [lastReceipt, setLastReceipt] = useState<any>(null);
    const [scannerBuffer, setScannerBuffer] = useState('');

    // Reset success screen when dialog closes to avoid "lingering" success screen on next sale
    useEffect(() => {
        if (!isPaymentDialogOpen && showSuccessScreen) {
            setShowSuccessScreen(false);
        }
    }, [isPaymentDialogOpen, showSuccessScreen]);

    const playBeep = useCallback((type: 'success' | 'error' = 'success') => {
        if (typeof window === 'undefined') return;
        try {
            const AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
            if (!AudioContext) return;
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(type === 'success' ? 880 : 220, ctx.currentTime);
            
            gain.gain.setValueAtTime(0.4, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.start();
            osc.stop(ctx.currentTime + 0.1);
        } catch (e) {
            console.error("Audio error", e);
        }
    }, []);

    // Ultra-Instinto: Web Worker & Offline DB
    const workerRef = useRef<Worker | null>(null);
    const [isOffline, setIsOffline] = useState(false);
    const [workerFilteredProducts, setWorkerFilteredProducts] = useState<Product[]>([]);

    const { weight: scaleWeight, isScaleOnline, isReloading: isScaleReloading, reload: reloadScale } = useScale();
    const submittingRef = useRef(false);
    const hiddenScannerRef = useRef<HTMLInputElement>(null);

    // --- LÓGICA DE AUTOREFRESCO DE BÁSCULA (HFT) ---
    const lastWeightRef = useRef(0);
    
    // 1. Detectar transición de 0 a Peso (y viceversa) para limpiar estados
    useEffect(() => {
        if (!isScaleOnline) return;
        
        // Si el peso baja a cero, forzamos una limpieza para evitar "pesos fantasmas"
        if (lastWeightRef.current > 0.002 && scaleWeight <= 0.001) {
            reloadScale();
        }
        
        // Si detectamos un nuevo peso tras estar en cero, aseguramos que la UI esté lista
        if (lastWeightRef.current <= 0.001 && scaleWeight > 0.005) {
            // Pequeño delay para dejar que la balanza se estabilice antes de permitir añadir
            // No bloqueamos, pero lastWeight se actualiza al final
        }
        
        lastWeightRef.current = scaleWeight;
    }, [scaleWeight, isScaleOnline, reloadScale]);

    // 2. Refresco proactivo cada 30 segundos si está en cero
    useEffect(() => {
        const interval = setInterval(() => {
            if (isScaleOnline && scaleWeight <= 0.001 && !isScaleReloading) {
                reloadScale();
            }
        }, 30000);
        return () => clearInterval(interval);
    }, [isScaleOnline, scaleWeight, isScaleReloading, reloadScale]);

    // --- PERSISTENCIA DE CARROS (RECUPERACIÓN POR CORTE DE LUZ / CIERRE) ---
    const isInitialMount = useRef(true);
    
    // 1. Cargar al montar
    useEffect(() => {
        loadCartsFromIndexedDB().then((data) => {
            if (data) {
                // Solo restaurar si hay algo guardado
                if (Object.keys(data.carts).length > 0) {
                    setCarts(data.carts);
                    setCartKeys(Object.keys(data.carts));
                    setActiveCartKey(data.activeKey);
                    setCartCustomers(data.cartCustomers || { 'Factura 1': '0' });
                    setSelectedCustomerDni(data.customerDni);
                    setSelectedItemId(data.selectedItemId);
                }
            }
            setLoading(false);
            isInitialMount.current = false;
        }).catch(err => {
            console.error("Error cargando persistencia:", err);
            setLoading(false);
            isInitialMount.current = false;
        });
    }, []);

    // 2. Guardar cambios (Debounced para performance)
    useEffect(() => {
        if (isInitialMount.current || loading) return;
        
        const timer = setTimeout(() => {
            saveCartsToIndexedDB(carts, activeCartKey, selectedCustomerDni, cartCustomers, selectedItemId);
        }, 1000);
        
        return () => clearTimeout(timer);
    }, [carts, activeCartKey, selectedCustomerDni, cartCustomers, selectedItemId, loading]);

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
        if (Array.isArray(products) && products.length > 0) {
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
    }, [products, customers, categories, searchQuery, selectedCategory]);

    // AUTOMATIZACIÓN: Despertar báscula si se selecciona un producto pesado y está offline
    useEffect(() => {
        if (selectedItemId) {
            const item = (carts[activeCartKey] || []).find(i => i.cartItemId === selectedItemId);
            if (item && isProductWeighted(item) && !isScaleOnline && !isScaleReloading) {
                reloadScale();
            }
        }
    }, [selectedItemId, isScaleOnline, isScaleReloading, activeCartKey, carts, reloadScale]);

    // NUEVO: Sincronizar stock de productos en carritos activos
    useEffect(() => {
        if (Array.isArray(products) && products.length > 0) {
            setCarts(prev => {
                const next = { ...prev };
                Object.keys(next).forEach(key => {
                    if (Array.isArray(next[key])) {
                        next[key] = next[key].map(item => {
                            const latest = Array.isArray(products) ? products.find(p => p.barcode === item.barcode) : null;
                            if (latest && latest.quantity !== item.quantity) {
                                return { ...item, quantity: latest.quantity };
                            }
                            return item;
                        });
                    }
                });
                return next;
            });
        }
    }, [products]);

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
        if (!Array.isArray(items) || items.length === 0) return 0;
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
        if (!Array.isArray(customers)) return [];
        if (!query) return customers;
        return customers.filter(c => 
            (c.name || '').toLowerCase().includes(query) || (c.dni || '').includes(query)
        );
    }, [customers, clientSearch]);

    const sortedCategories = useMemo(() => {
        if (!Array.isArray(categories)) return [];
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
        const items = carts[key] || [];
        if (items.length > 0) {
            setCartKeyToDelete(key);
            setIsDeleteCartConfirmOpen(true);
        } else {
            confirmDeleteCart(key);
        }
    };

    const confirmDeleteCart = (key?: string) => {
        const targetKey = key || cartKeyToDelete;
        if (!targetKey) return;

        const newKeys = cartKeys.filter(k => k !== targetKey); 
        setCartKeys(newKeys);
        setCarts(prev => {
            const next = { ...prev };
            delete next[targetKey];
            return next;
        });
        setCartCustomers(prev => {
            const next = { ...prev };
            delete next[targetKey];
            return next;
        });
        if (activeCartKey === targetKey) handleCartSwitch(newKeys[newKeys.length - 1]);
        setIsDeleteCartConfirmOpen(false);
        setCartKeyToDelete(null);
    };

    const updateQuantity = useCallback((cartItemId: string, delta: number) => {
        setCarts(prev => {
            const current = [...(prev[activeCartKey] || [])];
            const idx = current.findIndex(item => item.cartItemId === cartItemId);
            if (idx === -1) return prev;

            const item = current[idx];
            const newQty = item.cartQuantity + delta;

            if (newQty <= 0) {
                const filtered = current.filter(i => i.cartItemId !== cartItemId);
                if (selectedItemId === cartItemId) setSelectedItemId(null);
                return { ...prev, [activeCartKey]: filtered };
            }

            if (!isProductWeighted(item) && delta > 0 && newQty > item.quantity) {
                toast({ variant: "destructive", title: "SISTEMA", description: `STOCK INSUFICIENTE: SOLO QUEDAN ${item.quantity} UNIDADES` }); 
                return prev;
            }

            current[idx] = { ...current[idx], cartQuantity: newQty };
            return { ...prev, [activeCartKey]: current };
        });
    }, [activeCartKey, selectedItemId, toast]);

    const removeFromCart = useCallback((cartItemId: string) => {
        setCarts(prev => {
            const current = [...(prev[activeCartKey] || [])];
            const filtered = current.filter(item => item.cartItemId !== cartItemId);
            if (selectedItemId === cartItemId) setSelectedItemId(null);
            return { ...prev, [activeCartKey]: filtered };
        }); 
        returnFocusToScanner();
    }, [activeCartKey, selectedItemId, returnFocusToScanner]);

    const setCartItemQuantity = useCallback((cartItemId: string, quantity: number) => {
        setCarts(prev => {
            const current = [...(prev[activeCartKey] || [])];
            const idx = current.findIndex(item => item.cartItemId === cartItemId);
            if (idx === -1) return prev;

            const item = current[idx];
            if (quantity <= 0) {
                const filtered = current.filter(i => i.cartItemId !== cartItemId);
                if (selectedItemId === cartItemId) setSelectedItemId(null);
                return { ...prev, [activeCartKey]: filtered };
            }

            if (!isProductWeighted(item) && quantity > item.quantity) {
                toast({ variant: "destructive", title: "SISTEMA", description: `STOCK INSUFICIENTE: SOLO QUEDAN ${item.quantity} UNIDADES` }); 
                return prev;
            }

            current[idx] = { ...current[idx], cartQuantity: quantity };
            return { ...prev, [activeCartKey]: current };
        });
    }, [activeCartKey, selectedItemId, toast]);

    const addMiscItem = useCallback((priceStr: string) => {
        if (scaleWeight < 0) {
            toast({ variant: "destructive", title: "GRAMERA", description: "⚠️ Ponga la gramera en 0 o positivo" });
            return;
        }
        const price = parseFloat(priceStr);
        if (isNaN(price) || price <= 0) return;
        const cartItemId = `0000-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
        const miscProduct: CartItem = { 
            barcode: '0000', 
            cartItemId: cartItemId,
            productName: `VENTA RÁPIDA ($${price.toLocaleString()})`, 
            salePrice: price, 
            quantity: 999999, 
            purchasePrice: price * 0.8, // 20% de Rentabilidad
            marginPercentage: 20, 
            categoryId: 0, 
            isWeighted: false,
            cartQuantity: 1
        };
        setCarts(prev => {
            const current = [...(prev[activeCartKey] || [])];
            current.push(miscProduct);
            return { ...prev, [activeCartKey]: current };
        });
        setSelectedItemId(cartItemId); 
        setSearchQuery(''); 
        setScannerBuffer('');
        setFeedbackCode('0000'); // Triggers beep
        setIsFeedbackError(false);
        toast({ variant: "success", title: "ÉXITO", description: "VENTA RÁPIDA AGREGADA" }); 
        returnFocusToScanner();
    }, [activeCartKey, toast, returnFocusToScanner, setSearchQuery, setScannerBuffer]);

    const addToCart = useCallback(async (p: Product) => {
        if (isProductWeighted(p)) {
            // Forzar un refresco inmediato para asegurar que no capturamos el peso del ítem anterior
            reloadScale();
            await new Promise(resolve => setTimeout(resolve, 150)); // Pequeña espera para sincronización de WebSocket
        }

        if (scaleWeight < -0.0001) {
            toast({ variant: "destructive", title: "GRAMERA", description: "⚠️ Ponga la gramera en 0 o positivo" });
            return;
        }

        if (p.quantity <= 0 && !isProductWeighted(p)) { 
            toast({ variant: "destructive", title: "SISTEMA", description: "SIN STOCK" }); 
            setSearchQuery(''); 
            return; 
        }

        if (isProductWeighted(p)) {
            if (isScaleReloading) {
                toast({ variant: "destructive", title: "BÁSCULA RECARGANDO", description: "ESPERE UN MOMENTO PARA CAPTURAR EL NUEVO PESO..." });
                return;
            }
            if (isScaleOnline && scaleWeight < -0.0001) {
                toast({ variant: "destructive", title: "ERROR DE BÁSCULA", description: "PESO NEGATIVO DETECTADO. AJUSTE LA GRAMERA." });
                return;
            }
            // CAPTURA DIRECTA: No usamos el estado de React aquí porque puede estar stale en una función async
            const freshWeight = ScaleBridge.getInstance().getState().weight;

            if (freshWeight >= 0.0001 && isScaleOnline) {
                setCarts(prev => {
                    const current = [...(prev[activeCartKey] || [])];
                    const idx = current.findIndex(item => item.cartItemId === p.barcode);
                    if (idx > -1) current[idx] = { ...current[idx], cartQuantity: current[idx].cartQuantity + freshWeight }; 
                    else current.push({ ...p, cartQuantity: freshWeight, cartItemId: p.barcode });
                    return { ...prev, [activeCartKey]: current };
                }); 
                setSelectedItemId(p.barcode); 
                setSearchQuery(''); 
                returnFocusToScanner(); 
                return;
            }
            setManualWeightProduct(p); 
            setIsManualWeightOpen(true); 
            setSearchQuery(''); 
            return;
        }

        setCarts(prev => {
            const current = [...(prev[activeCartKey] || [])];
            const idx = current.findIndex(item => item.cartItemId === p.barcode);
            
            if (idx > -1) {
                // Check stock inside the functional update
                if (current[idx].cartQuantity >= p.quantity) {
                    toast({ variant: "destructive", title: "SISTEMA", description: `MÁXIMO ALCANZADO: ${p.quantity} DISPONIBLES` });
                    return prev;
                }
                current[idx] = { ...current[idx], cartQuantity: current[idx].cartQuantity + 1 };
            } else {
                current.push({ ...p, cartQuantity: 1, cartItemId: p.barcode });
            }
            return { ...prev, [activeCartKey]: current };
        }); 
        
        setSelectedItemId(p.barcode); 
        setSearchQuery(''); 
        setScannerBuffer('');
        returnFocusToScanner();
    }, [activeCartKey, scaleWeight, isScaleOnline, returnFocusToScanner, toast, setSearchQuery, setScannerBuffer]);

    const handleCodeSubmit = useCallback((code: string) => {
        let finalCode = code.trim();
        let qty = 1;

        // 1. DETECCIÓN DE ETIQUETAS DE BALANZA (EAN-13 Prefijos 20, 21, 22, 23)
        // Estándar: 20PPPPP VVVVV C (20 + 5 dígitos producto + 5 dígitos valor + 1 check)
        // 1. DETECCIÓN DE ETIQUETAS DE BALANZA (EAN-13 Prefijos 20, 21, 22, 23)
        // Estándar: 20PPPPP VVVVV C (20 + 5 dígitos producto + 5 dígitos valor + 1 check)
        if (finalCode.length === 13 && (finalCode.startsWith('20') || finalCode.startsWith('21') || finalCode.startsWith('22') || finalCode.startsWith('23'))) {
            const productPart = finalCode.substring(2, 7); // Los 5 dígitos del producto
            const valuePart = finalCode.substring(7, 12);   // Los 5 dígitos del valor (precio total)
            
            // Buscamos un producto que COMIENCE con esos 5 dígitos o coincida exactamente
            // Muchas veces en la BD el código está como "20001" o simplemente "1"
            const p = products.find(x => {
                const isMatch = x.barcode === productPart || 
                              x.barcode === `20${productPart}` || 
                              x.barcode === `21${productPart}` ||
                              x.barcode.endsWith(productPart);
                
                if (isMatch) return true;

                // También buscamos en códigos alternativos
                if (x.alternateCodes) {
                    const altCodes = x.alternateCodes.split(',').map(c => c.trim().toUpperCase());
                    return altCodes.some(ac => 
                        ac === productPart || 
                        ac === `20${productPart}` || 
                        ac.endsWith(productPart)
                    );
                }
                return false;
            });

            if (p && isProductWeighted(p)) {
                const totalPrice = parseInt(valuePart) / 100; // El estándar suele ser 2 decimales para el precio
                const unitPrice = Number(p.salePrice);
                
                if (unitPrice > 0) {
                    const calculatedWeight = totalPrice / unitPrice;
                    setCarts(prev => {
                        const current = [...(prev[activeCartKey] || [])];
                        const cartItemId = `${p.barcode}-${Date.now()}`;
                        current.push({ ...p, cartQuantity: calculatedWeight, cartItemId });
                        return { ...prev, [activeCartKey]: current };
                    });
                    setFeedbackCode(p.barcode);
                    setIsFeedbackError(false);
                    setScannerBuffer('');
                    setSearchQuery('');
                    toast({ variant: "success", title: "BALANZA", description: `${p.productName}: ${calculatedWeight.toFixed(3)}kg añadidos` });
                    returnFocusToScanner();
                    return;
                }
            }
        }

        // 2. LÓGICA DE MULTIPLICADOR (Ej: 5*770)
        if (finalCode.includes('*')) {
            const parts = finalCode.split('*');
            if (parts.length === 2) {
                const q = parseFloat(parts[0]);
                if (!isNaN(q) && q > 0) { qty = q; finalCode = parts[1].trim(); }
            }
        }

        if (!finalCode) return;

        // 3. BÚSQUEDA DEL PRODUCTO (Código Principal + Códigos Alternativos)
        const p = products.find(x => {
            const isPrimaryMatch = x.barcode.toUpperCase() === finalCode.toUpperCase();
            if (isPrimaryMatch) return true;

            // Si no coincide el principal, buscamos en la lista de alternativos
            if (x.alternateCodes) {
                const altCodes = x.alternateCodes.split(',').map(c => c.trim().toUpperCase());
                return altCodes.includes(finalCode.toUpperCase());
            }

            return false;
        });

        if (p) {
            if (isProductWeighted(p) && qty === 1) {
                // Si es pesado y no trae cantidad manual, abrimos pesaje
                addToCart(p);
            } else {
                for (let i = 0; i < qty; i++) addToCart(p);
            }
            setFeedbackCode(finalCode); setIsFeedbackError(false); setSearchQuery('');
        } else {
            setFeedbackCode(finalCode); 
            setIsFeedbackError(true); 
            toast({ variant: "destructive", title: "SISTEMA", description: `CÓDIGO ${finalCode} NO ENCONTRADO` });
        }
        setScannerBuffer('');
        setSearchQuery('');
        returnFocusToScanner();
    }, [products, activeCartKey, addToCart, toast, returnFocusToScanner, setScannerBuffer]);

    const handleScaleSync = useCallback(() => {
        if (!isScaleOnline || isScaleReloading) return;
        
        if (!selectedItemId) {
            reloadScale();
            toast({ variant: "default", title: "BÁSCULA", description: "RECARGANDO LECTURA..." });
            return;
        }
        
        const item = currentCart.find(i => i.barcode === selectedItemId);
        if (item && isProductWeighted(item)) {
            if (scaleWeight < 0.005) {
                toast({ variant: "destructive", title: "SIN PESO", description: "COLOQUE EL PRODUCTO EN LA GRAMERA" });
                return;
            }
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
    }, [isScaleOnline, isScaleReloading, scaleWeight, selectedItemId, activeCartKey, currentCart, toast, reloadScale]);

    const handleConfirmSale = async (paymentData: {
        cash: number;
        transfer: number;
        transferSource: string;
        credit: number;
        totalPaid: number;
        change: number;
    }) => {
        if (submitting || submittingRef.current) return;
        if (currentCart.length === 0 && !splitItemsToPay) return;
        const itemsToPay = splitItemsToPay || currentCart;

        submittingRef.current = true;
        setSubmitting(true);
        const token = Cookies.get('org-pos-token');
        const { cash, transfer, transferSource, credit, totalPaid, change } = paymentData;

        // --- INTELIGENCIA DE CATEGORIZACIÓN (Sin "MIXTO") ---
        const paymentMethods: string[] = [];
        if (cash > 0) paymentMethods.push("EFECTIVO");
        if (transfer > 0) paymentMethods.push(transferSource?.toUpperCase() || "TRANSFERENCIA");
        if (credit > 0) paymentMethods.push("FIADO");
        
        // Si no hay montos (error?), default a EFECTIVO
        const paymentMethod = paymentMethods.length > 0 ? paymentMethods.join(" + ") : "EFECTIVO";

        const localTotal = itemsToPay.reduce((acc, item) => acc + applyRounding(Number(item.salePrice) * item.cartQuantity), 0);

        if (localTotal > 100000000 || totalPaid > 100000000) {
            toast({ variant: "destructive", title: "ERROR DE MONTO", description: "EL VALOR ES DEMASIADO GRANDE" });
            setSubmitting(false);
            return;
        }

        const saleData = {
            clientDni: selectedCustomerDni,
            employeeDni: "ADMIN",
            paymentMethod: paymentMethod,
            total: localTotal,
            amountPaid: totalPaid,
            cashAmount: cash,
            transferAmount: transfer,
            transferSource: transfer > 0 ? transferSource : '',
            creditAmount: credit,
            change: change,
            details: itemsToPay.map(item => {
                const qty = Number(item.cartQuantity) || 0;
                const price = Number(item.salePrice) || 0;
                const cost = Number(item.purchasePrice || 0);
                return {
                    barcode: item.barcode, 
                    quantity: qty, 
                    unitPrice: price, 
                    costPrice: cost,
                    subtotal: applyRounding(price * qty)
                };
            })
        };

        try {
            if (credit > 0 && (selectedCustomerDni === '0' || !selectedCustomerDni)) {
                toast({ variant: "destructive", title: "ERROR DE CRÉDITO", description: "DEBE SELECCIONAR UN CLIENTE PARA FIAR" });
                setSubmitting(false);
                return;
            }

            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/sales/register`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify(saleData)
            });

            if (res.ok) {
                toast({ variant: 'success', title: 'VENTA REGISTRADA', description: 'TRANSACCIÓN COMPLETADA CON ÉXITO' });
                finalizeLocalSale(itemsToPay, saleData, change);
                if (reloadScale) reloadScale();
            } else {
                // ERROR DEL SERVIDOR: No vamos a offline porque es un error de validación (ej: falta cupo)
                const errorMsg = await extractApiError(res, "ERROR AL REGISTRAR VENTA");
                toast({ variant: "destructive", title: "ERROR DEL SERVIDOR", description: errorMsg });
                setSubmitting(false);
                return;
            }
        } catch (err: any) {
            // ERROR DE RED: Solo aquí activamos el modo offline (Ultra-Instinto)
            const isNetworkError = err instanceof TypeError || err.name === 'TypeError' || err.message?.includes('fetch');
            
            if (isNetworkError) {
                const { queueOfflineSale } = await import('@/lib/offline-db');
                await queueOfflineSale(saleData);
                
                toast({ 
                    variant: "default", 
                    title: "MODO OFFLINE", 
                    description: "FALLO DE RED. VENTA GUARDADA LOCALMENTE PARA SINCRONIZACIÓN POSTERIOR." 
                });
                
                finalizeLocalSale(itemsToPay, saleData, change);
            } else {
                toast({ variant: "destructive", title: "ERROR INESPERADO", description: err.message || "CONSULTE AL ADMINISTRADOR" });
                setSubmitting(false);
            }
            } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    };

    const finalizeLocalSale = (itemsToPay: any[], saleData: any, change: number) => {
        setLastChange(change);
        setShowSuccessScreen(true);
        reloadScale(); // RECARGAR BASCULA PARA EVITAR PESO STALE
        mutateProducts(); // Sincronizar stock inmediatamente tras venta
        if (remainingItemsAfterSplit) {
            setCarts(prev => ({ ...prev, [activeCartKey]: remainingItemsAfterSplit }));
            setRemainingItemsAfterSplit(null); setSplitItemsToPay(null);
            if (originalCustomerDniBeforeSplit) {
                handleClientSelect(originalCustomerDniBeforeSplit);
                setOriginalCustomerDniBeforeSplit(null);
            }
        } else {
            setCarts(prev => ({ ...prev, [activeCartKey]: [] })); 
            handleClientSelect('0');
            // REGRESO AUTOMÁTICO A F1: Como pidió el usuario, tras vender volvemos a la primera factura
            handleCartSwitch('Factura 1');
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
        
        // Notificar a otras pestañas que se hizo una venta (para actualizar stock y dashboard)
        broadcastRevalidate('SALE_MADE');
    };

    const confirmManualWeight = () => {
        const weight = parseFloat(manualWeightValue.replace(',', '.'));
        if (isNaN(weight) || weight <= 0.0001) { toast({ variant: "destructive", title: "ERROR", description: "PESO INVÁLIDO" }); return; }
        if (manualWeightProduct) {
            setCarts(prev => {
                const current = [...(prev[activeCartKey] || [])];
                const idx = current.findIndex(item => item.barcode === manualWeightProduct.barcode);
                if (idx > -1) current[idx] = { ...current[idx], cartQuantity: current[idx].cartQuantity + weight };
                else current.push({ ...manualWeightProduct, cartQuantity: weight, cartItemId: manualWeightProduct.barcode });
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
            playBeep(isFeedbackError ? 'error' : 'success');
            const t = setTimeout(() => { setFeedbackCode(''); setIsFeedbackError(false); }, 1500);
            return () => clearTimeout(t);
        }
    }, [feedbackCode, isFeedbackError, playBeep]);

    // Sincronizar datos de SWR a estados locales y Offline DB
    useEffect(() => {
        if (Array.isArray(productsData)) setProducts(productsData);
        
        if (Array.isArray(customersData)) {
            // Solo sobreescribimos si trae datos o si el estado actual está vacío.
            // Esto evita que un error de carga momentáneo limpie la lista de clientes.
            if (customersData.length > 0) {
                setCustomers(customersData);
            } else if (customers.length === 0) {
                // Si no hay nada, al menos permitimos que el estado sea el array vacío
                setCustomers([]);
            }
        }
        
        if (Array.isArray(categoriesData)) setCategories(categoriesData);
    }, [productsData, customersData, categoriesData, customers.length]);


    return {
        // Data
        products, customers, categories: sortedCategories,
        currentCart: sortedCart, activeCartKey, cartKeys, cartCustomers,
        selectedCustomer, selectedCustomerDni,
        
        // Computed
        total, filteredProductsGrid, filteredCustomers,
        
        // UI State
        loading: loading || ((products.length === 0 || categories.length === 0) && (productsLoading || categoriesLoading)), 
        submitting, searchQuery, setSearchQuery,
        selectedCategory, setSelectedCategory,
        selectedItemId, setSelectedItemId,
        feedbackCode, isFeedbackError,
        isOffline, // Exportamos estado de red
        
        // Modal States
        isPaymentDialogOpen, setIsPaymentDialogOpen,
        isClientDialogOpen, setIsClientDialogOpen,
        clientSearch, setClientSearch,
        isScannerOpen, setIsScannerOpen,
        isManualWeightOpen, setIsManualWeightOpen,
        scannerBuffer, setScannerBuffer,
        manualWeightProduct, manualWeightValue, setManualWeightValue,
        isSplitDialogOpen, setIsSplitDialogOpen,
        isCartDropdownOpen, setIsCartDropdownOpen,
        isMissingItemOpen, setIsMissingItemOpen,
        isDeleteCartConfirmOpen, setIsDeleteCartConfirmOpen,
        cartKeyToDelete,
        
        // Split State
        splitItemsToPay, setSplitItemsToPay,
        remainingItemsAfterSplit, setRemainingItemsAfterSplit,
        setOriginalCustomerDniBeforeSplit,
        
        // Results
        showSuccessScreen, setShowSuccessScreen,
        lastChange, lastReceipt,
        
        // Helpers & Refs
        playBeep,
        hiddenScannerRef, returnFocusToScanner,
        scaleWeight, isScaleOnline, isScaleReloading, reloadScale,
        
        // Handlers
        handleCartSwitch, handleClientSelect, addNewCart, deleteCart, confirmDeleteCart,
        updateQuantity, removeFromCart, addToCart, addMiscItem, setCartItemQuantity,
        handleCodeSubmit, handleScaleSync, handleConfirmSale, confirmManualWeight
    };
}
