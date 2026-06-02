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
  marginPercentage?: number;
  setMarginPercentage?: (margin: number) => void;
  onSave: () => Promise<void>;
}

const CategoryFormModal = memo(({ 
  isOpen, 
  onOpenChange, 
  isEdit, 
  categoryName, 
  setCategoryName,
  marginPercentage,
  setMarginPercentage,
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
      toast({ variant: 'destructive', title: 'ERROR', description: error?.message || 'FALLO AL GUARDAR CATEGORIA' });
    } finally {
      setIsSaving(false);
    }
  };

  // SYNCED STYLES WITH USERMODALS.TSX + CONTRAST IMPROVEMENTS
  const commonInputClasses = {
    label: "absolute z-10 pointer-events-none origin-top-left shrink-0 rtl:origin-top-right subpixel-antialiased block cursor-text will-change-auto !duration-200 !ease-out motion-reduce:transition-none transition-[transform,color,left,opacity,translate,scale] group-data-[filled-within=true]:text-default-600 group-data-[filled-within=true]:pointer-events-auto group-data-[filled-within=true]:scale-85 group-data-[filled-within=true]:-translate-y-[calc(50%_+_var(--heroui-font-size-small)/2_-_6px)] pe-2 max-w-full text-ellipsis overflow-hidden text-[9px] md:text-[10px] font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-widest",
    inputWrapper: "relative w-full inline-flex tap-highlight-transparent shadow-xs data-[hover=true]:bg-default-200 group-data-[focus=true]:bg-default-100 min-h-10 flex-col items-start justify-center gap-0 motion-reduce:transition-none !duration-150 outline-solid outline-transparent group-data-[focus-visible=true]:z-10 group-data-[focus-visible=true]:ring-2 group-data-[focus-visible=true]:ring-focus group-data-[focus-visible=true]:ring-offset-2 group-data-[focus-visible=true]:ring-offset-background py-2 h-14 md:h-18 md:min-h-[72px] px-6 bg-gray-50/80 dark:bg-[#18181b] border-2 border-gray-200/50 dark:border-white/10 transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl focus-within:!border-emerald-500/40 focus-within:bg-white dark:focus-within:bg-[#18181b]",
    input: "w-full bg-transparent font-medium text-sm md:text-base uppercase tracking-tight text-zinc-900 dark:text-zinc-50 pr-4 pt-1"
  };

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange} 
      backdrop="blur" 
      size="2xl" 
      classNames={{ 
        base: "bg-white/95 dark:bg-zinc-950/95 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-visible mx-2 md:mx-0",
        wrapper: "items-start sm:items-center mt-12 sm:mt-0 justify-center",
        closeButton: "absolute right-5 top-5 text-zinc-500 dark:text-zinc-400 hover:text-rose-500 transition-colors z-[100] rounded-2xl",
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="px-5 md:px-12 py-6 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-[#18181b]/50 rounded-t-[2rem]">
              <div className="flex flex-col min-w-0">
                <h2 className="text-xl md:text-2xl font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tight leading-none">
                  {isEdit ? "Gestion de Categoria" : "Nueva Categoria"}
                </h2>
                <p className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-widest mt-2 flex items-center gap-2">
                  <ShieldCheck size={12} /> PROTOCOLO TAXONOMICO
                </p>
              </div>
            </ModalHeader>

            <ModalBody className="px-5 md:px-12 py-8 md:py-10">
              <div className="flex flex-col md:flex-row items-center gap-6 md:gap-8">
                {/* LOGO GIGANTE LADO A LADO - REDUCIDO */}
                <div className="h-16 w-16 md:h-20 md:w-20 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 flex items-center justify-center text-white rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] transform -rotate-3 hover:rotate-0 transition-all duration-500 shrink-0">
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
                    startContent={<Shapes size={22} className="text-zinc-900 dark:text-zinc-100 mr-3" />}
                  />
                  {isEdit && setMarginPercentage && (
                    <Input
                      type="number"
                      label="MARGEN DE GANANCIA POR DEFECTO (%)"
                      labelPlacement="inside"
                      placeholder="Ej. 25"
                      value={marginPercentage?.toString() || ''}
                      onValueChange={(v) => setMarginPercentage(Number(v) || 0)}
                      classNames={commonInputClasses}
                      startContent={<Sparkles size={22} className="text-zinc-900 dark:text-zinc-100 mr-3" />}
                    />
                  )}
                  <p className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest tracking-tight px-2">
                    * El nombre se normalizara automaticamente a mayusculas para mantener la integridad del catalogo.
                  </p>
                </div>
              </div>
            </ModalBody>

            <ModalFooter className="px-5 md:px-12 py-4 md:py-6 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-[#18181b]/50 rounded-b-[2rem]">
              {validationErrors.length > 0 && (
                <div className="w-full mb-3">
                  <ValidationErrors errors={validationErrors} />
                </div>
              )}
              <div className="flex w-full gap-3 md:gap-4">
                <Button
                  variant="flat"
                  className="flex-1 h-12 md:h-14 rounded-2xl font-medium uppercase text-[10px] card-base border-none text-zinc-500 dark:text-zinc-400 border border-gray-200 dark:border-white/10 tracking-tight tracking-widest hover:bg-white/5 hover:text-zinc-900 dark:text-zinc-100 transition-all opacity-70 hover:opacity-100"
                  onPress={onClose}
                >
                  DESCARTAR
                </Button>
                <Button
                  isLoading={isSaving}
                  onPress={handleCustomSave}
                  className="flex-[2] h-12 md:h-14 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white font-medium uppercase text-[11px] md:text-base tracking-widest rounded-2xl transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:scale-[1.02] active:scale-95 tracking-tight group"
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
