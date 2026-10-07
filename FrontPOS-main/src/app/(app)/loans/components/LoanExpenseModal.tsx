"use client";

/**
 * LoanExpenseModal — registra un uso del principal del préstamo. Es la pieza
 * del "control de gastos" del detalle: cada movimiento genera un `expense`
 * normal en el libro mayor (categoría Proveedores u Otros) y una fila en
 * `loan_expenses` que lo ata al préstamo.
 *
 * La validación `amountUsed <= available` se hace en el backend (devuelve
 * `LOAN_PRINCIPAL_EXCEEDED` si se pasa). Aquí sólo guiamos al operador.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Receipt, X, Banknote } from "lucide-react";

import { formatLoanMoney } from "@/lib/loans.mjs";

interface LoanExpenseModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  available: number;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}

const CATEGORIES = [
  { id: "Proveedores", label: "Proveedores" },
  { id: "Servicios Publicos", label: "Servicios Públicos" },
  { id: "Nomina", label: "Nómina" },
  { id: "Danos / Arreglos", label: "Daños / Arreglos" },
  { id: "Otros Gastos", label: "Otros Gastos" },
];

export default function LoanExpenseModal({
  isOpen,
  onOpenChange,
  available,
  onSubmit,
}: LoanExpenseModalProps) {
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [category, setCategory] = useState<string>("Otros Gastos");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setAmount("");
      setPurpose("");
      setCategory("Otros Gastos");
      setSubmitting(false);
    }
  }, [isOpen]);

  const parsedAmount = Number(amount || 0);
  const exceeds = parsedAmount > available + 0.5;
  const canSubmit = useMemo(() => {
    return !submitting && parsedAmount > 0 && !exceeds && purpose.trim().length > 0;
  }, [submitting, parsedAmount, exceeds, purpose]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit({
        amountUsed: parsedAmount,
        purpose: purpose.trim().toUpperCase(),
        category,
      });
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, parsedAmount, purpose, category, onSubmit]);

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="md"
      placement="center"
      hideCloseButton
      classNames={{
        base: "bg-white dark:bg-zinc-950 rounded-3xl border border-gray-200 dark:border-white/10",
        header: "border-b border-gray-200 dark:border-white/10 px-6 py-4",
        footer: "border-t border-gray-200 dark:border-white/10 px-6 py-4 bg-gray-50 dark:bg-[#18181b]",
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-md">
                  <Receipt size={22} />
                </div>
                <div className="flex flex-col">
                  <h2 className="text-base font-bold uppercase leading-tight tracking-tight">
                    Registrar uso del principal
                  </h2>
                  <p className="text-[11px] font-medium text-gray-500 dark:text-zinc-400">
                    Disponible: <strong className="text-amber-500">{formatLoanMoney(available)}</strong>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Cerrar"
                className="rounded-xl p-2 text-gray-400 hover:bg-rose-500/10 hover:text-rose-500"
              >
                <X size={20} />
              </button>
            </ModalHeader>
            <ModalBody className="flex flex-col gap-3 py-4">
              <Input
                isRequired
                size="sm"
                type="number"
                inputMode="numeric"
                label="Monto a usar (COP)"
                labelPlacement="outside"
                placeholder="0"
                value={amount}
                onValueChange={(v) => setAmount(v.replace(/[^0-9.]/g, ""))}
                startContent={<Banknote size={14} className="text-amber-500" />}
                aria-label="Monto a usar del principal"
                errorMessage={exceeds ? `Excede el disponible (${formatLoanMoney(available)})` : undefined}
                isInvalid={exceeds}
              />
              <Input
                isRequired
                size="sm"
                label="Propósito"
                labelPlacement="outside"
                placeholder="¿En qué se usó?"
                value={purpose}
                onValueChange={setPurpose}
                aria-label="Propósito del uso del principal"
              />
              <Select
                size="sm"
                label="Categoría contable"
                labelPlacement="outside"
                selectedKeys={new Set([category])}
                onSelectionChange={(keys) => {
                  const [first] = Array.from(keys);
                  if (first) setCategory(String(first));
                }}
                aria-label="Categoría del gasto"
              >
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.id}>{c.label}</SelectItem>
                ))}
              </Select>
            </ModalBody>
            <ModalFooter className="gap-2">
              <Button variant="light" onPress={onClose} className="font-semibold uppercase">
                Cancelar
              </Button>
              <Button
                isLoading={submitting}
                isDisabled={!canSubmit}
                onPress={handleSubmit}
                className="rounded-xl bg-amber-500 px-6 font-bold uppercase tracking-wide text-white"
              >
                Registrar
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
