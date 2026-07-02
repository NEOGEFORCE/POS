"use client";

import React, { memo } from 'react';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Button, Chip, Tooltip
} from "@heroui/react";
import {
  FileText, Edit, Trash2, Calendar, ChevronLeft, ChevronRight, Info, UserPlus,
  Banknote, Wallet, Building2, CreditCard as CardIcon, HandCoins
} from 'lucide-react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  useDisclosure
} from "@heroui/react";
import { Expense } from '@/lib/definitions';
import { formatTimeWithSeconds } from '@/lib/utils';

interface TableProps {
  expenses: Expense[];
  isAdmin: boolean;
  onEdit: (expense: Expense) => void;
  onDelete: (id: string) => void;
  onSettle: (id: string, paymentSource: string, amount: number) => Promise<void>;
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalRecords: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

const formatDescription = (desc: string) => {
  if (!desc) return '';
  
  // Solo voltear si es una recepción de mercancía generada por el backend, 
  // para que el proveedor quede de primero (Ej: "RECREO - RECEPCIÓN DE MERCANCÍA")
  if (desc.startsWith('RECEPCIÓN DE MERCANCÍA - ') || desc.startsWith('RECEPCION DE MERCANCIA - ')) {
    const parts = desc.split(' - ');
    if (parts.length >= 2) {
      const supplier = parts.pop();
      return `${supplier} - ${parts.join(' - ')}`;
    }
  }
  
  // Para los demás egresos (incluyendo "PROVEEDOR - PAGO DE PROVEEDOR"), dejarlos tal cual
  return desc;
};

const formatPaymentSourceForDisplay = (source: string) => {
  if (!source) return 'CAJA';

  if (source.startsWith('{') && source.endsWith('}')) {
    try {
      const parsed = JSON.parse(source);
      const activeMethods = [];
      if (parsed.CAJA > 0) activeMethods.push('CAJA');
      if (parsed.CASH > 0) activeMethods.push('CAJA');
      if (parsed.EFECTIVO > 0) activeMethods.push('CAJA');
      if (parsed.NEQUI > 0) activeMethods.push('NEQUI');
      if (parsed.DAVIPLATA > 0) activeMethods.push('DAVIPLATA');
      if (parsed.FONDO > 0) activeMethods.push('BÓVEDA');
      if (parsed.PRESTAMO > 0) activeMethods.push('PRÉSTAMO');
      
      if (activeMethods.length > 0) {
        return Array.from(new Set(activeMethods)).join(' + ');
      }
    } catch (e) {
      // Ignorar error si no es JSON válido
    }
  }

  // Elimina montos como ": $171000" o ": $1.000" o ": $100.00"
  let cleanSource = source.replace(/:\s*\$[\d.,]+/g, '').trim();
  // Cambia " / " por " + "
  cleanSource = cleanSource.replace(/\s*\/\s*/g, ' + ');
  
  // Normalizar todo a CAJA
  cleanSource = cleanSource.replace(/\b(CASH|EFECTIVO)\b/g, 'CAJA');

  return cleanSource;
};

const getPaymentSourceStyle = (source: string) => {
  const formatted = formatPaymentSourceForDisplay(source);
  const s = formatted?.toUpperCase() || 'CAJA';
  if (s === 'NEQUI') return 'bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400';
  if (s === 'DAVIPLATA') return 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400';
  if (s === 'EFECTIVO' || s === 'CAJA') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400';
  if (s === 'FONDO' || s === 'BÓVEDA' || s === 'BOVEDA') return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-400';
  if (s === 'PRESTAMO' || s === 'PREST.') return 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400';
  if (s === 'BANCOLOMBIA' || s === 'TRANSFERENCIA') return 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400';
  if (s.includes('+')) return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-400'; // MIXTO
  return 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-zinc-300';
};

const ExpenseTable = memo(({
  expenses, isAdmin, onEdit, onDelete, onSettle,
  currentPage, totalPages, pageSize, totalRecords,
  onPageChange, onPageSizeChange
}: TableProps) => {
  const sortedExpenses = [...expenses].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="flex-1 min-h-0 h-full bg-black/5 dark:bg-[#18181b]/30 border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/5 transition-all">
      {/* AREA DE CONTENIDO PRINCIPAL */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* VISTA DESKTOP: TABLA */}
        <div className="hidden md:flex flex-1 flex-col overflow-hidden">
          <Table
            isCompact
            isHeaderSticky
            aria-label="Registro Maestro de Egresos"
            className="flex-1"
            classNames={{
              base: "flex-1 overflow-hidden",
              wrapper: "overflow-auto custom-scrollbar bg-transparent shadow-none p-0 rounded-none flex-1 min-h-0 h-full",
              th: "bg-[#f9fafb] dark:bg-[#09090b] text-gray-500 dark:text-rose-400 font-extrabold uppercase text-[10px] tracking-[0.2em] h-12 py-2 border-b-2 border-gray-200 dark:border-white/10 sticky top-0 !z-[500] shadow-[0_8px_30px_rgb(0,0,0,0.12)]",
              td: "py-3 font-medium border-b border-gray-100 dark:border-white/5 px-6",
              tr: "hover:bg-rose-500/5 dark:hover:bg-rose-500/5 transition-colors border-l-4 border-transparent hover:border-rose-500 active:bg-rose-500/10 group cursor-pointer"
            }}
          >
            <TableHeader>
              <TableColumn>CONCEPTO / DESCRIPCION</TableColumn>
              <TableColumn align="center" className="hidden lg:table-cell">AUDITORIA CCTV (HORA)</TableColumn>
              <TableColumn align="center" className="hidden xl:table-cell">AUDITORIA</TableColumn>
              <TableColumn align="center">CANAL ORIGEN</TableColumn>
              <TableColumn align="end">VALOR TOTAL</TableColumn>
            </TableHeader>
            <TableBody
              emptyContent={
                <div className="py-24 text-center">
                  <span className="text-xs font-medium uppercase tracking-[0.4em] tracking-tight text-gray-500 dark:text-zinc-500 dark:text-zinc-400">Sin registros de egreso</span>
                </div>
              }
            >
              {sortedExpenses.map((expense) => (
                <TableRow key={expense.id}>
                  <TableCell>
                    <div className="flex items-center gap-4">
                      <div className="h-10 w-10 rounded-2xl bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-white/5 flex items-center justify-center text-rose-500 shrink-0 shadow-inner group-hover:scale-110 transition-transform">
                        <FileText size={18} />
                      </div>
                      <div className="flex flex-col flex-1 min-h-0 min-w-0 h-full w-full">
                        <span className="text-[11px] font-medium text-zinc-900 dark:text-zinc-50 uppercase leading-tight tracking-tight truncate group-hover:text-rose-500 transition-colors">
                          {formatDescription(expense.description)}
                        </span>
                        <span className="text-[8px] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 font-bold tracking-widest mt-1 uppercase flex items-center gap-2">
                          {expense.category}
                          {expense.status === 'PENDING' && (
                            <span className="animate-pulse flex items-center gap-1 bg-rose-500/10 text-rose-500 px-1.5 py-0.5 rounded text-[7px] font-medium tracking-tighter">
                              <Info size={8} /> DEUDA PENDIENTE
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-center hidden lg:table-cell">
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-2xl bg-gray-50 dark:bg-zinc-800 border border-gray-100 dark:border-white/5">
                      <Calendar size={10} className="text-rose-500" />
                      <span className="text-[10px] font-medium tabular-nums text-gray-700 dark:text-zinc-300 tracking-tight">
                        {new Date(expense.date).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()}
                        <span className="mx-1 text-gray-300 dark:text-zinc-700">|</span>
                        <span className="text-rose-500 font-bold">
                          {formatTimeWithSeconds(expense.date)}
                        </span>
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-center hidden xl:table-cell">
                    <div className="flex flex-col items-center">
                      <span className="text-[10px] font-medium uppercase text-zinc-900 dark:text-zinc-50 tracking-tight leading-tight">
                        {expense.creator?.name || 'SISTEMA'}
                      </span>
                      <span className="text-[7px] font-medium text-rose-500 uppercase tracking-widest mt-0.5">
                        {expense.creator?.role || 'REGISTRADOR'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="flex flex-col items-center gap-1">
                        <Chip
                          size="sm"
                          variant="flat"
                          className={`text-[9px] font-bold h-6 uppercase tracking-widest border-none px-2 ${getPaymentSourceStyle(expense.paymentSource)}`}
                        >
                          {formatPaymentSourceForDisplay(expense.paymentSource)}
                        </Chip>
                      {(expense.paymentSource === 'PRESTAMO' || expense.paymentSource === 'PREST.') && expense.lenderName && (
                        <span className="text-[7px] font-medium text-amber-500 uppercase tracking-tight bg-amber-500/5 px-1.5 py-0.5 rounded-2xl flex items-center gap-1">
                          <UserPlus size={8} /> PRESTAMISTA: {expense.lenderName}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end items-center gap-4">
                      <div className="flex flex-col items-end leading-none">
                        <span className={`text-[13px] font-medium tracking-tight tabular-nums tracking-tighter ${expense.status === 'PENDING' ? 'text-amber-500' : 'text-zinc-900 dark:text-zinc-50'}`}>
                          <span className={`${expense.status === 'PENDING' ? 'text-amber-500' : 'text-rose-500'} mr-0.5`}>$</span>
                          {(Number(expense.amount) + Number(expense.taxAmount || 0)).toLocaleString()}
                        </span>
                        {Number(expense.taxAmount || 0) > 0 && (
                          <span className="text-[9px] font-medium text-gray-400 mt-1 uppercase tracking-tight">
                            Inc. imp. 4x1000
                          </span>
                        )}
                      </div>

                      {isAdmin && (
                        <div className="flex gap-1">
                          <Tooltip content="EDITAR" delay={0} closeDelay={0} showArrow classNames={{ content: "font-medium text-[9px] uppercase tracking-widest bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white py-1 px-2 rounded-none shadow-[0_8px_30px_rgb(0,0,0,0.12)]" }}>
                            <button
                              className="h-8 w-8 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 rounded-2xl hover:bg-zinc-50 dark:hover:bg-white/5 bg-white dark:bg-transparent border border-zinc-200 dark:border-white/5 hover:text-white border border-emerald-500/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all flex items-center justify-center active:scale-90"
                              onClick={() => onEdit(expense)}
                            >
                              <Edit size={14} />
                            </button>
                          </Tooltip>
                          <Tooltip content="ELIMINAR" delay={0} closeDelay={0} showArrow classNames={{ content: "font-medium text-[9px] uppercase tracking-widest bg-rose-500 text-white py-1 px-2 rounded-none shadow-[0_8px_30px_rgb(0,0,0,0.12)]" }} placement="top-end">
                            <button
                              className="h-8 w-8 bg-rose-500/5 text-rose-500 rounded-2xl hover:bg-rose-500 hover:text-white border border-rose-500/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all flex items-center justify-center active:scale-90"
                              onClick={() => onDelete(expense.id)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </Tooltip>
                        </div>
                      )}

                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* VISTA MOVIL: CARDS CON SCROLL INTERNO */}
        <div className="md:hidden p-2 flex flex-col gap-2 overflow-auto custom-scrollbar bg-gray-50/50 dark:bg-[#18181b] flex-1 min-h-0 h-full pb-24">
          {sortedExpenses.map((expense) => (
            <div key={expense.id} className="card-base border-none p-4 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col gap-3 shrink-0 transition-transform active:scale-[0.98]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-2xl bg-rose-500/10 text-rose-500 flex items-center justify-center shrink-0">
                    <FileText size={18} />
                  </div>
                  <div className="flex flex-col">
                    <h3 className="text-[11px] font-medium text-zinc-900 dark:text-zinc-50 uppercase truncate max-w-[150px] tracking-tight leading-tight">{formatDescription(expense.description)}</h3>
                    <span className="text-[8px] font-bold text-gray-400 uppercase tracking-widest">{expense.category}</span>
                  </div>
                </div>
                  <div className="flex flex-col items-end leading-tight text-right">
                    <span className="text-[13px] font-medium text-rose-500 tabular-nums tracking-tight leading-none">${(Number(expense.amount) + Number(expense.taxAmount || 0)).toLocaleString()}</span>

                    <div className="flex flex-col items-end mt-1 gap-0.5">
                      <span className={`text-[7px] font-bold px-1.5 py-0.5 rounded uppercase tracking-widest leading-none ${expense.status === 'PENDING' ? 'bg-amber-500/10 text-amber-500' : getPaymentSourceStyle(expense.paymentSource)}`}>
                        {expense.status === 'PENDING' ? 'DEUDA PENDIENTE' : formatPaymentSourceForDisplay(expense.paymentSource)}
                      </span>
                    {(expense.paymentSource === 'PRESTAMO' || expense.paymentSource === 'PREST.') && (
                      <span className="text-[6px] font-medium text-amber-500 uppercase tracking-tight">POR: {expense.lenderName}</span>
                    )}
                      {formatTimeWithSeconds(expense.date)}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-gray-50 dark:border-white/5 pt-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[8px] font-medium text-gray-300 dark:text-zinc-600 tabular-nums uppercase tracking-widest leading-none">#{String(expense.id).slice(-6).toUpperCase()}</span>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-[7px] font-medium text-rose-500 uppercase tracking-tighter leading-none tracking-tight">
                      {expense.creator?.name || 'SISTEMA'}
                    </span>
                    <span className="text-[6px] font-bold text-gray-400 uppercase">| {expense.creator?.role || 'REGISTRADOR'}</span>
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex gap-2">
                    <Tooltip content="EDITAR" delay={0} closeDelay={0} showArrow classNames={{ content: "font-medium text-[9px] uppercase tracking-widest bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white py-1 px-2 rounded-none shadow-[0_8px_30px_rgb(0,0,0,0.12)]" }}>
                      <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-emerald-500/5 text-zinc-900 dark:text-zinc-100 rounded-2xl border border-emerald-500/10 transition-all hover:bg-emerald-500 hover:text-white" onPress={() => onEdit(expense)}><Edit size={12} /></Button>
                    </Tooltip>
                    <Tooltip content="ELIMINAR" delay={0} closeDelay={0} showArrow classNames={{ content: "font-medium text-[9px] uppercase tracking-widest bg-rose-500 text-white py-1 px-2 rounded-none shadow-[0_8px_30px_rgb(0,0,0,0.12)]" }} placement="top-end">
                      <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-rose-500/5 text-rose-500 rounded-2xl border border-rose-500/10 transition-all hover:bg-rose-500 hover:text-white" onPress={() => onDelete(expense.id)}><Trash2 size={12} /></Button>
                    </Tooltip>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>


      {/* PAGINACION FIJA (ESTILO USUARIOS) */}
      {totalRecords > 0 && (
        <div className="shrink-0 px-3 py-2 flex items-center justify-between gap-2 border-t border-gray-200 dark:border-white/10 bg-gray-50/95 dark:bg-zinc-950 z-40 shadow-[0_-4px_15px_rgba(0,0,0,0.1)]">
          <div className="flex items-center gap-2 font-medium">
            <Button
              isIconOnly
              size="sm"
              variant="flat"
              onPress={() => onPageChange(Math.max(1, currentPage - 1))}
              isDisabled={currentPage === 1}
              className="h-8 w-8 min-w-0 card-base border-none text-zinc-900 dark:text-zinc-50 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-90 transition-transform"
            >
              <ChevronLeft size={18} />
            </Button>

            <div className="flex flex-col items-start px-1 leading-none">
              <span className="text-[7px] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase font-medium tracking-tighter">MOSTRANDO</span>
              <p className="text-[10px] text-zinc-900 dark:text-zinc-50 uppercase tracking-widest flex items-center gap-1">
                <span className="tracking-tight font-medium text-rose-500">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, totalRecords)}</span>
                <span className="opacity-20 text-[8px]">DE</span>
                <span className="tracking-tight font-medium">{totalRecords}</span>
              </p>
            </div>

            <Button
              isIconOnly
              size="sm"
              variant="flat"
              onPress={() => onPageChange(Math.min(totalPages, currentPage + 1))}
              isDisabled={currentPage === totalPages || totalPages === 0}
              className="h-8 w-8 min-w-0 card-base border-none text-zinc-900 dark:text-zinc-50 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-90 transition-transform"
            >
              <ChevronRight size={18} />
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <select
                value={pageSize}
                onChange={(e) => onPageSizeChange(Number(e.target.value))}
                className="h-8 card-base border-none text-zinc-900 dark:text-zinc-50 text-[10px] font-medium uppercase tracking-widest px-2 pr-6 outline-none rounded-2xl border border-gray-200 dark:border-white/10 cursor-pointer shadow-[0_8px_30px_rgb(0,0,0,0.12)] appearance-none"
              >
                {[10, 20, 50].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-30">
                <Info size={10} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

ExpenseTable.displayName = 'ExpenseTable';
export default ExpenseTable;



