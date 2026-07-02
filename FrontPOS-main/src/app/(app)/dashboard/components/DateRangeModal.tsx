"use client";

import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button } from "@heroui/react";
import { Calendar, Download } from "lucide-react";
import React from 'react';
import { PremiumDateInput } from "@/components/ui/premium-date-input";

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
                base: "bg-white dark:bg-zinc-950 border-2 border-emerald-500/20 rounded-[2rem] shadow-[0_8px_30px_rgb(0,0,0,0.12)]",
                header: "border-b border-gray-100 dark:border-white/5 p-8",
                footer: "border-t border-gray-100 dark:border-white/5 p-8"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1">
                            <div className="flex items-center gap-4">
                                <div className="p-3 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 shadow-[0_8px_30px_rgb(0,0,0,0.12)] -rotate-3">
                                    <Calendar size={22} />
                                </div>
                                <div className="flex flex-col">
                                    <h3 className="text-2xl font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tighter leading-none">Selector <span className="text-zinc-900 dark:text-zinc-100">Maestro</span></h3>
                                    <p className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.3em] mt-2 tracking-tight">Rango de Auditoria Temporal</p>
                                </div>
                            </div>
                        </ModalHeader>
                        <ModalBody className="p-8 py-10">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <PremiumDateInput
                                    type="datetime-local"
                                    label="Desde (Apertura)"
                                    value={startDate}
                                    onChange={onSetStartDate}
                                    accent="emerald"
                                    size="lg"
                                    showFormatted
                                />
                                <PremiumDateInput
                                    type="datetime-local"
                                    label="Hasta (Cierre)"
                                    value={endDate}
                                    onChange={onSetEndDate}
                                    accent="emerald"
                                    size="lg"
                                    showFormatted
                                />
                            </div>
                        </ModalBody>
                        <ModalFooter className="flex gap-3">
                            <Button
                                variant="flat"
                                onPress={onClose}
                                className="font-medium text-[11px] uppercase tracking-[0.2em] text-gray-500 dark:text-zinc-400 bg-gray-100 dark:bg-[#18181b] h-14 px-8 rounded-2xl tracking-tight"
                            >
                                Cancelar
                            </Button>
                            <Button
                                color="primary"
                                onPress={onDownloadRange}
                                startContent={<Download size={18} />}
                                className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 hover:bg-zinc-50 dark:hover:bg-white/5 bg-white dark:bg-transparent border border-zinc-200 dark:border-white/5 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 dark:hover:bg-white/5 dark:bg-transparent border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 font-medium text-[11px] uppercase tracking-[0.2em] h-14 px-8 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] tracking-tight"
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
