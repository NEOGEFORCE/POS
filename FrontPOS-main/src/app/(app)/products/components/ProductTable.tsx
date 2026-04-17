"use client";

import React, { memo } from 'react';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Button, Pagination, Chip, Tooltip
} from "@heroui/react";
import { 
  Package, Edit, Trash2, Barcode, Zap, TrendingUp, 
  ChevronUp, ChevronDown, AlertCircle, ShieldCheck
} from 'lucide-react';
import { Product } from '@/lib/definitions';

interface TableProps {
  products: Product[];
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalFiltered: number;
  onEdit: (product: Product) => void;
  onDelete: (barcode: string) => void;
  onQuickUpdate: (barcode: string, amount: number) => void;
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
  onQuickUpdate,
  onPageChange,
  onPageSizeChange,
  formatCOP
}: TableProps) => {
  return (
    <div className="flex-1 bg-white/60 dark:bg-zinc-950/40 backdrop-blur-3xl border border-white/20 dark:border-white/10 rounded-[2.5rem] overflow-hidden flex flex-col min-h-0 shadow-[0_20px_50px_rgba(0,0,0,0.1)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.3)] transition-all mb-6 relative">
      <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-transparent pointer-events-none" />
      
      {/* VISTA TABLET/DESKTOP */}
      <div className="hidden md:block flex-1 overflow-x-auto custom-scrollbar relative z-10">
        <Table 
          isCompact 
          removeWrapper 
          aria-label="Catálogo Maestro de Productos" 
          classNames={{ 
            th: "bg-gray-100/50 dark:bg-zinc-900/50 backdrop-blur-xl text-gray-400 dark:text-zinc-500 font-black uppercase text-[10px] tracking-[0.2em] h-16 py-2 border-b border-gray-200 dark:border-white/5 sticky top-0 z-10 px-8", 
            td: "py-6 font-medium border-b border-gray-100/50 dark:border-white/5 px-8 group-hover:bg-white/40 dark:group-hover:bg-white/5 transition-colors", 
            tr: "transition-all border-l-4 border-transparent hover:border-emerald-500 cursor-pointer group" 
          }}
        >
          <TableHeader>
            <TableColumn>PRODUCTO / IDENTIDAD</TableColumn>
            <TableColumn align="center">CONTROL DE STOCK</TableColumn>
            <TableColumn align="start">ANALÍTICA DE COSTOS</TableColumn>
            <TableColumn align="center">RENTABILIDAD</TableColumn>
            <TableColumn align="end">ACCIONES</TableColumn>
          </TableHeader>
          <TableBody emptyContent={<div className="py-24 text-center font-black uppercase text-zinc-400 tracking-[0.3em] italic">Sin registros en el ledger</div>}>
            {products.map((product) => {
              const isLowStock = !product.isWeighted && product.quantity <= (product.minStock || 5);
              return (
                <TableRow key={product.barcode} className={isLowStock ? "bg-rose-500/5 hover:bg-rose-500/10" : ""}>
                  <TableCell>
                    <div className="flex items-center gap-5">
                      <div className="relative">
                        <div className="h-14 w-14 rounded-2xl bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 flex items-center justify-center text-emerald-500 shrink-0 shadow-lg group-hover:scale-110 group-hover:rotate-3 transition-all overflow-hidden">
                          {product.imageUrl ? (
                            <img src={product.imageUrl} className="h-full w-full object-cover" alt={product.productName} />
                          ) : (
                            <Package size={24} />
                          )}
                        </div>
                        <div className={`absolute -top-1 -right-1 h-4 w-4 rounded-full border-4 border-white dark:border-zinc-950 ${product.isActive !== false ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-black text-gray-900 dark:text-white uppercase leading-tight italic truncate max-w-[250px] group-hover:text-emerald-500 transition-colors tracking-tighter">
                            {product.productName}
                          </span>
                          {product.isWeighted && (
                            <Chip size="sm" variant="flat" color="secondary" className="h-4 text-[8px] font-black uppercase tracking-widest italic rounded-md">Granel</Chip>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1.5">
                          <Barcode size={12} className="text-gray-400 opacity-50" />
                          <span className="text-[10px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest uppercase font-bold">{product.barcode}</span>
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-center gap-2">
                      <div className={`relative flex items-center gap-4 px-6 py-2.5 rounded-2xl border transition-all ${
                        isLowStock
                          ? 'bg-rose-500/10 border-rose-500/40 text-rose-500 shadow-[0_0_20px_rgba(244,63,94,0.4)] animate-pulse'
                          : 'bg-emerald-500/5 border-emerald-500/20 text-emerald-500 shadow-inner group-hover:bg-emerald-500/10'
                      }`}>
                        <div className="flex flex-col items-center min-w-[60px]">
                           <span className="text-[16px] font-black italic tracking-tighter leading-none tabular-nums">
                            {product.quantity}
                          </span>
                          <span className="text-[8px] font-black uppercase tracking-[0.2em] opacity-60 mt-0.5 italic">
                            {product.isWeighted ? 'Kilogramos' : 'Unidades'}
                          </span>
                        </div>
                        
                        <div className="flex flex-col gap-1 border-l border-white/20 pl-4 py-0.5">
                          <Button isIconOnly size="sm" onPress={() => onQuickUpdate(product.barcode, 1)} variant="light" className="h-5 w-5 min-w-unit-5 bg-white/10 hover:bg-emerald-500 hover:text-white rounded-md">
                            <ChevronUp size={12} />
                          </Button>
                          <Button isIconOnly size="sm" onPress={() => onQuickUpdate(product.barcode, -1)} variant="light" className="h-5 w-5 min-w-unit-5 bg-white/10 hover:bg-rose-500 hover:text-white rounded-md">
                            <ChevronDown size={12} />
                          </Button>
                        </div>
                      </div>
                      {isLowStock && (
                        <div className="flex items-center gap-1.5 px-3 py-1 bg-rose-500 text-white rounded-full text-[8px] font-black uppercase tracking-widest shadow-lg shadow-rose-500/30">
                          <AlertCircle size={10} /> Reabastecer <span className="opacity-60 italic">(Mín: {product.minStock || 5})</span>
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-2">
                       <div className="flex items-center justify-between gap-3 bg-gray-50/50 dark:bg-white/5 px-3 py-1.5 rounded-xl border border-gray-100 dark:border-white/5">
                          <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest italic">Costo:</span>
                          <span className="text-[11px] font-black text-gray-700 dark:text-zinc-300 italic tabular-nums">${formatCOP(product.purchasePrice)}</span>
                       </div>
                       <div className="flex items-center justify-between gap-3 bg-emerald-500/10 px-3 py-1.5 rounded-xl border border-emerald-500/20">
                          <span className="text-[9px] font-black text-emerald-500 uppercase tracking-widest italic">Venta:</span>
                          <span className="text-[13px] font-black text-emerald-600 dark:text-emerald-400 italic tabular-nums">${formatCOP(product.salePrice)}</span>
                       </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    <Tooltip content={`Utilidad Neta: $${formatCOP(product.netProfit || (product.salePrice - product.purchasePrice))}`} closeDelay={0}>
                      <div className="inline-flex flex-col items-center p-3 rounded-2xl bg-gradient-to-br from-white to-gray-50 dark:from-zinc-900 dark:to-zinc-950 border border-gray-200 dark:border-white/10 shadow-sm relative group/margin">
                        <div className="flex items-center gap-2 mb-1">
                          <TrendingUp size={12} className="text-emerald-500" />
                          <span className="text-[13px] font-black text-gray-900 dark:text-white italic tabular-nums">{product.marginPercentage}%</span>
                        </div>
                        <div className="h-1 w-10 bg-gray-200 dark:bg-white/5 rounded-full overflow-hidden">
                          <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.min(product.marginPercentage, 100)}%` }} />
                        </div>
                        <span className="text-[8px] font-black text-emerald-500/60 uppercase tracking-widest mt-2 italic">ROI</span>
                      </div>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-3">
                      <Button 
                        isIconOnly 
                        className="h-12 w-12 bg-white dark:bg-zinc-900 text-emerald-500 rounded-2xl hover:bg-emerald-500 hover:text-white border border-gray-200 dark:border-white/10 shadow-sm transition-all hover:scale-110 active:scale-95 group" 
                        onPress={() => onEdit(product)}
                      >
                        <Edit size={18} className="group-hover:rotate-12 transition-transform" />
                      </Button>
                      <Button 
                        isIconOnly 
                        className="h-12 w-12 bg-white dark:bg-zinc-900 text-rose-500 rounded-2xl hover:bg-rose-500 hover:text-white border border-gray-200 dark:border-white/10 shadow-sm transition-all hover:scale-110 active:scale-95 group" 
                        onPress={() => onDelete(product.barcode)}
                      >
                        <Trash2 size={18} className="group-hover:-rotate-12 transition-transform" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* VISTA MÓVIL (CARDS) */}
      <div className="md:hidden flex-1 p-4 flex flex-col gap-4 bg-gray-50/50 dark:bg-black/20 z-10 relative overflow-y-auto">
        {products.map((product) => {
          const isLowStock = !product.isWeighted && product.quantity <= (product.minStock || 5);
          return (
            <div 
              key={product.barcode}
              className={`bg-white dark:bg-zinc-900 p-5 rounded-[2rem] border border-gray-200 dark:border-white/5 shadow-lg flex flex-col gap-4 active:scale-[0.98] transition-transform relative overflow-hidden ${isLowStock ? "border-rose-500/30" : ""}`}
            >
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 rounded-2xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center shrink-0 overflow-hidden border border-emerald-500/20">
                  {product.imageUrl ? (
                    <img src={product.imageUrl} className="h-full w-full object-cover" alt={product.productName} />
                  ) : (
                    <Package size={24} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-black text-gray-900 dark:text-white uppercase leading-none truncate italic tracking-tighter">{product.productName}</h3>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-[10px] text-gray-400 font-mono tracking-widest font-bold">{product.barcode}</span>
                  </div>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-3 p-3 bg-gray-50 dark:bg-zinc-800/50 rounded-2xl border border-gray-100 dark:border-white/5">
                <div className="flex flex-col">
                  <span className="text-[8px] font-black text-gray-400 uppercase tracking-widest italic">Stock Disp.</span>
                  <span className={`text-lg font-black italic tabular-nums ${isLowStock ? 'text-rose-500' : 'text-gray-900 dark:text-white'}`}>
                    {product.quantity} <span className="text-[10px] opacity-60">{product.isWeighted ? 'KG' : 'UND'}</span>
                  </span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-[8px] font-black text-emerald-500 uppercase tracking-widest italic text-right">Precio Venta</span>
                  <span className="text-lg font-black text-emerald-500 italic tabular-nums">${formatCOP(product.salePrice)}</span>
                </div>
              </div>

              <div className="flex gap-3">
                <Button 
                  fullWidth 
                  className="h-12 bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white font-black text-[10px] uppercase tracking-widest rounded-xl transition-all active:scale-95 italic"
                  onPress={() => onEdit(product)}
                >
                  <Edit size={16} className="mr-2" /> AJUSTAR
                </Button>
                <Button 
                  fullWidth 
                  className="h-12 bg-rose-500 text-white font-black text-[10px] uppercase tracking-widest rounded-xl shadow-lg shadow-rose-500/20 transition-all active:scale-95 italic"
                  onPress={() => onDelete(product.barcode)}
                >
                  <Trash2 size={16} className="mr-2" /> BAJA
                </Button>
              </div>
            </div>
          );
        })}
        {products.length === 0 && <div className="py-20 text-center text-xs font-black text-gray-400 uppercase tracking-[0.3em] italic">Sin activos en el ledger</div>}
      </div>

       <div className="px-10 py-6 flex flex-col md:flex-row items-center justify-between border-t border-gray-100 dark:border-white/5 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-2xl shrink-0 gap-6 z-20">
        <div className="flex items-center gap-5">
          <div className="h-12 w-12 rounded-2xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center shadow-inner">
            <ShieldCheck size={24} />
          </div>
          <div className="flex flex-col">
            <p className="text-[11px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.3em] leading-none mb-1.5">
              LEDGER: <span className="text-gray-900 dark:text-white italic">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, totalFiltered)}</span> de {totalFiltered}
            </p>
            <span className="text-[9px] font-black text-emerald-500 uppercase tracking-widest italic opacity-70">Auditoría de Patrimonio Activa</span>
          </div>
        </div>
        
        <div className="flex flex-col md:flex-row items-center gap-8 w-full md:w-auto">
          <div className="flex items-center gap-4 bg-gray-100/50 dark:bg-white/5 p-1.5 rounded-2xl border border-gray-200 dark:border-white/5">
             <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest italic ml-4">FILAS</label>
             <select 
              value={pageSize} 
              onChange={(e) => onPageSizeChange(Number(e.target.value))} 
              className="h-10 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white text-[11px] font-black uppercase tracking-widest px-4 outline-none rounded-xl border border-gray-200 dark:border-white/10 cursor-pointer hover:border-emerald-500 shadow-sm transition-all"
            >
              {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n} REGISTROS</option>)}
            </select>
          </div>
          
          <Pagination
            isCompact
            showControls
            total={totalPages}
            page={currentPage}
            onChange={onPageChange}
            classNames={{
              wrapper: "gap-2",
              item: "bg-white dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 font-black text-[11px] uppercase rounded-xl border border-gray-200 dark:border-white/5 hover:border-emerald-500/50 hover:bg-emerald-500/5 min-w-[40px] h-11 transition-all",
              cursor: "bg-emerald-500 text-white font-black shadow-lg shadow-emerald-500/20",
              prev: "bg-white dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 rounded-xl border border-gray-200 dark:border-white/5 min-w-[40px] h-11 hover:border-emerald-500/50 transition-all",
              next: "bg-white dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 rounded-xl border border-gray-200 dark:border-white/5 min-w-[40px] h-11 hover:border-emerald-500/50 transition-all"
            }}
          />
        </div>
      </div>
    </div>
  );
});

ProductTable.displayName = 'ProductTable';
export default ProductTable;
