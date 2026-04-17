"use client";

import {
    Modal, ModalContent, Button
} from "@heroui/react";
import { 
    Banknote, Wallet, History as HistoryIcon, User, Zap, ChevronDown, Check as CheckIcon 
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import Cookies from 'js-cookie';
import { Sale } from '@/lib/definitions';
import { useToast } from '@/hooks/use-toast';
import { extractApiError } from '@/lib/api-error';

interface SaleEditModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    sale: Sale | null;
    customers: any[];
    onClientSelectorOpen: () => void;
    onSuccess: (change: number) => void;
}

export default function SaleEditModal({ 
    isOpen, 
    onOpenChange, 
    sale, 
    customers, 
    onClientSelectorOpen,
    onSuccess 
}: SaleEditModalProps) {
    const { toast } = useToast();
    const [activeTab, setActiveTab] = useState<'cash' | 'NEQUI' | 'DAVIPLATA' | 'credit'>('cash');
    const [cashPaid, setCashPaid] = useState('0');
    const [transferPaid, setTransferPaid] = useState('0');
    const [creditPaid, setCreditPaid] = useState('0');
    const [transferSource, setTransferSource] = useState('NEQUI');
    const [dialogAmount, setDialogAmount] = useState('');
    const [isUpdating, setIsUpdating] = useState(false);
    const [showSuccessScreen, setShowSuccessScreen] = useState(false);
    const [lastChange, setLastChange] = useState(0);

    // Sincronizar estado inicial cuando se abre el modal
    useEffect(() => {
        if (isOpen && sale) {
            const source = sale.transferSource || 'NEQUI';
            setTransferSource(source);
            if (sale.transferAmount > 0) setActiveTab(source as any);
            else if (sale.creditAmount > 0) setActiveTab('credit');
            else setActiveTab('cash');
            
            setCashPaid(String(sale.cashAmount || 0));
            setTransferPaid(String(sale.transferAmount || 0));
            setCreditPaid(String(sale.creditAmount || 0));
            setDialogAmount('');
            setShowSuccessScreen(false);
        }
    }, [isOpen, sale]);

    const total = sale?.total || 0;
    const numCashStored = Number(cashPaid) || 0;
    const numTransfer = Number(transferPaid) || 0;
    const numCredit = Number(creditPaid) || 0;
    const numManual = Number(dialogAmount) || 0;

    const totalPaidForDisplays = numManual + numCashStored + numTransfer + numCredit;
    const remaining = Math.max(0, total - totalPaidForDisplays);
    const change = Math.max(0, totalPaidForDisplays - total);
    
    const isReadyToFinalize = (activeTab === 'cash' && numManual >= remaining) || 
                             (numManual === 0 && (activeTab === 'cash' || activeTab === 'NEQUI' || activeTab === 'DAVIPLATA') && remaining > 0) || 
                             remaining === 0;

    const handleSaveEdit = async (manualValOverride?: number) => {
        if (!sale) return;
        setIsUpdating(true);
        try {
            const manualVal = manualValOverride !== undefined ? manualValOverride : (Number(dialogAmount) || 0);
            let numCash = Number(cashPaid) || 0;
            let numTrans = Number(transferPaid) || 0;
            let numCred = Number(creditPaid) || 0;
            let payloadSource = transferSource;

            if (manualVal > 0) {
                if (activeTab === 'cash') numCash += manualVal;
                else if (activeTab === 'NEQUI' || activeTab === 'DAVIPLATA') {
                    numTrans += manualVal;
                    payloadSource = activeTab;
                }
                else if (activeTab === 'credit') numCred += manualVal;
            }

            const currentSubtotal = numCash + numTrans + numCred;
            const pendingRemainder = total - currentSubtotal;

            if (pendingRemainder > 0) {
                if (activeTab === 'cash') numCash += pendingRemainder;
                else if (activeTab === 'NEQUI' || activeTab === 'DAVIPLATA') {
                    numTrans += pendingRemainder;
                    payloadSource = activeTab;
                }
                else if (activeTab === 'credit') numCred += pendingRemainder;
            }

            const totalPaid = numCash + numTrans + numCred;
            const finalChange = Math.max(0, totalPaid - (sale.total || 0));
            
            const payload = {
                clientDni: sale.client?.dni || '0',
                paymentMethod: numCred > 0 ? "FIADO" : (numCash > 0 && numTrans > 0 ? "MIXTO" : numTrans > 0 ? "TRANSFERENCIA" : "EFECTIVO"),
                cashAmount: numCash,
                transferAmount: numTrans,
                transferSource: payloadSource,
                creditAmount: numCred,
                amountPaid: totalPaid,
                change: finalChange
            };

            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api'}/sales/update-payment/${sale.id}`, {
                method: 'PUT',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${Cookies.get('org-pos-token')}` 
                },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errorMsg = await extractApiError(res, "Error al actualizar pago");
                throw new Error(errorMsg);
            }
            
            setLastChange(finalChange);
            setShowSuccessScreen(true);
            setDialogAmount('');
            toast({ title: "✓ Actualizado", description: "El método de pago ha sido corregido." });
            onSuccess(finalChange);
        } catch (err: any) {
            toast({ variant: "destructive", title: "Error", description: err.message || "Error al actualizar pago" });
        } finally {
            setIsUpdating(false);
        }
    };

    const handleNumpadAction = useCallback(() => {
        const val = numManual > 0 ? numManual : remaining;
        
        if (isReadyToFinalize) {
            handleSaveEdit(numManual > 0 ? numManual : undefined);
        } else if (val > 0) {
            if (activeTab === 'cash') {
                setCashPaid(String((Number(cashPaid) || 0) + val));
            } else if (activeTab === 'NEQUI' || activeTab === 'DAVIPLATA') {
                setTransferPaid(String((Number(transferPaid) || 0) + val));
                setTransferSource(activeTab);
                setActiveTab('cash');
            } else if (activeTab === 'credit') {
                setCreditPaid(String((Number(creditPaid) || 0) + val));
                setActiveTab('cash');
            }
            setDialogAmount('');
        }
    }, [numManual, remaining, isReadyToFinalize, activeTab, cashPaid, transferPaid, creditPaid, sale]);

    // Soporte para teclado físico
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key >= '0' && e.key <= '9') {
                setDialogAmount(prev => prev + e.key);
            } else if (e.key === 'Backspace') {
                setDialogAmount(prev => prev.slice(0, -1));
            } else if (e.key === 'Enter') {
                handleNumpadAction();
            } else if (e.key === '.') {
                if (!dialogAmount.includes('.')) setDialogAmount(prev => prev + '.');
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, dialogAmount, handleNumpadAction]);

    const handleResetPayments = () => {
        setCashPaid('0');
        setTransferPaid('0');
        setCreditPaid('0');
        setDialogAmount('');
        setActiveTab('cash');
        toast({ title: "Pagos Reiniciados", description: "Puedes ingresar los montos desde cero." });
    };

    if (!sale) return null;

    const selectedCustomer = sale.client || { name: 'Consumidor Final' };

    return (
        <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            size="full"
            backdrop="blur"
            classNames={{
                base: "bg-gray-100 dark:bg-zinc-950 border border-gray-300 dark:border-white/5 rounded-none md:rounded-[2rem] w-[100vw] md:w-[95vw] max-w-[1000px] h-[100vh] md:h-auto md:max-h-[85vh] overflow-hidden",
                header: "hidden",
                body: "p-0",
                footer: "hidden",
                closeButton: "hidden"
            }}
        >
            <ModalContent className="flex flex-col p-0 overflow-hidden">
                {(onClose) => (
                    <div className="flex flex-col lg:flex-row h-full min-h-0 lg:min-h-[400px] relative overflow-y-auto lg:overflow-hidden custom-scrollbar">
                        {showSuccessScreen && (
                            <div className="absolute inset-0 z-[100] bg-white dark:bg-zinc-950 flex flex-col items-center justify-center p-8 animate-in fade-in zoom-in duration-300">
                                <div className="h-28 w-28 rounded-full bg-emerald-500 text-white flex items-center justify-center mb-8 shadow-2xl shadow-emerald-500/40">
                                    <CheckIcon className="h-14 w-14 stroke-[4]" />
                                </div>
                                <h2 className="text-4xl font-black text-gray-900 dark:text-white uppercase tracking-tighter italic mb-2">Corrección Maestro</h2>
                                <p className="text-[10px] font-black text-emerald-600 uppercase tracking-[0.4em] mb-12">Pago Actualizado Correctamente</p>

                                <div className="bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/5 px-20 py-12 rounded-[3rem] text-center shadow-2xl mb-12">
                                    <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-6">CAMBIO DEFINITIVO</p>
                                    <p className="text-[6rem] font-black text-emerald-600 tabular-nums leading-none tracking-tighter italic">${lastChange.toLocaleString()}</p>
                                </div>
                                <Button 
                                    className="h-20 px-16 font-black text-xl uppercase rounded-[2rem] shadow-2xl bg-emerald-600 text-white hover:bg-emerald-500 active:scale-95 transition-all italic tracking-widest" 
                                    onPress={() => window.location.reload()}
                                >
                                    FINALIZAR (ENTER)
                                </Button>
                            </div>
                        )}
                        
                        {/* COLUMNA 1: TABS (Sidebar) */}
                        <div className="w-full lg:w-[240px] bg-white dark:bg-zinc-900 border-b lg:border-r lg:border-b-0 border-gray-200 dark:border-white/5 p-4 pt-16 lg:pt-8 lg:p-8 flex flex-row lg:flex-col gap-2 overflow-x-auto lg:overflow-y-auto shrink-0 custom-scrollbar sticky top-0 z-10">
                            <div className="hidden lg:flex items-center gap-3 mb-6 px-1">
                                <div className="bg-emerald-500/10 p-2 rounded-xl text-emerald-500 -rotate-3">
                                    <Zap size={18} />
                                </div>
                                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest leading-none">Cajero Maestro</span>
                            </div>
                            <h3 className="hidden lg:block text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-4 pl-1 italic">CORRECCIÓN PAGO</h3>
                            {[
                                { id: 'cash', label: 'Efectivo', icon: Banknote, color: 'emerald' },
                                { id: 'NEQUI', label: 'Nequi', logo: '/logos/nequi.png', color: 'pink' },
                                { id: 'DAVIPLATA', label: 'Daviplata', logo: '/logos/daviplata.png', color: 'red' },
                                { id: 'credit', label: 'Fiado', icon: Wallet, color: 'rose' }
                            ].map((tab: any) => (
                                <button
                                    key={tab.id}
                                    onClick={() => {
                                        setActiveTab(tab.id as any);
                                        if (tab.id === 'NEQUI' || tab.id === 'DAVIPLATA') {
                                            setTransferSource(tab.id);
                                        }
                                    }}
                                    className={`h-11 lg:h-14 px-4 rounded-2xl flex items-center gap-3 border transition-all shrink-0 font-black uppercase text-[10px] tracking-[0.1em] ${
                                        activeTab === tab.id
                                        ? `bg-emerald-500/10 dark:bg-emerald-500/20 border-emerald-500/50 text-emerald-600 dark:text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.15)] italic`
                                        : 'border-transparent text-gray-500 hover:bg-gray-50 dark:hover:bg-zinc-800/50'
                                    }`}
                                >
                                    {tab.logo ? <img src={tab.logo} className="h-5 w-5 object-contain rounded-md" /> : <tab.icon size={18} className={activeTab === tab.id ? 'text-emerald-500 animate-pulse' : ''} />}
                                    {tab.label}
                                </button>
                            ))}

                            <div className="mt-auto pt-4 border-t border-gray-200 dark:border-white/5 flex flex-col gap-2">
                                <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest pl-1">Acciones</p>
                                <Button size="sm" variant="flat" color="warning" className="w-full justify-start h-10 px-3 rounded-lg font-bold text-[10px] uppercase bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-500 hover:bg-amber-100 border border-amber-200 dark:border-amber-500/20" onPress={handleResetPayments}>
                                    <HistoryIcon className="h-4 w-4 mr-2" /> Limpiar Pagos
                                </Button>
                                <button 
                                    className="w-full h-14 px-4 rounded-2xl flex items-center gap-3 border border-sky-100 dark:border-sky-500/20 bg-sky-50 dark:bg-sky-500/10 text-sky-600 dark:text-sky-500 hover:bg-sky-100 transition-all font-black uppercase text-[10px] tracking-widest italic" 
                                    onClick={onClientSelectorOpen}
                                >
                                    <div className="bg-sky-500/20 p-2 rounded-xl shrink-0">
                                        <User size={16} />
                                    </div>
                                    <span className="truncate">{selectedCustomer.name}</span>
                                </button>
                                <button 
                                    className="w-full h-14 font-black uppercase text-[10px] tracking-widest rounded-2xl bg-rose-50 dark:bg-rose-500/10 text-rose-500 hover:bg-rose-100 transition-all border border-rose-100 dark:border-rose-500/20" 
                                    onClick={onClose}
                                >
                                    Cancelar
                                </button>
                            </div>
                        </div>

                        {/* COLUMNA 2: CONTENIDO CENTRAL */}
                        <div className="flex-1 bg-gray-50 dark:bg-zinc-950 flex flex-col p-8 min-h-0">
                            <div className="flex flex-col md:flex-row gap-4 mb-8">
                                <div className="bg-white dark:bg-zinc-900 p-8 rounded-[2rem] border border-gray-200 dark:border-white/5 flex-1 shadow-2xl flex items-center gap-6">
                                    <div className="bg-gray-100 dark:bg-zinc-800 p-4 rounded-3xl text-gray-400">
                                        <Banknote size={32} strokeWidth={2.5} />
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.3em] mb-1">TOTAL VENTA</p>
                                        <p className="text-4xl font-black text-gray-900 dark:text-white tabular-nums tracking-tighter italic">${total.toLocaleString()}</p>
                                    </div>
                                </div>
                                <div className={`${remaining > 0 ? 'bg-sky-500 text-white' : 'bg-emerald-600 text-white'} p-8 rounded-[2rem] flex-1 shadow-2xl transition-all flex items-center gap-6`}>
                                    <div className="bg-white/20 p-4 rounded-3xl">
                                        <Zap size={32} strokeWidth={2.5} />
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-black text-white/70 uppercase tracking-[0.3em] mb-1">{remaining > 0 ? 'PENDIENTE' : 'PAGADO OK'}</p>
                                        <p className="text-4xl font-black tabular-nums tracking-tighter italic">${remaining.toLocaleString()}</p>
                                    </div>
                                </div>
                            </div>

                            {activeTab === 'cash' ? (
                                <div className="flex flex-col flex-1 gap-4 lg:gap-0">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8 lg:flex-1">
                                        <div className="bg-white dark:bg-zinc-900 p-8 rounded-[2rem] border border-gray-200 dark:border-white/5 flex-1 flex items-center gap-6 shadow-xl">
                                            <div className="bg-emerald-500/10 p-4 rounded-3xl text-emerald-500">
                                                <Banknote size={24} />
                                            </div>
                                            <div>
                                                <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-1">RECIBIDO</p>
                                                <p className="text-3xl font-black text-gray-900 dark:text-white tabular-nums italic">${numCashStored.toLocaleString()}</p>
                                            </div>
                                        </div>
                                        <div className="bg-white dark:bg-zinc-900 p-8 rounded-[2rem] border border-gray-200 dark:border-white/5 flex-1 flex items-center gap-6 shadow-xl">
                                            <div className="bg-emerald-500 text-white p-4 rounded-3xl shadow-lg shadow-emerald-500/20">
                                                <Zap size={24} />
                                            </div>
                                            <div>
                                                <p className="text-[10px] font-black text-emerald-600 uppercase tracking-[0.2em] mb-1">CAMBIO</p>
                                                <p className="text-3xl font-black text-emerald-600 tabular-nums italic">${change.toLocaleString()}</p>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-3 gap-3">
                                        {[
                                            { v: 100000, img: '/logos/100.000.jpg' },
                                            { v: 50000, img: '/logos/50.000.jpg' },
                                            { v: 20000, img: '/logos/20.000.jpg' },
                                            { v: 10000, img: '/logos/10.000.jpg' },
                                            { v: 5000, img: '/logos/5.000.jpg' },
                                            { v: 2000, img: '/logos/2.000.png' }
                                        ].map(bill => (
                                            <button
                                                key={bill.v}
                                                className="h-20 bg-white dark:bg-zinc-900 hover:ring-2 hover:ring-emerald-500 rounded-2xl overflow-hidden border border-gray-200 dark:border-white/10 transition-all active:scale-95 shadow-sm"
                                                onClick={() => setDialogAmount(prev => String(Number(prev || 0) + bill.v))}
                                            >
                                                <img src={bill.img} alt={`$${bill.v}`} className="w-full h-full object-cover" />
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center flex-1">
                                    {activeTab === 'NEQUI' || activeTab === 'DAVIPLATA' ? (
                                        <div className="flex flex-col items-center justify-center animate-in fade-in zoom-in duration-500">
                                            <div className="h-48 w-48 mb-6 flex items-center justify-center bg-white dark:bg-zinc-900 rounded-[2.5rem] shadow-2xl border border-gray-100 dark:border-white/5 p-8">
                                                <img 
                                                    src={activeTab === 'NEQUI' ? '/logos/nequi.png' : '/logos/daviplata.png'} 
                                                    className="w-full h-full object-contain filter drop-shadow-xl" 
                                                    alt={activeTab}
                                                />
                                            </div>
                                            <div className="flex items-center gap-3 mb-2">
                                                <div className="bg-emerald-500/10 p-2 rounded-xl text-emerald-500 -rotate-3">
                                                    <Zap size={18} />
                                                </div>
                                                <h3 className="text-2xl font-black uppercase text-gray-900 dark:text-white tracking-tight italic">{activeTab}</h3>
                                            </div>
                                            <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.4em] mb-8">PAGO ELECTRÓNICO</p>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col items-center justify-center animate-in fade-in zoom-in duration-500">
                                            <div className="h-48 w-48 mb-6 flex items-center justify-center bg-white dark:bg-zinc-900 rounded-[2.5rem] shadow-2xl border border-gray-100 dark:border-white/5 p-8">
                                                <div className="bg-rose-500 text-white p-6 rounded-[2rem] -rotate-3 shadow-xl shadow-rose-500/20">
                                                    <Zap size={48} strokeWidth={2.5} />
                                                </div>
                                            </div>
                                            <h3 className="text-2xl font-black uppercase text-gray-900 dark:text-white tracking-tight italic mb-1">CRÉDITO / FIADO</h3>
                                            <p className="text-[10px] font-black text-rose-500 uppercase tracking-[0.4em] mb-8">DEUDA PENDIENTE</p>
                                        </div>
                                    )}
                                    <div className="bg-white dark:bg-zinc-900 px-12 py-6 rounded-[2rem] border border-gray-200 dark:border-white/5 shadow-2xl group transition-all hover:scale-105">
                                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-2 group-hover:text-emerald-500 text-center">MONTO ACTUAL REGISTRADO</p>
                                        <p className="text-4xl font-black text-gray-900 dark:text-white tabular-nums italic text-center text-emerald-600">${(activeTab === 'NEQUI' || activeTab === 'DAVIPLATA' ? numTransfer : numCredit).toLocaleString()}</p>
                                    </div>
                                    <p className="text-[10px] text-gray-400 font-black uppercase tracking-[0.3em] mt-12 animate-pulse italic">Usa el teclado numérico para actualizar</p>
                                </div>
                            )}
                        </div>

                        {/* COLUMNA 3: NUMPAD */}
                        <div className="w-full lg:w-[320px] bg-white dark:bg-zinc-900 border-t lg:border-l lg:border-t-0 border-gray-200 dark:border-white/5 p-8 flex flex-col gap-6 lg:min-h-0">
                            <div className="bg-gray-50 dark:bg-zinc-950 p-6 rounded-[2rem] border border-gray-200 dark:border-white/5 text-right shadow-inner flex flex-col justify-center items-end min-h-[100px]">
                                <p className="text-[10px] font-black text-emerald-600 uppercase tracking-[0.3em] mb-2">MONTO MANUAL</p>
                                <p className="text-4xl font-black text-gray-900 dark:text-white tabular-nums italic">{dialogAmount ? `$${Number(dialogAmount).toLocaleString()}` : '$0'}</p>
                            </div>
                            <div className="grid grid-cols-3 gap-3 flex-1">
                                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '00', 'CE'].map(n => (
                                    <button 
                                        key={n} 
                                        className={`h-16 lg:h-full text-2xl font-black rounded-2xl transition-all active:scale-95 ${
                                            n === 'CE' 
                                            ? 'text-rose-500 bg-rose-50 dark:bg-rose-500/10 border border-rose-100 dark:border-rose-500/20' 
                                            : 'text-gray-900 dark:text-white bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-white/5 hover:bg-gray-100'
                                        }`}
                                        onClick={() => n === 'CE' ? setDialogAmount('') : setDialogAmount((p: string) => p + String(n))}
                                    >
                                        {n}
                                    </button>
                                ))}
                            </div>
                            <button 
                                className={`h-24 font-black text-2xl uppercase rounded-[2rem] shadow-2xl transition-all active:scale-95 flex items-center justify-center gap-4 italic tracking-widest ${
                                    isReadyToFinalize 
                                    ? 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-emerald-500/40' 
                                    : 'bg-sky-600 text-white hover:bg-sky-500 shadow-sky-500/40'
                                }`}
                                disabled={isUpdating}
                                onClick={handleNumpadAction}
                            >
                                {isUpdating ? (
                                    <div className="h-8 w-8 border-4 border-white/30 border-t-white rounded-full animate-spin" />
                                ) : (
                                    <>
                                        {isReadyToFinalize ? 'FINALIZAR' : 'CARGAR'}
                                        <Zap size={24} className="fill-current" />
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                )}
            </ModalContent>
        </Modal>
    );
}
