"use client";

import React, { memo, useState } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input
} from "@heroui/react";
import { LayoutGrid, Sparkles, X, Shapes, ShieldCheck } from 'lucide-react';
import { Category } from '@/lib/definitions';
import { validateCategory, FieldError } from '@/lib/formValidation';
import ValidationErrors from '@/components/ValidationErrors';
import { useToast } from '@/hooks/use-toast';

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
  const [isSaving, setIsSaving] = useState(false);
  const [validationErrors, setValidationErrors] = useState<FieldError[]>([]);
  const { toast } = useToast();

  const handleCustomSave = async () => {
    const result = validateCategory({ name: categoryName });
    if (!result.isValid) {
      setValidationErrors(result.errors);
      return;
    }
    setValidationErrors([]);
    setIsSaving(true);
    try {
      await onSave();
    } catch (error: any) {
      console.error(error);
      toast({ variant: 'destructive', title: 'ERROR', description: error?.message || 'FALLO AL GUARDAR CATEGORÍA' });
    } finally {
      setIsSaving(false);
    }
  };

  // SYNCED STYLES WITH USERMODALS.TSX + CONTRAST IMPROVEMENTS
  const commonInputClasses = {
    label: "absolute z-10 pointer-events-none origin-top-left shrink-0 rtl:origin-top-right subpixel-antialiased block cursor-text will-change-auto !duration-200 !ease-out motion-reduce:transition-none transition-[transform,color,left,opacity,translate,scale] group-data-[filled-within=true]:text-default-600 group-data-[filled-within=true]:pointer-events-auto group-data-[filled-within=true]:scale-85 group-data-[filled-within=true]:-translate-y-[calc(50%_+_var(--heroui-font-size-small)/2_-_6px)] pe-2 max-w-full text-ellipsis overflow-hidden text-[9px] md:text-[10px] font-black text-gray-500 dark:text-zinc-400 uppercase tracking-widest",
    inputWrapper: "relative w-full inline-flex tap-highlight-transparent shadow-xs data-[hover=true]:bg-default-200 group-data-[focus=true]:bg-default-100 min-h-10 flex-col items-start justify-center gap-0 motion-reduce:transition-none !duration-150 outline-solid outline-transparent group-data-[focus-visible=true]:z-10 group-data-[focus-visible=true]:ring-2 group-data-[focus-visible=true]:ring-focus group-data-[focus-visible=true]:ring-offset-2 group-data-[focus-visible=true]:ring-offset-background py-2 h-14 md:h-18 md:min-h-[72px] px-6 bg-gray-50/80 dark:bg-black/40 border-2 border-gray-200/50 dark:border-white/10 transition-all shadow-sm rounded-2xl focus-within:!border-emerald-500/40 focus-within:bg-white dark:focus-within:bg-zinc-900",
    input: "w-full bg-transparent font-black text-sm md:text-base uppercase italic text-gray-900 dark:text-white pr-4 pt-1"
  };

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange} 
      backdrop="blur" 
      size="2xl" 
      classNames={{ 
        base: "bg-white/95 dark:bg-zinc-950/95 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-visible mx-2 md:mx-0",
        wrapper: "items-start sm:items-center mt-12 sm:mt-0 justify-center",
        closeButton: "absolute right-5 top-5 text-gray-400 dark:text-zinc-500 hover:text-rose-500 transition-colors z-[100] rounded-full",
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="px-5 md:px-12 py-6 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-t-[2rem]">
              <div className="flex flex-col min-w-0">
                <h2 className="text-xl md:text-2xl font-black text-gray-900 dark:text-white uppercase tracking-tight italic leading-none">
                  {isEdit ? "Gestión de Categoría" : "Nueva Categoría"}
                </h2>
                <p className="text-[10px] font-black text-emerald-500 uppercase tracking-widest mt-2 flex items-center gap-2">
                  <ShieldCheck size={12} /> PROTOCOLO TAXONÓMICO
                </p>
              </div>
            </ModalHeader>

            <ModalBody className="px-5 md:px-12 py-8 md:py-10">
              <div className="flex flex-col md:flex-row items-center gap-6 md:gap-8">
                {/* LOGO GIGANTE LADO A LADO - REDUCIDO */}
                <div className="h-16 w-16 md:h-20 md:w-20 bg-emerald-500 flex items-center justify-center text-white rounded-2xl shadow-xl shadow-emerald-500/30 transform -rotate-3 hover:rotate-0 transition-all duration-500 shrink-0">
                  <LayoutGrid size={32} className="md:size-10" strokeWidth={1.5} />
                </div>
                
                <div className="flex-1 w-full flex flex-col gap-6">
                  <Input
                    autoFocus
                    label="ETIQUETA DEL DEPARTAMENTO"
                    labelPlacement="inside"
                    placeholder="E.G. BEBIDAS, SNACKS..."
                    value={categoryName}
                    onValueChange={(v) => setCategoryName(v.toUpperCase())}
                    onKeyDown={(e) => e.key === 'Enter' && handleCustomSave()}
                    classNames={commonInputClasses}
                    startContent={<Shapes size={22} className="text-emerald-500 mr-3" />}
                  />
                  <p className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic px-2">
                    * El nombre se normalizará automáticamente a mayúsculas para mantener la integridad del catálogo.
                  </p>
                </div>
              </div>
            </ModalBody>

            <ModalFooter className="px-5 md:px-12 py-4 md:py-6 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-b-[2rem]">
              {validationErrors.length > 0 && (
                <div className="w-full mb-3">
                  <ValidationErrors errors={validationErrors} />
                </div>
              )}
              <div className="flex w-full gap-3 md:gap-4">
                <Button
                  variant="flat"
                  className="flex-1 h-12 md:h-14 rounded-xl font-black uppercase text-[10px] bg-white dark:bg-zinc-900 text-gray-400 dark:text-zinc-500 border border-gray-200 dark:border-white/10 italic tracking-widest hover:bg-emerald-500/10 hover:text-emerald-500 transition-all opacity-70 hover:opacity-100"
                  onPress={onClose}
                >
                  DESCARTAR
                </Button>
                <Button
                  isLoading={isSaving}
                  onPress={handleCustomSave}
                  className="flex-[2] h-12 md:h-14 bg-emerald-500 text-white font-black uppercase text-[11px] md:text-base tracking-widest rounded-xl transition-all shadow-xl shadow-emerald-500/20 hover:scale-[1.02] active:scale-95 italic group"
                >
                  <Sparkles size={20} className="md:size-6 mr-2 md:mr-3 group-hover:rotate-12 transition-transform" />
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
