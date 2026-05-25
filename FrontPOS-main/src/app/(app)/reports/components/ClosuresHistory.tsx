"use client";

import React, { useState, useEffect, useMemo } from 'react';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Spinner, Button, Chip, Tooltip, Card, CardBody,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
  Divider
} from "@heroui/react";
import { 
  Eye, FileText, Calendar, User, TrendingUp, TrendingDown, 
  AlertCircle, CheckCircle2, ChevronDown, ChevronRight,
  Wallet, CreditCard, Banknote, Landmark, History, Trash2, ShieldAlert, Zap, Edit
} from "lucide-react";
import { formatCurrency, formatTime, formatDateTime, formatShortDateTime, formatLocalDate } from "@/lib/utils";
import Cookies from 'js-cookie';
import { useAuth } from '@/lib/auth';
import { useToast } from "@/hooks/use-toast";
import EditClosureModal from './EditClosureModal';

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
  closedByName: string;
  authorizedBy?: string;
  expensesDetail?: string;
  salariesDetail?: string;
  coins100: number;
  coins200: number;
  coins500: number;
  coins1000: number;
}

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
  }, []);

  const handleViewDetail = (closure: CashierClosure) => {
    setSelectedClosure(closure);
    onOpen();
  };

  const handleDeleteClick = (closure: CashierClosure) => {
    setClosureToDelete(closure);
    onDeleteOpen();
  };

  const handleEditClick = (closure: CashierClosure) => {
    setClosureToEdit(closure);
    onEditOpen();
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

  // Agrupar cierres por día
  const groupedClosures = useMemo(() => {
    const groups: Record<string, CashierClosure[]> = {};
    (closures || []).forEach(c => {
      if (!c?.date) return;
      // Usar componentes locales para agrupar por el día real del usuario
      const d = new Date(c.date);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(c);
    });
    return groups;
  }, [closures]);

  const sortedDates = useMemo(() => {
    return Object.keys(groupedClosures).sort((a, b) => b.localeCompare(a));
  }, [groupedClosures]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-20 gap-4">
        <Spinner color="success" size="lg" />
        <p className="text-[10px] font-medium uppercase tracking-[0.4em] text-zinc-500 animate-pulse">Cargando Historial Auditado</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* SECCIÓN DE RESUMEN EJECUTIVO */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
         {/* CARD 1: ÚLTIMO CIERRE */}
         <Card className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/5 rounded-[2rem] shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden relative group">
            <div className="absolute -right-4 -top-4 bg-zinc-100 dark:bg-white/5 h-24 w-24 rounded-2xl blur-2xl transition-all" />
            <CardBody className="p-6">
               <div className="flex justify-between items-start mb-6">
                  <div className="flex items-center gap-3">
                     <div className="h-10 w-10 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 rounded-2xl flex items-center justify-center text-zinc-900 dark:text-zinc-100 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                        <History size={20} />
                     </div>
                     <div>
                        <h4 className="text-[11px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-tighter tracking-tight">Último Cierre de Caja</h4>
                        <p className="text-[8px] font-bold text-zinc-500 uppercase tracking-widest tracking-tight">Análisis del turno más reciente</p>
                     </div>
                  </div>
                  {closures[0] && (
                    <Chip size="sm" variant="flat" className="font-medium text-[9px] uppercase tracking-tight bg-zinc-100 dark:bg-white/5 text-zinc-900 dark:text-zinc-100 border-none">REF #{closures[0].id}</Chip>
                  )}
               </div>
               <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                     <span className="text-[9px] font-medium text-zinc-500 uppercase tracking-widest block">Efectivo Real</span>
                     <span className="text-xl font-medium text-zinc-900 dark:text-zinc-100 tabular-nums tracking-tight">${formatCurrency(closures[0]?.physicalCash || 0)}</span>
                  </div>
                  <div className="space-y-1 text-right">
                     <span className="text-[9px] font-medium text-zinc-500 uppercase tracking-widest block">Diferencia</span>
                     <span className={`text-xl font-medium tabular-nums tracking-tight ${closures[0]?.difference === 0 ? 'text-zinc-900 dark:text-zinc-100' : closures[0]?.difference < 0 ? 'text-rose-500' : 'text-amber-500'}`}>
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
                <span className="text-[9px] font-medium text-blue-500/80 uppercase tracking-tight">Ventas desde el último cierre</span>
                <span className="text-[9px] font-medium text-blue-500/80 uppercase tabular-nums">Monitorización 24/7</span>
              </div>
            </CardBody>
          </Card>
        </div>

        {/* INFO ADICIONAL: SALDO INICIAL */}
        <div className="bg-amber-500/5 border border-amber-500/10 p-4 rounded-2xl flex items-center gap-4">
           <AlertCircle className="text-amber-500" size={20} />
           <p className="text-[10px] font-bold text-amber-500/80 uppercase tracking-widest">
             <span className="font-medium">NOTA DE AUDITORÍA:</span> El sistema toma el <span className="underline">Efectivo Real</span> del cierre anterior como el <span className="underline">Saldo Inicial</span> del siguiente turno. Asegúrese de que el cajero cuente bien el fondo de caja al iniciar.
           </p>
        </div>

      {sortedDates.length === 0 ? (
        <div className="p-20 text-center bg-white dark:bg-zinc-950/20 rounded-[2rem] border border-dashed border-zinc-200 dark:border-white/5">
           <AlertCircle className="mx-auto mb-4 text-zinc-600" size={40} />
           <p className="text-sm font-medium text-zinc-500 uppercase tracking-tight">No se encontraron cierres registrados</p>
        </div>
      ) : (
        <div className="space-y-8">
          {sortedDates.map(date => (
            <div key={date} className="space-y-3">
              <div className="flex items-center gap-4 ml-4">
                <div className="h-2 w-2 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
                <h3 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.3em] tracking-tight">
                  {formatLocalDate(date)}
                </h3>
                <div className="flex-1 h-px bg-gradient-to-r from-white/10 to-transparent" />
              </div>

              <div className="grid grid-cols-1 gap-3">
                {groupedClosures[date].length > 1 && (
                  <div className="flex items-center gap-2 ml-6 animate-pulse">
                    <ShieldAlert size={14} className="text-amber-500" />
                    <span className="text-[9px] font-medium text-amber-500 uppercase tracking-widest">
                      âš ï¸ {groupedClosures[date].length} cierres detectados este día â€” Verificar posibles duplicados
                    </span>
                  </div>
                )}
                {groupedClosures[date].map(closure => (
                  <Card 
                    key={closure.id} 
                    className={`bg-white dark:bg-[#18181b] hover:bg-zinc-100 dark:bg-zinc-800 border hover:border-emerald-500/30 transition-all rounded-2xl group overflow-hidden cursor-pointer ${
                      groupedClosures[date].length > 1 ? 'border-amber-500/30' : 'border-zinc-200 dark:border-white/5'
                    }`}
                    onClick={() => handleViewDetail(closure)}
                  >
                    <CardBody className="p-4 md:p-6">
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        {/* Info General */}
                        <div className="flex items-center gap-4">
                          <div className={`h-12 w-12 rounded-2xl flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] ${closure.difference === 0 ? 'text-zinc-900 dark:text-zinc-100 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 ' : closure.difference < 0 ? 'text-white bg-rose-500 shadow-rose-500/20' : 'text-white bg-amber-500 shadow-amber-500/20'}`}>
                            <FileText size={20} />
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest leading-none mb-1">Cierre #{closure.id}</span>
                            <div className="flex items-center gap-2">
                               <span className="text-lg font-medium text-zinc-900 dark:text-zinc-100 tracking-tight tracking-tight">{closure?.date ? formatTime(closure.date) : '---'}</span>
                               <Chip size="sm" variant="flat" color="default" className="h-5 text-[9px] font-medium uppercase tracking-tight">{closure?.closedByName || '---'}</Chip>
                               {groupedClosures[date].length > 1 && (
                                 <Chip size="sm" variant="flat" className="h-5 text-[8px] font-medium uppercase bg-amber-500/10 text-amber-500 border-none">POSIBLE DUPLICADO</Chip>
                               )}
                            </div>
                          </div>
                        </div>

                        {/* Métricas Rápidas */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 md:gap-8 flex-1 md:justify-center px-4">
                          <div className="flex flex-col">
                            <span className="text-[9px] font-medium text-zinc-500 uppercase tracking-widest mb-1">Ventas Totales</span>
                            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(closure.totalSales)}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[9px] font-medium text-zinc-500 uppercase tracking-widest mb-1">Efectivo Real</span>
                            <span className="text-sm font-medium text-zinc-300 tabular-nums">${formatCurrency(closure.physicalCash)}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[9px] font-medium text-zinc-500 uppercase tracking-widest mb-1">Egresos</span>
                            <span className="text-sm font-medium text-rose-400 tabular-nums">${formatCurrency(closure.totalExpenses)}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[9px] font-medium text-zinc-500 uppercase tracking-widest mb-1">Diferencia</span>
                            <span className={`text-sm font-medium tabular-nums ${closure.difference === 0 ? 'text-zinc-900 dark:text-zinc-100' : closure.difference < 0 ? 'text-rose-500' : 'text-amber-500'}`}>
                              {closure.difference > 0 ? '+' : ''}${formatCurrency(closure.difference)}
                            </span>
                          </div>
                        </div>

                        {/* Botones de Acción */}
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
                           <Button 
                             isIconOnly 
                             variant="light" 
                             className="text-zinc-500 group-hover:text-zinc-900 dark:text-zinc-100 transition-colors"
                           >
                             <ChevronRight size={20} />
                           </Button>
                        </div>
                      </div>
                    </CardBody>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal Detalle */}
      <Modal 
        isOpen={isOpen} 
        onOpenChange={onOpenChange}
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
                        Detalle de <span className="text-zinc-900 dark:text-zinc-100">Auditoría</span>
                      </h3>
                      <p className="text-[9px] font-medium text-zinc-500 uppercase tracking-[0.3em] mt-1 tracking-tight">Cierre #{selectedClosure?.id} - Ref: {selectedClosure?.date ? formatShortDateTime(selectedClosure.date) : '---'}</p>
                   </div>
                </div>
              </ModalHeader>
              <ModalBody>
                {selectedClosure && (
                  <div className="space-y-8">
                    {/* Resumen de Arqueo */}
                    <div className="grid grid-cols-3 gap-4">
                       <div className="bg-white dark:bg-[#18181b] p-4 rounded-2xl border border-zinc-200 dark:border-white/5 flex flex-col items-center text-center">
                          <span className="text-[9px] font-medium text-zinc-500 uppercase tracking-widest mb-1 tracking-tight">Saldo Inicial</span>
                          <span className="text-xl font-medium text-amber-500 tabular-nums tracking-tight">${formatCurrency(selectedClosure.openingCash)}</span>
                       </div>
                       <div className="bg-white dark:bg-[#18181b] p-4 rounded-2xl border border-zinc-200 dark:border-white/5 flex flex-col items-center text-center border-l-4 border-l-blue-500/50">
                          <span className="text-[9px] font-medium text-zinc-500 uppercase tracking-widest mb-1 tracking-tight">Saldo Esperado</span>
                          <span className="text-xl font-medium text-blue-400 tabular-nums tracking-tight">${formatCurrency(selectedClosure.expectedCash || (selectedClosure.openingCash + selectedClosure.totalCash - selectedClosure.totalExpenses))}</span>
                       </div>
                       <div className="bg-white dark:bg-[#18181b] p-4 rounded-2xl border border-zinc-200 dark:border-white/5 flex flex-col items-center text-center border-l-4 border-l-emerald-500/50">
                          <span className="text-[9px] font-medium text-zinc-500 uppercase tracking-widest mb-1 tracking-tight">Arqueo Físico</span>
                          <span className="text-xl font-medium text-zinc-300 tabular-nums tracking-tight">${formatCurrency(selectedClosure.physicalCash)}</span>
                       </div>
                    </div>

                    {/* Desglose de Monedas */}
                    {(selectedClosure.coins100 > 0 || selectedClosure.coins200 > 0 || selectedClosure.coins500 > 0 || selectedClosure.coins1000 > 0) && (
                      <div className="space-y-4">
                         <h4 className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] tracking-tight ml-2">Desglose de Monedas en el Arqueo</h4>
                         <div className="grid grid-cols-4 gap-3">
                            <div className="bg-zinc-50/50 dark:bg-white dark:bg-[#18181b]/30 p-3 rounded-2xl border border-zinc-200 dark:border-white/5 text-center">
                               <span className="text-[9px] font-medium text-zinc-500 uppercase mb-1 block">$100</span>
                               <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(selectedClosure.coins100)}</span>
                            </div>
                            <div className="bg-zinc-50/50 dark:bg-white dark:bg-[#18181b]/30 p-3 rounded-2xl border border-zinc-200 dark:border-white/5 text-center">
                               <span className="text-[9px] font-medium text-zinc-500 uppercase mb-1 block">$200</span>
                               <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(selectedClosure.coins200)}</span>
                            </div>
                            <div className="bg-zinc-50/50 dark:bg-white dark:bg-[#18181b]/30 p-3 rounded-2xl border border-zinc-200 dark:border-white/5 text-center">
                               <span className="text-[9px] font-medium text-zinc-500 uppercase mb-1 block">$500</span>
                               <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(selectedClosure.coins500)}</span>
                            </div>
                            <div className="bg-zinc-50/50 dark:bg-white dark:bg-[#18181b]/30 p-3 rounded-2xl border border-zinc-200 dark:border-white/5 text-center">
                               <span className="text-[9px] font-medium text-zinc-500 uppercase mb-1 block">$1.000</span>
                               <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(selectedClosure.coins1000)}</span>
                            </div>
                         </div>
                      </div>
                    )}

                    {/* Alerta de Diferencia */}
                    {selectedClosure.difference !== 0 && (
                      <div className={`p-4 rounded-2xl flex items-center gap-4 border ${selectedClosure.difference < 0 ? 'bg-rose-500/10 border-rose-500/20 text-rose-500' : 'bg-amber-500/10 border-amber-500/20 text-amber-500'}`}>
                         <AlertCircle size={20} />
                         <div className="flex flex-col">
                            <span className="text-xs font-medium uppercase tracking-tight">Detección de {selectedClosure.difference < 0 ? 'Faltante' : 'Sobrante'}</span>
                            <p className="text-[10px] font-bold opacity-80 uppercase tracking-widest">Se ha registrado una discrepancia de ${formatCurrency(selectedClosure.difference)} en este turno.</p>
                         </div>
                      </div>
                    )}

                    {/* Desglose por Medio de Pago */}
                    <div className="space-y-4">
                       <h4 className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] tracking-tight ml-2">Distribución por Medios de Pago</h4>
                       <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          <div className="bg-zinc-50 dark:bg-white dark:bg-[#18181b]/50 p-4 rounded-2xl border border-zinc-200 dark:border-white/5">
                             <div className="flex items-center gap-2 text-zinc-500 mb-2">
                                <Banknote size={14} />
                                <span className="text-[10px] font-medium uppercase tracking-tight">Efectivo</span>
                             </div>
                             <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(selectedClosure.totalCash)}</span>
                          </div>
                          <div className="bg-zinc-50 dark:bg-white dark:bg-[#18181b]/50 p-4 rounded-2xl border border-zinc-200 dark:border-white/5">
                             <div className="flex items-center gap-2 text-zinc-500 mb-2">
                                <Wallet size={14} />
                                <span className="text-[10px] font-medium uppercase tracking-tight">Nequi</span>
                             </div>
                             <span className="text-sm font-medium text-purple-400 tabular-nums">${formatCurrency(selectedClosure.totalNequi)}</span>
                          </div>
                          <div className="bg-zinc-50 dark:bg-white dark:bg-[#18181b]/50 p-4 rounded-2xl border border-zinc-200 dark:border-white/5">
                             <div className="flex items-center gap-2 text-zinc-500 mb-2">
                                <Landmark size={14} />
                                <span className="text-[10px] font-medium uppercase tracking-tight">Daviplata</span>
                             </div>
                             <span className="text-sm font-medium text-rose-400 tabular-nums">${formatCurrency(selectedClosure.totalDaviplata)}</span>
                          </div>
                          <div className="bg-zinc-50 dark:bg-white dark:bg-[#18181b]/50 p-4 rounded-2xl border border-zinc-200 dark:border-white/5">
                             <div className="flex items-center gap-2 text-zinc-500 mb-2">
                                <CreditCard size={14} />
                                <span className="text-[10px] font-medium uppercase tracking-tight">Tarjeta/Otros</span>
                             </div>
                             <span className="text-sm font-medium text-sky-400 tabular-nums">${formatCurrency(selectedClosure.totalCard + selectedClosure.totalTransfer)}</span>
                          </div>
                       </div>
                    </div>

                      <Divider className="bg-white dark:bg-[#18181b]" />

                    {/* Gastos Detallados */}
                    {selectedClosure.expensesDetail && (
                      <div className="space-y-4">
                        <h4 className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] tracking-tight ml-2">Egresos Reportados en el Turno</h4>
                        <div className="bg-zinc-50 dark:bg-white dark:bg-[#18181b]/50 rounded-2xl border border-zinc-200 dark:border-white/5 overflow-hidden">
                          <Table 
                            aria-label="Expenses Detail" 
                            removeWrapper
                            classNames={{
                              th: "bg-white dark:bg-[#18181b] text-[9px] font-medium uppercase tracking-widest text-zinc-500",
                              td: "text-[10px] font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-tight border-b border-zinc-200 dark:border-white/5"
                            }}
                          >
                            <TableHeader>
                              <TableColumn>DESCRIPCIÓN</TableColumn>
                              <TableColumn>CANAL</TableColumn>
                              <TableColumn align="end">MONTO</TableColumn>
                            </TableHeader>
                            <TableBody>
                              {(() => {
                                try {
                                  if (!selectedClosure?.expensesDetail) return <TableRow><TableCell>Sin detalles</TableCell><TableCell>{" "}</TableCell><TableCell>{" "}</TableCell></TableRow>;
                                  const expenses = JSON.parse(selectedClosure.expensesDetail);
                                  if (!Array.isArray(expenses)) return <TableRow><TableCell>Formato inválido</TableCell><TableCell>{" "}</TableCell><TableCell>{" "}</TableCell></TableRow>;
                                  return expenses.map((e: any, i: number) => (
                                    <TableRow key={i}>
                                      <TableCell>{e?.description || '---'}</TableCell>
                                      <TableCell>
                                        <Chip size="sm" variant="flat" color="warning" className="h-5 text-[8px] font-medium uppercase">{e.paymentSource || 'EFECTIVO'}</Chip>
                                      </TableCell>
                                      <TableCell className="text-rose-400">-${formatCurrency(e?.amount || 0)}</TableCell>
                                    </TableRow>
                                  ));
                                } catch (e) {
                                  return <TableRow><TableCell>Error al cargar detalles</TableCell><TableCell>{" "}</TableCell><TableCell>{" "}</TableCell></TableRow>;
                                }
                              })()}
                            </TableBody>
                          </Table>
                        </div>
                      </div>
                    )}

                    <Divider className="bg-white dark:bg-[#18181b]" />

                    {/* Auditoría */}
                    <div className="bg-zinc-50/50 dark:bg-white dark:bg-[#18181b]/30 p-6 rounded-[2rem] border border-zinc-200 dark:border-white/5 space-y-4">
                       <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                             <User size={16} className="text-zinc-900 dark:text-zinc-100" />
                             <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest tracking-tight">Responsable del Cierre</span>
                          </div>
                          <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-tight tracking-widest">{selectedClosure.closedByName}</span>
                       </div>
                       <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                             <Calendar size={16} className="text-zinc-900 dark:text-zinc-100" />
                             <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest tracking-tight">Periodo de Turno</span>
                          </div>
                          <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 tabular-nums tracking-tight">
                            {formatDateTime(selectedClosure.startDate)} - {formatDateTime(selectedClosure.endDate)}
                          </span>
                       </div>
                       {selectedClosure.authorizedBy && (
                         <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                               <CheckCircle2 size={16} className="text-zinc-900 dark:text-zinc-100" />
                               <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest tracking-tight">Autorizado por</span>
                            </div>
                            <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-tight tracking-widest">{selectedClosure.authorizedBy}</span>
                         </div>
                       )}
                    </div>
                  </div>
                )}
              </ModalBody>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* Modal Confirmar Eliminación */}
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
                      <p className="text-[9px] font-medium text-zinc-500 uppercase tracking-[0.3em] mt-1 tracking-tight">Acción irreversible â€” Solo administradores</p>
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
                        <p className="text-[11px] text-rose-300/80 font-bold">Este cierre será eliminado permanentemente del sistema. Los totales acumulados se recalcularán automáticamente. Esta acción no se puede deshacer.</p>
                      </div>
                    </div>

                    <div className="bg-white dark:bg-[#18181b] rounded-2xl border border-zinc-200 dark:border-white/5 p-5 space-y-3">
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest">ID del Cierre</span>
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">#{closureToDelete.id}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest">Fecha</span>
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">{formatDateTime(closureToDelete.date)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest">Responsable</span>
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{closureToDelete.closedByName}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest">Ventas Totales</span>
                        <span className="text-sm font-medium text-zinc-300 tabular-nums">${formatCurrency(closureToDelete.totalSales)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest">Efectivo Físico</span>
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(closureToDelete.physicalCash)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest">Diferencia</span>
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
                  className="font-medium text-[10px] uppercase tracking-widest bg-white dark:bg-[#18181b] text-zinc-500 dark:text-zinc-400 rounded-2xl"
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



