"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Modal, ModalContent, Button, Avatar
} from "@heroui/react";
import { 
  Banknote, Zap, Check, Wallet, ArrowRight, X, 
  Calculator, ShieldCheck, TrendingUp, Grid3X3, Users 
} from 'lucide-react';
import { Customer } from '@/lib/definitions';
import { formatCurrency } from "@/lib/utils";

interface UniversalPaymentModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  client: Customer | null;
  totalToPay: number; // Total de la venta o total de la deuda
  initialPaidAmounts?: {
    cash: number;
    transfer: number;
    transferSource: string;
    credit: number;
  };
  showSuccessScreen: boolean;
  submittingPayment: boolean;
  lastChange: number;
  onPay: (data: {
    cash: number;
    transfer: number;
    transferSource: string;
    credit: number;
    totalPaid: number;
    change: number;
  }) => Promise<void>;
  onCloseComplete?: () => void;
  showCreditTab?: boolean;
  flowType?: "in" | "out";
  reason?: string;
  onReasonChange?: (reason: string) => void;
}

export default function UniversalPaymentModal({
  isOpen, 
  onOpenChange, 
  title = "Gestión de Pagos",
  client, 
  totalToPay,
  initialPaidAmounts,
  showSuccessScreen, 
  submittingPayment, 
  lastChange, 
  onPay,
  onCloseComplete,
  showCreditTab = true,
  flowType = "in",
  reason,
  onReasonChange
}: UniversalPaymentModalProps) {
  const [activePaymentTab, setActivePaymentTab] = useState<'cash' | 'NEQUI' | 'DAVIPLATA' | 'credit'>('cash');
  const [isMobileNumpadOpen, setIsMobileNumpadOpen] = useState(false);
  const [dialogAmount, setDialogAmount] = useState('');
  const [cashTendered, setCashTendered] = useState<string>('');
  const themeColor = flowType === "out" ? "rose" : "emerald";
  
  // Estados internos para pagos acumulados (mixtos)
  const [cashPaid, setCashPaid] = useState<number>(0);
  const [transferPaid, setTransferPaid] = useState<number>(0);
  const [transferSource, setTransferSource] = useState<string>('NEQUI');
  const [creditPaid, setCreditPaid] = useState<number>(0);

  // Inicializar estados cuando se abre el modal
  useEffect(() => {
    if (isOpen) {
      setCashPaid(initialPaidAmounts?.cash || 0);
      setTransferPaid(initialPaidAmounts?.transfer || 0);
      setTransferSource(initialPaidAmounts?.transferSource || 'NEQUI');
      setCreditPaid(initialPaidAmounts?.credit || 0);
      setDialogAmount('');
      setCashTendered('');
      
      // Determinar tab inicial
      if (initialPaidAmounts?.credit && initialPaidAmounts.credit > 0) setActivePaymentTab('credit');
      else if (initialPaidAmounts?.transfer && initialPaidAmounts.transfer > 0) setActivePaymentTab(initialPaidAmounts.transferSource as any);
      else setActivePaymentTab('cash');
    }
  }, [isOpen, initialPaidAmounts]);

  // Teclado físico - MOVIDO AQUÍ PARA EVITAR ERROR DE HOOKS CONDICIONALES
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen || showSuccessScreen) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        setDialogAmount(prev => prev + e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        setDialogAmount(prev => prev.slice(0, -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        processPayment();
      } else if (e.key === '+' || e.key === 'Add') {
        e.preventDefault();
        handleAddPayment();
      } else if (e.key === 'Escape') {
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, showSuccessScreen, dialogAmount, activePaymentTab, cashPaid, transferPaid, creditPaid, totalToPay]);

  if (!isOpen) return null;

  const currentDialogVal = Number(dialogAmount) || 0;
  const totalAlreadyPaid = cashPaid + transferPaid + creditPaid;
  const remainingDebt = Math.max(0, totalToPay - totalAlreadyPaid);

  // Valor a mostrar en el display principal
  const amountToPayRaw = currentDialogVal > 0 
    ? currentDialogVal 
    : (Number(cashTendered) > 0 
        ? Number(cashTendered) 
        : (totalAlreadyPaid > 0 ? 0 : remainingDebt));
        
  const actualPayment = Math.min(amountToPayRaw, remainingDebt);

  const handleAddPayment = () => {
    const val = currentDialogVal > 0 ? currentDialogVal : remainingDebt;
    if (val > 0) {
      if (activePaymentTab === 'NEQUI' || activePaymentTab === 'DAVIPLATA') {
        setTransferPaid(prev => prev + Math.min(val, remainingDebt));
        setTransferSource(activePaymentTab);
        setActivePaymentTab('cash');
      } else if (activePaymentTab === 'credit') {
        setCreditPaid(prev => prev + Math.min(val, remainingDebt));
        setActivePaymentTab('cash');
      } else {
        if (val >= remainingDebt) setCashTendered(String(val));
        else setCashPaid(prev => prev + val);
      }
      setDialogAmount('');
    }
  };

    const isCreditInvalid = activePaymentTab === 'credit' && (!client || client.id === "0" || client.name === "CONSUMIDOR FINAL");
    const isOverCreditLimit = activePaymentTab === 'credit' && client && (currentDialogVal > 0 ? currentDialogVal : remainingDebt) > (client.creditLimit - client.currentCredit);

    const processPayment = async () => {
      if (isCreditInvalid || isOverCreditLimit) return;
      
      let finalCash = cashPaid;
    let finalTransfer = transferPaid;
    let finalCredit = creditPaid;
    let finalSource = transferSource;
    let finalTendered = Number(cashTendered) || 0;

    if (currentDialogVal > 0) {
      if (activePaymentTab === 'cash') {
        finalCash += currentDialogVal;
        finalTendered = currentDialogVal;
      } else if (activePaymentTab === 'NEQUI' || activePaymentTab === 'DAVIPLATA') {
        finalTransfer += currentDialogVal;
        finalSource = activePaymentTab;
      } else if (activePaymentTab === 'credit') {
        finalCredit += currentDialogVal;
      }
    } 
    else if (finalCash === 0 && finalTransfer === 0 && finalCredit === 0 && currentDialogVal === 0) {
      if (activePaymentTab === 'cash') finalCash = remainingDebt;
      else if (activePaymentTab === 'NEQUI' || activePaymentTab === 'DAVIPLATA') {
        finalTransfer = remainingDebt;
        finalSource = activePaymentTab;
      } else if (activePaymentTab === 'credit') {
        finalCredit = remainingDebt;
      }
    }
    else if (finalTendered > 0 && activePaymentTab === 'cash') {
       if (finalCash === 0) finalCash = Math.min(finalTendered, remainingDebt);
    }

    const totalPaid = finalCash + finalTransfer + finalCredit;
    const effectiveCash = finalTendered > 0 ? finalTendered : finalCash;
    const change = Math.max(0, effectiveCash - (totalToPay - finalTransfer - finalCredit));

    await onPay({
      cash: finalCash,
      transfer: finalTransfer,
      transferSource: finalSource,
      credit: finalCredit,
      totalPaid: totalPaid,
      change: change
    });
  };

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange} 
      placement="top"
      backdrop="blur" 
      size="full" 
      onClose={onCloseComplete}
      classNames={{ 
        base: "bg-gray-50 dark:bg-zinc-950 max-w-[1300px] h-full md:h-auto md:max-h-[85vh] md:rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-hidden mx-2 md:mx-0", 
        closeButton: "hidden", 
        wrapper: "items-start sm:items-center mt-12 sm:mt-0 justify-center" 
      }}
    >
      <ModalContent>
        {() => (
          <div className="flex flex-col md:flex-row h-full overflow-hidden relative">
            {/* Pantalla de Éxito Maestro */}
            {showSuccessScreen && (
              <div className="absolute inset-0 z-[100] bg-zinc-950/40 backdrop-blur-xl flex flex-col items-center justify-center p-8 animate-in fade-in zoom-in duration-300">
                <div className="bg-white dark:bg-zinc-900 p-10 rounded-[2.5rem] flex flex-col items-center shadow-2xl border border-white/10 w-full max-w-sm relative overflow-hidden group">
                  <div className={`h-20 w-20 rounded-[1.5rem] bg-${themeColor}-500 text-white flex items-center justify-center mb-6 shadow-[0_20px_50px_rgba(16,185,129,0.3)] -rotate-3 scale-110 border-4 border-white/20`}>
                    <Check size={40} strokeWidth={4} />
                  </div>
                  <h2 className="text-3xl font-black text-gray-900 dark:text-white uppercase mb-2 italic tracking-tighter text-center leading-none">
                    Operación <span className={`text-${themeColor}-500`}>Exitosa</span>
                  </h2>
                  <span className={`text-[8px] font-black text-${themeColor}-600/60 dark:text-${themeColor}-500/40 uppercase tracking-[0.4em] mb-6 italic`}>PROCESADO CON ÉXITO</span>
                  
                  <div className={`bg-${themeColor}-500/5 dark:bg-${themeColor}-500/10 border-2 border-${themeColor}-500/20 p-8 rounded-[2rem] text-center w-full relative overflow-hidden group-hover:scale-[1.02] transition-transform`}>
                    <p className={`text-[9px] font-black text-${themeColor}-500 uppercase mb-3 tracking-[0.3em] italic`}>CAMBIO A ENTREGAR</p>
                    <p className="text-5xl font-black text-gray-900 dark:text-white tabular-nums italic tracking-tighter">${formatCurrency(lastChange)}</p>
                  </div>
                  
                  <Button 
                    className="mt-8 bg-gray-900 dark:bg-white text-white dark:text-black font-black px-12 h-14 rounded-2xl italic w-full shadow-2xl flex items-center gap-4 active:scale-95 transition-all text-[11px] tracking-widest uppercase hover:opacity-90" 
                    onPress={() => onOpenChange(false)}
                  >
                    CONTINUAR [ENTER] <ArrowRight size={18} />
                  </Button>
                </div>
              </div>
            )}
            
            {/* Sidebar de Métodos Maestro */}
            <div className="w-full md:w-[220px] bg-white dark:bg-zinc-900 border-b md:border-b-0 md:border-r border-gray-200 dark:border-white/5 p-2 md:p-6 flex flex-col gap-2 md:gap-3 z-20">
              <div className="hidden md:flex flex-col mb-8 px-2">
                <div className="flex items-center gap-2 mb-2">
                  <div className={`h-2 w-2 rounded-full bg-${themeColor}-500 animate-pulse`} />
                  <span className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] leading-none">Cajero Seguro</span>
                </div>
                <h3 className={`text-[10px] font-black text-${themeColor}-500 uppercase tracking-[0.2em] italic`}>MÉTODO PAGO</h3>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-1 gap-1.5 md:gap-3">
                {[
                  { id: 'cash', label: 'Efec.', icon: Banknote },
                  { id: 'NEQUI', label: 'Nequi', logo: '/logos/nequi.png' },
                  { id: 'DAVIPLATA', label: 'Daviplata', logo: '/logos/daviplata.png' },
                  { id: 'credit', label: 'Fiado', icon: Users }
                ].filter(tab => tab.id !== 'credit' || showCreditTab).map(tab => (
                  <button 
                    key={tab.id} 
                    onClick={() => { setActivePaymentTab(tab.id as any); setDialogAmount(''); setCashTendered(''); }} 
                    className={`h-10 md:h-14 px-2 md:px-5 rounded-lg md:rounded-2xl flex items-center justify-center md:justify-start gap-1.5 md:gap-4 border transition-all group ${
                      activePaymentTab === tab.id 
                        ? 'bg-${themeColor}-500/10 dark:bg-${themeColor}-500/20 border-${themeColor}-500/50 text-${themeColor}-600 dark:text-${themeColor}-400 shadow-[0_0_20px_rgba(16,185,129,0.15)] italic' 
                        : 'bg-gray-50 dark:bg-zinc-800 border-transparent text-gray-500 dark:text-zinc-500 hover:bg-${themeColor}-500/10'
                    }`}
                  >
                    <div className={`p-1 md:p-2 rounded-lg transition-colors ${activePaymentTab === tab.id ? 'bg-${themeColor}-500 text-white shadow-lg shadow-${themeColor}-500/30' : 'bg-gray-200 dark:bg-zinc-700/50 group-hover:bg-${themeColor}-500/20'}`}>
                      {tab.icon ? (
                        <tab.icon size={14} className="md:w-5 md:h-5" />
                      ) : (
                        <img 
                          src={tab.logo} 
                          className={`h-3.5 w-3.5 md:h-7 md:w-7 object-contain ${activePaymentTab === tab.id ? 'brightness-200' : 'opacity-70 group-hover:opacity-100'}`} 
                          alt={tab.label}
                        />
                      )}
                    </div>
                    <span className="text-[7.5px] md:text-[10px] font-black uppercase italic whitespace-nowrap tracking-wider md:tracking-widest leading-none">{tab.label}</span>
                  </button>
                ))}
                
                <button 
                  onClick={() => onOpenChange(false)}
                  className="h-10 md:hidden px-2 rounded-lg flex items-center justify-center gap-1.5 border border-rose-500/20 bg-rose-500/5 text-rose-500 active:scale-95 transition-all group"
                >
                  <div className="p-1 rounded-lg bg-rose-500/20 text-rose-500">
                    <X size={14} />
                  </div>
                  <span className="text-[7.5px] font-black uppercase italic tracking-wider leading-none">Cerrar</span>
                </button>
              </div>

              <Button variant="flat" className="hidden md:flex md:mt-auto h-14 font-black text-[10px] px-6 rounded-2xl bg-rose-500/10 text-rose-500 tracking-widest uppercase italic border border-rose-500/20" onPress={() => onOpenChange(false)}>
                CANCELAR <X size={14} className="ml-1" />
              </Button>
            </div>

            {/* Content Central */}
            <div className="flex-1 bg-gray-50 dark:bg-zinc-950 pt-2 md:pt-8 px-3 md:px-10 pb-3 flex flex-col relative overflow-hidden z-10">
              <header className="mb-1 md:mb-4 flex flex-col md:flex-row md:items-end justify-between gap-1 md:gap-4">
                <div className="flex flex-col min-w-0">
                  <h1 className="text-lg md:text-3xl font-black dark:text-white uppercase italic tracking-tighter leading-none mb-0.5 md:mb-2 text-center md:text-left">
                    {title.split(' ')[0]} <span className={`text-${themeColor}-500`}>{title.split(' ').slice(1).join(' ')}</span>
                  </h1>
                  <div className="flex items-center justify-center md:justify-start gap-1.5">
                    <Avatar size="sm" name={client?.name || 'C F'} className={`h-4 w-4 rounded-md bg-${themeColor}-500/10 text-${themeColor}-500 text-[6px]`} />
                    <p className="text-[8px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">{client?.name || 'CONSUMIDOR FINAL'} {client?.dni ? `/ CC: ${client.dni}` : ''}</p>
                  </div>
                </div>
                
                {/* Resumen de Pagos Acumulados (Chips) */}
                <div className="flex items-center gap-2">
                  {transferPaid > 0 && (
                    <div className="px-3 py-1 bg-blue-500/10 border border-blue-500/20 rounded-full flex items-center gap-2">
                       <img src={transferSource === 'NEQUI' ? '/logos/nequi.png' : '/logos/daviplata.png'} className="h-4 w-4 object-contain" />
                       <span className="text-[9px] font-black text-blue-500 uppercase tracking-widest">${formatCurrency(transferPaid)}</span>
                    </div>
                  )}
                  {cashPaid > 0 && (
                    <div className={`px-3 py-1 bg-${themeColor}-500/10 border border-${themeColor}-500/20 rounded-full flex items-center gap-2`}>
                       <Banknote size={12} className={`text-${themeColor}-500`} />
                       <span className={`text-[9px] font-black text-${themeColor}-500 uppercase tracking-widest`}>${formatCurrency(cashPaid)}</span>
                    </div>
                  )}
                  {creditPaid > 0 && (
                    <div className="px-3 py-1 bg-rose-500/10 border border-rose-500/20 rounded-full flex items-center gap-2">
                       <Users size={12} className="text-rose-500" />
                       <span className="text-[9px] font-black text-rose-500 uppercase tracking-widest">${formatCurrency(creditPaid)}</span>
                    </div>
                  )}
                </div>
              </header>

              <div className="flex flex-row gap-1.5 mb-1.5">
                <div className="bg-white dark:bg-zinc-900 px-2 py-1 rounded-lg border border-gray-100 dark:border-white/5 flex-1 shadow-sm flex flex-col justify-center">
                  <p className="text-[6px] md:text-[8px] font-black text-gray-400 uppercase mb-0 tracking-widest flex items-center gap-1"><Wallet size={6} className="text-rose-500" /> TOTAL</p>
                  <p className="text-sm md:text-2xl font-black text-rose-500 italic tabular-nums leading-none">${formatCurrency(totalToPay)}</p>
                </div>
                <div className="bg-white dark:bg-zinc-900 px-2 py-1 rounded-lg border border-gray-100 dark:border-white/5 flex-1 shadow-sm flex flex-col justify-center">
                  <p className="text-[6px] md:text-[8px] font-black text-gray-400 uppercase mb-0 tracking-widest flex items-center gap-1"><TrendingUp size={6} className={`text-${themeColor}-500`} /> PENDIENTE</p>
                  <p className={`text-sm md:text-2xl font-black text-${themeColor}-500 italic tabular-nums leading-none`}>${formatCurrency(remainingDebt)}</p>
                </div>
              </div>

              {activePaymentTab === 'cash' ? (
                <div className="flex flex-col flex-1 min-h-0 overflow-y-auto pr-1 custom-scrollbar">
                  <div className={`p-2 md:p-4 rounded-lg border-2 flex flex-col justify-center shadow-lg relative overflow-hidden group transition-all duration-500 ${
                    amountToPayRaw > remainingDebt 
                      ? 'bg-${themeColor}-500/10 border-${themeColor}-500/30' 
                      : 'bg-white dark:bg-zinc-900 border-gray-200 dark:border-${themeColor}-500/20'
                  }`}>
                    <div className={`absolute top-0 right-0 p-2 opacity-5 text-${themeColor}-500 group-hover:scale-125 transition-transform`}>
                      {amountToPayRaw > remainingDebt ? <Zap size={28} /> : <Banknote size={28} />}
                    </div>
                    
                    <p className={`text-[7px] md:text-[8px] font-black uppercase mb-0 tracking-[0.2em] italic transition-colors ${
                      amountToPayRaw > remainingDebt ? 'text-${themeColor}-500' : 'text-gray-400'
                    }`}>
                      {amountToPayRaw > remainingDebt ? 'CAMBIO (VUELTAS)' : 'EFECTIVO RECIBIDO'}
                    </p>
                    
                    <p className={`text-xl md:text-4xl font-black tabular-nums italic tracking-tighter transition-all ${
                      amountToPayRaw > remainingDebt ? 'text-${themeColor}-500 animate-pulse' : 'dark:text-white'
                    }`}>
                      ${formatCurrency(amountToPayRaw > remainingDebt ? amountToPayRaw - remainingDebt : amountToPayRaw)}
                    </p>
                  </div>
                  
                   {!isMobileNumpadOpen ? (
                     <>
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mt-2 content-start">
                        {[
                          { v: 100000, img: '100.000.jpg' },
                          { v: 50000, img: '50.000.jpg' },
                          { v: 20000, img: '20.000.jpg' },
                          { v: 10000, img: '10.000.jpg' },
                          { v: 5000, img: '5.000.jpg' },
                          { v: 2000, img: '2.000.png' },
                          { v: 1000, img: '1.000.jpg' }
                        ].map(({ v, img }) => (
                          <Button 
                            key={v} 
                            className="aspect-[2.2/1] w-full bg-white dark:bg-zinc-800 border-[1px] border-gray-100 dark:border-white/5 group active:scale-95 transition-all rounded-lg md:rounded-2xl p-0 overflow-hidden shadow-sm h-auto" 
                            onPress={() => { setCashTendered(String(v)); setDialogAmount(''); }}
                          >
                            <img 
                              src={`/logos/${img}`} 
                              className="h-full w-full object-cover grayscale-0 opacity-100 group-hover:scale-110 transition-transform duration-700" 
                              alt={`${v}`}
                            />
                          </Button>
                        ))}
                        <Button 
                          className={`aspect-[2.2/1] w-full bg-${themeColor}-500 text-white border-none active:scale-95 transition-all rounded-lg p-0 flex flex-col items-center justify-center gap-0.5 shadow-lg shadow-${themeColor}-500/20`} 
                          onPress={() => setIsMobileNumpadOpen(true)}
                        >
                          <Calculator size={14} />
                          <span className="text-[7px] font-black uppercase tracking-tighter">TECLADO</span>
                        </Button>
                      </div>
                      <Button className={`md:hidden h-12 mt-3 bg-${themeColor}-500 text-white font-black uppercase rounded-xl italic tracking-widest shadow-lg text-xs active:scale-95 transition-all`} onPress={processPayment} isLoading={submittingPayment}>
                        PROCESAR PAGO <ShieldCheck size={16} className="ml-1" />
                      </Button>
                    </>
                   ) : (
                    <>
                      <div className="grid grid-cols-3 gap-2 mt-2">
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '00', 'CE'].map(n => (
                          <Button 
                            key={n} 
                            className={`h-11 text-lg font-black rounded-xl transition-all shadow-sm active:scale-95 ${
                              n === 'CE' ? 'text-rose-500 bg-rose-500/10' : 'bg-white dark:bg-zinc-800 dark:text-white'
                            }`} 
                            onPress={() => {
                                if (n === 'CE') setDialogAmount('');
                                else setDialogAmount((p: string) => p + String(n));
                            }}
                          >
                            {n}
                          </Button>
                        ))}
                      </div>
                      <div className="flex gap-2 mt-3">
                        <Button className="flex-1 h-12 bg-zinc-800 text-white font-black uppercase rounded-xl text-[10px] tracking-widest active:scale-95 transition-all flex items-center justify-center gap-2" onPress={() => setIsMobileNumpadOpen(false)}>
                          <Grid3X3 size={14} /> BILLETES
                        </Button>
                        <Button className={`flex-[2] h-12 bg-${themeColor}-500 text-white font-black uppercase rounded-xl italic tracking-widest shadow-lg text-xs active:scale-95 transition-all`} onPress={processPayment} isLoading={submittingPayment}>
                          REALIZAR <ShieldCheck size={14} />
                        </Button>
                      </div>
                    </>
                   )}
                </div>
              ) : (
                <div className="flex-1 flex flex-col min-h-0 overflow-y-auto pr-1">
                  <div className={`bg-white dark:bg-zinc-900 p-4 rounded-xl border-2 border-${themeColor}-500/20 shadow-lg flex flex-col items-center justify-center gap-2 mb-3 relative overflow-hidden group`}>
                    <div className={`absolute inset-0 bg-${themeColor}-500/5 group-hover:bg-${themeColor}-500/10 transition-colors`} />
                    {activePaymentTab === 'credit' ? (
                       <div className="h-12 w-12 rounded-full bg-rose-500/10 flex items-center justify-center text-rose-500 relative z-10 animate-in zoom-in duration-500">
                          <Users size={24} />
                       </div>
                    ) : (
                      <img 
                        src={activePaymentTab === 'NEQUI' ? '/logos/nequi.png' : '/logos/daviplata.png'} 
                        className="h-12 w-12 object-contain relative z-10 animate-in zoom-in duration-500" 
                        alt={activePaymentTab}
                      />
                    )}
                    <div className="text-center relative z-10">
                      <p className="text-sm font-black dark:text-white italic uppercase tracking-tighter">{activePaymentTab === 'credit' ? 'CARTERA FIADO' : `TRANSACCIÓN ${activePaymentTab}`}</p>
                      <p className={`text-[14px] font-black text-${themeColor}-500 tabular-nums`}>${formatCurrency(amountToPayRaw)}</p>
                    </div>
                  </div>

                  {/* Panel de Inteligencia Crediticia y Validaciones - FASE 1 & 2 */}
                  {activePaymentTab === 'credit' && (
                    <div className="mb-4 animate-in slide-in-from-top-2 duration-300">
                        {(!client || client.id === "0" || client.name === "CONSUMIDOR FINAL") ? (
                            <div className="bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/20 rounded-xl p-4 flex flex-col gap-1 shadow-sm">
                                <p className="text-amber-700 dark:text-amber-400 font-black text-xs flex items-center gap-2 uppercase tracking-tight">
                                    ⚠️ CLIENTE NO SELECCIONADO
                                </p>
                                <p className="text-[10px] text-amber-600 dark:text-amber-500/70 font-medium leading-relaxed">
                                    No se puede fiar a Consumidor Final. Por favor, cancela y selecciona un cliente registrado para asignar la deuda.
                                </p>
                            </div>
                        ) : (
                            <div className={`border rounded-xl p-3 transition-all duration-300 shadow-sm ${
                                amountToPayRaw > (client.creditLimit - client.currentCredit)
                                    ? 'bg-rose-50 border-rose-200 dark:bg-rose-500/10 dark:border-rose-500/20'
                                    : 'bg-blue-50 border-blue-200 dark:bg-blue-500/10 dark:border-blue-500/20'
                            }`}>
                                <div className="flex items-center justify-between mb-2">
                                    <p className={`font-black text-[10px] uppercase tracking-widest ${
                                        amountToPayRaw > (client.creditLimit - client.currentCredit)
                                            ? 'text-rose-600 dark:text-rose-400'
                                            : 'text-blue-600 dark:text-blue-400'
                                    }`}>
                                        Inteligencia Crediticia
                                    </p>
                                    <Users size={14} className={ amountToPayRaw > (client.creditLimit - client.currentCredit) ? 'text-rose-500' : 'text-blue-500'} />
                                </div>
                                
                                <div className="grid grid-cols-3 gap-2">
                                    <div className="flex flex-col">
                                        <span className="text-[7px] font-bold text-gray-400 uppercase tracking-tighter">Deuda Actual</span>
                                        <span className="text-[11px] font-black text-gray-700 dark:text-zinc-300 italic tabular-nums">${formatCurrency(client.currentCredit)}</span>
                                    </div>
                                    <div className="flex flex-col border-x border-gray-200 dark:border-white/5 px-2">
                                        <span className="text-[7px] font-bold text-gray-400 uppercase tracking-tighter">Cupo Máximo</span>
                                        <span className="text-[11px] font-black text-gray-700 dark:text-zinc-300 italic tabular-nums">${formatCurrency(client.creditLimit)}</span>
                                    </div>
                                    <div className="flex flex-col items-end">
                                        <span className="text-[7px] font-bold text-gray-400 uppercase tracking-tighter">Cupo Disponible</span>
                                        <span className={`text-[11px] font-black italic tabular-nums ${
                                            (client.creditLimit - client.currentCredit) <= 0 ? 'text-rose-500' : 'text-emerald-500'
                                        }`}>
                                            ${formatCurrency(client.creditLimit - client.currentCredit)}
                                        </span>
                                    </div>
                                </div>

                                {amountToPayRaw > (client.creditLimit - client.currentCredit) && (
                                    <div className="mt-2 pt-2 border-t border-rose-200 dark:border-rose-500/20">
                                        <p className="text-[10px] font-black text-rose-600 dark:text-rose-400 uppercase animate-pulse italic">
                                            🚨 ESTA VENTA SUPERA EL CUPO DISPONIBLE
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                  )}

                  {/* Numpad para Transferencia / Crédito en Móvil */}
                  <div className="grid grid-cols-3 gap-2">
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '00', 'CE'].map(n => (
                      <Button 
                        key={n} 
                        className={`h-11 text-lg font-black rounded-xl transition-all shadow-sm active:scale-95 ${
                          n === 'CE' ? 'text-rose-500 bg-rose-500/10' : 'bg-white dark:bg-zinc-800 dark:text-white'
                        }`} 
                        onPress={() => {
                            if (n === 'CE') setDialogAmount('');
                            else setDialogAmount((p: string) => p + String(n));
                        }}
                      >
                        {n}
                      </Button>
                    ))}
                  </div>

                  {onReasonChange && (
                    <div className="mt-4 animate-in slide-in-from-top-2 duration-300">
                      <p className="text-[8px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] mb-2 ml-1 italic flex items-center gap-2">
                        <div className={`h-1 w-1 rounded-full bg-${themeColor}-500`} /> JUSTIFICACIÓN / NOTA
                      </p>
                      <input 
                        type="text"
                        value={reason || ''}
                        onChange={(e) => onReasonChange(e.target.value)}
                        placeholder="MOTIVO..."
                        className={`w-full h-12 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-xl px-4 text-[10px] font-black uppercase tracking-widest focus:outline-none focus:border-${themeColor}-500/50 transition-all placeholder:text-gray-300 dark:placeholder:text-zinc-700 shadow-sm`}
                      />
                    </div>
                  )}

                  <Button 
                    className={`md:hidden h-14 w-full font-black uppercase rounded-2xl mt-4 shadow-xl text-xs tracking-widest active:scale-95 transition-all italic ${
                        isCreditInvalid || isOverCreditLimit ? 'bg-gray-300 text-gray-500 cursor-not-allowed opacity-50' : `bg-${themeColor}-500 text-white`
                    }`} 
                    onPress={processPayment} 
                    isLoading={submittingPayment}
                    isDisabled={isCreditInvalid || isOverCreditLimit}
                  >
                    {isCreditInvalid ? "CLIENTE REQUERIDO" : isOverCreditLimit ? "CUPO EXCEDIDO" : (flowType === "out" ? "CONFIRMAR REEMBOLSO" : "SINCRONIZAR PAGO")} <Check size={18} className="ml-2" />
                  </Button>
                </div>
              )}
            </div>

            {/* Teclado Pad Derecho Maestro */}
            <div className="hidden md:flex w-[320px] bg-white dark:bg-zinc-900 border-l border-gray-200 dark:border-white/5 p-8 flex-col gap-6 z-20">
              <div className="bg-gray-50 dark:bg-zinc-950 p-8 rounded-[2.5rem] border border-gray-200 dark:border-white/10 text-right shadow-inner relative overflow-hidden group">
                <div className={`absolute top-0 left-0 p-4 opacity-5 text-${themeColor}-500 scale-150 -ml-4 -mt-4`}><Calculator size={60} /></div>
                <p className={`text-[10px] font-black text-${themeColor}-600 uppercase tracking-[0.2em] italic flex items-center justify-end gap-2 relative z-10`}><Calculator size={12} /> DIGITANDO MONTO</p>
                <div className="flex items-center justify-end gap-1 relative z-10">
                  <span className={`text-${themeColor}-500 font-black italic text-2xl tracking-tighter`}>$</span>
                  <p className="text-4xl font-black dark:text-white h-12 tracking-tighter italic tabular-nums leading-none">{formatCurrency(dialogAmount)}</p>
                </div>
              </div>

              {onReasonChange && (
                <div className="animate-in slide-in-from-top-2 duration-300">
                  <p className="text-[8px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] mb-2 ml-1 italic flex items-center gap-2">
                    <div className={`h-1 w-1 rounded-full bg-${themeColor}-500`} /> JUSTIFICACIÓN / NOTA
                  </p>
                  <input 
                    type="text"
                    value={reason || ''}
                    onChange={(e) => onReasonChange(e.target.value)}
                    placeholder="ESCRIBIR MOTIVO..."
                    className={`w-full h-12 bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-[1.2rem] px-5 text-[10px] font-black uppercase tracking-widest focus:outline-none focus:border-${themeColor}-500/50 transition-all placeholder:text-gray-300 dark:placeholder:text-zinc-700 shadow-inner`}
                  />
                </div>
              )}
              <div className="grid grid-cols-3 gap-3 flex-1 pb-4">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '+', 'CE'].map(n => (
                  <Button 
                    key={n} 
                    className={`h-full text-2xl font-black rounded-3xl transition-all shadow-sm active:scale-95 ${
                      n === 'CE' 
                        ? 'text-rose-500 bg-rose-500/10 border-2 border-rose-500/20 active:bg-rose-50 active:text-white' 
                        : n === '+'
                        ? 'bg-${themeColor}-500 text-white shadow-xl shadow-${themeColor}-500/20'
                        : 'bg-gray-50 dark:bg-zinc-800 dark:text-white active:bg-${themeColor}-500 active:text-white border border-transparent'
                    }`} 
                    onPress={() => {
                        if (n === 'CE') setDialogAmount('');
                        else if (n === '+') handleAddPayment();
                        else setDialogAmount((p: string) => p + String(n));
                    }}
                  >
                    {n}
                  </Button>
                ))}
              </div>
              <Button 
                className={`h-20 font-black uppercase rounded-3xl italic tracking-[0.2em] shadow-[0_20px_50px_rgba(0,0,0,0.1)] active:scale-95 transition-all text-[11px] border-b-4 ${
                    isCreditInvalid || isOverCreditLimit 
                        ? 'bg-gray-200 text-gray-400 border-gray-300 cursor-not-allowed opacity-50' 
                        : 'bg-gray-900 dark:bg-white text-white dark:text-black border-gray-600 dark:border-gray-300'
                }`} 
                onPress={processPayment} 
                isLoading={submittingPayment}
                isDisabled={isCreditInvalid || isOverCreditLimit}
              >
                {isCreditInvalid ? "⛔ CLIENTE NO SELECCIONADO" : isOverCreditLimit ? "❌ CUPO EXCEDIDO" : (flowType === "out" ? "ENTREGAR EFECTIVO" : "PROCESAR CAPITAL MAESTRO")} <ShieldCheck size={20} className="ml-2" />
              </Button>
            </div>
          </div>
        )}
      </ModalContent>
    </Modal>
  );
}
