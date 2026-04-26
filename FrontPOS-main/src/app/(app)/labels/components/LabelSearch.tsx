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
            <Card className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 shadow-sm rounded-lg" radius="sm">
                <CardBody className="p-3">
                    <div className="flex items-center justify-between mb-2">
                         <label className="text-[9px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest flex items-center gap-2 italic">
                            <Search size={14} className="text-emerald-500" />
                            Buscar Producto
                        </label>
                    </div>
                    <Input
                        placeholder="NOMBRE O CÓDIGO..."
                        value={filter} 
                        onValueChange={onFilterChange}
                        variant="faded"
                        classNames={{ 
                            inputWrapper: "h-12 bg-gray-50 dark:bg-black/40 border-gray-200 dark:border-white/10 rounded-xl shadow-inner group-data-[focus=true]:border-emerald-500/50", 
                            input: "font-black text-sm uppercase italic text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 tracking-tighter" 
                        }}
                    />
                </CardBody>
            </Card>

            {filter && (
                <Card className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 shadow-xl rounded-lg overflow-hidden" radius="sm">
                    <CardBody className="p-2 flex flex-col gap-1 max-h-[500px] overflow-auto custom-scrollbar">
                        {filteredProducts.map(p => (
                            <div 
                                key={p.barcode} 
                                onClick={() => onAddToQueue(p)}
                                className="group p-3 rounded-xl border border-transparent hover:border-emerald-500/30 bg-gray-50/50 dark:bg-white/5 hover:bg-white dark:hover:bg-emerald-500/5 flex justify-between items-center transition-all cursor-pointer"
                            >
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-500 group-hover:scale-110 transition-transform">
                                        <ShoppingBag size={18} />
                                    </div>
                                    <div className="flex flex-col min-w-0">
                                        <span className="text-xs font-black text-gray-900 dark:text-white uppercase italic truncate tracking-tight">
                                            {p.productName}
                                        </span>
                                        <span className="text-[9px] text-gray-400 dark:text-zinc-500 font-black tracking-[0.2em] mt-0.5 uppercase">
                                            ${formatCurrency(p.salePrice)} <span className="text-emerald-500/50 ml-1">#{p.barcode}</span>
                                        </span>
                                    </div>
                                </div>
                                <div className="bg-emerald-500 text-white h-8 w-8 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg shadow-emerald-500/40">
                                    <PlusCircle size={18} />
                                </div>
                            </div>
                        ))}
                        {filteredProducts.length === 0 && (
                            <div className="p-10 text-center flex flex-col items-center gap-2">
                                <Search size={32} className="text-gray-200 dark:text-white/5" />
                                <span className="text-[10px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-widest italic">No se encontraron productos</span>
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
