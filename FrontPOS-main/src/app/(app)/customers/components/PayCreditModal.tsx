"use client";

import {
  Modal, ModalContent, Button, Avatar
} from "@heroui/react";
import { Banknote, Zap, Check, Wallet, ArrowRight, X, Calculator, ShieldCheck, TrendingUp } from 'lucide-react';
import { Customer } from '@/lib/definitions';
import { formatCurrency } from "@/lib/utils";

interface PayCreditModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  client: Customer | null;
  activePaymentTab: 'cash' | 'NEQUI' | 'DAVIPLATA';
  setActivePaymentTab: (tab: 'cash' | 'NEQUI' | 'DAVIPLATA') => void;
  dialogAmount: string;
  setDialogAmount: (val: string | ((p: string) => string)) => void;
  cashTendered: string;
  setCashTendered: (val: string) => void;
  showSuccessScreen: boolean;
  setShowSuccessScreen: (show: boolean) => void;
  submittingPayment: boolean;
  lastChange: number;
  onPay: () => Promise<void>;
}

export default function PayCreditModal({
  isOpen, onOpenChange, client, activePaymentTab, setActivePaymentTab,
  dialogAmount, setDialogAmount, cashTendered, setCashTendered,
  showSuccessScreen, setShowSuccessScreen, submittingPayment, lastChange, onPay
}: PayCreditModalProps) {
  if (!client && !isOpen) return null;

  const totalDebt = Number(client?.currentCredit || 0);
  const currentDialogVal = Number(dialogAmount) || 0;
  const amountToPayRaw = currentDialogVal > 0 ? currentDialogVal : (Number(cashTendered) > 0 ? Number(cashTendered) : totalDebt);
  const actualPayment = Math.min(amountToPayRaw, totalDebt);

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange} 
      backdrop="blur" 
      size="full" 
      classNames={{ 
        base: "bg-gray-50 dark:bg-zinc-950 max-w-[1100px] h-full md:h-auto md:max-h-[90vh] md:rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-hidden", 
        closeButton: "hidden", 
        wrapper: "p-0 md:p-4" 
      }}
    >
      <ModalContent>
        {() => (
          <div className="flex flex-col md:flex-row h-full overflow-hidden relative">
            {/* Pantalla de Éxito Maestro */}
            {showSuccessScreen && (
              <div className="absolute inset-0 z-[100] bg-emerald-500/10 backdrop-blur-3xl flex flex-col items-center justify-center p-8 animate-in fade-in zoom-in duration-300">
                <div className="h-24 w-24 rounded-[2rem] bg-emerald-500 text-white flex items-center justify-center mb-8 shadow-[0_20px_50px_rgba(16,185,129,0.3)] -rotate-6 scale-110 border-4 border-white/20">
                  <Check size={48} strokeWidth={4} />
                </div>
                <h2 className="text-4xl font-black text-gray-900 dark:text-white uppercase mb-4 italic tracking-tighter text-center leading-none">
                  Abono <span className="text-emerald-500">Realizado</span>
                </h2>
                <span className="text-[10px] font-black text-emerald-600/60 dark:text-emerald-500/40 uppercase tracking-[0.4em] mb-8 italic">PROTOCOLO MAESTRO DE CRÉDITO</span>
                
                <div className="bg-white dark:bg-zinc-900 border-2 border-emerald-500/20 p-12 rounded-[2.5rem] text-center shadow-2xl w-full max-w-sm relative overflow-hidden group">
                  <div className="absolute top-0 right-0 p-4 opacity-5 text-emerald-500 -mr-4 -mt-4"><Banknote size={80} /></div>
                  <p className="text-[10px] font-black text-emerald-500 uppercase mb-4 tracking-[0.3em] italic">CAMBIO A ENTREGAR</p>
                  <p className="text-5xl md:text-7xl font-black text-gray-900 dark:text-white tabular-nums italic tracking-tighter">${formatCurrency(lastChange)}</p>
                </div>
                
                <Button 
                  className="mt-10 bg-gray-900 dark:bg-white text-white dark:text-black font-black px-12 h-16 rounded-2xl italic w-full max-w-sm shadow-2xl flex items-center gap-4 active:scale-95 transition-all text-sm tracking-widest uppercase hover:opacity-90" 
                  onPress={() => onOpenChange(false)}
                >
                  FINALIZAR OPERACIÓN <ArrowRight size={22} />
                </Button>
              </div>
            )}
            
            {/* Sidebar de Métodos Maestro */}
            <div className="w-full md:w-[220px] bg-white dark:bg-zinc-900 border-b md:border-b-0 md:border-r border-gray-200 dark:border-white/5 p-6 flex flex-row md:flex-col gap-3 overflow-x-auto no-scrollbar z-20">
              <div className="hidden md:flex flex-col mb-8 px-2">
                <div className="flex items-center gap-2 mb-2">
                  <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] leading-none">Abono Seguro</span>
                </div>
                <h3 className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.2em] italic">MÉTODO PAGO</h3>
              </div>
              
              {(['cash', 'NEQUI', 'DAVIPLATA'] as const).map(tab => (
                <button 
                  key={tab} 
                  onClick={() => { setActivePaymentTab(tab); setDialogAmount(''); setCashTendered(''); }} 
                  className={`h-14 px-5 rounded-2xl flex items-center gap-4 border transition-all shrink-0 group ${
                    activePaymentTab === tab 
                      ? 'bg-emerald-500/10 dark:bg-emerald-500/20 border-emerald-500/50 text-emerald-600 dark:text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.15)] italic' 
                      : 'bg-gray-50 dark:bg-zinc-800 border-transparent text-gray-500 dark:text-zinc-500 hover:bg-emerald-500/10'
                  }`}
                >
                  <div className={`p-2 rounded-xl transition-colors ${activePaymentTab === tab ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/30' : 'bg-gray-200 dark:bg-zinc-700/50 group-hover:bg-emerald-500/20'}`}>
                    {tab === 'cash' ? <Banknote size={18} /> : <span><img src={tab === 'NEQUI' ? '/logos/nequi.png' : '/logos/daviplata.png'} className="h-5 w-5 object-contain" /></span>}
                  </div>
                  <span className="text-[10px] font-black uppercase italic whitespace-nowrap tracking-widest leading-none">{tab === 'cash' ? 'Efectivo' : tab}</span>
                </button>
              ))}
              <Button variant="flat" className="ml-auto md:ml-0 md:mt-auto h-14 font-black text-[10px] px-6 rounded-2xl bg-rose-500/10 text-rose-500 tracking-widest uppercase italic border border-rose-500/20" onPress={() => onOpenChange(false)}>
                CANCELAR <X size={14} className="ml-1" />
              </Button>
            </div>

            {/* Content Central */}
            <div className="flex-1 bg-gray-50 dark:bg-zinc-950 p-6 md:p-10 flex flex-col relative overflow-y-auto custom-scrollbar z-10">
              <header className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-4">
                <div className="flex flex-col min-w-0">
                  <h1 className="text-3xl font-black dark:text-white uppercase italic tracking-tighter leading-none mb-2">Gestión de <span className="text-emerald-500">Abonos</span></h1>
                  <div className="flex items-center gap-2">
                    <Avatar size="sm" name={client?.name} className="h-6 w-6 rounded-lg bg-emerald-500/10 text-emerald-500" />
                    <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">{client?.name} / CC: {client?.dni}</p>
                  </div>
                </div>
              </header>

              <div className="flex flex-col lg:flex-row gap-4 mb-8">
                <div className="bg-white dark:bg-zinc-900 p-6 rounded-[2rem] border border-gray-100 dark:border-white/5 flex-1 shadow-sm group hover:border-rose-500/30 transition-all">
                  <p className="text-[9px] font-black text-gray-400 uppercase mb-2 tracking-widest flex items-center gap-2"><Wallet size={12} className="text-rose-500" /> SALDO PENDIENTE</p>
                  <p className="text-3xl font-black text-rose-500 italic tabular-nums">${formatCurrency(totalDebt)}</p>
                </div>
                <div className="bg-white dark:bg-zinc-900 p-6 rounded-[2rem] border border-gray-100 dark:border-white/5 flex-1 shadow-sm group hover:border-emerald-500/30 transition-all">
                  <p className="text-[9px] font-black text-gray-400 uppercase mb-2 tracking-widest flex items-center gap-2"><TrendingUp size={12} className="text-emerald-500" /> NUEVO BALANCE</p>
                  <p className="text-3xl font-black text-emerald-500 italic tabular-nums">${formatCurrency(Math.max(0, totalDebt - actualPayment))}</p>
                </div>
              </div>

              {activePaymentTab === 'cash' ? (
                <div className="flex flex-col flex-1">
                  <div className="bg-white dark:bg-zinc-900 p-8 rounded-[2.5rem] border border-gray-200 dark:border-emerald-500/20 flex flex-col justify-center shadow-xl shadow-emerald-500/5 relative overflow-hidden group">
                    <div className="absolute top-0 right-0 p-8 opacity-5 text-emerald-500 group-hover:scale-125 transition-transform"><Banknote size={120} /></div>
                    <p className="text-[10px] font-black text-gray-400 uppercase mb-3 tracking-[0.3em] italic">EFECTIVO RECIBIDO (VALOR)</p>
                    <p className="text-5xl md:text-7xl font-black dark:text-white tabular-nums italic tracking-tighter">${formatCurrency(amountToPayRaw)}</p>
                  </div>
                  
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-6">
                    {[100000, 50000, 20000, 10000, 5000, 2000].map(v => (
                      <Button 
                        key={v} 
                        className="h-16 bg-white dark:bg-zinc-900 hover:bg-emerald-500 hover:text-white dark:text-white text-sm font-black border border-gray-200 dark:border-white/10 shadow-sm rounded-2xl transition-all active:scale-95" 
                        onPress={() => { setCashTendered(String(v)); setDialogAmount(''); }}
                      >
                        ${v.toLocaleString()}
                      </Button>
                    ))}
                  </div>
                  <Button className="md:hidden h-20 mt-6 bg-emerald-500 text-white font-black uppercase rounded-[2rem] italic tracking-widest shadow-2xl shadow-emerald-500/40 text-lg active:scale-95 transition-all" onPress={onPay} isLoading={submittingPayment}>
                    REALIZAR ABONO <ShieldCheck size={24} className="ml-2" />
                  </Button>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center gap-6 group">
                  <div className="h-32 w-32 rounded-[3rem] bg-emerald-500/10 text-emerald-500 flex items-center justify-center shadow-inner group-hover:scale-110 transition-transform"><Zap size={48} className="animate-pulse" /></div>
                  <div className="text-center">
                    <p className="text-2xl font-black dark:text-white italic uppercase tracking-tighter">TRANSACCIÓN <span className="text-emerald-500">{activePaymentTab}</span></p>
                    <p className="text-[10px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-[0.4em] mt-2">REQUIERE VERIFICACIÓN DE COMPROBANTE</p>
                  </div>
                  <Button className="md:hidden h-16 w-full max-w-xs bg-emerald-500 text-white font-black uppercase rounded-2xl mt-8 shadow-xl" onPress={onPay} isLoading={submittingPayment}>SINCRONIZAR ABONO</Button>
                </div>
              )}
            </div>

            {/* Teclado Pad Derecho Maestro */}
            <div className="hidden md:flex w-[320px] bg-white dark:bg-zinc-900 border-l border-gray-200 dark:border-white/5 p-8 flex-col gap-6 z-20">
              <div className="bg-gray-50 dark:bg-zinc-950 p-8 rounded-[2.5rem] border border-gray-200 dark:border-white/10 text-right shadow-inner relative overflow-hidden group">
                <div className="absolute top-0 left-0 p-4 opacity-5 text-emerald-500 scale-150 -ml-4 -mt-4"><Calculator size={60} /></div>
                <p className="text-[10px] font-black text-emerald-500 uppercase mb-3 tracking-[0.2em] italic flex items-center justify-end gap-2 relative z-10"><Calculator size={12} /> DIGITANDO MONTO</p>
                <div className="flex items-center justify-end gap-1 relative z-10">
                  <span className="text-emerald-500 font-black italic text-2xl tracking-tighter">$</span>
                  <p className="text-4xl font-black dark:text-white h-12 tracking-tighter italic tabular-nums leading-none">{formatCurrency(dialogAmount)}</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3 flex-1 pb-4">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '00', 'CE'].map(n => (
                  <Button 
                    key={n} 
                    className={`h-full text-2xl font-black rounded-3xl transition-all shadow-sm active:scale-95 ${
                      n === 'CE' 
                        ? 'text-rose-500 bg-rose-500/10 border-2 border-rose-500/20 active:bg-rose-500 active:text-white' 
                        : 'bg-gray-50 dark:bg-zinc-800 dark:text-white active:bg-emerald-500 active:text-white border border-transparent'
                    }`} 
                    onPress={() => n === 'CE' ? setDialogAmount('') : setDialogAmount((p: string) => p + String(n))}
                  >
                    {n}
                  </Button>
                ))}
              </div>
              <Button 
                className="h-20 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase rounded-3xl italic tracking-[0.2em] shadow-[0_20px_50px_rgba(0,0,0,0.1)] active:scale-95 transition-all text-[11px] border-b-4 border-gray-600 dark:border-gray-300" 
                onPress={onPay} 
                isLoading={submittingPayment}
              >
                PROCESAR CAPITAL MAESTRO <ShieldCheck size={20} className="ml-2" />
              </Button>
            </div>
          </div>
        )}
      </ModalContent>
    </Modal>
  );
}
