"use client";

import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input
} from "@heroui/react";
import { 
  UserPlus, 
  Contact2, 
  Fingerprint, 
  Phone, 
  MapPin, 
  Wallet, 
  Sparkles,
  User
} from 'lucide-react';
import { Customer } from '@/lib/definitions';

interface CustomerFormModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  isEdit?: boolean;
  customer: Partial<Customer> | null;
  setCustomer: (customer: any) => void;
  onSave: () => Promise<void>;
}

export default function CustomerFormModal({
  isOpen,
  onOpenChange,
  isEdit = false,
  customer,
  setCustomer,
  onSave
}: CustomerFormModalProps) {
  if (!customer && !isOpen) return null;

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange} 
      backdrop="blur" 
      size="lg"
      classNames={{ 
        base: "bg-white dark:bg-zinc-950 rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-visible",
        closeButton: "text-gray-400 dark:text-zinc-500 hover:text-rose-500 transition-colors z-50 hover:bg-rose-500/10 rounded-full"
      }}
    >
      <ModalContent>
        {() => (
          <>
            <ModalHeader className="flex flex-col gap-1 p-10 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-t-[2.5rem]">
              <h2 className="text-2xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none flex items-center gap-4">
                <div className="h-16 w-16 bg-emerald-500/10 text-emerald-500 flex items-center justify-center rounded-2xl shadow-inner rotate-3">
                  {!isEdit ? <UserPlus size={32} /> : <User size={32} />}
                </div>
                <div className="flex flex-col">
                  <span>{!isEdit ? "Nuevo " : "Modificar "} <span className="text-emerald-500">Cliente</span></span>
                  <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-2 not-italic">Infraestructura de Registros Maestro</span>
                </div>
              </h2>
            </ModalHeader>

            <ModalBody className="p-10 gap-10">
              {/* Sección DNI y Razón Social */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                <div className="space-y-3">
                  <div className="flex items-center gap-2 ml-1">
                    <Fingerprint size={14} className="text-emerald-500" />
                    <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">Identificación Oficial</label>
                  </div>
                  <Input 
                    value={customer?.dni || ''} 
                    onValueChange={(v) => !isEdit && setCustomer((p: any) => ({ ...p, dni: v }))} 
                    isDisabled={isEdit} 
                    placeholder="DNI / NIT"
                    classNames={{ 
                      inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-emerald-500 shadow-inner transition-all", 
                      input: "font-black text-base uppercase italic text-gray-900 dark:text-white bg-transparent placeholder:text-gray-300 dark:placeholder:text-zinc-700" 
                    }}
                  />
                </div>
                <div className="space-y-3">
                  <div className="flex items-center gap-2 ml-1">
                    <Contact2 size={14} className="text-emerald-500" />
                    <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">Razón Social / Nombre</label>
                  </div>
                  <Input 
                    value={customer?.name || ''} 
                    onValueChange={(v) => setCustomer((p: any) => ({ ...p, name: v.toUpperCase() }))} 
                    placeholder="NOMBRE COMPLETO"
                    classNames={{ 
                      inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-emerald-500 shadow-inner transition-all", 
                      input: "font-black text-base uppercase italic text-gray-900 dark:text-white bg-transparent placeholder:text-gray-300 dark:placeholder:text-zinc-700" 
                    }}
                  />
                </div>
              </div>

              {/* Teléfono y Dirección */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                <div className="space-y-3">
                  <div className="flex items-center gap-2 ml-1">
                    <Phone size={14} className="text-emerald-500" />
                    <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">Línea de Contacto</label>
                  </div>
                  <Input 
                    value={customer?.phone || ''} 
                    onValueChange={(v) => setCustomer((p: any) => ({ ...p, phone: v }))} 
                    placeholder="WHATSAPP / TEL"
                    classNames={{ 
                      inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-emerald-500 shadow-inner transition-all", 
                      input: "font-black text-base uppercase italic text-gray-900 dark:text-white bg-transparent placeholder:text-gray-300 dark:placeholder:text-zinc-700 tracking-widest" 
                    }}
                  />
                </div>
                <div className="space-y-3">
                  <div className="flex items-center gap-2 ml-1">
                    <MapPin size={14} className="text-emerald-500" />
                    <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">Dirección Fiscal</label>
                  </div>
                  <Input 
                    value={customer?.address || ''} 
                    onValueChange={(v) => setCustomer((p: any) => ({ ...p, address: v.toUpperCase() }))} 
                    placeholder="DIRECCIÓN FÍSICA"
                    classNames={{ 
                      inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-emerald-500 shadow-inner transition-all", 
                      input: "font-black text-base uppercase italic text-gray-900 dark:text-white bg-transparent placeholder:text-gray-300 dark:placeholder:text-zinc-700" 
                    }}
                  />
                </div>
              </div>

              {/* Límite de Crédito */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 ml-1">
                  <Wallet size={14} className="text-emerald-500" />
                  <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">Cupo Disponible de Crédito</label>
                </div>
                <Input 
                  type="number" 
                  value={String(customer?.creditLimit || '0')} 
                  onValueChange={(v) => setCustomer((p: any) => ({ ...p, creditLimit: Number(v) }))} 
                  startContent={<span className="text-emerald-500 font-black italic mr-1">$</span>}
                  classNames={{ 
                    inputWrapper: "h-20 bg-gray-50/50 dark:bg-black/50 border border-gray-200 dark:border-emerald-500/10 rounded-3xl focus-within:!border-emerald-500 shadow-inner transition-all", 
                    input: "font-black text-3xl italic text-gray-900 dark:text-white bg-transparent tabular-nums" 
                  }}
                />
              </div>
            </ModalBody>

            <ModalFooter className="p-10 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-b-[2.5rem]">
              <Button 
                className="w-full h-20 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-sm tracking-[0.2em] rounded-3xl transition-all shadow-xl hover:scale-[1.02] active:scale-95 italic ring-4 ring-black/5 dark:ring-white/5" 
                onPress={onSave}
              >
                <Sparkles size={24} className="mr-3" />
                {!isEdit ? "REGISTRAR CLIENTE EN MAESTRO" : "SINCRONIZAR CAMBIOS"}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
