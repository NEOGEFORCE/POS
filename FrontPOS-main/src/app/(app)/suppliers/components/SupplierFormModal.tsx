'use client';

import React, { useState, useEffect } from 'react';
import { 
  Modal, 
  ModalContent, 
  ModalHeader, 
  ModalBody, 
  ModalFooter, 
  Button, 
  Input, 
  Select, 
  SelectItem,
} from "@heroui/react";
import { 
  Building2, 
  Phone, 
  Truck,
  Calendar,
  ShieldCheck,
  ChevronDown
} from "lucide-react";

import { Supplier } from '@/lib/definitions';
import { validateSupplier, FieldError } from '@/lib/formValidation';
import ValidationErrors from '@/components/ValidationErrors';
import { useToast } from '@/hooks/use-toast';

interface SupplierFormModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (supplier: Partial<Supplier>) => Promise<void>;
  isEdit: boolean;
  supplier?: Supplier | null;
}

// Días de la semana para selección múltiple
const DAYS_OF_WEEK = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const DAY_SHORT_NAMES: Record<string, string> = {
  'Lunes': 'LU',
  'Martes': 'MA',
  'Miércoles': 'MI',
  'Jueves': 'JU',
  'Viernes': 'VI',
  'Sábado': 'SA',
  'Domingo': 'DO'
};

const SupplierFormModal = React.memo(({ isOpen, onOpenChange, onSave, isEdit, supplier }: SupplierFormModalProps) => {
  const { toast } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [validationErrors, setValidationErrors] = useState<FieldError[]>([]);
  const [localSupplier, setLocalSupplier] = useState<Partial<Supplier>>({
    name: '',
    phone: '',
    vendorName: '',
    visitDays: [],
    deliveryDays: [],
    restockMethod: '',
  });

  useEffect(() => {
    if (supplier) {
      setLocalSupplier({
        ...supplier,
        name: supplier.name || '',
        phone: supplier.phone || '',
        vendorName: supplier.vendorName || '',
        // Usar nuevos campos multi-días, fallback a legacy si no existen
        visitDays: supplier.visitDays || (supplier.visitDay ? [supplier.visitDay] : []),
        deliveryDays: supplier.deliveryDays || (supplier.deliveryDay ? [supplier.deliveryDay] : []),
        restockMethod: supplier.restockMethod || '',
      });
    } else {
      setLocalSupplier({
        name: '',
        phone: '',
        vendorName: '',
        visitDays: [],
        deliveryDays: [],
        restockMethod: '',
      });
    }
  }, [supplier, isOpen]);

  // Toggle para días de visita (multi-select)
  const toggleVisitDay = (day: string) => {
    setLocalSupplier(prev => {
      const current = prev.visitDays || [];
      const updated = current.includes(day)
        ? current.filter(d => d !== day)
        : [...current, day];
      return { ...prev, visitDays: updated };
    });
  };

  // Toggle para días de entrega (multi-select)
  const toggleDeliveryDay = (day: string) => {
    setLocalSupplier(prev => {
      const current = prev.deliveryDays || [];
      const updated = current.includes(day)
        ? current.filter(d => d !== day)
        : [...current, day];
      return { ...prev, deliveryDays: updated };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = validateSupplier({
      name: localSupplier.name,
      phone: localSupplier.phone,
    });
    if (!result.isValid) {
      setValidationErrors(result.errors);
      return;
    }
    setValidationErrors([]);
    setIsSaving(true);
    try {
      await onSave(localSupplier);
    } catch (error: any) {
      console.error(error);
      toast({ variant: 'destructive', title: 'ERROR', description: error?.message || 'FALLO AL GUARDAR PROVEEDOR' });
    } finally {
      setIsSaving(false);
    }
  };

  const updateField = (field: keyof Supplier, value: any) => {
    setLocalSupplier(prev => ({ ...prev, [field]: value }));
  };

  const commonInputClasses = {
    label: "text-[9px] font-black text-gray-500 dark:text-zinc-400 uppercase tracking-widest italic text-center w-full mb-0.5",
    inputWrapper: "h-11 bg-gray-50/80 dark:bg-black/40 border border-gray-200/50 dark:border-white/10 transition-all shadow-sm rounded-xl focus-within:!border-emerald-500/40",
    input: "bg-transparent font-black text-xs uppercase italic text-gray-900 dark:text-white text-left"
  };

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange}
      size="lg"
      scrollBehavior="inside"
      backdrop="blur"
      classNames={{
        base: "bg-white dark:bg-zinc-950 rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-visible mx-2 md:mx-0 translate-y-2 md:translate-y-4",
        wrapper: "items-center justify-center p-8 md:p-12",
        backdrop: "bg-black/50 backdrop-blur-md",
        closeButton: "absolute right-5 top-5 text-gray-400 dark:text-zinc-500 hover:text-rose-500 transition-colors z-[100] rounded-full",
      }}
    >
      <ModalContent>
        {(onClose) => (
          <form onSubmit={handleSubmit} className="flex flex-col">
            <ModalHeader className="px-6 md:px-10 py-4 border-b border-gray-100 dark:border-white/5 rounded-t-[2.5rem]">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-emerald-500 flex items-center justify-center text-white shadow-lg shadow-emerald-500/20 transform -rotate-3 hover:rotate-0 transition-transform duration-500">
                  <Truck size={20} strokeWidth={1.5} />
                </div>
                <div className="flex flex-col">
                  <h2 className="text-base md:text-lg font-black text-gray-900 dark:text-white uppercase tracking-tight italic leading-none">
                    {isEdit ? "Gestión de Proveedor" : "Nuevo Proveedor"}
                  </h2>
                  <span className="text-[7px] font-black text-emerald-500 uppercase tracking-widest italic mt-0.5">Operación Certificada</span>
                </div>
              </div>
            </ModalHeader>

            <ModalBody className="px-6 md:px-10 py-4 flex flex-col gap-4 overflow-y-auto custom-scrollbar">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-0.5">
                    <label className={commonInputClasses.label}>EMPRESA / RAZÓN SOCIAL</label>
                    <Input
                      placeholder=" "
                      value={localSupplier.name}
                      onValueChange={(v) => updateField('name', v.toUpperCase())}
                      classNames={commonInputClasses}
                      startContent={<Building2 size={16} className="text-emerald-500 mr-2" />}
                    />
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <label className={commonInputClasses.label}>CONTACTO / TELÉFONO</label>
                    <Input
                      placeholder=" "
                      value={localSupplier.phone}
                      onValueChange={(v) => updateField('phone', v)}
                      classNames={commonInputClasses}
                      startContent={<Phone size={16} className="text-emerald-500 mr-2" />}
                    />
                  </div>

                  <div className="md:col-span-2 pt-2 pb-1 border-t border-gray-100 dark:border-white/5 flex items-center justify-center">
                    <span className="text-[8px] font-black text-gray-400 uppercase tracking-[0.3em] italic">Logística</span>
                  </div>

                  {/* DÍAS DE VISITA - Multi-Select con botones */}
                  <div className="md:col-span-2">
                    <label className={commonInputClasses.label}>DÍAS DE VISITA (SELECCIÓN MÚLTIPLE)</label>
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {DAYS_OF_WEEK.map((day) => {
                        const isSelected = (localSupplier.visitDays || []).includes(day);
                        return (
                          <Button
                            key={day}
                            size="sm"
                            variant={isSelected ? 'solid' : 'flat'}
                            className={`h-8 min-w-[40px] text-[10px] font-black ${
                              isSelected 
                                ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20' 
                                : 'bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:bg-gray-200'
                            }`}
                            onPress={() => toggleVisitDay(day)}
                          >
                            {DAY_SHORT_NAMES[day]}
                          </Button>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-1 mt-1">
                      <Calendar size={12} className="text-emerald-500/60" />
                      <span className="text-[9px] text-gray-400">
                        {(localSupplier.visitDays || []).length > 0 
                          ? (localSupplier.visitDays || []).join(', ')
                          : 'Selecciona al menos un día'}
                      </span>
                    </div>
                  </div>

                  {/* DÍAS DE ENTREGA - Multi-Select con botones */}
                  <div className="md:col-span-2">
                    <label className={commonInputClasses.label}>DÍAS DE ENTREGA (SELECCIÓN MÚLTIPLE)</label>
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {DAYS_OF_WEEK.map((day) => {
                        const isSelected = (localSupplier.deliveryDays || []).includes(day);
                        return (
                          <Button
                            key={day}
                            size="sm"
                            variant={isSelected ? 'solid' : 'flat'}
                            className={`h-8 min-w-[40px] text-[10px] font-black ${
                              isSelected 
                                ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/20' 
                                : 'bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:bg-gray-200'
                            }`}
                            onPress={() => toggleDeliveryDay(day)}
                          >
                            {DAY_SHORT_NAMES[day]}
                          </Button>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-1 mt-1">
                      <Truck size={12} className="text-orange-500/60" />
                      <span className="text-[9px] text-gray-400">
                        {(localSupplier.deliveryDays || []).length > 0 
                          ? (localSupplier.deliveryDays || []).join(', ')
                          : 'Selecciona al menos un día'}
                      </span>
                    </div>
                  </div>

                  {/* MÉTODO DE ABASTECIMIENTO */}
                  <div className="md:col-span-2">
                    <label className={commonInputClasses.label}>MÉTODO DE ABASTECIMIENTO PRINCIPAL</label>
                    <Select
                      placeholder="Selecciona método..."
                      selectedKeys={localSupplier.restockMethod ? [localSupplier.restockMethod] : []}
                      onSelectionChange={(keys) => updateField('restockMethod', Array.from(keys)[0] || '')}
                      selectorIcon={<ChevronDown className="text-gray-400 ml-2 shrink-0" size={16} />}
                      classNames={{
                        trigger: `${commonInputClasses.inputWrapper} mt-1 flex-row items-center justify-between px-3`,
                        innerWrapper: "flex-1 flex items-center",
                        value: "font-black text-xs uppercase italic text-gray-900 dark:text-white truncate",
                        listbox: "bg-zinc-900 border border-white/10 rounded-xl shadow-2xl",
                        popoverContent: "bg-zinc-900 border border-white/10 rounded-xl shadow-2xl",
                      }}
                      listboxProps={{
                        itemClasses: {
                          base: "font-extrabold uppercase italic text-[10px] text-white data-[selected=true]:bg-emerald-500/20 data-[selected=true]:text-emerald-400 hover:bg-white/5",
                        }
                      }}
                    >
                      <SelectItem key="RUTA">RUTA TRADICIONAL</SelectItem>
                      <SelectItem key="APP">APP / PLATAFORMA</SelectItem>
                      <SelectItem key="MIXTO">MIXTO (RUTA + APP)</SelectItem>
                      <SelectItem key="DIRECTO">DIRECTO (BODEGA)</SelectItem>
                    </Select>
                  </div>

              </div>
            </ModalBody>

            <ModalFooter className="px-6 md:px-10 py-4 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-b-[2.5rem]">
              {validationErrors.length > 0 && (
                <div className="w-full mb-3">
                  <ValidationErrors errors={validationErrors} />
                </div>
              )}
              <div className="flex w-full gap-3">
                <Button
                  variant="flat"
                  className="flex-1 h-10 rounded-xl font-black uppercase text-[9px] bg-white dark:bg-zinc-900 text-gray-400 italic tracking-widest border border-gray-100 dark:border-white/5"
                  onPress={onClose}
                >
                  CANCELAR
                </Button>
                <Button
                  type="submit"
                  isLoading={isSaving}
                  className="flex-[2] h-10 bg-emerald-500 text-white font-black uppercase text-[10px] tracking-widest rounded-xl transition-all shadow-lg shadow-emerald-500/20 active:scale-95 italic"
                >
                  <ShieldCheck size={14} className="mr-2" />
                  {isEdit ? "GUARDAR CAMBIOS" : "CONFIRMAR"}
                </Button>
              </div>
            </ModalFooter>
          </form>
        )}
      </ModalContent>
    </Modal>
  );
});

SupplierFormModal.displayName = 'SupplierFormModal';
export default SupplierFormModal;
