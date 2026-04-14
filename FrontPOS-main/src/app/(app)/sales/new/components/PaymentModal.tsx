"use client";

import {
    Modal, ModalContent, Button
} from "@heroui/react";
import { formatCurrency } from "@/lib/utils";
import { Customer } from "@/lib/definitions";
import { User, Check, Zap, Banknote, Users } from "lucide-react";

interface PaymentModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    showSuccessScreen: boolean;
    setShowSuccessScreen: (show: boolean) => void;
    lastChange: number;
    total: number;
    remaining: number;
    activePaymentTab: 'cash' | 'NEQUI' | 'DAVIPLATA' | 'credit';
    setActivePaymentTab: (tab: 'cash' | 'NEQUI' | 'DAVIPLATA' | 'credit') => void;
    dialogAmount: string;
    setDialogAmount: (val: string | ((prev: string) => string)) => void;
    displayTendered: number;
    displayChange: number;
    selectedCustomer: Customer;
    isReadyToFinalize: boolean;
    submitting: boolean;
    handleNumpadAction: () => void;
    setIsClientDialogOpen: (open: boolean) => void;
    onCloseComplete: () => void;
}

export default function PaymentModal({
    isOpen,
    onOpenChange,
    showSuccessScreen,
    setShowSuccessScreen,
    lastChange,
    total,
    remaining,
    activePaymentTab,
    setActivePaymentTab,
    dialogAmount,
    setDialogAmount,
    displayTendered,
    displayChange,
    selectedCustomer,
    isReadyToFinalize,
    submitting,
    handleNumpadAction,
    setIsClientDialogOpen,
    onCloseComplete
}: PaymentModalProps) {

    const handleTabSwitch = (tab: any) => {
        if (dialogAmount !== '') {
            // Logic handled by handleNumpadAction or specific triggers in parent
            // For now, mirroring parent logic
            setActivePaymentTab(tab.id);
        } else {
            setActivePaymentTab(tab.id);
        }
    };

    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            backdrop="blur" 
            size="full" 
            classNames={{ 
                base: "bg-gray-100 dark:bg-zinc-950 border border-gray-300 dark:border-white/5 rounded-none md:rounded-[2rem] w-[100vw] md:w-[95vw] max-w-[1000px] h-[100vh] md:h-auto md:max-h-[90vh] overflow-hidden", 
                closeButton: "hidden" 
            }}
        >
            <ModalContent className="flex flex-col p-0 overflow-hidden">
                {(onClose) => (
                    <div className="flex flex-col lg:flex-row h-full min-h-0 lg:min-h-[500px] relative overflow-y-auto lg:overflow-hidden custom-scrollbar">
                        {showSuccessScreen && (
                            <div className="absolute inset-0 z-[100] bg-white dark:bg-zinc-950 flex flex-col items-center justify-center p-8 animate-in fade-in zoom-in duration-300">
                                <div className="h-28 w-28 rounded-full bg-emerald-500 text-white flex items-center justify-center mb-8 shadow-2xl shadow-emerald-500/40">
                                    <Check className="h-14 w-14 stroke-[4]" />
                                </div>
                                <h2 className="text-4xl font-black text-gray-900 dark:text-white uppercase tracking-tighter italic mb-2">Venta Maestro</h2>
                                <p className="text-[10px] font-black text-emerald-600 uppercase tracking-[0.4em] mb-12">Transacción Procesada con Éxito</p>
                                
                                <div className="bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/5 px-20 py-12 rounded-[3rem] text-center shadow-2xl mb-12">
                                    <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-6">CAMBIO DISPONIBLE</p>
                                    <p className="text-[6rem] font-black text-emerald-600 tabular-nums leading-none tracking-tighter italic">${formatCurrency(lastChange)}</p>
                                </div>
                                <Button 
                                    className="h-20 px-16 font-black text-xl uppercase rounded-[2rem] shadow-2xl bg-emerald-600 text-white hover:bg-emerald-500 active:scale-95 transition-all italic tracking-widest" 
                                    onPress={() => {
                                        setShowSuccessScreen(false);
                                        onClose();
                                        onCloseComplete();
                                    }}
                                >
                                    NUEVA VENTA (ENTER)
                                </Button>
                            </div>
                        )}
                        <div className="w-full lg:w-[240px] bg-white dark:bg-zinc-900 border-b lg:border-r lg:border-b-0 border-gray-200 dark:border-white/5 p-4 pt-16 lg:pt-8 lg:p-8 flex flex-row lg:flex-col gap-2 overflow-x-auto lg:overflow-y-auto shrink-0 custom-scrollbar sticky top-0 z-10">
                            <div className="hidden lg:flex items-center gap-3 mb-6 px-1">
                                <div className="bg-emerald-500/10 p-2 rounded-xl text-emerald-500 -rotate-3">
                                    <Zap size={18} />
                                </div>
                                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest leading-none">Cajero Maestro</span>
                            </div>
                            <h3 className="hidden lg:block text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-4 pl-1 italic">MÉTODOS DE PAGO</h3>
                            {[
                                { id: 'cash', icon: Banknote, label: 'Efectivo', color: 'emerald' },
                                { id: 'NEQUI', logo: '/logos/nequi.png', label: 'Nequi', color: 'pink' },
                                { id: 'DAVIPLATA', logo: '/logos/daviplata.png', label: 'Daviplata', color: 'red' },
                                { id: 'credit', icon: Users, label: 'Fiado', color: 'rose' }
                            ].map((tab: any) => (
                                <button
                                    key={tab.id}
                                    onClick={() => handleTabSwitch(tab)}
                                    className={`h-11 lg:h-14 px-4 rounded-2xl flex items-center gap-3 border transition-all shrink-0 font-black uppercase text-[10px] tracking-[0.1em] ${
                                        activePaymentTab === tab.id
                                        ? `bg-emerald-500/10 dark:bg-emerald-500/20 border-emerald-500/50 text-emerald-600 dark:text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.15)] italic`
                                        : 'border-transparent text-gray-500 hover:bg-gray-50 dark:hover:bg-zinc-800/50'
                                    }`}
                                >
                                    {tab.logo ? <img src={tab.logo} className="h-5 w-5 object-contain rounded-md" /> : <tab.icon size={18} className={activePaymentTab === tab.id ? 'text-emerald-500 animate-pulse' : ''} />}
                                    {tab.label}
                                </button>
                            ))}

                            <div className="mt-auto pt-8 border-t border-gray-100 dark:border-white/5 flex flex-col gap-3">
                                <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest pl-1 mb-2">OPERACIÓN CLIENTE</p>
                                <Button 
                                    className="w-full justify-start h-14 px-4 rounded-xl font-black text-[10px] uppercase bg-gray-50 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 border border-gray-200 dark:border-white/10 italic truncate tracking-widest" 
                                    onPress={() => setIsClientDialogOpen(true)}
                                >
                                    <User size={16} className="mr-2" />
                                    <span className="truncate">{selectedCustomer?.name || 'CONSUMIDOR FINAL'}</span>
                                </Button>
                                <Button 
                                    variant="flat" 
                                    color="danger" 
                                    className="w-full h-14 font-black uppercase text-[10px] rounded-xl bg-rose-500/10 text-rose-500 italic tracking-widest" 
                                    onPress={onClose}
                                >
                                    CANCELAR VENTA
                                </Button>
                            </div>
                        </div>

                        <div className="flex-1 bg-gray-50 dark:bg-zinc-950 flex flex-col p-8 min-h-0">
                            <div className="flex flex-col md:flex-row gap-6 mb-8">
                                <div className="bg-white dark:bg-zinc-900 p-8 rounded-[2rem] border border-gray-200 dark:border-white/5 flex-1 shadow-sm">
                                    <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-4">TOTAL A RECAUDAR</p>
                                    <p className="text-4xl font-black text-gray-900 dark:text-white tabular-nums tracking-tighter italic">${formatCurrency(total)}</p>
                                </div>
                                <div className={`${remaining > 0 ? 'bg-sky-500/10 border-sky-500/20 shadow-sky-500/5' : 'bg-emerald-500/10 border-emerald-500/20 shadow-emerald-500/5'} p-8 rounded-[2rem] border flex-1 shadow-sm transition-all`}>
                                    <p className={`text-[10px] font-black ${remaining > 0 ? 'text-sky-600' : 'text-emerald-600'} uppercase tracking-[0.2em] mb-4`}>{remaining > 0 ? 'SALDO PENDIENTE' : 'SALDO CUBIERTO'}</p>
                                    <p className={`text-4xl font-black ${remaining > 0 ? 'text-sky-700 dark:text-sky-400' : 'text-emerald-700 dark:text-emerald-400'} tabular-nums tracking-tighter italic`}>${formatCurrency(remaining)}</p>
                                </div>
                            </div>

                            {activePaymentTab === 'cash' ? (
                                <div className="flex flex-col flex-1 gap-6">
                                    <div className="flex flex-col md:flex-row gap-6 mb-2 lg:flex-1">
                                        <div className="bg-white dark:bg-zinc-900 p-8 rounded-[2rem] border border-gray-200 dark:border-white/5 flex-1 shadow-sm flex flex-col justify-center">
                                            <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-4">EFECTIVO RECIBIDO</p>
                                            <p className="text-6xl font-black text-gray-900 dark:text-white tabular-nums tracking-tighter italic leading-none">${formatCurrency(displayTendered)}</p>
                                        </div>
                                        <div className="bg-white dark:bg-zinc-900 p-8 rounded-[2rem] border border-gray-200 dark:border-white/5 flex-1 shadow-sm flex flex-col justify-center">
                                            <p className="text-[10px] font-black text-emerald-600 uppercase tracking-[0.2em] mb-4">CAMBIO MAESTRO</p>
                                            <p className="text-6xl font-black text-emerald-600 tabular-nums tracking-tighter italic leading-none">${formatCurrency(displayChange)}</p>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 h-40">
                                        {[
                                            { v: 100000, img: '/logos/100.000.jpg' },
                                            { v: 50000, img: '/logos/50.000.jpg' },
                                            { v: 20000, img: '/logos/20.000.jpg' }
                                        ].map(bill => (
                                            <button
                                                key={bill.v}
                                                className="h-full bg-white dark:bg-zinc-900 hover:ring-2 hover:ring-emerald-500 rounded-[1.5rem] overflow-hidden border border-gray-200 dark:border-white/10 transition-all active:scale-95 shadow-sm"
                                                onClick={() => setDialogAmount(prev => String(Number(prev || 0) + bill.v))}
                                            >
                                                <img src={bill.img} alt={`$${bill.v}`} className="w-full h-full object-cover" />
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center flex-1 py-12 animate-in fade-in duration-500">
                                    <div className="h-48 w-48 mb-8 flex items-center justify-center">
                                        {activePaymentTab === 'credit' ? (
                                            <div className="h-32 w-32 rounded-full bg-rose-500/10 flex items-center justify-center text-rose-500 shadow-2xl shadow-rose-500/20">
                                                <Users size={64} className="stroke-[3]" />
                                            </div>
                                        ) : (
                                            <img 
                                                src={activePaymentTab === 'NEQUI' ? '/logos/nequi.png' : '/logos/daviplata.png'} 
                                                className="w-full h-full object-contain filter drop-shadow-[0_0_30px_rgba(0,0,0,0.15)]" 
                                                alt={activePaymentTab}
                                            />
                                        )}
                                    </div>
                                    <h3 className="text-2xl font-black uppercase text-gray-900 dark:text-white tracking-widest italic mb-2">{activePaymentTab === 'credit' ? 'CARTERA FIADO' : activePaymentTab}</h3>
                                    <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.4em] mb-12">Confirmación de Recibo Digital</p>
                                    
                                    <div className="bg-white dark:bg-zinc-900 px-12 py-6 rounded-[2rem] border border-gray-200 dark:border-white/5 shadow-xl">
                                        <p className="text-[10px] font-black text-emerald-600 uppercase mb-2 tracking-[0.2em] text-center">VALOR A CARGAR</p>
                                        <p className="text-4xl font-black text-gray-900 dark:text-white tabular-nums tracking-tighter italic">${formatCurrency(remaining)}</p>
                                    </div>
                                    <p className="text-[10px] text-gray-400 font-black uppercase tracking-[0.3em] mt-12 animate-pulse">Ingrese monto o presione Cargar</p>
                                </div>
                            )}
                        </div>

                        <div className="w-full lg:w-[320px] bg-white dark:bg-zinc-900 border-t lg:border-l lg:border-t-0 border-gray-200 dark:border-white/5 p-8 flex flex-col gap-6 lg:min-h-0">
                            <div className="bg-gray-50 dark:bg-zinc-950 p-6 rounded-[2rem] border border-gray-200 dark:border-white/5 text-right shadow-inner flex flex-col justify-center h-32">
                                <p className="text-[10px] font-black text-emerald-600 uppercase tracking-widest mb-2 font-black">ENTRADA MANUAL</p>
                                <p className="text-4xl font-black text-gray-900 dark:text-white tabular-nums h-12 italic tracking-tighter">
                                    {dialogAmount ? `$${Number(dialogAmount).toLocaleString()}` : ''}
                                </p>
                            </div>
                            
                            <div className="grid grid-cols-3 gap-3 flex-1">
                                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '00', 'CE'].map(n => (
                                    <Button 
                                        key={n} 
                                        variant="flat"
                                        className={`h-full text-2xl font-black rounded-2xl transition-all active:scale-95 ${
                                            n === 'CE' 
                                            ? 'text-rose-500 bg-rose-50 dark:bg-rose-500/10 hover:bg-rose-500 hover:text-white' 
                                            : 'text-gray-900 dark:text-white bg-gray-50 dark:bg-zinc-800 hover:bg-emerald-500 hover:text-white'
                                        }`}
                                        onPress={() => n === 'CE' ? setDialogAmount('') : setDialogAmount((p: string) => p + String(n))}
                                    >
                                        {n}
                                    </Button>
                                ))}
                            </div>

                            <Button 
                                className={`h-24 font-black text-lg uppercase rounded-[2rem] shadow-2xl transition-all tracking-[0.2em] italic ${
                                    isReadyToFinalize 
                                    ? 'bg-emerald-600 text-white shadow-emerald-500/20' 
                                    : 'bg-sky-600 text-white shadow-sky-500/20'
                                }`}
                                isLoading={submitting}
                                onPress={handleNumpadAction}
                            >
                                {isReadyToFinalize ? 'FINALIZAR TRANSACCIÓN' : 'CARGAR PAGO'}
                            </Button>
                        </div>
                    </div>
                )}
            </ModalContent>
        </Modal>
    );
}
