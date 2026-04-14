"use client";

import React, { memo } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input
} from "@heroui/react";
import { Truck, Phone, MapPin, Sparkles, X, Building2, Camera } from 'lucide-react';
import { Supplier } from '@/lib/definitions';

interface SupplierFormModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  isEdit?: boolean;
  supplier: Partial<Supplier> | null;
  setSupplier: (supplier: any) => void;
  onSave: () => Promise<void>;
}

const SupplierFormModal = memo(({
  isOpen,
  onOpenChange,
  isEdit = false,
  supplier,
  setSupplier,
  onSave
}: SupplierFormModalProps) => {
  if (!supplier && !isOpen) return null;

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange} 
      backdrop="blur" 
      size="lg" 
      classNames={{ 
        base: "bg-white dark:bg-zinc-950 rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-visible mx-4 my-8", 
        closeButton: "hover:bg-rose-500/10 hover:text-rose-500 transition-colors top-6 right-6" 
      }}
    >
      <ModalContent className="overflow-visible">
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1 p-10 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-t-[2.5rem]">
              <div className="flex items-center gap-6">
                <div className="h-16 w-16 bg-emerald-500/10 text-emerald-500 flex items-center justify-center rounded-[1.5rem] shadow-inner rotate-3 border border-emerald-500/20">
                  <Truck size={32} />
                </div>
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    <h2 className="text-3xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none">
                      {isEdit ? "Sincronizar" : "Vincular"} <span className="text-emerald-500">Abastecedor</span>
                    </h2>
                  </div>
                  <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.4em] mt-3 not-italic opacity-70">Infraestructura de Suministros Maestro</span>
                </div>
              </div>
            </ModalHeader>

            <ModalBody className="p-10 space-y-8">
              {/* PHOTO SELECTOR SECTION */}
              <div className="flex flex-col items-center gap-5 py-4 bg-gray-50/50 dark:bg-zinc-900/50 rounded-[2rem] border border-gray-100 dark:border-white/5 relative overflow-hidden group/photo-container">
                <div className="absolute inset-0 bg-gradient-to-b from-emerald-500/5 to-transparent pointer-events-none opacity-0 group-hover/photo-container:opacity-100 transition-opacity duration-700" />
                <div className="relative group/photo cursor-pointer z-10 transition-transform duration-500 hover:scale-110">
                  <div className="h-28 w-28 rounded-[2rem] bg-white dark:bg-zinc-950 border-2 border-dashed border-gray-200 dark:border-white/10 flex items-center justify-center overflow-hidden transition-all group-hover/photo:border-emerald-500 group-hover/photo:shadow-[0_0_30px_rgba(16,185,129,0.2)] shadow-xl">
                    {supplier?.imageUrl ? (
                      <img 
                        src={supplier.imageUrl} 
                        className="h-full w-full object-cover" 
                        alt="Preview" 
                      />
                    ) : (
                      <Building2 size={40} className="text-gray-200 dark:text-zinc-800 group-hover/photo:text-emerald-500 transition-colors duration-500" />
                    )}
                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover/photo:opacity-100 transition-opacity flex flex-col items-center justify-center text-white p-4">
                      <Camera size={20} className="mb-2 animate-bounce" />
                      <span className="text-[8px] font-black uppercase tracking-widest italic text-center">CAMBIAR IDENTIDAD</span>
                    </div>
                  </div>
                  <div className="absolute -bottom-2 -right-2 bg-emerald-500 text-white p-2 rounded-xl shadow-[0_5px_15px_rgba(16,185,129,0.4)] border-2 border-white dark:border-zinc-950 group-hover/photo:rotate-12 transition-transform">
                    <Camera size={16} />
                  </div>
                  <input 
                    type="file" 
                    accept="image/*"
                    className="absolute inset-0 opacity-0 cursor-pointer"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                          const base64String = reader.result as string;
                          setSupplier((p: any) => ({ ...p, imageUrl: base64String }));
                        };
                        reader.readAsDataURL(file);
                      }
                    }}
                  />
                </div>
                <div className="text-center z-10">
                  <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] italic">Branding Corporativo del Proveedor</p>
                </div>
              </div>
              
              {/* Razón Social */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 ml-1">
                  <Building2 size={14} className="text-emerald-500" />
                  <label className="text-[11px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">Razón Social Registrada</label>
                </div>
                <Input
                  autoFocus
                  placeholder="E.G. IMPORTADORA CONTINENTAL S.A.S"
                  value={supplier?.name || ''}
                  onValueChange={(v) => setSupplier((p: any) => ({ ...p, name: v.toUpperCase() }))}
                  classNames={{ 
                    inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-[1.25rem] focus-within:!border-emerald-500 shadow-inner transition-all", 
                    input: "font-black text-lg uppercase italic text-gray-900 dark:text-white bg-transparent placeholder:text-gray-200 dark:placeholder:text-zinc-800" 
                  }}
                />
              </div>

              {/* Grid Contacto y Dirección */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="space-y-4">
                  <div className="flex items-center gap-2 ml-1">
                    <Phone size={14} className="text-emerald-500" />
                    <label className="text-[11px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">Línea Telefónica</label>
                  </div>
                  <Input
                    placeholder="+54 000 000 0000"
                    value={supplier?.phone || ''}
                    onValueChange={(v) => setSupplier((p: any) => ({ ...p, phone: v }))}
                    classNames={{ 
                      inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-[1.25rem] focus-within:!border-emerald-500 shadow-inner transition-all", 
                      input: "font-black text-base uppercase italic text-gray-900 dark:text-white bg-transparent placeholder:text-gray-200 dark:placeholder:text-zinc-800 tracking-[0.1em]" 
                    }}
                  />
                </div>

                <div className="space-y-4">
                  <div className="flex items-center gap-2 ml-1">
                    <MapPin size={14} className="text-emerald-500" />
                    <label className="text-[11px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">Sede Operativa</label>
                  </div>
                  <Input
                    placeholder="AV. CENTRAL #123 - PISO 2"
                    value={supplier?.address || ''}
                    onValueChange={(v) => setSupplier((p: any) => ({ ...p, address: v.toUpperCase() }))}
                    classNames={{ 
                      inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-[1.25rem] focus-within:!border-emerald-500 shadow-inner transition-all", 
                      input: "font-black text-base uppercase italic text-gray-900 dark:text-white bg-transparent placeholder:text-gray-200 dark:placeholder:text-zinc-800" 
                    }}
                  />
                </div>
              </div>
            </ModalBody>

            <ModalFooter className="p-10 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-b-[2.5rem]">
              <div className="flex w-full gap-5">
                <Button
                  variant="flat"
                  className="flex-1 h-16 rounded-[1.25rem] font-black uppercase text-xs bg-white dark:bg-zinc-900 text-gray-400 border border-gray-200 dark:border-white/10 italic tracking-widest hover:bg-rose-500/10 hover:text-rose-500 transition-all"
                  onPress={onClose}
                >
                  CANCELAR <X size={18} className="ml-2" />
                </Button>
                <Button
                  className="flex-[2] h-16 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-sm tracking-[0.25em] rounded-[1.25rem] transition-all shadow-[0_10px_40px_-10px_rgba(0,0,0,0.3)] dark:shadow-[0_10px_40px_-10px_rgba(255,255,255,0.1)] hover:scale-[1.03] active:scale-95 italic group"
                  onPress={onSave}
                >
                  <Sparkles size={22} className="mr-3 group-hover:rotate-12 transition-transform" />
                  {isEdit ? "GUARDAR CAMBIOS" : "VINCULAR MAESTRO"}
                </Button>
              </div>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
});

SupplierFormModal.displayName = 'SupplierFormModal';
export default SupplierFormModal;
