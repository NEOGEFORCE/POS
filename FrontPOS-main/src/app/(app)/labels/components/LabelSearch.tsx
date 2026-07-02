"use client";

import React, { memo } from 'react';
import { Input, Button, Card, CardBody } from "@heroui/react";
import { Search, PlusCircle, ShoppingBag } from 'lucide-react';
import { Product } from '@/lib/definitions';
import { formatCurrency } from '@/lib/utils';

interface SearchProps {
    filter: string;
    onFilterChange: (value: string) => void;
    filteredProducts: Product[];
    onAddToQueue: (product: Product) => void;
}

const LabelSearch = memo(({ filter, onFilterChange, filteredProducts, onAddToQueue }: SearchProps) => {
    return (
        <div className="flex flex-col gap-1 w-full">
            <Card className="card-base border-none shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl" radius="sm">
                <CardBody className="p-3">
                    <div className="flex items-center justify-between mb-2">
                         <label className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest flex items-center gap-2 tracking-tight">
                            <Search size={14} className="text-zinc-900 dark:text-zinc-100" />
                            Buscar Producto
                        </label>
                    </div>
                    <Input
                        placeholder="NOMBRE O CODIGO..."
                        value={filter} 
                        onValueChange={onFilterChange}
                        variant="faded"
                        classNames={{ 
                            inputWrapper: "h-12 bg-gray-50 dark:bg-[#18181b] border-gray-200 dark:border-white/10 rounded-2xl shadow-inner group-data-[focus=true]:border-emerald-500/50", 
                            input: "font-medium text-sm uppercase tracking-tight text-zinc-900 dark:text-zinc-50 placeholder:text-gray-400 dark:placeholder:text-zinc-600 tracking-tighter" 
                        }}
                    />
                </CardBody>
            </Card>

            {filter && (
                <Card className="card-base border-none shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl overflow-hidden" radius="sm">
                    <CardBody className="p-2 flex flex-col gap-1 max-h-[500px] overflow-auto custom-scrollbar">
                        {filteredProducts.map(p => (
                            <div 
                                key={p.barcode} 
                                onClick={() => onAddToQueue(p)}
                                className="group p-3 rounded-2xl border border-transparent hover:border-emerald-500/30 bg-gray-50/50 dark:bg-[#18181b] hover:bg-white dark:hover:bg-white/5 dark:bg-transparent border border-zinc-200 dark:border-white/5 flex justify-between items-center transition-all cursor-pointer"
                            >
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className="h-10 w-10 rounded-2xl bg-black/5 dark:bg-white/5 flex items-center justify-center text-zinc-900 dark:text-zinc-100 group-hover:scale-110 transition-transform">
                                        <ShoppingBag size={18} />
                                    </div>
                                    <div className="flex flex-col min-w-0">
                                        <span className="text-xs font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight truncate tracking-tight">
                                            {p.productName}
                                        </span>
                                        <span className="text-[9px] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 font-medium tracking-[0.2em] mt-0.5 uppercase">
                                            ${formatCurrency(p.salePrice)} <span className="text-zinc-900 dark:text-zinc-100/50 ml-1">#{p.barcode}</span>
                                        </span>
                                    </div>
                                </div>
                                <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white h-8 w-8 rounded-2xl flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-emerald-500/40">
                                    <PlusCircle size={18} />
                                </div>
                            </div>
                        ))}
                        {filteredProducts.length === 0 && (
                            <div className="p-10 text-center flex flex-col items-center gap-2">
                                <Search size={32} className="text-gray-200 dark:text-white/5" />
                                <span className="text-[10px] font-medium text-gray-400 dark:text-zinc-600 uppercase tracking-widest tracking-tight">No se encontraron productos</span>
                            </div>
                        )}
                    </CardBody>
                </Card>
            )}
        </div>
    );
});

LabelSearch.displayName = 'LabelSearch';

export default LabelSearch;
