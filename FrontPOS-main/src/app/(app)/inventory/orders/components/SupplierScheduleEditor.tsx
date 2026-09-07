"use client";

import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import { CalendarDays, Save } from "lucide-react";

import type { Supplier } from "@/lib/definitions";
import {
  WEEKDAYS_CANONICAL,
  parseSupplierDays,
  sanitizeDayList,
  toDisplayDays,
} from "@/lib/supplier-days.mjs";
import type { CanonicalWeekday } from "@/lib/supplier-days.d.mts";
import type { SupplierSchedulePayload } from "@/lib/orders-admin-actions.mjs";

interface SupplierScheduleEditorProps {
  isOpen: boolean;
  supplier: Supplier | null;
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (payload: SupplierSchedulePayload) => Promise<void>;
}

function toggleDay(current: string[], day: CanonicalWeekday): string[] {
  return current.includes(day)
    ? sanitizeDayList(current.filter((value) => value !== day))
    : sanitizeDayList([...current, day]);
}

function DaySelector({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (days: string[]) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-[10px] font-black uppercase tracking-widest text-zinc-600 dark:text-zinc-300">{label}</legend>
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
        {WEEKDAYS_CANONICAL.map((day) => {
          const selected = value.includes(day);
          const display = toDisplayDays([day])[0] ?? day;
          return (
            <button
              key={day}
              type="button"
              aria-pressed={selected}
              aria-label={`${selected ? "Quitar" : "Agregar"} ${display} en ${label.toLowerCase()}`}
              onClick={() => onChange(toggleDay(value, day as CanonicalWeekday))}
              className={`min-h-10 rounded-xl border px-1.5 text-[10px] font-black uppercase transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                selected
                  ? "border-amber-500 bg-amber-500 text-white"
                  : "border-zinc-200 bg-zinc-50 text-zinc-600 hover:border-amber-500/50 dark:border-white/10 dark:bg-[#121214] dark:text-zinc-300"
              }`}
              title={display}
            >
              {display.slice(0, 2)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function SupplierScheduleEditor({
  isOpen,
  supplier,
  isSaving,
  onOpenChange,
  onSave,
}: SupplierScheduleEditorProps) {
  const [visitDays, setVisitDays] = useState<string[]>([]);
  const [deliveryDays, setDeliveryDays] = useState<string[]>([]);
  const [leadTimeDays, setLeadTimeDays] = useState("0");

  useEffect(() => {
    if (!supplier || !isOpen) return;
    setVisitDays(parseSupplierDays({ days: supplier.visitDays, csv: supplier.visitDay }));
    setDeliveryDays(parseSupplierDays({ days: supplier.deliveryDays, csv: supplier.deliveryDay }));
    const lead = Number(supplier.leadTimeDays ?? 0);
    setLeadTimeDays(String(Number.isFinite(lead) ? Math.min(60, Math.max(0, Math.trunc(lead))) : 0));
  }, [isOpen, supplier]);

  const submit = () => {
    const numericLead = Number(leadTimeDays);
    void onSave({
      visitDays: sanitizeDayList(visitDays),
      deliveryDays: sanitizeDayList(deliveryDays),
      leadTimeDays: Number.isFinite(numericLead) ? Math.min(60, Math.max(0, Math.trunc(numericLead))) : 0,
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      placement="center"
      scrollBehavior="inside"
      size="2xl"
      classNames={{
        base: "mx-3 rounded-2xl border border-zinc-200 bg-white dark:border-white/10 dark:bg-zinc-900",
        backdrop: "bg-black/60",
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex items-start gap-3 border-b border-zinc-200 px-5 py-4 dark:border-white/10">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
                <CalendarDays size={20} aria-hidden="true" />
              </span>
              <span>
                <span className="block text-base font-black uppercase text-zinc-900 dark:text-white">Configurar agenda aquí</span>
                <span className="block text-xs font-medium text-zinc-500">{supplier?.name ?? "Proveedor"}</span>
              </span>
            </ModalHeader>
            <ModalBody className="gap-5 px-5 py-5">
              <DaySelector label="Días de visita" value={visitDays} onChange={setVisitDays} />
              <DaySelector label="Días de entrega" value={deliveryDays} onChange={setDeliveryDays} />
              <Input
                type="number"
                min={0}
                max={60}
                step={1}
                label="Lead time manual (días)"
                description="0 limpia el lead time manual. Rango permitido: 0 a 60."
                value={leadTimeDays}
                onValueChange={setLeadTimeDays}
                inputMode="numeric"
                classNames={{
                  inputWrapper: "min-h-12 rounded-xl border border-zinc-200 bg-zinc-50 shadow-none dark:border-white/10 dark:bg-[#121214]",
                }}
              />
              <p className="rounded-xl border border-sky-500/20 bg-sky-500/10 p-3 text-xs text-sky-800 dark:text-sky-200">
                Sólo se guardará tu agenda manual. Lo aprendido por el sistema no se modifica automáticamente.
              </p>
            </ModalBody>
            <ModalFooter className="border-t border-zinc-200 px-5 py-4 dark:border-white/10">
              <Button variant="flat" onPress={onClose} isDisabled={isSaving}>Cancelar</Button>
              <Button
                color="success"
                onPress={submit}
                isLoading={isSaving}
                isDisabled={isSaving}
                startContent={!isSaving && <Save size={15} aria-hidden="true" />}
              >
                Guardar agenda
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
