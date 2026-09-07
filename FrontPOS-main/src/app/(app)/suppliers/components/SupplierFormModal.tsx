'use client';

import React, { useMemo, useState, useEffect } from 'react';
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
  AlertTriangle,
  Brain,
  Building2,
  Calendar,
  ChevronDown,
  Info,
  Phone,
  ShieldCheck,
  Truck,
} from "lucide-react";

import { Supplier } from '@/lib/definitions';
import { validateSupplier, FieldError } from '@/lib/formValidation';
import ValidationErrors from '@/components/ValidationErrors';
import { useToast } from '@/hooks/use-toast';
import { normalizeText } from '@/lib/utils';
import {
  WEEKDAYS_CANONICAL,
  WEEKDAY_DISPLAY,
  WEEKDAY_SHORT,
  isSameDaySet,
  parseSupplierDays,
  sanitizeDayList,
  toDisplayDays,
  toStorageCsv,
} from '@/lib/supplier-days.mjs';
import type { CanonicalWeekday } from '@/lib/supplier-days.d.mts';

// El umbral para considerar la agenda aprendida como confiable esta amarrado
// al backend (`scheduling.LearnMinSamples` = 4). Mantener sincronizado.
const LEARN_MIN_SAMPLES = 4;

interface SupplierFormModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (supplier: Partial<Supplier>) => Promise<void>;
  isEdit: boolean;
  supplier?: Supplier | null;
  onLookupName?: (name: string) => void;
}

function formatLearnedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota",
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(parsed);
  } catch {
    return null;
  }
}

const SupplierFormModal = React.memo(({ isOpen, onOpenChange, onSave, isEdit, supplier, onLookupName }: SupplierFormModalProps) => {
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
      // Al abrir en modo edicion parseamos SIEMPRE por el helper compartido:
      // asi datos viejos guardados con tilde ("Miércoles") aparecen marcados
      // igual que los nuevos, y los que estan solo en el campo legacy CSV
      // (visitDay/deliveryDay) tambien se recuperan.
      const visitDays = parseSupplierDays({ days: supplier.visitDays, csv: supplier.visitDay });
      const deliveryDays = parseSupplierDays({ days: supplier.deliveryDays, csv: supplier.deliveryDay });

      setLocalSupplier({
        ...supplier,
        name: supplier.name || '',
        phone: supplier.phone || '',
        vendorName: supplier.vendorName || '',
        visitDays,
        deliveryDays,
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
    setValidationErrors([]);
  }, [supplier, isOpen]);

  // Toggle para dias de visita (multi-select). Siempre pasa por sanitizeDayList
  // para dejar la lista en orden natural, sin duplicados y sin basura.
  const toggleVisitDay = (day: CanonicalWeekday) => {
    setLocalSupplier(prev => {
      const current = sanitizeDayList(prev.visitDays);
      const updated = current.includes(day)
        ? current.filter(d => d !== day)
        : sanitizeDayList([...current, day]);
      return { ...prev, visitDays: updated };
    });
  };

  // Toggle para dias de entrega (multi-select)
  const toggleDeliveryDay = (day: CanonicalWeekday) => {
    setLocalSupplier(prev => {
      const current = sanitizeDayList(prev.deliveryDays);
      const updated = current.includes(day)
        ? current.filter(d => d !== day)
        : sanitizeDayList([...current, day]);
      return { ...prev, deliveryDays: updated };
    });
  };

  // Agenda aprendida por el backend. Se toma del supplier original: los
  // learned_* NUNCA se editan desde el formulario, sirven solo para que el
  // dueno compare con lo que escribio y decida si corrige la ficha.
  const learned = useMemo(() => {
    if (!supplier) {
      return {
        visitDays: [] as string[],
        deliveryDays: [] as string[],
        leadTimeDays: null as number | null,
        sampleCount: 0,
        learnedAt: null as string | null,
        hasEvidence: false,
        isReliable: false,
      };
    }
    const visitDays = sanitizeDayList(supplier.learnedVisitDays);
    const deliveryDays = sanitizeDayList(supplier.learnedDeliveryDays);
    const leadTimeDays =
      typeof supplier.learnedLeadTimeDays === 'number' && supplier.learnedLeadTimeDays > 0
        ? Math.floor(supplier.learnedLeadTimeDays)
        : null;
    const sampleCount = Number.isFinite(supplier.learnedSampleCount)
      ? Math.max(0, Math.floor(supplier.learnedSampleCount as number))
      : 0;
    const hasEvidence = sampleCount > 0
      && (visitDays.length > 0 || deliveryDays.length > 0 || leadTimeDays !== null);
    const isReliable = sampleCount >= LEARN_MIN_SAMPLES
      && (visitDays.length > 0 || deliveryDays.length > 0);
    return {
      visitDays,
      deliveryDays,
      leadTimeDays,
      sampleCount,
      learnedAt: supplier.learnedAt ?? null,
      hasEvidence,
      isReliable,
    };
  }, [supplier]);

  const visitContradiction = useMemo(() => {
    if (!learned.isReliable) return false;
    const current = sanitizeDayList(localSupplier.visitDays);
    if (current.length === 0 || learned.visitDays.length === 0) return false;
    return !isSameDaySet(current, learned.visitDays);
  }, [learned.isReliable, learned.visitDays, localSupplier.visitDays]);

  const deliveryContradiction = useMemo(() => {
    if (!learned.isReliable) return false;
    const current = sanitizeDayList(localSupplier.deliveryDays);
    if (current.length === 0 || learned.deliveryDays.length === 0) return false;
    return !isSameDaySet(current, learned.deliveryDays);
  }, [learned.isReliable, learned.deliveryDays, localSupplier.deliveryDays]);

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
      // Sanitizamos por ultima vez antes de mandar: canoniza forma (sin
      // tilde), orden natural, sin duplicados. El helper es la unica fuente
      // de verdad para el formato.
      const visitDays = sanitizeDayList(localSupplier.visitDays);
      const deliveryDays = sanitizeDayList(localSupplier.deliveryDays);

      const dataToSave: Partial<Supplier> = {
        ...localSupplier,
        name: normalizeText(localSupplier.name),
        phone: localSupplier.phone?.trim(),
        visitDays,
        deliveryDays,
        visitDay: toStorageCsv(visitDays),
        deliveryDay: toStorageCsv(deliveryDays),
      };
      await onSave(dataToSave);
    } catch (error: any) {
      console.error(error);

      // Manejo de Conflicto (Duplicados / Inactivos)
      if (error?.status === 409 || error?.message?.includes('ya existe')) {
        const existingData = error?.data || {};
        const isActive = existingData.active;
        const existingId = existingData.id;

        toast({
          variant: 'destructive',
          title: 'PROVEEDOR DUPLICADO',
          description: isActive
            ? `Ya existe un proveedor activo con el nombre "${localSupplier.name}".`
            : `Existe un registro inactivo para "${localSupplier.name}". ¿Deseas reactivarlo?`,
          action: !isActive && existingId ? (
            <Button
              size="sm"
              color="success"
              className="font-medium text-[9px] uppercase"
              onPress={async () => {
                try {
                  await onSave({ id: existingId, isActive: true });
                  toast({ title: 'EXITO', description: 'PROVEEDOR REACTIVADO CORRECTAMENTE' });
                  onOpenChange(false);
                } catch {
                  toast({ variant: 'destructive', title: 'ERROR', description: 'FALLO AL REACTIVAR' });
                }
              }}
            >
              REACTIVAR
            </Button>
          ) : undefined
        });
      } else {
        toast({ variant: 'destructive', title: 'ERROR', description: error?.message || 'FALLO AL GUARDAR PROVEEDOR' });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const updateField = (field: keyof Supplier, value: any) => {
    setLocalSupplier(prev => ({ ...prev, [field]: value }));
  };

  const commonInputClasses = {
    label: "text-[9px] font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-widest tracking-tight text-center w-full mb-0.5",
    inputWrapper: "h-11 bg-gray-50/80 dark:bg-[#18181b] border border-gray-200/50 dark:border-white/10 transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl focus-within:!border-emerald-500/40",
    input: "bg-transparent font-medium text-xs uppercase tracking-tight text-zinc-900 dark:text-zinc-50 text-left"
  };

  const selectedVisitDays = sanitizeDayList(localSupplier.visitDays);
  const selectedDeliveryDays = sanitizeDayList(localSupplier.deliveryDays);
  const learnedAtLabel = formatLearnedAt(learned.learnedAt);

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="lg"
      scrollBehavior="inside"
      backdrop="blur"
      classNames={{
        base: "bg-white dark:bg-zinc-950 rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-visible mx-2 md:mx-0 translate-y-2 md:translate-y-4",
        wrapper: "items-center justify-center p-8 md:p-12",
        backdrop: "bg-black/50 backdrop-blur-sm",
        closeButton: "absolute right-5 top-5 text-gray-500 dark:text-zinc-500 dark:text-zinc-400 hover:text-rose-500 transition-colors z-[100] rounded-2xl",
      }}
    >
      <ModalContent>
        {(onClose) => (
          <form onSubmit={handleSubmit} className="flex flex-col">
            <ModalHeader className="px-6 md:px-10 py-4 border-b border-gray-100 dark:border-white/5 rounded-t-[2.5rem]">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 flex items-center justify-center text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] transform -rotate-3 hover:rotate-0 transition-transform duration-500">
                  <Truck size={20} strokeWidth={1.5} />
                </div>
                <div className="flex flex-col">
                  <h2 className="text-base md:text-lg font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tight leading-none">
                    {isEdit ? "Gestion de Proveedor" : "Nuevo Proveedor"}
                  </h2>
                  <span className="text-[7px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-widest tracking-tight mt-0.5">Operacion Certificada</span>
                </div>
              </div>
            </ModalHeader>

            <ModalBody className="px-6 md:px-10 py-4 flex flex-col gap-4 overflow-hidden custom-scrollbar">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-0.5">
                    <label htmlFor="supplier-name" className={commonInputClasses.label}>EMPRESA / RAZON SOCIAL</label>
                    <Input
                      id="supplier-name"
                      placeholder=" "
                      value={localSupplier.name}
                      onValueChange={(v) => {
                        const name = normalizeText(v);
                        updateField('name', name);
                        if (!isEdit && name.length >= 3 && onLookupName) {
                          onLookupName(name);
                        }
                      }}
                      classNames={commonInputClasses}
                      startContent={<Building2 size={16} className="text-zinc-900 dark:text-zinc-100 mr-2" />}
                    />
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <label htmlFor="supplier-phone" className={commonInputClasses.label}>CONTACTO / TELEFONO</label>
                    <Input
                      id="supplier-phone"
                      placeholder=" "
                      value={localSupplier.phone}
                      onValueChange={(v) => updateField('phone', v)}
                      classNames={commonInputClasses}
                      startContent={<Phone size={16} className="text-zinc-900 dark:text-zinc-100 mr-2" />}
                    />
                  </div>

                  <div className="md:col-span-2 pt-2 pb-1 border-t border-gray-100 dark:border-white/5 flex items-center justify-center">
                    <span className="text-[8px] font-medium text-gray-400 uppercase tracking-[0.3em] tracking-tight">Logistica</span>
                  </div>

                  {/* AVISO PLANO EN LENGUAJE DEL DUENO */}
                  <div
                    className="md:col-span-2 flex items-start gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2"
                    role="note"
                    aria-label="Como usa el sistema los dias de visita y entrega"
                  >
                    <Info size={14} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                    <div className="text-[10px] leading-snug text-zinc-700 dark:text-zinc-200">
                      <p>
                        <span className="font-semibold">Dia de visita:</span> cuando pasa el preventista a tomar el pedido.
                        {' '}<span className="font-semibold">Dia de entrega:</span> cuando el proveedor deja la mercancia.
                      </p>
                      <p className="mt-1 text-zinc-500 dark:text-zinc-400">
                        Con eso el sistema calcula la fecha de entrega y cuanto se demora para avisarte cuando toca pedir.
                      </p>
                    </div>
                  </div>

                  {/* DIAS DE VISITA - Multi-Select con botones */}
                  <div className="md:col-span-2">
                    <fieldset>
                      <legend className={commonInputClasses.label}>DIAS DE VISITA (SELECCION MULTIPLE)</legend>
                      <div className="flex gap-1 mt-1.5 flex-wrap" role="group" aria-label="Dias de visita del preventista">
                        {WEEKDAYS_CANONICAL.map((day) => {
                          const isSelected = selectedVisitDays.includes(day);
                          return (
                            <Button
                              key={day}
                              size="sm"
                              type="button"
                              variant={isSelected ? 'solid' : 'flat'}
                              aria-pressed={isSelected}
                              aria-label={`${isSelected ? 'Quitar' : 'Agregar'} ${WEEKDAY_DISPLAY[day]} como dia de visita`}
                              className={`h-8 min-w-[40px] text-[10px] font-medium ${
                                isSelected
                                  ? 'bg-zinc-900 dark:bg-white text-white dark:text-black shadow-[0_8px_30px_rgb(0,0,0,0.12)]'
                                  : 'bg-gray-100 dark:bg-[#18181b] text-gray-500 dark:text-zinc-500 hover:bg-gray-200 border border-transparent dark:border-white/5'
                              }`}
                              onPress={() => toggleVisitDay(day)}
                            >
                              {WEEKDAY_SHORT[day]}
                            </Button>
                          );
                        })}
                      </div>
                    </fieldset>
                    <div className="flex items-center gap-1 mt-1">
                      <Calendar size={12} className="text-zinc-900 dark:text-zinc-100/60" aria-hidden="true" />
                      <span className="text-[9px] text-gray-500 dark:text-zinc-400">
                        {selectedVisitDays.length > 0
                          ? toDisplayDays(selectedVisitDays).join(', ')
                          : 'Sin dias marcados (no se disparan alertas de visita).'}
                      </span>
                    </div>
                  </div>

                  {/* DIAS DE ENTREGA - Multi-Select con botones */}
                  <div className="md:col-span-2">
                    <fieldset>
                      <legend className={commonInputClasses.label}>DIAS DE ENTREGA (SELECCION MULTIPLE)</legend>
                      <div className="flex gap-1 mt-1.5 flex-wrap" role="group" aria-label="Dias en que el proveedor entrega mercancia">
                        {WEEKDAYS_CANONICAL.map((day) => {
                          const isSelected = selectedDeliveryDays.includes(day);
                          return (
                            <Button
                              key={day}
                              size="sm"
                              type="button"
                              variant={isSelected ? 'solid' : 'flat'}
                              aria-pressed={isSelected}
                              aria-label={`${isSelected ? 'Quitar' : 'Agregar'} ${WEEKDAY_DISPLAY[day]} como dia de entrega`}
                              className={`h-8 min-w-[40px] text-[10px] font-medium ${
                                isSelected
                                  ? 'bg-orange-500 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-orange-500/20'
                                  : 'bg-gray-100 dark:bg-[#18181b] text-gray-500 dark:text-zinc-500 hover:bg-gray-200 border border-transparent dark:border-white/5'
                              }`}
                              onPress={() => toggleDeliveryDay(day)}
                            >
                              {WEEKDAY_SHORT[day]}
                            </Button>
                          );
                        })}
                      </div>
                    </fieldset>
                    <div className="flex items-center gap-1 mt-1">
                      <Truck size={12} className="text-orange-500/70" aria-hidden="true" />
                      <span className="text-[9px] text-gray-500 dark:text-zinc-400">
                        {selectedDeliveryDays.length > 0
                          ? toDisplayDays(selectedDeliveryDays).join(', ')
                          : 'Sin dias marcados (no se calcula fecha de entrega).'}
                      </span>
                    </div>
                  </div>

                  {/* AGENDA APRENDIDA POR EL SISTEMA */}
                  {isEdit && supplier && (
                    <div className="md:col-span-2">
                      <LearnedAgendaPanel
                        hasEvidence={learned.hasEvidence}
                        isReliable={learned.isReliable}
                        sampleCount={learned.sampleCount}
                        learnedVisitDays={learned.visitDays}
                        learnedDeliveryDays={learned.deliveryDays}
                        learnedLeadTimeDays={learned.leadTimeDays}
                        learnedAtLabel={learnedAtLabel}
                        visitContradiction={visitContradiction}
                        deliveryContradiction={deliveryContradiction}
                      />
                    </div>
                  )}

                  {/* METODO DE ABASTECIMIENTO */}
                  <div className="md:col-span-2">
                    <label htmlFor="supplier-restock" className={commonInputClasses.label}>METODO DE ABASTECIMIENTO PRINCIPAL</label>
                    <Select
                      id="supplier-restock"
                      aria-label="Metodo de abastecimiento principal"
                      placeholder="Selecciona metodo..."
                      selectedKeys={localSupplier.restockMethod ? [localSupplier.restockMethod] : []}
                      onSelectionChange={(keys) => updateField('restockMethod', Array.from(keys)[0] || '')}
                      selectorIcon={<ChevronDown className="text-gray-400 ml-2 shrink-0" size={16} />}
                      classNames={{
                        trigger: `${commonInputClasses.inputWrapper} mt-1 flex-row items-center justify-between px-3`,
                        innerWrapper: "flex-1 flex items-center",
                        value: "font-medium text-xs uppercase tracking-tight text-zinc-900 dark:text-zinc-50 truncate",
                        listbox: "bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]",
                        popoverContent: "bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]",
                      }}
                      listboxProps={{
                        itemClasses: {
                          base: "font-extrabold uppercase tracking-tight text-[10px] text-white data-[selected=true]:bg-black/5 dark:bg-white/5 data-[selected=true]:text-gray-600 dark:text-zinc-300 hover:bg-[#18181b]",
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

            <ModalFooter className="px-6 md:px-10 py-4 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-[#18181b]/50 rounded-b-[2.5rem]">
              {validationErrors.length > 0 && (
                <div className="w-full mb-3">
                  <ValidationErrors errors={validationErrors} />
                </div>
              )}
              <div className="flex w-full gap-3">
                <Button
                  variant="flat"
                  className="flex-1 h-10 rounded-2xl font-medium uppercase text-[9px] card-base border-none text-gray-400 tracking-tight tracking-widest border border-gray-100 dark:border-white/5"
                  onPress={onClose}
                >
                  CANCELAR
                </Button>
                <Button
                  type="submit"
                  isLoading={isSaving}
                  className="flex-[2] h-10 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 font-medium uppercase text-[10px] tracking-widest rounded-2xl transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 tracking-tight"
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

// ---------- SUB-COMPONENTES ----------

interface LearnedAgendaPanelProps {
  hasEvidence: boolean;
  isReliable: boolean;
  sampleCount: number;
  learnedVisitDays: string[];
  learnedDeliveryDays: string[];
  learnedLeadTimeDays: number | null;
  learnedAtLabel: string | null;
  visitContradiction: boolean;
  deliveryContradiction: boolean;
}

// Panel que muestra al dueno lo que el sistema aprendio observando sus
// pedidos y egresos. No es editable: es solo un espejo para que compare con
// lo que el escribio arriba y decida si corrige la ficha. Los datos vienen
// del batch nocturno (learn.go) y llegan por la respuesta del /suppliers.
function LearnedAgendaPanel({
  hasEvidence,
  isReliable,
  sampleCount,
  learnedVisitDays,
  learnedDeliveryDays,
  learnedLeadTimeDays,
  learnedAtLabel,
  visitContradiction,
  deliveryContradiction,
}: LearnedAgendaPanelProps) {
  const sampleLabel = sampleCount === 1 ? '1 registro observado' : `${sampleCount} registros observados`;
  const hasContradiction = visitContradiction || deliveryContradiction;

  if (!hasEvidence) {
    return (
      <section
        aria-label="Agenda aprendida por el sistema"
        className="mt-2 rounded-2xl border border-dashed border-zinc-300 dark:border-white/10 bg-zinc-50/60 dark:bg-white/5 px-3 py-2"
      >
        <div className="flex items-center gap-1.5">
          <Brain size={13} className="text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600 dark:text-zinc-300">
            El sistema observo
          </h3>
        </div>
        <p className="mt-1 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
          Todavia no hay evidencia observada para este proveedor. El calculo
          nocturno necesita al menos {LEARN_MIN_SAMPLES} egresos o pedidos
          confirmados para aprender el patron. Mientras tanto, lo que tu
          configures manda.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Agenda aprendida por el sistema"
      className={`mt-2 rounded-2xl border px-3 py-2 ${
        hasContradiction
          ? 'border-amber-500/40 bg-amber-500/5'
          : isReliable
            ? 'border-indigo-500/30 bg-indigo-500/5'
            : 'border-zinc-300 dark:border-white/10 bg-zinc-50/60 dark:bg-white/5'
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Brain size={13} className="text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-indigo-700 dark:text-indigo-300">
          El sistema observo
        </h3>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
            isReliable
              ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
          }`}
          title={
            isReliable
              ? `Respaldo solido: ${sampleLabel}`
              : `Respaldo debil: ${sampleLabel}. Se necesitan al menos ${LEARN_MIN_SAMPLES} registros para considerarlo confiable.`
          }
        >
          {sampleLabel}
        </span>
      </div>

      {hasContradiction && (
        <div
          role="alert"
          className="mt-2 flex items-start gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-900 dark:text-amber-100"
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
          <p className="text-[10px] leading-snug">
            <span className="font-semibold">Lo aprendido no coincide con lo que marcaste.</span>{' '}
            {visitContradiction && deliveryContradiction
              ? 'El sistema observo dias de visita y entrega distintos a los que marcaste arriba.'
              : visitContradiction
                ? 'El sistema observo un dia de visita distinto al que marcaste.'
                : 'El sistema observo un dia de entrega distinto al que marcaste.'}
            {' '}Revisa si el ruteo cambio o si toca ajustar.
          </p>
        </div>
      )}

      <dl className="mt-2 grid grid-cols-1 gap-1 text-[10px]">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="font-semibold uppercase text-zinc-500 dark:text-zinc-400">Visita observada</dt>
          <dd
            className={`text-right font-semibold text-zinc-900 dark:text-white ${
              visitContradiction ? 'underline decoration-amber-500 decoration-2 underline-offset-2' : ''
            }`}
          >
            {learnedVisitDays.length > 0
              ? toDisplayDays(learnedVisitDays).join(', ')
              : 'sin patron claro'}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="font-semibold uppercase text-zinc-500 dark:text-zinc-400">Entrega observada</dt>
          <dd
            className={`text-right font-semibold text-zinc-900 dark:text-white ${
              deliveryContradiction ? 'underline decoration-amber-500 decoration-2 underline-offset-2' : ''
            }`}
          >
            {learnedDeliveryDays.length > 0
              ? toDisplayDays(learnedDeliveryDays).join(', ')
              : 'sin patron claro'}
          </dd>
        </div>
        {learnedLeadTimeDays !== null && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="font-semibold uppercase text-zinc-500 dark:text-zinc-400">Demora observada</dt>
            <dd className="text-right font-semibold text-zinc-900 dark:text-white">
              {learnedLeadTimeDays} {learnedLeadTimeDays === 1 ? 'dia' : 'dias'} (mediana)
            </dd>
          </div>
        )}
      </dl>

      {(learnedAtLabel || !isReliable) && (
        <p className="mt-2 flex items-start gap-1 text-[9px] text-zinc-500 dark:text-zinc-400">
          <Info size={10} className="mt-[1px] shrink-0" aria-hidden="true" />
          <span>
            {!isReliable ? (
              <>
                Respaldo debil, aun no confiable. Se activa con {LEARN_MIN_SAMPLES}+ registros.
                {learnedAtLabel ? ` Ultimo calculo: ${learnedAtLabel}.` : ''}
              </>
            ) : (
              <>Ultimo calculo: {learnedAtLabel}</>
            )}
          </span>
        </p>
      )}
    </section>
  );
}
