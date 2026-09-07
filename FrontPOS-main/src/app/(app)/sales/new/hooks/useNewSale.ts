import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/hooks/use-toast';
import { Product, Customer, Category } from '@/lib/definitions';
import { applyRounding, isProductWeighted, formatDateTime, normalizeText, roundSaleLineSubtotal } from "@/lib/utils";
import { ScaleBridge } from '@/lib/scaleBridge';
import { useScale } from '@/hooks/useScale';
import { saveCartsToIndexedDB, loadCartsFromIndexedDB } from '@/lib/cartStorage';
import { ApiError, apiFetch } from '@/lib/api-error';
import { useApi } from '@/hooks/use-api';
import { broadcastRevalidate, setupSyncListener } from '@/lib/revalidate';
import { registerAuditLog } from '@/lib/audit-service';
import { syncOfflineSalesQueue } from '@/lib/offline-sync';
import { isSoundMuted } from '@/lib/audio-utils';
import { useAuth } from '@/lib/auth';
import {
    buildEditItemsPayload,
    buildStockAdjustmentMap,
    computeEditDeltaTotal,
    getEditMode,
    hasEditChanges,
} from '@/lib/sales-edit-helpers.mjs';

export interface CartItem extends Product {
    cartQuantity: number;
    cartItemId: string; // ID unico para React keys
    originalQuantity?: number;
    isPreexisting?: boolean;
}

export function useNewSale() {
    const router = useRouter();
    const { toast } = useToast();
    const { user } = useAuth();
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);

    // Core Data (Auto-refreshing via SWR)
    // Los cambios reales llegan por SSE (PRODUCT_UPDATE, STOCK_UPDATE...), asi que
    // el sondeo periodico solo es una red de seguridad. Bajarlo evita descargar el
    // catalogo completo cada minuto, que en celular se sentia lento.
    const { data: productsData, mutate: mutateProducts, isLoading: productsLoading, error: productsError } = useApi<Product[]>('/products/all-products', { 
        refreshInterval: 300000, // 5 min
        revalidateOnFocus: true 
    });
    const { data: customersData, mutate: mutateCustomers, isLoading: customersLoading } = useApi<Customer[]>('/clients/all-clients', { refreshInterval: 300000 });
    const { data: categoriesData, mutate: mutateCategories, isLoading: categoriesLoading } = useApi<Category[]>('/categories/all-categories', { refreshInterval: 600000 });

    const [products, setProducts] = useState<Product[]>([]);
    const [customers, setCustomers] = useState<Customer[]>([]);
    const [categories, setCategories] = useState<Category[]>([]);

    // --- OPTIMIZACION DE RENDIMIENTO (Busqueda O(1)) ---
    const productMap = useMemo(() => {
        const map = new Map<string, Product>();
        products.forEach(p => map.set(p.barcode, p));
        return map;
    }, [products]);

    // Cart Management
    const [carts, setCarts] = useState<Record<string, CartItem[]>>({ 'Factura 1': [] });
    const [cartKeys, setCartKeys] = useState<string[]>(['Factura 1']);
    const [activeCartKey, setActiveCartKey] = useState('Factura 1');
    const activeCartKeyRef = useRef(activeCartKey);

    // Sincronizar referencia para funciones asincronas
    useEffect(() => {
        activeCartKeyRef.current = activeCartKey;
    }, [activeCartKey]);

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
        if (isSoundMuted()) return;
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
    const [syncQueueCount, setSyncQueueCount] = useState(0);
    const [workerFilteredProducts, setWorkerFilteredProducts] = useState<Product[]>([]);

    const { weight: scaleWeight, isScaleOnline, isReloading: isScaleReloading, reload: reloadScale } = useScale();
    const submittingRef = useRef(false);
    const hiddenScannerRef = useRef<HTMLInputElement>(null);

    // --- LOGICA DE AUTOREFRESCO DE BASCULA (HFT) ---
    const lastWeightRef = useRef(0);
    
    // 1. Detectar transicion de 0 a Peso (y viceversa) para limpiar estados
    useEffect(() => {
        if (!isScaleOnline) return;
        
        // Si detectamos un nuevo peso tras estar en cero, aseguramos que la UI este lista
        if (lastWeightRef.current <= 0.001 && scaleWeight > 0.005) {
            // Flujo normal de peso
        }
        
        lastWeightRef.current = scaleWeight;
    }, [scaleWeight, isScaleOnline, reloadScale]);

    // 2. Refresco proactivo cada 30 segundos si esta en cero.
    // Las pestañas ocultas no deben mantener activo el bridge de la bascula.
    useEffect(() => {
        const interval = setInterval(() => {
            if (document.visibilityState !== 'visible') return;
            if (isScaleOnline && scaleWeight <= 0.001 && !isScaleReloading) {
                reloadScale();
            }
        }, 30000);
        return () => clearInterval(interval);
    }, [isScaleOnline, scaleWeight, isScaleReloading, reloadScale]);
    
    // --- GUARDIAN DE FOCO (SCANNER GUARDIAN) ---
    // Asegura que el foco siempre regrese al escaner oculto si no hay un modal abierto.
    useEffect(() => {
        const interval = setInterval(() => {
            if (typeof window === 'undefined' || document.visibilityState !== 'visible') return;
            
            const target = document.activeElement as HTMLElement;
            const isRealInput = (
                target?.tagName === 'INPUT' || 
                target?.tagName === 'TEXTAREA' || 
                target?.closest('button') ||
                target?.closest('[role="dialog"]') ||
                target?.closest('.heroui-modal')
            ) && !target.classList.contains('scanner-gate');

            const isAnyModalOpen = isPaymentDialogOpen || isClientDialogOpen || isScannerOpen || isManualWeightOpen || isSplitDialogOpen || isMissingItemOpen;

            if (!isRealInput && !isAnyModalOpen && hiddenScannerRef.current) {
                hiddenScannerRef.current.focus();
            }
        }, 500);
        
        return () => clearInterval(interval);
    }, [isPaymentDialogOpen, isClientDialogOpen, isScannerOpen, isManualWeightOpen, isSplitDialogOpen, isMissingItemOpen]);

    // --- PERSISTENCIA DE CARROS (RECUPERACION POR CORTE DE LUZ / CIERRE) ---
    const isInitialMount = useRef(true);
    
    // 1. Cargar al montar
    useEffect(() => {
        if (!user?.dni) return;
        let cancelled = false;
        isInitialMount.current = true;
        loadCartsFromIndexedDB(user.dni).then((data) => {
            if (cancelled) return;
            if (data && Object.keys(data.carts).length > 0) {
                setCarts(data.carts);
                setCartKeys(Object.keys(data.carts));
                setActiveCartKey(data.activeKey);
                setCartCustomers(data.cartCustomers || { 'Factura 1': '0' });
                setSelectedCustomerDni(data.customerDni);
                setSelectedItemId(data.selectedItemId);
            }
            setLoading(false);
            isInitialMount.current = false;
        }).catch(err => {
            if (cancelled) return;
            console.error("Error cargando persistencia:", err);
            setLoading(false);
            isInitialMount.current = false;
        });
        return () => { cancelled = true; };
    }, [user?.dni]);

    // --- SINCRONIZACION EN TIEMPO REAL ---
    // Escuchar actualizaciones de otros paneles (Productos, Categorias, etc)
    useEffect(() => {
        const cleanup = setupSyncListener((event) => {
            if (event === 'PRODUCT_UPDATE' || event === 'CATEGORY_UPDATE' || event === 'STOCK_UPDATE' || event === 'DASHBOARD_UPDATE' || event === 'SALE_MADE' || event === 'INVENTORY_UPDATE') {
                // DEBOUNCE HFT: Evita flickering visual entre la mutacion optimista local y el re-fetch del server
                setTimeout(() => {
                    mutateProducts();
                }, 800);
            }
            if (event === 'CATEGORY_UPDATE' || event === 'DASHBOARD_UPDATE') {
                mutateCategories();
            }
            if (event === 'CUSTOMER_UPDATE' || event === 'DASHBOARD_UPDATE') {
                mutateCustomers();
            }
        });
        return cleanup;
    }, [mutateProducts, mutateCategories, mutateCustomers]);

    // 2. Guardar cambios (Debounced para performance)
    useEffect(() => {
        if (isInitialMount.current || loading || !user?.dni) return;
        
        const timer = setTimeout(() => {
            void saveCartsToIndexedDB(carts, activeCartKey, selectedCustomerDni, cartCustomers, selectedItemId, user.dni);
        }, 1000);
        
        return () => clearTimeout(timer);
    }, [carts, activeCartKey, selectedCustomerDni, cartCustomers, selectedItemId, loading, user?.dni]);
    // Auto-select last item in cart if nothing is selected
    useEffect(() => {
        const currentCart = carts[activeCartKey] || [];
        if (currentCart.length > 0 && !selectedItemId) {
            setSelectedItemId(currentCart[currentCart.length - 1].cartItemId);
        }
    }, [carts, activeCartKey, selectedItemId]);

    // Initializing Web Worker
    useEffect(() => {
        workerRef.current = new Worker(new URL('../../../../../workers/saleWorker.ts', import.meta.url));
        
        workerRef.current.onmessage = (e) => {
            const { type, payload } = e.data;
            if (type === 'FILTERED_PRODUCTS') {
                setWorkerFilteredProducts(payload);
            }
        };

        const handleOnline = () => { setIsOffline(false); void syncOfflineQueue(); };
        const handleOffline = () => { setIsOffline(true); };

        setIsOffline(!navigator.onLine);
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        return () => {
            workerRef.current?.terminate();
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    // 1. Sincronizar catalogo maestro con el Worker y DB Offline (Solo cuando el catalogo cambia)
    useEffect(() => {
        if (products.length > 0) {
            workerRef.current?.postMessage({
                type: 'SET_PRODUCTS',
                payload: products
            });
            workerRef.current?.postMessage({ 
                type: 'UPDATE_SEARCH', 
                payload: { query: searchQuery, category: selectedCategory } 
            });
        }
    }, [products]);



    // 2. Actualizar busqueda (Sin reenviar todo el catalogo)
    useEffect(() => {
        // Debounce 250ms: balance entre responsividad percibida y carga del
        // worker. Antes era 50ms, lo que saturaba el thread cuando el cajero
        // teclea/escanea rapido (cada keystroke disparaba un mensaje al worker).
        // 250ms se siente "instantaneo" para el usuario y reduce ~5x los
        // mensajes en escritura veloz.
        const timer = setTimeout(() => {
            workerRef.current?.postMessage({ 
                type: 'UPDATE_SEARCH', 
                payload: { query: searchQuery, category: selectedCategory } 
            });
        }, 250);
        
        return () => clearTimeout(timer);
    }, [searchQuery, selectedCategory]);

    // AUTOMATIZACION: Despertar bascula si se selecciona un producto pesado y esta offline
    useEffect(() => {
        if (selectedItemId) {
            const item = (carts[activeCartKey] || []).find(i => i.cartItemId === selectedItemId);
            if (item && isProductWeighted(item) && !isScaleOnline && !isScaleReloading) {
                reloadScale();
            }
        }
    }, [selectedItemId, isScaleOnline, isScaleReloading, activeCartKey, carts, reloadScale]);

    // NUEVO: Sincronizar stock y precios de productos en carritos activos
    useEffect(() => {
        if (Array.isArray(products) && products.length > 0) {
            setCarts(prev => {
                const next = { ...prev };
                let totalCartsChanged = false;

                Object.keys(next).forEach(key => {
                    if (Array.isArray(next[key])) {
                        let cartChanged = false;
                        const updatedCart = next[key].map(item => {
                            // BLINDAJE: Ignorar productos de Venta Rapida (Codigo 0000)
                            if (item.barcode === '0000') return item;

                            const latest = productMap.get(item.barcode);
                            if (latest) {
                                const priceChanged = Number(latest.salePrice) !== Number(item.salePrice);
                                const stockChanged = latest.quantity !== item.quantity;
                                if (priceChanged || stockChanged) {
                                    cartChanged = true;
                                    totalCartsChanged = true;
                                    return { ...item, quantity: latest.quantity, salePrice: latest.salePrice };
                                }
                            }
                            return item;
                        });
                        
                        if (cartChanged) {
                            next[key] = updatedCart;
                        }
                    }
                });

                return totalCartsChanged ? next : prev;
            });
        }
    }, [products, productMap]);

    const syncOfflineQueue = async () => {
        const result = await syncOfflineSalesQueue();
        setSyncQueueCount(result.remaining);

        if (result.succeeded > 0) {
            toast({
                variant: "success",
                title: "SINCRO COMPLETA",
                description: `${result.succeeded} VENTAS SUBIDAS AL SERVIDOR`,
            });
        }
    };

    // Actualizar conteo de cola al montar y cada vez que cambia el estado offline
    useEffect(() => {
        const updateCount = async () => {
            const { getSyncQueue } = await import('@/lib/offline-db');
            const queue = await getSyncQueue();
            setSyncQueueCount(queue.length);
        };
        updateCount();
    }, [isOffline]);

    // Computed Values (Optimized via useMemo)
    const currentCart = useMemo(() => carts[activeCartKey] || [], [carts, activeCartKey]);

    // Auto-seleccionar el ultimo producto registrado al cambiar de factura o modificar el carrito
    useEffect(() => {
        const cart = carts[activeCartKey] || [];
        if (cart.length > 0) {
            const isSelectedValid = selectedItemId && cart.some(i => i.cartItemId === selectedItemId);
            if (!isSelectedValid) {
                const lastItem = cart[cart.length - 1];
                setSelectedItemId(lastItem.cartItemId);
            }
        } else {
            setSelectedItemId(null);
        }
    }, [activeCartKey, carts]);

    const sortedCart = useMemo(() => {
        return [...currentCart];
    }, [currentCart]);

    const isEditMode = activeCartKey.startsWith('Factura EDIT-');

    // Total FIRMADO del cambio en modo edición. Positivo = cobro adicional;
    // Negativo = devolución/ajuste; Cero con `editHasChanges=true` = mezcla
    // neutral (se sustituyeron productos por el mismo valor). Se calcula
    // sobre el carrito o sobre los items del split si el usuario dividió.
    const editDeltaTotal = useMemo(() => {
        if (!isEditMode) return 0;
        const items = splitItemsToPay || currentCart;
        return computeEditDeltaTotal(items);
    }, [splitItemsToPay, currentCart, isEditMode]);

    const editHasChanges = useMemo(() => {
        if (!isEditMode) return false;
        const items = splitItemsToPay || currentCart;
        return hasEditChanges(items);
    }, [splitItemsToPay, currentCart, isEditMode]);

    const editMode = useMemo<'no-changes' | 'charge' | 'refund' | 'neutral'>(() => {
        if (!isEditMode) return 'no-changes';
        const items = splitItemsToPay || currentCart;
        return getEditMode(items);
    }, [splitItemsToPay, currentCart, isEditMode]);

    // Alias legacy conservado para no romper llamadores externos (page.tsx
    // aún consume `extraTotal`). Ahora es firmado.
    const extraTotal = editDeltaTotal;

    const total = useMemo(() => {
        const items = splitItemsToPay || currentCart;
        if (!Array.isArray(items) || items.length === 0) return 0;
        return items.reduce((sum, item) => {
            const price = Number(item.salePrice) || 0;
            return sum + roundSaleLineSubtotal(price, item.cartQuantity);
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

    // El grid viene del Worker con Fallback al hilo principal para maxima resiliencia
    const filteredProductsGrid = useMemo(() => {
        if (workerFilteredProducts.length > 0) {
            return workerFilteredProducts;
        }
        if (!products || !Array.isArray(products) || products.length === 0) return [];
        
        const query = searchQuery.toLowerCase().trim();
        const categoryFilter = selectedCategory;

        return products.filter(p => {
            const matchesCategory = categoryFilter === 'all' || String(p.categoryId) === categoryFilter;
            if (!matchesCategory) return false;
            if (!query) return true;

            const nameMatch = (p.productName || '').toLowerCase().includes(query);
            const barcodeMatch = (p.barcode || '').toLowerCase().includes(query);
            const altCodesMatch = (p.alternateCodes || '').toLowerCase().includes(query);
            
            return nameMatch || barcodeMatch || altCodesMatch;
        }).sort((a, b) => (a.productName || '').localeCompare(b.productName || ''));
    }, [workerFilteredProducts, products, searchQuery, selectedCategory]);

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
        activeCartKeyRef.current = key; // Blindaje inmediato
        setSelectedCustomerDni(cartCustomers[key] || '0'); 
        
        // Al cambiar de factura, refrescamos la bascula por si acaso
        reloadScale();
        
        setTimeout(returnFocusToScanner, 50);
    }, [cartCustomers, returnFocusToScanner, reloadScale]);

    const handleClientSelect = (dni: string) => { 
        setSelectedCustomerDni(dni); 
        const currentKey = activeCartKeyRef.current;
        setCartCustomers(prev => ({ ...prev, [currentKey]: dni })); 
    };

    const addNewCart = () => {
        // Generar el siguiente numero disponible buscando el primer hueco
        let nextNum = 1;
        while (cartKeys.includes(`Factura ${nextNum}`)) {
            nextNum++;
        }
        
        const newKey = `Factura ${nextNum}`;
        setCartKeys(prev => [...prev, newKey]); 
        setCarts(prev => ({ ...prev, [newKey]: [] })); 
        setCartCustomers(prev => ({ ...prev, [newKey]: '0' })); 
        handleCartSwitch(newKey);
        
        // Proactivamente refrescar bascula al crear factura nueva
        reloadScale();
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

        // LOG DE AUDITORIA: Eliminacion de factura completa
        registerAuditLog('CART_CLEAR', 'VENTAS', `Factura eliminada: ${targetKey}. Tenia productos registrados.`, true);
    };

    const updateQuantity = useCallback((cartItemId: string, delta: number) => {
        setCarts(prev => {
            const currentKey = activeCartKeyRef.current;
            const current = [...(prev[currentKey] || [])];
            const idx = current.findIndex(item => item.cartItemId === cartItemId);
            if (idx === -1) return prev;

            const item = current[idx];
            const newQty = item.cartQuantity + delta;

            if (newQty <= 0) {
                // Los items pre-existentes (edición desde historial) NO se
                // eliminan al llegar a 0: conservan `originalQuantity` para
                // producir el delta negativo (-original) al enviar. Los
                // items nuevos SÍ se eliminan porque su delta es 0.
                if (item.isPreexisting) {
                    current[idx] = { ...item, cartQuantity: 0 };
                    return { ...prev, [currentKey]: current };
                }
                const filtered = current.filter(i => i.cartItemId !== cartItemId);
                if (selectedItemId === cartItemId) setSelectedItemId(null);
                return { ...prev, [currentKey]: filtered };
            }

            current[idx] = { ...current[idx], cartQuantity: newQty };
            return { ...prev, [currentKey]: current };
        });
    }, [selectedItemId, toast]);

    const removeFromCart = useCallback((cartItemId: string) => {
        setCarts(prev => {
            const currentKey = activeCartKeyRef.current;
            const current = [...(prev[currentKey] || [])];
            const itemToRemove = current.find(item => item.cartItemId === cartItemId);
            const filtered = current.filter(item => item.cartItemId !== cartItemId);
            
            if (itemToRemove) {
                registerAuditLog('CART_ITEM_REMOVE', 'VENTAS', `Producto removido: ${itemToRemove.productName} (${itemToRemove.barcode}) x${itemToRemove.cartQuantity}`);
            }

            if (selectedItemId === cartItemId) setSelectedItemId(null);
            return { ...prev, [currentKey]: filtered };
        }); 
        returnFocusToScanner();
    }, [selectedItemId, returnFocusToScanner]);

    const updateCartItem = useCallback((cartItemId: string, quantity: number, salePrice: number) => {
        setCarts(prev => {
            const currentKey = activeCartKeyRef.current;
            const current = [...(prev[currentKey] || [])];
            const idx = current.findIndex(item => item.cartItemId === cartItemId);
            if (idx === -1) return prev;

            const item = current[idx];
            if (quantity <= 0) {
                const filtered = current.filter(i => i.cartItemId !== cartItemId);
                if (selectedItemId === cartItemId) setSelectedItemId(null);
                return { ...prev, [currentKey]: filtered };
            }
            // if (!item.isWeighted && quantity > item.quantity) {
            //     setTimeout(() => toast({ variant: "destructive", title: "STOCK INSUFICIENTE", description: `Solo quedan ${item.quantity} unidades de ${item.productName}` }), 0);
            //     return prev;
            // }
            current[idx] = { ...item, cartQuantity: quantity, salePrice: salePrice };
            return { ...prev, [currentKey]: current };
        });
        returnFocusToScanner();
    }, [selectedItemId, returnFocusToScanner]);

    const setCartItemQuantity = useCallback((cartItemId: string, quantity: number) => {
        setCarts(prev => {
            const currentKey = activeCartKeyRef.current;
            const current = [...(prev[currentKey] || [])];
            const idx = current.findIndex(item => item.cartItemId === cartItemId);
            if (idx === -1) return prev;

            const item = current[idx];

            if (quantity <= 0) {
                if (item.isPreexisting) {
                    current[idx] = { ...item, cartQuantity: 0 };
                    return { ...prev, [currentKey]: current };
                }
                const filtered = current.filter(i => i.cartItemId !== cartItemId);
                if (selectedItemId === cartItemId) setSelectedItemId(null);
                return { ...prev, [currentKey]: filtered };
            }

            current[idx] = { ...current[idx], cartQuantity: quantity };
            return { ...prev, [currentKey]: current };
        });
    }, [selectedItemId, toast]);

    const addMiscItem = useCallback((priceStr: string) => {
        if (scaleWeight < 0) {
            toast({ variant: "destructive", title: "GRAMERA", description: "âš ï¸  Ponga la gramera en 0 o positivo" });
            return;
        }
        const price = parseFloat(priceStr);
        if (isNaN(price) || price <= 0) return;
        const cartItemId = `0000-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
        const miscProduct: CartItem = { 
            barcode: '0000', 
            cartItemId: cartItemId,
            productName: `${normalizeText("VENTA RAPIDA")} ($${price.toLocaleString()})`, 
            salePrice: price, 
            quantity: 999999, 
            purchasePrice: price * 0.8, // 20% de Rentabilidad
            marginPercentage: 20, 
            categoryId: 0, 
            isWeighted: false,
            cartQuantity: 1
        };
        setCarts(prev => {
            const currentKey = activeCartKeyRef.current;
            const current = [...(prev[currentKey] || [])];
            current.push(miscProduct);
            return { ...prev, [currentKey]: current };
        });
        setSelectedItemId(cartItemId); 
        setSearchQuery(''); 
        setScannerBuffer('');
        setFeedbackCode('0000'); // Triggers beep
        setIsFeedbackError(false);
        // toast({ variant: "success", title: "EXITO", description: "VENTA RAPIDA AGREGADA" }); 
        returnFocusToScanner();
    }, [toast, returnFocusToScanner, setSearchQuery, setScannerBuffer]);

    const addToCart = useCallback(async (p: Product) => {
        try {
            if (scaleWeight < -0.0001) {
                toast({ variant: "destructive", title: "GRAMERA", description: "âš ï¸ Ponga la gramera en 0 o positivo" });
                return;
            }



            const currentKey = activeCartKeyRef.current;

            if (isProductWeighted(p)) {
                if (isScaleReloading) {
                    toast({ variant: "destructive", title: "BASCULA RECARGANDO", description: "ESPERE UN MOMENTO PARA CAPTURAR EL NUEVO PESO..." });
                    return;
                }
                if (isScaleOnline && scaleWeight < -0.0001) {
                    toast({ variant: "destructive", title: "ERROR DE BASCULA", description: "PESO NEGATIVO DETECTADO. AJUSTE LA GRAMERA." });
                    return;
                }
                // CAPTURA DIRECTA: No usamos el estado de React aqui porque puede estar stale en una funcion async
                const freshWeight = ScaleBridge.getInstance().getState().weight;

                if (freshWeight >= 0.0001 && isScaleOnline) {
                    setCarts(prev => {
                        const current = [...(prev[currentKey] || [])];
                        const idx = current.findIndex(item => item.cartItemId === p.barcode);
                        if (idx > -1) {
                            const updatedItem = { ...current[idx], cartQuantity: current[idx].cartQuantity + freshWeight };
                            current.splice(idx, 1);
                            current.push(updatedItem);
                        } else {
                            current.push({ ...p, cartQuantity: freshWeight, cartItemId: p.barcode });
                        }
                        return { ...prev, [currentKey]: current };
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
                const current = [...(prev[currentKey] || [])];
                const idx = current.findIndex(item => item.cartItemId === p.barcode);
                
                if (idx > -1) {
                    const newQty = current[idx].cartQuantity + 1;
                    // if (!isProductWeighted(p) && newQty > p.quantity) {
                    //     setTimeout(() => toast({ variant: "destructive", title: "STOCK INSUFICIENTE", description: `Solo quedan ${p.quantity} unidades de ${p.productName}` }), 0);
                    //     return prev;
                    // }
                    const updatedItem = { ...current[idx], cartQuantity: newQty };
                    current.splice(idx, 1);
                    current.push(updatedItem);
                } else {
                    // if (!isProductWeighted(p) && 1 > p.quantity) {
                    //     setTimeout(() => toast({ variant: "destructive", title: "STOCK INSUFICIENTE", description: `Solo quedan ${p.quantity} unidades de ${p.productName}` }), 0);
                    //     return prev;
                    // }
                    current.push({ ...p, cartQuantity: 1, cartItemId: p.barcode });
                }
                return { ...prev, [currentKey]: current };
            }); 
            
            setSelectedItemId(p.barcode); 
            setSearchQuery(''); 
            setScannerBuffer('');
            
            // --- FORZAR FOCO EN EL INPUT DE CANTIDAD (FASE 3) ---
            setTimeout(() => {
                const input = document.getElementById(`qty-input-${p.barcode}`) as HTMLInputElement;
                if (input) {
                    input.focus();
                    input.select();
                }
            }, 50);
            // Eliminado returnFocusToScanner() para que el autoFocus del input de cantidad surta efecto
        } catch (error: any) {
            console.error("Error en addToCart:", error);
            toast({ variant: "destructive", title: "ERROR INESPERADO", description: error?.message || "No se pudo seleccionar el producto." });
        }
    }, [scaleWeight, isScaleOnline, isScaleReloading, returnFocusToScanner, toast, setSearchQuery, setScannerBuffer, reloadScale, playBeep]);

    const handleCodeSubmit = useCallback((code: string) => {
        let finalCode = code.trim();
        let qty = 1;
        const currentKey = activeCartKeyRef.current;

        // 1. DETECCION DE ETIQUETAS DE BALANZA (EAN-13/UPC-A Prefijos 20-29)
        // Estandar: 20PPPPP VVVVV C (20 + 5 digitos producto + 5 digitos valor/peso + 1 check)
        const isBalanceCode = (finalCode.length === 13 || finalCode.length === 12) && 
                             (finalCode.startsWith('20') || finalCode.startsWith('21') || finalCode.startsWith('22') || 
                              finalCode.startsWith('23') || finalCode.startsWith('24') || finalCode.startsWith('25') ||
                              finalCode.startsWith('26') || finalCode.startsWith('27') || finalCode.startsWith('28') || 
                              finalCode.startsWith('29'));

        if (isBalanceCode) {
            const productPart = finalCode.substring(2, 7); // Los 5 digitos del producto
            const valuePart = finalCode.substring(7, 12);   // Los 5 digitos del valor o peso
            
            // Busqueda Ultra-Flexible: Comparamos limpiando ceros a la izquierda para evitar fallos por formato
            const p = products.find(x => {
                const cleanBarcode = (x.barcode || '').replace(/^0+/, '');
                const cleanProductPart = productPart.replace(/^0+/, '');
                
                const isMatch = (cleanBarcode !== '' && cleanBarcode === cleanProductPart) || 
                               x.barcode === productPart ||
                               (x.barcode && x.barcode.endsWith(productPart)) ||
                               productPart.endsWith(x.barcode);
                
                if (isMatch) return true;

                // Tambien buscamos en codigos alternativos
                if (x.alternateCodes) {
                    const altCodes = x.alternateCodes.split(',').map(c => c.trim().toUpperCase().replace(/^0+/, ''));
                    return altCodes.some(ac => ac !== '' && (ac === cleanProductPart || cleanProductPart.endsWith(ac)));
                }
                return false;
            });

            if (p && isProductWeighted(p)) {
                const unitPrice = Number(p.salePrice);
                
                if (unitPrice > 0) {
                    // Logica Heuristica: Intentar como PRECIO primero, luego como PESO
                    const totalPrice = parseInt(valuePart) / 100;
                    let calculatedWeight = totalPrice / unitPrice;

                    if (calculatedWeight > 50 || calculatedWeight <= 0.001) {
                        calculatedWeight = parseInt(valuePart) / 1000;
                    }

                    setCarts(prev => {
                        const current = [...(prev[currentKey] || [])];
                        // Generamos un ID unico para evitar colisiones si se pesa el mismo producto varias veces
                        const cartItemId = `${p.barcode}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
                        current.push({ ...p, cartQuantity: calculatedWeight, cartItemId });
                        return { ...prev, [currentKey]: current };
                    });
                    
                    setFeedbackCode(p.barcode);
                    setIsFeedbackError(false);
                    setScannerBuffer('');
                    setSearchQuery('');
                    // toast({ 
                    //     variant: "success", 
                    //     title: "BALANZA DETECTADA", 
                    //     description: `${p.productName}: ${calculatedWeight.toFixed(3)}kg añadidos` 
                    // });
                    // Autofocus en el carrito: necesitamos reconstruir el ID para seleccionarlo
                    // como dependemos del estado, usamos el mismo barcode temporal (para heuristic no se suele editar la cantidad, pero por si acaso)
                    returnFocusToScanner();
                    return;
                }
            }
        }

        // 2. LOGICA DE MULTIPLICADOR (Ej: 5*770)
        if (finalCode.includes('*')) {
            const parts = finalCode.split('*');
            if (parts.length === 2) {
                const q = parseFloat(parts[0]);
                if (!isNaN(q) && q > 0) { qty = q; finalCode = parts[1].trim(); }
            }
        }

        if (!finalCode) return;

        // 3. BUSQUEDA DEL PRODUCTO (Codigo Principal + Codigos Alternativos)
        const p = products.find(x => {
            const barcodeStr = (x.barcode || '').toString().toUpperCase();
            const targetCode = finalCode.toUpperCase();
            const isPrimaryMatch = barcodeStr === targetCode;
            if (isPrimaryMatch) return true;

            // Si no coincide el principal, buscamos en la lista de alternativos
            if (x.alternateCodes) {
                const altCodes = x.alternateCodes.split(',').map(c => c.trim().toUpperCase());
                return altCodes.includes(targetCode);
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
            toast({
                variant: "destructive",
                title: "PRODUCTO NO EXISTE",
                description: `El código ${finalCode} no se encuentra registrado en el inventario.`,
                duration: 3500
            });
            returnFocusToScanner();
        }
        setScannerBuffer('');
        setSearchQuery('');
    }, [products, addToCart, toast, returnFocusToScanner, setScannerBuffer]);

    const handleScaleSync = useCallback(() => {
        if (!isScaleOnline || isScaleReloading) return;
        
        if (!selectedItemId) {
            reloadScale();
            toast({ variant: "default", title: "BASCULA", description: "RECARGANDO LECTURA..." });
            return;
        }
        
        const currentKey = activeCartKeyRef.current;
        const currentCartLocal = carts[currentKey] || [];
        const item = currentCartLocal.find(i => i.barcode === selectedItemId);
        if (item && isProductWeighted(item)) {
            if (scaleWeight < 0.005) {
                toast({ variant: "destructive", title: "SIN PESO", description: "COLOQUE EL PRODUCTO EN LA GRAMERA" });
                return;
            }
            setCarts(prev => {
                const current = [...(prev[currentKey] || [])];
                const idx = current.findIndex(i => i.barcode === selectedItemId);
                if (idx > -1) {
                    current[idx] = { ...current[idx], cartQuantity: scaleWeight };
                }
                return { ...prev, [currentKey]: current };
            });
            // toast({ variant: "success", title: "PESO SINCRONIZADO", description: `${item.productName}: ${scaleWeight.toFixed(3)} kg` });
        }
    }, [isScaleOnline, isScaleReloading, scaleWeight, selectedItemId, carts, toast, reloadScale]);

    const handleConfirmSale = async (paymentData: {
        cash: number;
        transfer: number;
        transferSource: string;
        transferNequi?: number;
        transferDaviplata?: number;
        credit: number;
        totalPaid: number;
        change: number;
    }, pendingReturn?: any) => {
        if (submitting || submittingRef.current) return;
        submittingRef.current = true;
        setSubmitting(true);
        if (currentCart.length === 0 && !splitItemsToPay) {
            submittingRef.current = false;
            setSubmitting(false);
            return;
        }
        
        const currentKey = activeCartKeyRef.current;
        const isEditModeLocal = currentKey.startsWith('Factura EDIT-');
        const itemsToPay = splitItemsToPay || currentCart;
        
        if (isEditModeLocal) {
            setSubmitting(true);
            submittingRef.current = true;
            try {
                const editItemsPayload = buildEditItemsPayload(itemsToPay);

                if (editItemsPayload.length === 0) {
                    toast({ variant: "destructive", title: "SIN CAMBIOS", description: "No hay diferencias respecto a la factura original." });
                    setSubmitting(false);
                    submittingRef.current = false;
                    return;
                }

                const deltaTotal = computeEditDeltaTotal(itemsToPay);
                // 'charge' cobra al cliente, 'refund' le devuelve, 'neutral'
                // sustituye productos por el mismo valor (sin flujo de caja).
                const resolvedMode: 'charge' | 'refund' | 'neutral' = deltaTotal > 0
                    ? 'charge'
                    : deltaTotal < 0
                    ? 'refund'
                    : 'neutral';

                // Contrato con /sales/add-items/:id: los montos viajan como
                // MAGNITUDES POSITIVAS. El backend rechaza cualquier valor
                // negativo y determina el signo aplicado según el delta
                // monetario derivado de los items firmados. En 'neutral'
                // (mezcla al mismo valor) se envían ceros aunque el modal
                // traiga valores residuales.
                const zeroChannels = resolvedMode === 'neutral';
                const clamp = (n: number) => (n > 0 ? n : 0);
                const cashAmount = zeroChannels ? 0 : clamp(paymentData.cash || 0);
                const transferNequi = zeroChannels ? 0 : clamp(paymentData.transferNequi || 0);
                const transferDaviplata = zeroChannels ? 0 : clamp(paymentData.transferDaviplata || 0);
                const transferBreakdown = transferNequi + transferDaviplata;
                const transferAmount = zeroChannels
                    ? 0
                    : transferBreakdown > 0
                        ? transferBreakdown
                        : clamp(paymentData.transfer || 0);
                const creditAmount = zeroChannels ? 0 : clamp(paymentData.credit || 0);
                const transferSource = paymentData.transferSource || '';

                const saleId = currentKey.split('-')[1];
                await apiFetch(`/sales/add-items/${saleId}`, {
                    method: 'POST',
                    body: JSON.stringify({
                        items: editItemsPayload,
                        cashAmount,
                        transferAmount,
                        transferNequi,
                        transferDaviplata,
                        transferSource,
                        creditAmount,
                    }),
                    fallbackError: 'ERROR AL ACTUALIZAR',
                    timeoutMs: 30000,
                });

                const successCopy = resolvedMode === 'refund'
                    ? { title: 'DEVOLUCIÓN APLICADA', description: 'SE AJUSTÓ LA FACTURA Y SE REEMBOLSÓ AL CLIENTE' }
                    : resolvedMode === 'charge'
                    ? { title: 'COBRO ADICIONAL REGISTRADO', description: 'SE ACTUALIZÓ LA FACTURA CON LOS NUEVOS PRODUCTOS' }
                    : { title: 'AJUSTE APLICADO', description: 'SE SUSTITUYERON PRODUCTOS SIN COBRO ADICIONAL' };
                toast({ variant: 'success', title: successCopy.title, description: successCopy.description });

                setLastChange(paymentData.change || 0);
                setShowSuccessScreen(true);

                // Actualización optimista del stock local con signo:
                // delta > 0 (venta neta) resta stock, delta < 0 (devolución)
                // suma stock. `buildStockAdjustmentMap` ya trae los deltas
                // firmados por barcode, ignorando items sin cambio.
                const stockAdjustments = buildStockAdjustmentMap(itemsToPay);
                setProducts(prev => prev.map(p => {
                    const adjustment = stockAdjustments.get(p.barcode);
                    if (adjustment === undefined) return p;
                    // Restamos el delta: si es positivo baja el stock (más
                    // productos vendidos); si es negativo sube (devolución).
                    return { ...p, quantity: p.quantity - adjustment };
                }));
                mutateProducts();

                const updatedCarts = { ...carts };
                delete updatedCarts[currentKey];
                setCarts(updatedCarts);
                const newKeys = cartKeys.filter(k => k !== currentKey);
                setCartKeys(newKeys.length > 0 ? newKeys : ['Factura 1']);
                setActiveCartKey(newKeys.length > 0 ? newKeys[0] : 'Factura 1');
                if (newKeys.length === 0) {
                    setCarts(prevCarts => ({ ...prevCarts, 'Factura 1': [] }));
                }

                broadcastRevalidate('SALE_MADE');
            } catch (err) {
                // En edición contable NO caemos a la cola offline: la venta
                // ya existe en el backend y una segunda copia local
                // duplicaría el movimiento cuando volviera la red. El error
                // se muestra y el carrito se preserva para reintentar.
                toast({
                    variant: "destructive",
                    title: err instanceof ApiError ? "ERROR DEL SERVIDOR" : "ERROR INESPERADO",
                    description: err instanceof Error ? err.message : "Ocurrió un error de red",
                    duration: 8000,
                });
            } finally {
                setSubmitting(false);
                submittingRef.current = false;
            }
            return;
        }
        // --- BLINDAJE DE PRECIOS (POS GUARD v1.0) ---
        // Verificamos que los precios del carrito coincidan con los datos frescos de la memoria (SWR)
        const priceMismatches = itemsToPay.filter(item => {
            if (item.barcode === '0000') return false;
            const fresh = productMap.get(item.barcode);
            if (!fresh) return false;
            return Number(fresh.salePrice) !== Number(item.salePrice);
        });

        if (priceMismatches.length > 0) {
            toast({
                variant: "destructive",
                title: "ALERTA: CAMBIO DE PRECIOS",
                description: `Se detectaron cambios en ${priceMismatches.length} productos. El total ha sido actualizado.`
            });
            
            // Sincronizar precios en todos los carritos
            setCarts(prev => {
                const next = { ...prev };
                Object.keys(next).forEach(key => {
                    next[key] = next[key].map(item => {
                        const fresh = productMap.get(item.barcode);
                        if (fresh) return { ...item, salePrice: fresh.salePrice };
                        return item;
                    });
                });
                return next;
            });
            
            setIsPaymentDialogOpen(false); // Cerramos el pago para que el cajero vea el nuevo total
            setSubmitting(false);
            submittingRef.current = false;

            registerAuditLog('PRICE_GUARD_TRIGGER', 'VENTAS', `Se bloqueo venta por cambio de precios en ${priceMismatches.length} productos.`, true);
            return; 
        }

        submittingRef.current = true;
        setSubmitting(true);
        const { cash, transfer, transferSource, transferNequi = 0, transferDaviplata = 0, credit, totalPaid, change } = paymentData;

        // Si hay devolucion pendiente, llama a /sales/returns
        if (pendingReturn) {
            try {
                const payload = {
                    invoiceRef: Number(pendingReturn.saleId || 0),
                    type: "EXCHANGE",
                    refundAmount: change > 0 ? change : 0, 
                    chargeAmount: totalPaid > 0 ? totalPaid : 0,
                    returnedItems: pendingReturn.items,
                    replacementItems: itemsToPay.map(item => ({
                        barcode: item.barcode,
                        qty: item.cartQuantity
                    })),
                    chargeMethod: totalPaid > 0 ? (transfer > 0 ? transferSource : "EFECTIVO") : ""
                };

                await apiFetch('/sales/returns', {
                    method: 'POST',
                    body: JSON.stringify(payload),
                    fallbackError: 'Error procesando cambio',
                });

                toast({ variant: 'success', title: 'CAMBIO PROCESADO', description: 'SE COMPLETÓ LA DEVOLUCIÓN Y LA NUEVA VENTA' });
                localStorage.removeItem("pos-pending-return");

                if (typeof window !== 'undefined') {
                    const event = new CustomEvent('return-completed');
                    window.dispatchEvent(event);
                }

                setLastChange(change);
                setShowSuccessScreen(true);
                mutateProducts();

                const updatedCarts = { ...carts };
                delete updatedCarts[currentKey];
                setCarts(updatedCarts);
                const newKeys = cartKeys.filter(k => k !== currentKey);
                setCartKeys(newKeys.length > 0 ? newKeys : ['Factura 1']);
                setActiveCartKey(newKeys.length > 0 ? newKeys[0] : 'Factura 1');
                if (newKeys.length === 0) addNewCart();

                broadcastRevalidate('SALE_MADE');
            } catch (err) {
                toast({
                    variant: "destructive",
                    title: "ERROR",
                    description: err instanceof Error ? err.message : "Error procesando cambio",
                });
            } finally {
                setSubmitting(false);
                submittingRef.current = false;
            }
            return;
        }

        // --- INTELIGENCIA DE CATEGORIZACION (Sin "MIXTO") ---
        const paymentMethods: string[] = [];
        if (cash > 0) paymentMethods.push("EFECTIVO");
        if (transferNequi > 0) paymentMethods.push("NEQUI");
        if (transferDaviplata > 0) paymentMethods.push("DAVIPLATA");
        if (transfer > 0 && transferNequi === 0 && transferDaviplata === 0) paymentMethods.push(transferSource?.toUpperCase() || "TRANSFERENCIA");
        if (credit > 0) paymentMethods.push("FIADO");
        
        // Si no hay montos (error?), default a EFECTIVO
        const paymentMethod = paymentMethods.length > 0 ? paymentMethods.join(" + ") : "EFECTIVO";

        const localTotal = itemsToPay.reduce((acc, item) => acc + roundSaleLineSubtotal(Number(item.salePrice), item.cartQuantity), 0);

        if (localTotal > 100000000 || totalPaid > 100000000) {
            toast({ variant: "destructive", title: "ERROR DE MONTO", description: "EL VALOR ES DEMASIADO GRANDE" });
            setSubmitting(false);
            submittingRef.current = false;
            return;
        }

        const clientTxId = `tx_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        const saleData = {
            clientTxId,
            clientDni: selectedCustomerDni,
            employeeDni: "ADMIN",
            paymentMethod: paymentMethod,
            total: localTotal,
            amountPaid: totalPaid,
            cashAmount: cash,
            transferAmount: transfer,
            transferNequi: transferNequi,
            transferDaviplata: transferDaviplata,
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
                    subtotal: roundSaleLineSubtotal(price, qty)
                };
            })
        };

        try {
            if (credit > 0 && (selectedCustomerDni === '0' || !selectedCustomerDni)) {
                toast({ variant: "destructive", title: "ERROR DE CREDITO", description: "DEBE SELECCIONAR UN CLIENTE PARA FIAR" });
                setSubmitting(false);
                return;
            }

            const isEditMode = activeCartKey.startsWith("Factura EDIT-");
            let endpointPath = '/sales/register';
            let reqMethod = 'POST';

            if (isEditMode) {
                const saleId = activeCartKey.split('-')[1];
                endpointPath = `/sales/update/${saleId}`;
                reqMethod = 'PUT';
            }

            await apiFetch(endpointPath, {
                method: reqMethod,
                body: JSON.stringify(saleData),
                fallbackError: 'ERROR AL REGISTRAR VENTA',
                timeoutMs: 30000,
            });

            toast({ variant: 'success', title: 'VENTA REGISTRADA', description: 'TRANSACCION COMPLETADA CON EXITO' });
            finalizeLocalSale(itemsToPay, saleData, change);
        } catch (err: any) {
            const isNetworkError = !(err instanceof ApiError) && (
                err instanceof TypeError ||
                err?.name === 'TypeError' ||
                err?.name === 'AbortError' ||
                err?.message?.includes('fetch') ||
                err?.message?.includes('SIN CONEXION')
            );
            
            if (isNetworkError) {
                try {
                    const { addToSyncQueue } = await import('@/lib/offline-db');
                    await addToSyncQueue('SALE', saleData);
                    
                    toast({ 
                        variant: "success", 
                        title: "MODO OFFLINE", 
                        description: "Venta guardada localmente (Modo Offline)" 
                    });
                    
                    finalizeLocalSale(itemsToPay, saleData, change);
                } catch (dbError) {
                    toast({ variant: "destructive", title: "ERROR CRITICO", description: "Fallo al guardar la venta offline" });
                    setSubmitting(false);
                }
            } else {
                toast({ variant: "destructive", title: "ERROR INESPERADO", description: err.message || "CONSULTE AL ADMINISTRADOR", duration: 10000 });
                setSubmitting(false);
            }
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    };

    const finalizeLocalSale = (itemsToPay: any[], saleData: any, change: number) => {
        try {
            setLastChange(change);
            setShowSuccessScreen(true);
            
            // --- OPTIMIZACION ULTRA (Actualizacion Optimista con Soporte para Packs) ---
            const totalDeductions = new Map<string, number>();

            itemsToPay.forEach(item => {
                const qty = item.cartQuantity || 0;
                // Si es un pack, acumulamos la resta sobre el base
                if (item.isPack && item.baseProductBarcode && item.packMultiplier) {
                    const baseBarcode = item.baseProductBarcode;
                    const effectiveQty = qty * item.packMultiplier;
                    totalDeductions.set(baseBarcode, (totalDeductions.get(baseBarcode) || 0) + effectiveQty);
                } else {
                    totalDeductions.set(item.barcode, (totalDeductions.get(item.barcode) || 0) + qty);
                }
            });
            
            setProducts(prev => prev.map(p => {
                const deduction = totalDeductions.get(p.barcode);
                if (deduction !== undefined) {
                    return { ...p, quantity: Math.max(0, p.quantity - deduction) };
                }
                return p;
            }));

            mutateProducts(); // Sincronizar con el servidor en segundo plano
            
            if (remainingItemsAfterSplit) {
                const currentKey = activeCartKeyRef.current;
                setCarts(prev => ({ ...prev, [currentKey]: remainingItemsAfterSplit }));
                setRemainingItemsAfterSplit(null); 
                setSplitItemsToPay(null);
                if (originalCustomerDniBeforeSplit) {
                    handleClientSelect(originalCustomerDniBeforeSplit);
                    setOriginalCustomerDniBeforeSplit(null);
                }
            } else {
                // --- GESTION DE FACTURAS (V6.3 - Seguridad Primero) ---
                const currentKey = activeCartKeyRef.current;
                
                // 1. Limpiamos la pestaña actual
                const updatedCarts = { ...carts, [currentKey]: [] };
                setCarts(updatedCarts);
                setCartCustomers(prev => ({ ...prev, [currentKey]: '0' }));
                setSelectedCustomerDni('0');

                // 2. Verificamos si queda ALGO pendiente en cualquier otra pestaña
                const anyTabHasItems = Object.values(updatedCarts).some(items => items.length > 0);

                if (!anyTabHasItems) {
                    // Si ya no hay nada pendiente en ningun lado, reseteamos a F1
                    setCarts({ 'Factura 1': [] });
                    setCartKeys(['Factura 1']);
                    setCartCustomers({ 'Factura 1': '0' });
                    setActiveCartKey('Factura 1');
                    activeCartKeyRef.current = 'Factura 1';
                } else {
                    // Si aun hay gente esperando en otras pestañas, nos quedamos quietos
                    // No borramos pestañas para no perder datos.
                }
            }

            // REINICIAR BASCULA: Limpiar peso para la nueva factura
            reloadScale();

            setLastReceipt({
                date: new Date().toLocaleString(),
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
            
            broadcastRevalidate('SALE_MADE');
        } catch (error) {
            console.error("Error finalizing local sale:", error);
        } finally {
            setSubmitting(false);
            submittingRef.current = false;
        }
    };

    const confirmManualWeight = () => {
        const weight = parseFloat(manualWeightValue.replace(',', '.'));
        if (isNaN(weight) || weight <= 0.0001) { toast({ variant: "destructive", title: "ERROR", description: "PESO INVALIDO" }); return; }
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

    // Cargar boveda offline (IndexedDB) inmediatamente al montar para renderizado instantaneo
    useEffect(() => {
        const loadInitialCache = async () => {
            try {
                const { getCachedProducts } = await import('@/lib/offline-db');
                const cached = await getCachedProducts();
                if (Array.isArray(cached) && cached.length > 0) {
                    setProducts(cached);
                }
            } catch (e) {
                console.error("[useNewSale] Error cargando cache inicial:", e);
            }
        };
        loadInitialCache();
    }, []);

    // Sincronizar datos de SWR a estados locales de forma eficiente (HFT) + OFFLINE MODE
    useEffect(() => {
        const syncOfflineData = async () => {
            const hasData = Array.isArray(productsData);
            const hasApiError = !!productsError;
            const effectivelyOffline = isOffline || hasApiError;

            if (hasData && !effectivelyOffline) {
                // Hay internet y llegaron productos, actualizar estado local
                setProducts(productsData);
                
                // Actualizar boveda local (Offline First) silenciosamente si trae elementos
                if (productsData.length > 0) {
                    const { saveProductsToCache } = await import('@/lib/offline-db');
                    await saveProductsToCache(productsData);
                }
            } else if (effectivelyOffline) {
                // No hay internet O la API fallo (servidor caido), intentar cargar desde la boveda
                const { getCachedProducts } = await import('@/lib/offline-db');
                const cached = await getCachedProducts();
                if (Array.isArray(cached) && cached.length > 0) {
                    setProducts(cached);
                }
            }
        };
        syncOfflineData();
    }, [productsData, productsError, isOffline]);

    useEffect(() => {
        if (Array.isArray(customersData) && customersData.length > 0) {
            setCustomers(customersData);
        }
    }, [customersData]);

    useEffect(() => {
        if (Array.isArray(categoriesData)) {
            setCategories(categoriesData);
        }
    }, [categoriesData]);


    return {
        // Data
        products, customers, categories: sortedCategories,
        currentCart: sortedCart, carts, activeCartKey, cartKeys, cartCustomers,
        selectedCustomer, selectedCustomerDni,
        
        // Computed
        total, extraTotal, editDeltaTotal, editHasChanges, editMode, isEditMode, filteredProductsGrid, filteredCustomers,
        
        // UI State
        loading: loading || ((products.length === 0 || categories.length === 0) && (productsLoading || categoriesLoading)), 
        submitting, searchQuery, setSearchQuery,
        selectedCategory, setSelectedCategory,
        selectedItemId, setSelectedItemId,
        feedbackCode, isFeedbackError,
        isOffline, // Exportamos estado de red
        syncQueueCount,
        syncOfflineQueue,
        
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
        updateQuantity, removeFromCart, addToCart, addMiscItem, setCartItemQuantity, updateCartItem,
        handleCodeSubmit, handleScaleSync, handleConfirmSale, confirmManualWeight
    };
}


