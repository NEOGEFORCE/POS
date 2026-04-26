"use client";

import React, { memo, useState, useEffect } from 'react';
import { Button } from "@heroui/react";
import { 
    Barcode, Trash2, Truck, Gift, ArrowDownLeft 
} from 'lucide-react';
import { ReceiveItem } from '../page';
import { formatCOP, formatInputCOP, parseCOP, applyRounding } from "@/lib/utils";

interface ReceptionRowProps {
    item: ReceiveItem;
    onUpdate: (barcode: string, updates: Partial<ReceiveItem>) => void;
    onDelete: (barcode: string) => void;
}

const ReceptionRow = memo(({ item, onUpdate, onDelete }: ReceptionRowProps) => {
    // Calcular costo REAL con descuento aplicado
    const calculateCostWithDiscount = (base: number, discountPct: number) => {
        return base * (1 + discountPct / 100);
    };

    // Calcular PVP: costoReal × (1 + taxes%) × (1 + margin%)
    const calculateFinalPrice = (base: number, discountPct: number, ivaPct: number, icuiPct: number, ibuaPct: number, marginPct: number) => {
        const withDiscount = base * (1 + discountPct / 100);
        const withTaxes = withDiscount * (1 + ivaPct / 100 + icuiPct / 100 + ibuaPct / 100);
        return withTaxes * (1 + marginPct / 100);
    };

    // Local state
    const costWithDiscount = calculateCostWithDiscount(item.newPurchasePrice, item.discount || 0);
    const [localTotal, setLocalTotal] = useState(formatCOP(costWithDiscount * item.addedQuantity));
    const [localCost, setLocalCost] = useState(formatCOP(costWithDiscount)); 
    const [localSalePrice, setLocalSalePrice] = useState(formatCOP(item.newSalePrice));
    const [localIva, setLocalIva] = useState(String(item.iva || 0));
    const [localIcui, setLocalIcui] = useState(String(item.icui || 0));
    const [localIbua, setLocalIbua] = useState(String(item.ibua || 0));
    const [localDiscount, setLocalDiscount] = useState(String(Math.round(item.discount || 0)));
    const [localMargin, setLocalMargin] = useState(String(Math.round(item.marginPercentage || 30)));

    useEffect(() => {
        const costWithDisc = calculateCostWithDiscount(item.newPurchasePrice, item.discount || 0);
        setLocalTotal(formatCOP(costWithDisc * item.addedQuantity));
        setLocalCost(formatCOP(costWithDisc)); 
        setLocalSalePrice(formatCOP(item.newSalePrice));
        setLocalIva(String(item.iva || 0));
        setLocalIcui(String(item.icui || 0));
        setLocalIbua(String(item.ibua || 0));
        setLocalDiscount(String(item.discount || 0));
        setLocalMargin(String(Math.round(item.marginPercentage || 30)));
    }, [item.newPurchasePrice, item.addedQuantity, item.newSalePrice, item.iva, item.icui, item.ibua, item.discount, item.marginPercentage]);

    const handleTotalChange = (val: string) => {
        const formatted = formatInputCOP(val);
        setLocalTotal(formatted);
        const totalRow = parseCOP(val) || 0;
        const costWithDiscount = totalRow / Math.max(1, item.addedQuantity);
        const discountPct = Number(item.discount || 0);
        const costBaseSinDiscount = costWithDiscount / (1 + discountPct / 100);
        const newSale = applyRounding(calculateFinalPrice(costBaseSinDiscount, discountPct, Number(item.iva), Number(item.icui), Number(item.ibua), Number(item.marginPercentage)));
        setLocalCost(formatCOP(costWithDiscount));
        setLocalSalePrice(formatCOP(newSale));
        onUpdate(item.barcode, {
            newPurchasePrice: costBaseSinDiscount,
            newSalePrice: newSale
        });
    };

    const handleCostChange = (val: string) => {
        const formatted = formatInputCOP(val);
        setLocalCost(formatted);
        const costWithDiscount = parseCOP(val) || 0;
        const discountPct = Number(item.discount || 0);
        const costBaseSinDiscount = costWithDiscount / (1 + discountPct / 100);
        const newTotal = costWithDiscount * item.addedQuantity;
        setLocalTotal(formatCOP(newTotal));
        const newSale = applyRounding(calculateFinalPrice(costBaseSinDiscount, discountPct, Number(item.iva), Number(item.icui), Number(item.ibua), Number(item.marginPercentage)));
        setLocalSalePrice(formatCOP(newSale));
        onUpdate(item.barcode, {
            newPurchasePrice: costBaseSinDiscount,
            newSalePrice: newSale
        });
    };

    const handleSalePriceChange = (val: string) => {
        const formatted = formatInputCOP(val);
        setLocalSalePrice(formatted);
        const sale = applyRounding(parseCOP(val) || 0);
        const discountPct = Number(item.discount || 0);
        const costWithDiscount = item.newPurchasePrice * (1 + discountPct / 100);
        const taxMultiplier = 1 + (Number(item.iva) + Number(item.icui) + Number(item.ibua)) / 100;
        const totalCost = costWithDiscount * taxMultiplier;
        const margin = totalCost > 0 ? ((sale / totalCost) - 1) * 100 : item.marginPercentage;
        setLocalMargin(String(Math.round(margin)));
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
        const currentIva = type === 'iva' ? value : Number(item.iva);
        const currentIcui = type === 'icui' ? value : Number(item.icui);
        const currentIbua = type === 'ibua' ? value : Number(item.ibua);
        const discountPct = Number(item.discount || 0);
        const updates: any = { [type]: value };
        const newSale = applyRounding(calculateFinalPrice(item.newPurchasePrice, discountPct, currentIva, currentIcui, currentIbua, Number(item.marginPercentage)));
        updates.newSalePrice = newSale;
        setLocalSalePrice(formatCOP(newSale));
        onUpdate(item.barcode, updates);
    };

    const handleMarginChange = (val: string) => {
        const value = parseFloat(val) || 0;
        setLocalMargin(String(Math.round(value)));
        const newSale = applyRounding(calculateFinalPrice(item.newPurchasePrice, Number(item.discount || 0), Number(item.iva), Number(item.icui), Number(item.ibua), value));
        setLocalSalePrice(formatCOP(newSale));
        onUpdate(item.barcode, { 
            marginPercentage: value,
            newSalePrice: newSale
        });
    };

    const handleDiscountChange = (val: string) => {
        const value = parseFloat(val) || 0;
        setLocalDiscount(String(Math.round(value)));
        const costWithDiscount = calculateCostWithDiscount(item.newPurchasePrice, value);
        setLocalCost(formatCOP(costWithDiscount));
        const newTotal = costWithDiscount * item.addedQuantity;
        setLocalTotal(formatCOP(newTotal));
        const newSale = applyRounding(calculateFinalPrice(item.newPurchasePrice, value, Number(item.iva), Number(item.icui), Number(item.ibua), Number(item.marginPercentage)));
        setLocalSalePrice(formatCOP(newSale));
        onUpdate(item.barcode, { 
            discount: value,
            newSalePrice: newSale
        });
    };

    return (
        <div className="flex flex-col lg:flex-row lg:items-center gap-0 p-1 px-2 md:p-4 bg-white dark:bg-black/40 hover:bg-gray-50 dark:hover:bg-white/[0.02] transition-colors border-b border-gray-100 dark:border-white/5 first:rounded-t-2xl last:rounded-b-2xl shadow-sm overflow-hidden">
            {/* Cabecera compacta: Nombre, Código y Acciones */}
            <div className="flex-1 min-w-0 flex items-center justify-between gap-2 overflow-hidden py-0.5">
                <div className="flex items-center gap-2 md:gap-3 min-w-0">
                    <div className="h-6 w-6 md:h-10 md:w-10 rounded-lg md:rounded-xl bg-gray-100 dark:bg-zinc-900 flex items-center justify-center text-emerald-500 shrink-0 shadow-inner">
                        <Barcode size={14} className="md:w-[18px] md:h-[18px]" />
                    </div>
                    <div className="min-w-0 flex flex-col">
                        <div className="flex items-baseline gap-1.5 min-w-0">
                            <h3 className="text-[9px] md:text-[11px] font-black text-gray-900 dark:text-white uppercase italic leading-tight truncate">{item.productName}</h3>
                            <span className="text-[7px] font-black text-gray-400 dark:text-zinc-600 font-mono tracking-tighter shrink-0">#{item.barcode}</span>
                        </div>
                    </div>
                </div>
                
                <div className="flex items-center gap-1.5 shrink-0 ml-4">
                    <div className="flex bg-gray-100 dark:bg-zinc-900/50 p-0.5 rounded-lg gap-0.5 shrink-0 h-7 items-center">
                        {[
                            { id: 'purchase', icon: Truck, color: 'emerald' },
                            { id: 'gift', icon: Gift, color: 'pink' },
                            { id: 'return', icon: ArrowDownLeft, color: 'rose' }
                        ].map(btn => (
                            <button
                                key={btn.id}
                                onClick={() => onUpdate(item.barcode, { entryType: btn.id as any })}
                                className={`flex items-center justify-center w-7 h-6 rounded-md transition-all ${
                                    item.entryType === btn.id 
                                    ? `bg-${btn.color === 'emerald' ? 'emerald' : btn.color === 'pink' ? 'pink' : 'rose'}-500 text-white shadow-sm` 
                                    : 'text-gray-400 hover:bg-gray-200 dark:hover:bg-zinc-800'
                                }`}
                            >
                                <btn.icon size={12} />
                            </button>
                        ))}
                    </div>

                    <Button 
                        isIconOnly 
                        variant="flat" 
                        size="sm" 
                        onClick={() => onDelete(item.barcode)} 
                        className="h-7 w-7 min-w-7 bg-rose-50 dark:bg-rose-500/10 text-rose-500 rounded-lg border border-rose-500/10 shadow-sm"
                    >
                        <Trash2 size={13} />
                    </Button>
                </div>
            </div>

            {/* Fila de Inputs (4 columnas) */}
            <div className="grid grid-cols-4 items-start gap-1 shrink-0 w-full lg:w-auto p-0 lg:p-0 bg-transparent rounded-xl">
                {/* CANT */}
                <div className="col-span-1 space-y-0">
                    <span className="text-[6px] font-black text-gray-400 dark:text-zinc-600 uppercase italic ml-1 block mb-0">CANT</span>
                    <div className="flex items-center bg-white dark:bg-zinc-900 rounded-lg h-7 px-1 gap-1 border border-gray-200 dark:border-white/10 shadow-sm">
                        <input 
                            type="number" 
                            className="bg-transparent w-full text-center text-[9px] font-black text-gray-900 dark:text-white border-none outline-none focus:ring-0 p-0" 
                            value={item.addedQuantity}
                            onChange={(e) => onUpdate(item.barcode, { addedQuantity: Math.max(0, parseFloat(e.target.value) || 0) })} 
                        />
                    </div>
                </div>

                {/* TOTAL */}
                <div className="col-span-1 space-y-0">
                    <span className="text-[6px] font-black text-indigo-500 uppercase italic ml-1 block mb-0">TOTAL</span>
                    <div className="flex items-center bg-white dark:bg-zinc-900 rounded-lg h-7 px-1 gap-0.5 border border-gray-200 dark:border-white/10 shadow-sm">
                        <span className="text-[7px] text-indigo-500 font-black">$</span>
                        <input 
                            className={`bg-transparent w-full text-[9px] font-black italic tabular-nums border-none outline-none focus:ring-0 p-0 ${item.entryType === 'gift' ? 'text-gray-400' : 'text-indigo-600 dark:text-indigo-400'}`} 
                            value={localTotal}
                            onChange={(e) => handleTotalChange(e.target.value)}
                            disabled={item.entryType === 'gift'}
                        />
                    </div>
                </div>

                {/* COSTO */}
                <div className="col-span-1 space-y-0">
                    <span className="text-[6px] font-black text-gray-400 dark:text-zinc-600 uppercase italic ml-1 block mb-0">COSTO</span>
                    <div className="flex items-center bg-white dark:bg-zinc-900 rounded-lg h-7 px-1 gap-0.5 border border-gray-200 dark:border-white/10 shadow-sm">
                        <span className="text-[7px] text-rose-500 font-black">$</span>
                        <input 
                            className="bg-transparent w-full text-[9px] font-black italic tabular-nums text-gray-900 dark:text-white border-none outline-none focus:ring-0 p-0" 
                            value={localCost}
                            onChange={(e) => handleCostChange(e.target.value)}
                            disabled={item.entryType === 'gift'}
                        />
                    </div>
                </div>

                {/* PVP */}
                <div className="col-span-1 space-y-0">
                    <span className="text-[6px] font-black text-emerald-500 uppercase italic ml-1 block mb-0">PVP</span>
                    <div className="flex items-center bg-white dark:bg-zinc-900 rounded-lg h-7 px-1 gap-0.5 border border-gray-200 dark:border-white/10 shadow-sm">
                        <span className="text-[7px] text-emerald-500 font-black">$</span>
                        <input 
                            className="bg-transparent w-full text-[9px] font-black italic tabular-nums text-emerald-600 dark:text-emerald-500 border-none outline-none focus:ring-0 p-0" 
                            value={localSalePrice}
                            onChange={(e) => handleSalePriceChange(e.target.value)}
                        />
                    </div>
                </div>
            </div>

            {/* Panel de porcentajes */}
            <div className="col-span-2 md:col-span-2 lg:md:col-span-1 flex flex-wrap items-center gap-1 bg-gray-100 dark:bg-white/5 p-1 rounded-lg border border-gray-200 dark:border-white/10 min-w-0 shadow-inner mt-0.5">
                <div className="flex items-center gap-1 bg-white dark:bg-zinc-900 px-1 py-0.5 rounded-md border border-gray-200 dark:border-white/10">
                    <span className="text-[7px] font-black text-emerald-500 italic">DTO</span>
                    <input className="bg-transparent w-5 text-center text-[9px] font-black border-none outline-none p-0" value={localDiscount} onChange={(e) => handleDiscountChange(e.target.value)} disabled={item.entryType === 'gift'} />
                    <span className="text-[7px] text-emerald-500 font-black">%</span>
                </div>
                <div className="flex items-center gap-1 bg-white dark:bg-zinc-900 px-1 py-0.5 rounded-md border border-gray-200 dark:border-white/10">
                    <span className="text-[7px] font-black text-rose-500 italic">IVA</span>
                    <input className="bg-transparent w-5 text-center text-[9px] font-black border-none outline-none p-0" value={localIva} onChange={(e) => handleTaxChange('iva', e.target.value)} />
                    <span className="text-[7px] text-rose-500 font-black">%</span>
                </div>
                <div className="flex items-center gap-1 bg-white dark:bg-zinc-900 px-1 py-0.5 rounded-md border border-gray-200 dark:border-white/10">
                    <span className="text-[7px] font-black text-amber-500 italic">ICUI</span>
                    <input className="bg-transparent w-5 text-center text-[9px] font-black border-none outline-none p-0" value={localIcui} onChange={(e) => handleTaxChange('icui', e.target.value)} />
                    <span className="text-[7px] text-amber-500 font-black">%</span>
                </div>
                <div className="flex items-center gap-1 bg-white dark:bg-zinc-900 px-1 py-0.5 rounded-md border border-gray-200 dark:border-white/10">
                    <span className="text-[7px] font-black text-sky-500 italic">IBUA</span>
                    <input className="bg-transparent w-5 text-center text-[9px] font-black border-none outline-none p-0" value={localIbua} onChange={(e) => handleTaxChange('ibua', e.target.value)} />
                    <span className="text-[7px] text-sky-500 font-black">%</span>
                </div>
                <div className="flex items-center gap-1 bg-violet-500/10 dark:bg-violet-500/20 px-1 py-0.5 rounded-md border border-violet-500/20">
                    <span className="text-[7px] font-black text-violet-500 italic">GAN</span>
                    <input className="bg-transparent w-6 text-center text-[9px] font-black border-none outline-none p-0 text-violet-600 dark:text-violet-400" value={localMargin} onChange={(e) => handleMarginChange(String(e.target.value))} />
                    <span className="text-[7px] text-violet-500 font-black">%</span>
                </div>
            </div>
        </div>
    );
});

ReceptionRow.displayName = 'ReceptionRow';

export default ReceptionRow;
