"use client";

import React, { memo } from 'react';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Button, Chip
} from "@heroui/react";
import { FileText, Edit, Trash2, Calendar, CreditCard } from 'lucide-react';
import { Expense } from '@/lib/definitions';

interface TableProps {
  expenses: Expense[];
  onEdit: (expense: Expense) => void;
  onDelete: (id: string) => void;
}

const ExpenseTable = memo(({ expenses, onEdit, onDelete }: TableProps) => {
  const sortedExpenses = [...expenses].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="flex-1 bg-white/90 dark:bg-zinc-950/60 backdrop-blur-3xl border border-gray-200 dark:border-white/10 rounded-[2.5rem] overflow-hidden flex flex-col shadow-2xl transition-all">
      {/* VISTA DESKTOP: TABLA */}
      <div className="hidden md:block flex-1 overflow-x-auto w-full custom-scrollbar">
        <Table 
          isCompact 
          removeWrapper 
          aria-label="Registro Maestro de Egresos" 
          classNames={{ 
            th: "bg-transparent text-gray-400 dark:text-rose-500/50 font-black uppercase text-[10px] tracking-widest h-14 py-1 border-b border-rose-500/10 sticky top-0 z-10 px-6", 
            td: "py-4 font-medium border-b border-rose-500/5 px-6", 
            tr: "hover:bg-rose-500/5 transition-all border-l-4 border-transparent hover:border-rose-500 active:bg-rose-500/10 group cursor-pointer" 
          }}
        >
          <TableHeader>
            <TableColumn>CONCEPTO / DESCRIPCIÓN</TableColumn>
            <TableColumn align="center" className="hidden lg:table-cell">ORDEN CRONOLÓGICO</TableColumn>
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
                    <div className="h-12 w-12 rounded-2xl bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-white/5 flex items-center justify-center text-rose-500 shrink-0 shadow-inner group-hover:scale-110 transition-transform">
                      <FileText size={20} />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm font-black text-gray-900 dark:text-white uppercase leading-tight italic truncate group-hover:text-rose-500 transition-colors">
                        {expense.description}
                      </span>
                      <span className="text-[9px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest mt-1 uppercase text-xs">
                        {expense.category}
                      </span>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-center hidden lg:table-cell">
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-gray-50 dark:bg-zinc-800 border border-gray-100 dark:border-white/5">
                    <Calendar size={10} className="text-gray-400" />
                    <span className="text-[10px] font-black tabular-nums text-gray-700 dark:text-zinc-300 italic">
                      {new Date(expense.date).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-center">
                  <Chip 
                    size="sm" 
                    variant="flat" 
                    className={`text-[9px] font-black h-6 uppercase italic border-none px-2 ${
                      expense.paymentSource === 'NEQUI' ? 'bg-pink-500/10 text-pink-500' :
                      expense.paymentSource === 'DAVIPLATA' ? 'bg-rose-500/10 text-rose-500' :
                      'bg-emerald-500/10 text-emerald-500'
                    }`}
                  >
                    {expense.paymentSource}
                  </Chip>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end items-center gap-4">
                    <div className="flex flex-col items-end">
                      <span className="text-base font-black text-gray-900 dark:text-white italic tabular-nums leading-none tracking-tighter">
                        <span className="text-rose-500 mr-0.5">$</span>
                        {Number(expense.amount).toLocaleString()}
                      </span>
                    </div>
                    
                    <div className="flex gap-2">
                      <button 
                         className="h-9 w-9 bg-gray-50 dark:bg-zinc-800 text-emerald-500 rounded-xl hover:bg-emerald-500 hover:text-white border border-gray-200 dark:border-white/5 shadow-sm transition-all flex items-center justify-center"
                         onClick={() => onEdit(expense)}
                      >
                        <Edit size={16} />
                      </button>
                      <button 
                         className="h-9 w-9 bg-gray-50 dark:bg-zinc-800 text-rose-500 rounded-xl hover:bg-rose-500 hover:text-white border border-gray-200 dark:border-white/5 shadow-sm transition-all flex items-center justify-center"
                         onClick={() => onDelete(expense.id)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* VISTA MÓVIL: CARDS */}
      <div className="md:hidden flex-1 p-2 flex flex-col gap-2 bg-gray-50/50 dark:bg-black/20">
        {sortedExpenses.map((expense) => (
          <div key={expense.id} className="bg-white dark:bg-zinc-900 p-4 rounded-2xl border border-gray-200 dark:border-white/5 shadow-sm flex flex-col gap-3">
             <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                   <div className="h-10 w-10 rounded-xl bg-rose-500/10 text-rose-500 flex items-center justify-center shrink-0">
                      <FileText size={18} />
                   </div>
                   <div className="flex flex-col">
                      <h3 className="text-[11px] font-black text-gray-900 dark:text-white uppercase truncate max-w-[150px] italic">{expense.description}</h3>
                      <span className="text-[8px] font-bold text-gray-400 uppercase tracking-widest">{expense.category}</span>
                   </div>
                </div>
                <div className="flex flex-col items-end">
                   <span className="text-sm font-black text-rose-500 tabular-nums italic">${Number(expense.amount).toLocaleString()}</span>
                   <span className="text-[8px] font-bold text-gray-400 uppercase">{expense.paymentSource}</span>
                </div>
             </div>
             <div className="flex items-center justify-between border-t border-gray-50 dark:border-white/5 pt-3">
                <span className="text-[9px] font-black text-gray-400 tabular-nums uppercase">#{String(expense.id).slice(-6).toUpperCase()}</span>
                <div className="flex gap-2">
                   <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-gray-100 dark:bg-zinc-800" onPress={() => onEdit(expense)}><Edit size={14}/></Button>
                   <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-rose-500/10 text-rose-500" onPress={() => onDelete(expense.id)}><Trash2 size={14}/></Button>
                </div>
             </div>
          </div>
        ))}
      </div>
    </div>
  );
});

ExpenseTable.displayName = 'ExpenseTable';
export default ExpenseTable;
