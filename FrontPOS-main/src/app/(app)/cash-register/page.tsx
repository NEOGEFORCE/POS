"use client";

import { Card, Button, Input, Textarea, Skeleton } from "@heroui/react";
import { 
  TrendingUp, TrendingDown, 
  Lock, ArrowRight, Banknote, 
  XCircle, CheckCircle2, AlertTriangle, ArrowRightCircle, Receipt, Calculator
} from 'lucide-react';
import { useApi } from "@/hooks/use-api";
import { formatCurrency } from "@/lib/utils";
import React, { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";

interface CashClosure {
  id: number;
  totalSales: number;
  totalCash: number;
  totalCard: number;
  totalTransfer: number;
  totalExpenses: number;
  totalReturns: number;
  expectedCash: number;
  actualCash: number;
  difference: number;
  status: 'BALANCED' | 'SHORTAGE' | 'SURPLUS';
  date: string;
  createdBy: string;
}

export default function CashRegisterPage() {
  const { data: closure, isLoading } = useApi<CashClosure>("/dashboard/cashier-closure", {
    revalidateOnFocus: true,
  });
  const { toast } = useToast();

  const [actualCashInput, setActualCashInput] = useState('');
  const [closingNote, setClosingNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Calculadora de denominaciones
  const [bills, setBills] = useState({
    '100000': '',
    '50000': '',
    '20000': '',
    '10000': '',
    '5000': '',
    '2000': '',
    '1000': '',
  });
  const [coinsValue, setCoinsValue] = useState('');

  // Sincronizar calculadora con el input gigante
  useEffect(() => {
    let sum = 0;
    Object.entries(bills).forEach(([val, qty]) => {
      sum += parseInt(val) * (parseInt(qty) || 0);
    });
    sum += parseInt(coinsValue || '0');

    const hasUsedGrid = Object.values(bills).some(v => v !== '') || coinsValue !== '';
    if (hasUsedGrid) {
      setActualCashInput(sum.toString());
    }
  }, [bills, coinsValue]);

  const expectedCash = closure?.expectedCash || 0;
  const actualCash = parseFloat(actualCashInput) || 0;
  const difference = actualCash - expectedCash;

  const getStatus = () => {
    if (!actualCashInput) return 'PENDING';
    if (difference === 0) return 'BALANCED';
    if (difference < 0) return 'SHORTAGE';
    return 'SURPLUS';
  };
  const status = getStatus();

  const handleCloseRegister = async () => {
    if (status === 'SHORTAGE' && !closingNote.trim()) {
      toast({
        variant: 'destructive',
        title: 'JUSTIFICACIÓN REQUERIDA',
        description: 'Debes escribir una justificación para el faltante.',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/cash-register/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actualCash: actualCash,
          note: closingNote
        })
      });
      
      if (!res.ok) throw new Error("Error al cerrar caja");

      toast({
        variant: 'success',
        title: 'CAJA CERRADA EXITOSAMENTE',
        description: 'El turno ha finalizado.',
      });
      
      window.location.reload();
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: 'ERROR AL CERRAR',
        description: err.message || 'Ha ocurrido un error inesperado.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const salidasTotales = (closure?.totalExpenses || 0) + (closure?.totalReturns || 0);

  return (
    <div className="flex flex-col w-full min-h-screen bg-zinc-950 text-white p-3 md:p-6 gap-6 overflow-y-auto custom-scrollbar pb-24">
      
      {/* HEADER */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="h-10 w-10 bg-emerald-500 text-white rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/20 transform -rotate-3">
          <Lock size={20} />
        </div>
        <div className="flex flex-col">
          <h1 className="text-2xl md:text-3xl font-black text-white tracking-tighter uppercase italic leading-none">
            Cierre de <span className="text-emerald-500">Caja</span>
          </h1>
          <p className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.4em] italic mt-1">Procedimiento de Cuadre</p>
        </div>
      </div>

      {/* TOP CARDS KPI */}
      <div className="grid grid-cols-3 gap-3 md:gap-4 shrink-0">
        {/* Entradas/Ventas */}
        <div className="bg-zinc-900/40 backdrop-blur-md border border-white/10 rounded-2xl p-4 md:p-5 flex flex-col relative overflow-hidden group hover:border-emerald-500/30 transition-colors">
          <div className="absolute -right-6 -top-6 w-24 h-24 bg-emerald-500/10 rounded-full blur-2xl" />
          <span className="text-emerald-400 text-[10px] font-black tracking-widest uppercase mb-1 flex items-center gap-2">
            <TrendingUp size={12} /> Entradas Efectivo
          </span>
          {isLoading ? <Skeleton className="h-8 w-24 rounded bg-zinc-800" /> : (
            <span className="text-white font-black italic text-2xl md:text-3xl tabular-nums tracking-tighter">
              {formatCurrency(closure?.totalCash || 0)}
            </span>
          )}
        </div>

        {/* Salidas/Gastos */}
        <div className="bg-zinc-900/40 backdrop-blur-md border border-white/10 rounded-2xl p-4 md:p-5 flex flex-col relative overflow-hidden group hover:border-rose-500/30 transition-colors">
          <div className="absolute -right-6 -top-6 w-24 h-24 bg-rose-500/10 rounded-full blur-2xl" />
          <span className="text-rose-400 text-[10px] font-black tracking-widest uppercase mb-1 flex items-center gap-2">
            <TrendingDown size={12} /> Salidas Efectivo
          </span>
          {isLoading ? <Skeleton className="h-8 w-24 rounded bg-zinc-800" /> : (
            <span className="text-white font-black italic text-2xl md:text-3xl tabular-nums tracking-tighter">
              {formatCurrency(salidasTotales)}
            </span>
          )}
        </div>

        {/* Total Esperado */}
        <div className="bg-zinc-900/40 backdrop-blur-md border border-blue-500/20 rounded-2xl p-4 md:p-5 flex flex-col relative overflow-hidden group shadow-[0_0_30px_rgba(59,130,246,0.1)]">
          <div className="absolute -right-6 -top-6 w-32 h-32 bg-blue-500/20 rounded-full blur-3xl" />
          <span className="text-blue-400 text-[10px] font-black tracking-widest uppercase mb-1 flex items-center gap-2">
            <Calculator size={12} /> Total Esperado
          </span>
          {isLoading ? <Skeleton className="h-8 w-32 rounded bg-zinc-800" /> : (
            <span className="text-blue-400 font-black italic text-2xl md:text-3xl tabular-nums tracking-tighter">
              {formatCurrency(expectedCash)}
            </span>
          )}
        </div>
      </div>

      {/* BLOQUE PRINCIPAL DIVIDIDO */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-4 md:gap-6 flex-1">
        
        {/* BLOQUE IZQUIERDO: RESUMEN INTOCABLE */}
        <div className="bg-zinc-900/60 backdrop-blur-xl border border-white/5 rounded-[2rem] p-6 md:p-8 flex flex-col relative overflow-hidden shadow-2xl">
          <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-zinc-800 via-zinc-700 to-zinc-800 opacity-50" />
          
          <div className="flex items-center gap-3 mb-8">
            <div className="h-8 w-8 rounded-full bg-zinc-800 flex items-center justify-center">
              <Receipt size={14} className="text-zinc-400" />
            </div>
            <h2 className="text-sm font-black uppercase tracking-[0.2em] text-zinc-400">Resumen del Turno</h2>
          </div>

          <div className="space-y-6 flex-1">
            <div className="flex flex-col">
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1">1. Efectivo Entrante</span>
              <span className="text-2xl font-black italic tracking-tighter text-emerald-400 tabular-nums">+{formatCurrency(closure?.totalCash || 0)}</span>
            </div>

            <div className="flex flex-col">
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1">2. Efectivo Saliente</span>
              <span className="text-2xl font-black italic tracking-tighter text-rose-400 tabular-nums">-{formatCurrency(salidasTotales)}</span>
            </div>

            <div className="w-full h-px bg-white/10 my-4 border-b border-dashed border-zinc-700" />

            <div className="flex flex-col bg-blue-500/10 p-4 rounded-2xl border border-blue-500/20">
              <span className="text-[12px] font-black text-blue-400 uppercase tracking-[0.2em] mb-1">Efectivo Físico Esperado</span>
              <span className="text-4xl font-black italic tracking-tighter text-blue-500 tabular-nums">{formatCurrency(expectedCash)}</span>
            </div>
          </div>
        </div>

        {/* BLOQUE DERECHO: INTERACCIÓN CAJERO */}
        <div className="bg-zinc-900/60 backdrop-blur-xl border border-white/5 rounded-[2rem] p-6 md:p-8 flex flex-col gap-6 md:gap-8 shadow-2xl relative">
          
          {/* Input Gigante */}
          <div className="flex flex-col gap-2 relative z-10">
            <label className="text-[12px] md:text-sm font-black uppercase tracking-[0.3em] text-zinc-400 flex items-center gap-2">
              <Banknote size={16} className="text-emerald-500" />
              Efectivo Real en el Cajón
            </label>
            <Input
              type="number"
              placeholder="0"
              value={actualCashInput}
              onChange={(e) => setActualCashInput(e.target.value)}
              className="w-full"
              classNames={{
                inputWrapper: "h-20 md:h-24 bg-zinc-950 border border-white/10 rounded-2xl shadow-inner px-6",
                input: "text-4xl md:text-6xl font-black tabular-nums text-white text-right italic placeholder:text-zinc-800",
              }}
              startContent={<span className="text-3xl font-black text-zinc-600">$</span>}
            />
          </div>

          {/* Calculadora Rápida */}
          <div className="flex flex-col gap-3 relative z-10">
            <label className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500">Calculadora Rápida (Opcional)</label>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {['100000', '50000', '20000', '10000', '5000', '2000', '1000'].map(bill => (
                <Input
                  key={bill}
                  type="number"
                  placeholder="0"
                  value={bills[bill as keyof typeof bills]}
                  onChange={(e) => setBills(prev => ({...prev, [bill]: e.target.value}))}
                  classNames={{
                    inputWrapper: "h-10 bg-zinc-950/50 border border-white/5 rounded-xl",
                    input: "font-black text-right text-sm text-emerald-400"
                  }}
                  startContent={<span className="text-[10px] font-bold text-zinc-500 uppercase">${bill.replace('000','K')}</span>}
                />
              ))}
              <Input
                type="number"
                placeholder="0"
                value={coinsValue}
                onChange={(e) => setCoinsValue(e.target.value)}
                classNames={{
                  inputWrapper: "h-10 bg-zinc-950/50 border border-white/5 rounded-xl",
                  input: "font-black text-right text-sm text-zinc-300"
                }}
                startContent={<span className="text-[10px] font-bold text-zinc-500 uppercase">Monedas $</span>}
              />
            </div>
          </div>

          {/* Cartel Dinámico de Descuadre */}
          <div className="mt-auto flex flex-col gap-4 relative z-10">
            {status === 'PENDING' && (
              <div className="h-24 md:h-32 border-2 border-dashed border-white/10 rounded-2xl flex items-center justify-center text-center p-4">
                <span className="text-zinc-500 font-black uppercase tracking-widest text-xs">Cuenta el dinero físico e ingrésalo arriba</span>
              </div>
            )}

            {status === 'BALANCED' && (
              <div className="h-24 md:h-32 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl flex items-center justify-center p-6 animate-in fade-in zoom-in-95">
                <div className="flex items-center gap-4">
                  <div className="h-12 w-12 rounded-full bg-emerald-500 flex items-center justify-center text-white shadow-[0_0_30px_rgba(16,185,129,0.5)]">
                    <CheckCircle2 size={24} />
                  </div>
                  <div>
                    <h2 className="text-2xl md:text-4xl font-black text-emerald-400 uppercase italic tracking-tighter">Caja Cuadrada</h2>
                    <p className="text-xs font-bold text-emerald-500/70 uppercase tracking-widest">Descuadre: $0</p>
                  </div>
                </div>
              </div>
            )}

            {status === 'SHORTAGE' && (
              <div className="flex flex-col gap-3 animate-in fade-in zoom-in-95">
                <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl flex items-center justify-between p-6">
                  <div className="flex items-center gap-4">
                    <div className="h-12 w-12 rounded-full bg-rose-500 flex items-center justify-center text-white shadow-[0_0_30px_rgba(244,63,94,0.5)]">
                      <XCircle size={24} />
                    </div>
                    <div>
                      <h2 className="text-2xl md:text-3xl font-black text-rose-500 uppercase italic tracking-tighter">Faltante</h2>
                      <p className="text-[10px] font-bold text-rose-400 uppercase tracking-widest mt-1">Dinero faltante en físico</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-3xl md:text-4xl font-black text-rose-500 tabular-nums italic">-${Math.abs(difference).toLocaleString()}</span>
                  </div>
                </div>
                <Textarea 
                  placeholder="Justificación del faltante (Obligatorio)..."
                  value={closingNote}
                  onValueChange={setClosingNote}
                  classNames={{
                    input: "text-white font-medium",
                    inputWrapper: "bg-rose-950/20 border border-rose-500/20 hover:border-rose-500/50 rounded-xl"
                  }}
                />
              </div>
            )}

            {status === 'SURPLUS' && (
              <div className="flex flex-col gap-3 animate-in fade-in zoom-in-95">
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-center justify-between p-6">
                  <div className="flex items-center gap-4">
                    <div className="h-12 w-12 rounded-full bg-amber-500 flex items-center justify-center text-white shadow-[0_0_30px_rgba(245,158,11,0.5)]">
                      <AlertTriangle size={24} />
                    </div>
                    <div>
                      <h2 className="text-2xl md:text-3xl font-black text-amber-500 uppercase italic tracking-tighter">Sobrante</h2>
                      <p className="text-[10px] font-bold text-amber-400 uppercase tracking-widest mt-1">Dinero extra en físico</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-3xl md:text-4xl font-black text-amber-500 tabular-nums italic">+${Math.abs(difference).toLocaleString()}</span>
                  </div>
                </div>
                <Textarea 
                  placeholder="Nota (Opcional)..."
                  value={closingNote}
                  onValueChange={setClosingNote}
                  classNames={{
                    input: "text-white font-medium",
                    inputWrapper: "bg-amber-950/20 border border-amber-500/20 hover:border-amber-500/50 rounded-xl"
                  }}
                />
              </div>
            )}

            {/* BOTÓN DE CIERRE IRREVERSIBLE */}
            <Button
              onPress={handleCloseRegister}
              isDisabled={status === 'PENDING' || (status === 'SHORTAGE' && !closingNote.trim()) || isSubmitting}
              className={`w-full h-20 rounded-2xl font-black text-xl md:text-2xl uppercase tracking-[0.2em] italic shadow-2xl transition-all duration-300 mt-2 ${
                status === 'PENDING' 
                  ? 'bg-zinc-800 text-zinc-500 opacity-50' 
                  : status === 'SHORTAGE' && !closingNote.trim()
                    ? 'bg-zinc-800 text-zinc-500 opacity-50'
                    : 'bg-blue-600 hover:bg-blue-500 text-white shadow-[0_0_40px_rgba(37,99,235,0.4)] hover:scale-[1.02]'
              }`}
              endContent={status !== 'PENDING' && !(status === 'SHORTAGE' && !closingNote.trim()) ? <ArrowRightCircle size={28} /> : null}
            >
              {isSubmitting ? 'PROCESANDO...' : 'CERRAR CAJA'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
