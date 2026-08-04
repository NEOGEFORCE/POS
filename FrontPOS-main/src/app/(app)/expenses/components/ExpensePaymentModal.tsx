import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Modal, ModalContent, Button, Avatar } from '@heroui/react';
import { Banknote, Users, X, ArrowRight, Zap, Check, ShieldCheck, TrendingUp, Landmark } from 'lucide-react';

interface ExpensePaymentModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  totalToPay: number;
  title?: string;
  onPay: (data: {
    cash: number;
    nequi: number;
    daviplata: number;
    fondo: number;
    paymentSourceString: string;
    taxAmount: number;
  }) => Promise<void>;
  onCloseComplete?: () => void;
}

export function ExpensePaymentModal({
  isOpen,
  onOpenChange,
  totalToPay,
  title = "AUTORIZAR EGRESO",
  onPay,
  onCloseComplete
}: ExpensePaymentModalProps) {
  const [activePaymentTab, setActivePaymentTab] = useState<'cash'|'NEQUI'|'DAVIPLATA'|'fondo'>('cash');
  const [dialogAmount, setDialogAmount] = useState<string>('');
  
  const [cashPaid, setCashPaid] = useState<number>(0);
  const [nequiPaid, setNequiPaid] = useState<number>(0);
  const [daviplataPaid, setDaviplataPaid] = useState<number>(0);
  const [fondoPaid, setFondoPaid] = useState<number>(0);

  const [showSuccessScreen, setShowSuccessScreen] = useState(false);
  const [submittingPayment, setSubmittingPayment] = useState(false);

  const isProcessingRef = useRef(false);

  // Reset al abrir
  useEffect(() => {
    if (isOpen) {
      setActivePaymentTab('cash');
      setDialogAmount('');
      setCashPaid(0);
      setNequiPaid(0);
      setDaviplataPaid(0);
      setFondoPaid(0);
      setShowSuccessScreen(false);
      setSubmittingPayment(false);
      isProcessingRef.current = false;
    }
  }, [isOpen]);

  const totalAlreadyPaid = cashPaid + nequiPaid + daviplataPaid + fondoPaid;
  const remainingDebt = Math.max(0, totalToPay - totalAlreadyPaid);
  const isReady = totalAlreadyPaid >= totalToPay || (Number(dialogAmount) > 0 && totalAlreadyPaid + Number(dialogAmount) >= totalToPay);
  
  const currentDialogVal = Number(dialogAmount) || 0;
  const amountToPayRaw = currentDialogVal;
  const actualPayment = Math.min(amountToPayRaw, remainingDebt);

  const visualActualPayment = currentDialogVal > 0 ? actualPayment : remainingDebt;
  const isNequi = activePaymentTab === 'NEQUI';
  const visualTax = isNequi ? Math.round(visualActualPayment * 0.004) : 0;
  const totalTaxAccumulated = Math.round(nequiPaid * 0.004);
  const totalTaxPreview = totalTaxAccumulated + visualTax;

  const handleAddPayment = useCallback(() => {
    const val = currentDialogVal > 0 ? currentDialogVal : remainingDebt;
    if (val > 0) {
      if (activePaymentTab === 'NEQUI') {
        setNequiPaid(prev => prev + Math.min(val, remainingDebt));
        setActivePaymentTab('cash');
      } else if (activePaymentTab === 'DAVIPLATA') {
        setDaviplataPaid(prev => prev + Math.min(val, remainingDebt));
        setActivePaymentTab('cash');
      } else if (activePaymentTab === 'fondo') {
        setFondoPaid(prev => prev + Math.min(val, remainingDebt));
        setActivePaymentTab('cash');
      } else {
        setCashPaid(prev => prev + Math.min(val, remainingDebt));
      }
      setDialogAmount('');
    }
  }, [currentDialogVal, remainingDebt, activePaymentTab]);

  const processPayment = useCallback(async () => {
    if (isProcessingRef.current || submittingPayment) return;
    isProcessingRef.current = true;
    setSubmittingPayment(true);
    
    let finalCash = cashPaid;
    let finalNequi = nequiPaid;
    let finalDaviplata = daviplataPaid;
    let finalFondo = fondoPaid;

    // 1. Aplicar el monto digitado en el input si el usuario no presiono '+' previamente
    if (currentDialogVal > 0) {
      const actualPay = Math.min(currentDialogVal, remainingDebt);
      if (activePaymentTab === 'cash') finalCash += actualPay;
      else if (activePaymentTab === 'NEQUI') finalNequi += actualPay;
      else if (activePaymentTab === 'DAVIPLATA') finalDaviplata += actualPay;
      else if (activePaymentTab === 'fondo') finalFondo += actualPay;
    }

    // 2. Calcular el remanente real que falta por cubrir para completar el 100% del egreso
    const totalAllocated = finalCash + finalNequi + finalDaviplata + finalFondo;
    const leftover = Math.max(0, totalToPay - totalAllocated);

    // 3. Si queda un remanente por pagar, asignarlo al método de pago que esté SELECCIONADO actualmente
    if (leftover > 0) {
      if (activePaymentTab === 'cash') {
        finalCash += leftover;
      } else if (activePaymentTab === 'NEQUI') {
        finalNequi += leftover;
      } else if (activePaymentTab === 'DAVIPLATA') {
        finalDaviplata += leftover;
      } else if (activePaymentTab === 'fondo') {
        finalFondo += leftover;
      }
    }

    // Build the string: NEQUI: $1000 / CAJA: $1000
    const parts: string[] = [];
    if (finalNequi > 0) parts.push(`NEQUI: $${finalNequi}`);
    if (finalDaviplata > 0) parts.push(`DAVIPLATA: $${finalDaviplata}`);
    if (finalCash > 0) parts.push(`CAJA: $${finalCash}`);
    if (finalFondo > 0) parts.push(`FONDO: $${finalFondo}`);
    
    let finalPaymentSource = parts.join(' / ');
    if (!finalPaymentSource) {
      if (finalNequi > 0) finalPaymentSource = 'NEQUI';
      else if (finalDaviplata > 0) finalPaymentSource = 'DAVIPLATA';
      else if (finalFondo > 0) finalPaymentSource = 'FONDO';
      else finalPaymentSource = 'CAJA';
    }

    const finalTax = Math.round(finalNequi * 0.004);

    try {
      await onPay({
        cash: finalCash,
        nequi: finalNequi,
        daviplata: finalDaviplata,
        fondo: finalFondo,
        paymentSourceString: finalPaymentSource,
        taxAmount: finalTax
      });
      setShowSuccessScreen(true);
    } catch (err) {
      console.error(err);
    } finally {
      isProcessingRef.current = false;
      setSubmittingPayment(false);
    }
  }, [cashPaid, nequiPaid, daviplataPaid, fondoPaid, currentDialogVal, activePaymentTab, remainingDebt, actualPayment, onPay, submittingPayment]);

  // Teclado fisico
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (showSuccessScreen) {
        if (e.key === 'Enter' || e.key === 'Escape') {
          onCloseComplete?.();
          onOpenChange(false);
        }
        return;
      }
      
      const target = e.target as HTMLElement;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

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
        if (isReady || currentDialogVal > 0 || remainingDebt > 0) processPayment();
      } else if (e.key === '+' || e.key === 'Add') {
        e.preventDefault();
        handleAddPayment();
      } else if (e.key === 'Escape') {
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, showSuccessScreen, dialogAmount, onOpenChange, processPayment, handleAddPayment, isReady, currentDialogVal, remainingDebt]);

  if (!isOpen) return null;

  const formatCurrency = (val: number) => new Intl.NumberFormat('es-CO').format(val);

  const theme = {
    bg: "bg-rose-500",
    bgLight: "bg-rose-500/10",
    text: "text-rose-500",
    border: "border-rose-500",
    bgHover: "hover:bg-rose-500/5",
    borderLight: "border-rose-500/20"
  };

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
        closeButton: "z-[100] absolute right-4 top-4 md:right-6 md:top-6 bg-gray-200/50 dark:bg-white/10 hover:bg-rose-500 hover:text-white text-gray-600 dark:text-gray-300 rounded-full p-2 md:p-3 transition-colors", 
        wrapper: "fixed top-0 left-0 w-screen h-screen bg-[#09090b]/90 z-[9999] flex items-center justify-center" 
      }}
    >
      <ModalContent>
        {() => (
          <div className="flex flex-col md:flex-row h-full overflow-hidden relative">
            {showSuccessScreen && (
              <div className="absolute inset-0 z-[100] bg-white dark:bg-zinc-950/95 flex flex-col items-center justify-center p-8 animate-in fade-in zoom-in duration-300">
                <div className="bg-white dark:bg-[#18181b] p-10 rounded-[2.5rem] flex flex-col items-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-black/5 dark:border-white/10 w-full max-w-sm relative overflow-hidden">
                  <div className={`h-20 w-20 rounded-[1.5rem] ${theme.bg} text-white flex items-center justify-center mb-6 shadow-[0_8px_30px_rgb(0,0,0,0.12)] -rotate-3 scale-110 border-4 border-black/10 dark:border-white/20`}>
                    <Check size={40} strokeWidth={4} />
                  </div>
                  <h2 className="text-3xl font-medium text-gray-900 dark:text-white uppercase mb-2 tracking-tight tracking-tighter text-center leading-none">
                    Operacion <span className={theme.text}>Exitosa</span>
                  </h2>
                  <span className={`text-[8px] font-medium opacity-60 ${theme.text} uppercase tracking-[0.4em] mb-6 tracking-tight`}>PROCESADO CON EXITO</span>
                  
                  <Button 
                    className="mt-8 bg-gray-900 dark:bg-white text-white dark:text-black font-medium px-12 h-14 rounded-2xl tracking-tight w-full shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center gap-4 active:scale-95 transition-all text-[11px] tracking-widest uppercase hover:opacity-90" 
                    onPress={() => { onCloseComplete?.(); onOpenChange(false); }}
                  >
                    CONTINUAR [ENTER] <ArrowRight size={18} />
                  </Button>
                </div>
              </div>
            )}
            
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
                  { id: 'cash', label: 'Caja', icon: <Banknote size={14} className="md:w-5 md:h-5" /> },
                  { id: 'fondo', label: 'Bóveda', icon: <Landmark size={14} className="md:w-5 md:h-5" /> },
                  { id: 'NEQUI', label: 'Nequi', logo: '/logos/nequi.png' },
                  { id: 'DAVIPLATA', label: 'Daviplata', logo: '/logos/daviplata.png' },
                ].map(tab => (
                  <button 
                    key={tab.id} 
                    onClick={() => { setActivePaymentTab(tab.id as any); setDialogAmount(''); }} 
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
              </div>

              <Button variant="flat" className="hidden md:flex md:mt-auto h-14 font-medium text-[10px] px-6 rounded-2xl bg-rose-500/10 text-rose-500 tracking-widest uppercase tracking-tight border border-rose-500/20" onPress={() => onOpenChange(false)}>
                CANCELAR <X size={14} className="ml-1" />
              </Button>
            </div>

            <div className="flex-1 bg-gray-50 dark:bg-zinc-950 pt-2 md:pt-8 px-3 md:px-10 pb-3 flex flex-col relative overflow-hidden z-10">
              <header className="mb-1 md:mb-4 flex flex-col md:flex-row md:items-end justify-between gap-1 md:gap-4">
                <div className="flex flex-col min-w-0">
                  <h1 className="text-lg md:text-3xl font-medium dark:text-white uppercase tracking-tight tracking-tighter leading-none mb-0.5 md:mb-2 text-center md:text-left">
                    {title.split(' ')[0]} <span className={theme.text}>{title.split(' ').slice(1).join(' ')}</span>
                  </h1>
                </div>
              </header>

              <div className="flex flex-col md:flex-row gap-3 md:gap-8 flex-1 min-h-0">
                <div className="w-full md:w-[360px] flex flex-col gap-2 md:gap-4 flex-shrink-0">
                  <div className="flex flex-col gap-2 w-full max-w-full overflow-x-auto custom-scrollbar pb-1">
                    <div className="flex items-center gap-2">
                      {nequiPaid > 0 && (
                        <div className="px-3 py-1.5 bg-[#23004C]/10 border border-[#23004C]/20 rounded-2xl flex items-center gap-2">
                           <img src="/logos/nequi.png" className="h-4 w-4 object-contain" />
                           <span className="text-[10px] font-medium text-[#23004C] dark:text-[#E8D1FF] uppercase tracking-widest">${formatCurrency(nequiPaid)}</span>
                        </div>
                      )}
                      {daviplataPaid > 0 && (
                        <div className="px-3 py-1.5 bg-red-500/10 border border-red-500/20 rounded-2xl flex items-center gap-2">
                           <img src="/logos/daviplata.png" className="h-4 w-4 object-contain" />
                           <span className="text-[10px] font-medium text-red-500 dark:text-red-400 uppercase tracking-widest">${formatCurrency(daviplataPaid)}</span>
                        </div>
                      )}
                      {fondoPaid > 0 && (
                        <div className="px-3 py-1.5 bg-cyan-500/10 border border-cyan-500/20 rounded-2xl flex items-center gap-2">
                           <Landmark size={14} className="text-cyan-500" />
                           <span className="text-[10px] font-medium text-cyan-600 dark:text-cyan-400 uppercase tracking-widest">${formatCurrency(fondoPaid)}</span>
                        </div>
                      )}
                      {cashPaid > 0 && (
                        <div className="px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl flex items-center gap-2">
                           <Banknote size={14} className="text-emerald-500" />
                           <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 uppercase tracking-widest">${formatCurrency(cashPaid)}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className={`bg-white dark:bg-[#18181b] rounded-[1.5rem] p-4 md:p-6 border-2 ${remainingDebt > 0 ? 'border-rose-500/20 shadow-[0_8px_30px_rgb(244,63,94,0.12)]' : 'border-emerald-500/20 shadow-[0_8px_30px_rgb(16,185,129,0.12)]'} flex flex-col justify-center items-center relative overflow-hidden transition-all duration-500`}>
                    <p className="text-[8px] md:text-[10px] font-medium text-gray-400 uppercase mb-0 tracking-widest flex items-center gap-1"><TrendingUp size={10} className={remainingDebt > 0 ? "text-rose-500" : "text-emerald-500"} /> RESTANTE A PAGAR</p>
                    <p className={`text-2xl md:text-5xl font-medium tracking-tight tabular-nums leading-none mt-1 ${remainingDebt > 0 ? 'text-rose-500' : 'text-emerald-500'}`}>${formatCurrency(remainingDebt)}</p>
                  </div>
                  
                  <div className="flex-1 flex flex-col min-h-0 overflow-y-auto pr-1">
                    <div className={`bg-white dark:bg-[#18181b] p-4 rounded-2xl border-2 border-rose-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col items-center justify-center gap-2 mb-3 relative overflow-hidden group`}>
                      <div className="text-center relative z-10 w-full">
                        <p className="text-sm font-medium dark:text-white tracking-tight uppercase tracking-tighter mb-1">MONTO EN {activePaymentTab}</p>
                        <div className="flex items-center justify-center gap-1">
                          <span className={`${theme.text} font-medium tracking-tight text-2xl md:text-4xl tracking-tighter`}>$</span>
                          <input 
                            type="text"
                            inputMode="numeric"
                            value={dialogAmount ? formatCurrency(Number(dialogAmount)) : formatCurrency(Number(amountToPayRaw))}
                            onFocus={(e) => {
                              const val = e.target.value.replace(/\D/g, '');
                              e.target.value = val;
                              e.target.select();
                            }}
                            onChange={(e) => {
                              const val = e.target.value.replace(/\D/g, '');
                              setDialogAmount(val);
                            }}
                            className={`w-full max-w-[280px] font-medium text-3xl md:text-5xl tracking-tight ${theme.text} bg-transparent tabular-nums text-center focus:outline-none tracking-tighter leading-none`}
                          />
                        </div>
                        {isNequi && visualTax > 0 && (
                          <p className="text-[10px] md:text-[11px] font-medium text-rose-500 mt-2 md:mt-3 uppercase tracking-widest animate-in fade-in slide-in-from-bottom-1">
                            + ${formatCurrency(visualTax)} <span className="opacity-70">GMF 4X1000</span>
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex-1 w-full max-w-[420px] mx-auto md:max-w-none flex flex-col gap-2 md:gap-3 bg-white dark:bg-[#18181b] p-3 md:p-6 rounded-3xl md:rounded-[2rem] border border-gray-200 dark:border-white/5 shadow-sm min-h-0 pb-6 md:pb-6">
                  <div className="grid grid-cols-3 grid-rows-4 gap-2 md:gap-3 flex-1 min-h-0">
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 'CE', 0, '+'].map((n, i) => (
                      <Button 
                        key={i}
                        className={`text-2xl md:text-3xl font-medium rounded-2xl md:rounded-3xl h-full w-full border-b-4 active:scale-95 transition-all text-gray-900 ${
                          n === '+' || n === 'CE' 
                            ? theme.bg + ' text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] border-rose-600'
                            : 'bg-gray-50 dark:bg-zinc-800 dark:text-white active:bg-gray-200 border-gray-200 dark:border-zinc-700 hover:bg-gray-100'
                        }`} 
                        onPress={() => {
                            if (n === 'CE') setDialogAmount('');
                            else if (n === '+') handleAddPayment();
                            else setDialogAmount((p) => p + String(n));
                        }}
                      >
                        {n}
                      </Button>
                    ))}
                  </div>
                  <Button 
                    className={`h-16 md:h-20 mt-1 md:mt-2 font-semibold uppercase rounded-2xl md:rounded-3xl tracking-tight tracking-[0.2em] shadow-[0_10px_40px_rgba(0,0,0,0.1)] active:scale-95 transition-all text-[13px] md:text-[15px] border-b-4 flex flex-col items-center justify-center ${
                         'bg-gray-900 dark:bg-white text-white dark:text-black border-gray-600 dark:border-gray-300'
                    }`} 
                    onPress={processPayment} 
                    isLoading={submittingPayment}
                  >
                    <div className="flex items-center">
                      AUTORIZAR EGRESO <ShieldCheck size={22} className="ml-2" />
                    </div>
                    {totalTaxPreview > 0 && (
                      <span className="text-[9px] font-medium opacity-60 tracking-widest mt-0.5">
                        INCLUYE +${formatCurrency(totalTaxPreview)} DE 4X1000
                      </span>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </ModalContent>
    </Modal>
  );
}
