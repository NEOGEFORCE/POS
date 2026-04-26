"use client";

import React, { memo } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button
} from "@heroui/react";
import { Trash2, AlertTriangle, X } from 'lucide-react';

interface DeleteModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}

const DeleteCategoryModal = memo(({ 
  isOpen, 
  onOpenChange, 
  onConfirm 
}: DeleteModalProps) => {
  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange} 
      placement="top"
      backdrop="blur" 
      size="md"
      classNames={{ 
        base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-2xl rounded-[2.5rem] mx-2 md:mx-0",
        wrapper: "items-start sm:items-center mt-12 sm:mt-0 justify-center",
        closeButton: "hover:bg-rose-500/10 hover:text-rose-500 transition-colors z-50 rounded-full"
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex items-center gap-4 px-6 md:px-10 py-5 border-b border-gray-100 dark:border-white/5 rounded-t-[2.5rem] bg-gray-50/50 dark:bg-zinc-900/50">
              <div className="bg-rose-500/10 p-4 rounded-2xl text-rose-500 shadow-inner -rotate-3 text-rose-500 flex items-center justify-center">
                <Trash2 size={28} />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-xl font-black text-gray-900 dark:text-white uppercase italic tracking-tighter leading-none">Protocolo de Purga</span>
                <span className="text-[10px] font-black text-rose-500 uppercase tracking-[0.3em] mt-3 not-italic">Categoría Maestra</span>
              </div>
            </ModalHeader>
            <ModalBody className="p-6 md:p-10 flex flex-col items-center text-center gap-6">
              <div className="h-20 w-20 bg-rose-500/5 rounded-full flex items-center justify-center text-rose-500 animate-pulse ring-8 ring-rose-500/5">
                <AlertTriangle size={40} />
              </div>
              <p className="text-sm md:text-base font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-widest leading-relaxed italic px-4">
                ¿Confirma la eliminación definitiva? <br/>
                <span className="text-rose-500 font-black">Los productos asociados podrían perder su jerarquía en el sistema.</span>
              </p>
            </ModalBody>
            <ModalFooter className="px-6 md:px-10 py-6 border-t border-gray-100 dark:border-white/5 flex gap-4 rounded-b-[2.5rem] bg-gray-50/50 dark:bg-zinc-900/50">
              <Button 
                variant="flat" 
                className="flex-1 h-12 rounded-xl font-black uppercase text-[10px] bg-gray-100 dark:bg-zinc-900 text-gray-400 dark:text-zinc-500 hover:bg-gray-200 dark:hover:bg-zinc-800 italic tracking-widest transition-all" 
                onPress={onClose}
              >
                DESCARTAR <X size={16} className="ml-2" />
              </Button>
              <Button 
                color="danger" 
                className="flex-1 h-12 rounded-xl font-black uppercase text-[10px] shadow-xl shadow-rose-500/20 italic tracking-widest hover:scale-[1.02] active:scale-95 transition-all bg-rose-500 text-white" 
                onPress={onConfirm}
              >
                SÍ, PURGAR
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
});

DeleteCategoryModal.displayName = 'DeleteCategoryModal';
export default DeleteCategoryModal;
