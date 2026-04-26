"use client";

import React, { useRef, useMemo } from 'react';
import { Scale, Package } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Product } from '@/lib/definitions';

interface ProductGridProps {
    products: Product[];
    addToCart: (product: Product) => void;
}

// COMPONENTE MEMOIZADO: Solo se re-renderiza si el producto cambia
const ProductItem = React.memo(({ product, onAdd }: { product: Product, onAdd: (p: Product) => void }) => {
    return (
        <button 
            className="group flex flex-col bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 p-2 rounded-lg text-left h-[80px] hover:bg-emerald-50 dark:hover:bg-emerald-500/10 hover:border-emerald-300 transition-all active:scale-95 shadow-sm overflow-hidden" 
            onClick={() => onAdd(product)}
        >
            <div className="flex justify-between items-start w-full mb-1">
                <div className={`h-5 w-5 rounded flex items-center justify-center transition-colors ${product.isWeighted ? 'bg-amber-100 text-amber-600' : 'bg-gray-100 text-gray-600 group-hover:bg-emerald-500 group-hover:text-white'}`}>
                    {product.isWeighted ? <Scale className="h-3 w-3" /> : <Package className="h-3 w-3" />}
                </div>
                <span className="text-[8px] font-bold text-gray-400">STK:{product.quantity}</span>
            </div>
            <span className="font-bold text-[9px] text-gray-700 dark:text-zinc-300 uppercase line-clamp-2 leading-tight flex-1">{product.productName}</span>
            <div className="mt-auto w-full text-right">
                <span className="font-black text-emerald-600 dark:text-emerald-500 text-xs tabular-nums">${Number(product.salePrice).toLocaleString()}</span>
            </div>
        </button>
    );
}, (prev, next) => {
    // Comparación profunda para evitar re-renders si solo cambia la referencia del objeto pero no su contenido vital
    return prev.product.barcode === next.product.barcode && 
           prev.product.quantity === next.product.quantity &&
           prev.product.salePrice === next.product.salePrice;
});

ProductItem.displayName = 'ProductItem';

export default function ProductGrid({ products, addToCart }: ProductGridProps) {
    const parentRef = useRef<HTMLDivElement>(null);
    const columns = 10;
    const rowCount = Math.ceil(products.length / columns);

    const rowVirtualizer = useVirtualizer({
        count: rowCount,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 90,
        overscan: 5,
    });

    return (
        <div 
            ref={parentRef}
            className="flex-1 overflow-y-auto custom-scrollbar p-1.5 min-h-[200px] [scrollbar-gutter:stable]"
        >
            <div
                style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                }}
            >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const startIdx = virtualRow.index * columns;
                    const rowProducts = products.slice(startIdx, startIdx + columns);

                    return (
                        <div
                            key={virtualRow.key}
                            className="absolute top-0 left-0 w-full grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-1.5"
                            style={{
                                height: `${virtualRow.size}px`,
                                transform: `translateY(${virtualRow.start}px)`,
                            }}
                        >
                            {rowProducts.map((p) => (
                                <ProductItem 
                                    key={p.barcode || Math.random().toString()} 
                                    product={p} 
                                    onAdd={addToCart} 
                                />
                            ))}
                        </div>
                    );
                })}
            </div>
            {products.length === 0 && (
                <div className="py-20 text-center text-default-400 italic text-sm">
                    No se encontraron productos en esta categoría.
                </div>
            )}
        </div>
    );
}
