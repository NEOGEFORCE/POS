"use client";

/**
 * PayablesCenter — Centro de Pagos / Cuentas por pagar.
 *
 * Antes vivía como MODAL dentro de /expenses. Ahora vive como SECCIÓN
 * EMBEBIDA dentro de la pestaña "Cuentas por pagar" de /loans (ver
 * `src/app/(app)/loans/page.tsx`).
 *
 * Esta mudanza es por diseño: el Centro de Pagos y el módulo de Préstamos
 * son flujos de deuda hermanos; tenerlos bajo el mismo techo evita que el
 * cajero tenga que recordar que "las cuentas por pagar están en Egresos
 * pero los préstamos están en Préstamos".
 *
 * Contrato:
 *   - Recibe las deudas vivas por props (`debts`), ya filtradas con
 *     `selectLiveDebts` por el padre. No vuelve a filtrar.
 *   - Dispara `onSettle(id, paymentData, amount)` cuando el usuario abona
 *     usando el `ExpensePaymentModal` reutilizado del módulo de egresos.
 *   - Dispara `onForceClose(id)` cuando el admin condona la deuda, con
 *     confirmación propia (`debtToForgive`). JAMÁS usa diálogos nativos.
 *   - La agrupación por acreedor y el total vienen de `@/lib/payables.mjs`,
 *     que es la fuente ÚNICA de la fórmula de cuentas por pagar.
 */

import { useMemo, useState } from "react";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  ScrollShadow,
} from "@heroui/react";
import { HandCoins, Activity, ChevronRight, X, AlertTriangle } from "lucide-react";

import { Expense } from "@/lib/definitions";
import { ExpensePaymentModal, type LoanOption } from "@/app/(app)/expenses/components/ExpensePaymentModal";
import {
  groupPayablesByCreditor,
  liveDebtPrincipal,
  liveDebtTotal,
  sumPayables,
} from "@/lib/payables.mjs";

interface PayablesCenterProps {
  debts: Expense[];
  onSettle: (id: string, paymentData: unknown, amount: number) => Promise<void>;
  isAdmin?: boolean;
  onForceClose?: (id: string) => Promise<void>;
  /**
   * Si viene con préstamos activos y `enabled=true`, el modal de pago
   * mostrará la pestaña "Préstamo" para abonar deudas con el disponible
   * del préstamo elegido. El padre decide cuáles préstamos (admin only,
   * ACTIVE/DEFAULTED, available = liveLoanAvailable).
   */
  loanOption?: LoanOption;
}

const money = (value: number) => `$${Math.round(value).toLocaleString("es-CO")}`;

export default function PayablesCenter({
  debts,
  onSettle,
  isAdmin,
  onForceClose,
  loanOption,
}: PayablesCenterProps) {
  const [currentDebtId, setCurrentDebtId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [currentDebtAmount, setCurrentDebtAmount] = useState(0);
  // Confirmación de condonar con modal propio: reemplaza al diálogo nativo
  // del navegador que bloqueaba el hilo y no mostraba de qué factura se
  // trataba. El guardián `tests/payables.test.mjs` verifica que `debtToForgive`
  // esté presente en el Centro de Pagos.
  const [debtToForgive, setDebtToForgive] = useState<Expense | null>(null);

  const groups = useMemo(() => groupPayablesByCreditor(debts), [debts]);
  const grandTotal = useMemo(() => sumPayables(debts), [debts]);

  const handleSettleClick = async (paymentData: {
    cash: number;
    nequi: number;
    daviplata: number;
    fondo: number;
    coins: number;
    paymentSourceString: string;
    taxAmount: number;
    loanId?: number | string;
  }) => {
    if (!currentDebtId) return;
    setIsProcessing(true);
    // Para un abono con préstamo, el "monto pagado" es el totalToPay del
    // modal (ya que los cinco canales vienen en 0). Si no hay loanId,
    // sumamos los canales como siempre.
    const totalAmountPaid = paymentData.loanId
      ? currentDebtAmount
      : paymentData.cash +
        paymentData.nequi +
        paymentData.daviplata +
        paymentData.fondo +
        paymentData.coins;
    try {
      await onSettle(currentDebtId, paymentData, totalAmountPaid);
      setIsPaymentModalOpen(false);
    } catch (e) {
      console.error(e);
      throw e;
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <section
      aria-label="Centro de pagos — Cuentas por pagar"
      className="flex flex-col flex-1 min-h-0 gap-3"
    >
      {/* RESUMEN SUPERIOR (mantiene jerarquía: lo primero que se ve es a
          cuánto se debe y a cuántos acreedores). */}
      <header
        role="group"
        aria-label="Resumen de cuentas por pagar"
        className="flex flex-col gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-md">
            <HandCoins size={22} />
          </div>
          <div className="flex min-w-0 flex-col">
            <h2 className="text-base font-bold uppercase leading-tight tracking-tight text-zinc-900 dark:text-zinc-50">
              Centro de <span className="text-amber-500">pagos</span>
            </h2>
            <p className="text-[11px] font-medium text-gray-500 dark:text-zinc-400">
              {debts.length === 0
                ? "Sin deudas pendientes"
                : `${debts.length} ${debts.length === 1 ? "factura" : "facturas"} · ${groups.length} ${groups.length === 1 ? "acreedor" : "acreedores"}`}
            </p>
          </div>
        </div>
        <div className="flex flex-col text-left sm:text-right">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-400">
            Total por pagar
          </span>
          <span className="text-2xl font-bold tabular-nums leading-none tracking-tight text-rose-500 sm:text-3xl">
            {money(grandTotal)}
          </span>
        </div>
      </header>

      {/* LISTA DE DEUDAS */}
      {debts.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border-2 border-dashed border-emerald-500/40 text-emerald-500">
            <Activity size={28} />
          </div>
          <h3 className="text-base font-bold uppercase tracking-wide text-zinc-900 dark:text-zinc-50">
            Todo al día
          </h3>
          <p className="mt-1 text-[13px] font-medium text-gray-500 dark:text-zinc-400">
            No hay facturas pendientes de pago.
          </p>
        </div>
      ) : (
        <ScrollShadow className="flex-1 min-h-0 space-y-5 overflow-y-auto pr-1 custom-scrollbar">
          {groups.map(({ creditor, debts: creditorDebts, total }) => (
            <section key={creditor} className="flex flex-col gap-2">
              <header className="flex items-baseline justify-between gap-3 border-b border-amber-500/30 pb-1.5">
                <h3 className="truncate text-[14px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                  {creditor}
                </h3>
                <div className="flex shrink-0 items-baseline gap-2">
                  <span className="hidden text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-400 sm:inline">
                    {creditorDebts.length}{" "}
                    {creditorDebts.length === 1 ? "factura" : "facturas"}
                  </span>
                  <span className="text-[16px] font-bold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">
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
                    className="flex flex-col gap-3 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 transition-colors hover:bg-white dark:border-white/10 dark:bg-[#18181b]/50 dark:hover:bg-[#18181b] sm:flex-row sm:items-center sm:gap-3"
                  >
                    {/* Concepto */}
                    <div className="min-w-0 flex-1">
                      <p
                        className="truncate text-[14px] font-semibold uppercase leading-tight text-zinc-900 dark:text-zinc-50"
                        title={debt.description}
                      >
                        {debt.description}
                      </p>
                      <p className="mt-0.5 text-[11px] font-medium text-gray-500 dark:text-zinc-500">
                        Factura #{String(debt.id).slice(-6).toUpperCase()}
                        {tax > 0.5 && <> · Incluye {money(tax)} de impuesto</>}
                      </p>
                    </div>

                    {/* Monto adeudado */}
                    <div className="shrink-0 text-right">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-500">
                        Debe
                      </p>
                      <p className="text-[20px] font-bold tabular-nums leading-none tracking-tight text-zinc-900 dark:text-zinc-50">
                        {money(owed)}
                      </p>
                    </div>

                    {/* Acciones */}
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        isLoading={isBusy}
                        className="h-10 min-w-[120px] flex-1 rounded-xl bg-emerald-600 px-4 text-[12px] font-bold uppercase tracking-wide text-white transition-transform active:scale-95 sm:flex-none"
                        onPress={() => {
                          setCurrentDebtId(String(debt.id));
                          setCurrentDebtAmount(owed);
                          setIsPaymentModalOpen(true);
                        }}
                        aria-label={`Abonar la factura ${debt.description}`}
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

      <ExpensePaymentModal
        isOpen={isPaymentModalOpen}
        onOpenChange={setIsPaymentModalOpen}
        title="Liquidar Deuda"
        totalToPay={currentDebtAmount}
        loanOption={loanOption}
        onPay={handleSettleClick}
      />

      {/* Confirmación de condonar. NO es nativo del navegador — es un
          HeroUI Modal con contexto y descargo explícito del impacto en caja. */}
      <Modal
        isOpen={debtToForgive !== null}
        onOpenChange={(open) => {
          if (!open) setDebtToForgive(null);
        }}
        size="md"
        placement="center"
        classNames={{
          base: "bg-white dark:bg-zinc-950 rounded-3xl border-2 border-rose-500/50",
        }}
      >
        <ModalContent>
          <ModalHeader className="flex items-center gap-3 text-rose-500">
            <AlertTriangle size={22} />
            <span className="text-base font-bold uppercase tracking-tight">
              Condonar deuda
            </span>
          </ModalHeader>
          <ModalBody className="pb-2">
            <p className="text-[14px] font-medium leading-relaxed text-zinc-900 dark:text-zinc-100">
              La factura{" "}
              <strong className="uppercase">{debtToForgive?.description}</strong>{" "}
              por{" "}
              <strong className="tabular-nums">
                {debtToForgive ? money(liveDebtTotal(debtToForgive)) : ""}
              </strong>{" "}
              se marcará como pagada.
            </p>
            <p className="text-[13px] font-semibold text-rose-500">
              NO se registra ningún egreso de caja, así que esta plata no va a
              aparecer como salida en ningún reporte. Usá esta opción sólo si la
              deuda desapareció sin que hubiera pago.
            </p>
          </ModalBody>
          <ModalFooter className="gap-2">
            <Button
              variant="light"
              className="font-semibold uppercase"
              onPress={() => setDebtToForgive(null)}
            >
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
    </section>
  );
}
