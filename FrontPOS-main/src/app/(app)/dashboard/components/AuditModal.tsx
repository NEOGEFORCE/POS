"use client";

import React, { useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input } from "@heroui/react";
import { Calculator, ShieldCheck, AlertCircle, TrendingUp } from 'lucide-react';
import { formatCurrency } from "@/lib/utils";

interface AuditBalances {
    cash: number;
    nequi: number;
    daviplata: number;
}

interface AuditModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: (balances: AuditBalances) => Promise<void>;
}

export default function AuditModal({ isOpen, onOpenChange, onConfirm }: AuditModalProps) {
    const [cash, setCash] = useState<string>('');
    const [nequi, setNequi] = useState<string>('');
    const [daviplata, setDaviplata] = useState<string>('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleConfirm = async () => {
        const numCash = parseFloat(cash) || 0;
        const numNequi = parseFloat(nequi) || 0;
        const numDaviplata = parseFloat(daviplata) || 0;
        
        setIsSubmitting(true);
        try {
            await onConfirm({ cash: numCash, nequi: numNequi, daviplata: numDaviplata });
            onOpenChange(false);
            setCash('');
            setNequi('');
            setDaviplata('');
        } catch (error) {
            console.error(error);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange}
            backdrop="blur"
            classNames={{
                base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-2xl rounded-[2.5rem]",
                header: "border-b border-gray-100 dark:border-white/5 p-8",
                body: "p-8",
                footer: "border-t border-gray-100 dark:border-white/5 p-6 bg-gray-50/50 dark:bg-white/[0.02]"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1">
                            <div className="flex items-center gap-4">
                                <div className="h-12 w-12 bg-emerald-500/10 text-emerald-500 rounded-2xl flex items-center justify-center border border-emerald-500/20 shadow-inner">
                                    <ShieldCheck size={24} />
                                </div>
                                <div className="flex flex-col">
                                    <h3 className="font-black text-gray-900 dark:text-white uppercase italic tracking-tighter text-xl">Auditoría de <span className="text-emerald-500">Caja</span></h3>
                                    <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">Sincronización de Saldo Real</p>
                                </div>
                            </div>
                        </ModalHeader>
                        <ModalBody>
                            <div className="space-y-6">
                                <div className="p-4 rounded-2xl bg-amber-500/5 border border-amber-500/10 flex gap-3">
                                    <AlertCircle className="text-amber-500 shrink-0" size={18} />
                                    <p className="text-[11px] text-amber-700 dark:text-amber-400 font-medium leading-relaxed italic">
                                        Introduce el total de dinero físico y digital disponible actualmente. Esto reseteará la diferencia a <span className="font-black">$0</span> y establecerá un nuevo punto de partida.
                                    </p>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] italic ml-1">Efectivo en Caja</label>
                                        <Input
                                            autoFocus
                                            type="number"
                                            placeholder="0.00"
                                            variant="flat"
                                            value={cash}
                                            onValueChange={setCash}
                                            startContent={<span className="text-emerald-500 font-black">$</span>}
                                            classNames={{
                                                inputWrapper: "h-14 bg-gray-100 dark:bg-white/5 border-2 border-transparent group-data-[focus=true]:border-emerald-500 transition-all rounded-2xl px-4 shadow-inner",
                                                input: "text-lg font-black italic tracking-tighter placeholder:text-gray-300 dark:placeholder:text-zinc-700"
                                            }}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] italic ml-1">Saldo Nequi</label>
                                        <Input
                                            type="number"
                                            placeholder="0.00"
                                            variant="flat"
                                            value={nequi}
                                            onValueChange={setNequi}
                                            startContent={<span className="text-purple-500 font-black">$</span>}
                                            classNames={{
                                                inputWrapper: "h-14 bg-gray-100 dark:bg-white/5 border-2 border-transparent group-data-[focus=true]:border-purple-500 transition-all rounded-2xl px-4 shadow-inner",
                                                input: "text-lg font-black italic tracking-tighter placeholder:text-gray-300 dark:placeholder:text-zinc-700"
                                            }}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] italic ml-1">Saldo Daviplata</label>
                                        <Input
                                            type="number"
                                            placeholder="0.00"
                                            variant="flat"
                                            value={daviplata}
                                            onValueChange={setDaviplata}
                                            startContent={<span className="text-rose-500 font-black">$</span>}
                                            classNames={{
                                                inputWrapper: "h-14 bg-gray-100 dark:bg-white/5 border-2 border-transparent group-data-[focus=true]:border-rose-500 transition-all rounded-2xl px-4 shadow-inner",
                                                input: "text-lg font-black italic tracking-tighter placeholder:text-gray-300 dark:placeholder:text-zinc-700"
                                            }}
                                        />
                                    </div>
                                </div>

                                {(cash || nequi || daviplata) && (
                                    <div className="flex items-center justify-between p-4 rounded-2xl bg-emerald-500/5 border border-emerald-500/10 animate-in fade-in zoom-in duration-300">
                                        <div className="flex flex-col">
                                            <span className="text-[9px] font-black text-emerald-600 dark:text-emerald-500 uppercase italic">Nuevo Saldo Total Combinado</span>
                                            <span className="text-xl font-black text-gray-900 dark:text-white italic">
                                                ${formatCurrency((parseFloat(cash)||0) + (parseFloat(nequi)||0) + (parseFloat(daviplata)||0))}
                                            </span>
                                        </div>
                                        <TrendingUp className="text-emerald-500" size={24} />
                                    </div>
                                )}
                            </div>
                        </ModalBody>
                        <ModalFooter>
                            <Button 
                                variant="light" 
                                onPress={onClose}
                                className="font-black uppercase text-[10px] tracking-widest rounded-xl px-6 h-12"
                            >
                                Cancelar
                            </Button>
                            <Button 
                                color="success"
                                onPress={handleConfirm}
                                isLoading={isSubmitting}
                                className="bg-emerald-500 text-white font-black uppercase text-[10px] tracking-widest rounded-xl px-8 h-12 shadow-lg shadow-emerald-500/20 active:scale-95 transition-all"
                            >
                                <Calculator size={16} className="mr-2" />
                                Ajustar Saldo
                            </Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
