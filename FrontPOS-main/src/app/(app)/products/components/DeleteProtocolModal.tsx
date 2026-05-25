"use client";

import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button } from "@heroui/react";
import { AlertTriangle } from 'lucide-react';

interface DeleteProtocolModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    deletingBarcode: string | null;
    onDelete: () => void;
}

export default function DeleteProtocolModal({ isOpen, onOpenChange, deletingBarcode, onDelete }: DeleteProtocolModalProps) {
    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            placement="top"
            backdrop="blur" 
            classNames={{ 
                base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] mx-2 md:mx-0", 
                wrapper: "items-start sm:items-center mt-12 sm:mt-0 justify-center",
                closeButton: "text-gray-400 hover:text-rose-500 transition-colors" 
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="text-rose-500 font-medium uppercase text-xl p-8 pb-4 tracking-tight flex items-center gap-4 rounded-t-[2rem]">
                            <div className="p-3 bg-rose-50 dark:bg-rose-500/10 rounded-2xl shadow-inner -rotate-3">
                                <AlertTriangle size={24} />
                            </div> 
                            <div className="flex flex-col">
                                <span className="text-xl font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tighter leading-none">Protocolo de Purga</span>
                                <span className="text-[9px] font-medium text-rose-500 uppercase tracking-[0.3em] mt-2 not-tracking-tight">Vault Maestro de Inventario</span>
                            </div>
                        </ModalHeader>
                        <ModalBody className="px-8 pb-8 text-center text-sm font-bold text-gray-500 dark:text-zinc-400 uppercase leading-relaxed tracking-widest tracking-tight">
                            ¿Seguro que desea eliminar permanentemente la referencia <span className="text-rose-500 font-mono">#{deletingBarcode}</span>?
                        </ModalBody>
                        <ModalFooter className="p-8 border-t border-gray-100 dark:border-white/5 flex gap-4 rounded-b-[2rem]">
                            <Button 
                                variant="flat" 
                                className="flex-1 h-14 rounded-2xl font-medium text-[10px] tracking-widest bg-gray-50 dark:bg-[#18181b] text-gray-400 uppercase tracking-tight" 
                                onPress={onClose}
                            >
                                DESCARTAR
                            </Button>
                            <Button 
                                color="danger" 
                                className="flex-1 h-14 rounded-2xl font-medium text-[10px] tracking-widest shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20 uppercase tracking-tight" 
                                onPress={() => {
                                    onDelete();
                                    onClose();
                                }}
                            >
                                SÍ, PURGAR
                            </Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
