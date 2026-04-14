"use client";

import React, { memo } from 'react';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Button, Pagination, Chip
} from "@heroui/react";
import { Package, Edit, Trash2, Barcode, Shapes, Zap } from 'lucide-react';
import { Product } from '@/lib/definitions';

interface TableProps {
  products: Product[];
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalFiltered: number;
  onEdit: (product: Product) => void;
  onDelete: (barcode: string) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  formatCOP: (val: number | string) => string;
}

const ProductTable = memo(({
  products,
  currentPage,
  totalPages,
  pageSize,
  totalFiltered,
  onEdit,
  onDelete,
  onPageChange,
  onPageSizeChange,
  formatCOP
}: TableProps) => {
  return (
    <div className="flex-1 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col min-h-0 shadow-sm transition-all focus-within:border-emerald-500/30">
      {/* VISTA TABLET/DESKTOP */}
      <div className="hidden md:block flex-1 overflow-x-auto custom-scrollbar">
        <Table 
          isCompact 
          removeWrapper 
          aria-label="Catálogo Maestro de Productos" 
          classNames={{ 
            th: "bg-gray-50 dark:bg-zinc-950 text-gray-400 dark:text-zinc-500 font-black uppercase text-[9px] tracking-widest h-12 py-1 border-b border-gray-200 dark:border-white/5 sticky top-0 z-10 px-4", 
            td: "py-3 font-medium border-b border-gray-100 dark:border-white/5 px-4", 
            tr: "hover:bg-emerald-500/5 transition-all border-l-4 border-transparent hover:border-emerald-500 active:bg-emerald-500/10 group cursor-pointer" 
          }}
        >
          <TableHeader>
            <TableColumn>REFERENCIA / NOMBRE</TableColumn>
            <TableColumn align="center">STOCK</TableColumn>
            <TableColumn align="start">PRECIOS</TableColumn>
            <TableColumn align="center">MARGEN</TableColumn>
            <TableColumn align="end">ACCIONES</TableColumn>
          </TableHeader>
          <TableBody emptyContent={<div className="py-24 text-center font-black uppercase text-zinc-400 tracking-[0.3em] italic">Catálogo vacío</div>}>
            {products.map((product) => (
              <TableRow key={product.barcode}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-xl bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-white/5 flex items-center justify-center text-emerald-500 shrink-0 shadow-inner group-hover:scale-110 transition-transform overflow-hidden">
                      {product.imageUrl ? (
                        <img src={product.imageUrl} className="h-full w-full object-cover" alt={product.productName} />
                      ) : (
                        <Package size={16} />
                      )}
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="text-[12px] font-black text-gray-900 dark:text-white uppercase leading-tight italic truncate group-hover:text-emerald-500 transition-colors">
                        {product.productName}
                      </span>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Barcode size={8} className="text-gray-400" />
                        <span className="text-[8px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest uppercase">{product.barcode}</span>
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-center">
                  <div className={`inline-flex flex-col items-center px-3 py-1 rounded-lg border tabular-nums transition-all ${
                    product.quantity <= 5 && !product.isWeighted
                      ? 'bg-rose-500/10 border-rose-500/30 text-rose-500 scale-105'
                      : 'bg-gray-50 dark:bg-zinc-800 border-gray-100 dark:border-white/5 text-gray-900 dark:text-white'
                  }`}>
                    <span className="text-[11px] font-black italic tracking-tighter leading-tight">
                      {product.quantity} {product.isWeighted ? 'KG' : 'UND'}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5">
                       <span className="text-[8px] font-black text-gray-400 uppercase tracking-widest w-9 italic">C:</span>
                       <span className="text-[10px] font-black text-gray-600 dark:text-zinc-400 italic tabular-nums">${formatCOP(product.purchasePrice)}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                       <span className="text-[8px] font-black text-emerald-500 uppercase tracking-widest w-9 italic">V:</span>
                       <span className="text-[12px] font-black text-gray-900 dark:text-white italic tabular-nums">${formatCOP(product.salePrice)}</span>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-center">
                   <div className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                     <Zap size={8} />
                     <span className="text-[9px] font-black italic tabular-nums">{product.marginPercentage}%</span>
                   </div>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1.5">
                    <Button 
                      isIconOnly 
                      size="sm" 
                      variant="flat" 
                      className="h-8 w-8 bg-gray-50 dark:bg-zinc-800 text-emerald-500 rounded-lg hover:bg-emerald-500 hover:text-white border border-gray-200 dark:border-white/5 shadow-sm transition-all" 
                      onPress={() => onEdit(product)}
                    >
                      <Edit size={14} />
                    </Button>
                    <Button 
                      isIconOnly 
                      size="sm" 
                      variant="flat" 
                      className="h-8 w-8 bg-gray-50 dark:bg-zinc-800 text-rose-500 rounded-lg hover:bg-rose-500 hover:text-white border border-gray-200 dark:border-white/5 shadow-sm transition-all" 
                      onPress={() => onDelete(product.barcode)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* VISTA MÓVIL (CARDS) */}
      <div className="md:hidden flex-1 p-2 flex flex-col gap-2 bg-gray-50/50 dark:bg-black/20">
        {products.map((product) => (
          <div 
            key={product.barcode}
            className="bg-white dark:bg-zinc-900 p-3 rounded-xl border border-gray-200 dark:border-white/5 shadow-sm flex flex-col gap-3 active:scale-[0.98] transition-transform"
          >
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center shrink-0 overflow-hidden">
                {product.imageUrl ? (
                  <img src={product.imageUrl} className="h-full w-full object-cover" alt={product.productName} />
                ) : (
                  <Package size={18} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[11px] font-black text-gray-900 dark:text-white uppercase leading-none truncate italic">{product.productName}</h3>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-[8px] text-gray-400 font-mono tracking-widest">{product.barcode}</span>
                  <div className="h-1 w-1 bg-gray-300 rounded-full" />
                  <span className={`text-[8px] font-black uppercase tracking-widest ${product.quantity <= 5 && !product.isWeighted ? 'text-rose-500' : 'text-emerald-500'}`}>
                    Stock: {product.quantity}
                  </span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[11px] font-black text-gray-900 dark:text-white italic tabular-nums">${formatCOP(product.salePrice)}</div>
                <div className="text-[7px] font-black text-emerald-500 uppercase tracking-widest mt-0.5">Margen {product.marginPercentage}%</div>
              </div>
            </div>
            
            <div className="flex gap-2 pt-2 border-t border-gray-100 dark:border-white/5">
              <Button 
                fullWidth 
                size="sm" 
                variant="flat" 
                className="h-8 bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-white font-black text-[9px] uppercase tracking-widest rounded-lg"
                onPress={() => onEdit(product)}
              >
                <Edit size={12} className="mr-1" /> Editar
              </Button>
              <Button 
                fullWidth 
                size="sm" 
                variant="flat" 
                className="h-8 bg-rose-500/10 text-rose-500 font-black text-[9px] uppercase tracking-widest rounded-lg"
                onPress={() => onDelete(product.barcode)}
              >
                <Trash2 size={12} className="mr-1" /> Eliminar
              </Button>
            </div>
          </div>
        ))}
        {products.length === 0 && <div className="py-10 text-center text-[9px] font-black text-gray-400 uppercase tracking-widest italic">Sin productos en esta vista</div>}
      </div>

       <div className="px-8 py-4 flex items-center justify-between border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900 shrink-0 min-h-[70px]">
        <div className="flex flex-col">
          <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] leading-none mb-1">
            EXHIBICIÓN: <span className="text-gray-900 dark:text-white italic">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, totalFiltered)}</span>
          </p>
          <span className="text-[8px] font-bold text-emerald-500/60 uppercase tracking-widest italic">Inventario en tiempo real</span>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
             <label className="text-[9px] font-black text-gray-400 uppercase tracking-widest italic">Mostrar</label>
             <select 
              value={pageSize} 
              onChange={(e) => onPageSizeChange(Number(e.target.value))} 
              className="h-9 bg-white dark:bg-zinc-800 text-gray-900 dark:text-white text-[10px] font-black uppercase tracking-widest px-3 outline-none rounded-xl border border-gray-200 dark:border-white/10 cursor-pointer hover:border-emerald-500/50 transition-colors shadow-sm"
            >
              {[10, 20, 50, 100].map(n => <option key={n} value={n}>{n} FILAS</option>)}
            </select>
          </div>
          
          <Pagination
            isCompact
            showControls
            total={totalPages}
            page={currentPage}
            onChange={onPageChange}
            classNames={{
              wrapper: "gap-1",
              item: "bg-white dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 font-black text-[10px] uppercase rounded-xl border border-gray-200 dark:border-white/5 hover:border-emerald-500/50 hover:bg-emerald-500/5 min-w-[36px] h-9",
              cursor: "bg-gray-900 dark:bg-white text-white dark:text-black font-black",
              prev: "bg-white dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 rounded-xl border border-gray-200 dark:border-white/5 min-w-[36px] h-9 hover:border-emerald-500/50",
              next: "bg-white dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 rounded-xl border border-gray-200 dark:border-white/5 min-w-[36px] h-9 hover:border-emerald-500/50"
            }}
          />
        </div>
      </div>
    </div>
  );
});

ProductTable.displayName = 'ProductTable';
export default ProductTable;
