"use client";

import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input } from "@heroui/react";
import { Calendar, Download } from "lucide-react";
import React from 'react';

interface DateRangeModalProps {
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;
    startDate: string;
    endDate: string;
    onSetStartDate: (val: string) => void;
    onSetEndDate: (val: string) => void;
    onDownloadRange: () => void;
}

export default function DateRangeModal({
    isOpen,
    onOpenChange,
    startDate,
    endDate,
    onSetStartDate,
    onSetEndDate,
    onDownloadRange
}: DateRangeModalProps) {
    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            size="lg"
            placement="center" 
            backdrop="blur"
            classNames={{
                base: "bg-white dark:bg-zinc-950 border-2 border-emerald-500/20 rounded-[2rem] shadow-2xl",
                header: "border-b border-gray-100 dark:border-white/5 p-8",
                footer: "border-t border-gray-100 dark:border-white/5 p-8"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1">
                            <div className="flex items-center gap-4">
                                <div className="p-3 rounded-2xl bg-emerald-500 text-white shadow-lg shadow-emerald-500/20 -rotate-3">
                                    <Calendar size={22} />
                                </div>
                                <div className="flex flex-col">
                                    <h3 className="text-2xl font-black text-gray-900 dark:text-white uppercase italic tracking-tighter leading-none">Selector <span className="text-emerald-500">Maestro</span></h3>
                                    <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.3em] mt-2 italic">Rango de Auditoría Temporal</p>
                                </div>
                            </div>
                        </ModalHeader>
                        <ModalBody className="p-8 py-10">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="space-y-2 text-left">
                                    <label className="text-[10px] font-black uppercase tracking-widest text-emerald-600/60 dark:text-emerald-500/50 ml-1 italic">Desde (Apertura)</label>
                                    <Input
                                        type="datetime-local"
                                        aria-label="Fecha Inicial"
                                        value={startDate}
                                        onChange={(e) => onSetStartDate(e.target.value)}
                                        variant="flat"
                                        classNames={{
                                            input: "text-xs font-black uppercase italic",
                                            inputWrapper: "h-14 bg-gray-50 dark:bg-white/5 border-2 border-transparent focus-within:border-emerald-500/50 transition-all rounded-2xl shadow-inner"
                                        }}
                                    />
                                </div>
                                <div className="space-y-2 text-left">
                                    <label className="text-[10px] font-black uppercase tracking-widest text-emerald-600/60 dark:text-emerald-500/50 ml-1 italic">Hasta (Cierre)</label>
                                    <Input
                                        type="datetime-local"
                                        aria-label="Fecha Final"
                                        value={endDate}
                                        onChange={(e) => onSetEndDate(e.target.value)}
                                        variant="flat"
                                        classNames={{
                                            input: "text-xs font-black uppercase italic",
                                            inputWrapper: "h-14 bg-gray-50 dark:bg-white/5 border-2 border-transparent focus-within:border-emerald-500/50 transition-all rounded-2xl shadow-inner"
                                        }}
                                    />
                                </div>
                            </div>
                        </ModalBody>
                        <ModalFooter className="flex gap-3">
                            <Button
                                variant="flat"
                                onPress={onClose}
                                className="font-black text-[11px] uppercase tracking-[0.2em] text-gray-500 dark:text-zinc-400 bg-gray-100 dark:bg-zinc-900 h-14 px-8 rounded-2xl italic"
                            >
                                Cancelar
                            </Button>
                            <Button
                                color="primary"
                                onPress={onDownloadRange}
                                startContent={<Download size={18} />}
                                className="bg-emerald-500 hover:bg-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white font-black text-[11px] uppercase tracking-[0.2em] h-14 px-8 rounded-2xl shadow-xl shadow-emerald-500/30 italic"
                            >
                                Generar Reporte
                            </Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
