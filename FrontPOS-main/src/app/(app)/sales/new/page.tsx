"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Cookies from 'js-cookie';

import {
    Button, Input, Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Dropdown, DropdownTrigger, DropdownMenu, DropdownItem,
    Chip, Spinner, Card, CardHeader, CardBody, useDisclosure, ScrollShadow, Tabs, Tab, Divider, Kbd
} from "@heroui/react";

import {
    ChevronDown, Layers, Plus, ShoppingCart, Search, Trash2,
    Banknote, Package, Grid, Camera, User, Check, Scale, Users, Barcode, Zap, Receipt,
    LayoutList, X, Scale3d, Keyboard, Scan, Ticket, RotateCcw, ChevronsUpDown
} from 'lucide-react';

import dynamic from 'next/dynamic';


import { useToast } from '@/hooks/use-toast';
import { Product, Customer, Category } from '@/lib/definitions';
import { formatCurrency, parseCurrency, applyRounding } from "@/lib/utils";
import { ScannerOverlay } from '@/components/ScannerOverlay';
import { useScale } from '@/hooks/useScale';
import { SplitBillDialog } from '@/components/SplitBillDialog';
import { saveCartsToIndexedDB, loadCartsFromIndexedDB } from '@/lib/cartStorage';
import { extractApiError } from '@/lib/api-error';

// CARGA DINÁMICA DE COMPONENTES PESADOS
const PaymentModal = dynamic(() => import('./components/PaymentModal'), { ssr: false });
const ClientSelectionModal = dynamic(() => import('./components/ClientSelectionModal'), { ssr: false });
const ManualWeightModal = dynamic(() => import('./components/ManualWeightModal'), { ssr: false });
const MissingItemModal = dynamic(() => import('./components/MissingItemModal'), { ssr: false });
const AlertTriangleIcon = dynamic(() => import('lucide-react').then(m => m.AlertTriangle), { ssr: false });


interface CartItem extends Product {
    cartQuantity: number;
}

export default function NewSalePage() {
    const router = useRouter();
    const { toast } = useToast();
    const [loading, setLoading] = useState(true);

    const [activePaymentTab, setActivePaymentTab] = useState<'cash' | 'NEQUI' | 'DAVIPLATA' | 'credit'>('cash');
    const [dialogAmount, setDialogAmount] = useState('');
    const [lastChange, setLastChange] = useState(0);

    const [cashPaid, setCashPaid] = useState<string>('');
    const [transferPaid, setTransferPaid] = useState<string>('');
    const [transferSource, setTransferSource] = useState<string>('');
    const [creditPaid, setCreditPaid] = useState<string>('');
    const [cashTendered, setCashTendered] = useState<string>('');

    const [products, setProducts] = useState<Product[]>([]);
    const [customers, setCustomers] = useState<Customer[]>([]);
    const [categories, setCategories] = useState<Category[]>([]);

    const [carts, setCarts] = useState<Record<string, CartItem[]>>({ 'Factura 1': [] });
    const [cartKeys, setCartKeys] = useState<string[]>(['Factura 1']);
    const [activeCartKey, setActiveCartKey] = useState('Factura 1');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategory, setSelectedCategory] = useState<string>('all');
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

    const [cartCustomers, setCartCustomers] = useState<Record<string, string>>({ 'Factura 1': '0' });
    const [selectedCustomerDni, setSelectedCustomerDni] = useState<string>('0');

    const [isPaymentDialogOpen, setIsPaymentDialogOpen] = useState(false);
    const [isClientDialogOpen, setIsClientDialogOpen] = useState(false);
    const [clientSearch, setClientSearch] = useState('');
    const [isScannerOpen, setIsScannerOpen] = useState(false);
    const [isManualWeightOpen, setIsManualWeightOpen] = useState(false);
    const [manualWeightProduct, setManualWeightProduct] = useState<Product | null>(null);
    const [manualWeightValue, setManualWeightValue] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [isCartDropdownOpen, setIsCartDropdownOpen] = useState(false);
    const [isSplitDialogOpen, setIsSplitDialogOpen] = useState(false);
    const [splitItemsToPay, setSplitItemsToPay] = useState<CartItem[] | null>(null);
    const [remainingItemsAfterSplit, setRemainingItemsAfterSplit] = useState<CartItem[] | null>(null);
    const [showSuccessScreen, setShowSuccessScreen] = useState(false);
    const [isMissingItemOpen, setIsMissingItemOpen] = useState(false);

    const { weight: scaleWeight, isScaleOnline } = useScale();
    const searchRef = useRef<HTMLInputElement>(null);
    const hiddenScannerRef = useRef<HTMLInputElement>(null);
    const [barcodeInput, setBarcodeInput] = useState('');
    const [feedbackCode, setFeedbackCode] = useState('');
    const [isFeedbackError, setIsFeedbackError] = useState(false);

    const [lastReceipt, setLastReceipt] = useState<any>(null);

    // --- FEEDBACK CLEANER ---
    useEffect(() => {
        if (feedbackCode) {
            const t = setTimeout(() => {
                setFeedbackCode('');
                setIsFeedbackError(false);
            }, 1500);
            return () => clearTimeout(t);
        }
    }, [feedbackCode]);

    // --- SMART FOCUS AGENT ---
    useEffect(() => {
        const interval = setInterval(() => {
            if (typeof window === 'undefined') return;
            const target = document.activeElement as HTMLElement;
            const isRealInput = (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') && !target.classList.contains('scanner-gate');
            const isModalOpen = isPaymentDialogOpen || isClientDialogOpen || isScannerOpen || isManualWeightOpen || isSplitDialogOpen || isCartDropdownOpen || isMissingItemOpen;

            if (!isRealInput && !isModalOpen && hiddenScannerRef.current) {
                hiddenScannerRef.current.focus();
            }
        }, 800);
        return () => clearInterval(interval);
    }, [isPaymentDialogOpen, isClientDialogOpen, isScannerOpen, isManualWeightOpen, isSplitDialogOpen, isCartDropdownOpen]);

    const currentCart = carts[activeCartKey] || [];
    const total = splitItemsToPay
        ? splitItemsToPay.reduce((sum, item) => sum + applyRounding(Number(item.salePrice) * item.cartQuantity), 0)
        : currentCart.reduce((sum, item) => sum + applyRounding(Number(item.salePrice) * item.cartQuantity), 0);

    const subtotal = total / 1.19;
    const iva = total - subtotal;

    const currentCollected = (Number(cashPaid) || 0) + (Number(transferPaid) || 0) + (Number(creditPaid) || 0);
    const remaining = Math.max(0, total - currentCollected);
    const currentDialogVal = Number(dialogAmount) || 0;
    const currentCashTendered = Number(cashTendered) || 0;

    const displayTendered = activePaymentTab === 'cash'
        ? (currentDialogVal > 0 ? currentDialogVal : (currentCashTendered > 0 ? currentCashTendered : remaining))
        : remaining;

    const displayChange = activePaymentTab === 'cash' ? Math.max(0, displayTendered - remaining) : 0;
    const isReadyToFinalize = (activePaymentTab === 'cash' && currentDialogVal >= remaining) || (currentDialogVal === 0 && currentCashTendered >= remaining) || (currentDialogVal === 0 && currentCashTendered === 0 && remaining > 0) || remaining === 0;

    const handleNumpadAction = () => {
        if (showSuccessScreen) {
            setIsPaymentDialogOpen(false);
            setShowSuccessScreen(false);
            setTimeout(() => hiddenScannerRef.current?.focus(), 100);
            return;
        }
        if (isReadyToFinalize) handleConfirmSale(currentDialogVal > 0 ? currentDialogVal : currentCashTendered);
        else handleAddPayment();
    };

    const handleAddPayment = () => {
        const val = currentDialogVal > 0 ? currentDialogVal : remaining;
        if (val > 0) {
            if (activePaymentTab === 'NEQUI' || activePaymentTab === 'DAVIPLATA') {
                setTransferPaid(prev => String((Number(prev) || 0) + Math.min(val, remaining)));
                setTransferSource(activePaymentTab);
                setActivePaymentTab('cash');
            } else if (activePaymentTab === 'credit') {
                if (selectedCustomerDni === '0') {
                    toast({ variant: "destructive", title: "ERROR", description: "VINCULAR CLIENTE" });
                    return;
                }
                setCreditPaid(prev => String((Number(prev) || 0) + Math.min(val, remaining)));
                setActivePaymentTab('cash');
            } else {
                if (val >= remaining) setCashTendered(String(val));
                else setCashPaid(prev => String((Number(prev) || 0) + val));
            }
            setDialogAmount('');
        }
    };

    const returnFocusToScanner = useCallback(() => hiddenScannerRef.current?.focus(), []);
    const returnFocusToSearch = useCallback(() => { if (typeof window !== 'undefined' && document.activeElement instanceof HTMLElement) document.activeElement.blur(); }, []);

    const selectedCustomer = useMemo(() => customers.find(c => c.dni === selectedCustomerDni) || { id: '0', dni: '0', name: 'CONSUMIDOR FINAL', phone: '', address: '', totalPurchases: 0, totalSpent: 0, lastPurchaseDate: '', creditLimit: 0, currentCredit: 0 } as Customer, [customers, selectedCustomerDni]);
    const filteredProductsGrid = useMemo(() => products.filter(p => (selectedCategory === 'all' || String(p.categoryId) === selectedCategory) && ((p.productName || '').toLowerCase().includes(searchQuery.toLowerCase()) || (p.barcode || '').includes(searchQuery))), [products, selectedCategory, searchQuery]);
    const filteredCustomers = customers.filter(c => (c.name || '').toLowerCase().includes(clientSearch.toLowerCase()) || (c.dni || '').includes(clientSearch));

    const handleCartSwitch = (key: string) => { setActiveCartKey(key); setSelectedCustomerDni(cartCustomers[key] || '0'); returnFocusToScanner(); };
    const handleClientSelect = (dni: string) => { setSelectedCustomerDni(dni); setCartCustomers(prev => ({ ...prev, [activeCartKey]: dni })); };

    const addNewCart = () => {
        if (currentCart.length === 0) { toast({ variant: "destructive", title: "SISTEMA", description: "CARRITO VACÍO" }); returnFocusToScanner(); return; }
        const nextNum = cartKeys.length > 0 ? Math.max(...cartKeys.map(k => parseInt(k.split(' ')[1]) || 0)) + 1 : 1;
        const newKey = `Factura ${nextNum}`;
        setCartKeys([...cartKeys, newKey]); setCarts(prev => ({ ...prev, [newKey]: [] })); setCartCustomers(prev => ({ ...prev, [newKey]: '0' })); handleCartSwitch(newKey);
    };

    const deleteCart = (key: string) => {
        if (cartKeys.length <= 1) return;
        const newKeys = cartKeys.filter(k => k !== key); setCartKeys(newKeys);
        const newCarts = { ...carts }; delete newCarts[key]; setCarts(newCarts);
        const newCustomers = { ...cartCustomers }; delete newCustomers[key]; setCartCustomers(newCustomers);
        if (activeCartKey === key) handleCartSwitch(newKeys[newKeys.length - 1]);
    };

    const updateQuantity = useCallback((barcode: string, delta: number) => {
        setCarts(prev => {
            const current = [...(prev[activeCartKey] || [])];
            const index = current.findIndex(item => item.barcode === barcode);
            if (index === -1) return prev;
            const newQty = current[index].cartQuantity + delta;
            if (newQty <= 0) {
                const filtered = current.filter(item => item.barcode !== barcode);
                if (barcode === selectedItemId) setSelectedItemId(filtered[0]?.barcode || null);
                return { ...prev, [activeCartKey]: filtered };
            }
            if (newQty > current[index].quantity && !current[index].isWeighted) { toast({ variant: "destructive", title: "ERROR", description: "STOCK INSUFICIENTE" }); return prev; }
            current[index] = { ...current[index], cartQuantity: newQty };
            return { ...prev, [activeCartKey]: current };
        });
    }, [activeCartKey, selectedItemId, toast]);

    const removeFromCart = useCallback((barcode: string) => {
        setCarts(prev => {
            const current = [...(prev[activeCartKey] || [])];
            const filtered = current.filter(item => item.barcode !== barcode);
            if (barcode === selectedItemId) setSelectedItemId(filtered[0]?.barcode || null);
            return { ...prev, [activeCartKey]: filtered };
        }); returnFocusToScanner();
    }, [activeCartKey, selectedItemId, returnFocusToScanner]);

    const addMiscItem = useCallback((priceStr: string) => {
        const price = parseFloat(priceStr);
        if (isNaN(price) || price <= 0) return;
        const miscProduct: Product = { barcode: `MISC-${price}`, productName: `PRODUCTO VARIO ($${price.toLocaleString()})`, salePrice: price, quantity: 999999, purchasePrice: price / 1.20, marginPercentage: 20, categoryId: 'misc', isWeighted: false };
        setCarts(prev => {
            const current = [...(prev[activeCartKey] || [])];
            const existingIndex = current.findIndex(item => item.barcode === miscProduct.barcode);
            if (existingIndex > -1) { current[existingIndex] = { ...current[existingIndex], cartQuantity: current[existingIndex].cartQuantity + 1 }; }
            else { current.push({ ...miscProduct, cartQuantity: 1 }); }
            return { ...prev, [activeCartKey]: current };
        });
        setSelectedItemId(miscProduct.barcode); toast({ variant: "success", title: "ÉXITO", description: "AGREGADO" }); returnFocusToScanner();
    }, [activeCartKey, toast, returnFocusToScanner]);

    const addToCart = useCallback((product: Product) => {
        if (product.quantity <= 0 && !product.isWeighted) { toast({ variant: "destructive", title: "SISTEMA", description: "SIN STOCK" }); setSearchQuery(''); return; }
        if (product.isWeighted) {
            if (scaleWeight >= 0.010 && isScaleOnline) {
                setCarts(prev => {
                    const current = [...(prev[activeCartKey] || [])];
                    const idx = current.findIndex(item => item.barcode === product.barcode);
                    if (idx > -1) current[idx] = { ...current[idx], cartQuantity: current[idx].cartQuantity + scaleWeight }; else current.push({ ...product, cartQuantity: scaleWeight });
                    return { ...prev, [activeCartKey]: current };
                }); setSelectedItemId(product.barcode); setSearchQuery(''); returnFocusToScanner(); return;
            }
            setManualWeightProduct(product); setIsManualWeightOpen(true); setSearchQuery(''); return;
        }
        setCarts(prev => {
            const current = [...(prev[activeCartKey] || [])];
            const idx = current.findIndex(item => item.barcode === product.barcode);
            if (idx > -1) {
                if (current[idx].cartQuantity >= product.quantity && !product.isWeighted) return prev;
                current[idx] = { ...current[idx], cartQuantity: current[idx].cartQuantity + 1 };
            } else current.push({ ...product, cartQuantity: 1 });
            return { ...prev, [activeCartKey]: current };
        }); setSelectedItemId(product.barcode); setSearchQuery(''); returnFocusToScanner();
    }, [activeCartKey, scaleWeight, isScaleOnline, returnFocusToScanner, toast]);

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

    // ATAJOS DE TECLADO Y LECTOR ULTRA RÁPIDO
    useEffect(() => {
        let barcodeBuffer = '';
        let lastKeyTime = Date.now();

        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

            // 1. Lector de pistola física
            if (!isInput || target.classList.contains('scanner-gate')) {
                const currentTime = Date.now();
                if (currentTime - lastKeyTime > 50) {
                    barcodeBuffer = '';
                }
                lastKeyTime = currentTime;

                if (e.key === 'Enter') {
                    if (barcodeBuffer.length >= 4) {
                        e.preventDefault();
                        handleCodeSubmit(barcodeBuffer);
                        barcodeBuffer = '';
                        return;
                    }
                } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
                    barcodeBuffer += e.key;
                }
            }

            // 2. Atajos de pago y acciones
            if (e.code === 'Space' && (!isInput || target.classList.contains('scanner-gate')) && currentCart.length > 0 && !isPaymentDialogOpen) {
                e.preventDefault(); setCashPaid(''); setTransferPaid(''); setCreditPaid(''); setCashTendered(''); setDialogAmount('');
                setActivePaymentTab('cash'); setIsPaymentDialogOpen(true); return;
            }
            if (e.key === 'Enter' && showSuccessScreen) {
                e.preventDefault(); setShowSuccessScreen(false); setIsPaymentDialogOpen(false); returnFocusToScanner(); return;
            }
            if (isPaymentDialogOpen && !showSuccessScreen) {
                if (/^[0-9]$/.test(e.key) && (!isInput || target.classList.contains('scanner-gate'))) { e.preventDefault(); setDialogAmount(prev => prev + e.key); return; }
                if (e.key === 'Backspace' && (!isInput || target.classList.contains('scanner-gate'))) { e.preventDefault(); setDialogAmount(prev => prev.slice(0, -1)); return; }
                if (e.key === 'Escape') { e.preventDefault(); setIsPaymentDialogOpen(false); setDialogAmount(''); returnFocusToScanner(); return; }
                if (e.key === 'Enter') { e.preventDefault(); handleNumpadAction(); return; }
            }
            if ((!isInput || target.classList.contains('scanner-gate')) && selectedItemId && !isPaymentDialogOpen) {
                if (e.key === '+') { e.preventDefault(); updateQuantity(selectedItemId, 1); }
                else if (e.key === '-') { e.preventDefault(); updateQuantity(selectedItemId, -1); }
            }
        };

        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }, [currentCart.length, isPaymentDialogOpen, selectedItemId, updateQuantity, showSuccessScreen, activePaymentTab, dialogAmount, remaining, total, transferSource, selectedCustomerDni, currentDialogVal, currentCashTendered, products, handleCodeSubmit, handleNumpadAction, returnFocusToScanner]);

    const handleConfirmSale = async (directCashValue?: number) => {
        if (currentCart.length === 0 && !splitItemsToPay) return;
        const itemsToPay = splitItemsToPay || currentCart;

        setSubmitting(true);
        const token = Cookies.get('org-pos-token');
        try {
            let numCash = Number(cashPaid) || 0;
            let numTransfer = Number(transferPaid) || 0;
            let numCredit = Number(creditPaid) || 0;
            let numTendered = Number(cashTendered) || 0;
            let tSource = transferSource;

            if (typeof directCashValue === 'number' && directCashValue >= remaining && activePaymentTab === 'cash') {
                numTendered = directCashValue;
                setCashTendered(String(directCashValue));
                setDialogAmount('');
            }

            const curCollected = numCash + numTransfer + numCredit;
            const rem = Math.max(0, total - curCollected);

            if (rem > 0) {
                if (activePaymentTab === 'NEQUI' || activePaymentTab === 'DAVIPLATA') {
                    numTransfer += rem; tSource = activePaymentTab;
                } else if (activePaymentTab === 'credit') {
                    numCredit += rem;
                } else {
                    numCash += rem;
                }
            }

            if (numCredit > 0 && selectedCustomerDni === '0') {
                toast({ variant: "destructive", title: "ERROR", description: "INVÁLIDO PARA C. FINAL" });
                setSubmitting(false);
                return;
            }

            const finalChange = numTendered > 0 ? Math.max(0, numTendered - (total - numTransfer - numCredit)) : 0;

            const saleData = {
                clientDni: selectedCustomerDni,
                employeeDni: "ADMIN",
                paymentMethod: numCredit > 0 ? "FIADO" : (numCash > 0 && numTransfer > 0 ? "MIXTO" : numTransfer > 0 ? "TRANSFERENCIA" : "EFECTIVO"),
                total: total,
                amountPaid: numCash + numTransfer + numCredit,
                cashAmount: numCash,
                transferAmount: numTransfer,
                transferSource: numTransfer > 0 ? tSource : '',
                creditAmount: numCredit,
                change: finalChange,
                details: itemsToPay.map(item => ({
                    barcode: item.barcode, quantity: item.cartQuantity, unitPrice: Number(item.salePrice), subtotal: applyRounding(Number(item.salePrice) * item.cartQuantity)
                }))
            };

            console.log('DEBUG: Enviando venta:', saleData);
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/sales/register`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify(saleData)
            });

            if (res.ok) {
                setLastChange(finalChange);
                setShowSuccessScreen(true);
                if (remainingItemsAfterSplit) {
                    setCarts(prev => ({ ...prev, [activeCartKey]: remainingItemsAfterSplit }));
                    setRemainingItemsAfterSplit(null); setSplitItemsToPay(null);
                } else {
                    setCarts(prev => ({ ...prev, [activeCartKey]: [] })); handleClientSelect('0');
                }
                setLastReceipt({
                    date: new Date().toLocaleString('es-CO'),
                    clientName: selectedCustomer.name,
                    clientDni: selectedCustomerDni,
                    total: total,
                    paymentMethod: saleData.paymentMethod,
                    cashAmount: numCash,
                    transferAmount: numTransfer,
                    creditAmount: numCredit,
                    change: finalChange,
                    items: itemsToPay
                });
                setCashPaid(''); setCashTendered(''); setTransferPaid(''); setTransferSource(''); setCreditPaid(''); setDialogAmount(''); setActivePaymentTab('cash');
            } else {
                const errorMsg = await extractApiError(res, "ERROR AL REGISTRAR VENTA");
                throw new Error(errorMsg);
            }
        } catch (err: any) {
            toast({ variant: "destructive", title: "FALLO", description: err.message || "ERROR DE REGISTRO" });
        } finally {
            setSubmitting(false);
        }
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
            setSelectedItemId(manualWeightProduct.barcode); setManualWeightValue(''); setIsManualWeightOpen(false); setManualWeightProduct(null); returnFocusToScanner();
        }
    };

    useEffect(() => {
        const loadData = async () => {
            const token = Cookies.get('org-pos-token');
            if (!token) { router.replace('/login'); return; }
            try {
                const [pRes, cuRes, caRes] = await Promise.all([
                    fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/all-products`, { headers: { 'Authorization': `Bearer ${token}` } }).then(r => r.json()).catch(() => null),
                    fetch(`${process.env.NEXT_PUBLIC_API_URL}/clients/all-clients`, { headers: { 'Authorization': `Bearer ${token}` } }).then(r => r.json()).catch(() => null),
                    fetch(`${process.env.NEXT_PUBLIC_API_URL}/categories/all-categories`, { headers: { 'Authorization': `Bearer ${token}` } }).then(r => r.json()).catch(() => null)
                ]);
                setProducts(pRes || []); setCustomers(cuRes || []); setCategories(caRes || []);
                const savedData = await loadCartsFromIndexedDB();
                if (savedData && Object.keys(savedData.carts).length > 0) {
                    setCarts(savedData.carts); setCartKeys(Object.keys(savedData.carts)); setActiveCartKey(savedData.activeKey || 'Factura 1'); setSelectedCustomerDni(savedData.customerDni || '0');
                }
            } catch (err: any) {
                console.error(err);
                toast({ variant: "destructive", title: "ERROR DE CARGA", description: "Verifique su conexión al servidor." });
            } finally {
                setLoading(false);
            }
        };
        loadData();
    }, [router]);

    useEffect(() => {
        if (!loading) saveCartsToIndexedDB(carts, activeCartKey, selectedCustomerDni);
    }, [carts, activeCartKey, selectedCustomerDni, loading]);



    if (loading) return <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner size="lg" color="success" /></div>;

    return (
        <div className="flex flex-col h-screen gap-1 p-1 bg-gray-100 dark:bg-zinc-950 overflow-hidden select-none transition-colors duration-500">

            <main className="flex-1 flex flex-col gap-1 min-h-0 overflow-hidden relative">

                {/* --- SECCIÓN SUPERIOR: CARRITO (IZQ) Y TECLADO (DER) --- */}
                <div className="flex-[7] lg:flex-[5] flex flex-col lg:flex-row gap-1 min-h-0">

                    {/* PANEL IZQUIERDO: CARRITO */}
                    <div className="flex-1 flex flex-col rounded-lg border border-gray-200 dark:border-white/5 bg-white dark:bg-zinc-900 overflow-hidden shadow-sm min-h-0">
                        {/* HEADER CARRITO - ULTRA COMPACTO CON BALANZA */}
                        <div className="bg-gray-50 dark:bg-zinc-900/50 border-b border-gray-200 dark:border-white/5 p-2 shrink-0 flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                <Dropdown placement="bottom-start" onOpenChange={setIsCartDropdownOpen} classNames={{ content: "min-w-[250px] bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 shadow-xl rounded-lg max-h-[300px] overflow-y-auto custom-scrollbar" }}>
                                    <DropdownTrigger>
                                        <Button size="sm" variant="flat" className="h-8 px-2 sm:px-3 rounded-md font-bold text-[10px] sm:text-[11px] bg-emerald-500 text-white shadow-sm hover:bg-emerald-600">
                                            <Layers className="h-3 w-3 sm:mr-1.5" />
                                            <span className="hidden sm:inline">{activeCartKey.replace('Factura ', 'F')}</span>
                                            <span className="sm:hidden">{activeCartKey.split(' ')[1]}</span>
                                            {currentCart.length > 0 && <span className="ml-1 bg-white/20 px-1.5 py-0.5 rounded text-[9px]">{currentCart.length}</span>}
                                            <ChevronDown className="h-3 w-3 ml-1 opacity-70" />
                                        </Button>
                                    </DropdownTrigger>
                                    <DropdownMenu aria-label="Carritos Abiertos">
                                        {cartKeys.map((key) => {
                                            const custDni = cartCustomers[key] || '0';
                                            const cust = customers.find(c => c.dni === custDni);
                                            const custName = cust && cust.dni !== '0' ? cust.name : 'Consumidor Final';
                                            const itemsCount = carts[key]?.length || 0;
                                            return (
                                                <DropdownItem key={key} textValue={key} onPress={() => handleCartSwitch(key)} className={`rounded-md py-2 px-3 mb-0.5 ${activeCartKey === key ? 'bg-emerald-50 dark:bg-emerald-500/10' : 'hover:bg-gray-50 dark:hover:bg-white/5'}`}>
                                                    <div className="flex justify-between items-center w-full">
                                                        <div className="flex flex-col flex-1 pr-2 overflow-hidden">
                                                            <span className={`font-black text-xs ${activeCartKey === key ? 'text-emerald-600 dark:text-emerald-500' : 'text-gray-900 dark:text-white'}`}>{key}</span>
                                                            <span className="text-[9px] text-gray-500 dark:text-zinc-500 uppercase tracking-widest font-bold truncate">{custName}</span>
                                                        </div>
                                                        <div className="flex items-center gap-2 shrink-0">
                                                            <Chip size="sm" variant="flat" className="bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 font-bold text-[9px] h-5">{itemsCount} art</Chip>
                                                            {cartKeys.length > 1 && itemsCount === 0 && (
                                                                <div onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteCart(key); }} className="h-6 w-6 flex items-center justify-center rounded bg-rose-50 dark:bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white transition-colors cursor-pointer"><Trash2 className="h-3 w-3" /></div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </DropdownItem>
                                            );
                                        })}
                                    </DropdownMenu>
                                </Dropdown>
                                <Button isIconOnly size="sm" variant="light" className="h-8 w-8 rounded-md text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10" onPress={addNewCart}><Plus className="h-4 w-4" /></Button>
                            </div>

                            <div className="flex items-center gap-2">
                                {/* INDICADOR DE BALANZA EN VIVO */}
                                <div className={`flex items-center gap-1.5 sm:gap-2 px-1.5 sm:px-2 py-1 rounded-md border shadow-sm transition-colors ${isScaleOnline ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20 text-emerald-600 dark:text-emerald-500' : 'bg-gray-100 dark:bg-zinc-800 border-gray-200 dark:border-white/10 text-gray-400 dark:text-zinc-500'}`}>
                                    <Scale className={`h-3 w-3 ${isScaleOnline ? 'animate-pulse' : ''}`} />
                                    <div className="flex flex-col leading-none text-right">
                                        <span className="hidden sm:block text-[7px] font-bold uppercase tracking-widest leading-none">{isScaleOnline ? 'En línea' : 'Offline'}</span>
                                        <span className="text-[9px] sm:text-[10px] font-black tabular-nums">{isScaleOnline ? `${scaleWeight.toFixed(3)} kg` : '---'}</span>
                                    </div>
                                </div>

                                {/* Cliente */}
                                <Button size="sm" variant="flat" onPress={() => setIsClientDialogOpen(true)} className="h-8 px-2 sm:px-3 rounded-md font-bold text-[10px] uppercase bg-sky-50 dark:bg-sky-500/10 text-sky-600 dark:text-sky-500 hover:bg-sky-100 border border-sky-200 dark:border-sky-500/20">
                                    <User className="h-3 w-3 sm:mr-1.5" /> <span className="hidden sm:inline italic">CLIENTE</span>
                                </Button>

                                {/* DIVIDIR CUENTA */}
                                <Button size="sm" variant="flat" onPress={() => setIsSplitDialogOpen(true)} isDisabled={currentCart.length === 0} className="h-8 px-2 sm:px-3 rounded-md font-bold text-[10px] uppercase bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-500 hover:bg-amber-100 border border-amber-200 dark:border-amber-500/20">
                                    <Grid className="h-3 w-3 sm:mr-1.5" /> <span className="hidden sm:inline">Dividir</span>
                                </Button>
                            </div>
                        </div>

                        {/* TABLA DE PRODUCTOS - COMPACTA */}
                        <div className="flex-1 overflow-hidden flex flex-col min-h-0 bg-white dark:bg-zinc-900/40">
                            <div className="flex-1 overflow-y-auto custom-scrollbar px-1">
                                <Table aria-label="Carrito" isCompact removeWrapper classNames={{ th: "bg-gray-50 dark:bg-zinc-800/80 text-gray-500 font-bold uppercase text-[8px] sm:text-[9px] tracking-widest sticky top-0 z-10 border-b border-gray-200 h-7 sm:h-8 py-0.5 sm:py-1", td: "py-0.5 sm:py-1 font-medium border-b border-gray-100 dark:border-white/5", tr: "hover:bg-gray-50 dark:hover:bg-zinc-800/50 cursor-pointer" }}>
                                    <TableHeader>
                                        <TableColumn>ARTÍCULO</TableColumn>
                                        <TableColumn align="center">PVP</TableColumn>
                                        <TableColumn align="center">CANT</TableColumn>
                                        <TableColumn align="end">TOTAL</TableColumn>
                                        <TableColumn align="center" width={30}> </TableColumn>
                                    </TableHeader>
                                    <TableBody emptyContent={<div className="py-10 text-gray-400 text-xs font-bold uppercase tracking-widest text-center">Carrito vacío</div>}>
                                        {currentCart.map((item) => (
                                            <TableRow key={item.barcode} className={selectedItemId === item.barcode ? "bg-emerald-500/20 dark:bg-emerald-500/30 border-l-4 border-emerald-500" : ""} onClick={() => { setSelectedItemId(item.barcode); returnFocusToSearch(); }}>
                                                <TableCell>
                                                    <div className="text-[10px] sm:text-[11px] font-bold text-gray-900 dark:text-white uppercase leading-tight truncate max-w-[100px] sm:max-w-none">{item.productName}</div>
                                                    <div className="text-[8px] sm:text-[9px] text-gray-400 dark:text-zinc-500 font-mono">{item.barcode}</div>
                                                </TableCell>
                                                <TableCell className="text-center text-gray-600 dark:text-zinc-400 text-[11px] tabular-nums">${formatCurrency(item.salePrice)}</TableCell>
                                                <TableCell className="text-center">
                                                    <span className="bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-500 font-bold text-[11px] px-2 py-0.5 rounded tabular-nums">{item.cartQuantity}</span>
                                                </TableCell>
                                                <TableCell className="text-right font-black text-emerald-600 dark:text-emerald-500 text-xs tabular-nums">${formatCurrency(applyRounding(Number(item.salePrice) * item.cartQuantity))}</TableCell>
                                                <TableCell className="text-center p-0">
                                                    <div onClick={(e) => e.stopPropagation()}>
                                                        <Button isIconOnly color="danger" variant="light" size="sm" className="h-6 w-6 min-w-6 hover:bg-rose-100" onPress={() => removeFromCart(item.barcode)}>
                                                            <Trash2 size={12} className="text-rose-500" />
                                                        </Button>
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        </div>

                        {/* TOTALES FOOTER - COMPACTO */}
                        <div className="bg-gray-50 dark:bg-zinc-900 p-2 flex items-center justify-between shrink-0 border-t border-gray-200 dark:border-white/5 gap-2">
                            <div className="flex gap-4 px-2">
                                <div className="flex flex-col text-left">
                                    <span className="text-[9px] font-bold text-gray-500 uppercase tracking-widest leading-none">Subtotal</span>
                                    <span className="text-xs font-black text-gray-700 dark:text-zinc-300 tabular-nums">${formatCurrency(subtotal)}</span>
                                </div>
                                <div className="flex flex-col text-left">
                                    <span className="text-[9px] font-bold text-gray-500 uppercase tracking-widest leading-none">IVA</span>
                                    <span className="text-xs font-black text-gray-700 dark:text-zinc-300 tabular-nums">${formatCurrency(iva)}</span>
                                </div>
                            </div>
                            <div className="bg-emerald-100 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 px-4 py-1.5 rounded-lg flex items-center gap-4 shadow-sm">
                                <p className="text-[9px] font-black text-emerald-700 dark:text-emerald-500 uppercase tracking-widest leading-none">TOTAL</p>
                                <p className="text-2xl font-black text-gray-900 dark:text-white tabular-nums leading-none tracking-tighter">${formatCurrency(total)}</p>
                            </div>
                        </div>
                    </div>

                    {/* PANEL DERECHO: TECLADO Y ESCÁNER - MÁS ESTRECHO */}
                    <aside className="w-[260px] flex flex-col shrink-0">
                        <div className="flex-1 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-lg p-2 shadow-sm flex flex-col gap-1">
                            {/* Input escáner con BOTÓN DE CÁMARA INCLUIDO */}
                            <div className="flex items-center gap-1 bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/5 px-2 py-1 rounded-md shadow-inner h-10 shrink-0">
                                <Barcode className="h-4 w-4 text-emerald-600 shrink-0" />
                                <Input
                                    size="sm"
                                    value={barcodeInput}
                                    onChange={e => setBarcodeInput(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && handleCodeSubmit(barcodeInput)}
                                    placeholder="CÓDIGO..."
                                    classNames={{ inputWrapper: "bg-transparent border-none shadow-none h-8 px-0", input: "scanner-gate font-mono font-bold text-xs text-gray-900 dark:text-emerald-500" }}
                                />
                                <Button
                                    isIconOnly
                                    size="sm"
                                    variant="flat"
                                    className="h-7 w-7 min-w-7 rounded bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-500 hover:bg-emerald-500 hover:text-white transition-colors"
                                    onPress={() => setIsScannerOpen(true)}
                                >
                                    <Camera className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                    isIconOnly
                                    size="sm"
                                    variant="flat"
                                    className="h-7 w-7 min-w-7 rounded bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-500 hover:bg-rose-500 hover:text-white transition-colors"
                                    onPress={() => setIsMissingItemOpen(true)}
                                >
                                    <AlertTriangleIcon className="h-3.5 w-3.5" />
                                </Button>
                            </div>

                            <div className="grid grid-cols-4 gap-1 flex-1 mt-1">
                                <Button color="danger" variant="flat" className="h-full min-h-[40px] rounded-md font-bold text-xs" onPress={() => setSearchQuery('')}>CE</Button>
                                <Button variant="flat" className="h-full min-h-[40px] rounded-md font-bold text-base bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white" onPress={() => setSearchQuery(p => p + '*')}>*</Button>
                                <Button variant="flat" className="h-full min-h-[40px] rounded-md font-bold text-xl bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white leading-none" onPress={() => selectedItemId && updateQuantity(selectedItemId, -1)}>-</Button>
                                <Button variant="flat" className="h-full min-h-[40px] rounded-md font-bold text-xl bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white leading-none" onPress={() => selectedItemId && updateQuantity(selectedItemId, 1)}>+</Button>

                                <div className="col-span-3 grid grid-cols-3 gap-1">
                                    {['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '.'].map(n => (
                                        <Button key={n} variant="bordered" className={`h-full min-h-[40px] rounded-md text-base font-bold bg-gray-50 dark:bg-zinc-950 border-gray-200 dark:border-white/5 text-gray-900 dark:text-white hover:border-emerald-500 ${n === '0' ? 'col-span-2' : ''}`} onPress={() => setSearchQuery(p => p + n)}>{n}</Button>
                                    ))}
                                </div>
                                <Button className="col-span-1 h-full min-h-[40px] rounded-md font-black text-2xl text-white bg-emerald-500 hover:bg-emerald-600 shadow-sm" onPress={() => { setCashPaid(''); setTransferPaid(''); setCreditPaid(''); setCashTendered(''); setDialogAmount(''); setActivePaymentTab('cash'); setIsPaymentDialogOpen(true); }} isDisabled={currentCart.length === 0}>=</Button>
                            </div>
                        </div>
                    </aside>
                </div>

                {/* --- SECCIÓN INFERIOR: CATEGORÍAS Y PRODUCTOS --- */}
                <div className="flex-[3] lg:flex-[4] flex gap-1 min-h-0 bg-white dark:bg-zinc-900 rounded-lg p-1 border border-gray-200 dark:border-white/5 shadow-sm">
                    <aside className="w-28 shrink-0 flex flex-col gap-1 overflow-y-auto custom-scrollbar pr-1">
                        <Button size="sm" className={`justify-start h-8 min-h-[32px] rounded-md font-bold text-[9px] px-2 ${selectedCategory === 'all' ? 'bg-emerald-500 text-white' : 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-400 hover:bg-gray-200'}`} onPress={() => setSelectedCategory('all')}>
                            TODOS
                        </Button>
                        {categories.map(cat => (
                            <Button key={cat.id} size="sm" className={`justify-start h-8 min-h-[32px] rounded-md font-bold text-[9px] uppercase truncate px-2 ${selectedCategory === String(cat.id) ? 'bg-emerald-500 text-white' : 'bg-gray-100 dark:bg-zinc-800 text-gray-600 hover:bg-gray-200'}`} onPress={() => setSelectedCategory(String(cat.id))}>
                                {cat.name}
                            </Button>
                        ))}
                    </aside>

                    <section className="flex-1 flex flex-col overflow-hidden min-h-0 bg-gray-50 dark:bg-zinc-950 rounded-md border border-gray-200 dark:border-white/5">
                        <div className="p-1.5 border-b border-gray-200 dark:border-white/5 bg-white dark:bg-zinc-900/50 shrink-0">
                            <Input size="sm" placeholder="BUSCAR PRODUCTO..." value={searchQuery} onValueChange={setSearchQuery} ref={searchRef} startContent={<Search className="text-gray-400 h-3 w-3" />} classNames={{ inputWrapper: "bg-gray-100 dark:bg-zinc-950 border-transparent h-8 min-h-[32px] rounded-md", input: "text-[10px] font-bold uppercase text-gray-900 dark:text-white" }} />
                        </div>
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-1.5">
                            <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-1.5">
                                {filteredProductsGrid.map(p => (
                                    <button key={p.barcode || Math.random().toString()} className="group flex flex-col bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 p-2 rounded-lg text-left h-[80px] hover:bg-emerald-50 dark:hover:bg-emerald-500/10 hover:border-emerald-300 transition-all active:scale-95 shadow-sm" onClick={() => addToCart(p)}>
                                        <div className="flex justify-between items-start w-full mb-1">
                                            <div className={`h-5 w-5 rounded flex items-center justify-center transition-colors ${p.isWeighted ? 'bg-amber-100 text-amber-600' : 'bg-gray-100 text-gray-600 group-hover:bg-emerald-500 group-hover:text-white'}`}>
                                                {p.isWeighted ? <Scale className="h-3 w-3" /> : <Package className="h-3 w-3" />}
                                            </div>
                                            <span className="text-[8px] font-bold text-gray-400">STK:{p.quantity}</span>
                                        </div>
                                        <span className="font-bold text-[9px] text-gray-700 dark:text-zinc-300 uppercase line-clamp-2 leading-tight flex-1">{p.productName}</span>
                                        <div className="mt-auto w-full text-right">
                                            <span className="font-black text-emerald-600 dark:text-emerald-500 text-xs tabular-nums">${Number(p.salePrice).toLocaleString()}</span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </section>
                </div>
            </main>

            {/* --- MODALES DINÁMICOS --- */}
            <PaymentModal 
                isOpen={isPaymentDialogOpen}
                onOpenChange={setIsPaymentDialogOpen}
                showSuccessScreen={showSuccessScreen}
                setShowSuccessScreen={setShowSuccessScreen}
                lastChange={lastChange}
                total={total}
                remaining={remaining}
                activePaymentTab={activePaymentTab}
                setActivePaymentTab={setActivePaymentTab}
                dialogAmount={dialogAmount}
                setDialogAmount={setDialogAmount}
                displayTendered={displayTendered}
                displayChange={displayChange}
                selectedCustomer={selectedCustomer}
                isReadyToFinalize={isReadyToFinalize}
                submitting={submitting}
                handleNumpadAction={handleNumpadAction}
                setIsClientDialogOpen={setIsClientDialogOpen}
                onCloseComplete={returnFocusToScanner}
            />

            <ClientSelectionModal 
                isOpen={isClientDialogOpen}
                onOpenChange={setIsClientDialogOpen}
                clientSearch={clientSearch}
                setClientSearch={setClientSearch}
                filteredCustomers={filteredCustomers}
                handleClientSelect={handleClientSelect}
            />

            <ManualWeightModal 
                isOpen={isManualWeightOpen}
                onOpenChange={setIsManualWeightOpen}
                manualWeightProduct={manualWeightProduct}
                manualWeightValue={manualWeightValue}
                setManualWeightValue={setManualWeightValue}
                confirmManualWeight={confirmManualWeight}
            />


            <ScannerOverlay isOpen={isScannerOpen} onClose={() => setIsScannerOpen(false)} onResult={(res) => { handleCodeSubmit(res); setIsScannerOpen(false); }} title="Escáner POS" />
            <SplitBillDialog isOpen={isSplitDialogOpen} onClose={() => setIsSplitDialogOpen(false)} originalItems={currentCart} onConfirm={(l, r) => { setRemainingItemsAfterSplit(l); setSplitItemsToPay(r); setIsSplitDialogOpen(false); setIsPaymentDialogOpen(true); }} />
            <MissingItemModal isOpen={isMissingItemOpen} onOpenChange={setIsMissingItemOpen} />

            {/* THERMAL RECEIPT (HIDDEN FROM UI, SHOWN FOR PRINT) */}
            {lastReceipt && (
                <div className="hidden print:block fixed inset-0 bg-white text-black font-mono p-4 w-[80mm]" style={{ margin: 0 }}>
                    <div className="text-center font-bold mb-4 uppercase"><h1>POS MINIMAL</h1><p className="text-[10px]">Factura de Venta</p></div>
                    <div className="text-[10px] border-b border-zinc-200 pb-2 mb-2">
                        <p>FECHA: {lastReceipt.date}</p>
                        <p>CLIENTE: {lastReceipt.clientName}</p>
                        <p>DNI: {lastReceipt.clientDni}</p>
                    </div>
                    <table className="w-full text-[9px] uppercase mb-2 border-b border-zinc-200">
                        <thead><tr className="border-b border-zinc-100"><th>CANT</th><th>DESC</th><th className="text-right">SUMA</th></tr></thead>
                        <tbody>
                            {lastReceipt.items.map((it: any, idx: number) => (
                                <tr key={idx}><td className="py-1">{it.cartQuantity}{it.isWeighted ? 'kg' : ''}</td><td className="py-1">{it.productName}</td><td className="py-1 text-right font-bold">${(it.salePrice * it.cartQuantity).toLocaleString()}</td></tr>
                            ))}
                        </tbody>
                    </table>
                    <div className="text-right text-[10px] space-y-1">
                        <div className="flex justify-between"><span>TOTAL:</span><span className="font-bold">${lastReceipt.total.toLocaleString()}</span></div>
                        <p className="flex justify-between text-zinc-500"><span>PAGO:</span><span>{lastReceipt.paymentMethod}</span></p>
                    </div>
                    <div className="text-center text-[9px] mt-6"><p className="font-bold">¡GRACIAS POR SU COMPRA!</p></div>
                </div>
            )}

            <input ref={hiddenScannerRef} type="text" className="scanner-gate absolute opacity-0 pointer-events-none -z-50 h-0 w-0" value={barcodeInput} onChange={e => setBarcodeInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCodeSubmit(barcodeInput)} />
        </div>
    );
}