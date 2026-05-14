"use client";

import React, { useRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Scale, Package } from 'lucide-react';
import { isProductWeighted, getStockStatus } from '@/lib/utils';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Product } from '@/lib/definitions';

interface ProductGridProps {
    products: Product[];
    addToCart: (product: Product) => void;
}

// COMPONENTE MEMOIZADO: Solo se re-renderiza si el producto cambia
const ProductItem = React.memo(({ product, onAdd }: { product: Product, onAdd: (p: Product) => void }) => {
    return (
        <motion.button
            whileTap={{ scale: 0.94 }}
            whileHover={{ y: -2 }}
            className="group flex flex-col bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 p-2 rounded-lg text-left h-[84px] hover:bg-emerald-50 dark:hover:bg-emerald-500/10 hover:border-emerald-300 transition-all shadow-sm overflow-hidden"
            onClick={(e) => {
                e.currentTarget.blur();
                onAdd(product);
            }}
        >
            <div className="flex justify-between items-start w-full shrink-0">
                <div className={`h-5 w-5 rounded flex items-center justify-center transition-colors ${isProductWeighted(product) ? 'bg-amber-100 text-amber-600' : 'bg-gray-100 text-gray-600 group-hover:bg-emerald-500 group-hover:text-white'}`}>
                    {isProductWeighted(product) ? <Scale className="h-3 w-3" /> : <Package className="h-3 w-3" />}
                </div>
                <div className="flex flex-col items-end leading-none">
                    <span className={`text-[8px] font-black px-1 rounded ${
                        getStockStatus(product.quantity, product.minStock || 0) === 'CRITICAL' ? 'bg-rose-500 text-white animate-pulse' :
                        getStockStatus(product.quantity, product.minStock || 0) === 'REORDER' ? 'bg-amber-400 text-black' :
                        'text-gray-400'
                    }`}>
                        STK:{product.quantity}
                    </span>
                    {product.minStock && product.minStock > 0 && (
                        <span className="text-[6px] text-gray-300 font-bold uppercase tracking-tighter">Meta:{product.minStock}</span>
                    )}
                </div>
            </div>
            <span className="font-black text-[8px] leading-[1.3] text-gray-800 dark:text-zinc-200 uppercase line-clamp-2 w-full mt-1 break-words" title={product.productName}>
                {product.productName}
            </span>
            <span className="font-black text-emerald-600 dark:text-emerald-500 text-[11px] tabular-nums mt-auto w-full text-right leading-none">
                ${Number(product.salePrice).toLocaleString()}
            </span>
        </motion.button>
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
    const rowCount = Math.ceil((products?.length || 0) / columns);

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
            {(!products || products.length === 0) && (
                <div className="py-20 text-center text-default-400 italic text-sm">
                    No se encontraron productos en esta categoría.
                </div>
            )}
        </div>
    );
}
