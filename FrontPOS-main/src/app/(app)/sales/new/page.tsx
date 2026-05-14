"use client";

import { useEffect, useRef } from 'react';
import {
    Button, Input, Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Spinner, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter
} from "@heroui/react";

import {
    Plus, Trash2, User, Grid, Camera, Search, Scale, Barcode,
    Wifi, WifiOff
} from 'lucide-react';

import { motion, AnimatePresence } from 'framer-motion';

import dynamic from 'next/dynamic';

import { formatCurrency, applyRounding } from "@/lib/utils";
import { ScannerOverlay } from '@/components/ScannerOverlay';
import { SplitBillDialog } from '@/components/SplitBillDialog';
import { useNewSale } from './hooks/useNewSale';
import ProductGrid from './components/ProductGrid';

// CARGA DINÁMICA DE COMPONENTES PESADOS
const UniversalPaymentModal = dynamic(() => import('@/components/shared/UniversalPaymentModal'), { ssr: false });
const ClientSelectionModal = dynamic(() => import('./components/ClientSelectionModal'), { ssr: false });
const ManualWeightModal = dynamic(() => import('./components/ManualWeightModal'), { ssr: false });
const MissingItemModal = dynamic(() => import('./components/MissingItemModal'), { ssr: false });
const AlertTriangleIcon = dynamic(() => import('lucide-react').then(m => m.AlertTriangle), { ssr: false });

export default function NewSalePage() {
    const {
        products, customers, categories,
        currentCart, activeCartKey, cartKeys, cartCustomers,
        selectedCustomer, selectedCustomerDni,
        total, filteredProductsGrid, filteredCustomers,
        loading, submitting, searchQuery, setSearchQuery,
        selectedCategory, setSelectedCategory,
        selectedItemId, setSelectedItemId,
        isPaymentDialogOpen, setIsPaymentDialogOpen,
        isClientDialogOpen, setIsClientDialogOpen,
        clientSearch, setClientSearch,
        isScannerOpen, setIsScannerOpen,
        isManualWeightOpen, setIsManualWeightOpen,
        manualWeightProduct, manualWeightValue, setManualWeightValue,
        isSplitDialogOpen, setIsSplitDialogOpen,
        isMissingItemOpen, setIsMissingItemOpen,
        showSuccessScreen, setShowSuccessScreen,
        lastChange, hiddenScannerRef, returnFocusToScanner,
        scaleWeight, isScaleOnline, isScaleReloading, isOffline,
        scannerBuffer, setScannerBuffer, playBeep, feedbackCode, isFeedbackError,
        handleCartSwitch, handleClientSelect, addNewCart, deleteCart, confirmDeleteCart,
        isDeleteCartConfirmOpen, setIsDeleteCartConfirmOpen,
        updateQuantity, removeFromCart, addToCart, addMiscItem, setCartItemQuantity,
        handleCodeSubmit, handleScaleSync, handleConfirmSale, confirmManualWeight,
        setOriginalCustomerDniBeforeSplit, setRemainingItemsAfterSplit, setSplitItemsToPay
    } = useNewSale();

    const searchRef = useRef<HTMLInputElement>(null);
    const lastKeyPressTime = useRef<number>(0);
    const isScanningRef = useRef<boolean>(false);
    const autoSubmitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // --- AUTO-SUBMIT JALTECH POS 2D: Buffer quieto 150ms = código completo ---
    // Jaltech omnidireccional completa un EAN-13 en ~130ms (10-15ms entre chars)
    useEffect(() => {
        if (autoSubmitTimer.current) clearTimeout(autoSubmitTimer.current);
        
        // Solo auto-enviar si detectamos que viene de un escáner (isScanningRef)
        // y tiene una longitud razonable para un código de barras.
        if (scannerBuffer.length >= 3 && isScanningRef.current) {
            autoSubmitTimer.current = setTimeout(() => {
                handleCodeSubmit(scannerBuffer);
                setScannerBuffer('');
                isScanningRef.current = false;
            }, 150);
        }
        return () => { if (autoSubmitTimer.current) clearTimeout(autoSubmitTimer.current); };
    }, [scannerBuffer, handleCodeSubmit, setScannerBuffer]);

    // --- REFS PARA ESTABILIDAD DE LISTENERS (V9.0) ---
    const scannerBufferRef = useRef(scannerBuffer);
    useEffect(() => { scannerBufferRef.current = scannerBuffer; }, [scannerBuffer]);

    const isModalOpenRef = useRef(false);
    useEffect(() => {
        isModalOpenRef.current = isPaymentDialogOpen || isClientDialogOpen || isScannerOpen || isManualWeightOpen || isSplitDialogOpen || isMissingItemOpen;
    }, [isPaymentDialogOpen, isClientDialogOpen, isScannerOpen, isManualWeightOpen, isSplitDialogOpen, isMissingItemOpen]);

    const selectedItemIdRef = useRef(selectedItemId);
    useEffect(() => { selectedItemIdRef.current = selectedItemId; }, [selectedItemId]);

    // ATAJOS DE TECLADO ESTABILIZADOS
    useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            const now = performance.now();
            const diff = now - lastKeyPressTime.current;
            lastKeyPressTime.current = now;

            // JALTECH POS 2D Omnidireccional: ráfagas de ~10-15ms entre chars
            const isFast = diff < 35;
            if (isFast) isScanningRef.current = true;

            const isSearchFocused = document.activeElement === searchRef.current;
            const isModalOpen = isModalOpenRef.current;

            // REGLA DE ORO: Pausar motor global en búsqueda o modales
            if (isSearchFocused && e.key !== 'Escape' && e.key !== 'Enter') return;
            if (isModalOpen && e.key !== 'Escape') return;

            // --- MOTOR DE CAJA ZERO-FRICTION ---
            if (['-', '+', '*', 'Delete', 'Backspace'].includes(e.key) || e.key === 'NumpadAdd') {
                if (e.key === 'Backspace' && scannerBufferRef.current.length > 0) {
                    setScannerBuffer(prev => prev.slice(0, -1));
                    e.preventDefault();
                    return;
                }

                e.preventDefault();

                if (e.key === '-') {
                    if (selectedItemIdRef.current) updateQuantity(selectedItemIdRef.current, -1);
                } else if (e.key === '+' || e.key === 'NumpadAdd') {
                    if (scannerBufferRef.current.length > 0) {
                        addMiscItem(scannerBufferRef.current);
                    } else if (searchQuery.length > 0) {
                        addMiscItem(searchQuery);
                    } else if (selectedItemIdRef.current) {
                        updateQuantity(selectedItemIdRef.current, 1);
                    }
                } else if (e.key === '*') {
                    if (scannerBufferRef.current.length > 0 && selectedItemIdRef.current) {
                        const newQty = parseFloat(scannerBufferRef.current);
                        if (!isNaN(newQty) && newQty > 0) {
                            setCartItemQuantity(selectedItemIdRef.current, newQty);
                            setScannerBuffer('');
                        }
                    }
                } else if (e.key === 'Backspace' || e.key === 'Delete') {
                    if (scannerBufferRef.current.length === 0 && selectedItemIdRef.current) {
                        removeFromCart(selectedItemIdRef.current);
                    }
                }
                return;
            }

            if (e.key === 'Enter') {
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

                if (showSuccessScreen) {
                    e.preventDefault();
                    setShowSuccessScreen(false);
                    return;
                }
                if (scannerBufferRef.current.length > 0) {
                    e.preventDefault();
                    if (autoSubmitTimer.current) clearTimeout(autoSubmitTimer.current);
                    handleCodeSubmit(scannerBufferRef.current);
                    setScannerBuffer('');
                    isScanningRef.current = false;
                    return;
                } else if (currentCart.length > 0) {
                    // Si no hay nada en el scanner pero hay items, Enter abre el pago
                    e.preventDefault();
                    setIsPaymentDialogOpen(true);
                    return;
                }
            }

            if (e.key === '=') {
                e.preventDefault();
                if (currentCart.length > 0) {
                    setIsPaymentDialogOpen(true);
                }
                return;
            }

            if (e.key === 'Escape') {
                if (showSuccessScreen) {
                    setShowSuccessScreen(false);
                } else {
                    setIsPaymentDialogOpen(false);
                    setIsClientDialogOpen(false);
                    setIsScannerOpen(false);
                    setIsManualWeightOpen(false);
                    setIsSplitDialogOpen(false);
                    setIsMissingItemOpen(false);
                }
                setScannerBuffer('');
                isScanningRef.current = false;
                if (isSearchFocused) searchRef.current?.blur();
                return;
            }

            if (e.key === ' ') {
                e.preventDefault();
                if (scannerBufferRef.current.length > 0) {
                    if (autoSubmitTimer.current) clearTimeout(autoSubmitTimer.current);
                    handleCodeSubmit(scannerBufferRef.current);
                    setScannerBuffer('');
                    isScanningRef.current = false;
                    setTimeout(() => setIsPaymentDialogOpen(true), 80);
                } else if (currentCart.length > 0) {
                    setIsPaymentDialogOpen(true);
                }
                return;
            }

            const isAlphanumeric = /^[a-zA-Z0-9.\-_/]$/.test(e.key);
            if (isAlphanumeric || isFast) {
                if (isFast || (!isSearchFocused && !isModalOpen)) {
                    if (isAlphanumeric) {
                        setScannerBuffer(prev => prev + e.key);
                        if (!isFast) isScanningRef.current = false;
                    }
                }
            }
        };

        window.addEventListener('keydown', handleGlobalKeyDown);

        const handleGlobalClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
            if (!isInput && !isModalOpenRef.current) {
                if (target.closest('button')) target.closest('button')?.blur();
                setTimeout(returnFocusToScanner, 50);
            }
        };

        window.addEventListener('mousedown', handleGlobalClick);

        return () => {
            window.removeEventListener('keydown', handleGlobalKeyDown);
            window.removeEventListener('mousedown', handleGlobalClick);
        };
    }, [handleCodeSubmit, addMiscItem, updateQuantity, setCartItemQuantity, removeFromCart, currentCart.length, showSuccessScreen, returnFocusToScanner, setIsPaymentDialogOpen, setShowSuccessScreen, setIsClientDialogOpen, setIsScannerOpen, setIsManualWeightOpen, setIsSplitDialogOpen, setIsMissingItemOpen, searchQuery]);

    // --- MOTOR DE RECUPERACIÓN DE FOCO (V9.5) ---
    useEffect(() => {
        const interval = setInterval(() => {
            const isModalOpen = isModalOpenRef.current;
            const isSearchFocused = document.activeElement === searchRef.current;
            
            // Si no hay modal, ni búsqueda, y perdimos el foco del "gate"
            if (!isModalOpen && !isSearchFocused && document.activeElement !== hiddenScannerRef.current) {
                returnFocusToScanner();
            }
        }, 1500);
        return () => clearInterval(interval);
    }, [returnFocusToScanner]);

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-zinc-950">
                <Spinner size="lg" color="success" />
            </div>
        );
    }

    const subtotal = total / 1.19;
    const iva = total - subtotal;

    return (
        <div className="flex flex-col h-full gap-1 p-1 bg-gray-100 dark:bg-zinc-950 overflow-hidden select-none transition-colors duration-500">
            {/* INPUT INVISIBLE PARA CAPTURA DE ESCÁNER FÍSICO */}
            <input
                ref={hiddenScannerRef}
                type="text"
                autoComplete="off"
                inputMode="none"
                className="absolute opacity-0 pointer-events-none scanner-gate"
                style={{ position: 'absolute', left: '-9999px', top: '0' }}
                tabIndex={-1}
            />

            <div id="pos-main-container" className="flex-1 flex flex-col gap-1 min-h-0 overflow-hidden relative">
                <div className="flex-[7] lg:flex-[5] flex flex-col lg:flex-row gap-1 min-h-0">
                    {/* PANEL IZQUIERDO: CARRITO */}
                    <div className="flex-1 flex flex-col rounded-lg border border-gray-200 dark:border-white/5 bg-white dark:bg-zinc-900 overflow-hidden shadow-sm min-h-0">
                        <div className="bg-gray-50 dark:bg-zinc-900/50 border-b border-gray-200 dark:border-white/5 p-2 shrink-0 flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                <div className="flex items-center flex-wrap gap-1.5 max-w-[500px]">
                                    {cartKeys.map((key) => {
                                        const isActive = activeCartKey === key;
                                        const custDni = cartCustomers[key] || '0';
                                        const cust = customers.find(c => c.dni === custDni);
                                        const custName = cust && cust.dni !== '0' ? cust.name.split(' ')[0] : '';
                                        return (
                                            <div key={key} className="group relative flex items-center shrink-0">
                                                <Button size="sm" variant="flat" className={`h-8 pl-2.5 pr-7 rounded-lg font-black text-[10px] sm:text-[11px] transition-all border ${isActive ? 'bg-emerald-500 text-white border-emerald-400 shadow-md shadow-emerald-500/20' : 'bg-white dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 border-gray-200 dark:border-white/5 hover:bg-gray-50 dark:hover:bg-zinc-700'}`} onPress={() => handleCartSwitch(key)}>
                                                    <span>{key.replace('Factura ', 'F')}</span>
                                                    {custName && <span className={`ml-1 text-[8px] font-bold truncate max-w-[50px] ${isActive ? 'text-white/80' : 'text-emerald-500'}`}>{custName}</span>}
                                                </Button>
                                                {cartKeys.length > 1 ? (
                                                    <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteCart(key); }} className={`absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded transition-all z-20 ${isActive ? 'text-white/60 hover:text-white hover:bg-white/20' : 'text-gray-300 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 opacity-0 group-hover:opacity-100'}`}>
                                                        <Trash2 size={10} />
                                                    </button>
                                                ) : null}
                                            </div>
                                        );
                                    })}
                                    <Button isIconOnly size="sm" variant="light" className="h-8 w-8 min-w-8 rounded-lg text-emerald-500 bg-emerald-50 dark:bg-emerald-500/5 hover:bg-emerald-500 hover:text-white transition-all shrink-0 border border-dashed border-emerald-200 dark:border-emerald-500/20" onPress={addNewCart}>
                                        <Plus size={20} strokeWidth={2.5} />
                                    </Button>
                                </div>
                            </div>

                            <div className="flex items-center gap-2">
                                {/* RESILIENCIA DE RED: INDICADOR HFT */}
                                <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md border shadow-sm transition-all ${isOffline ? 'bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/20 text-rose-600' : 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20 text-emerald-600'}`}>
                                    {isOffline ? <WifiOff className="h-3 w-3" /> : <Wifi className="h-3 w-3 animate-pulse" />}
                                    <div className="flex flex-col leading-none text-right">
                                        <span className="text-[7px] font-bold uppercase tracking-widest leading-none">{isOffline ? 'Sin Red' : 'Sincro'}</span>
                                        <span className="text-[9px] font-black">{isOffline ? 'OFFLINE' : 'ONLINE'}</span>
                                    </div>
                                </div>

                                <div onClick={handleScaleSync} className={`flex items-center gap-1.5 sm:gap-2 px-1.5 sm:px-2 py-1 rounded-md border shadow-sm transition-all cursor-pointer active:scale-95 ${isScaleReloading ? 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20 text-amber-600 animate-pulse' : isScaleOnline ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20 text-emerald-600 dark:text-emerald-500 hover:bg-emerald-100' : 'bg-gray-100 dark:bg-zinc-800 border-gray-200 dark:border-white/10 text-gray-400 dark:text-zinc-500 opacity-50'}`}>
                                    <Scale className={`h-3 w-3 ${isScaleOnline && !isScaleReloading ? 'animate-pulse' : ''}`} />
                                    <div className="flex flex-col leading-none text-right">
                                        <span className="hidden sm:block text-[7px] font-bold uppercase tracking-widest leading-none">{isScaleReloading ? 'Esperando...' : isScaleOnline ? 'Sincronizar' : 'Offline'}</span>
                                        <span className="text-[9px] sm:text-[10px] font-black tabular-nums">{isScaleReloading ? '---' : isScaleOnline ? `${scaleWeight.toFixed(3)} kg` : '---'}</span>
                                    </div>
                                </div>
                                <Button size="sm" variant="flat" onPress={() => setIsClientDialogOpen(true)} className="h-8 px-2 sm:px-3 rounded-md font-bold text-[10px] uppercase bg-sky-50 dark:bg-sky-500/10 text-sky-600 dark:text-sky-500 hover:bg-sky-100 border border-sky-200 dark:border-sky-500/20">
                                    <User size={20} strokeWidth={2.5} className="sm:mr-1.5" /> <span className="hidden sm:inline italic">CLIENTE</span>
                                </Button>
                                <Button size="sm" variant="flat" onPress={() => setIsSplitDialogOpen(true)} isDisabled={currentCart.length === 0} className="h-8 px-2 sm:px-3 rounded-md font-bold text-[10px] uppercase bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-500 hover:bg-amber-100 border border-amber-200 dark:border-amber-500/20">
                                    <Grid size={20} strokeWidth={2.5} className="sm:mr-1.5" /> <span className="hidden sm:inline">Dividir</span>
                                </Button>
                            </div>
                        </div>

                        <div className="flex-1 overflow-hidden flex flex-col min-h-0 bg-white dark:bg-zinc-900/40">
                            <div className="flex-1 overflow-y-auto custom-scrollbar px-1 [scrollbar-gutter:stable]">
                                <Table
                                    aria-label="Carrito"
                                    isCompact
                                    selectionMode="none"
                                    classNames={{
                                        th: "bg-gray-50 dark:bg-zinc-800/80 text-gray-500 font-bold uppercase text-[8px] sm:text-[9px] tracking-widest sticky top-0 z-10 border-b border-gray-200 h-7 sm:h-8 py-0.5 sm:py-1",
                                        td: "py-0.5 sm:py-1 font-medium border-b border-gray-100 dark:border-white/5",
                                        tr: "hover:bg-gray-50 dark:hover:bg-zinc-800/50 cursor-pointer transition-colors"
                                    }}
                                >
                                    <TableHeader>
                                        <TableColumn>ARTÍCULO</TableColumn>
                                        <TableColumn align="center">PVP</TableColumn>
                                        <TableColumn align="center">CANT</TableColumn>
                                        <TableColumn align="end">TOTAL</TableColumn>
                                        <TableColumn align="center" width={30}> </TableColumn>
                                    </TableHeader>
                                    <TableBody emptyContent={<div className="py-10 text-gray-400 text-xs font-bold uppercase tracking-widest text-center">Carrito vacío</div>}>
                                        {currentCart.map((item) => (
                                            <TableRow 
                                                key={item.cartItemId} 
                                                onClick={() => setSelectedItemId(item.cartItemId)}
                                                className={selectedItemId === item.cartItemId ? 'bg-emerald-500/10 dark:bg-emerald-500/20 border-l-4 border-emerald-500' : ''}
                                            >
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
                                                        <Button isIconOnly color="danger" variant="light" size="sm" className="h-6 w-6 min-w-6 hover:bg-rose-100" onPress={() => { removeFromCart(item.cartItemId); returnFocusToScanner(); }}>
                                                            <Trash2 size={18} className="text-rose-500" strokeWidth={2.5} />
                                                        </Button>
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        </div>

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
                                <div className="text-2xl font-black text-gray-900 dark:text-white tabular-nums leading-none tracking-tighter flex overflow-hidden h-7 items-center">
                                    <span className="mr-1">$</span>
                                    <AnimatePresence mode="wait">
                                        <motion.span
                                            key={total}
                                            initial={{ y: 10, opacity: 0 }}
                                            animate={{ y: 0, opacity: 1 }}
                                            exit={{ y: -10, opacity: 0 }}
                                            transition={{ duration: 0.15, ease: "easeOut" }}
                                        >
                                            {formatCurrency(total)}
                                        </motion.span>
                                    </AnimatePresence>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* PANEL DERECHO: TECLADO Y ESCÁNER */}
                    <aside className="w-[260px] flex flex-col shrink-0">
                        <div className="flex-1 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-lg p-2 shadow-sm flex flex-col gap-1">
                            <div className="flex items-center gap-1 bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/5 px-2 py-1 rounded-md shadow-inner h-10 shrink-0">
                                <Barcode className="h-4 w-4 text-emerald-600 shrink-0" />
                                <div className="relative flex-1 h-8 flex items-center px-1">
                                    <div className="font-mono font-bold text-xs text-gray-900 dark:text-emerald-500 bg-transparent flex-1 truncate">
                                        {scannerBuffer || (feedbackCode ? "" : "ESPERANDO ESCÁNER...")}
                                    </div>
                                    {!scannerBuffer && feedbackCode && (
                                        <div className={`absolute left-0 pointer-events-none font-mono font-bold text-xs italic ${isFeedbackError ? 'text-rose-400' : 'text-emerald-500/50'} animate-out fade-out duration-1000 fill-mode-forwards`}>
                                            {isFeedbackError ? 'ERROR: ' : 'VISTO: '}{feedbackCode}
                                        </div>
                                    )}
                                </div>
                                <Button isIconOnly size="sm" variant="flat" className="h-7 w-7 min-w-7 rounded bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-500 hover:bg-emerald-500 hover:text-white transition-colors" onPress={() => { setIsScannerOpen(true); returnFocusToScanner(); }}>
                                    <Camera className="h-3.5 w-3.5" />
                                </Button>
                                <Button isIconOnly size="sm" variant="flat" className="h-7 w-7 min-w-7 rounded bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-500 hover:bg-rose-500 hover:text-white transition-colors" onPress={() => { setIsMissingItemOpen(true); returnFocusToScanner(); }}>
                                    <AlertTriangleIcon className="h-3.5 w-3.5" />
                                </Button>
                            </div>

                            <div className="grid grid-cols-4 gap-1 flex-1 mt-1">
                                <Button color="danger" variant="flat" className="h-full min-h-[40px] rounded-md font-bold text-xs" onPress={() => { setScannerBuffer(''); returnFocusToScanner(); }}>CE</Button>
                                <Button variant="flat" className="h-full min-h-[40px] rounded-md font-bold text-base bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white" onPress={() => { setScannerBuffer(p => p + '*'); returnFocusToScanner(); }}>*</Button>
                                <Button variant="flat" className="h-full min-h-[40px] rounded-md font-bold text-xl bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white leading-none" onPress={() => { if (selectedItemId) updateQuantity(selectedItemId, -1); returnFocusToScanner(); }}>-</Button>
                                <Button variant="flat" className="h-full min-h-[40px] rounded-md font-bold text-xl bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white leading-none" onPress={() => {
                                    if (selectedItemId) {
                                        updateQuantity(selectedItemId, 1);
                                    }
                                    returnFocusToScanner();
                                }}>+</Button>

                                <div className="col-span-3 grid grid-cols-3 gap-1">
                                    {['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '.'].map(n => (
                                        <Button key={n} variant="bordered" className={`h-full min-h-[40px] rounded-md text-base font-bold bg-gray-50 dark:bg-zinc-950 border-gray-200 dark:border-white/5 text-gray-900 dark:text-white hover:border-emerald-500 ${n === '0' ? 'col-span-2' : ''}`} onPress={() => { setScannerBuffer(p => p + n); returnFocusToScanner(); }}>{n}</Button>
                                    ))}
                                </div>
                                <Button 
                                    className="col-span-1 h-full min-h-[40px] rounded-md font-black text-2xl text-white bg-emerald-500 hover:bg-emerald-600 shadow-sm" 
                                    onPress={() => { 
                                        if (scannerBuffer.length > 0) {
                                            handleCodeSubmit(scannerBuffer);
                                            setScannerBuffer('');
                                        } else if (currentCart.length > 0) {
                                            setIsPaymentDialogOpen(true); 
                                        }
                                        returnFocusToScanner();
                                    }} 
                                    isDisabled={currentCart.length === 0 && scannerBuffer.length === 0}
                                >
                                    =
                                </Button>
                            </div>
                        </div>
                    </aside>
                </div>

                {/* SECCIÓN INFERIOR: CATEGORÍAS Y PRODUCTOS */}
                <div className="flex-[3] lg:flex-[4] flex gap-1 min-h-0 bg-white dark:bg-zinc-900 rounded-lg p-1 border border-gray-200 dark:border-white/5 shadow-sm">
                    <aside className="w-28 shrink-0 flex flex-col gap-1 overflow-y-auto custom-scrollbar pr-1">
                        <Button size="sm" className={`justify-start h-8 min-h-[32px] rounded-md font-bold text-[9px] px-2 ${selectedCategory === 'all' ? 'bg-emerald-500 text-white' : 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-400 hover:bg-gray-200'}`} onPress={() => { setSelectedCategory('all'); returnFocusToScanner(); }}>TODOS</Button>
                        {categories.map(cat => (
                            <Button key={cat.id} size="sm" className={`justify-start h-8 min-h-[32px] rounded-md font-bold text-[9px] uppercase truncate px-2 ${selectedCategory === String(cat.id) ? 'bg-emerald-500 text-white' : 'bg-gray-100 dark:bg-zinc-800 text-gray-600 hover:bg-gray-200'}`} onPress={() => { setSelectedCategory(String(cat.id)); returnFocusToScanner(); }}>{cat.name}</Button>
                        ))}
                    </aside>

                    <section className="flex-1 flex flex-col overflow-hidden min-h-0 bg-gray-50 dark:bg-zinc-950 rounded-md border border-gray-200 dark:border-white/5">
                        <div className="p-1.5 border-b border-gray-200 dark:border-white/5 bg-white dark:bg-zinc-900/50 shrink-0">
                            <Input size="sm" placeholder="BUSCAR PRODUCTO..." value={searchQuery} onValueChange={setSearchQuery} ref={searchRef} startContent={<Search className="text-gray-400 h-3 w-3" />} classNames={{ inputWrapper: "bg-gray-100 dark:bg-zinc-950 border-transparent h-8 min-h-[32px] rounded-md", input: "text-[10px] font-bold uppercase text-gray-900 dark:text-white" }} />
                        </div>
                        <ProductGrid
                            products={filteredProductsGrid}
                            addToCart={(p) => { addToCart(p); returnFocusToScanner(); }}
                        />
                    </section>
                </div>
            </div>

            {/* MODALES DINÁMICOS */}
            <UniversalPaymentModal isOpen={isPaymentDialogOpen} onOpenChange={setIsPaymentDialogOpen} title="Cobrar Venta" client={selectedCustomer} totalToPay={total} showSuccessScreen={showSuccessScreen} submittingPayment={submitting} lastChange={lastChange} onPay={handleConfirmSale} onCloseComplete={returnFocusToScanner} />
            <ClientSelectionModal isOpen={isClientDialogOpen} onOpenChange={(open) => { setIsClientDialogOpen(open); if (!open) setTimeout(returnFocusToScanner, 100); }} clientSearch={clientSearch} setClientSearch={setClientSearch} filteredCustomers={filteredCustomers} handleClientSelect={handleClientSelect} selectedClientDni={selectedCustomerDni} />
            <ManualWeightModal isOpen={isManualWeightOpen} onOpenChange={(open) => { setIsManualWeightOpen(open); if (!open) setTimeout(returnFocusToScanner, 100); }} manualWeightProduct={manualWeightProduct} manualWeightValue={manualWeightValue} setManualWeightValue={setManualWeightValue} confirmManualWeight={confirmManualWeight} />
            <ScannerOverlay isOpen={isScannerOpen} onClose={() => setIsScannerOpen(false)} onResult={(res) => { handleCodeSubmit(res); setIsScannerOpen(false); }} title="Escáner POS" />
            <SplitBillDialog
                isOpen={isSplitDialogOpen}
                onClose={() => setIsSplitDialogOpen(false)}
                originalItems={currentCart}
                customers={customers}
                currentCustomerDni={selectedCustomerDni}
                onConfirm={(l, r, targetDni) => {
                    setOriginalCustomerDniBeforeSplit(selectedCustomerDni);
                    setRemainingItemsAfterSplit(l);
                    setSplitItemsToPay(r);
                    handleClientSelect(targetDni);
                    setIsSplitDialogOpen(false);
                    setIsPaymentDialogOpen(true);
                }}
            />
            <MissingItemModal isOpen={isMissingItemOpen} onOpenChange={(open) => { setIsMissingItemOpen(open); if (!open) setTimeout(returnFocusToScanner, 100); }} />

            {/* Modal de Confirmación de Eliminación de Factura (V8.5) */}
            <Modal 
                isOpen={isDeleteCartConfirmOpen} 
                onOpenChange={setIsDeleteCartConfirmOpen}
                backdrop="blur"
                classNames={{
                    base: "border-[#f43f5e] border-2 bg-zinc-950",
                    header: "border-b border-white/10",
                    footer: "border-t border-white/10",
                }}
            >
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex flex-col gap-1 text-rose-500 font-black italic">
                                <div className="flex items-center gap-2">
                                    <AlertTriangleIcon size={24} />
                                    ¿ELIMINAR FACTURA?
                                </div>
                            </ModalHeader>
                            <ModalBody>
                                <p className="text-white font-bold">
                                    Esta factura contiene productos registrados. Si la elimina, se perderán los cambios y esto podría afectar la trazabilidad de su inventario.
                                </p>
                                <p className="text-zinc-400 text-xs italic">
                                    ¿Está seguro de que desea proceder con la eliminación total?
                                </p>
                            </ModalBody>
                            <ModalFooter>
                                <Button variant="light" onPress={onClose} className="font-black text-white">
                                    CANCELAR
                                </Button>
                                <Button 
                                    color="danger" 
                                    onPress={() => {
                                        confirmDeleteCart();
                                        onClose();
                                    }}
                                    className="font-black italic shadow-lg shadow-rose-500/20"
                                >
                                    SÍ, ELIMINAR FACTURA
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>
        </div>
    );
}