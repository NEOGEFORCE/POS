"use client";

import React, { useState } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input, Spinner
} from "@heroui/react";
import { 
  UserPlus, 
  Contact2, 
  Fingerprint, 
  Phone, 
  MapPin, 
  Wallet, 
  Sparkles,
  User,
  Search,
  ShieldCheck
} from 'lucide-react';
import { Customer } from '@/lib/definitions';
import { validateCustomer, FieldError } from '@/lib/formValidation';
import ValidationErrors from '@/components/ValidationErrors';

interface CustomerFormModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  isEdit?: boolean;
  customer: Partial<Customer> | null;
  setCustomer: (customer: any) => void;
  onSave: () => Promise<void>;
  onLookupDni?: (dni: string) => void;
}

export default function CustomerFormModal({
  isOpen,
  onOpenChange,
  isEdit = false,
  customer,
  setCustomer,
  onSave,
  onLookupDni
}: CustomerFormModalProps) {
  const [validationErrors, setValidationErrors] = useState<Array<{ field: string; message: string }>>([]);

  if (!customer && !isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = validateCustomer({
      dni: customer?.dni,
      name: customer?.name,
      creditLimit: customer?.creditLimit,
    });
    if (!result.isValid) {
      setValidationErrors(result.errors);
      return;
    }
    setValidationErrors([]);
    onSave();
  };

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange} 
      backdrop="opaque"
      size="2xl"
      scrollBehavior="inside"
      classNames={{ 
        base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-visible mx-2 md:mx-0",
        wrapper: "items-start sm:items-center mt-12 sm:mt-0 justify-center",
        closeButton: "absolute right-5 top-5 text-zinc-500 dark:text-zinc-400 hover:text-rose-500 transition-colors z-[100] rounded-2xl",
        backdrop: "bg-[#18181b] "
      }}
    >
      <ModalContent>
        {() => (
          <form onSubmit={handleSubmit}>
            <ModalHeader className="flex flex-col gap-1 px-5 md:px-12 py-3 md:py-4 border-b border-gray-100 dark:border-white/5 bg-[#18181b] dark:bg-[#18181b]/50 rounded-t-2xl md:rounded-t-[2rem]">
              <h2 className="text-lg md:text-2xl font-medium text-zinc-900 dark:text-zinc-50 tracking-tight tracking-tighter uppercase leading-none flex items-center gap-3 md:gap-4">
                <div className="h-8 w-8 md:h-14 md:w-14 bg-white/5 text-zinc-900 dark:text-zinc-100 flex items-center justify-center rounded-2xl md:rounded-2xl border border-emerald-500/20">
                  {!isEdit ? <UserPlus size={16} className="md:size-7" /> : <User size={16} className="md:size-7" />}
                </div>
                <div className="flex flex-col gap-0.5 md:gap-1">
                  <span>{!isEdit ? "Cifrar " : "Actualizar "} <span className="text-zinc-900 dark:text-zinc-100">Cliente</span></span>
                  <span className="text-[7px] md:text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest not-tracking-tight opacity-80">Infraestructura de Registros Maestro</span>
                </div>
              </h2>
            </ModalHeader>

            <ModalBody className="px-5 md:px-12 py-3 md:py-6 gap-2 md:gap-4 pb-4 sm:pb-4">
              {/* Sección DNI y Nombre */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 md:gap-4">
                <div className="flex flex-col gap-1">
                  <Input 
                    label="IDENTIFICACIÓN OFICIAL"
                    labelPlacement="inside"
                    placeholder=" "
                    value={customer?.dni || ''} 
                    onValueChange={(v) => {
                      if (!isEdit) {
                        setCustomer((p: any) => ({ ...p, dni: v }));
                        // Auto-lookup si tiene longitud mínima
                        if (v.length >= 5 && onLookupDni) {
                          onLookupDni(v);
                        }
                      }
                    }} 
                    isDisabled={isEdit} 
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isEdit && customer?.dni && customer.dni.length >= 5 && onLookupDni) {
                        onLookupDni(customer.dni);
                      }
                    }}
                    startContent={<Fingerprint size={20} className="text-zinc-900 dark:text-zinc-100 mr-3" />}
                    endContent={!isEdit && (
                      <Button 
                        isIconOnly 
                        size="sm" 
                        variant="light" 
                        onPress={() => onLookupDni && customer?.dni && onLookupDni(customer.dni)}
                        className="text-zinc-900 dark:text-zinc-100"
                      >
                        <Search size={16} />
                      </Button>
                    )}
                    classNames={{ 
                      label: "absolute z-10 pointer-events-none origin-top-left shrink-0 rtl:origin-top-right subpixel-antialiased block cursor-text will-change-auto !duration-200 !ease-out motion-reduce:transition-none transition-[transform,color,left,opacity,translate,scale] group-data-[filled-within=true]:text-default-600 group-data-[filled-within=true]:pointer-events-auto group-data-[filled-within=true]:scale-85 group-data-[filled-within=true]:-translate-y-[calc(50%_+_var(--heroui-font-size-small)/2_-_6px)] pe-2 max-w-full text-ellipsis overflow-hidden text-[9px] md:text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest",
                      inputWrapper: "relative w-full inline-flex tap-highlight-transparent shadow-xs data-[hover=true]:bg-default-200 group-data-[focus=true]:bg-default-100 min-h-10 flex-col items-start justify-center gap-0 motion-reduce:transition-none !duration-150 outline-solid outline-transparent group-data-[focus-visible=true]:z-10 group-data-[focus-visible=true]:ring-2 group-data-[focus-visible=true]:ring-focus group-data-[focus-visible=true]:ring-offset-2 group-data-[focus-visible=true]:ring-offset-background py-2 h-13 md:h-18 md:min-h-[72px] px-4 bg-white/50 dark:bg-[#18181b] border-2 transition-all shadow-inner rounded-2xl border-transparent focus-within:!border-emerald-500/30",
                      input: "w-full bg-transparent !outline-solid placeholder:text-foreground-500 focus-visible:outline-solid outline-transparent data-[has-start-content=true]:ps-1.5 data-[has-end-content=true]:pe-1.5 data-[type=color]:rounded-none file:cursor-pointer file:bg-transparent file:border-0 autofill:bg-transparent bg-clip-text dark:autofill:[-webkit-text-fill-color:hsl(var(--heroui-foreground))] [&::-ms-reveal]:hidden group-data-[has-value=true]:text-default-foreground font-medium text-sm md:text-base uppercase tracking-tight text-zinc-900 dark:text-zinc-50" 
                    }}
                  />
                  {!isEdit && (
                    <p className="text-[7px] font-medium text-gray-400 px-2 uppercase tracking-widest tracking-tight opacity-60">Enter para buscar</p>
                  )}
                </div>

                <Input 
                  label="RAZÓN SOCIAL / NOMBRE"
                  labelPlacement="inside"
                  placeholder=" "
                  value={customer?.name || ''} 
                  onValueChange={(v) => setCustomer((p: any) => ({ ...p, name: v.toUpperCase() }))} 
                  startContent={<Contact2 size={20} className="text-zinc-900 dark:text-zinc-100 mr-3" />}
                  classNames={{ 
                    label: "absolute z-10 pointer-events-none origin-top-left shrink-0 rtl:origin-top-right subpixel-antialiased block cursor-text will-change-auto !duration-200 !ease-out motion-reduce:transition-none transition-[transform,color,left,opacity,translate,scale] group-data-[filled-within=true]:text-default-600 group-data-[filled-within=true]:pointer-events-auto group-data-[filled-within=true]:scale-85 group-data-[filled-within=true]:-translate-y-[calc(50%_+_var(--heroui-font-size-small)/2_-_6px)] pe-2 max-w-full text-ellipsis overflow-hidden text-[9px] md:text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest",
                    inputWrapper: "relative w-full inline-flex tap-highlight-transparent shadow-xs data-[hover=true]:bg-default-200 group-data-[focus=true]:bg-default-100 min-h-10 flex-col items-start justify-center gap-0 motion-reduce:transition-none !duration-150 outline-solid outline-transparent group-data-[focus-visible=true]:z-10 group-data-[focus-visible=true]:ring-2 group-data-[focus-visible=true]:ring-focus group-data-[focus-visible=true]:ring-offset-2 group-data-[focus-visible=true]:ring-offset-background py-2 h-13 md:h-18 md:min-h-[72px] px-4 bg-white/50 dark:bg-[#18181b] border-2 transition-all shadow-inner rounded-2xl border-transparent focus-within:!border-emerald-500/30",
                    input: "w-full bg-transparent !outline-solid placeholder:text-foreground-500 focus-visible:outline-solid outline-transparent data-[has-start-content=true]:ps-1.5 data-[has-end-content=true]:pe-1.5 data-[type=color]:rounded-none file:cursor-pointer file:bg-transparent file:border-0 autofill:bg-transparent bg-clip-text dark:autofill:[-webkit-text-fill-color:hsl(var(--heroui-foreground))] [&::-ms-reveal]:hidden group-data-[has-value=true]:text-default-foreground font-medium text-sm md:text-base uppercase tracking-tight text-zinc-900 dark:text-zinc-50" 
                  }}
                />
              </div>

              {/* Teléfono y Dirección */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 md:gap-4">
                <Input 
                  label="LÍNEA DE CONTACTO"
                  labelPlacement="inside"
                  placeholder=" "
                  value={customer?.phone || ''} 
                  onValueChange={(v) => setCustomer((p: any) => ({ ...p, phone: v }))} 
                  startContent={<Phone size={20} className="text-zinc-900 dark:text-zinc-100 mr-3" />}
                  classNames={{ 
                    label: "absolute z-10 pointer-events-none origin-top-left shrink-0 rtl:origin-top-right subpixel-antialiased block cursor-text will-change-auto !duration-200 !ease-out motion-reduce:transition-none transition-[transform,color,left,opacity,translate,scale] group-data-[filled-within=true]:text-default-600 group-data-[filled-within=true]:pointer-events-auto group-data-[filled-within=true]:scale-85 group-data-[filled-within=true]:-translate-y-[calc(50%_+_var(--heroui-font-size-small)/2_-_6px)] pe-2 max-w-full text-ellipsis overflow-hidden text-[9px] md:text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest",
                    inputWrapper: "relative w-full inline-flex tap-highlight-transparent shadow-xs data-[hover=true]:bg-default-200 group-data-[focus=true]:bg-default-100 min-h-10 flex-col items-start justify-center gap-0 motion-reduce:transition-none !duration-150 outline-solid outline-transparent group-data-[focus-visible=true]:z-10 group-data-[focus-visible=true]:ring-2 group-data-[focus-visible=true]:ring-focus group-data-[focus-visible=true]:ring-offset-2 group-data-[focus-visible=true]:ring-offset-background py-2 h-13 md:h-18 md:min-h-[72px] px-4 bg-white/50 dark:bg-[#18181b] border-2 transition-all shadow-inner rounded-2xl border-transparent focus-within:!border-emerald-500/30",
                    input: "w-full bg-transparent !outline-solid placeholder:text-foreground-500 focus-visible:outline-solid outline-transparent data-[has-start-content=true]:ps-1.5 data-[has-end-content=true]:pe-1.5 data-[type=color]:rounded-none file:cursor-pointer file:bg-transparent file:border-0 autofill:bg-transparent bg-clip-text dark:autofill:[-webkit-text-fill-color:hsl(var(--heroui-foreground))] [&::-ms-reveal]:hidden group-data-[has-value=true]:text-default-foreground font-medium text-sm md:text-base uppercase tracking-tight text-zinc-900 dark:text-zinc-50 tracking-widest" 
                  }}
                />
                <Input 
                  label="DIRECCIÓN FISCAL"
                  labelPlacement="inside"
                  placeholder=" "
                  value={customer?.address || ''} 
                  onValueChange={(v) => setCustomer((p: any) => ({ ...p, address: v.toUpperCase() }))} 
                  startContent={<MapPin size={20} className="text-zinc-900 dark:text-zinc-100 mr-3" />}
                  classNames={{ 
                    label: "absolute z-10 pointer-events-none origin-top-left shrink-0 rtl:origin-top-right subpixel-antialiased block cursor-text will-change-auto !duration-200 !ease-out motion-reduce:transition-none transition-[transform,color,left,opacity,translate,scale] group-data-[filled-within=true]:text-default-600 group-data-[filled-within=true]:pointer-events-auto group-data-[filled-within=true]:scale-85 group-data-[filled-within=true]:-translate-y-[calc(50%_+_var(--heroui-font-size-small)/2_-_6px)] pe-2 max-w-full text-ellipsis overflow-hidden text-[9px] md:text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest",
                    inputWrapper: "relative w-full inline-flex tap-highlight-transparent shadow-xs data-[hover=true]:bg-default-200 group-data-[focus=true]:bg-default-100 min-h-10 flex-col items-start justify-center gap-0 motion-reduce:transition-none !duration-150 outline-solid outline-transparent group-data-[focus-visible=true]:z-10 group-data-[focus-visible=true]:ring-2 group-data-[focus-visible=true]:ring-focus group-data-[focus-visible=true]:ring-offset-2 group-data-[focus-visible=true]:ring-offset-background py-2 h-13 md:h-18 md:min-h-[72px] px-4 bg-white/50 dark:bg-[#18181b] border-2 transition-all shadow-inner rounded-2xl border-transparent focus-within:!border-emerald-500/30",
                    input: "w-full bg-transparent !outline-solid placeholder:text-foreground-500 focus-visible:outline-solid outline-transparent data-[has-start-content=true]:ps-1.5 data-[has-end-content=true]:pe-1.5 data-[type=color]:rounded-none file:cursor-pointer file:bg-transparent file:border-0 autofill:bg-transparent bg-clip-text dark:autofill:[-webkit-text-fill-color:hsl(var(--heroui-foreground))] [&::-ms-reveal]:hidden group-data-[has-value=true]:text-default-foreground font-medium text-sm md:text-base uppercase tracking-tight text-zinc-900 dark:text-zinc-50" 
                  }}
                />
              </div>

              {/* Límite de Crédito - Estilo Premium Hero UI */}
              <div className="space-y-2 mt-2">
                <label className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-300 uppercase tracking-widest ml-1 flex items-center gap-2">
                    <Wallet size={14} /> CUPO DISPONIBLE DE CRÉDITO
                </label>
                <Input 
                  labelPlacement="outside"
                  placeholder="0"
                  value={(customer?.creditLimit !== undefined && customer?.creditLimit !== null && String(customer?.creditLimit) !== '' && Number(customer?.creditLimit) !== 0) 
                    ? String(customer.creditLimit).replace(/\D/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, ".") 
                    : ''}
                  onValueChange={(v) => {
                    const raw = v.replace(/\D/g, '');
                    setCustomer((p: any) => ({ ...p, creditLimit: raw }));
                  }} 
                  startContent={<span className="text-zinc-900 dark:text-zinc-100 font-medium tracking-tight mr-1 text-2xl">$</span>}
                  classNames={{ 
                    inputWrapper: "h-20 md:h-28 bg-gray-50/50 dark:bg-[#18181b] border-2 border-emerald-500/10 rounded-[2rem] focus-within:!border-emerald-500/50 shadow-inner transition-all px-8", 
                    input: "font-medium text-3xl md:text-5xl tracking-tight text-zinc-900 dark:text-zinc-50 bg-transparent tabular-nums text-center" 
                  }}
                />
              </div>
            </ModalBody>

            <ModalFooter className="px-5 md:px-12 py-3 md:py-4 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-[#18181b]/50 rounded-b-2xl md:rounded-b-[2.5rem]">
              {validationErrors.length > 0 && (
                <div className="w-full mb-2">
                  <ValidationErrors errors={validationErrors} />
                </div>
              )}
              <Button 
                type="submit"
                className="w-full h-11 md:h-14 bg-gray-900 dark:bg-white text-white dark:text-black font-medium uppercase text-[10px] md:text-[11px] tracking-widest rounded-2xl transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:scale-[1.01] active:scale-95 tracking-tight" 
              >
                <ShieldCheck size={18} className="mr-3" />
                {!isEdit ? "AUTORIZAR REGISTRO" : "GUARDAR CAMBIOS"}
              </Button>
            </ModalFooter>
          </form>
        )}
      </ModalContent>
    </Modal>
  );
}
