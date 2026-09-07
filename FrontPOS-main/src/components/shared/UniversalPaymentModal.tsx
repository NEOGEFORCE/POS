"use client";

import { useState, useEffect, useCallback, useRef, ReactNode } from "react";
import {
  Modal, ModalContent, Button, Avatar, Switch
} from "@heroui/react";
import {
  Banknote, Zap, Check, Wallet, ArrowRight, X,
  Calculator, ShieldCheck, TrendingUp, Grid3X3, Users, AlertTriangle,
  Printer, Send, MessageCircle, Trash2
} from 'lucide-react';
import { Customer } from '@/lib/definitions';
import { formatCurrency } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-error";

/* ============================================================================
 * TIPOGRAFÍA — REGLA DE ORO PARA UNA CAJA REGISTRADORA
 * Etiquetas   >= 11px   (uppercase tracking-wider)
 * Datos       >= 13px   (tabular-nums)
 * Dinero KPI  >= 24px md:30px  (tabular-nums tracking-tight)
 * Dinero HERO >= 30px md:48px  (tabular-nums tracking-tight)
 * Un solo tracking por elemento (nunca 'tracking-tight tracking-tighter').
 * ========================================================================== */

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
  lastReceipt?: any;
  onPay: (data: {
    cash: number;
    transfer: number;
    transferSource: string;
    /**
     * Desglose de la transferencia por canal. Se propagan por separado ademas
     * de `transfer` (total) para que el cuadre del turno pueda conciliar
     * contra los saldos reales de Nequi y Daviplata cuando el cliente paga
     * mitad y mitad. `transfer` sigue siendo la suma para no romper a los
     * consumidores existentes.
     */
    transferNequi?: number;
    transferDaviplata?: number;
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
  isRefund?: boolean;
  onClientSelectorOpen?: () => void;
  pendingReturnAmount?: number;
  originalPaymentMethod?: string;
}

/* ---------------------------------------------------------------------------
 * Sub-componentes de presentación (mismo archivo para no dispersar la lógica).
 * Ninguno toca math ni callbacks; solo pintan.
 * ------------------------------------------------------------------------- */

interface SummaryTileProps {
  label: string;
  icon: ReactNode;
  value: number;
  valueClassName?: string;
  containerClassName?: string;
  prefix?: string;
}

function SummaryTile({ label, icon, value, valueClassName = "", containerClassName = "", prefix = "$" }: SummaryTileProps) {
  return (
    <div className={`bg-white dark:bg-[#18181b] px-3 py-2 md:px-4 md:py-3 rounded-2xl border shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col justify-center ${containerClassName}`}>
      <p className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 leading-none mb-1.5">
        {icon}
        <span>{label}</span>
      </p>
      <p className={`text-2xl md:text-3xl font-semibold tabular-nums tracking-tight leading-none ${valueClassName}`}>
        {prefix}{formatCurrency(value)}
      </p>
    </div>
  );
}

interface AccumulatedPillProps {
  label: string;
  icon: ReactNode;
  amount: number;
  colorClass: string;
  bgClass: string;
  borderClass: string;
}

function AccumulatedPill({ label, icon, amount, colorClass, bgClass, borderClass }: AccumulatedPillProps) {
  return (
    <div className={`px-3 py-1.5 ${bgClass} border ${borderClass} rounded-xl flex items-center gap-2`} title={`${label}: $${formatCurrency(amount)}`}>
      {icon}
      <span className={`text-[13px] font-semibold ${colorClass} tabular-nums leading-none`}>
        ${formatCurrency(amount)}
      </span>
    </div>
  );
}

interface NumpadKeyProps {
  value: string | number;
  onPress: () => void;
  variant?: "digit" | "clear" | "add";
  fullHeight?: boolean;
  themeBgClass?: string;
}

function NumpadKey({ value, onPress, variant = "digit", fullHeight = false, themeBgClass = "" }: NumpadKeyProps) {
  const base = "font-semibold rounded-2xl transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95";
  const sizing = fullHeight ? "h-full text-2xl" : "h-12 text-lg";
  const tone =
    variant === "clear"
      ? "text-rose-500 bg-rose-500/10 border-2 border-rose-500/20 active:bg-rose-500/20"
      : variant === "add"
        ? `${themeBgClass} text-white`
        : "bg-white dark:bg-zinc-800 text-gray-900 dark:text-white active:bg-gray-200 dark:active:bg-zinc-700 border border-transparent";
  return (
    <Button
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      className={`${base} ${sizing} ${tone}`}
      onPress={() => {
        onPress();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }}
    >
      {value}
    </Button>
  );
}

/* ---------------------------------------------------------------------------
 * Componente principal
 * ------------------------------------------------------------------------- */

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
  lastReceipt,
  onPay,
  onCloseComplete,
  showCreditTab = true,
  flowType = "in",
  reason,
  onReasonChange,
  isAbono = false,
  isRefund = false,
  onClientSelectorOpen,
  pendingReturnAmount = 0,
  originalPaymentMethod = "EFECTIVO"
}: UniversalPaymentModalProps) {

  const netExchangeBalance = totalToPay - (pendingReturnAmount || 0);
  const isReturnExchange = (pendingReturnAmount || 0) > 0;
  const isTransferReturn = isReturnExchange && !!originalPaymentMethod && (originalPaymentMethod.toUpperCase() !== 'EFECTIVO' && originalPaymentMethod.toUpperCase() !== 'CAJA');
  const isBlockedTransferRefund = isTransferReturn && netExchangeBalance < 0;
  const baseReturnRefund = isReturnExchange && netExchangeBalance < 0 && !isTransferReturn ? Math.abs(netExchangeBalance) : 0;
  const effectiveTotal = isReturnExchange ? Math.max(0, netExchangeBalance) : totalToPay;

  const isProcessingRef = useRef(false);
  const [activePaymentTab, setActivePaymentTab] = useState<'cash' | 'NEQUI' | 'DAVIPLATA' | 'credit'>('cash');
  const [isMobileNumpadOpen, setIsMobileNumpadOpen] = useState(false);
  const [dialogAmount, setDialogAmount] = useState('');
  const [cashTendered, setCashTendered] = useState<string>('');

  // Clases estaticas para evitar problemas con el purgado de Tailwind y errores de referencia
  const isOut = flowType === "out";
  const theme = {
    bg: isOut ? "bg-rose-500" : "bg-gray-100 dark:bg-zinc-800 border border-black/5 dark:border-white/5",
    bgLight: isOut ? "bg-rose-500/10" : "bg-black/5 dark:bg-white/5",
    bgHover: isOut ? "hover:bg-rose-500/10" : "hover:bg-black/5 dark:hover:bg-white/5",
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

      // Pequeño retardo de seguridad (300ms) para evitar capturar el Enter que abrio el modal
      const timer = setTimeout(() => setIsReady(true), 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen, initialPaidAmounts]);

  const currentDialogVal = Number(dialogAmount) || 0;
  const totalAlreadyPaid = cashPaid + nequiPaid + daviplataPaid + creditPaid;
  const remainingDebt = Math.max(0, effectiveTotal - totalAlreadyPaid);

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

  // LIMPIAR PAGOS: Resetear todos los pagos parciales acumulados para empezar de cero
  const handleClearPayments = useCallback(() => {
    setCashPaid(0);
    setNequiPaid(0);
    setDaviplataPaid(0);
    setCreditPaid(0);
    setCashTendered('');
    setDialogAmount('');
    setActivePaymentTab('cash');
  }, []);

  const isCreditInvalid = !!(activePaymentTab === 'credit' && (!client || client.id === "0" || client.name === "CONSUMIDOR FINAL"));
  const isOverCreditLimit = !!(activePaymentTab === 'credit' && client && (currentDialogVal > 0 ? currentDialogVal : remainingDebt) > (client.creditLimit - client.currentCredit));

  const processPayment = useCallback(async () => {
        if (isProcessingRef.current || submittingPayment || isCreditInvalid || isOverCreditLimit || isBlockedTransferRefund) return;
        isProcessingRef.current = true;

        let finalCash = cashPaid;
        let finalNequi = nequiPaid;
        let finalDaviplata = daviplataPaid;
        let finalCredit = creditPaid;
        let finalTendered = Number(cashTendered) || 0;

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
        finalCash += isAbono ? Math.min(finalTendered, remainingDebt) : remainingDebt;
      } else if (!isAbono) {
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

      if (!isAbono) {
        const totalCoveredSoFar = finalCash + finalNequi + finalDaviplata + finalCredit;
        const leftToPay = effectiveTotal - totalCoveredSoFar;
        if (leftToPay > 0) {
          finalCash += leftToPay;
          if (finalTendered < finalCash) {
            finalTendered = finalCash;
          }
        }
      }

      const totalPaid = finalCash + finalNequi + finalDaviplata + finalCredit;
      const effectiveCash = finalTendered > 0 ? finalTendered : finalCash;
      const extraCashChange = Math.max(0, effectiveCash - finalCash);
      const change = baseReturnRefund + extraCashChange;

    let mainTransferSource = "MIXTO";
    if (finalNequi > 0 && finalDaviplata === 0) mainTransferSource = "NEQUI";
    if (finalDaviplata > 0 && finalNequi === 0) mainTransferSource = "DAVIPLATA";

    try {
      await onPay({
        cash: finalCash,
        transfer: finalNequi + finalDaviplata,
        transferSource: mainTransferSource,
        // Se manda el desglose por canal para que el backend registre por
        // separado Nequi y Daviplata. Sin esto, un pago mixto (parte Nequi,
        // parte Daviplata) se sumaba en un solo balde "otras transferencias"
        // y el dueno no podia conciliar contra los saldos de los celulares.
        transferNequi: finalNequi,
        transferDaviplata: finalDaviplata,
        credit: finalCredit,
        totalPaid: totalPaid,
        change: change
      });
    } finally {
      isProcessingRef.current = false;
    }
  }, [isCreditInvalid, isOverCreditLimit, isBlockedTransferRefund, submittingPayment, cashPaid, nequiPaid, daviplataPaid, creditPaid, cashTendered, currentDialogVal, activePaymentTab, remainingDebt, effectiveTotal, baseReturnRefund, onPay, isAbono, actualPayment]);

  const keyboardActionsRef = useRef({ processPayment, handleAddPayment, onOpenChange, onCloseComplete });
  useEffect(() => {
    keyboardActionsRef.current = { processPayment, handleAddPayment, onOpenChange, onCloseComplete };
  }, [processPayment, handleAddPayment, onOpenChange, onCloseComplete]);

  const { toast } = useToast();
  const [isTelegramSending, setIsTelegramSending] = useState(false);
  const [autoPrint, setAutoPrint] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('pos_auto_print_ticket') === 'true';
    }
    return false;
  });

  const generateTicketText = useCallback(() => {
    const rClient = lastReceipt?.clientName || client?.name || "CONSUMIDOR FINAL";
    const rDni = lastReceipt?.clientDni || client?.dni || "0";
    const rDate = lastReceipt?.date || new Date().toLocaleString('es-CO');

    let text = `🧾 *FACTURA DE VENTA N° #${lastReceipt?.saleId || 'POS'}*\n`;
    text += `🏢 *SUPERMERCADO SURTIFAMILIAR*\n`;
    text += `📅 *Fecha:* ${rDate}\n`;
    text += `👤 *Cliente:* ${rClient}\n`;
    text += `📄 *CC/NIT:* ${rDni}\n`;
    text += `--------------------------------\n`;

    (lastReceipt?.items || []).forEach((it: any) => {
      const name = it.product?.productName || it.name || 'Producto';
      const qty = it.quantity || it.cartQuantity || 1;
      const price = it.unitPrice || it.salePrice || it.price || 0;
      const sub = it.subtotal || (qty * price);
      text += `• *${qty}x* ${name}\n  $${formatCurrency(price)} = *$${formatCurrency(sub)}*\n`;
    });

    text += `--------------------------------\n`;
    text += `💰 *TOTAL:* *$${formatCurrency(lastReceipt?.total || totalToPay)}*\n`;
    text += `💳 *MÉTODO:* ${lastReceipt?.paymentMethod || 'EFECTIVO'}\n`;
    if (lastReceipt?.cashAmount > 0) text += `💵 *Efectivo:* $${formatCurrency(lastReceipt.cashAmount)}\n`;
    if (lastReceipt?.transferAmount > 0) text += `📱 *Transferencia:* $${formatCurrency(lastReceipt.transferAmount)}\n`;
    if (lastReceipt?.creditAmount > 0) text += `👥 *Fiado:* $${formatCurrency(lastReceipt.creditAmount)}\n`;
    if ((lastReceipt?.change || lastChange || 0) > 0) text += `🪙 *Cambio:* $${formatCurrency(lastReceipt?.change || lastChange)}\n`;
    text += `\n¡Gracias por su compra! 🙏✨`;
    return text;
  }, [lastReceipt, client, totalToPay, lastChange]);

  const handleTelegramShare = useCallback(async (silent = false) => {
    const text = generateTicketText();
    if (!text) return;
    setIsTelegramSending(true);
    try {
      await apiFetch('/telegram/ticket', {
        method: 'POST',
        body: JSON.stringify({ text }),
        fallbackError: 'Fallo al enviar comprobante a Telegram'
      });
      if (!silent) {
        toast({ title: "FACTURA ENVIADA", description: "Se envió el ticket a Telegram correctamente." });
      }
    } catch (err: any) {
      if (!silent) {
        toast({ variant: "destructive", title: "FALLO TELEGRAM", description: err.message || "Error al enviar comprobante" });
      }
    } finally {
      setIsTelegramSending(false);
    }
  }, [generateTicketText, toast]);

  const handleWhatsAppShare = useCallback(() => {
    const text = generateTicketText();
    if (!text) return;
    let phone = (lastReceipt?.clientPhone || client?.phone || '').replace(/\D/g, '');
    if (phone && !phone.startsWith('57') && phone.length === 10) {
      phone = `57${phone}`;
    }
    const url = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  }, [generateTicketText, lastReceipt, client]);

  const handlePrintTicket = useCallback(() => {
    window.print();
  }, []);

  // Efecto de Auto-Impresión persistente
  useEffect(() => {
    if (showSuccessScreen && autoPrint) {
      const timer = setTimeout(() => {
        window.print();
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [showSuccessScreen, autoPrint]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      const actions = keyboardActionsRef.current;
      if (showSuccessScreen) {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          actions.onCloseComplete?.();
          actions.onOpenChange(false);
        }
        return;
      }

      const target = e.target as HTMLElement;
      if (target?.tagName === 'TEXTAREA') {
        return;
      }

      if (isProcessingRef.current && e.key === 'Enter') {
          e.preventDefault();
          return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        void actions.processPayment();
        return;
      }

      if (target?.tagName === 'INPUT') {
        return;
      }

      if (target?.tagName === 'BUTTON') {
        target.blur();
      }

      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        setDialogAmount(prev => prev + e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        setDialogAmount(prev => prev.slice(0, -1));
      } else if (e.key === '+' || e.key === 'Add') {
        e.preventDefault();
        actions.handleAddPayment();
      } else if (e.key === 'Escape') {
        actions.onOpenChange(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, showSuccessScreen]);

  if (!isOpen) return null;

  // Derivados de presentación (no de math): qué mostrar en el hero del efectivo.
  const showChangeHero = baseReturnRefund > 0 || amountToPayRaw > remainingDebt;
  const cashHeroValue = baseReturnRefund > 0
    ? baseReturnRefund + Math.max(0, (amountToPayRaw > remainingDebt ? amountToPayRaw - remainingDebt : 0))
    : (amountToPayRaw > remainingDebt ? amountToPayRaw - remainingDebt : amountToPayRaw);
  const cashHeroLabel = baseReturnRefund > 0
    ? 'DEVOLUCIÓN AL CLIENTE (VUELTAS)'
    : (amountToPayRaw > remainingDebt ? 'CAMBIO (VUELTAS)' : 'EFECTIVO RECIBIDO');

  const primaryActionLabel = isCreditInvalid
    ? "CLIENTE REQUERIDO"
    : isOverCreditLimit
      ? "CUPO EXCEDIDO"
      : isBlockedTransferRefund
        ? `LLEVAR MÁS PRODUCTOS ($${formatCurrency(Math.abs(netExchangeBalance))})`
        : (flowType === "out" ? "CONFIRMAR REEMBOLSO" : "COMPLETAR VENTA");

  const desktopActionLabel = isCreditInvalid
    ? "CLIENTE NO SELECCIONADO"
    : isOverCreditLimit
      ? "CUPO EXCEDIDO"
      : isBlockedTransferRefund
        ? `LLEVAR MÁS PRODUCTOS ($${formatCurrency(Math.abs(netExchangeBalance))})`
        : (flowType === "out" ? "ENTREGAR EFECTIVO" : "COMPLETAR VENTA");

  const paymentTabs = [
    { id: 'cash' as const, label: 'Efectivo', icon: <Banknote size={18} className="md:w-6 md:h-6" /> },
    { id: 'NEQUI' as const, label: 'Nequi', logo: '/logos/nequi.png' },
    { id: 'DAVIPLATA' as const, label: 'Daviplata', logo: '/logos/daviplata.png' },
    { id: 'credit' as const, label: 'Fiado', icon: <Users size={18} className="md:w-6 md:h-6" /> }
  ]
    .filter(tab => tab.id !== 'credit' || showCreditTab)
    .filter(tab => !isRefund || tab.id === 'cash');

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
        wrapper: "fixed top-0 left-0 w-screen h-screen bg-black/70 z-[9999] flex items-center justify-center"
      }}
    >
      <ModalContent>
        {() => (
          <div className="flex flex-col md:flex-row h-full overflow-hidden relative">
            {showSuccessScreen && (
              <div className="absolute inset-0 z-[100] bg-white dark:bg-zinc-950/95 flex flex-col items-center justify-center p-4 md:p-8 animate-in fade-in zoom-in duration-300">
                <div className="bg-white dark:bg-[#18181b] p-6 md:p-8 rounded-[2.5rem] flex flex-col items-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-black/5 dark:border-white/10 w-full max-w-md relative overflow-hidden group">
                  <div className={`h-16 w-16 rounded-2xl ${theme.bg} text-white flex items-center justify-center mb-4 shadow-[0_8px_30px_rgb(0,0,0,0.12)]`}>
                    <Check size={36} strokeWidth={3.5} />
                  </div>
                  <h2 className="text-2xl md:text-3xl font-semibold text-gray-900 dark:text-white uppercase mb-5 tracking-tight text-center leading-tight">
                    Operación <span className={theme.text}>Exitosa</span>
                  </h2>

                  <div className={`${theme.bgLight} border-2 ${theme.borderLight} px-4 py-5 rounded-2xl text-center w-full mb-5`}>
                    <p className={`text-[11px] font-semibold ${theme.text} uppercase mb-2 tracking-wider`}>CAMBIO A ENTREGAR</p>
                    <p className="text-4xl md:text-5xl font-bold text-gray-900 dark:text-white tabular-nums tracking-tight leading-none">${formatCurrency(lastChange)}</p>
                  </div>

                  {/* FACTURA Y COMPARTIR ACCIONES */}
                  <div className="w-full flex flex-col gap-3 pt-3 border-t border-gray-200 dark:border-white/10">
                    <div className="grid grid-cols-3 gap-2 w-full">
                      <Button
                        size="sm"
                        className="h-11 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 rounded-xl font-semibold uppercase text-[11px] tracking-wider flex items-center justify-center gap-1.5"
                        onPress={handleWhatsAppShare}
                      >
                        <MessageCircle size={15} /> WhatsApp
                      </Button>
                      <Button
                        size="sm"
                        isLoading={isTelegramSending}
                        className="h-11 bg-sky-500/10 hover:bg-sky-500/20 text-sky-600 dark:text-sky-400 border border-sky-500/30 rounded-xl font-semibold uppercase text-[11px] tracking-wider flex items-center justify-center gap-1.5"
                        onPress={() => handleTelegramShare(false)}
                      >
                        <Send size={15} /> Telegram
                      </Button>
                      <Button
                        size="sm"
                        className="h-11 bg-zinc-500/10 hover:bg-zinc-500/20 text-zinc-700 dark:text-zinc-300 border border-zinc-500/30 rounded-xl font-semibold uppercase text-[11px] tracking-wider flex items-center justify-center gap-1.5"
                        onPress={handlePrintTicket}
                      >
                        <Printer size={15} /> Imprimir
                      </Button>
                    </div>

                    {/* INTERRUPTOR DE IMPRESION AUTOMATICA PERSISTENTE */}
                    <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-zinc-900/60 rounded-xl border border-gray-200 dark:border-white/5">
                      <div className="flex items-center gap-3">
                        <Printer size={18} className={autoPrint ? "text-emerald-500" : "text-zinc-400"} />
                        <div className="flex flex-col text-left">
                          <span className="text-[12px] font-semibold text-gray-800 dark:text-zinc-200 uppercase tracking-wider">Impresión automática</span>
                          <span className="text-[11px] font-medium text-gray-500 dark:text-zinc-400">{autoPrint ? "Activa (imprime al cobrar)" : "Inactiva (manual)"}</span>
                        </div>
                      </div>
                      <Switch
                        size="sm"
                        color="success"
                        isSelected={autoPrint}
                        onValueChange={(val) => {
                          setAutoPrint(val);
                          localStorage.setItem('pos_auto_print_ticket', String(val));
                        }}
                      />
                    </div>
                  </div>

                  <Button
                    className="mt-5 bg-gray-900 dark:bg-white text-white dark:text-black font-semibold px-8 h-12 rounded-2xl w-full shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center justify-center gap-3 active:scale-95 transition-all text-[13px] tracking-wider uppercase hover:opacity-90"
                    onPress={() => {
                      onCloseComplete?.();
                      onOpenChange(false);
                    }}
                  >
                    CONTINUAR [ENTER] <ArrowRight size={16} />
                  </Button>
                </div>
              </div>
            )}

            <div className="w-full md:w-[220px] bg-white dark:bg-[#18181b] border-b md:border-b-0 md:border-r border-gray-200 dark:border-white/5 p-2 md:p-6 flex flex-col gap-2 md:gap-3 z-20">
              <div className="hidden md:flex flex-col mb-6 px-1">
                <h3 className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-widest leading-none">
                  Método de pago
                </h3>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-1 gap-1.5 md:gap-3">
                {paymentTabs.map(tab => (
                  <button
                    key={tab.id}
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      setActivePaymentTab(tab.id);
                      setDialogAmount('');
                      setCashTendered('');
                      (e.currentTarget as HTMLElement)?.blur();
                      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                    }}
                    className={`h-11 md:h-14 px-2 md:px-4 rounded-2xl flex items-center justify-center md:justify-start gap-2 md:gap-3 border transition-all group ${
                      activePaymentTab === tab.id
                        ? `${theme.bgLight} ${theme.border} text-gray-900 dark:text-white`
                        : 'bg-gray-50 dark:bg-zinc-800 border-transparent text-gray-600 dark:text-zinc-400 ' + theme.bgHover
                    }`}
                  >
                    <div className={`p-1.5 md:p-2 rounded-xl transition-colors ${activePaymentTab === tab.id ? theme.bg + ' text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)]' : 'bg-gray-200 dark:bg-zinc-700/50 group-hover:' + theme.bg + ' group-hover:text-white'}`}>
                      {tab.icon ? (
                        tab.icon
                      ) : (
                        <img
                          src={tab.logo}
                          className={`h-5 w-5 md:h-6 md:w-6 object-contain ${activePaymentTab === tab.id ? 'brightness-200' : 'opacity-70 group-hover:opacity-100'}`}
                          alt={tab.label}
                        />
                      )}
                    </div>
                    <span className="text-[12px] md:text-[13px] font-semibold uppercase tracking-wider whitespace-nowrap leading-none">{tab.label}</span>
                  </button>
                ))}

                <button
                  onClick={() => onOpenChange(false)}
                  className="h-11 md:hidden px-2 rounded-2xl flex items-center justify-center gap-2 border border-rose-500/20 bg-rose-500/5 text-rose-500 active:scale-95 transition-all"
                >
                  <div className="p-1.5 rounded-xl bg-rose-500/20 text-rose-500">
                    <X size={16} />
                  </div>
                  <span className="text-[12px] font-semibold uppercase tracking-wider leading-none">Cerrar</span>
                </button>
              </div>

              <Button
                variant="flat"
                className="hidden md:flex md:mt-auto h-12 font-semibold text-[12px] px-6 rounded-2xl bg-rose-500/10 text-rose-500 tracking-wider uppercase border border-rose-500/20"
                onPress={() => onOpenChange(false)}
              >
                CANCELAR <X size={14} className="ml-1" />
              </Button>
            </div>

            <div className="flex-1 bg-gray-50 dark:bg-zinc-950 pt-3 md:pt-6 px-3 md:px-8 pb-3 flex flex-col relative overflow-hidden z-10">
              <header className="mb-3 md:mb-4 flex flex-col md:flex-row md:items-end justify-between gap-2 md:gap-4">
                <div className="flex flex-col min-w-0">
                  <h1 className="text-xl md:text-3xl font-semibold text-gray-900 dark:text-white uppercase tracking-tight leading-tight mb-1 text-center md:text-left">
                    {title.split(' ')[0]} <span className={theme.text}>{title.split(' ').slice(1).join(' ')}</span>
                  </h1>
                  <div className="flex items-center justify-center md:justify-start gap-2">
                    <Avatar
                      size="sm"
                      name={client?.name || 'CF'}
                      className={`h-6 w-6 rounded-full ${theme.bgLight} ${theme.text} text-[10px] font-semibold`}
                    />
                    <p className="text-[12px] font-semibold text-gray-600 dark:text-zinc-400 uppercase tracking-wide truncate">
                      {client?.name || 'CONSUMIDOR FINAL'}{client?.dni ? ` · CC ${client.dni}` : ''}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-center md:justify-end gap-2">
                  {nequiPaid > 0 && (
                    <AccumulatedPill
                      label="Nequi"
                      icon={<img src="/logos/nequi.png" className="h-4 w-4 object-contain" alt="Nequi" />}
                      amount={nequiPaid}
                      colorClass="text-[#23004C] dark:text-fuchsia-300"
                      bgClass="bg-[#23004C]/10"
                      borderClass="border-[#23004C]/20 dark:border-fuchsia-500/30"
                    />
                  )}
                  {daviplataPaid > 0 && (
                    <AccumulatedPill
                      label="Daviplata"
                      icon={<img src="/logos/daviplata.png" className="h-4 w-4 object-contain" alt="Daviplata" />}
                      amount={daviplataPaid}
                      colorClass="text-red-600 dark:text-red-400"
                      bgClass="bg-red-500/10"
                      borderClass="border-red-500/20"
                    />
                  )}
                  {cashPaid > 0 && (
                    <AccumulatedPill
                      label="Efectivo"
                      icon={<Banknote size={14} className={theme.text} />}
                      amount={cashPaid}
                      colorClass={theme.text}
                      bgClass={theme.bgLight}
                      borderClass={theme.borderLight}
                    />
                  )}
                  {creditPaid > 0 && (
                    <AccumulatedPill
                      label="Fiado"
                      icon={<Users size={14} className="text-rose-500" />}
                      amount={creditPaid}
                      colorClass="text-rose-600 dark:text-rose-400"
                      bgClass="bg-rose-500/10"
                      borderClass="border-rose-500/20"
                    />
                  )}
                  {(totalAlreadyPaid > 0 || Number(cashTendered) > 0) && (
                    <button
                      type="button"
                      onClick={handleClearPayments}
                      className="px-3 py-1 bg-amber-500/10 border border-amber-500/30 rounded-full flex items-center gap-1.5 hover:bg-amber-500/20 active:scale-95 transition-all"
                    >
                      <Trash2 size={12} className="text-amber-500" />
                      <span className="text-[11px] font-bold text-amber-500 uppercase tracking-wider">LIMPIAR</span>
                    </button>
                  )}
                </div>
              </header>

              {isBlockedTransferRefund && (
                <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-start gap-3 mb-3">
                  <AlertTriangle className="text-amber-500 shrink-0 mt-0.5" size={22} />
                  <div className="flex flex-col gap-1">
                    <span className="text-[12px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider leading-tight">
                      Devolución en efectivo no permitida (venta original en {originalPaymentMethod.toUpperCase()})
                    </span>
                    <span className="text-[13px] font-medium text-amber-700 dark:text-amber-300 leading-snug">
                      No se puede entregar efectivo por caja para devoluciones de compras pagadas por transferencia. El cliente debe llevar más productos por al menos <strong className="text-amber-500 font-bold">${formatCurrency(Math.abs(netExchangeBalance))}</strong> para cubrir el saldo a favor.
                    </span>
                  </div>
                </div>
              )}

              <div className={`grid ${isReturnExchange ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-3'} gap-2 mb-3`}>
                <SummaryTile
                  label="Total a pagar"
                  icon={<Wallet size={12} className="text-rose-500" />}
                  value={totalToPay}
                  valueClassName="text-rose-500"
                  containerClassName="border-gray-100 dark:border-white/5"
                />
                {isReturnExchange && (
                  <SummaryTile
                    label="Saldo a favor"
                    icon={<Zap size={12} className="text-emerald-500" />}
                    value={pendingReturnAmount}
                    valueClassName="text-emerald-500"
                    containerClassName="bg-emerald-500/10 border-emerald-500/20"
                    prefix="-$"
                  />
                )}
                <SummaryTile
                  label={isRefund ? 'Reembolsando' : 'Ya pagado'}
                  icon={<Check size={12} className={theme.text} />}
                  value={totalAlreadyPaid + actualPayment}
                  valueClassName={theme.text}
                  containerClassName="border-gray-100 dark:border-white/5"
                />
                <SummaryTile
                  label={baseReturnRefund > 0 ? 'Cambio a entregar' : 'Restante'}
                  icon={<TrendingUp size={12} className={baseReturnRefund > 0 ? 'text-emerald-500' : 'text-sky-500'} />}
                  value={baseReturnRefund > 0 ? baseReturnRefund : remainingDebt}
                  valueClassName={baseReturnRefund > 0 ? 'text-emerald-500' : 'text-sky-500'}
                  containerClassName={baseReturnRefund > 0
                    ? 'border-emerald-500/50 bg-emerald-500/5'
                    : 'border-gray-100 dark:border-white/5'}
                />
              </div>

              {activePaymentTab === 'cash' ? (
                <div className="flex flex-col flex-1 min-h-0 overflow-y-auto pr-1 custom-scrollbar">
                  <div className={`p-4 md:p-5 rounded-2xl border-2 flex flex-col justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] relative overflow-hidden transition-colors duration-300 ${
                    showChangeHero
                      ? 'bg-emerald-500/10 border-emerald-500/40'
                      : 'bg-white dark:bg-[#18181b] border-gray-200 dark:border-white/10'
                  }`}>
                    {Number(cashTendered) > 0 ? (
                      <button 
                        type="button"
                        onClick={() => { setCashTendered(''); setDialogAmount(''); }}
                        className="absolute top-2 right-2 z-10 p-1.5 md:p-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 text-rose-500 active:scale-90 transition-all"
                        title="Limpiar efectivo ingresado"
                      >
                        <Trash2 size={16} />
                      </button>
                    ) : (
                      <div className={`absolute top-2 right-2 opacity-10 ${showChangeHero ? 'text-emerald-500' : theme.text}`}>
                        {showChangeHero ? <Zap size={32} /> : <Banknote size={32} />}
                      </div>
                    )}

                    <p className={`text-[11px] font-semibold uppercase mb-2 tracking-wider ${
                      showChangeHero ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-500 dark:text-zinc-400'
                    }`}>
                      {cashHeroLabel}
                    </p>

                    <p className={`text-3xl md:text-5xl font-bold tabular-nums tracking-tight leading-none ${
                      showChangeHero ? 'text-emerald-500' : 'text-gray-900 dark:text-white'
                    }`}>
                      ${formatCurrency(cashHeroValue)}
                    </p>
                  </div>

                   {!isMobileNumpadOpen ? (
                     <>
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mt-3 content-start">
                        {[
                          { v: 100000, img: '100.000.jpg' },
                          { v: 50000, img: '50.000.jpg' },
                          { v: 20000, img: '20.000.jpg' },
                          { v: 10000, img: '10.000.jpg' },
                          { v: 5000, img: '5.000.jpg' },
                          { v: 2000, img: '2.000.png' },
                          { v: 1000, img: '1.000.jpg' },
                          { v: 500, img: '500.jpg' },
                          { v: 200, img: '200.jpg' },
                          { v: 100, img: '100.jpg' }
                        ].map(({ v, img }) => (
                          <Button
                            key={v}
                            tabIndex={-1}
                            onMouseDown={(e) => e.preventDefault()}
                            className="aspect-[2.2/1] w-full bg-white dark:bg-zinc-800 border border-gray-100 dark:border-white/5 group active:scale-95 transition-all rounded-2xl p-0 overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.12)] h-auto"
                            aria-label={`Agregar $${formatCurrency(v)}`}
                            onPress={() => {
                              setCashTendered(prev => String(Number(prev || 0) + v));
                              setDialogAmount('');
                              if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                              setTimeout(() => {
                                if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                              }, 0);
                            }}
                          >
                            <img
                              src={`/logos/${img}`}
                              className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-500"
                              alt={`Billete de ${v}`}
                            />
                          </Button>
                        ))}
                        <Button
                          className={`aspect-[2.2/1] w-full lg:col-span-2 bg-${themeColor}-500 text-white border-none active:scale-95 transition-all rounded-2xl p-0 flex flex-col items-center justify-center gap-1 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-${themeColor}-500/20`}
                          onPress={() => setIsMobileNumpadOpen(true)}
                        >
                          <Calculator size={18} />
                          <span className="text-[11px] font-semibold uppercase tracking-wider">Teclado</span>
                        </Button>
                      </div>
                      <Button
                        className={`md:hidden h-14 mt-4 ${theme.bg} text-white font-semibold uppercase rounded-2xl tracking-wider shadow-[0_8px_30px_rgb(0,0,0,0.12)] text-[13px] active:scale-95 transition-all`}
                        onPress={processPayment}
                        isLoading={submittingPayment}
                      >
                        PROCESAR PAGO <ShieldCheck size={18} className="ml-2" />
                      </Button>
                    </>
                   ) : (
                    <>
                      <div className="grid grid-cols-3 gap-2 mt-3">
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '00', 'CE'].map(n => (
                          <NumpadKey
                            key={n}
                            value={n}
                            variant={n === 'CE' ? 'clear' : 'digit'}
                            onPress={() => {
                              if (n === 'CE') setDialogAmount('');
                              else setDialogAmount((p: string) => p + String(n));
                            }}
                          />
                        ))}
                      </div>
                      <div className="flex gap-2 mt-3">
                        <Button
                          className="flex-1 h-12 bg-gray-100 dark:bg-zinc-800 text-zinc-900 dark:text-white font-semibold uppercase rounded-2xl text-[12px] tracking-wider active:scale-95 transition-all flex items-center justify-center gap-2"
                          onPress={() => setIsMobileNumpadOpen(false)}
                        >
                          <Grid3X3 size={16} /> BILLETES
                        </Button>
                        <Button
                          className={`flex-[2] h-12 ${theme.bg} text-white font-semibold uppercase rounded-2xl tracking-wider shadow-[0_8px_30px_rgb(0,0,0,0.12)] text-[13px] active:scale-95 transition-all`}
                          onPress={processPayment}
                          isLoading={submittingPayment}
                        >
                          REALIZAR <ShieldCheck size={16} />
                        </Button>
                      </div>
                    </>
                   )}
                </div>
              ) : (
                <div className="flex-1 flex flex-col min-h-0 overflow-y-auto pr-1 custom-scrollbar">
                  <label className={`bg-white dark:bg-[#18181b] p-4 md:p-5 rounded-2xl border-2 border-${themeColor}-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col items-center justify-center gap-2 mb-3 relative overflow-hidden cursor-text`}>
                    <div className={`absolute inset-0 bg-${themeColor}-500/5`} />
                    <div className="text-center relative z-10 w-full">
                      <p className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 tracking-wider uppercase mb-2">
                        {activePaymentTab === 'credit' ? 'MONTO A FIAR' : `MONTO POR ${activePaymentTab}`}
                      </p>
                      <div className="flex items-center justify-center gap-1">
                        <span className={`${theme.text} font-semibold text-3xl md:text-5xl tracking-tight`}>$</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          aria-label={`Monto a pagar por ${activePaymentTab}`}
                          value={(activePaymentTab === 'credit' && !dialogAmount) ? '' : (dialogAmount ? formatCurrency(Number(dialogAmount)) : formatCurrency(Number(amountToPayRaw)))}
                          onFocus={(e) => {
                            const val = e.target.value.replace(/\D/g, '');
                            e.target.value = val;
                            e.target.select();
                          }}
                          onChange={(e) => {
                            const val = e.target.value.replace(/\D/g, '');
                            setDialogAmount(val);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              processPayment();
                            }
                          }}
                          className={`w-full max-w-[280px] font-bold text-3xl md:text-5xl tracking-tight ${theme.text} bg-transparent tabular-nums text-center focus:outline-none leading-none`}
                        />
                      </div>
                    </div>
                  </label>

                  {activePaymentTab === 'credit' && (
                    <div className="mb-4 animate-in slide-in-from-top-2 duration-300">
                        {(!client || client.id === "0" || client.name === "CONSUMIDOR FINAL") ? (
                            <div className="bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/20 rounded-2xl p-4 flex flex-col gap-2 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                <p className="text-amber-700 dark:text-amber-400 font-semibold text-[13px] flex items-center gap-2 uppercase tracking-wider">
                                    ⚠️ Cliente no seleccionado
                                </p>
                                <p className="text-[12px] text-amber-700 dark:text-amber-500/80 font-medium leading-relaxed">
                                    No se puede fiar a Consumidor Final. Cancela y selecciona un cliente registrado para asignar la deuda, o pulsa el botón de abajo.
                                </p>
                                {onClientSelectorOpen && (
                                    <Button
                                        color="warning"
                                        size="sm"
                                        className="font-semibold text-[12px] uppercase tracking-wider rounded-xl"
                                        onPress={onClientSelectorOpen}
                                    >
                                        Seleccionar cliente
                                    </Button>
                                )}
                            </div>
                        ) : (
                            <div className={`border rounded-2xl p-4 transition-all duration-300 shadow-[0_8px_30px_rgb(0,0,0,0.12)] ${
                                amountToPayRaw > (client.creditLimit - client.currentCredit)
                                    ? 'bg-rose-50 border-rose-200 dark:bg-rose-500/10 dark:border-rose-500/20'
                                    : 'bg-blue-50 border-blue-200 dark:bg-blue-500/10 dark:border-blue-500/20'
                            }`}>
                                <div className="flex items-center justify-between mb-3">
                                    <p className={`font-semibold text-[12px] uppercase tracking-wider ${
                                        amountToPayRaw > (client.creditLimit - client.currentCredit)
                                            ? 'text-rose-600 dark:text-rose-400'
                                            : 'text-blue-600 dark:text-blue-400'
                                    }`}>
                                        Cupo de crédito
                                    </p>
                                    <Users size={16} className={ amountToPayRaw > (client.creditLimit - client.currentCredit) ? 'text-rose-500' : 'text-blue-500'} />
                                </div>

                                <div className="grid grid-cols-3 gap-2">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-wider">Deuda actual</span>
                                        <span className="text-[15px] font-semibold text-gray-800 dark:text-zinc-200 tabular-nums tracking-tight">${formatCurrency(client.currentCredit)}</span>
                                    </div>
                                    <div className="flex flex-col gap-1 border-x border-gray-200 dark:border-white/5 px-2">
                                        <span className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-wider">Cupo máximo</span>
                                        <span className="text-[15px] font-semibold text-gray-800 dark:text-zinc-200 tabular-nums tracking-tight">${formatCurrency(client.creditLimit)}</span>
                                    </div>
                                    <div className="flex flex-col gap-1 items-end">
                                        <span className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-wider">Disponible</span>
                                        <span className={`text-[15px] font-semibold tabular-nums tracking-tight ${
                                            (client.creditLimit - client.currentCredit) <= 0 ? 'text-rose-500' : 'text-emerald-600 dark:text-emerald-400'
                                        }`}>
                                            ${formatCurrency(client.creditLimit - client.currentCredit)}
                                        </span>
                                    </div>
                                </div>

                                {amountToPayRaw > (client.creditLimit - client.currentCredit) && (
                                    <div className="mt-3 pt-3 border-t border-rose-200 dark:border-rose-500/20">
                                        <p className="text-[12px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-wider">
                                            🚨 Esta venta supera el cupo disponible
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-2">
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '00', 'CE'].map(n => (
                      <NumpadKey
                        key={n}
                        value={n}
                        variant={n === 'CE' ? 'clear' : 'digit'}
                        onPress={() => {
                          if (n === 'CE') setDialogAmount('');
                          else setDialogAmount((p: string) => p + String(n));
                        }}
                      />
                    ))}
                  </div>

                  {onReasonChange && (
                    <div className="mt-4 animate-in slide-in-from-top-2 duration-300">
                      <label className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-wider mb-2 ml-1 flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${theme.bg}`} /> Justificación / nota
                      </label>
                      <input
                        type="text"
                        value={reason || ''}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => onReasonChange(e.target.value)}
                        placeholder="Motivo..."
                        className={`w-full h-12 bg-white dark:bg-[#18181b] border border-gray-200 dark:border-white/10 rounded-2xl px-4 text-[13px] font-medium focus:outline-none focus:border-${theme.ring} transition-all placeholder:text-gray-400 dark:placeholder:text-zinc-600 shadow-[0_8px_30px_rgb(0,0,0,0.12)]`}
                      />
                    </div>
                  )}

                  <Button
                    className={`md:hidden h-14 w-full font-semibold uppercase rounded-2xl mt-4 shadow-[0_8px_30px_rgb(0,0,0,0.12)] text-[13px] tracking-wider active:scale-95 transition-all ${
                        isCreditInvalid || isOverCreditLimit || isBlockedTransferRefund ? 'bg-amber-500/20 text-amber-500 border border-amber-500/30 cursor-not-allowed' : `${theme.bg} text-white`
                    }`}
                    onPress={processPayment}
                    isLoading={submittingPayment}
                    isDisabled={isCreditInvalid || isOverCreditLimit || isBlockedTransferRefund}
                  >
                    {primaryActionLabel} <Check size={18} className="ml-2" />
                  </Button>
                </div>
              )}
            </div>

            {/* Teclado Pad Derecho Maestro */}
            <div className="hidden md:flex w-[320px] bg-white dark:bg-[#18181b] border-l border-gray-200 dark:border-white/5 p-6 flex-col gap-4 z-20">
              <label className="bg-gray-50 dark:bg-zinc-950 p-5 rounded-2xl border border-gray-200 dark:border-white/10 text-right shadow-inner relative overflow-hidden cursor-text">
                <div className={`absolute top-2 left-2 opacity-5 ${theme.text}`}><Calculator size={44} /></div>
                <p className={`text-[11px] font-semibold ${theme.text} uppercase tracking-wider flex items-center justify-end gap-2 relative z-10 mb-2`}>
                  <Calculator size={13} /> Monto ingresado
                </p>
                <div className="flex items-center justify-end gap-1 relative z-10">
                  <span className={`${theme.text} font-semibold text-3xl md:text-5xl tracking-tight`}>$</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label="Monto ingresado"
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
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          processPayment();
                        }
                      }}
                    className={`w-full font-bold text-3xl md:text-5xl tracking-tight ${theme.text} bg-transparent border-none text-right focus:outline-none tabular-nums leading-none`}
                  />
                </div>
              </label>

              {onReasonChange && (
                <div className="animate-in slide-in-from-top-2 duration-300">
                  <label className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-wider mb-2 ml-1 flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${theme.bg}`} /> Justificación / nota
                  </label>
                  <input
                    type="text"
                    value={reason || ''}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => onReasonChange(e.target.value)}
                    placeholder="Escribir motivo..."
                    className={`w-full h-11 bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-xl px-4 text-[13px] font-medium focus:outline-none focus:border-${theme.ring} transition-all placeholder:text-gray-400 dark:placeholder:text-zinc-600 shadow-inner`}
                  />
                </div>
              )}
              <div className="grid grid-cols-3 gap-3 flex-1 pb-2">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '+', 'CE'].map(n => (
                  <NumpadKey
                    key={n}
                    value={n}
                    variant={n === 'CE' ? 'clear' : n === '+' ? 'add' : 'digit'}
                    themeBgClass={theme.bg}
                    fullHeight
                    onPress={() => {
                      if (n === 'CE') setDialogAmount('');
                      else if (n === '+') handleAddPayment();
                      else setDialogAmount((p: string) => p + String(n));
                    }}
                  />
                ))}
              </div>
              <Button
                className={`h-20 font-semibold uppercase rounded-2xl tracking-wider shadow-[0_20px_50px_rgba(0,0,0,0.1)] active:scale-95 transition-all text-[13px] border-b-4 ${
                    isCreditInvalid || isOverCreditLimit || isBlockedTransferRefund
                        ? 'bg-amber-500/20 text-amber-500 border-amber-500/40 cursor-not-allowed'
                        : 'bg-gray-900 dark:bg-white text-white dark:text-black border-gray-600 dark:border-gray-300'
                }`}
                onPress={processPayment}
                isLoading={submittingPayment}
                isDisabled={isCreditInvalid || isOverCreditLimit || isBlockedTransferRefund}
              >
                {desktopActionLabel} <ShieldCheck size={20} className="ml-2" />
              </Button>
            </div>
          </div>
        )}
        </ModalContent>

        {/* OVERLAY DE SEGURIDAD ANTIDUPLICADO */}
        {!showSuccessScreen && (submittingPayment || isProcessingRef.current) && (
          <div className="absolute inset-0 z-[999] flex flex-col items-center justify-center bg-white dark:bg-zinc-950/95 animate-in fade-in duration-300">
            <div className="bg-white dark:bg-[#18181b] p-8 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col items-center gap-5 border border-black/5 dark:border-white/10">
              <div className="relative">
                <div className={`h-20 w-20 rounded-full border-4 ${theme.border} border-t-transparent animate-spin`} />
                <div className="absolute inset-0 flex items-center justify-center">
                  <ShieldCheck className={`h-8 w-8 ${theme.text}`} />
                </div>
              </div>
              <div className="flex flex-col items-center text-center">
                <h3 className="text-xl font-semibold text-gray-900 dark:text-white uppercase tracking-tight">
                  Procesando <span className={theme.text}>pago</span>
                </h3>
                <p className="text-[12px] font-medium text-gray-500 dark:text-zinc-400 mt-1">
                  No cierres esta ventana.
                </p>
              </div>
            </div>
          </div>
        )}
      </Modal>
  );
}
