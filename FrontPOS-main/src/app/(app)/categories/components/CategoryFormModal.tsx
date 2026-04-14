"use client";

import React, { memo } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input
} from "@heroui/react";
import { LayoutGrid, Sparkles, X, Shapes } from 'lucide-react';
import { Category } from '@/lib/definitions';

interface FormModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  isEdit: boolean;
  categoryName: string;
  setCategoryName: (name: string) => void;
  onSave: () => Promise<void>;
}

const CategoryFormModal = memo(({ 
  isOpen, 
  onOpenChange, 
  isEdit, 
  categoryName, 
  setCategoryName, 
  onSave 
}: FormModalProps) => {
  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange} 
      backdrop="blur" 
      size="md" 
      classNames={{ 
        base: "bg-white dark:bg-zinc-950 rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-visible", 
        closeButton: "hover:bg-rose-500/10 hover:text-rose-500 transition-colors" 
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1 p-10 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-t-[2.5rem]">
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 bg-emerald-500/10 text-emerald-500 flex items-center justify-center rounded-2xl shadow-inner rotate-3">
                  <LayoutGrid size={32} />
                </div>
                <div className="flex flex-col min-w-0">
                  <h2 className="text-2xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none">
                    {isEdit ? "Modificar" : "Nueva"} <span className="text-emerald-500">Categoría</span>
                  </h2>
                  <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.3em] mt-2 not-italic">Taxonomía Maestra de Stock</span>
                </div>
              </div>
            </ModalHeader>

            <ModalBody className="p-10">
              <div className="space-y-6">
                <div className="space-y-3">
                  <div className="flex items-center gap-2 mb-1 ml-1">
                    <Shapes size={14} className="text-emerald-500" />
                    <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">Etiqueta del Departamento</label>
                  </div>
                  <Input
                    autoFocus
                    placeholder="E.G. BEBIDAS, SNACKS, CIGARRILLOS..."
                    value={categoryName}
                    onValueChange={(v) => setCategoryName(v.toUpperCase())}
                    onKeyDown={(e) => e.key === 'Enter' && onSave()}
                    classNames={{ 
                      inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-emerald-500 shadow-inner transition-all", 
                      input: "font-black text-base uppercase italic text-gray-900 dark:text-white bg-transparent placeholder:text-gray-300 dark:placeholder:text-zinc-700" 
                    }}
                  />
                </div>
              </div>
            </ModalBody>

            <ModalFooter className="p-10 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-b-[2.5rem]">
              <div className="flex w-full gap-4">
                <Button
                  variant="flat"
                  className="flex-1 h-14 rounded-2xl font-black uppercase text-[10px] bg-white dark:bg-zinc-900 text-gray-400 border border-gray-200 dark:border-white/10 italic tracking-widest"
                  onPress={onClose}
                >
                  DESCARTAR <X size={16} className="ml-1" />
                </Button>
                <Button
                  className="flex-[2] h-20 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-xs tracking-[0.2em] rounded-3xl transition-all shadow-xl hover:scale-105 active:scale-95 italic ring-4 ring-black/5 dark:ring-white/5"
                  onPress={onSave}
                >
                  <Sparkles size={24} className="mr-3" />
                  {isEdit ? "GUARDAR CAMBIOS" : "ESTABLECER DEP."}
                </Button>
              </div>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>

  );
});

CategoryFormModal.displayName = 'CategoryFormModal';
export default CategoryFormModal;
