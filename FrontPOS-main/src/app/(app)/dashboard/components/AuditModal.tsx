"use client";

import React, { useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input } from "@heroui/react";
import { Calculator, ShieldCheck, AlertCircle, TrendingUp, Coins } from 'lucide-react';
import { formatCurrency } from "@/lib/utils";

interface AuditBalances {
    cash: number;
    nequi: number;
    daviplata: number;
    bills?: number;
    coins1000?: number;
    coins200?: number;
    coins100?: number;
}

interface AuditModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: (balances: AuditBalances) => Promise<void>;
}

export default function AuditModal({ isOpen, onOpenChange, onConfirm }: AuditModalProps) {
    const [bills, setBills] = useState<string>('');
    const [coins1000, setCoins1000] = useState<string>('');
    const [coins200, setCoins200] = useState<string>('');
    const [coins100, setCoins100] = useState<string>('');
    const [nequi, setNequi] = useState<string>('');
    const [daviplata, setDaviplata] = useState<string>('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleConfirm = async () => {
        const numBills = parseFloat(bills) || 0;
        const numCoins1000 = parseFloat(coins1000) || 0;
        const numCoins200 = parseFloat(coins200) || 0;
        const numCoins100 = parseFloat(coins100) || 0;
        const numCash = numBills + numCoins1000 + numCoins200 + numCoins100;
        const numNequi = parseFloat(nequi) || 0;
        const numDaviplata = parseFloat(daviplata) || 0;
        
        setIsSubmitting(true);
        try {
            await onConfirm({ 
                cash: numCash, 
                nequi: numNequi, 
                daviplata: numDaviplata,
                bills: numBills,
                coins1000: numCoins1000,
                coins200: numCoins200,
                coins100: numCoins100
            });
            onOpenChange(false);
            setBills('');
            setCoins1000('');
            setCoins200('');
            setCoins100('');
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

                                {/* CALCULADORA DE EFECTIVO DETALLADA */}
                                <div className="space-y-4 bg-gray-50 dark:bg-white/[0.02] p-5 rounded-[2rem] border border-gray-100 dark:border-white/5">
                                    <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] italic ml-1 mb-2 block">Conteo Físico Detallado</label>
                                    
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                        <div className="space-y-1.5">
                                            <label className="text-[9px] font-black text-zinc-500 uppercase italic ml-1">Total Billetes</label>
                                            <Input
                                                type="number"
                                                placeholder="0"
                                                size="sm"
                                                variant="flat"
                                                value={bills}
                                                onValueChange={setBills}
                                                startContent={<span className="text-[10px] text-emerald-500 font-black">$</span>}
                                                classNames={{
                                                    inputWrapper: "h-11 bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl",
                                                    input: "text-xs font-black italic tabular-nums"
                                                }}
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-[9px] font-black text-zinc-500 uppercase italic ml-1">Monedas 1k/500</label>
                                            <Input
                                                type="number"
                                                placeholder="0"
                                                size="sm"
                                                variant="flat"
                                                value={coins1000}
                                                onValueChange={setCoins1000}
                                                startContent={<span className="text-[10px] text-amber-500 font-black">$</span>}
                                                classNames={{
                                                    inputWrapper: "h-11 bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl",
                                                    input: "text-xs font-black italic tabular-nums"
                                                }}
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-[9px] font-black text-zinc-500 uppercase italic ml-1">Monedas 200</label>
                                            <Input
                                                type="number"
                                                placeholder="0"
                                                size="sm"
                                                variant="flat"
                                                value={coins200}
                                                onValueChange={setCoins200}
                                                startContent={<span className="text-[10px] text-zinc-400 font-black">$</span>}
                                                classNames={{
                                                    inputWrapper: "h-11 bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl",
                                                    input: "text-xs font-black italic tabular-nums"
                                                }}
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-[9px] font-black text-zinc-500 uppercase italic ml-1">Monedas 100</label>
                                            <Input
                                                type="number"
                                                placeholder="0"
                                                size="sm"
                                                variant="flat"
                                                value={coins100}
                                                onValueChange={setCoins100}
                                                startContent={<span className="text-[10px] text-zinc-500 font-black">$</span>}
                                                classNames={{
                                                    inputWrapper: "h-11 bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl",
                                                    input: "text-xs font-black italic tabular-nums"
                                                }}
                                            />
                                        </div>
                                    </div>
                                    
                                    <div className="flex items-center justify-between px-4 py-3 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl mt-2">
                                        <span className="text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase italic">Total Efectivo Calculado</span>
                                        <span className="text-lg font-black text-emerald-600 dark:text-emerald-400 italic">
                                            ${formatCurrency((parseFloat(bills)||0) + (parseFloat(coins1000)||0) + (parseFloat(coins200)||0) + (parseFloat(coins100)||0))}
                                        </span>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

                                {(bills || coins1000 || coins200 || coins100 || nequi || daviplata) && (
                                    <div className="flex items-center justify-between p-4 rounded-2xl bg-emerald-500/5 border border-emerald-500/10 animate-in fade-in zoom-in duration-300">
                                        <div className="flex flex-col">
                                            <span className="text-[9px] font-black text-emerald-600 dark:text-emerald-500 uppercase italic">Nuevo Saldo Total Combinado</span>
                                            <span className="text-xl font-black text-gray-900 dark:text-white italic">
                                                ${formatCurrency(
                                                    (parseFloat(bills)||0) + 
                                                    (parseFloat(coins1000)||0) + 
                                                    (parseFloat(coins200)||0) + 
                                                    (parseFloat(coins100)||0) + 
                                                    (parseFloat(nequi)||0) + 
                                                    (parseFloat(daviplata)||0)
                                                )}
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
