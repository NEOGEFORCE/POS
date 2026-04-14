"use client";

import React, { memo } from 'react';
import { Input, Button } from "@heroui/react";
import { Search, PlusCircle } from 'lucide-react';
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
        <div className="w-full md:w-1/3 flex flex-col gap-2">
            <div className="bg-white dark:bg-zinc-900 p-4 border border-gray-200 dark:border-white/5 rounded-2xl shadow-sm flex flex-col transition-colors">
                <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mb-2 flex items-center gap-2">
                    <Search size={12} /> Buscar Producto
                </label>
                <Input
                    placeholder="NOMBRE O CÓDIGO..."
                    value={filter} 
                    onValueChange={onFilterChange}
                    classNames={{ 
                        inputWrapper: "h-12 bg-transparent border border-gray-200 dark:border-white/10 rounded-xl shadow-none focus-within:border-emerald-500/50", 
                        input: "font-black text-xs uppercase italic text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600" 
                    }}
                />
            </div>

            {filter && (
                <div className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl shadow-sm overflow-hidden flex flex-col transition-colors max-h-[400px] overflow-auto custom-scrollbar">
                    {filteredProducts.map(p => (
                        <div key={p.barcode} className="p-3 border-b border-gray-100 dark:border-white/5 flex justify-between items-center hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                            <div className="flex flex-col min-w-0">
                                <span className="text-xs font-black text-gray-900 dark:text-white uppercase italic truncate">
                                    {p.productName}
                                </span>
                                <span className="text-[9px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest mt-0.5">
                                    ${formatCurrency(p.salePrice)}
                                </span>
                            </div>
                            <Button 
                                isIconOnly 
                                size="sm" 
                                className="bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 min-w-8 rounded-lg" 
                                onPress={() => onAddToQueue(p)}
                            >
                                <PlusCircle size={16} />
                            </Button>
                        </div>
                    ))}
                    {filteredProducts.length === 0 && (
                        <div className="p-6 text-center text-[10px] font-bold text-gray-400 dark:text-zinc-600 uppercase tracking-widest">
                            No hay resultados
                        </div>
                    )}
                </div>
            )}
        </div>
    );
});

LabelSearch.displayName = 'LabelSearch';

export default LabelSearch;
