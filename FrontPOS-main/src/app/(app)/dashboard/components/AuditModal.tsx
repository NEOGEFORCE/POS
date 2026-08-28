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
    const [coins, setCoins] = useState<string>('');
    const [nequi, setNequi] = useState<string>('');
    const [daviplata, setDaviplata] = useState<string>('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const numBills = parseFloat(bills) || 0;
    const numCoins = parseFloat(coins) || 0;
    const numCashTotal = numBills + numCoins;
    const numNequi = parseFloat(nequi) || 0;
    const numDaviplata = parseFloat(daviplata) || 0;
    const numDigitalTotal = numNequi + numDaviplata;
    const numGrandTotal = numCashTotal + numDigitalTotal;

    const handleConfirm = async () => {
        setIsSubmitting(true);
        try {
            await onConfirm({ 
                cash: numCashTotal,
                bills: numBills,
                coins1000: numCoins,
                nequi: numNequi, 
                daviplata: numDaviplata
            });
            onOpenChange(false);
            setBills('');
            setCoins('');
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
                header: "border-b border-gray-100 dark:border-white/5 p-8 pb-4",
                body: "p-8",
                footer: "border-t border-gray-100 dark:border-white/5 p-6 bg-gray-50/50 dark:bg-white/[0.02]"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1">
                            <div className="flex items-center gap-4">
                                <div className="h-12 w-12 bg-black/5 dark:bg-white/5 text-zinc-900 dark:text-zinc-100 rounded-2xl flex items-center justify-center border border-emerald-500/20 shadow-inner">
                                    <ShieldCheck size={24} />
                                </div>
                                <div className="flex flex-col">
                                    <h3 className="font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tighter text-xl">Auditoría de <span className="text-zinc-900 dark:text-zinc-100">Caja</span></h3>
                                    <p className="text-[10px] font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-widest tracking-tight">Sincronización de Saldo Real</p>
                                </div>
                            </div>
                        </ModalHeader>
                        <ModalBody>
                            <div className="space-y-5">
                                <div className="p-3.5 rounded-2xl bg-amber-500/5 border border-amber-500/10 flex gap-3">
                                    <AlertCircle className="text-amber-500 shrink-0 mt-0.5" size={16} />
                                    <p className="text-[11px] text-amber-700 dark:text-amber-400 font-medium leading-relaxed tracking-tight">
                                        Introduce el dinero físico (billetes y monedas) y los saldos digitales actuales para establecer un nuevo punto de partida exacto.
                                    </p>
                                </div>

                                {/* CONTEO FÍSICO: BILLETES Y MONEDAS APARTE */}
                                <div className="space-y-3 bg-gray-50 dark:bg-white/[0.02] p-4 rounded-2xl border border-gray-100 dark:border-white/5">
                                    <div className="flex items-center justify-between">
                                        <label className="text-[10px] font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-widest block">
                                            1. Conteo Físico
                                        </label>
                                        {numCashTotal > 0 && (
                                            <span className="text-[11px] font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
                                                Subtotal Físico: ${formatCurrency(numCashTotal)}
                                            </span>
                                        )}
                                    </div>
                                    
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <label className="text-[9px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-tight ml-1">Billetes en Mano</label>
                                            <Input
                                                type="number"
                                                placeholder="0"
                                                variant="flat"
                                                value={bills}
                                                onValueChange={setBills}
                                                startContent={<span className="text-[11px] text-emerald-600 font-bold">$</span>}
                                                classNames={{
                                                    inputWrapper: "h-12 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-xl",
                                                    input: "text-base font-bold tabular-nums"
                                                }}
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-[9px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-tight ml-1">Monedas Alcancía</label>
                                            <Input
                                                type="number"
                                                placeholder="0"
                                                variant="flat"
                                                value={coins}
                                                onValueChange={setCoins}
                                                startContent={<span className="text-[11px] text-amber-600 font-bold">$</span>}
                                                classNames={{
                                                    inputWrapper: "h-12 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-xl",
                                                    input: "text-base font-bold tabular-nums"
                                                }}
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* BILLETERAS DIGITALES: NEQUI Y DAVIPLATA APARTE */}
                                <div className="space-y-3 bg-gray-50 dark:bg-white/[0.02] p-4 rounded-2xl border border-gray-100 dark:border-white/5">
                                    <div className="flex items-center justify-between">
                                        <label className="text-[10px] font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-widest block">
                                            2. Billeteras Digitales
                                        </label>
                                        {numDigitalTotal > 0 && (
                                            <span className="text-[11px] font-black text-purple-600 dark:text-purple-400 tabular-nums">
                                                Subtotal Digital: ${formatCurrency(numDigitalTotal)}
                                            </span>
                                        )}
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <label className="text-[9px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-tight ml-1">Saldo Nequi</label>
                                            <Input
                                                type="number"
                                                placeholder="0"
                                                variant="flat"
                                                value={nequi}
                                                onValueChange={setNequi}
                                                startContent={<span className="text-purple-500 font-bold">$</span>}
                                                classNames={{
                                                    inputWrapper: "h-12 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-xl",
                                                    input: "text-base font-bold tabular-nums"
                                                }}
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-[9px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-tight ml-1">Saldo Daviplata</label>
                                            <Input
                                                type="number"
                                                placeholder="0"
                                                variant="flat"
                                                value={daviplata}
                                                onValueChange={setDaviplata}
                                                startContent={<span className="text-rose-500 font-bold">$</span>}
                                                classNames={{
                                                    inputWrapper: "h-12 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-xl",
                                                    input: "text-base font-bold tabular-nums"
                                                }}
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* TOTAL GENERAL COMBINADO */}
                                {numGrandTotal > 0 && (
                                    <div className="flex items-center justify-between p-4 rounded-2xl bg-zinc-900 dark:bg-zinc-900 border border-emerald-500/30 text-white animate-in fade-in zoom-in duration-300">
                                        <div className="flex flex-col">
                                            <span className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">Nuevo Total Guardado (Físico + Digital)</span>
                                            <span className="text-2xl font-black text-emerald-400 tracking-tight tabular-nums">
                                                ${formatCurrency(numGrandTotal)}
                                            </span>
                                        </div>
                                        <TrendingUp className="text-emerald-400" size={24} />
                                    </div>
                                )}
                            </div>
                        </ModalBody>
                        <ModalFooter>
                            <Button 
                                variant="light" 
                                onPress={onClose}
                                className="font-bold uppercase text-[10px] tracking-widest rounded-xl px-6 h-11"
                            >
                                Cancelar
                            </Button>
                            <Button 
                                color="success"
                                onPress={handleConfirm}
                                isLoading={isSubmitting}
                                className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold uppercase text-[10px] tracking-widest rounded-xl px-7 h-11 shadow-md shadow-emerald-600/20 active:scale-95 transition-all"
                            >
                                <Calculator size={16} className="mr-1.5" />
                                Guardar Ajuste
                            </Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
