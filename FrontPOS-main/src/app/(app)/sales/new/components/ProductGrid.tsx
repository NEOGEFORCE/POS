"use client";

import React, { useRef, useMemo, memo } from 'react';
import { motion } from 'framer-motion';
import { Scale, Package } from 'lucide-react';
import { isProductWeighted, calculateStockHealth } from '@/lib/utils';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Product } from '@/lib/definitions';

interface ProductGridProps {
    products: Product[];
    addToCart: (product: Product) => void;
}

// ProductItem aislado y memoizado: solo se re-renderiza si cambia el
// producto o el callback. El callback addToCart del padre debe estar
// envuelto en useCallback para que la memo sea efectiva (verificado en
// useNewSale.ts:677).
const ProductItem = memo(({ product, onAdd }: { product: Product, onAdd: (p: Product) => void }) => {
    return (
        <motion.button
            whileTap={{ scale: 0.97 }}
            className="group flex flex-col bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/[0.06] rounded-xl p-3 text-left h-[90px] shadow-sm hover:shadow-md hover:bg-gray-50 dark:hover:bg-zinc-800 hover:border-emerald-500/30 dark:hover:border-white/[0.12] transition-all duration-150 overflow-hidden cursor-pointer"
            onClick={(e) => {
                e.currentTarget.blur();
                onAdd(product);
            }}
        >
            <div className="flex justify-between items-start w-full shrink-0">
                <div className="h-5 w-5 rounded flex items-center justify-center bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-white/8 text-gray-500 dark:text-zinc-500 dark:text-zinc-400 shrink-0">
                    {isProductWeighted(product) ? <Scale className="h-3 w-3" /> : <Package className="h-3 w-3" />}
                </div>
                <div className="flex flex-col items-end leading-none">
                    <span className={`text-[10px] font-medium rounded px-1.5 py-0.5 ${
                        calculateStockHealth(product.quantity, product.minStock || 0) === 'CRITICAL' ? 'text-red-500/80 bg-red-500/10' :
                        calculateStockHealth(product.quantity, product.minStock || 0) === 'WARNING' ? 'text-amber-500/80 bg-amber-500/10' :
                        'text-gray-500 dark:text-zinc-500 bg-zinc-100 dark:bg-zinc-800'
                    }`}>
                        STK:{product.quantity}
                    </span>
                </div>
            </div>
            <div className="flex-1 w-full mt-1.5 overflow-hidden flex items-start">
                <span className="text-[10px] uppercase font-bold text-zinc-800 dark:text-zinc-300 leading-tight line-clamp-2 break-words w-full" title={product.productName}>
                    {product.productName}
                </span>
            </div>
            <span className="text-sm font-bold text-zinc-900 dark:text-zinc-50 tabular-nums font-['DM_Mono'] w-full text-right mt-auto">
                ${Number(product.salePrice).toLocaleString()}
            </span>
        </motion.button>
    );
}, (prev, next) => {
    // Comparador shallow estable: solo re-renderiza si cambio este producto
    // especifico (precio, stock, nombre) o el callback. Ignora cambios del
    // resto del catalogo o del carrito en el padre.
    return (
        prev.onAdd === next.onAdd &&
        prev.product.barcode === next.product.barcode &&
        prev.product.productName === next.product.productName &&
        prev.product.salePrice === next.product.salePrice &&
        prev.product.quantity === next.product.quantity &&
        prev.product.minStock === next.product.minStock
    );
});

ProductItem.displayName = 'ProductItem';

function ProductGridBase({ products, addToCart }: ProductGridProps) {
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
            className="flex-1 overflow-y-auto custom-scrollbar p-1.5 min-h-0 [scrollbar-gutter:stable]"
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
                <div className="py-20 text-center text-default-400 tracking-tight text-sm">
                    No se encontraron productos en esta categoria.
                </div>
            )}
        </div>
    );
}

// Export memoizado: el ProductGrid solo re-renderiza si cambia la lista de
// productos (referencia) o la funcion addToCart (envuelta en useCallback).
// Cambios en el carrito, searchQuery o cualquier otro state del padre no
// afectan este componente — el filtrado real ocurre en un Web Worker
// (useNewSale.ts) que actualiza `filteredProductsGrid` solo cuando cambia
// el resultado.
const ProductGrid = memo(ProductGridBase);
ProductGrid.displayName = 'ProductGrid';
export default ProductGrid;
