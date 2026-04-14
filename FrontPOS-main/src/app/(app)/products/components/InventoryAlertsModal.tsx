"use client";

import React, { memo } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, Button } from "@heroui/react";
import { AlertTriangle, Check, Package, X, ArrowRight } from 'lucide-react';
import { Product } from '@/lib/definitions';

interface InventoryAlertsModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    products: Product[];
}

const InventoryAlertsModal = memo(({ isOpen, onOpenChange, products }: InventoryAlertsModalProps) => {
    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            backdrop="blur" 
            scrollBehavior="inside" 
            size="xl"
            classNames={{ 
                base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-amber-500/20 shadow-2xl overflow-hidden", 
                closeButton: "hover:bg-amber-500/10 hover:text-amber-500 transition-colors z-50" 
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1 p-8 border-b border-gray-100 dark:border-white/5 bg-amber-50/30 dark:bg-amber-500/5">
                            <div className="flex items-center gap-5">
                                <div className="h-14 w-14 bg-amber-500 text-white flex items-center justify-center rounded-2xl shadow-lg shadow-amber-500/20 -rotate-3">
                                    <AlertTriangle size={28} />
                                </div>
                                <div className="flex flex-col min-w-0">
                                    <h2 className="text-2xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none">
                                        Monitor <span className="text-amber-500">Maestro</span>
                                    </h2>
                                    <span className="text-[10px] font-black text-amber-600/60 dark:text-amber-500/50 uppercase tracking-[0.3em] mt-2 not-italic">Items en Punto de Re-orden (≤ 5)</span>
                                </div>
                            </div>
                        </ModalHeader>

                        <ModalBody className="p-8 pb-12">
                            {products.length === 0 ? (
                                <div className="py-20 flex flex-col items-center justify-center text-center">
                                    <div className="h-20 w-20 bg-emerald-500/10 text-emerald-500 rounded-full flex items-center justify-center mb-6 shadow-inner animate-bounce">
                                        <Check size={40} />
                                    </div>
                                    <h3 className="text-sm font-black text-gray-900 dark:text-white uppercase italic tracking-widest mb-2">Inventario Saludable</h3>
                                    <p className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest">No se detectaron quiebres de stock</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    {products.map(p => (
                                        <div key={p.barcode} className="group bg-gray-50 dark:bg-zinc-900/50 p-5 rounded-3xl border border-gray-200 dark:border-white/5 flex items-center justify-between gap-4 transition-all hover:bg-amber-500/5 hover:border-amber-500/20 shadow-sm overflow-hidden relative">
                                            <div className="absolute top-0 right-0 p-2 opacity-10 text-amber-500 rotate-12 -mr-3 -mt-3">
                                                <Package size={50} />
                                            </div>
                                            
                                            <div className="flex items-center gap-4 relative z-10 min-w-0">
                                                <div className="h-10 w-10 bg-white dark:bg-zinc-800 rounded-xl flex items-center justify-center text-amber-500 shadow-sm border border-gray-100 dark:border-white/5">
                                                    <Package size={18} />
                                                </div>
                                                <div className="flex flex-col min-w-0">
                                                    <span className="text-xs font-black text-gray-900 dark:text-white uppercase italic tracking-tighter truncate leading-tight">
                                                        {p.productName}
                                                    </span>
                                                    <span className="text-[8px] font-mono text-gray-400 dark:text-zinc-500 tracking-[0.2em] uppercase">#{p.barcode}</span>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-3 relative z-10 shrink-0">
                                                <div className="flex flex-col items-end">
                                                    <span className="text-xl font-black text-rose-500 italic tabular-nums leading-none">{p.quantity}</span>
                                                    <span className="text-[7px] font-black text-rose-500/50 uppercase tracking-widest mt-1">STOCK</span>
                                                </div>
                                                <ArrowRight size={12} className="text-gray-300 group-hover:text-amber-500 transition-colors" />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </ModalBody>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
});

InventoryAlertsModal.displayName = 'InventoryAlertsModal';
export default InventoryAlertsModal;
