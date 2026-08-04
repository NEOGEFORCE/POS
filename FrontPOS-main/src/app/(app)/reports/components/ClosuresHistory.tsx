"use client";

import React, { useState, useEffect, useMemo } from 'react';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Spinner, Button, Chip, Tooltip, Card, CardBody,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
  Divider, Input,
  Dropdown, DropdownTrigger, DropdownMenu, DropdownItem
} from "@heroui/react";
import { 
  Eye, FileText, Calendar, User, TrendingUp, TrendingDown, 
  AlertCircle, CheckCircle2, ChevronDown, ChevronRight,
  Wallet, CreditCard, Banknote, Landmark, History, Trash2, ShieldAlert, Zap, Edit,
  Send, Download, MoreVertical
} from "lucide-react";
import { formatCurrency, formatTime, formatDateTime, formatShortDateTime, formatLocalDate } from "@/lib/utils";
import Cookies from 'js-cookie';
import { useAuth } from '@/lib/auth';
import { useToast } from "@/hooks/use-toast";
import { useRouter } from 'next/navigation';
import EditClosureModal from './EditClosureModal';
import { setupSyncListener } from '@/lib/revalidate';

export interface CashierClosure {
  id: number;
  date: string;
  startDate: string;
  endDate: string;
  salesCount: number;
  totalSales: number;
  totalCash: number;
  totalTransfer: number;
  totalCard: number;
  totalExpenses: number;
  totalReturns: number;
  openingCash: number;
  totalNequi: number;
  totalDaviplata: number;
  netBalance: number;
  physicalCash: number;
  totalCashReal: number;
  totalNequiReal: number;
  totalDaviplataReal: number;
  difference: number;
  expectedCash?: number;
  totalCreditCollected?: number;
  // Desglose dinamico por metodo de pago — contiene cada metodo EXACTO
  // (BANCOLOMBIA, MASTERCARD, etc.) con su total. Reemplaza la tarjeta
  // estatica "Tarjeta/Otros". Puede venir vacio en cierres muy antiguos.
  paymentMethodsBreakdown?: { method: string; total: number }[];
  closedByName: string;
  authorizedBy?: string;
  expensesDetail?: string;
  salariesDetail?: string;
  coins100: number;
  coins200: number;
  coins500: number;
  coins1000: number;
  expectedNequi: number;
  expectedDaviplata: number;
  differenceNequi: number;
  differenceDaviplata: number;
}

const getPaymentSourceStyle = (source: string) => {
  const s = source?.toUpperCase() || 'EFECTIVO';
  if (s === 'NEQUI') return 'bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400';
  if (s === 'DAVIPLATA' || s === 'DAVI') return 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400';
  if (s === 'FONDO') return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-400';
  if (s === 'PRESTAMO' || s === 'PREST.') return 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400';
  if (s.includes('MIXTO') || s.includes('/')) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400 border border-emerald-500/30';
  return 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
};

export const getVentasCajero = (closure: CashierClosure) => {
  const digitalIncome = (closure.totalNequi || 0) + (closure.totalDaviplata || 0) + (closure.totalCard || 0) + (closure.totalBancolombia || 0) + (closure.totalOtherTransfer || 0);
  
  let egresosCaja = 0;
  let parsedExpenses: any[] = [];
  try {
    if (closure.expenses && closure.expenses.length > 0) {
      parsedExpenses = closure.expenses;
    } else if (closure.expensesDetail) {
      parsedExpenses = JSON.parse(closure.expensesDetail);
    }
    parsedExpenses.forEach((e: any) => {
      if (String(e.status).toUpperCase() !== 'PENDING') {
        const rawCash = Number(e.cashAmount || e.cash_amount || 0);
        const rawNequi = Number(e.nequiAmount || e.nequi_amount || 0);
        const rawDavi = Number(e.daviplataAmount || e.daviplata_amount || 0);
        const rawFondo = Number(e.fondoAmount || e.fondo_amount || 0);
        const tax = Number(e.taxAmount || 0);
        const base = Number(e.amount || 0);
        const total = base + tax;

        const sumChannels = rawCash + rawNequi + rawDavi + rawFondo;
        if (sumChannels > 0) {
          egresosCaja += rawCash;
          if (tax > 0 && sumChannels === base && rawCash > 0 && rawNequi === 0 && rawDavi === 0 && rawFondo === 0) {
            egresosCaja += tax;
          }
        } else {
          const src = (e.paymentSource || '').toUpperCase();
          if (src.includes('CAJA') || src.includes('EFECTIVO') || src.includes('CASH') || (!src.includes('NEQUI') && !src.includes('DAVI') && !src.includes('FONDO') && !src.includes('PREST'))) {
            egresosCaja += (total > 0 ? total : base);
          }
        }
      }
    });
  } catch(e) {}

  return (closure.physicalCash || 0) + digitalIncome + egresosCaja + (closure.totalReturns || 0);
};

export default function ClosuresHistory() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role?.toUpperCase() === 'ADMIN' || user?.role?.toUpperCase() === 'SUPERADMIN';
  const [closures, setClosures] = useState<CashierClosure[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [globalStats, setGlobalStats] = useState<{expected: number, real: number} | null>(null);
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const [selectedClosure, setSelectedClosure] = useState<CashierClosure | null>(null);
  const [closureToDelete, setClosureToDelete] = useState<CashierClosure | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const { isOpen: isDeleteOpen, onOpen: onDeleteOpen, onOpenChange: onDeleteOpenChange } = useDisclosure();
  
  const [closureToEdit, setClosureToEdit] = useState<CashierClosure | null>(null);
  const { isOpen: isEditOpen, onOpen: onEditOpen, onOpenChange: onEditOpenChange } = useDisclosure();

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const [historyRes, cashierRes] = await Promise.all([
        fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/dashboard/cashier-history`, {
          headers: { 'Authorization': `Bearer ${Cookies.get('org-pos-token')}` }
        }),
        fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/dashboard/cashier-closure`, {
          headers: { 'Authorization': `Bearer ${Cookies.get('org-pos-token')}` }
        })
      ]);

      if (historyRes.ok) {
        const data = await historyRes.json();
        setClosures(data || []);
      }

      if (cashierRes.ok) {
        const data = await cashierRes.json();
        setGlobalStats({
          expected: data.expectedCash || 0,
          real: data.physicalCash || 0
        });
      }
    } catch (error) {
      console.error("Error fetching data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();

    // Refrescar cuando el usuario vuelve a esta tab (ej: despues de editar un cierre)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Solo refrescar si habia una edicion pendiente
        const flag = localStorage.getItem('closure_edited');
        if (flag) {
          localStorage.removeItem('closure_edited');
          fetchData();
        }
      }
    };

    // Tambien escuchar si el usuario navega de vuelta (popstate / Next router)
    const handleFocus = () => {
      const flag = localStorage.getItem('closure_edited');
      if (flag) {
        localStorage.removeItem('closure_edited');
        fetchData();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  // Escuchar el broadcast CLOSURE_MADE del BroadcastChannel para refrescar en tiempo real
  useEffect(() => {
    const unsub = setupSyncListener((event) => {
      if (event === 'CLOSURE_MADE') {
        fetchData();
      }
    });
    return unsub;
  }, []);

  // Estado para el detalle ampliado del cierre seleccionado
  const [fullDetail, setFullDetail] = useState<any | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const handleViewDetail = async (closure: CashierClosure) => {
    setSelectedClosure(closure);
    onOpen();
    setLoadingDetail(true);
    setFullDetail(null);
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api';
      const res = await fetch(`${baseUrl}/dashboard/cashier-history/${closure.id}/full-detail`, {
        headers: { 'Authorization': `Bearer ${Cookies.get('org-pos-token')}` }
      });
      if (res.ok) {
        const data = await res.json();
        setFullDetail(data);
      }
    } catch (error) {
      console.error('Error loading full detail:', error);
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleDeleteClick = (closure: CashierClosure) => {
    setClosureToDelete(closure);
    onDeleteOpen();
  };

  const router = useRouter();

  const handleEditClick = (closure: CashierClosure) => {
    // Navega a la pantalla completa de cierre con el ID en query param
    // Alli la pantalla detecta ?edit=:id y precarga el cierre historico para corregir
    router.push(`/dashboard/closure?edit=${closure.id}`);
  };

  // Helper generico que pega al export y dispara descarga / Telegram
  const exportClosure = async (closure: CashierClosure, telegram: boolean) => {
    const baseUrl = process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined'
      ? process.env.NEXT_PUBLIC_API_URL : '/api';

    // Convertir la fecha del cierre a un rango YYYY-MM-DD seguro
    const d = closure.date ? new Date(closure.date) : new Date();
    const fromStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    // tomar 1 dia completo
    const toStr = fromStr;

    const params = new URLSearchParams({
      type: 'single-closure',
      closure_id: String(closure.id),
      id: String(closure.id),
      from: fromStr,
      to: toStr,
      format: 'PDF',
      telegram: telegram ? 'true' : 'false',
    });

    const url = `${baseUrl}/dashboard/reports/export?${params.toString()}`;

    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${Cookies.get('org-pos-token')}` }
      });
      if (!res.ok) {
        throw new Error(`Error ${res.status} al exportar (¿backend actualizado?)`);
      }
      const blob = await res.blob();

      if (telegram) {
        toast({
          title: 'ENVIADO POR TELEGRAM',
          description: `El cierre #${closure.id} se envio al chat administrativo.`,
        });
      } else {
        // Disparar descarga local
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `cierre_${closure.id}_${fromStr}.pdf`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(downloadUrl);
        document.body.removeChild(a);

        toast({
          title: 'DESCARGADO',
          description: `Cierre #${closure.id} listo en PDF.`,
        });
      }
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: 'NO SE PUDO EXPORTAR',
        description: err?.message || 'Error desconocido',
      });
    }
  };

  const handleConfirmDelete = async () => {
    if (!closureToDelete) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/dashboard/cashier-history/${closureToDelete.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${Cookies.get('org-pos-token')}` }
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.userMessage || 'Error al eliminar el cierre');
      }
      // Refrescar lista
      await fetchData();
      onDeleteOpenChange();
      setClosureToDelete(null);
    } catch (error: any) {
      console.error('Error deleting closure:', error);
      toast({ variant: "destructive", title: "ERROR AL ELIMINAR", description: error.message });
    } finally {
      setIsDeleting(false);
    }
  };

  // Estado para el selector de rango de fechas de cierres
  const [datePreset, setDatePreset] = useState<'all' | 'today' | 'yesterday' | 'this_month' | 'last_month' | 'custom'>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  // Filtrar cierres segun el rango de fechas seleccionado
  const filteredClosures = useMemo(() => {
    if (!closures || closures.length === 0) return [];
    if (datePreset === 'all') return closures;

    const now = new Date();
    let start = new Date(0);
    let end = new Date(2099, 11, 31, 23, 59, 59);

    if (datePreset === 'today') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    } else if (datePreset === 'yesterday') {
      const y = new Date(now);
      y.setDate(now.getDate() - 1);
      start = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0, 0);
      end = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59);
    } else if (datePreset === 'this_month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    } else if (datePreset === 'last_month') {
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0);
      end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    } else if (datePreset === 'custom') {
      if (customFrom) {
        const [y, m, d] = customFrom.split('-').map(Number);
        start = new Date(y, m - 1, d, 0, 0, 0);
      }
      if (customTo) {
        const [y, m, d] = customTo.split('-').map(Number);
        end = new Date(y, m - 1, d, 23, 59, 59);
      }
    }

    return closures.filter(c => {
      const dateStr = c.date || c.startDate;
      if (!dateStr) return true;
      const cDate = new Date(dateStr);
      return cDate >= start && cDate <= end;
    });
  }, [closures, datePreset, customFrom, customTo]);

  // Agrupar cierres filtrados por dia
  const groupedClosures = useMemo(() => {
    const groups: Record<string, CashierClosure[]> = {};
    (filteredClosures || []).forEach(c => {
      if (!c?.date) return;
      const d = new Date(c.date);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(c);
    });
    return groups;
  }, [filteredClosures]);

  const sortedDates = useMemo(() => {
    return Object.keys(groupedClosures).sort((a, b) => b.localeCompare(a));
  }, [groupedClosures]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-20 gap-4">
        <Spinner color="success" size="lg" />
        <p className="text-[10px] font-medium uppercase tracking-[0.4em] text-gray-500 dark:text-zinc-500 animate-pulse">Cargando Historial Auditado</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* BARRA DE FILTRO / SELECTOR DE FECHAS DE CIERRES */}
      <div className="card-base p-4 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/5 rounded-2xl shadow-sm flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Calendar size={18} className="text-emerald-500" />
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-900 dark:text-zinc-100">
              HISTORIAL DE CIERRES ({filteredClosures.length} {filteredClosures.length === 1 ? 'Turno' : 'Turnos'})
            </span>
            <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 font-mono border border-emerald-200 dark:border-emerald-800/40 font-bold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Generado: {new Date().toLocaleString('es-CO')}
            </span>
          </div>

          {/* BOTONES DE SELECCION DE FECHA DE CIERRES */}
          <div className="flex flex-wrap items-center gap-1.5 bg-gray-100 dark:bg-zinc-950 p-1 rounded-xl border border-gray-200 dark:border-white/5">
            {[
              { id: 'all', label: 'Todos' },
              { id: 'today', label: 'Hoy' },
              { id: 'yesterday', label: 'Ayer' },
              { id: 'this_month', label: 'Este Mes' },
              { id: 'last_month', label: 'Mes Pasado' },
              { id: 'custom', label: 'Personalizado' },
            ].map(preset => (
              <Button
                key={preset.id}
                size="sm"
                variant={datePreset === preset.id ? "solid" : "light"}
                color={datePreset === preset.id ? "success" : "default"}
                onPress={() => setDatePreset(preset.id as any)}
                className={`h-7 px-3 text-[10px] font-semibold uppercase tracking-wider rounded-lg transition-all ${
                  datePreset === preset.id
                    ? 'shadow-sm bg-emerald-500 text-white font-bold'
                    : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
                }`}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>

        {/* INPUTS PARA RANGO PERSONALIZADO */}
        {datePreset === 'custom' && (
          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-zinc-200 dark:border-white/5 animate-in fade-in duration-200">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium uppercase text-zinc-500">Desde:</span>
              <Input
                type="date"
                size="sm"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="w-36 text-xs font-mono"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium uppercase text-zinc-500">Hasta:</span>
              <Input
                type="date"
                size="sm"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="w-36 text-xs font-mono"
              />
            </div>
          </div>
        )}
      </div>

      {/* SECCION DE RESUMEN EJECUTIVO */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
         {/* CARD 1: ULTIMO CIERRE */}
         <Card className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/5 rounded-[2rem] shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden relative group">
            <div className="absolute -right-4 -top-4 bg-zinc-100 dark:bg-white/5 h-24 w-24 rounded-2xl blur-2xl transition-all" />
            <CardBody className="p-6">
               <div className="flex justify-between items-start mb-6">
                  <div className="flex items-center gap-3">
                     <div className="h-10 w-10 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 rounded-2xl flex items-center justify-center text-zinc-900 dark:text-zinc-100 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                        <History size={20} />
                     </div>
                     <div>
                        <h4 className="text-[11px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-tighter tracking-tight">Ultimo Cierre de Caja</h4>
                        <p className="text-[8px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest tracking-tight">Analisis del turno mas reciente</p>
                     </div>
                  </div>
                  {closures[0] && (
                    <Chip size="sm" variant="flat" className="font-medium text-[9px] uppercase tracking-tight bg-zinc-100 dark:bg-white/5 text-zinc-900 dark:text-zinc-100 border-none">REF #{closures[0].id}</Chip>
                  )}
               </div>
               <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                     <span className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest block">Efectivo Real</span>
                     <span className="text-xl font-medium text-zinc-900 dark:text-zinc-100 tabular-nums tracking-tight">${formatCurrency(closures[0]?.physicalCash || 0)}</span>
                  </div>
                  <div className="space-y-1 text-right">
                     <span className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest block">Diferencia</span>
                     <span className={`text-xl font-bold tabular-nums tracking-tight ${closures[0]?.difference === 0 ? 'text-zinc-900 dark:text-zinc-100' : closures[0]?.difference < 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                        {closures[0]?.difference > 0 ? '+' : ''}${formatCurrency(closures[0]?.difference || 0)}
                     </span>
                  </div>
               </div>
               <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-white/5 flex justify-between items-center">
                  <span className="text-[9px] font-medium text-zinc-600 uppercase tracking-tight">Responsable: {closures?.[0]?.closedByName || '---'}</span>
                  <span className="text-[9px] font-medium text-zinc-600 uppercase tabular-nums">{closures?.[0] ? formatDateTime(closures[0].date) : '---'}</span>
               </div>
            </CardBody>
         </Card>

          {/* CARD 2: TURNO ACTIVO (EN VIVO) */}
          <Card className="bg-blue-500/[0.08] border border-blue-500/20 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden relative group">
            <div className="absolute -right-4 -top-4 bg-blue-500/10 h-32 w-32 rounded-2xl blur-2xl" />
            <CardBody className="p-6">
              <div className="flex justify-between items-start mb-6">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 bg-zinc-100 dark:bg-zinc-800 border border-white/8 rounded-xl flex items-center justify-center text-blue-400">
                    <Zap size={20} className="animate-pulse" />
                  </div>
                  <div>
                    <h4 className="text-[11px] font-medium text-blue-400 uppercase tracking-tighter tracking-tight">Arqueo en Vivo (Ahora)</h4>
                    <p className="text-[8px] font-bold text-blue-500/80 uppercase tracking-widest tracking-tight">Turno abierto — Sin cerrar caja</p>
                  </div>
                </div>
                <span className="text-[10px] font-semibold tracking-widest text-blue-400 bg-blue-400/10 border border-blue-400/20 rounded px-2 py-0.5 animate-pulse">LIVE</span>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <span className="text-[9px] font-medium text-blue-500/80 uppercase tracking-widest block">Esperado en Caja</span>
                  <span className="text-xl font-medium text-zinc-900 dark:text-zinc-50 tabular-nums tracking-tight font-['DM_Mono']">
                    ${formatCurrency(globalStats?.expected || 0)} {/* Fallback logic */}
                  </span>
                </div>
                <div className="space-y-1 text-right">
                  <span className="text-[9px] font-medium text-blue-500/80 uppercase tracking-widest block">Estado del Turno</span>
                  <Button size="sm" variant="flat" className="h-6 bg-blue-500/20 text-blue-400 font-medium text-[9px] uppercase hover:bg-blue-500/30" onPress={() => {
                    // Abrir modal de cierre si el usuario lo desea
                    window.location.href = '/dashboard';
                  }}>
                    GESTIONAR CAJA
                  </Button>
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-blue-500/20 flex justify-between items-center">
                <span className="text-[9px] font-medium text-blue-500/80 uppercase tracking-tight">Ventas desde el ultimo cierre</span>
                <span className="text-[9px] font-medium text-blue-500/80 uppercase tabular-nums">Monitorizacion 24/7</span>
              </div>
            </CardBody>
          </Card>
        </div>

      {sortedDates.length === 0 ? (
        <div className="p-20 text-center bg-white dark:bg-zinc-950/20 rounded-[2rem] border border-dashed border-zinc-200 dark:border-white/5">
           <AlertCircle className="mx-auto mb-4 text-zinc-600" size={40} />
           <p className="text-sm font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-tight">No se encontraron cierres registrados</p>
        </div>
      ) : (
        <div className="space-y-8">
          {sortedDates.map(date => {
            const dayClosures = groupedClosures[date] || [];
            const sortedChronological = [...dayClosures].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
            
            const dailyTotalSales = dayClosures.reduce((sum, c) => sum + getVentasCajero(c), 0);
            const dailyPhysicalCash = dayClosures.reduce((sum, c) => sum + (c.physicalCash || 0), 0);
            const dailyTotalExpenses = dayClosures.reduce((sum, c) => sum + (c.totalExpenses || 0), 0);
            const dailyDifference = dayClosures.reduce((sum, c) => sum + (c.difference || 0), 0);

            return (
              <div key={date} className="space-y-3">
                <div className="flex items-center gap-4 ml-4">
                  <div className="h-2 w-2 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
                  <h3 className="text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-[0.3em] tracking-tight">
                    {formatLocalDate(date)}
                  </h3>
                  <div className="flex-1 h-px bg-gradient-to-r from-white/10 to-transparent" />
                </div>

                <div className="grid grid-cols-1 gap-3">
                  {dayClosures.length > 1 && (
                    <Card className="bg-emerald-950/20 dark:bg-emerald-950/30 border border-emerald-500/30 rounded-2xl p-4 shadow-sm">
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
                            <TrendingUp size={20} />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                                RESUMEN CONSOLIDADO DEL DÍA
                              </span>
                              <Chip size="sm" variant="flat" className="h-5 text-[9px] font-bold uppercase bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                {dayClosures.length} TURNOS COMBINADOS
                              </Chip>
                            </div>
                            <p className="text-[9px] font-medium text-zinc-400 uppercase tracking-tight">
                              Suma total acumulada de todas las ventas y movimientos del día
                            </p>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 md:gap-8 flex-1 md:justify-center px-4">
                          <div className="flex flex-col">
                            <span className="text-[9px] font-medium text-gray-400 uppercase tracking-widest mb-1">Ventas Día</span>
                            <span className="text-sm font-bold text-zinc-900 dark:text-white tabular-nums">${formatCurrency(dailyTotalSales)}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[9px] font-medium text-gray-400 uppercase tracking-widest mb-1">Efectivo Real Día</span>
                            <span className="text-sm font-bold text-emerald-400 tabular-nums">${formatCurrency(dailyPhysicalCash)}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[9px] font-medium text-gray-400 uppercase tracking-widest mb-1">Egresos Día</span>
                            <span className="text-sm font-bold text-rose-400 tabular-nums">${formatCurrency(dailyTotalExpenses)}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[9px] font-medium text-gray-400 uppercase tracking-widest mb-1">Diferencia Día</span>
                            <span className={`text-sm font-bold tabular-nums ${dailyDifference === 0 ? 'text-zinc-100' : dailyDifference < 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                              {dailyDifference > 0 ? '+' : ''}${formatCurrency(dailyDifference)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </Card>
                  )}

                  {dayClosures.map(closure => {
                    const turnoNum = sortedChronological.findIndex(c => c.id === closure.id) + 1;
                    return (
                      <Card 
                        key={closure.id} 
                        className="bg-white dark:bg-[#18181b] hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 hover:border-emerald-500/30 transition-all rounded-2xl group overflow-hidden cursor-pointer"
                        onClick={() => handleViewDetail(closure)}
                      >
                        <CardBody className="p-4 md:p-6">
                          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            {/* Info General */}
                            <div className="flex items-center gap-4">
                              <div className={`h-12 w-12 rounded-2xl flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] ${closure.difference === 0 ? 'text-zinc-900 dark:text-zinc-100 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 ' : closure.difference < 0 ? 'text-white bg-rose-500 shadow-rose-500/20' : 'text-white bg-emerald-500 shadow-emerald-500/20'}`}>
                                <FileText size={20} />
                              </div>
                              <div className="flex flex-col">
                                <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest leading-none mb-1">Cierre #{closure.id}</span>
                                <div className="flex items-center gap-2">
                                   <span className="text-lg font-medium text-zinc-900 dark:text-zinc-100 tracking-tight">{closure?.date ? formatTime(closure.date) : '---'}</span>
                                   <Chip size="sm" variant="flat" color="default" className="h-5 text-[9px] font-medium uppercase tracking-tight">{closure?.closedByName || '---'}</Chip>
                                   {dayClosures.length > 1 && (
                                     <Chip size="sm" variant="flat" className="h-5 text-[8px] font-bold uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                       TURNO {turnoNum}
                                     </Chip>
                                   )}
                                </div>
                              </div>
                            </div>

                        {/* Metricas Rapidas */}
                        {(() => {
                           let displaySales = getVentasCajero(closure);
                           let displayExpenses = closure.totalExpenses;
                           return (
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 md:gap-8 flex-1 md:justify-center px-4">
                              <div className="flex flex-col">
                                <span className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest mb-1">Ventas Totales</span>
                                <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(displaySales)}</span>
                              </div>
                              <div className="flex flex-col">
                                <span className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest mb-1">Efectivo Real</span>
                                <span className="text-sm font-medium text-gray-600 dark:text-zinc-300 tabular-nums">${formatCurrency(closure.physicalCash)}</span>
                              </div>
                              <div className="flex flex-col">
                                <span className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest mb-1">Egresos</span>
                                <span className="text-sm font-medium text-rose-400 tabular-nums">${formatCurrency(displayExpenses)}</span>
                              </div>
                              <div className="flex flex-col">
                                <span className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest mb-1">Diferencia</span>
                                <span className={`text-sm font-bold tabular-nums ${closure.difference === 0 ? 'text-zinc-900 dark:text-zinc-100' : closure.difference < 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                                  {closure.difference > 0 ? '+' : ''}${formatCurrency(closure.difference)}
                                </span>
                              </div>
                            </div>
                           );
                        })()}

                        {/* Botones de Accion */}
                        <div className="flex items-center gap-1 justify-end">
                           {isAdmin && (
                             <div onClick={(e) => e.stopPropagation()} className="flex gap-1">
                             <Tooltip content="Editar cierre" color="primary">
                               <Button 
                                 isIconOnly 
                                 variant="light" 
                                 className="text-zinc-600 hover:text-blue-500 hover:bg-blue-500/10 transition-colors"
                                 onPress={() => handleEditClick(closure)}
                               >
                                 <Edit size={18} />
                               </Button>
                             </Tooltip>
                             <Tooltip content="Eliminar este cierre" color="danger">
                               <Button 
                                 isIconOnly 
                                 variant="light" 
                                 className="text-zinc-600 hover:text-rose-500 hover:bg-rose-500/10 transition-colors"
                                 onPress={() => handleDeleteClick(closure)}
                               >
                                 <Trash2 size={18} />
                               </Button>
                             </Tooltip>
                             </div>
                           )}
                           <Dropdown placement="bottom-end">
                             <DropdownTrigger>
                               <Button
                                 isIconOnly
                                 variant="light"
                                 onClick={(e) => e.stopPropagation()}
                                 className="text-gray-500 dark:text-zinc-500 group-hover:text-zinc-900 dark:text-zinc-100 transition-colors"
                               >
                                 <ChevronRight size={20} />
                               </Button>
                             </DropdownTrigger>
                             <DropdownMenu
                               aria-label="Acciones del cierre"
                               variant="flat"
                               className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-white/10 rounded-2xl"
                               disabledKeys={isAdmin ? [] : ['edit']}
                               onAction={(key) => {
                                 if (key === 'view') {
                                   handleViewDetail(closure);
                                 } else if (key === 'telegram') {
                                   exportClosure(closure, true);
                                 } else if (key === 'download') {
                                   exportClosure(closure, false);
                                 } else if (key === 'edit') {
                                   handleEditClick(closure);
                                 }
                               }}
                             >
                               <DropdownItem
                                 key="view"
                                 startContent={<Eye size={14} />}
                                 className="text-[10px] font-medium uppercase tracking-widest"
                               >
                                 Ver detalle
                               </DropdownItem>
                               <DropdownItem
                                 key="telegram"
                                 startContent={<Send size={14} />}
                                 className="text-[10px] font-medium uppercase tracking-widest text-blue-500"
                               >
                                 Enviar por Telegram
                               </DropdownItem>
                               <DropdownItem
                                 key="download"
                                 startContent={<Download size={14} />}
                                 className="text-[10px] font-medium uppercase tracking-widest text-emerald-500"
                               >
                                 Descargar PDF
                               </DropdownItem>
                               <DropdownItem
                                 key="edit"
                                 startContent={<Edit size={14} />}
                                 className="text-[10px] font-medium uppercase tracking-widest text-amber-500"
                               >
                                 Editar (corregir)
                               </DropdownItem>
                             </DropdownMenu>
                           </Dropdown>
                        </div>
                      </div>
                    </CardBody>
                  </Card>
                );
              })}
              </div>
            </div>
          );
        })}
        </div>
      )}

      {/* Modal Detalle */}
      <Modal 
        isOpen={isOpen} 
        onOpenChange={(open) => {
          if (!open) {
            setFullDetail(null);
            setSelectedClosure(null);
          }
          onOpenChange();
        }}
        size="4xl"
        classNames={{
          base: "bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-white/10 rounded-[2.5rem] max-h-[90vh]",
          header: "border-b border-zinc-200 dark:border-white/5 p-8 pb-4",
          body: "p-8 pt-6",
        }}
        scrollBehavior="inside"
        backdrop="blur"
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1">
                <div className="flex items-center gap-3">
                   <div className="h-10 w-10 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 rounded-2xl flex items-center justify-center text-zinc-900 dark:text-zinc-100">
                      <TrendingUp size={20} />
                   </div>
                   <div className="flex flex-col">
                      <h3 className="text-xl font-medium text-zinc-900 dark:text-zinc-100 tracking-tight uppercase tracking-tighter leading-none">
                        Detalle de <span className="text-zinc-900 dark:text-zinc-100">Auditoria</span>
                      </h3>
                      <p className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-[0.3em] mt-1 tracking-tight">Cierre #{selectedClosure?.id} - Ref: {selectedClosure?.date ? formatShortDateTime(selectedClosure.date) : '---'}</p>
                   </div>
                </div>
              </ModalHeader>
              <ModalBody>
                {selectedClosure && (() => {
                    const digitalIncome = (selectedClosure.totalNequi || 0) + (selectedClosure.totalDaviplata || 0) + (selectedClosure.totalCard || 0) + (selectedClosure.totalBancolombia || 0) + (selectedClosure.totalOtherTransfer || 0);
                    
                    let egresosCaja = 0;
                    let egresosGlobales = 0;
                    let parsedExpenses: any[] = [];
                    try {
                        if (selectedClosure.expensesDetail && selectedClosure.expensesDetail.trim() !== '' && selectedClosure.expensesDetail !== '[]') {
                            parsedExpenses = JSON.parse(selectedClosure.expensesDetail);
                        } else if (selectedClosure.expenses && selectedClosure.expenses.length > 0) {
                            parsedExpenses = selectedClosure.expenses;
                        } else if (fullDetail?.expenses && Array.isArray(fullDetail.expenses) && fullDetail.expenses.length > 0) {
                            parsedExpenses = fullDetail.expenses;
                        }
                        parsedExpenses.forEach((e: any) => {
                            if (String(e.status).toUpperCase() !== 'PENDING') {
                                const tax = Number(e.taxAmount || 0);
                                const base = Number(e.amount || 0);
                                const total = base + tax;
                                const src = (e.paymentSource || e.payment_source || '').toUpperCase();
                                
                                let finalCash = 0;
                                let finalNequi = 0;
                                let finalDavi = 0;
                                let finalFondo = 0;

                                // Primary: paymentSource is the authority (same as backend normalizeExpensesForReport)
                                if (src.includes('/')) {
                                    // Split payment: "CAJA: $50000 / DAVIPLATA: $30000" or "CAJA: $97603.85 / DAVIPLATA: $22000"
                                    src.split('/').forEach((part: string) => {
                                        const p = part.trim();
                                        const match = p.match(/\$?([0-9.,]+)/);
                                        let val = 0;
                                        if (match) {
                                            let s = match[1];
                                            if (s.includes(',')) {
                                                s = s.replace(/\./g, '').replace(',', '.');
                                            } else if (s.includes('.')) {
                                                if (!/\.\d{1,2}$/.test(s)) {
                                                    s = s.replace(/\./g, '');
                                                }
                                            }
                                            val = parseFloat(s) || 0;
                                        }
                                        if (p.includes('NEQUI') || p.includes('NEQ')) finalNequi += val;
                                        else if (p.includes('DAVIPLATA') || p.includes('DAVI')) finalDavi += val;
                                        else if (p.includes('FONDO') || p.includes('BOVEDA') || p.includes('BÓVEDA') || p.includes('FOND')) finalFondo += val;
                                        else if (p.includes('CAJA') || p.includes('EFECTIVO') || p.includes('CASH') || p.includes('EFEC')) finalCash += val;
                                    });
                                    // If nothing parsed from split, use DB columns as fallback
                                    if (finalCash + finalNequi + finalDavi + finalFondo === 0) {
                                        finalCash = total;
                                    }
                                } else if (src === 'NEQUI') {
                                    finalNequi = total;
                                } else if (src === 'DAVIPLATA' || src === 'DAVI') {
                                    finalDavi = total;
                                } else if (src === 'FONDO' || src === 'BOVEDA' || src === 'BÓVEDA' || src.includes('FOND')) {
                                    finalFondo = total;
                                } else if (src.includes('PREST') || src === 'DEUDA') {
                                    // Debt -> 0
                                } else {
                                    // Default: use DB channel columns if populated, else full amount to cash
                                    const rawCash = Number(e.cashAmount || e.cash_amount || 0);
                                    const rawNequi = Number(e.nequiAmount || e.nequi_amount || 0);
                                    const rawDavi = Number(e.daviplataAmount || e.daviplata_amount || 0);
                                    const rawFondo = Number(e.fondoAmount || e.fondo_amount || 0);
                                    const sumChannels = rawCash + rawNequi + rawDavi + rawFondo;

                                    if (sumChannels > 0) {
                                        finalCash = rawCash;
                                        finalNequi = rawNequi;
                                        finalDavi = rawDavi;
                                        finalFondo = rawFondo;
                                        if (tax > 0 && sumChannels === base) {
                                            const count = (rawCash>0?1:0)+(rawNequi>0?1:0)+(rawDavi>0?1:0)+(rawFondo>0?1:0);
                                            if (count <= 1) {
                                                if (rawCash > 0) finalCash += tax;
                                                if (rawNequi > 0) finalNequi += tax;
                                                if (rawDavi > 0) finalDavi += tax;
                                                if (rawFondo > 0) finalFondo += tax;
                                            } else {
                                                if (rawNequi > 0) finalNequi += tax;
                                                else if (rawDavi > 0) finalDavi += tax;
                                                else if (rawFondo > 0) finalFondo += tax;
                                                else finalCash += tax;
                                            }
                                        }
                                    } else {
                                        finalCash = total;
                                    }
                                }
                                
                                e._finalCash = finalCash;
                                e._finalNequi = finalNequi;
                                e._finalDavi = finalDavi;
                                e._finalFondo = finalFondo;
                                
                                egresosCaja += finalCash;
                                egresosGlobales += finalCash + finalNequi + finalDavi + finalFondo;
                            }
                        });
                    } catch(e) {}
                    
                    const cashIngresos = (selectedClosure.totalCash || 0) + (selectedClosure.totalCreditCollected || 0);
                    const expectedCashFinal = (selectedClosure.expectedCash && selectedClosure.expectedCash !== 0)
                        ? selectedClosure.expectedCash
                        : (cashIngresos - egresosCaja - (selectedClosure.totalReturns || 0));
                    const physicalCash = selectedClosure.physicalCash || 0;
                    
                    const descuadreCaja = (selectedClosure.difference !== undefined && selectedClosure.difference !== 0)
                        ? selectedClosure.difference
                        : (physicalCash - expectedCashFinal);

                    const ventasCajero = physicalCash + digitalIncome + egresosCaja + (selectedClosure.totalReturns || 0);
                    const ventasSistema = expectedCashFinal + digitalIncome + egresosCaja + (selectedClosure.totalReturns || 0);

                    const totalCalculatedSales = cashIngresos + digitalIncome;
                    const ingresosReales = (selectedClosure.totalSales && selectedClosure.totalSales >= totalCalculatedSales) ? selectedClosure.totalSales : totalCalculatedSales;
                    const balanceNetoReal = ingresosReales - egresosGlobales - (selectedClosure.totalReturns || 0);

                    const summaryTableClasses = {
                        th: "bg-white dark:bg-[#18181b] text-[10px] font-bold uppercase tracking-widest text-gray-500 dark:text-zinc-500 border-b-2 border-zinc-200 dark:border-white/10",
                        td: "text-[11px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-tight border-b border-zinc-200 dark:border-white/5 py-3"
                    };

                    return (
                        <div className="space-y-6">
                            {/* Cabecera Principal (Ventas Totales y Balance de Auditoría) */}
                            <div className="grid grid-cols-3 gap-4">
                                <div className="bg-white dark:bg-[#18181b] p-4 rounded-2xl border border-zinc-200 dark:border-white/10 flex flex-col items-center text-center">
                                    <span className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest mb-2">Ventas Totales (Cajero)</span>
                                    <span className="text-xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(ventasCajero)}</span>
                                </div>
                                <div className="bg-white dark:bg-[#18181b] p-4 rounded-2xl border border-zinc-200 dark:border-white/10 flex flex-col items-center text-center">
                                    <span className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest mb-2">Ventas Totales (Sist.)</span>
                                    <span className="text-xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(ventasSistema)}</span>
                                </div>
                                <div className={`p-4 rounded-2xl border flex flex-col items-center text-center ${descuadreCaja >= 0 ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-rose-500/10 border-rose-500/30'}`}>
                                    <span className={`text-[10px] font-bold uppercase tracking-widest mb-2 ${descuadreCaja >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>Descuadre Caja</span>
                                    <span className={`text-xl font-bold tabular-nums ${descuadreCaja >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                                        {descuadreCaja > 0 ? `+` : ''}${formatCurrency(descuadreCaja)}
                                    </span>
                                </div>
                            </div>
                            
                            <p className="text-[9px] font-medium text-gray-400 dark:text-zinc-600 tracking-wider">
                                * Ventas Cajero = Efectivo Contado + Digital + Egresos Caja <br/>
                                * Ventas Sistema = Ventas Registradas en Sistema (Efectivo + Digital + Fiados)
                            </p>

                            {/* RESUMEN FINANCIERO GLOBAL */}
                            <div className="bg-zinc-50 dark:bg-[#18181b]/50 rounded-2xl border border-zinc-200 dark:border-white/5 overflow-hidden">
                                <h4 className="px-4 py-3 text-[11px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-[0.2em] border-b border-zinc-200 dark:border-white/5 bg-white dark:bg-[#18181b]">Resumen Financiero Global</h4>
                                <Table aria-label="Resumen Global" removeWrapper classNames={summaryTableClasses}>
                                    <TableHeader>
                                        <TableColumn>CONCEPTO</TableColumn>
                                        <TableColumn align="end">MONTO</TableColumn>
                                    </TableHeader>
                                    <TableBody>
                                        <TableRow>
                                            <TableCell>(+) Ingresos Totales (Efectivo + Digital)</TableCell>
                                            <TableCell className="text-right">${formatCurrency(ingresosReales)}</TableCell>
                                        </TableRow>
                                        <TableRow>
                                            <TableCell>(-) Egresos Totales (Todos los canales)</TableCell>
                                            <TableCell className="text-right text-rose-500 font-bold">${formatCurrency(egresosGlobales)}</TableCell>
                                        </TableRow>
                                        <TableRow>
                                            <TableCell>(-) Devoluciones Totales</TableCell>
                                            <TableCell className="text-right text-rose-500">${formatCurrency(selectedClosure.totalReturns || 0)}</TableCell>
                                        </TableRow>
                                        <TableRow className="bg-emerald-500/5">
                                            <TableCell className="font-bold text-emerald-600 dark:text-emerald-400">(=) BALANCE NETO DEL TURNO</TableCell>
                                            <TableCell className={`text-right font-bold ${balanceNetoReal >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`}>${formatCurrency(balanceNetoReal)}</TableCell>
                                        </TableRow>
                                    </TableBody>
                                </Table>
                            </div>

                            {/* CUADRE DE CAJA FISICA */}
                            <div className="bg-zinc-50 dark:bg-[#18181b]/50 rounded-2xl border border-zinc-200 dark:border-white/5 overflow-hidden">
                                <h4 className="px-4 py-3 text-[11px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-[0.2em] border-b border-zinc-200 dark:border-white/5 bg-white dark:bg-[#18181b]">Cuadre de Caja Fisica</h4>
                                <Table aria-label="Cuadre Fisico" removeWrapper classNames={summaryTableClasses}>
                                    <TableHeader>
                                        <TableColumn>CONCEPTO</TableColumn>
                                        <TableColumn align="end">MONTO</TableColumn>
                                    </TableHeader>
                                    <TableBody>
                                        <TableRow>
                                            <TableCell>(+) Ingresos en Efectivo (Ventas + Recaudos)</TableCell>
                                            <TableCell className="text-right">${formatCurrency(cashIngresos)}</TableCell>
                                        </TableRow>
                                        <TableRow>
                                            <TableCell>(-) Salidas de Efectivo (Egresos de Caja)</TableCell>
                                            <TableCell className="text-right text-rose-500">${formatCurrency(egresosCaja)}</TableCell>
                                        </TableRow>
                                        <TableRow>
                                            <TableCell>(-) Devoluciones de Mercancia en Efectivo</TableCell>
                                            <TableCell className="text-right text-rose-500">${formatCurrency(0)}</TableCell>
                                        </TableRow>
                                        <TableRow className="bg-blue-500/5">
                                            <TableCell className="font-bold text-blue-600 dark:text-blue-400">(=) EFECTIVO ESPERADO EN CAJA</TableCell>
                                            <TableCell className="text-right font-bold text-blue-600 dark:text-blue-400">${formatCurrency(expectedCashFinal)}</TableCell>
                                        </TableRow>
                                    </TableBody>
                                </Table>
                            </div>

                            {/* DESGLOSE DE EFECTIVO REPORTADO */}
                            <div className="bg-zinc-50 dark:bg-[#18181b]/50 rounded-2xl border border-zinc-200 dark:border-white/5 overflow-hidden">
                                <h4 className="px-4 py-3 text-[11px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-[0.2em] border-b border-zinc-200 dark:border-white/5 bg-white dark:bg-[#18181b]">Desglose de Efectivo Reportado</h4>
                                <Table aria-label="Desglose Billetes" removeWrapper classNames={summaryTableClasses}>
                                    <TableHeader>
                                        <TableColumn>DENOMINACION</TableColumn>
                                        <TableColumn align="end">MONTO</TableColumn>
                                    </TableHeader>
                                    <TableBody>
                                        <TableRow><TableCell>Billetes</TableCell><TableCell className="text-right">${formatCurrency(selectedClosure.cashBills || 0)}</TableCell></TableRow>
                                        <TableRow><TableCell>Monedas 1000</TableCell><TableCell className="text-right">${formatCurrency(selectedClosure.coins1000 || 0)}</TableCell></TableRow>
                                        <TableRow><TableCell>Monedas 500</TableCell><TableCell className="text-right">${formatCurrency(selectedClosure.coins500 || 0)}</TableCell></TableRow>
                                        <TableRow><TableCell>Monedas 200</TableCell><TableCell className="text-right">${formatCurrency(selectedClosure.coins200 || 0)}</TableCell></TableRow>
                                        <TableRow><TableCell>Monedas 100</TableCell><TableCell className="text-right">${formatCurrency(selectedClosure.coins100 || 0)}</TableCell></TableRow>
                                    </TableBody>
                                </Table>
                            </div>

                            {/* CANALES DIGITALES (TRANSFERENCIAS) */}
                            <div className="bg-zinc-50 dark:bg-[#18181b]/50 rounded-2xl border border-zinc-200 dark:border-white/5 overflow-hidden">
                                <h4 className="px-4 py-3 text-[11px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-[0.2em] border-b border-zinc-200 dark:border-white/5 bg-white dark:bg-[#18181b]">Canales Digitales (Transferencias)</h4>
                                <Table aria-label="Canales Digitales" removeWrapper classNames={summaryTableClasses}>
                                    <TableHeader>
                                        <TableColumn>NEQUI</TableColumn>
                                        <TableColumn>DAVIPLATA</TableColumn>
                                        <TableColumn>TARJETA</TableColumn>
                                        <TableColumn>OTROS</TableColumn>
                                    </TableHeader>
                                    <TableBody>
                                        <TableRow>
                                            <TableCell className="font-bold text-purple-500">${formatCurrency(selectedClosure.totalNequi || 0)}</TableCell>
                                            <TableCell className="font-bold text-rose-500">${formatCurrency(selectedClosure.totalDaviplata || 0)}</TableCell>
                                            <TableCell className="font-bold text-orange-500">${formatCurrency(selectedClosure.totalCard || 0)}</TableCell>
                                            <TableCell className="font-bold text-sky-500">${formatCurrency((selectedClosure.totalBancolombia || 0) + (selectedClosure.totalOtherTransfer || 0))}</TableCell>
                                        </TableRow>
                                    </TableBody>
                                </Table>
                            </div>

                            {/* EGRESOS POR CANAL DETALLADO - usa datos actuales de BD si disponibles */}
                            {(() => {
                                const liveExpenses = (selectedClosure.expensesDetail && selectedClosure.expensesDetail.trim() !== '' && selectedClosure.expensesDetail !== '[]')
                                    ? JSON.parse(selectedClosure.expensesDetail)
                                    : ((!loadingDetail && fullDetail?.expenses && Array.isArray(fullDetail.expenses) && fullDetail.expenses.length > 0)
                                        ? fullDetail.expenses
                                        : null);

                                // Construir montos por canal usando paymentSource como autoridad (idéntico al backend)
                                const expensesForChannels = liveExpenses
                                    ? liveExpenses
                                        .filter((e: any) => String(e.status || '').toUpperCase() !== 'PENDING')
                                        .map((e: any) => {
                                            const tax = Number(e.taxAmount || 0);
                                            const base = Number(e.amount || 0);
                                            const total = base + tax;
                                            const src = (e.paymentSource || '').toUpperCase();

                                            let finalCash = 0;
                                            let finalNequi = 0;
                                            let finalDavi = 0;
                                            let finalFondo = 0;

                                            if (src.includes('/')) {
                                                src.split('/').forEach((part: string) => {
                                                    const p = part.trim();
                                                    const match = p.match(/\$?([0-9.,]+)/);
                                                    let val = 0;
                                                    if (match) {
                                                        let s = match[1];
                                                        if (s.includes(',')) {
                                                            s = s.replace(/\./g, '').replace(',', '.');
                                                        } else if (s.includes('.')) {
                                                            if (!/\.\d{1,2}$/.test(s)) {
                                                                s = s.replace(/\./g, '');
                                                            }
                                                        }
                                                        val = parseFloat(s) || 0;
                                                    }
                                                    if (p.includes('NEQUI') || p.includes('NEQ')) finalNequi += val;
                                                    else if (p.includes('DAVIPLATA') || p.includes('DAVI')) finalDavi += val;
                                                    else if (p.includes('FONDO') || p.includes('BOVEDA') || p.includes('BÓVEDA') || p.includes('FOND')) finalFondo += val;
                                                    else if (p.includes('CAJA') || p.includes('EFECTIVO') || p.includes('CASH') || p.includes('EFEC')) finalCash += val;
                                                });
                                                if (finalCash + finalNequi + finalDavi + finalFondo === 0) {
                                                    finalCash = total;
                                                }
                                            } else if (src === 'NEQUI') {
                                                finalNequi = total;
                                            } else if (src === 'DAVIPLATA' || src === 'DAVI') {
                                                finalDavi = total;
                                            } else if (src === 'FONDO' || src === 'BOVEDA' || src === 'BÓVEDA' || src.includes('FOND')) {
                                                finalFondo = total;
                                            } else if (src.includes('PREST') || src === 'DEUDA') {
                                                // Debt -> 0
                                            } else {
                                                const rawCash = Number(e.cashAmount || 0);
                                                const rawNequi = Number(e.nequiAmount || 0);
                                                const rawDavi = Number(e.daviplataAmount || 0);
                                                const rawFondo = Number(e.fondoAmount || 0);
                                                const sum = rawCash + rawNequi + rawDavi + rawFondo;

                                                if (sum > 0) {
                                                    finalCash = rawCash; finalNequi = rawNequi; finalDavi = rawDavi; finalFondo = rawFondo;
                                                    if (tax > 0 && sum === base) {
                                                        const count = (rawCash>0?1:0)+(rawNequi>0?1:0)+(rawDavi>0?1:0)+(rawFondo>0?1:0);
                                                        if (count <= 1) {
                                                            if (rawCash > 0) finalCash += tax;
                                                            if (rawNequi > 0) finalNequi += tax;
                                                            if (rawDavi > 0) finalDavi += tax;
                                                            if (rawFondo > 0) finalFondo += tax;
                                                        } else {
                                                            if (rawNequi > 0) finalNequi += tax;
                                                            else if (rawDavi > 0) finalDavi += tax;
                                                            else if (rawFondo > 0) finalFondo += tax;
                                                            else finalCash += tax;
                                                        }
                                                    }
                                                } else {
                                                    finalCash = total;
                                                }
                                            }
                                            return { ...e, _finalCash: finalCash, _finalNequi: finalNequi, _finalDavi: finalDavi, _finalFondo: finalFondo };
                                        })
                                    : parsedExpenses;

                                if (expensesForChannels.length === 0) return null;

                                return (
                                    <div className="space-y-4">
                                        {liveExpenses && (
                                            <p className="text-[9px] font-medium text-emerald-500 uppercase tracking-widest ml-1">✓ Mostrando datos actualizados desde la base de datos</p>
                                        )}
                                        {[
                                          { name: 'EFECTIVO', key: '_finalCash', icon: <Banknote size={14}/>, color: 'text-zinc-600 dark:text-zinc-400' },
                                          { name: 'NEQUI', key: '_finalNequi', icon: <Wallet size={14}/>, color: 'text-purple-500' },
                                          { name: 'DAVIPLATA', key: '_finalDavi', icon: <Landmark size={14}/>, color: 'text-rose-500' },
                                          { name: 'FONDO', key: '_finalFondo', icon: <Banknote size={14}/>, color: 'text-cyan-500' }
                                        ].map(method => {
                                            const mExps = expensesForChannels.filter((e: any) => e[method.key] > 0);
                                            if (mExps.length === 0) return null;
                                            const total = mExps.reduce((acc: number, e: any) => acc + e[method.key], 0);
                                            return (
                                                <div key={method.name} className="bg-zinc-50 dark:bg-[#18181b]/50 rounded-2xl border border-zinc-200 dark:border-white/5 overflow-hidden">
                                                    <h4 className="px-4 py-3 text-[11px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-[0.2em] border-b border-zinc-200 dark:border-white/5 bg-white dark:bg-[#18181b] flex items-center gap-2">
                                                        {method.icon} EGRESOS: {method.name}
                                                    </h4>
                                                    <Table aria-label={`Egresos ${method.name}`} removeWrapper classNames={summaryTableClasses}>
                                                        <TableHeader>
                                                            <TableColumn>DESCRIPCION</TableColumn>
                                                            <TableColumn align="end">MONTO</TableColumn>
                                                        </TableHeader>
                                                        <TableBody>
                                                            {mExps.map((e: any, i: number) => (
                                                                <TableRow key={i}>
                                                                    <TableCell className="uppercase">{e.description}</TableCell>
                                                                    <TableCell className="text-right font-bold text-rose-500">-${formatCurrency(e[method.key])}</TableCell>
                                                                </TableRow>
                                                            ))}
                                                            <TableRow className="bg-rose-500/5">
                                                                <TableCell className="font-bold text-rose-600 dark:text-rose-400 uppercase">TOTAL EGRESOS {method.name}</TableCell>
                                                                <TableCell className="text-right font-bold text-rose-600 dark:text-rose-400">-${formatCurrency(total)}</TableCell>
                                                            </TableRow>
                                                        </TableBody>
                                                    </Table>
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            })()}

                            <Divider className="bg-white dark:bg-[#18181b]" />

                            {/* VENTAS DETALLADAS DEL TURNO (desde BD) */}
                            {loadingDetail && (
                              <div className="flex items-center justify-center p-8">
                                <Spinner color="success" size="sm" />
                                <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest ml-3">Cargando detalle...</span>
                              </div>
                            )}
                            {!loadingDetail && fullDetail?.sales && Array.isArray(fullDetail.sales) && fullDetail.sales.length > 0 && (
                              <div className="space-y-4">
                                <div className="flex items-center justify-between ml-2">
                                  <h4 className="text-[11px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] tracking-tight">
                                    Ventas del Turno ({fullDetail.counts?.salesCount ?? fullDetail.sales.length})
                                  </h4>
                                  <span className="text-[9px] font-bold text-emerald-500 uppercase tracking-widest">
                                    Total: ${formatCurrency(fullDetail.sales.reduce((acc: number, s: any) => acc + (Number(s.total) || 0), 0))}
                                  </span>
                                </div>
                                <div className="bg-zinc-50 dark:bg-[#18181b]/50 rounded-2xl border border-zinc-200 dark:border-white/5 overflow-hidden max-h-[300px] overflow-y-auto">
                                  <Table
                                    aria-label="Sales Detail"
                                    removeWrapper
                                    classNames={{
                                      th: "bg-white dark:bg-[#18181b] text-[9px] font-medium uppercase tracking-widest text-gray-500 dark:text-zinc-500 sticky top-0 z-10",
                                      td: "text-[10px] font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-tight border-b border-zinc-200 dark:border-white/5"
                                    }}
                                  >
                                    <TableHeader>
                                      <TableColumn>HORA</TableColumn>
                                      <TableColumn>ID</TableColumn>
                                      <TableColumn>CLIENTE</TableColumn>
                                      <TableColumn>METODO</TableColumn>
                                      <TableColumn align="end">TOTAL</TableColumn>
                                    </TableHeader>
                                    <TableBody>
                                      {fullDetail.sales.map((s: any) => (
                                        <TableRow key={s.id || s.saleId}>
                                          <TableCell>{s.date ? formatTime(s.date) : '---'}</TableCell>
                                          <TableCell>#{s.id || s.saleId}</TableCell>
                                          <TableCell className="truncate max-w-[180px]">{s.client?.name || 'CONSUMIDOR FINAL'}</TableCell>
                                          <TableCell>
                                            <Chip size="sm" variant="flat" className="h-5 text-[8px] font-medium uppercase">
                                              {s.cashAmount > 0 && s.transferAmount > 0 ? 'MIXTO' :
                                               s.cashAmount > 0 ? 'EFECTIVO' :
                                               s.transferNequi > 0 ? 'NEQUI' :
                                               s.transferDaviplata > 0 ? 'DAVIPLATA' :
                                               s.transferAmount > 0 ? 'TRANSFER' :
                                               s.creditAmount > 0 ? 'FIADO' : '---'}
                                            </Chip>
                                          </TableCell>
                                          <TableCell className="text-emerald-500">${formatCurrency(Number(s.total) || 0)}</TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </div>
                              </div>
                            )}

                            {/* EGRESOS DEL TURNO DESDE BD (no del JSON serializado) */}
                            {!loadingDetail && fullDetail?.expenses && Array.isArray(fullDetail.expenses) && fullDetail.expenses.length > 0 && (
                              <div className="space-y-4">
                                <div className="flex items-center justify-between ml-2">
                                  <h4 className="text-[11px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] tracking-tight">
                                    Egresos Cargados en BD ({fullDetail.counts?.expensesCount ?? fullDetail.expenses.length})
                                  </h4>
                                  <span className="text-[9px] font-bold text-rose-400 uppercase tracking-widest">
                                    Total: ${formatCurrency(fullDetail.expenses.reduce((acc: number, e: any) => acc + (Number(e.amount) || 0), 0))}
                                  </span>
                                </div>
                                <div className="bg-zinc-50 dark:bg-[#18181b]/50 rounded-2xl border border-zinc-200 dark:border-white/5 overflow-hidden max-h-[300px] overflow-y-auto">
                                  <Table
                                    aria-label="DB Expenses Detail"
                                    removeWrapper
                                    classNames={{
                                      th: "bg-white dark:bg-[#18181b] text-[9px] font-medium uppercase tracking-widest text-gray-500 dark:text-zinc-500 sticky top-0 z-10",
                                      td: "text-[10px] font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-tight border-b border-zinc-200 dark:border-white/5"
                                    }}
                                  >
                                    <TableHeader>
                                      <TableColumn>HORA</TableColumn>
                                      <TableColumn>DESCRIPCION</TableColumn>
                                      <TableColumn>CATEGORIA</TableColumn>
                                      <TableColumn>FUENTE</TableColumn>
                                      <TableColumn align="end">MONTO</TableColumn>
                                    </TableHeader>
                                    <TableBody>
                                      {fullDetail.expenses.map((e: any) => (
                                        <TableRow key={e.id}>
                                          <TableCell>{e.date ? formatTime(e.date) : '---'}</TableCell>
                                          <TableCell className="truncate max-w-[180px]">{e.description || '---'}</TableCell>
                                          <TableCell>
                                            <Chip size="sm" variant="flat" color="warning" className="h-5 text-[8px] font-medium uppercase">
                                              {e.category || 'Otros'}
                                            </Chip>
                                          </TableCell>
                                          <TableCell>
                                            <Chip size="sm" variant="flat" className="h-5 text-[8px] font-medium uppercase">
                                              {e.paymentSource || 'EFECTIVO'}
                                            </Chip>
                                          </TableCell>
                                          <TableCell className="text-rose-400">-${formatCurrency(Number(e.amount) || 0)}</TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </div>
                              </div>
                            )}

                            {/* RESUMEN RAPIDO POR METODO DE PAGO (calculado de las ventas reales) */}
                            {!loadingDetail && fullDetail?.paymentSummary && (
                              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                                {Object.entries(fullDetail.paymentSummary as Record<string, number>)
                                  .filter(([_, v]) => Number(v) > 0)
                                  .map(([method, amount]) => (
                                    <div key={method} className="bg-zinc-50 dark:bg-[#18181b]/40 p-3 rounded-xl border border-zinc-200 dark:border-white/5">
                                      <span className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest block mb-1">{method}</span>
                                      <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(Number(amount))}</span>
                                    </div>
                                  ))}
                              </div>
                            )}

                            {/* Auditoria */}
                            <div className="bg-zinc-50/50 dark:bg-[#18181b]/30 p-6 rounded-[2rem] border border-zinc-200 dark:border-white/5 space-y-4">
                               <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-3">
                                     <User size={16} className="text-zinc-900 dark:text-zinc-100" />
                                     <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest tracking-tight">Responsable del Cierre</span>
                                  </div>
                                  <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-tight tracking-widest">{selectedClosure.closedByName}</span>
                               </div>
                               <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-3">
                                     <Calendar size={16} className="text-zinc-900 dark:text-zinc-100" />
                                     <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest tracking-tight">Periodo de Turno</span>
                                  </div>
                                  <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 tabular-nums tracking-tight">
                                    {formatDateTime(selectedClosure.startDate)} - {formatDateTime(selectedClosure.endDate)}
                                  </span>
                               </div>
                               {selectedClosure.authorizedBy && (
                                 <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                       <CheckCircle2 size={16} className="text-zinc-900 dark:text-zinc-100" />
                                       <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest tracking-tight">Autorizado por</span>
                                    </div>
                                    <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-tight tracking-widest">{selectedClosure.authorizedBy}</span>
                                 </div>
                               )}
                            </div>
                        </div>
                    );
                })()}
              </ModalBody>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* Modal Confirmar Eliminacion */}
      <Modal 
        isOpen={isDeleteOpen} 
        onOpenChange={onDeleteOpenChange}
        size="lg"
        classNames={{
          base: "bg-white dark:bg-zinc-950 border border-rose-500/20 rounded-[2.5rem]",
          header: "border-b border-rose-500/10 p-8",
          body: "p-8",
          footer: "border-t border-zinc-200 dark:border-white/5 p-6",
        }}
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1">
                <div className="flex items-center gap-3">
                   <div className="h-10 w-10 text-white bg-rose-500 rounded-2xl flex items-center justify-center text-zinc-900 dark:text-zinc-100 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/30">
                      <Trash2 size={20} />
                   </div>
                   <div className="flex flex-col">
                      <h3 className="text-xl font-medium text-zinc-900 dark:text-zinc-100 tracking-tight uppercase tracking-tighter leading-none">
                        Eliminar <span className="text-rose-500">Cierre de Caja</span>
                      </h3>
                      <p className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-[0.3em] mt-1 tracking-tight">Accion irreversible â€” Solo administradores</p>
                   </div>
                </div>
              </ModalHeader>
              <ModalBody>
                {closureToDelete && (
                  <div className="space-y-6">
                    <div className="bg-rose-500/10 border border-rose-500/20 rounded-2xl p-4 flex items-start gap-3">
                      <AlertCircle size={20} className="text-rose-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs font-medium text-rose-400 uppercase mb-1">Advertencia</p>
                        <p className="text-[11px] text-rose-300/80 font-bold">Este cierre sera eliminado permanentemente del sistema. Los totales acumulados se recalcularan automaticamente. Esta accion no se puede deshacer.</p>
                      </div>
                    </div>

                    <div className="bg-white dark:bg-[#18181b] rounded-2xl border border-zinc-200 dark:border-white/5 p-5 space-y-3">
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest">ID del Cierre</span>
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">#{closureToDelete.id}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Fecha</span>
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">{formatDateTime(closureToDelete.date)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Responsable</span>
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{closureToDelete.closedByName}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Ventas Totales</span>
                        <span className="text-sm font-medium text-gray-600 dark:text-zinc-300 tabular-nums">${formatCurrency(closureToDelete.totalSales)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Efectivo Fisico</span>
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(closureToDelete.physicalCash)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Diferencia</span>
                        <span className={`text-sm font-medium tabular-nums ${closureToDelete.difference === 0 ? 'text-zinc-900 dark:text-zinc-100' : closureToDelete.difference < 0 ? 'text-rose-500' : 'text-amber-500'}`}>
                          {closureToDelete.difference > 0 ? '+' : ''}${formatCurrency(closureToDelete.difference)}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </ModalBody>
              <ModalFooter>
                <Button 
                  variant="flat" 
                  onPress={onClose}
                  className="font-medium text-[10px] uppercase tracking-widest bg-white dark:bg-[#18181b] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 rounded-2xl"
                >
                  Cancelar
                </Button>
                <Button 
                  color="danger"
                  onPress={handleConfirmDelete}
                  isLoading={isDeleting}
                  className="font-medium text-[10px] uppercase tracking-widest rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20"
                  startContent={!isDeleting ? <Trash2 size={14} /> : undefined}
                >
                  {isDeleting ? 'Eliminando...' : 'Eliminar Permanentemente'}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
      
      <EditClosureModal 
        isOpen={isEditOpen} 
        onOpenChange={onEditOpenChange} 
        closure={closureToEdit} 
        onSuccess={fetchData} 
      />
    </div>
  );
}



