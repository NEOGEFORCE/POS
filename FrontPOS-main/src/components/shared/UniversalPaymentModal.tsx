"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
  isAbono?: boolean;
}

export default function UniversalPaymentModal({
  isOpen, 
  onOpenChange, 
  title = "Gestion de Pagos",
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
  onReasonChange,
  isAbono = false
}: UniversalPaymentModalProps) {
  const isProcessingRef = useRef(false);
  const [activePaymentTab, setActivePaymentTab] = useState<'cash' | 'NEQUI' | 'DAVIPLATA' | 'credit'>('cash');
  const [isMobileNumpadOpen, setIsMobileNumpadOpen] = useState(false);
  const [dialogAmount, setDialogAmount] = useState('');
  const [cashTendered, setCashTendered] = useState<string>('');
  
  // Clases estaticas para evitar problemas con el purgado de Tailwind y errores de referencia
  const isOut = flowType === "out";
  const theme = {
    bg: isOut ? "bg-rose-500" : "bg-zinc-800 border border-white/5",
    bgLight: isOut ? "bg-rose-500/10" : "bg-white/5",
    bgHover: isOut ? "hover:bg-rose-500/10" : "hover:bg-white/5",
    text: isOut ? "text-rose-500" : "text-zinc-100",
    textDark: isOut ? "text-rose-600" : "text-zinc-100",
    border: isOut ? "border-rose-500" : "border-emerald-500",
    borderLight: isOut ? "border-rose-500/20" : "border-emerald-500/20",
    shadow: isOut ? "shadow-rose-500/30" : "",
    ring: isOut ? "ring-rose-500" : "ring-emerald-500"
  };
  
  const themeColor = isOut ? 'rose' : 'emerald';
  
  // Estados internos para pagos acumulados (mixtos)
  const [cashPaid, setCashPaid] = useState<number>(0);
  const [nequiPaid, setNequiPaid] = useState<number>(0);
  const [daviplataPaid, setDaviplataPaid] = useState<number>(0);
  const [creditPaid, setCreditPaid] = useState<number>(0);

  const [isReady, setIsReady] = useState(false);
  
  // Inicializar estados cuando se abre el modal
  useEffect(() => {
    if (isOpen) {
      setCashPaid(initialPaidAmounts?.cash || 0);
      setNequiPaid(initialPaidAmounts?.transferSource === 'NEQUI' ? (initialPaidAmounts?.transfer || 0) : 0);
      setDaviplataPaid(initialPaidAmounts?.transferSource === 'DAVIPLATA' ? (initialPaidAmounts?.transfer || 0) : 0);
      setCreditPaid(initialPaidAmounts?.credit || 0);
      setDialogAmount('');
      setCashTendered('');
      setIsMobileNumpadOpen(false);
      setIsReady(false); // No esta listo inmediatamentente
      
      // Determinar tab inicial
      if (initialPaidAmounts?.credit && initialPaidAmounts.credit > 0) setActivePaymentTab('credit');
      else if (initialPaidAmounts?.transfer && initialPaidAmounts.transfer > 0) setActivePaymentTab(initialPaidAmounts.transferSource as any);
      else setActivePaymentTab('cash');

      // Pequeno retardo de seguridad (300ms) para evitar capturar el Enter que abrio el modal
      const timer = setTimeout(() => setIsReady(true), 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen, initialPaidAmounts]);

  const currentDialogVal = Number(dialogAmount) || 0;
  const totalAlreadyPaid = cashPaid + nequiPaid + daviplataPaid + creditPaid;
  const remainingDebt = Math.max(0, totalToPay - totalAlreadyPaid);

  // Valor a mostrar en el display principal
  const amountToPayRaw = currentDialogVal > 0 
    ? currentDialogVal 
    : (Number(cashTendered) > 0 
        ? Number(cashTendered) 
        : (totalAlreadyPaid > 0 || isAbono ? 0 : remainingDebt));
        
  const actualPayment = Math.min(amountToPayRaw, remainingDebt);

  const handleAddPayment = useCallback(() => {
    const val = currentDialogVal > 0 ? currentDialogVal : remainingDebt;
    if (val > 0) {
      if (activePaymentTab === 'NEQUI') {
        setNequiPaid(prev => prev + Math.min(val, remainingDebt));
        setActivePaymentTab('cash');
      } else if (activePaymentTab === 'DAVIPLATA') {
        setDaviplataPaid(prev => prev + Math.min(val, remainingDebt));
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
  }, [currentDialogVal, remainingDebt, activePaymentTab]);

    const isAmountIncomplete = false; // El usuario pidio que pase normal y autocomplete
  
      const isCreditInvalid = !!(activePaymentTab === 'credit' && (!client || client.id === "0" || client.name === "CONSUMIDOR FINAL"));
      const isOverCreditLimit = !!(activePaymentTab === 'credit' && client && (currentDialogVal > 0 ? currentDialogVal : remainingDebt) > (client.creditLimit - client.currentCredit));
  
    const processPayment = useCallback(async () => {
        if (isProcessingRef.current || submittingPayment || isCreditInvalid || isOverCreditLimit || isAmountIncomplete) return;
        isProcessingRef.current = true;
        
        let finalCash = cashPaid;
      let finalNequi = nequiPaid;
      let finalDaviplata = daviplataPaid;
      let finalCredit = creditPaid;
      let finalTendered = Number(cashTendered) || 0;
  
      // --- INTELIGENCIA DE PAGOS MULTIPLES (Fase 2) ---
      // Si el usuario digita un valor, lo tomamos en cuenta al procesar.
      if (currentDialogVal > 0) {
        if (activePaymentTab === 'cash') {
          finalCash += isAbono ? actualPayment : currentDialogVal;
          finalTendered = currentDialogVal;
        } else if (activePaymentTab === 'NEQUI') {
          finalNequi += isAbono ? actualPayment : currentDialogVal;
        } else if (activePaymentTab === 'DAVIPLATA') {
          finalDaviplata += isAbono ? actualPayment : currentDialogVal;
        } else if (activePaymentTab === 'credit') {
          finalCredit += currentDialogVal;
        }
      } else if (finalTendered > 0 && activePaymentTab === 'cash') {
        finalCash += isAbono ? Math.min(finalTendered, remainingDebt) : remainingDebt; // Cash payment added via quick buttons
      } else if (!isAbono) {
        // Autocompletar el resto con el mtodo activo si no digitaron nada (Solo si NO es abono)
        if (activePaymentTab === 'cash') {
          finalCash += remainingDebt;
          finalTendered = finalTendered > 0 ? finalTendered : remainingDebt;
        } else if (activePaymentTab === 'NEQUI') {
          finalNequi += remainingDebt;
        } else if (activePaymentTab === 'DAVIPLATA') {
          finalDaviplata += remainingDebt;
        } else if (activePaymentTab === 'credit') {
          finalCredit += remainingDebt;
        }
      }

      // Autocompletar monto faltante a EFECTIVO (solicitud del usuario: "si hay venta de 2000 y pagan 1000 nequi, el resto efectivo")
      if (!isAbono) {
        const totalCoveredSoFar = finalCash + finalNequi + finalDaviplata + finalCredit;
        const leftToPay = totalToPay - totalCoveredSoFar;
        if (leftToPay > 0) {
          finalCash += leftToPay;
          if (finalTendered < finalCash) {
            finalTendered = finalCash;
          }
        }
      }
  
      const totalPaid = finalCash + finalNequi + finalDaviplata + finalCredit;
      const effectiveCash = finalTendered > 0 ? finalTendered : finalCash;
      const change = Math.max(0, effectiveCash - finalCash);
    
    // Calcular transferSource principal para compatibilidad retroactiva temporal
    let mainTransferSource = "MIXTO";
    if (finalNequi > 0 && finalDaviplata === 0) mainTransferSource = "NEQUI";
    if (finalDaviplata > 0 && finalNequi === 0) mainTransferSource = "DAVIPLATA";

    try {
      await onPay({
        cash: finalCash,
        transfer: finalNequi + finalDaviplata,
        transferSource: mainTransferSource,
        transferNequi: finalNequi,
        transferDaviplata: finalDaviplata,
        credit: finalCredit,
        totalPaid: totalPaid,
        change: change
      } as any);
    } finally {
      isProcessingRef.current = false;
    }
  }, [isCreditInvalid, isOverCreditLimit, cashPaid, nequiPaid, daviplataPaid, creditPaid, cashTendered, currentDialogVal, activePaymentTab, remainingDebt, totalToPay, onPay]);

  // Teclado fisico
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showSuccessScreen) {
        if (e.key === 'Enter' || e.key === 'Escape') {
          onCloseComplete?.();
          onOpenChange(false);
        }
        return;
      }
      
      // BLINDAJE: Si el foco esta en un input o textarea (notas, busqueda, etc), no interceptamos
      const target = e.target as HTMLElement;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') {
        return;
      }

      if (isProcessingRef.current && e.key === 'Enter') {
          e.preventDefault();
          return;
      }

      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        setDialogAmount(prev => prev + e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        setDialogAmount(prev => prev.slice(0, -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (isReady) processPayment();
      } else if (e.key === '+' || e.key === 'Add') {
        e.preventDefault();
        handleAddPayment();
      } else if (e.key === 'Escape') {
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, showSuccessScreen, dialogAmount, onOpenChange, processPayment, handleAddPayment, isReady]);

  if (!isOpen) return null;



  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange} 
      placement="center"
      backdrop="blur" 
      size="full" 
      onClose={onCloseComplete}
    classNames={{ 
        base: "bg-gray-50 dark:bg-zinc-950 max-w-[1300px] h-[100dvh] md:h-auto md:max-h-[88vh] md:rounded-[2.5rem] border-0 md:border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden m-0 md:mx-2 rounded-none", 
        closeButton: "hidden", 
        wrapper: "fixed top-0 left-0 w-screen h-screen bg-[#09090b]/90 z-[9999] flex items-center justify-center" 
      }}
    >
      <ModalContent>
        {() => (
          <div className="flex flex-col md:flex-row h-full overflow-hidden relative">
            {/* Pantalla de Exito Maestro */}
            {showSuccessScreen && (
              <div className="absolute inset-0 z-[100] bg-zinc-950/95 flex flex-col items-center justify-center p-8 animate-in fade-in zoom-in duration-300">
                <div className="bg-white dark:bg-[#18181b] p-10 rounded-[2.5rem] flex flex-col items-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-white/10 w-full max-w-sm relative overflow-hidden group">
                  <div className={`h-20 w-20 rounded-[1.5rem] ${theme.bg} text-white flex items-center justify-center mb-6 shadow-[0_8px_30px_rgb(0,0,0,0.12)] -rotate-3 scale-110 border-4 border-white/20`}>
                    <Check size={40} strokeWidth={4} />
                  </div>
                  <h2 className="text-3xl font-medium text-gray-900 dark:text-white uppercase mb-2 tracking-tight tracking-tighter text-center leading-none">
                    Operacion <span className={theme.text}>Exitosa</span>
                  </h2>
                  <span className={`text-[8px] font-medium opacity-60 ${theme.text} uppercase tracking-[0.4em] mb-6 tracking-tight`}>PROCESADO CON EXITO</span>
                  
                  <div className={`${theme.bgLight} border-2 ${theme.borderLight} p-8 rounded-[2rem] text-center w-full relative overflow-hidden group-hover:scale-[1.02] transition-transform`}>
                    <p className={`text-[9px] font-medium ${theme.text} uppercase mb-3 tracking-[0.3em] tracking-tight`}>CAMBIO A ENTREGAR</p>
                    <p className="text-5xl font-medium text-gray-900 dark:text-white tabular-nums tracking-tight tracking-tighter">${formatCurrency(lastChange)}</p>
                  </div>
                  
                  <Button 
                    className="mt-8 bg-gray-900 dark:bg-white text-white dark:text-black font-medium px-12 h-14 rounded-2xl tracking-tight w-full shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center gap-4 active:scale-95 transition-all text-[11px] tracking-widest uppercase hover:opacity-90" 
                    onPress={() => onOpenChange(false)}
                  >
                    CONTINUAR [ENTER] <ArrowRight size={18} />
                  </Button>
                </div>
              </div>
            )}
            
            {/* Sidebar de Metodos Maestro */}
            <div className="w-full md:w-[220px] bg-white dark:bg-[#18181b] border-b md:border-b-0 md:border-r border-gray-200 dark:border-white/5 p-2 md:p-6 flex flex-col gap-2 md:gap-3 z-20">
              <div className="hidden md:flex flex-col mb-8 px-2">
                <div className="flex items-center gap-2 mb-2">
                  <div className={`h-2 w-2 rounded-2xl ${theme.bg} animate-pulse`} />
                  <span className="text-[10px] font-medium text-gray-400 uppercase tracking-[0.2em] leading-none">Cajero Seguro</span>
                </div>
                <h3 className={`text-[10px] font-medium ${theme.text} uppercase tracking-[0.2em] tracking-tight`}>METODO PAGO</h3>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-1 gap-1.5 md:gap-3">
                {[
                  { id: 'cash', label: 'Efec.', icon: <Banknote size={14} className="md:w-5 md:h-5" /> },
                  { id: 'NEQUI', label: 'Nequi', logo: '/logos/nequi.png' },
                  { id: 'DAVIPLATA', label: 'Daviplata', logo: '/logos/daviplata.png' },
                  { id: 'credit', label: 'Fiado', icon: <Users size={14} className="md:w-5 md:h-5" /> }
                ].filter(tab => tab.id !== 'credit' || showCreditTab).map(tab => (
                  <button 
                    key={tab.id} 
                    onClick={() => { setActivePaymentTab(tab.id as any); setDialogAmount(''); setCashTendered(''); }} 
                    className={`h-10 md:h-14 px-2 md:px-5 rounded-2xl md:rounded-2xl flex items-center justify-center md:justify-start gap-1.5 md:gap-4 border transition-all group ${
                      activePaymentTab === tab.id 
                        ? `${theme.bgLight} ${theme.border} text-gray-900 dark:text-white tracking-tight` 
                        : 'bg-gray-50 dark:bg-zinc-800 border-transparent text-gray-500 dark:text-zinc-500 ' + theme.bgHover
                    }`}
                  >
                    <div className={`p-1 md:p-2 rounded-2xl transition-colors ${activePaymentTab === tab.id ? theme.bg + ' text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)]' : 'bg-gray-200 dark:bg-zinc-700/50 group-hover:' + theme.bg + ' group-hover:text-white'}`}>
                      {tab.icon ? (
                        tab.icon
                      ) : (
                        <img 
                          src={tab.logo} 
                          className={`h-3.5 w-3.5 md:h-7 md:w-7 object-contain ${activePaymentTab === tab.id ? 'brightness-200' : 'opacity-70 group-hover:opacity-100'}`} 
                          alt={tab.label}
                        />
                      )}
                    </div>
                    <span className="text-[7.5px] md:text-[10px] font-medium uppercase tracking-tight whitespace-nowrap tracking-wider md:tracking-widest leading-none">{tab.label}</span>
                  </button>
                ))}
                
                <button 
                  onClick={() => onOpenChange(false)}
                  className="h-10 md:hidden px-2 rounded-2xl flex items-center justify-center gap-1.5 border border-rose-500/20 bg-rose-500/5 text-rose-500 active:scale-95 transition-all group"
                >
                  <div className="p-1 rounded-2xl bg-rose-500/20 text-rose-500">
                    <X size={14} />
                  </div>
                  <span className="text-[7.5px] font-medium uppercase tracking-tight tracking-wider leading-none">Cerrar</span>
                </button>
              </div>

              <Button variant="flat" className="hidden md:flex md:mt-auto h-14 font-medium text-[10px] px-6 rounded-2xl bg-rose-500/10 text-rose-500 tracking-widest uppercase tracking-tight border border-rose-500/20" onPress={() => onOpenChange(false)}>
                CANCELAR <X size={14} className="ml-1" />
              </Button>
            </div>

            {/* Content Central */}
            <div className="flex-1 bg-gray-50 dark:bg-zinc-950 pt-2 md:pt-8 px-3 md:px-10 pb-3 flex flex-col relative overflow-hidden z-10">
              <header className="mb-1 md:mb-4 flex flex-col md:flex-row md:items-end justify-between gap-1 md:gap-4">
                <div className="flex flex-col min-w-0">
                  <h1 className="text-lg md:text-3xl font-medium dark:text-white uppercase tracking-tight tracking-tighter leading-none mb-0.5 md:mb-2 text-center md:text-left">
                    {title.split(' ')[0]} <span className={theme.text}>{title.split(' ').slice(1).join(' ')}</span>
                  </h1>
                  <div className="flex items-center justify-center md:justify-start gap-1.5">
                    <Avatar size="sm" name={client?.name || 'C F'} className={`h-4 w-4 rounded-2xl ${theme.bgLight} ${theme.text} text-[6px]`} />
                    <p className="text-[8px] font-medium text-gray-400 dark:text-zinc-500 uppercase tracking-widest tracking-tight">{client?.name || 'CONSUMIDOR FINAL'} {client?.dni ? `/ CC: ${client.dni}` : ''}</p>
                  </div>
                </div>
                
                {/* Resumen de Pagos Acumulados (Chips) */}
                <div className="flex items-center gap-2">
                  {nequiPaid > 0 && (
                    <div className="px-3 py-1 bg-[#23004C]/10 border border-[#23004C]/20 rounded-2xl flex items-center gap-2">
                       <img src="/logos/nequi.png" className="h-4 w-4 object-contain" />
                       <span className="text-[9px] font-medium text-[#23004C] uppercase tracking-widest">${formatCurrency(nequiPaid)}</span>
                    </div>
                  )}
                  {daviplataPaid > 0 && (
                    <div className="px-3 py-1 bg-red-500/10 border border-red-500/20 rounded-2xl flex items-center gap-2">
                       <img src="/logos/daviplata.png" className="h-4 w-4 object-contain" />
                       <span className="text-[9px] font-medium text-red-500 uppercase tracking-widest">${formatCurrency(daviplataPaid)}</span>
                    </div>
                  )}
                  {cashPaid > 0 && (
                    <div className={`px-3 py-1 ${theme.bgLight} border ${theme.borderLight} rounded-2xl flex items-center gap-2`}>
                       <Banknote size={12} className={theme.text} />
                       <span className={`text-[9px] font-medium ${theme.text} uppercase tracking-widest`}>${formatCurrency(cashPaid)}</span>
                    </div>
                  )}
                  {creditPaid > 0 && (
                    <div className="px-3 py-1 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-center gap-2">
                       <Users size={12} className="text-rose-500" />
                       <span className="text-[9px] font-medium text-rose-500 uppercase tracking-widest">${formatCurrency(creditPaid)}</span>
                    </div>
                  )}
                </div>
              </header>

              <div className="grid grid-cols-3 gap-1.5 mb-1.5">
                <div className="bg-white dark:bg-[#18181b] px-2 py-1 rounded-2xl border border-gray-100 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col justify-center">
                  <p className="text-[6px] md:text-[8px] font-medium text-gray-400 uppercase mb-0 tracking-widest flex items-center gap-1"><Wallet size={6} className="text-rose-500" /> TOTAL</p>
                  <p className="text-sm md:text-2xl font-medium text-rose-500 tracking-tight tabular-nums leading-none">${formatCurrency(totalToPay)}</p>
                </div>
                <div className="bg-white dark:bg-[#18181b] px-2 py-1 rounded-2xl border border-gray-100 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col justify-center">
                  <p className="text-[6px] md:text-[8px] font-medium text-gray-400 uppercase mb-0 tracking-widest flex items-center gap-1"><Check size={6} className={theme.text} /> ABONANDO</p>
                  <p className={`text-sm md:text-2xl font-medium ${theme.text} tracking-tight tabular-nums leading-none`}>${formatCurrency(totalAlreadyPaid + actualPayment)}</p>
                </div>
                <div className="bg-white dark:bg-[#18181b] px-2 py-1 rounded-2xl border border-gray-100 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col justify-center border-emerald-500/30">
                  <p className="text-[6px] md:text-[8px] font-medium text-gray-400 uppercase mb-0 tracking-widest flex items-center gap-1"><TrendingUp size={6} className="text-sky-500" /> RESTANTE</p>
                  <p className="text-sm md:text-2xl font-medium text-sky-500 tracking-tight tabular-nums leading-none">${formatCurrency(Math.max(0, totalToPay - (totalAlreadyPaid + actualPayment)))}</p>
                </div>
              </div>

              {activePaymentTab === 'cash' ? (
                <div className="flex flex-col flex-1 min-h-0 overflow-y-auto pr-1 custom-scrollbar">
                  <div className={`p-2 md:p-4 rounded-2xl border-2 flex flex-col justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] relative overflow-hidden group transition-all duration-500 ${
                    amountToPayRaw > remainingDebt 
                      ? `${theme.bgLight} ${theme.border} border-opacity-30` 
                      : 'bg-white dark:bg-[#18181b] border-gray-200 dark:border-white/10'
                  }`}>
                    <div className={`absolute top-0 right-0 p-2 opacity-5 ${theme.text} group-hover:scale-125 transition-transform`}>
                      {amountToPayRaw > remainingDebt ? <Zap size={28} /> : <Banknote size={28} />}
                    </div>
                    
                    <p className={`text-[7px] md:text-[8px] font-medium uppercase mb-0 tracking-[0.2em] tracking-tight transition-colors ${
                      amountToPayRaw > remainingDebt ? theme.text : 'text-gray-400'
                    }`}>
                      {amountToPayRaw > remainingDebt ? 'CAMBIO (VUELTAS)' : 'EFECTIVO RECIBIDO'}
                    </p>
                    
                    <p className={`text-xl md:text-4xl font-medium tabular-nums tracking-tight tracking-tighter transition-all ${
                      amountToPayRaw > remainingDebt ? theme.text + ' animate-pulse' : 'dark:text-white'
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
                            className="aspect-[2.2/1] w-full bg-white dark:bg-zinc-800 border-[1px] border-gray-100 dark:border-white/5 group active:scale-95 transition-all rounded-2xl md:rounded-2xl p-0 overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.12)] h-auto" 
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
                          className={`aspect-[2.2/1] w-full bg-${themeColor}-500 text-white border-none active:scale-95 transition-all rounded-2xl p-0 flex flex-col items-center justify-center gap-0.5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-${themeColor}-500/20`} 
                          onPress={() => setIsMobileNumpadOpen(true)}
                        >
                          <Calculator size={14} />
                          <span className="text-[7px] font-medium uppercase tracking-tighter">TECLADO</span>
                        </Button>
                      </div>
                        <Button className={`md:hidden h-12 mt-3 ${theme.bg} text-white font-medium uppercase rounded-2xl tracking-tight tracking-widest shadow-[0_8px_30px_rgb(0,0,0,0.12)] text-xs active:scale-95 transition-all`} onPress={processPayment} isLoading={submittingPayment}>
                        PROCESAR PAGO <ShieldCheck size={16} className="ml-1" />
                      </Button>
                    </>
                   ) : (
                    <>
                      <div className="grid grid-cols-3 gap-2 mt-2">
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '00', 'CE'].map(n => (
                          <Button 
                            key={n} 
                            className={`h-11 text-lg font-medium rounded-2xl transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 ${
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
                        <Button className="flex-1 h-12 bg-zinc-800 text-white font-medium uppercase rounded-2xl text-[10px] tracking-widest active:scale-95 transition-all flex items-center justify-center gap-2" onPress={() => setIsMobileNumpadOpen(false)}>
                          <Grid3X3 size={14} /> BILLETES
                        </Button>
                        <Button className={`flex-[2] h-12 ${theme.bg} text-white font-medium uppercase rounded-2xl tracking-tight tracking-widest shadow-[0_8px_30px_rgb(0,0,0,0.12)] text-xs active:scale-95 transition-all`} onPress={processPayment} isLoading={submittingPayment}>
                          REALIZAR <ShieldCheck size={14} />
                        </Button>
                      </div>
                    </>
                   )}
                </div>
              ) : (
                <div className="flex-1 flex flex-col min-h-0 overflow-y-auto pr-1">
                  <div className={`bg-white dark:bg-[#18181b] p-4 rounded-2xl border-2 border-${themeColor}-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col items-center justify-center gap-2 mb-3 relative overflow-hidden group`}>
                    <div className={`absolute inset-0 bg-${themeColor}-500/5 group-hover:bg-${themeColor}-500/10 transition-colors`} />
                    <div className="text-center relative z-10 w-full">
                      <p className="text-sm font-medium dark:text-white tracking-tight uppercase tracking-tighter mb-1">{activePaymentTab === 'credit' ? 'CARTERA FIADO' : `TRANSACCION ${activePaymentTab}`}</p>
                      <div className="flex items-center justify-center gap-1">
                        <span className={`${theme.text} font-medium tracking-tight text-2xl md:text-4xl tracking-tighter`}>$</span>
                        <input 
                          type="text"
                          inputMode="numeric"
                          value={(activePaymentTab === 'credit' && !dialogAmount) ? '' : (dialogAmount ? formatCurrency(dialogAmount) : formatCurrency(amountToPayRaw))}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => {
                            const val = e.target.value.replace(/\D/g, '');
                            setDialogAmount(val);
                          }}
                          className={`w-full max-w-[280px] font-medium text-3xl md:text-5xl tracking-tight ${theme.text} bg-transparent tabular-nums text-center focus:outline-none tracking-tighter leading-none`}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Panel de Inteligencia Crediticia y Validaciones - FASE 1 & 2 */}
                  {activePaymentTab === 'credit' && (
                    <div className="mb-4 animate-in slide-in-from-top-2 duration-300">
                        {(!client || client.id === "0" || client.name === "CONSUMIDOR FINAL") ? (
                            <div className="bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/20 rounded-2xl p-4 flex flex-col gap-1 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                <p className="text-amber-700 dark:text-amber-400 font-medium text-xs flex items-center gap-2 uppercase tracking-tight">
                                    ⚠️ CLIENTE NO SELECCIONADO
                                </p>
                                <p className="text-[10px] text-amber-600 dark:text-amber-500/70 font-medium leading-relaxed">
                                    No se puede fiar a Consumidor Final. Por favor, cancela y selecciona un cliente registrado para asignar la deuda.
                                </p>
                            </div>
                        ) : (
                            <div className={`border rounded-2xl p-3 transition-all duration-300 shadow-[0_8px_30px_rgb(0,0,0,0.12)] ${
                                amountToPayRaw > (client.creditLimit - client.currentCredit)
                                    ? 'bg-rose-50 border-rose-200 dark:bg-rose-500/10 dark:border-rose-500/20'
                                    : 'bg-blue-50 border-blue-200 dark:bg-blue-500/10 dark:border-blue-500/20'
                            }`}>
                                <div className="flex items-center justify-between mb-2">
                                    <p className={`font-medium text-[10px] uppercase tracking-widest ${
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
                                        <span className="text-[11px] font-medium text-gray-700 dark:text-zinc-300 tracking-tight tabular-nums">${formatCurrency(client.currentCredit)}</span>
                                    </div>
                                    <div className="flex flex-col border-x border-gray-200 dark:border-white/5 px-2">
                                        <span className="text-[7px] font-bold text-gray-400 uppercase tracking-tighter">Cupo Maximo</span>
                                        <span className="text-[11px] font-medium text-gray-700 dark:text-zinc-300 tracking-tight tabular-nums">${formatCurrency(client.creditLimit)}</span>
                                    </div>
                                    <div className="flex flex-col items-end">
                                        <span className="text-[7px] font-bold text-gray-400 uppercase tracking-tighter">Cupo Disponible</span>
                                        <span className={`text-[11px] font-medium tracking-tight tabular-nums ${
                                            (client.creditLimit - client.currentCredit) <= 0 ? 'text-rose-500' : 'text-zinc-100'
                                        }`}>
                                            ${formatCurrency(client.creditLimit - client.currentCredit)}
                                        </span>
                                    </div>
                                </div>

                                {amountToPayRaw > (client.creditLimit - client.currentCredit) && (
                                    <div className="mt-2 pt-2 border-t border-rose-200 dark:border-rose-500/20">
                                        <p className="text-[10px] font-medium text-rose-600 dark:text-rose-400 uppercase animate-pulse tracking-tight">
                                            🚨 ESTA VENTA SUPERA EL CUPO DISPONIBLE
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                  )}

                  {/* Numpad para Transferencia / Credito en Movil */}
                  <div className="grid grid-cols-3 gap-2">
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '00', 'CE'].map(n => (
                      <Button 
                        key={n} 
                        className={`h-11 text-lg font-medium rounded-2xl transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 ${
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
                      <p className="text-[8px] font-medium text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] mb-2 ml-1 tracking-tight flex items-center gap-2">
                        <div className={`h-1 w-1 rounded-2xl ${theme.bg}`} /> JUSTIFICACION / NOTA
                      </p>
                      <input 
                        type="text"
                        value={reason || ''}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => onReasonChange(e.target.value)}
                        placeholder="MOTIVO..."
                        className={`w-full h-12 bg-white dark:bg-[#18181b] border border-gray-200 dark:border-white/10 rounded-2xl px-4 text-[10px] font-medium uppercase tracking-widest focus:outline-none focus:border-${theme.ring} transition-all placeholder:text-gray-300 dark:placeholder:text-zinc-700 shadow-[0_8px_30px_rgb(0,0,0,0.12)]`}
                      />
                    </div>
                  )}

                  <Button 
                    className={`md:hidden h-14 w-full font-medium uppercase rounded-2xl mt-4 shadow-[0_8px_30px_rgb(0,0,0,0.12)] text-xs tracking-widest active:scale-95 transition-all tracking-tight ${
                        isCreditInvalid || isOverCreditLimit ? 'bg-gray-300 text-gray-500 cursor-not-allowed opacity-50' : `${theme.bg} text-white`
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
            <div className="hidden md:flex w-[320px] bg-white dark:bg-[#18181b] border-l border-gray-200 dark:border-white/5 p-8 flex-col gap-6 z-20">
              <div className="bg-gray-50 dark:bg-zinc-950 p-8 rounded-[2.5rem] border border-gray-200 dark:border-white/10 text-right shadow-inner relative overflow-hidden group">
                <div className={`absolute top-0 left-0 p-4 opacity-5 ${theme.text} scale-150 -ml-4 -mt-4`}><Calculator size={60} /></div>
                <p className={`text-[10px] font-medium ${theme.text} uppercase tracking-[0.2em] tracking-tight flex items-center justify-end gap-2 relative z-10`}><Calculator size={12} /> DIGITANDO MONTO</p>
                <div className="flex items-center justify-end gap-1 relative z-10">
                  <span className={`${theme.text} font-medium tracking-tight text-2xl md:text-4xl tracking-tighter`}>$</span>
                  <input 
                    type="text"
                    inputMode="numeric"
                    value={dialogAmount ? formatCurrency(dialogAmount) : formatCurrency(amountToPayRaw)}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '');
                      setDialogAmount(val);
                    }}
                    className={`w-full font-medium text-3xl md:text-5xl tracking-tight ${theme.text} bg-transparent border-none text-right focus:outline-none tracking-tighter tabular-nums leading-none`}
                  />
                </div>
              </div>

              {onReasonChange && (
                <div className="animate-in slide-in-from-top-2 duration-300">
                  <p className="text-[8px] font-medium text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] mb-2 ml-1 tracking-tight flex items-center gap-2">
                    <div className={`h-1 w-1 rounded-2xl ${theme.bg}`} /> JUSTIFICACION / NOTA
                  </p>
                  <input 
                    type="text"
                    value={reason || ''}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => onReasonChange(e.target.value)}
                    placeholder="ESCRIBIR MOTIVO..."
                    className={`w-full h-12 bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-[1.2rem] px-5 text-[10px] font-medium uppercase tracking-widest focus:outline-none focus:border-${theme.ring} transition-all placeholder:text-gray-300 dark:placeholder:text-zinc-700 shadow-inner`}
                  />
                </div>
              )}
              <div className="grid grid-cols-3 gap-3 flex-1 pb-4">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '+', 'CE'].map(n => (
                  <Button 
                    key={n} 
                    className={`h-full text-2xl font-medium rounded-2xl transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 ${
                      n === 'CE' 
                        ? 'text-rose-500 bg-rose-500/10 border-2 border-rose-500/20 active:bg-rose-50 active:text-white' 
                        : n === '+'
                        ? theme.bg + ' text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)]'
                        : 'bg-gray-50 dark:bg-zinc-800 dark:text-white active:bg-gray-200 border border-transparent'
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
                className={`h-20 font-medium uppercase rounded-2xl tracking-tight tracking-[0.2em] shadow-[0_20px_50px_rgba(0,0,0,0.1)] active:scale-95 transition-all text-[11px] border-b-4 ${
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
        
        {/* OVERLAY DE SEGURIDAD ANTIDUPLICADO */}
        {(submittingPayment || isProcessingRef.current) && (
          <div className="absolute inset-0 z-[999] flex flex-col items-center justify-center bg-zinc-950/95 animate-in fade-in duration-300">
            <div className="bg-white dark:bg-[#18181b] p-8 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col items-center gap-6 border border-white/10 scale-110">
              <div className="relative">
                <div className={`h-20 w-20 rounded-2xl border-4 ${theme.border} border-t-transparent animate-spin`} />
                <div className="absolute inset-0 flex items-center justify-center">
                  <ShieldCheck className={`h-8 w-8 ${theme.text} animate-pulse`} />
                </div>
              </div>
              <div className="flex flex-col items-center text-center">
                <h3 className="text-xl font-medium text-gray-900 dark:text-white uppercase tracking-tight tracking-tighter">
                  Procesando <span className={theme.text}>Pago</span>
                </h3>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-1">
                  Protegiendo integridad financiera...
                </p>
              </div>
            </div>
          </div>
        )}
      </Modal>
  );
}
