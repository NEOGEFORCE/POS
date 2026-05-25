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
                base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-[2.5rem]",
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
                                <div className="h-12 w-12 bg-white/5 text-zinc-900 dark:text-zinc-100 rounded-2xl flex items-center justify-center border border-emerald-500/20 shadow-inner">
                                    <ShieldCheck size={24} />
                                </div>
                                <div className="flex flex-col">
                                    <h3 className="font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tighter text-xl">Auditoría de <span className="text-zinc-900 dark:text-zinc-100">Caja</span></h3>
                                    <p className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest tracking-tight">Sincronización de Saldo Real</p>
                                </div>
                            </div>
                        </ModalHeader>
                        <ModalBody>
                            <div className="space-y-6">
                                <div className="p-4 rounded-2xl bg-amber-500/5 border border-amber-500/10 flex gap-3">
                                    <AlertCircle className="text-amber-500 shrink-0" size={18} />
                                    <p className="text-[11px] text-amber-700 dark:text-amber-400 font-medium leading-relaxed tracking-tight">
                                        Introduce el total de dinero físico y digital disponible actualmente. Esto reseteará la diferencia a <span className="font-medium">$0</span> y establecerá un nuevo punto de partida.
                                    </p>
                                </div>

                                {/* CALCULADORA DE EFECTIVO DETALLADA */}
                                <div className="space-y-4 bg-gray-50 dark:bg-white/[0.02] p-5 rounded-[2rem] border border-gray-100 dark:border-white/5">
                                    <label className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] tracking-tight ml-1 mb-2 block">Conteo Físico Detallado</label>
                                    
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                        <div className="space-y-1.5">
                                            <label className="text-[9px] font-medium text-zinc-500 uppercase tracking-tight ml-1">Total Billetes</label>
                                            <Input
                                                type="number"
                                                placeholder="0"
                                                size="sm"
                                                variant="flat"
                                                value={bills}
                                                onValueChange={setBills}
                                                startContent={<span className="text-[10px] text-zinc-900 dark:text-zinc-100 font-medium">$</span>}
                                                classNames={{
                                                    inputWrapper: "h-11 card-base border-none border border-gray-200 dark:border-white/10 rounded-2xl",
                                                    input: "text-xs font-medium tracking-tight tabular-nums"
                                                }}
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-[9px] font-medium text-zinc-500 uppercase tracking-tight ml-1">Monedas 1k/500</label>
                                            <Input
                                                type="number"
                                                placeholder="0"
                                                size="sm"
                                                variant="flat"
                                                value={coins1000}
                                                onValueChange={setCoins1000}
                                                startContent={<span className="text-[10px] text-amber-500 font-medium">$</span>}
                                                classNames={{
                                                    inputWrapper: "h-11 card-base border-none border border-gray-200 dark:border-white/10 rounded-2xl",
                                                    input: "text-xs font-medium tracking-tight tabular-nums"
                                                }}
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-[9px] font-medium text-zinc-500 uppercase tracking-tight ml-1">Monedas 200</label>
                                            <Input
                                                type="number"
                                                placeholder="0"
                                                size="sm"
                                                variant="flat"
                                                value={coins200}
                                                onValueChange={setCoins200}
                                                startContent={<span className="text-[10px] text-zinc-500 dark:text-zinc-400 font-medium">$</span>}
                                                classNames={{
                                                    inputWrapper: "h-11 card-base border-none border border-gray-200 dark:border-white/10 rounded-2xl",
                                                    input: "text-xs font-medium tracking-tight tabular-nums"
                                                }}
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-[9px] font-medium text-zinc-500 uppercase tracking-tight ml-1">Monedas 100</label>
                                            <Input
                                                type="number"
                                                placeholder="0"
                                                size="sm"
                                                variant="flat"
                                                value={coins100}
                                                onValueChange={setCoins100}
                                                startContent={<span className="text-[10px] text-zinc-500 font-medium">$</span>}
                                                classNames={{
                                                    inputWrapper: "h-11 card-base border-none border border-gray-200 dark:border-white/10 rounded-2xl",
                                                    input: "text-xs font-medium tracking-tight tabular-nums"
                                                }}
                                            />
                                        </div>
                                    </div>
                                    
                                    <div className="flex items-center justify-between px-4 py-3 bg-white/5 border border-emerald-500/20 rounded-2xl mt-2">
                                        <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 uppercase tracking-tight">Total Efectivo Calculado</span>
                                        <span className="text-lg font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-300 tracking-tight">
                                            ${formatCurrency((parseFloat(bills)||0) + (parseFloat(coins1000)||0) + (parseFloat(coins200)||0) + (parseFloat(coins100)||0))}
                                        </span>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] tracking-tight ml-1">Saldo Nequi</label>
                                        <Input
                                            type="number"
                                            placeholder="0.00"
                                            variant="flat"
                                            value={nequi}
                                            onValueChange={setNequi}
                                            startContent={<span className="text-purple-500 font-medium">$</span>}
                                            classNames={{
                                                inputWrapper: "h-14 bg-gray-100 dark:bg-[#18181b] border-2 border-transparent group-data-[focus=true]:border-purple-500 transition-all rounded-2xl px-4 shadow-inner",
                                                input: "text-lg font-medium tracking-tight tracking-tighter placeholder:text-gray-300 dark:placeholder:text-zinc-700"
                                            }}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] tracking-tight ml-1">Saldo Daviplata</label>
                                        <Input
                                            type="number"
                                            placeholder="0.00"
                                            variant="flat"
                                            value={daviplata}
                                            onValueChange={setDaviplata}
                                            startContent={<span className="text-rose-500 font-medium">$</span>}
                                            classNames={{
                                                inputWrapper: "h-14 bg-gray-100 dark:bg-[#18181b] border-2 border-transparent group-data-[focus=true]:border-rose-500 transition-all rounded-2xl px-4 shadow-inner",
                                                input: "text-lg font-medium tracking-tight tracking-tighter placeholder:text-gray-300 dark:placeholder:text-zinc-700"
                                            }}
                                        />
                                    </div>
                                </div>

                                {(bills || coins1000 || coins200 || coins100 || nequi || daviplata) && (
                                    <div className="flex items-center justify-between p-4 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 border border-emerald-500/10 animate-in fade-in zoom-in duration-300">
                                        <div className="flex flex-col">
                                            <span className="text-[9px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 uppercase tracking-tight">Nuevo Saldo Total Combinado</span>
                                            <span className="text-xl font-medium text-zinc-900 dark:text-zinc-50 tracking-tight">
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
                                        <TrendingUp className="text-zinc-900 dark:text-zinc-100" size={24} />
                                    </div>
                                )}
                            </div>
                        </ModalBody>
                        <ModalFooter>
                            <Button 
                                variant="light" 
                                onPress={onClose}
                                className="font-medium uppercase text-[10px] tracking-widest rounded-2xl px-6 h-12"
                            >
                                Cancelar
                            </Button>
                            <Button 
                                color="success"
                                onPress={handleConfirm}
                                isLoading={isSubmitting}
                                className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white font-medium uppercase text-[10px] tracking-widest rounded-2xl px-8 h-12 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 transition-all"
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
