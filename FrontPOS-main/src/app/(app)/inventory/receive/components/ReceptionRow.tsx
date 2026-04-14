"use client";

import React, { memo, useState, useEffect } from 'react';
import { Button, Input } from "@heroui/react";
import { 
    Barcode, Trash2, Truck, Gift, ArrowDownLeft, 
    Minus, Plus, Calculator 
} from 'lucide-react';
import { ReceiveItem } from '../page';
import { formatCurrency, applyRounding } from "@/lib/utils";

interface ReceptionRowProps {
    item: ReceiveItem;
    onUpdate: (barcode: string, updates: Partial<ReceiveItem>) => void;
    onDelete: (barcode: string) => void;
}

const ReceptionRow = memo(({ item, onUpdate, onDelete }: ReceptionRowProps) => {
    // Local state for numeric inputs to avoid parent-triggered re-renders on every keystroke
    const [localTotal, setLocalTotal] = useState(String((Number(item.newPurchasePrice) + Number(item.iva) + Number(item.icui) + Number(item.ibua)) * item.addedQuantity));
    const [localCost, setLocalCost] = useState(String(item.newPurchasePrice));
    const [localSalePrice, setLocalSalePrice] = useState(String(item.newSalePrice));
    const [localIva, setLocalIva] = useState(String(item.iva || 0));
    const [localIcui, setLocalIcui] = useState(String(item.icui || 0));
    const [localIbua, setLocalIbua] = useState(String(item.ibua || 0));

    // Update local state if item changes from parent (e.g. sync or other row updates)
    useEffect(() => {
        setLocalTotal(String((Number(item.newPurchasePrice) + Number(item.iva) + Number(item.icui) + Number(item.ibua)) * item.addedQuantity));
        setLocalCost(String(item.newPurchasePrice));
        setLocalSalePrice(String(item.newSalePrice));
        setLocalIva(String(item.iva || 0));
        setLocalIcui(String(item.icui || 0));
        setLocalIbua(String(item.ibua || 0));
    }, [item.newPurchasePrice, item.addedQuantity, item.newSalePrice, item.iva, item.icui, item.ibua]);

    const handleTotalChange = (val: string) => {
        setLocalTotal(val);
        const totalRow = parseFloat(val) || 0;
        const totalUnitCost = totalRow / Math.max(1, item.addedQuantity);
        
        // El costo base es el totalUnitCost menos los impuestos actuales
        const taxes = Number(item.iva) + Number(item.icui) + Number(item.ibua);
        const costUndBase = Math.max(0, totalUnitCost - taxes);

        onUpdate(item.barcode, {
            newPurchasePrice: costUndBase,
            newSalePrice: applyRounding((costUndBase + taxes) * (1 + item.marginPercentage / 100))
        });
    };

    const handleCostChange = (val: string) => {
        setLocalCost(val);
        const cost = parseFloat(val) || 0;
        const totalUnit = cost + Number(item.iva) + Number(item.icui) + Number(item.ibua);
        onUpdate(item.barcode, {
            newPurchasePrice: cost,
            newSalePrice: applyRounding(totalUnit * (1 + item.marginPercentage / 100))
        });
    };

    const handleSalePriceChange = (val: string) => {
        setLocalSalePrice(val);
        const sale = applyRounding(parseFloat(val) || 0);
        const totalPurchase = Number(item.newPurchasePrice) + Number(item.iva) + Number(item.icui) + Number(item.ibua);
        const margin = totalPurchase > 0 ? ((sale / totalPurchase) - 1) * 100 : item.marginPercentage;
        onUpdate(item.barcode, { 
            newSalePrice: sale, 
            marginPercentage: margin 
        });
    };

    const handleTaxChange = (type: 'iva' | 'icui' | 'ibua', val: string) => {
        const value = parseFloat(val) || 0;
        if (type === 'iva') setLocalIva(val);
        if (type === 'icui') setLocalIcui(val);
        if (type === 'ibua') setLocalIbua(val);

        const updates: any = { [type]: value };
        
        // Recalcular el PVP basado en el nuevo costo total (Base + Todos los Impuestos)
        const newTotalPurchase = Number(item.newPurchasePrice) + 
                                (type === 'iva' ? value : Number(item.iva)) + 
                                (type === 'icui' ? value : Number(item.icui)) + 
                                (type === 'ibua' ? value : Number(item.ibua));
                                
        updates.newSalePrice = applyRounding(newTotalPurchase * (1 + item.marginPercentage / 100));
        onUpdate(item.barcode, updates);
    };

    return (
        <div className="flex flex-col lg:flex-row lg:items-center gap-4 p-4 bg-white dark:bg-black/40 hover:bg-gray-50 dark:hover:bg-white/[0.02] transition-colors min-h-[60px] border-b border-gray-100 dark:border-white/5 first:rounded-t-2xl last:rounded-b-2xl shadow-sm">
            {/* Info Base */}
            <div className="flex-1 min-w-0 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="h-10 w-10 rounded-xl bg-gray-100 dark:bg-zinc-900 flex items-center justify-center text-emerald-500 shrink-0 shadow-inner">
                        <Barcode size={18} />
                    </div>
                    <div className="min-w-0">
                        <h3 className="text-[13px] font-black text-gray-900 dark:text-white uppercase italic leading-tight truncate">
                            {item.productName}
                        </h3>
                        <p className="text-[10px] font-black text-gray-400 dark:text-zinc-600 font-mono mt-0.5 tracking-tighter">
                            #{item.barcode}
                        </p>
                    </div>
                </div>
                
                <Button 
                    isIconOnly 
                    variant="flat" 
                    size="sm" 
                    onClick={() => onDelete(item.barcode)} 
                    className="h-9 w-9 min-w-9 bg-rose-50 dark:bg-rose-500/10 text-rose-500 rounded-xl hover:bg-rose-500 hover:text-white transition-all border border-rose-500/10 shadow-sm lg:hidden"
                >
                    <Trash2 size={16} />
                </Button>
            </div>

            {/* Selector de Protocolo */}
            <div className="flex bg-gray-100 dark:bg-zinc-900/50 p-1 rounded-xl gap-1 shrink-0 self-start lg:self-center">
                {[
                    { id: 'purchase', icon: Truck, color: 'emerald', label: 'PAGO' },
                    { id: 'gift', icon: Gift, color: 'pink', label: 'GRATIS' },
                    { id: 'return', icon: ArrowDownLeft, color: 'rose', label: 'DEVOL.' }
                ].map(btn => (
                    <button
                        key={btn.id}
                        onClick={() => onUpdate(item.barcode, { entryType: btn.id as any })}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-all ${
                            item.entryType === btn.id 
                            ? `bg-${btn.color === 'emerald' ? 'emerald' : btn.color === 'pink' ? 'pink' : 'rose'}-500 text-white shadow-lg shadow-${btn.color}-500/20` 
                            : 'text-gray-400 dark:text-zinc-500 hover:bg-gray-200 dark:hover:bg-zinc-800'
                        }`}
                    >
                        <btn.icon size={12} />
                        <span className="text-[9px] font-black uppercase tracking-wider">{btn.label}</span>
                    </button>
                ))}
            </div>

            {/* CALCULADORA DE COSTOS E INPUTS - RESPONSIVA (STACK EN MÓVIL) */}
            <div className="grid grid-cols-2 sm:grid-cols-4 items-end gap-3 lg:flex lg:items-center lg:justify-end lg:gap-6 shrink-0 w-full lg:w-auto mt-1 lg:mt-0 p-3 lg:p-0 bg-gray-50/50 dark:bg-white/[0.02] lg:bg-transparent rounded-2xl">
                {/* CANTIDAD */}
                <div className="space-y-1">
                    <span className="text-[8px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-[0.2em] ml-1">CANTIDAD</span>
                    <div className="flex items-center bg-white dark:bg-zinc-900 rounded-xl h-10 px-2 gap-2 border border-gray-200 dark:border-white/10 shadow-sm">
                        <button 
                            onClick={() => onUpdate(item.barcode, { addedQuantity: Math.max(1, item.addedQuantity - 1) })} 
                            className="text-rose-500 hover:scale-125 transition-transform"
                        >
                            <Minus size={14} />
                        </button>
                        <input 
                            type="number" 
                            aria-label="Cantidad a recibir"
                            className="bg-transparent w-8 text-center text-[11px] font-black text-gray-900 dark:text-white border-none outline-none focus:ring-0" 
                            value={item.addedQuantity}
                            onChange={(e) => onUpdate(item.barcode, { addedQuantity: Math.max(0, parseFloat(e.target.value) || 0) })} 
                        />
                        <button 
                            onClick={() => onUpdate(item.barcode, { addedQuantity: item.addedQuantity + 1 })} 
                            className="text-emerald-500 hover:scale-125 transition-transform"
                        >
                            <Plus size={14} />
                        </button>
                    </div>
                </div>

                {/* TOTAL PRODUCTO */}
                <div className="space-y-1">
                    <span className="text-[8px] font-black text-indigo-500 dark:text-indigo-400 uppercase tracking-[0.2em] ml-1 flex items-center gap-1">
                        <Calculator size={10} /> TOTAL LOTE
                    </span>
                    <Input 
                        size="sm" 
                        aria-label="Total del lote"
                        variant="flat" 
                        className="w-full lg:w-32"
                        classNames={{ 
                            input: "text-[13px] font-black italic tabular-nums text-indigo-600 dark:text-indigo-400", 
                            inputWrapper: "h-10 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-xl shadow-sm focus-within:border-indigo-500 transition-all" 
                        }}
                        startContent={<span className="text-[10px] text-indigo-500 font-black">$</span>}
                        value={localTotal}
                        isDisabled={item.entryType === 'gift'}
                        onValueChange={handleTotalChange}
                    />
                </div>

                {/* COSTO UND */}
                <div className="space-y-1">
                    <span className="text-[8px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-[0.2em] ml-1">COSTO BASE</span>
                    <Input 
                        size="sm" 
                        aria-label="Costo unitario"
                        variant="flat" 
                        className="w-full lg:w-28" 
                        classNames={{ 
                            input: "text-[13px] font-black italic tabular-nums text-gray-900 dark:text-white", 
                            inputWrapper: "h-10 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-xl shadow-sm focus-within:border-emerald-500/50 transition-all" 
                        }} 
                        startContent={<span className="text-[10px] text-rose-500 font-black">$</span>}
                        value={localCost}
                        isDisabled={item.entryType === 'gift'}
                        onValueChange={handleCostChange}
                    />
                </div>

                {/* IMPUESTOS PANEL */}
                <div className="flex items-center gap-2 bg-gray-100 dark:bg-white/5 p-1.5 rounded-xl border border-gray-200 dark:border-white/10 shrink-0">
                    <div className="flex flex-col gap-1">
                        <span className="text-[7px] font-black text-rose-500 uppercase tracking-widest ml-1">IVA</span>
                        <input 
                            aria-label="IVA por unidad"
                            className="bg-white dark:bg-zinc-900 w-14 h-7 text-center text-[10px] font-black rounded-lg border-none outline-none focus:ring-1 focus:ring-rose-500/50" 
                            value={localIva}
                            onChange={(e) => handleTaxChange('iva', e.target.value)}
                        />
                    </div>
                    <div className="flex flex-col gap-1">
                        <span className="text-[7px] font-black text-amber-500 uppercase tracking-widest ml-1">ICUI</span>
                        <input 
                            aria-label="ICUI por unidad"
                            className="bg-white dark:bg-zinc-900 w-14 h-7 text-center text-[10px] font-black rounded-lg border-none outline-none focus:ring-1 focus:ring-amber-500/50" 
                            value={localIcui}
                            onChange={(e) => handleTaxChange('icui', e.target.value)}
                        />
                    </div>
                    <div className="flex flex-col gap-1">
                        <span className="text-[7px] font-black text-sky-500 uppercase tracking-widest ml-1">IBUA</span>
                        <input 
                            aria-label="IBUA por unidad"
                            className="bg-white dark:bg-zinc-900 w-14 h-7 text-center text-[10px] font-black rounded-lg border-none outline-none focus:ring-1 focus:ring-sky-500/50" 
                            value={localIbua}
                            onChange={(e) => handleTaxChange('ibua', e.target.value)}
                        />
                    </div>
                </div>

                {/* PVP SUGERIDO */}
                <div className="space-y-1">
                    <span className="text-[8px] font-black text-emerald-500 uppercase tracking-[0.2em] ml-1 italic">PVP FINAL</span>
                    <Input 
                        size="sm" 
                        aria-label="Precio de venta final"
                        variant="flat" 
                        className="w-full lg:w-28" 
                        classNames={{ 
                            input: "text-[13px] font-black italic tabular-nums text-emerald-600 dark:text-emerald-500", 
                            inputWrapper: "h-10 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-xl shadow-sm focus-within:border-emerald-500 transition-all" 
                        }} 
                        startContent={<span className="text-[10px] text-emerald-500 font-black">$</span>}
                        value={localSalePrice}
                        onValueChange={handleSalePriceChange}
                    />
                </div>

                <Button 
                    isIconOnly 
                    variant="flat" 
                    size="sm" 
                    onClick={() => onDelete(item.barcode)} 
                    className="h-10 w-10 min-w-10 bg-rose-50 dark:bg-rose-500/10 text-rose-500 rounded-xl hover:bg-rose-500 hover:text-white transition-all border border-rose-500/10 shadow-sm hidden lg:flex"
                >
                    <Trash2 size={16} />
                </Button>
            </div>
        </div>
    );
});

ReceptionRow.displayName = 'ReceptionRow';

export default ReceptionRow;
