"use client";

import React, { useState, useEffect, useMemo } from 'react';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Spinner, Button, Chip, Tooltip, Card, CardBody,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
  Divider,
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
      type: 'box-closure',
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

  // Agrupar cierres por dia
  const groupedClosures = useMemo(() => {
    const groups: Record<string, CashierClosure[]> = {};
    (closures || []).forEach(c => {
      if (!c?.date) return;
      // Usar componentes locales para agrupar por el dia real del usuario
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
                        <p className="text-[8px] font-bold text-zinc-500 uppercase tracking-widest tracking-tight">Analisis del turno mas reciente</p>
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
                <span className="text-[9px] font-medium text-blue-500/80 uppercase tracking-tight">Ventas desde el ultimo cierre</span>
                <span className="text-[9px] font-medium text-blue-500/80 uppercase tabular-nums">Monitorizacion 24/7</span>
              </div>
            </CardBody>
          </Card>
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
                      âš ï¸ {groupedClosures[date].length} cierres detectados este dia â€” Verificar posibles duplicados
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

                        {/* Metricas Rapidas */}
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
                                 className="text-zinc-500 group-hover:text-zinc-900 dark:text-zinc-100 transition-colors"
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
                ))}
              </div>
            </div>
          ))}
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
                          <span className="text-xl font-medium text-blue-400 tabular-nums tracking-tight">${formatCurrency(selectedClosure.expectedCash || (selectedClosure.totalCash - selectedClosure.totalExpenses))}</span>
                       </div>
                       <div className="bg-white dark:bg-[#18181b] p-4 rounded-2xl border border-zinc-200 dark:border-white/5 flex flex-col items-center text-center border-l-4 border-l-emerald-500/50">
                          <span className="text-[9px] font-medium text-zinc-500 uppercase tracking-widest mb-1 tracking-tight">Arqueo Fisico</span>
                          <span className="text-xl font-medium text-zinc-300 tabular-nums tracking-tight">${formatCurrency(selectedClosure.physicalCash)}</span>
                       </div>
                    </div>

                    {/* CUADRE REAL — Formula visible */}
                    {fullDetail?.realCashFormula && (
                      <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-[2rem] p-6">
                        <div className="flex items-center gap-3 mb-4">
                          <div className="h-9 w-9 rounded-2xl bg-emerald-500 text-white flex items-center justify-center shadow-[0_0_20px_rgba(16,185,129,0.3)]">
                            <Wallet size={16} />
                          </div>
                          <div className="flex flex-col">
                            <h4 className="text-[11px] font-medium text-emerald-500 uppercase tracking-tighter">Cuadre Real (Fisico)</h4>
                            <p className="text-[8px] font-bold text-emerald-500/70 uppercase tracking-widest">Efectivo Real + Transferencias - Egresos</p>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          <div className="bg-white dark:bg-[#18181b] p-3 rounded-2xl border border-zinc-200 dark:border-white/5 text-center">
                            <span className="text-[8px] font-medium text-zinc-500 uppercase tracking-widest mb-1 block">Efectivo Real</span>
                            <span className="text-base font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(fullDetail.realCashFormula.physicalCash || 0)}</span>
                          </div>
                          <div className="bg-white dark:bg-[#18181b] p-3 rounded-2xl border border-zinc-200 dark:border-white/5 text-center">
                            <span className="text-[8px] font-medium text-zinc-500 uppercase tracking-widest mb-1 block">+ Transferencias</span>
                            <span className="text-base font-medium text-purple-400 tabular-nums">${formatCurrency(fullDetail.realCashFormula.transferReal || 0)}</span>
                          </div>
                          <div className="bg-white dark:bg-[#18181b] p-3 rounded-2xl border border-zinc-200 dark:border-white/5 text-center">
                            <span className="text-[8px] font-medium text-zinc-500 uppercase tracking-widest mb-1 block">- Egresos</span>
                            <span className="text-base font-medium text-rose-400 tabular-nums">${formatCurrency(fullDetail.realCashFormula.expenses || 0)}</span>
                          </div>
                          <div className="bg-emerald-500/10 p-3 rounded-2xl border border-emerald-500/30 text-center">
                            <span className="text-[8px] font-medium text-emerald-500 uppercase tracking-widest mb-1 block">= BALANCE REAL</span>
                            <span className="text-base font-bold text-emerald-500 tabular-nums">${formatCurrency(fullDetail.realCashFormula.balanceReal || 0)}</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Desglose de Monedas */}
                    {(selectedClosure.coins100 > 0 || selectedClosure.coins200 > 0 || selectedClosure.coins500 > 0 || selectedClosure.coins1000 > 0) && (
                      <div className="space-y-4">
                         <h4 className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] tracking-tight ml-2">Desglose de Monedas en el Arqueo</h4>
                         <div className="grid grid-cols-4 gap-3">
                            <div className="bg-zinc-50/50 dark:bg-[#18181b]/30 p-3 rounded-2xl border border-zinc-200 dark:border-white/5 text-center">
                               <span className="text-[9px] font-medium text-zinc-500 uppercase mb-1 block">$100</span>
                               <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(selectedClosure.coins100)}</span>
                            </div>
                            <div className="bg-zinc-50/50 dark:bg-[#18181b]/30 p-3 rounded-2xl border border-zinc-200 dark:border-white/5 text-center">
                               <span className="text-[9px] font-medium text-zinc-500 uppercase mb-1 block">$200</span>
                               <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(selectedClosure.coins200)}</span>
                            </div>
                            <div className="bg-zinc-50/50 dark:bg-[#18181b]/30 p-3 rounded-2xl border border-zinc-200 dark:border-white/5 text-center">
                               <span className="text-[9px] font-medium text-zinc-500 uppercase mb-1 block">$500</span>
                               <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(selectedClosure.coins500)}</span>
                            </div>
                            <div className="bg-zinc-50/50 dark:bg-[#18181b]/30 p-3 rounded-2xl border border-zinc-200 dark:border-white/5 text-center">
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
                            <span className="text-xs font-medium uppercase tracking-tight">Deteccion de {selectedClosure.difference < 0 ? 'Faltante' : 'Sobrante'}</span>
                            <p className="text-[10px] font-bold opacity-80 uppercase tracking-widest">Se ha registrado una discrepancia de ${formatCurrency(selectedClosure.difference)} en este turno.</p>
                         </div>
                      </div>
                    )}

                    {/* Desglose por Medio de Pago */}
                    <div className="space-y-4">
                       <h4 className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] tracking-tight ml-2">Distribucion por Medios de Pago</h4>
                       <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          <div className="bg-zinc-50 dark:bg-[#18181b]/50 p-4 rounded-2xl border border-zinc-200 dark:border-white/5">
                             <div className="flex items-center gap-2 text-zinc-500 mb-2">
                                <Banknote size={14} />
                                <span className="text-[10px] font-medium uppercase tracking-tight">Efectivo</span>
                             </div>
                             <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">${formatCurrency(selectedClosure.totalCash)}</span>
                          </div>
                          <div className="bg-zinc-50 dark:bg-[#18181b]/50 p-4 rounded-2xl border border-zinc-200 dark:border-white/5">
                             <div className="flex items-center gap-2 text-zinc-500 mb-2">
                                <Wallet size={14} />
                                <span className="text-[10px] font-medium uppercase tracking-tight">Nequi</span>
                             </div>
                             <span className="text-sm font-medium text-purple-400 tabular-nums">${formatCurrency(selectedClosure.totalNequi)}</span>
                          </div>
                          <div className="bg-zinc-50 dark:bg-[#18181b]/50 p-4 rounded-2xl border border-zinc-200 dark:border-white/5">
                             <div className="flex items-center gap-2 text-zinc-500 mb-2">
                                <Landmark size={14} />
                                <span className="text-[10px] font-medium uppercase tracking-tight">Daviplata</span>
                             </div>
                             <span className="text-sm font-medium text-rose-400 tabular-nums">${formatCurrency(selectedClosure.totalDaviplata)}</span>
                          </div>
                          {/* Tarjetas dinamicas: una por cada metodo EXTRA usado en el turno
                              (Bancolombia, Mastercard, Visa, etc.) — sin agrupacion "Otros".
                              Filtramos los 4 metodos ya cubiertos arriba (Efectivo, Nequi,
                              Daviplata, Fiado). */}
                          {(() => {
                            const breakdown = selectedClosure.paymentMethodsBreakdown || [];
                            const fixed = new Set(['EFECTIVO', 'NEQUI', 'DAVIPLATA', 'FIADO']);
                            const extras = breakdown.filter(
                              (m) => m && m.method && m.total > 0 && !fixed.has(m.method.toUpperCase())
                            );
                            if (extras.length === 0) return null;

                            const iconFor = (raw: string) => {
                              const m = raw.toUpperCase();
                              if (m.includes('BANCOLOMBIA') || m.includes('BANCO')) return <Landmark size={14} />;
                              return <CreditCard size={14} />;
                            };
                            const colorFor = (raw: string) => {
                              const m = raw.toUpperCase();
                              if (m.includes('BANCOLOMBIA')) return 'text-sky-400';
                              if (m.includes('MASTERCARD')) return 'text-orange-400';
                              if (m.includes('VISA')) return 'text-blue-400';
                              if (m.includes('AMEX') || m.includes('AMERICAN')) return 'text-emerald-400';
                              return 'text-sky-400';
                            };

                            return extras.map((mt) => (
                              <div key={mt.method} className="bg-zinc-50 dark:bg-[#18181b]/50 p-4 rounded-2xl border border-zinc-200 dark:border-white/5">
                                <div className="flex items-center gap-2 text-zinc-500 mb-2">
                                  {iconFor(mt.method)}
                                  <span className="text-[10px] font-medium uppercase tracking-tight">{mt.method}</span>
                                </div>
                                <span className={`text-sm font-medium ${colorFor(mt.method)} tabular-nums`}>${formatCurrency(mt.total)}</span>
                              </div>
                            ));
                          })()}
                       </div>
                    </div>

                      <Divider className="bg-white dark:bg-[#18181b]" />

                    {/* Gastos Detallados */}
                    {selectedClosure.expensesDetail && (
                      <div className="space-y-4">
                        <h4 className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] tracking-tight ml-2">Egresos Reportados en el Turno</h4>
                        <div className="bg-zinc-50 dark:bg-[#18181b]/50 rounded-2xl border border-zinc-200 dark:border-white/5 overflow-hidden">
                          <Table 
                            aria-label="Expenses Detail" 
                            removeWrapper
                            classNames={{
                              th: "bg-white dark:bg-[#18181b] text-xs font-semibold uppercase tracking-widest text-zinc-500",
                              td: "text-[10px] font-medium text-zinc-900 dark:text-zinc-100 border-b border-zinc-200 dark:border-white/5"
                            }}
                          >
                            <TableHeader>
                              <TableColumn>DESCRIPCION</TableColumn>
                              <TableColumn>CANAL</TableColumn>
                              <TableColumn align="end">MONTO</TableColumn>
                            </TableHeader>
                            <TableBody>
                              {(() => {
                                try {
                                  if (!selectedClosure?.expensesDetail) return <TableRow><TableCell>Sin detalles</TableCell><TableCell>{" "}</TableCell><TableCell>{" "}</TableCell></TableRow>;
                                  const expenses = JSON.parse(selectedClosure.expensesDetail);
                                  if (!Array.isArray(expenses)) return <TableRow><TableCell>Formato invalido</TableCell><TableCell>{" "}</TableCell><TableCell>{" "}</TableCell></TableRow>;
                                  return expenses.map((e: any, i: number) => (
                                    <TableRow key={i}>
                                      <TableCell>{e?.description || '---'}</TableCell>
                                      <TableCell>
                                        <Chip size="sm" variant="flat" color="warning" className="h-5 text-[8px] font-medium uppercase">{e.paymentSource || 'EFECTIVO'}</Chip>
                                      </TableCell>
                                      <TableCell className="text-red-400 font-medium">-${formatCurrency(e?.amount || 0)}</TableCell>
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

                    {/* VENTAS DETALLADAS DEL TURNO (desde BD) */}
                    {loadingDetail && (
                      <div className="flex items-center justify-center p-8">
                        <Spinner color="success" size="sm" />
                        <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest ml-3">Cargando detalle...</span>
                      </div>
                    )}
                    {!loadingDetail && fullDetail?.sales && Array.isArray(fullDetail.sales) && fullDetail.sales.length > 0 && (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between ml-2">
                          <h4 className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] tracking-tight">
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
                              th: "bg-white dark:bg-[#18181b] text-[9px] font-medium uppercase tracking-widest text-zinc-500 sticky top-0 z-10",
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
                          <h4 className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] tracking-tight">
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
                              th: "bg-white dark:bg-[#18181b] text-[9px] font-medium uppercase tracking-widest text-zinc-500 sticky top-0 z-10",
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
                              <span className="text-[9px] font-medium text-zinc-500 uppercase tracking-widest block mb-1">{method}</span>
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
                      <p className="text-[9px] font-medium text-zinc-500 uppercase tracking-[0.3em] mt-1 tracking-tight">Accion irreversible â€” Solo administradores</p>
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
                        <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest">Efectivo Fisico</span>
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



