"use client";

import { Card, CardHeader, CardBody, Chip, Button } from "@heroui/react";
import { Sparkles, TrendingDown, ArrowRight, Truck } from "lucide-react";
import React from 'react';
import { SavingsOpportunity } from "@/lib/definitions";
import { formatCurrency } from "@/lib/utils";
import { motion } from "framer-motion";

interface SavingsWidgetProps {
    items: SavingsOpportunity[];
}

export default function SavingsWidget({ items }: SavingsWidgetProps) {
    if (!items || items.length === 0) return null;

    // Calcular ahorro total potencial
    const totalPotentialSavings = items.reduce((acc, item) => acc + item.potentialSave, 0);

    return (
        <Card className="bg-gradient-to-br from-white to-emerald-50/30 dark:from-zinc-900/50 dark:to-emerald-950/20 border border-emerald-200/50 dark:border-emerald-500/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.12)] h-full flex flex-col overflow-hidden" radius="lg">
            <CardHeader className="px-6 pt-6 pb-3 flex-shrink-0 relative overflow-hidden">
                <div className="absolute -right-4 -top-4 w-24 h-24 bg-white/5 rounded-2xl blur-3xl" />
                <div className="flex items-center justify-between w-full z-10">
                    <div className="flex items-center gap-3">
                        <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 p-2.5 rounded-2xl text-zinc-900 dark:text-zinc-100 shadow-[0_8px_30px_rgb(0,0,0,0.12)] transform -rotate-3">
                            <TrendingDown size={18} />
                        </div>
                        <div>
                            <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tight">Oportunidades de Ahorro</h2>
                            <p className="text-[10px] font-bold text-zinc-900 dark:text-zinc-100 dark:text-zinc-300 uppercase tracking-widest flex items-center gap-1">
                                <Sparkles size={10} /> {items.length} productos con mejor precio
                            </p>
                        </div>
                    </div>
                </div>
            </CardHeader>

            <CardBody className="px-6 pb-6 pt-0 flex-1 flex flex-col gap-4 overflow-hidden">
                {/* Banner de Ahorro Total */}
                <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 p-4 rounded-2xl shadow-inner relative overflow-hidden group">
                    <div className="absolute right-0 top-0 opacity-10 group-hover:scale-110 transition-transform duration-700">
                        <TrendingDown size={80} strokeWidth={4} />
                    </div>
                    <p className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-[0.2em] tracking-tight mb-1">Ahorro Potencial Total</p>
                    <div className="flex items-baseline gap-2">
                        <h3 className="text-2xl font-medium text-zinc-900 dark:text-zinc-100 tracking-tight tracking-tighter tabular-nums">
                            {formatCurrency(totalPotentialSavings)}
                        </h3>
                        <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-tight">estimado</span>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2.5 pr-1">
                    {items.map((item, idx) => (
                        <motion.div 
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: idx * 0.1 }}
                            key={item.barcode} 
                            className="p-3 rounded-2xl bg-white/50 dark:bg-[#18181b] border border-gray-100 dark:border-white/5 hover:border-emerald-500/30 transition-all duration-300 group"
                        >
                            <div className="flex justify-between items-start mb-2">
                                <div className="min-w-0">
                                    <p className="font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight text-[11px] truncate leading-tight group-hover:text-zinc-900 dark:text-zinc-100 transition-colors">
                                        {item.productName}
                                    </p>
                                    <div className="flex items-center gap-2 mt-0.5">
                                        <span className="text-[8px] font-bold text-zinc-500 dark:text-zinc-400 tracking-widest uppercase">{item.barcode}</span>
                                        <span className="h-1 w-1 rounded-2xl bg-gray-300 dark:bg-zinc-700" />
                                        <span className="text-[8px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-tight">Stock: {item.stock}</span>
                                    </div>
                                </div>
                                <Chip size="sm" variant="flat"
                                    className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 dark:bg-white/5 dark:text-zinc-300 border border-emerald-500/20"
                                    classNames={{ content: "text-[8px] font-medium uppercase tracking-widest px-1" }}
                                >
                                    AHORRA {Math.round((1 - item.bestPrice/item.currentPrice) * 100)}%
                                </Chip>
                            </div>

                            <div className="flex items-center justify-between pt-2 border-t border-gray-100 dark:border-white/5">
                                <div className="flex flex-col">
                                    <span className="text-[8px] font-medium text-gray-400 uppercase tracking-widest tracking-tight leading-none mb-1">Mejor Proveedor</span>
                                    <div className="flex items-center gap-1.5">
                                        <Truck size={10} className="text-zinc-900 dark:text-zinc-100" />
                                        <span className="text-[10px] font-medium text-gray-700 dark:text-zinc-300 uppercase truncate max-w-[100px]">{item.bestSupplier}</span>
                                    </div>
                                </div>
                                
                                <div className="flex flex-col items-end">
                                    <span className="text-[8px] font-medium text-gray-400 uppercase tracking-widest tracking-tight leading-none mb-1">Costo Objetivo</span>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[9px] text-gray-400 line-through tabular-nums font-bold">{formatCurrency(item.currentPrice)}</span>
                                        <ArrowRight size={10} className="text-zinc-900 dark:text-zinc-100" />
                                        <span className="text-[12px] font-medium text-zinc-900 dark:text-zinc-100 tabular-nums tracking-tight">{formatCurrency(item.bestPrice)}</span>
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    ))}
                </div>

                <Button 
                    variant="shadow"
                    className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 font-medium uppercase text-[10px] tracking-tight tracking-[0.2em] rounded-2xl h-10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] group"
                >
                    Optimizar Compras <ArrowRight size={14} className="ml-2 group-hover:translate-x-1 transition-transform" />
                </Button>
            </CardBody>
        </Card>
    );
}
