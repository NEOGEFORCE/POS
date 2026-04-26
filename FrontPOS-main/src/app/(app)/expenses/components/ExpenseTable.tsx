"use client";

import React, { memo } from 'react';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Button, Chip, Tooltip
} from "@heroui/react";
import { 
  FileText, Edit, Trash2, Calendar, CreditCard, 
  ChevronLeft, ChevronRight, Info 
} from 'lucide-react';
import { Expense } from '@/lib/definitions';

interface TableProps {
  expenses: Expense[];
  isAdmin: boolean;
  onEdit: (expense: Expense) => void;
  onDelete: (id: string) => void;
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalRecords: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

const ExpenseTable = memo(({ 
  expenses, isAdmin, onEdit, onDelete,
  currentPage, totalPages, pageSize, totalRecords,
  onPageChange, onPageSizeChange
}: TableProps) => {
  const sortedExpenses = [...expenses].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="flex-1 min-h-0 bg-white/50 dark:bg-zinc-900/30 backdrop-blur-sm border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col shadow-2xl shadow-rose-500/5 transition-all">
      {/* ÁREA DE CONTENIDO PRINCIPAL */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* VISTA DESKTOP: TABLA */}
        <div className="hidden md:flex flex-1 flex-col overflow-hidden">
          <Table 
            isCompact 
            isHeaderSticky
            aria-label="Registro Maestro de Egresos" 
            className="flex-1"
            classNames={{ 
              base: "flex-1 overflow-hidden",
              wrapper: "flex-1 overflow-auto custom-scrollbar bg-transparent shadow-none p-0 rounded-none",
              th: "bg-[#f9fafb] dark:bg-[#09090b] text-gray-500 dark:text-rose-400 font-extrabold uppercase text-[10px] tracking-[0.2em] h-12 py-2 border-b-2 border-gray-200 dark:border-white/10 sticky top-0 !z-[500] shadow-sm", 
              td: "py-3 font-medium border-b border-gray-100 dark:border-white/5 px-6", 
              tr: "hover:bg-rose-500/5 dark:hover:bg-rose-500/5 transition-colors border-l-4 border-transparent hover:border-rose-500 active:bg-rose-500/10 group cursor-pointer" 
            }}
          >
            <TableHeader>
              <TableColumn>CONCEPTO / DESCRIPCIÓN</TableColumn>
              <TableColumn align="center" className="hidden lg:table-cell">AUDITORÍA CCTV (HORA)</TableColumn>
              <TableColumn align="center" className="hidden xl:table-cell">AUDITORÍA</TableColumn>
              <TableColumn align="center">CANAL ORIGEN</TableColumn>
              <TableColumn align="end">VALOR TOTAL</TableColumn>
            </TableHeader>
            <TableBody 
              emptyContent={
                <div className="py-24 text-center">
                  <span className="text-xs font-black uppercase tracking-[0.4em] italic text-zinc-400">Sin registros de egreso</span>
                </div>
              }
            >
              {sortedExpenses.map((expense) => (
                <TableRow key={expense.id}>
                  <TableCell>
                    <div className="flex items-center gap-4">
                      <div className="h-10 w-10 rounded-xl bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-white/5 flex items-center justify-center text-rose-500 shrink-0 shadow-inner group-hover:scale-110 transition-transform">
                        <FileText size={18} />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-[11px] font-black text-gray-900 dark:text-white uppercase leading-tight italic truncate group-hover:text-rose-500 transition-colors">
                          {expense.description}
                        </span>
                        <span className="text-[8px] text-gray-400 dark:text-zinc-500 font-bold tracking-widest mt-1 uppercase">
                          {expense.category}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-center hidden lg:table-cell">
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-gray-50 dark:bg-zinc-800 border border-gray-100 dark:border-white/5">
                      <Calendar size={10} className="text-rose-500" />
                      <span className="text-[10px] font-black tabular-nums text-gray-700 dark:text-zinc-300 italic">
                        {new Date(expense.date).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()}
                        <span className="mx-1 text-gray-300 dark:text-zinc-700">|</span>
                        <span className="text-rose-500 font-bold">
                          {new Date(expense.date).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-center hidden xl:table-cell">
                    <div className="flex flex-col items-center">
                      <span className="text-[10px] font-black uppercase text-gray-900 dark:text-white italic leading-tight">
                        {expense.creator?.name || 'SISTEMA'}
                      </span>
                      <span className="text-[7px] font-black text-rose-500 uppercase tracking-widest mt-0.5">
                        {expense.creator?.role || 'REGISTRADOR'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="flex flex-col items-center gap-1">
                      <Chip 
                        size="sm" 
                        variant="flat" 
                        className={`text-[9px] font-black h-6 uppercase italic border-none px-2 ${
                          expense.paymentSource === 'NEQUI' ? 'bg-pink-500/10 text-pink-500' :
                          expense.paymentSource === 'DAVIPLATA' ? 'bg-rose-500/10 text-rose-500' :
                          expense.paymentSource === 'PRESTADO' ? 'bg-amber-500/10 text-amber-500' :
                          'bg-emerald-500/10 text-emerald-500'
                        }`}
                      >
                        {expense.paymentSource}
                      </Chip>
                      {expense.paymentSource === 'PRESTADO' && expense.lenderName && (
                        <span className="text-[7px] font-black text-amber-500 uppercase italic bg-amber-500/5 px-1.5 py-0.5 rounded-md">
                          A CARGO: {expense.lenderName}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end items-center gap-4">
                      <div className="flex flex-col items-end leading-none">
                        <span className="text-[13px] font-black text-gray-900 dark:text-white italic tabular-nums tracking-tighter">
                          <span className="text-rose-500 mr-0.5">$</span>
                          {Number(expense.amount).toLocaleString()}
                        </span>
                      </div>
                      
                      {isAdmin && (
                        <div className="flex gap-1">
                          <Tooltip content="EDITAR" delay={0} closeDelay={0} showArrow classNames={{ content: "font-black text-[9px] uppercase tracking-widest bg-emerald-500 text-white py-1 px-2 rounded-none shadow-xl" }}>
                            <button 
                               className="h-8 w-8 bg-emerald-500/5 text-emerald-500 rounded-lg hover:bg-emerald-500 hover:text-white border border-emerald-500/10 shadow-sm transition-all flex items-center justify-center active:scale-90"
                               onClick={() => onEdit(expense)}
                            >
                              <Edit size={14} />
                            </button>
                          </Tooltip>
                          <Tooltip content="ELIMINAR" delay={0} closeDelay={0} showArrow classNames={{ content: "font-black text-[9px] uppercase tracking-widest bg-rose-500 text-white py-1 px-2 rounded-none shadow-xl" }} placement="top-end">
                            <button 
                               className="h-8 w-8 bg-rose-500/5 text-rose-500 rounded-lg hover:bg-rose-500 hover:text-white border border-rose-500/10 shadow-sm transition-all flex items-center justify-center active:scale-90"
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

        {/* VISTA MÓVIL: CARDS CON SCROLL INTERNO */}
        <div className="md:hidden flex-1 p-2 flex flex-col gap-2 overflow-auto custom-scrollbar bg-gray-50/50 dark:bg-black/20">
          {sortedExpenses.map((expense) => (
            <div key={expense.id} className="bg-white dark:bg-zinc-900 p-4 rounded-xl border border-gray-200 dark:border-white/5 shadow-sm flex flex-col gap-3 shrink-0 transition-transform active:scale-[0.98]">
               <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                     <div className="h-10 w-10 rounded-xl bg-rose-500/10 text-rose-500 flex items-center justify-center shrink-0">
                        <FileText size={18} />
                     </div>
                     <div className="flex flex-col">
                        <h3 className="text-[11px] font-black text-gray-900 dark:text-white uppercase truncate max-w-[150px] italic leading-tight">{expense.description}</h3>
                        <span className="text-[8px] font-bold text-gray-400 uppercase tracking-widest">{expense.category}</span>
                     </div>
                  </div>
                  <div className="flex flex-col items-end leading-tight text-right">
                     <span className="text-[13px] font-black text-rose-500 tabular-nums italic leading-none">${Number(expense.amount).toLocaleString()}</span>
                     <div className="flex flex-col items-end mt-1 gap-0.5">
                        <span className="text-[7px] font-black text-gray-400 uppercase tracking-tighter leading-none">{expense.paymentSource}</span>
                        {expense.paymentSource === 'PRESTADO' && (
                          <span className="text-[6px] font-black text-amber-500 uppercase italic">POR: {expense.lenderName}</span>
                        )}
                        <span className="text-[6px] font-bold text-zinc-500 uppercase leading-none">
                          {new Date(expense.date).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                     </div>
                  </div>
               </div>
                <div className="flex items-center justify-between border-t border-gray-50 dark:border-white/5 pt-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[8px] font-black text-gray-300 dark:text-zinc-600 tabular-nums uppercase tracking-widest leading-none">#{String(expense.id).slice(-6).toUpperCase()}</span>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="text-[7px] font-black text-rose-500 uppercase tracking-tighter leading-none italic">
                        {expense.creator?.name || 'SISTEMA'}
                      </span>
                      <span className="text-[6px] font-bold text-gray-400 uppercase">| {expense.creator?.role || 'REGISTRADOR'}</span>
                    </div>
                  </div>
                    <div className="flex gap-2">
                       <Tooltip content="EDITAR" delay={0} closeDelay={0} showArrow classNames={{ content: "font-black text-[9px] uppercase tracking-widest bg-emerald-500 text-white py-1 px-2 rounded-none shadow-xl" }}>
                         <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-emerald-500/5 text-emerald-500 rounded-lg border border-emerald-500/10 transition-all hover:bg-emerald-500 hover:text-white" onPress={() => onEdit(expense)}><Edit size={12}/></Button>
                       </Tooltip>
                       <Tooltip content="ELIMINAR" delay={0} closeDelay={0} showArrow classNames={{ content: "font-black text-[9px] uppercase tracking-widest bg-rose-500 text-white py-1 px-2 rounded-none shadow-xl" }} placement="top-end">
                         <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-rose-500/5 text-rose-500 rounded-lg border border-rose-500/10 transition-all hover:bg-rose-500 hover:text-white" onPress={() => onDelete(expense.id)}><Trash2 size={12}/></Button>
                       </Tooltip>
                    </div>
               </div>
            </div>
          ))}
        </div>
      </div>

      {/* PAGINACIÓN FIJA (ESTILO USUARIOS) */}
      {totalRecords > 0 && (
        <div className="shrink-0 px-3 py-2 flex items-center justify-between gap-2 border-t border-gray-200 dark:border-white/10 bg-gray-50/95 dark:bg-zinc-950 backdrop-blur-md z-40 shadow-[0_-4px_15px_rgba(0,0,0,0.1)]">
          <div className="flex items-center gap-2 font-black">
            <Button
              isIconOnly
              size="sm"
              variant="flat"
              onPress={() => onPageChange(Math.max(1, currentPage - 1))}
              isDisabled={currentPage === 1}
              className="h-8 w-8 min-w-0 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white rounded-lg border border-gray-200 dark:border-white/5 shadow-sm active:scale-90 transition-transform"
            >
              <ChevronLeft size={18} />
            </Button>
            
            <div className="flex flex-col items-start px-1 leading-none">
              <span className="text-[7px] text-gray-400 dark:text-zinc-500 uppercase font-black tracking-tighter">MOSTRANDO</span>
              <p className="text-[10px] text-gray-900 dark:text-white uppercase tracking-widest flex items-center gap-1">
                <span className="italic font-black text-rose-500">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, totalRecords)}</span> 
                <span className="opacity-20 text-[8px]">DE</span> 
                <span className="italic font-black">{totalRecords}</span>
              </p>
            </div>

            <Button
              isIconOnly
              size="sm"
              variant="flat"
              onPress={() => onPageChange(Math.min(totalPages, currentPage + 1))}
              isDisabled={currentPage === totalPages || totalPages === 0}
              className="h-8 w-8 min-w-0 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white rounded-lg border border-gray-200 dark:border-white/5 shadow-sm active:scale-90 transition-transform"
            >
              <ChevronRight size={18} />
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <select 
                value={pageSize} 
                onChange={(e) => onPageSizeChange(Number(e.target.value))} 
                className="h-8 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white text-[10px] font-black uppercase tracking-widest px-2 pr-6 outline-none rounded-lg border border-gray-200 dark:border-white/10 cursor-pointer shadow-sm appearance-none"
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
