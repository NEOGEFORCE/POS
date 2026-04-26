"use client";

import React, { memo } from 'react';
import { Product } from '@/lib/definitions';
import { formatCurrency } from '@/lib/utils';
import { Scissors } from 'lucide-react';

interface PrintItem {
    product: Product;
    quantity: number;
}

interface PrintProps {
    printQueue: PrintItem[];
}

const PrintableLabels = memo(({ printQueue }: PrintProps) => {
    return (
        <div className="hidden print:block w-full bg-white">
            {/* Indicador de Línea de Corte (Solo Informativo) */}
            <div className="flex items-center gap-2 mb-4 opacity-30 border-b border-dashed border-black pb-2">
                <Scissors size={14} className="text-black" />
                <span className="text-[10px] font-black uppercase tracking-widest text-black italic">Formato de Impresión Central - Corte por las líneas continuas</span>
            </div>

            <div className="grid grid-cols-2 gap-x-2 gap-y-2 justify-items-center">
                {printQueue.flatMap(item =>
                    Array(item.quantity).fill(0).map((_, i) => (
                        <div
                            key={`${item.product.barcode}-${i}`}
                            className="w-[9.8cm] h-[5.8cm] border-[5px] border-black flex flex-col bg-white text-black break-inside-avoid relative box-border overflow-hidden"
                        >
                            {/* Franja Superior de Marca/Categoría */}
                            <div className="bg-black text-white p-2 flex justify-between items-center">
                                <span className="text-[8px] font-black tracking-[0.4em] uppercase italic">AUTENTICIDAD GARANTIZADA</span>
                                <span className="text-[8px] font-black tracking-widest uppercase">#{item.product.barcode.slice(-6)}</span>
                            </div>

                            <div className="flex-1 flex flex-col p-3 justify-between">
                                {/* Nombre del Producto */}
                                <div className="border-b-2 border-black/10 pb-2">
                                    <h1 className="text-[18px] font-extrabold uppercase leading-[1.1] line-clamp-2 italic tracking-tighter text-black">
                                        {item.product.productName}
                                    </h1>
                                </div>

                                {/* Precio Protagonista */}
                                <div className="flex items-baseline justify-center py-1">
                                    <span className="text-2xl font-black mr-1 mt-auto text-black italic">$</span>
                                    <span 
                                        className="text-7xl font-black tracking-tighter leading-none text-black italic" 
                                        style={{ fontSize: String(formatCurrency(item.product.salePrice)).length > 6 ? '3.8rem' : '5rem' }}
                                    >
                                        {formatCurrency(item.product.salePrice)}
                                    </span>
                                </div>

                                {/* Footer con Código de Barras Visual */}
                                <div className="flex items-end justify-between pt-2 border-t-4 border-black border-double">
                                    <div className="flex flex-col">
                                        <span className="text-[7px] font-black text-black/40 uppercase tracking-widest leading-none mb-1">CÓDIGO DE ACCESO</span>
                                        <span className="text-[12px] font-black tracking-[0.3em] font-mono text-black leading-none">{item.product.barcode}</span>
                                    </div>
                                    <div className="flex flex-col items-end">
                                        <span className="text-[20px] font-black italic tracking-tighter leading-none text-black">PVP.</span>
                                        <span className="text-[6px] font-black uppercase text-black/40">IVA INCLUIDO</span>
                                    </div>
                                </div>
                            </div>

                            {/* Decoración Circular de Seguridad */}
                            <div className="absolute top-1/2 left-0 w-4 h-8 bg-black rounded-r-full -translate-y-1/2 opacity-10" />
                            <div className="absolute top-1/2 right-0 w-4 h-8 bg-black rounded-l-full -translate-y-1/2 opacity-10" />
                        </div>
                    ))
                )}
            </div>
        </div>
    );
});

PrintableLabels.displayName = 'PrintableLabels';

export default PrintableLabels;
