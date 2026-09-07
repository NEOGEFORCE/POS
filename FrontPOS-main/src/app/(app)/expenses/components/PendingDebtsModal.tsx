"use client";

import React, { useState, useMemo } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, ScrollShadow
} from "@heroui/react";
import { HandCoins, Activity, ChevronRight, X, AlertTriangle } from 'lucide-react';
import { Expense } from '@/lib/definitions';
import { ExpensePaymentModal } from './ExpensePaymentModal';
import { groupPayablesByCreditor, liveDebtPrincipal, liveDebtTotal, sumPayables } from '@/lib/payables.mjs';

interface PendingDebtsModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  debts: Expense[];
  onSettle: (id: string, paymentData: any, amount: number) => Promise<void>;
  isAdmin?: boolean;
  onForceClose?: (id: string) => Promise<void>;
}

const money = (value: number) => `$${Math.round(value).toLocaleString('es-CO')}`;

const PendingDebtsModal = ({ isOpen, onOpenChange, debts, onSettle, isAdmin, onForceClose }: PendingDebtsModalProps) => {
  const [currentDebtId, setCurrentDebtId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [currentDebtAmount, setCurrentDebtAmount] = useState(0);
  // Confirmación de condonar con modal propio: el proyecto está sacando los
  // diálogos nativos del navegador porque bloquean el hilo y se ven distintos
  // en cada equipo.
  const [debtToForgive, setDebtToForgive] = useState<Expense | null>(null);

  const handleSettleClick = async (paymentData: any) => {
    if (!currentDebtId) return;
    setIsProcessing(true);

    const totalAmountPaid = paymentData.cash + paymentData.nequi + paymentData.daviplata + paymentData.fondo;

    try {
      await onSettle(currentDebtId, paymentData, totalAmountPaid);
      setIsPaymentModalOpen(false);
    } catch (e) {
      console.error(e);
    } finally {
      setIsProcessing(false);
    }
  };

  // Agrupado por acreedor y ORDENADO DE MAYOR A MENOR deuda, con subtotal por
  // grupo: lo primero que uno quiere saber es a quién le debe más.
  const groups = useMemo(() => groupPayablesByCreditor(debts), [debts]);
  const grandTotal = useMemo(() => sumPayables(debts), [debts]);

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="3xl"
      scrollBehavior="inside"
      placement="center"
      hideCloseButton
      classNames={{
        base: "bg-white dark:bg-zinc-950 rounded-3xl border border-gray-200 dark:border-white/10",
        header: "border-b border-gray-200 dark:border-white/10 px-6 py-4",
        footer: "border-t border-gray-200 dark:border-white/10 px-6 py-4 bg-gray-50 dark:bg-[#18181b]",
        body: "px-6 py-4"
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-md">
                  <HandCoins size={22} />
                </div>
                <div className="flex flex-col">
                  <h2 className="text-xl font-bold uppercase leading-tight tracking-tight">
                    Centro de <span className="text-amber-500">pagos</span>
                  </h2>
                  <p className="text-[12px] font-medium text-gray-500 dark:text-zinc-400">
                    {debts.length === 0
                      ? "Sin deudas pendientes"
                      : `${debts.length} ${debts.length === 1 ? "factura" : "facturas"} por pagar · ${groups.length} ${groups.length === 1 ? "acreedor" : "acreedores"}`}
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Cerrar centro de pagos"
                className="rounded-xl p-2 text-gray-400 transition-colors hover:bg-rose-500/10 hover:text-rose-500"
              >
                <X size={22} />
              </button>
            </ModalHeader>

            <ModalBody>
              {debts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border-2 border-dashed border-emerald-500/40 text-emerald-500">
                    <Activity size={28} />
                  </div>
                  <h3 className="text-base font-bold uppercase tracking-wide text-zinc-900 dark:text-zinc-50">Todo al día</h3>
                  <p className="mt-1 text-[13px] font-medium text-gray-500 dark:text-zinc-400">
                    No hay facturas pendientes de pago.
                  </p>
                </div>
              ) : (
                <ScrollShadow className="max-h-[62vh] space-y-5 pr-1">
                  {groups.map(({ creditor, debts: creditorDebts, total }) => (
                    <section key={creditor} className="flex flex-col gap-2">
                      {/* Cabecera de acreedor CON SU SUBTOTAL: así se ve de una
                          a quién se le debe más sin sumar de memoria. */}
                      <header className="flex items-baseline justify-between gap-3 border-b border-amber-500/30 pb-1.5">
                        <h3 className="truncate text-[15px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                          {creditor}
                        </h3>
                        <div className="flex shrink-0 items-baseline gap-2">
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-400">
                            {creditorDebts.length} {creditorDebts.length === 1 ? "factura" : "facturas"}
                          </span>
                          <span className="text-[17px] font-bold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">
                            {money(total)}
                          </span>
                        </div>
                      </header>

                      {creditorDebts.map((debt) => {
                        const principal = liveDebtPrincipal(debt);
                        const tax = liveDebtTotal(debt) - principal;
                        const owed = liveDebtTotal(debt);
                        const isBusy = isProcessing && currentDebtId === String(debt.id);

                        return (
                          <div
                            key={debt.id}
                            className="flex items-center gap-3 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 transition-colors hover:bg-white dark:border-white/10 dark:bg-[#18181b]/50 dark:hover:bg-[#18181b]"
                          >
                            {/* Concepto */}
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[14px] font-semibold uppercase leading-tight text-zinc-900 dark:text-zinc-50" title={debt.description}>
                                {debt.description}
                              </p>
                              <p className="mt-0.5 text-[11px] font-medium text-gray-500 dark:text-zinc-500">
                                Factura #{String(debt.id).slice(-6).toUpperCase()}
                                {tax > 0.5 && <> · Incluye {money(tax)} de impuesto</>}
                              </p>
                            </div>

                            {/* Monto: es el dato que manda en la fila */}
                            <div className="shrink-0 text-right">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-rose-500">Debe</p>
                              <p className="text-[20px] font-bold tabular-nums leading-none tracking-tight text-zinc-900 dark:text-zinc-50">
                                {money(owed)}
                              </p>
                            </div>

                            {/* Acciones proporcionadas: ya no ocupan un renglón
                                propio, así entran muchas más deudas en pantalla. */}
                            <div className="flex shrink-0 items-center gap-1.5">
                              <Button
                                size="sm"
                                isLoading={isBusy}
                                className="h-10 rounded-xl bg-emerald-600 px-4 text-[12px] font-bold uppercase tracking-wide text-white transition-transform active:scale-95"
                                onPress={() => {
                                  setCurrentDebtId(String(debt.id));
                                  setCurrentDebtAmount(owed);
                                  setIsPaymentModalOpen(true);
                                }}
                              >
                                Abonar <ChevronRight size={14} />
                              </Button>
                              {isAdmin && onForceClose && (
                                <Button
                                  size="sm"
                                  isIconOnly
                                  aria-label={`Condonar la factura ${debt.description}`}
                                  title="Condonar (quitar sin registrar egreso)"
                                  className="h-10 w-10 min-w-10 rounded-xl bg-transparent text-gray-400 transition-colors hover:bg-rose-500/10 hover:text-rose-500"
                                  onPress={() => setDebtToForgive(debt)}
                                >
                                  <X size={16} />
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </section>
                  ))}
                </ScrollShadow>
              )}
            </ModalBody>

            <ModalFooter className="flex items-center justify-between gap-4">
              <div className="flex flex-col">
                <span className="text-[12px] font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-400">
                  Total por pagar
                </span>
                {/* El total general es el número más grande del modal: es la
                    pregunta que uno viene a responder. */}
                <span className="text-3xl font-bold tabular-nums leading-none tracking-tight text-rose-500">
                  {money(grandTotal)}
                </span>
              </div>
              <Button
                variant="flat"
                className="rounded-xl bg-gray-200 px-6 text-[12px] font-bold uppercase tracking-wide text-zinc-900 dark:bg-[#18181b] dark:text-zinc-50"
                onPress={onClose}
              >
                Cerrar
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>

      <ExpensePaymentModal
        isOpen={isPaymentModalOpen}
        onOpenChange={setIsPaymentModalOpen}
        title="Liquidar Deuda"
        totalToPay={currentDebtAmount}
        onPay={handleSettleClick}
      />

      {/* Confirmación de condonar. Reemplaza al diálogo nativo del navegador,
          que bloqueaba el hilo y no dejaba ver de qué factura se trataba. */}
      <Modal
        isOpen={debtToForgive !== null}
        onOpenChange={(open) => { if (!open) setDebtToForgive(null); }}
        size="md"
        placement="center"
        classNames={{ base: "bg-white dark:bg-zinc-950 rounded-3xl border-2 border-rose-500/50" }}
      >
        <ModalContent>
          <ModalHeader className="flex items-center gap-3 text-rose-500">
            <AlertTriangle size={22} />
            <span className="text-base font-bold uppercase tracking-tight">Condonar deuda</span>
          </ModalHeader>
          <ModalBody className="pb-2">
            <p className="text-[14px] font-medium leading-relaxed text-zinc-900 dark:text-zinc-100">
              La factura <strong className="uppercase">{debtToForgive?.description}</strong> por{" "}
              <strong className="tabular-nums">{debtToForgive ? money(liveDebtTotal(debtToForgive)) : ""}</strong>{" "}
              se marcará como pagada.
            </p>
            <p className="text-[13px] font-semibold text-rose-500">
              NO se registra ningún egreso de caja, así que esta plata no va a aparecer como salida en ningún reporte.
              Usá esta opción sólo si la deuda desapareció sin que hubiera pago.
            </p>
          </ModalBody>
          <ModalFooter className="gap-2">
            <Button variant="light" className="font-semibold uppercase" onPress={() => setDebtToForgive(null)}>
              Cancelar
            </Button>
            <Button
              isLoading={isProcessing}
              className="rounded-xl bg-rose-500 px-6 font-bold uppercase tracking-wide text-white"
              onPress={async () => {
                if (!debtToForgive || !onForceClose) return;
                setCurrentDebtId(String(debtToForgive.id));
                setIsProcessing(true);
                try {
                  await onForceClose(String(debtToForgive.id));
                  setDebtToForgive(null);
                } finally {
                  setIsProcessing(false);
                }
              }}
            >
              Condonar
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Modal>
  );
};

export default PendingDebtsModal;
