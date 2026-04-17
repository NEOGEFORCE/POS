"use client";

import React, { memo } from 'react';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Button, Pagination
} from "@heroui/react";
import { Building2, Phone, MapPin, Edit, Trash2 } from 'lucide-react';
import { Supplier } from '@/lib/definitions';

interface TableProps {
  suppliers: Supplier[];
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalFiltered: number;
  onEdit: (supplier: Supplier) => void;
  onDelete: (id: string | number) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

const SupplierTable = memo(({
  suppliers,
  currentPage,
  totalPages,
  pageSize,
  totalFiltered,
  onEdit,
  onDelete,
  onPageChange,
  onPageSizeChange
}: TableProps) => {
  return (
    <div className="flex-1 bg-white/80 dark:bg-zinc-950/60 backdrop-blur-2xl border border-gray-200 dark:border-white/10 rounded-[2.5rem] overflow-hidden flex flex-col min-h-0 shadow-2xl transition-all focus-within:border-emerald-500/30 mb-6">
      {/* VISTA DESKTOP: TABLA */}
      <div className="hidden md:block flex-1 overflow-x-auto custom-scrollbar">
        <Table 
          isCompact 
          removeWrapper 
          aria-label="Directorio Maestro Proveedores" 
          classNames={{ 
            th: "bg-gray-50/50 dark:bg-black/40 backdrop-blur-md text-gray-400 dark:text-zinc-500 font-black uppercase text-[10px] tracking-[0.2em] h-14 py-2 border-b border-gray-200 dark:border-white/10 sticky top-0 z-10 px-6", 
            td: "py-4 font-medium border-b border-gray-100 dark:border-white/5 px-6 group-hover:bg-white dark:group-hover:bg-zinc-900/50 transition-colors", 
            tr: "transition-all border-l-4 border-transparent hover:border-emerald-500 cursor-pointer group" 
          }}
        >
          <TableHeader>
            <TableColumn>FIRMA / RAZÓN SOCIAL</TableColumn>
            <TableColumn align="center">CANAL CONTACTO</TableColumn>
            <TableColumn align="start" className="hidden lg:table-cell">LOCALIZACIÓN / SEDE</TableColumn>
            <TableColumn align="end">ACCIONES</TableColumn>
          </TableHeader>
          <TableBody emptyContent={<div className="py-24 text-xs font-black text-zinc-500 uppercase text-center italic tracking-[0.3em]">Sin abastecedores registrados bajo este criterio</div>}>
            {suppliers.map((supplier) => (
              <TableRow key={supplier.id}>
                <TableCell>
                  <div className="flex items-center gap-4">
                    <div className="h-12 w-12 rounded-2xl bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-white/5 flex items-center justify-center text-emerald-500 shrink-0 shadow-inner group-hover:scale-110 transition-transform overflow-hidden">
                      {supplier.imageUrl ? (
                        <img src={supplier.imageUrl} alt={supplier.name} className="h-full w-full object-cover" />
                      ) : (
                        <Building2 size={20} />
                      )}
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm font-black text-gray-900 dark:text-white uppercase leading-tight italic truncate group-hover:text-emerald-500 transition-colors">
                        {supplier.name}
                      </span>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[9px] text-gray-400 dark:text-zinc-500 font-bold tracking-widest uppercase">ID: {supplier.id}</span>
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="inline-flex items-center gap-3 px-4 py-2 rounded-xl bg-gray-50 dark:bg-zinc-800/50 border border-gray-200 dark:border-white/5 group-hover:border-emerald-500/30 transition-all">
                    <Phone size={12} className="text-emerald-500" />
                    <span className="text-xs font-black text-gray-900 dark:text-white tabular-nums tracking-[0.2em] italic">
                      {supplier.phone || 'SIN TEL.'}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <div className="flex items-center gap-2 max-w-[200px] md:max-w-[300px]">
                    <MapPin size={14} className="text-zinc-400 shrink-0" />
                    <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-tight italic truncate">
                      {supplier.address || 'DIRECCIÓN NO DISPONIBLE'}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <button 
                      className="h-9 w-9 bg-gray-50 dark:bg-zinc-800 text-emerald-500 rounded-xl hover:bg-emerald-500 hover:text-white border border-gray-200 dark:border-white/5 shadow-sm transition-all flex items-center justify-center p-0"
                      onClick={() => onEdit(supplier)}
                    >
                      <Edit size={16} />
                    </button>
                    <button 
                      className="h-9 w-9 bg-gray-50 dark:bg-zinc-800 text-rose-500 rounded-xl hover:bg-rose-500 hover:text-white border border-gray-200 dark:border-white/5 shadow-sm transition-all flex items-center justify-center p-0" 
                      onClick={() => onDelete(supplier.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* VISTA MÓVIL: CARDS */}
      <div className="md:hidden flex-1 p-2 flex flex-col gap-2">
        {suppliers.map((supplier) => (
          <div key={supplier.id} className="bg-white dark:bg-zinc-900 p-4 rounded-xl border border-gray-200 dark:border-white/5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center shrink-0 overflow-hidden">
                {supplier.imageUrl ? (
                  <img src={supplier.imageUrl} alt={supplier.name} className="h-full w-full object-cover" />
                ) : (
                  <Building2 size={18} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[11px] font-black text-gray-900 dark:text-white uppercase truncate">{supplier.name}</h3>
                <div className="flex items-center gap-2 mt-1">
                   <Phone size={8} className="text-emerald-500" />
                   <span className="text-[9px] font-bold text-gray-500 italic">{supplier.phone || 'N/A'}</span>
                </div>
              </div>
              <div className="flex gap-1">
                <Button isIconOnly size="sm" variant="flat" onPress={() => onEdit(supplier)} className="h-8 w-8 bg-gray-100 dark:bg-zinc-800"><Edit size={12}/></Button>
                <Button isIconOnly size="sm" variant="flat" onPress={() => onDelete(supplier.id)} className="h-8 w-8 bg-rose-500/10 text-rose-500"><Trash2 size={12}/></Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="px-6 py-4 flex items-center justify-between border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900 shrink-0">
        <div className="flex flex-col">
          <p className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none mb-1">
            REGISTROS: <span className="text-gray-900 dark:text-white italic">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, totalFiltered)}</span>
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          <Pagination
            isCompact
            showControls
            total={totalPages}
            page={currentPage}
            onChange={onPageChange}
            classNames={{
              item: "bg-white dark:bg-zinc-800 text-[10px] font-black uppercase rounded-lg border border-gray-200 dark:border-white/5 h-8 min-w-[32px]",
              cursor: "bg-gray-900 dark:bg-white text-white dark:text-black font-black",
            }}
          />
        </div>
      </div>
    </div>
  );
});

SupplierTable.displayName = 'SupplierTable';
export default SupplierTable;
