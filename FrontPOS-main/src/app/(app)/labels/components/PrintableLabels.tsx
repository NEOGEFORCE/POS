"use client";

import React, { memo } from 'react';
import { Product } from '@/lib/definitions';
import { formatCurrency } from '@/lib/utils';
import { Barcode } from 'lucide-react';

interface PrintItem {
    product: Product;
    quantity: number;
}

interface PrintProps {
    printQueue: PrintItem[];
}

const PrintableLabels = memo(({ printQueue }: PrintProps) => {
    return (
        <div className="hidden print:grid grid-cols-2 gap-x-4 gap-y-6 pt-4 bg-white w-full max-w-full justify-items-center">
            {printQueue.flatMap(item =>
                Array(item.quantity).fill(0).map((_, i) => (
                    <div
                        key={`${item.product.barcode}-${i}`}
                        className="w-[9.5cm] h-[5.5cm] border-4 border-black flex flex-col items-center justify-between p-2 bg-white text-black break-inside-avoid relative box-border"
                    >
                        {/* Nombre del Producto (Arriba) */}
                        <div className="w-full text-center flex-1 flex items-center justify-center border-b-2 border-black/20 pb-1">
                            <h1 className="text-[14px] font-black uppercase text-center leading-tight line-clamp-2 text-black">
                                {item.product.productName}
                            </h1>
                        </div>

                        {/* Harga Gigante (Centro) */}
                        <div className="flex items-start justify-center flex-none py-2 w-full">
                            <span className="text-3xl font-black mt-1 mr-1 text-black">$</span>
                            <span 
                                className="text-6xl font-black tracking-tighter leading-none text-black" 
                                style={{ fontSize: String(item.product.salePrice).length > 5 ? '3.5rem' : '4rem' }}
                            >
                                {formatCurrency(item.product.salePrice)}
                            </span>
                        </div>

                        {/* Código y detalles (Abajo) */}
                        <div className="w-full flex items-end justify-between pt-1 border-t-2 border-black/20">
                            <div className="flex items-center gap-1">
                                <Barcode size={12} className="text-black" />
                                <span className="text-[10px] font-black tracking-widest font-mono text-black">{item.product.barcode}</span>
                            </div>
                            <span className="text-[8px] font-bold tracking-widest uppercase text-black">PVP</span>
                        </div>
                    </div>
                ))
            )}
        </div>
    );
});

PrintableLabels.displayName = 'PrintableLabels';

export default PrintableLabels;
