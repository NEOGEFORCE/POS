"use client";

import {
    Modal, ModalContent, ModalHeader, ModalBody, Button, Input
} from "@heroui/react";
import { Weight, Check } from 'lucide-react';
import { validateManualWeight, FieldError } from '@/lib/formValidation';
import ValidationErrors from '@/components/ValidationErrors';
import { Product } from "@/lib/definitions";
import React from 'react';

interface ManualWeightModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    manualWeightProduct: Product | null;
    manualWeightValue: string;
    setManualWeightValue: (val: string) => void;
    confirmManualWeight: () => void;
}

export default function ManualWeightModal({
    isOpen,
    onOpenChange,
    manualWeightProduct,
    manualWeightValue,
    setManualWeightValue,
    confirmManualWeight
}: ManualWeightModalProps) {
    const [validationErrors, setValidationErrors] = React.useState<FieldError[]>([]);
    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            hideCloseButton 
            backdrop="blur" 
            classNames={{ 
                base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-[2rem]", 
                backdrop: "bg-black/60 backdrop-blur-md" 
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="p-8 border-b border-gray-100 dark:border-white/5 rounded-t-[2rem] flex items-center gap-4">
                            <div className="bg-sky-500/10 p-3 rounded-2xl text-sky-500 shadow-inner -rotate-3">
                                <Weight size={24} />
                            </div>
                            <div className="flex flex-col min-w-0">
                                <span className="text-xl font-black text-gray-900 dark:text-white uppercase italic tracking-tighter leading-none">{manualWeightProduct?.productName || 'PRODUCTO'}</span>
                                <span className="text-[9px] font-black text-sky-500 uppercase tracking-[0.3em] mt-2 not-italic">Módulo de Pesaje Manual Maestro</span>
                            </div>
                            <Button 
                                isIconOnly 
                                size="sm" 
                                variant="flat" 
                                onPress={onClose} 
                                className="ml-auto text-gray-400 hover:text-rose-500 bg-gray-50 dark:bg-zinc-900 rounded-xl h-10 w-10 transition-colors"
                            >
                                <Check size={18} />
                            </Button>
                        </ModalHeader>
                        <ModalBody className="p-8 gap-8">
                            <div className="relative w-full">
                                <Input
                                    type="number"
                                    step="0.001"
                                    value={manualWeightValue}
                                    onValueChange={setManualWeightValue}
                                    onKeyDown={(e) => e.key === 'Enter' && confirmManualWeight()}
                                    autoFocus
                                    placeholder="0.000"
                                    endContent={
                                        <div className="flex items-center gap-2 text-gray-400 dark:text-gray-500 select-none pointer-events-none">
                                            <span className="font-black italic text-xl">KG</span>
                                        </div>
                                    }
                                    classNames={{
                                        input: "text-center text-6xl font-black text-gray-900 dark:text-white h-24 tabular-nums",
                                        inputWrapper: "bg-gray-50 dark:bg-zinc-900 h-32 rounded-[2rem] border-2 border-sky-500 shadow-[0_0_30px_rgba(14,165,233,0.15)] px-8"
                                    }}
                                />
                            </div>

                            <div className="grid grid-cols-4 gap-4">
                                {[0.25, 0.5, 1.0, 2.0].map(w => (
                                    <Button
                                        key={w}
                                        className="h-14 font-black rounded-xl bg-white dark:bg-zinc-900 text-gray-700 dark:text-gray-300 hover:bg-sky-500 hover:text-white border border-gray-200 dark:border-white/5 shadow-sm transition-all uppercase italic tracking-widest text-[10px]"
                                        onPress={() => setManualWeightValue(w.toFixed(3))}
                                    >
                                        {w}kg
                                    </Button>
                                ))}
                            </div>

                            {validationErrors.length > 0 && (
                                <div className="col-span-2 mb-2">
                                    <ValidationErrors errors={validationErrors} />
                                </div>
                            )}
                            <Button
                                className="w-full h-16 rounded-[2rem] font-black uppercase tracking-widest text-base bg-emerald-600 hover:bg-emerald-500 text-white shadow-xl shadow-emerald-500/20 transition-all active:scale-95 italic"
                                onPress={() => {
                                    const result = validateManualWeight(manualWeightValue);
                                    if (!result.isValid) {
                                        setValidationErrors(result.errors);
                                        return;
                                    }
                                    setValidationErrors([]);
                                    confirmManualWeight();
                                }}
                            >
                                AÑADIR AL COMPROBANTE
                            </Button>
                        </ModalBody>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
