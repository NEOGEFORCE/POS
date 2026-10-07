"use client";

/**
 * /loans/detail?id=X — Detalle de un préstamo.
 *
 * Tres secciones (patrón `FRONTEND_LAYOUT_RULES.md`):
 *   1. Encabezado: acreedor, principal, saldo, estado, canal.
 *   2. Amortización: tabla de cuotas, botón "Pagar cuota" por fila que abre
 *      `ExpensePaymentModal` (reutilizado del módulo de egresos). El pago
 *      cumple el contrato POST /loans/:id/installments/:number/pay con el
 *      desglose por canal — el BACKEND crea el `expense` real (status PAID,
 *      canal explícito) dentro de la misma transacción. El frontend NUNCA
 *      fabrica un expense con `paymentSource='PRESTAMO'`.
 *   3. Tracker de uso del principal: lista de `loan_expenses` + botón para
 *      registrar en qué se gastó el dinero recibido. Muestra "Disponible =
 *      principal - Σ(amountUsed)". Este tracker NO crea el gasto contable
 *      en /expenses; es sólo una bitácora de a dónde fue el dinero del
 *      préstamo. El gasto contable (si existe) se registra aparte en el
 *      módulo de egresos.
 *
 * Contratos:
 *   GET  /loans/:id                                   → { loan: LoanRecord }
 *   POST /loans/:id/installments/:number/pay          → pago exacto; cubre
 *       el saldo PENDIENTE completo de la cuota (contrato actual del
 *       backend; tolerancia ±1 centavo). Códigos: LOAN_INSTALLMENT_NOT_FOUND,
 *       LOAN_INSTALLMENT_ALREADY_PAID.
 *   POST /loans/:id/expenses                          → tracker de uso de
 *       principal. Códigos: LOAN_PRINCIPAL_EXCEEDED.
 *   GET  /loans/:id devuelve 404 con código LOAN_NOT_FOUND cuando no existe.
 *
 * Static export: no se usa `[id]` dinámico; en su lugar se lee el id del
 * query param del navegador. Esto es consistente con el resto del proyecto
 * que no usa rutas dinámicas.
 */

import { useCallback, useEffect, useMemo, useState, Suspense } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Button,
  Chip,
  Spinner,
  Progress,
  ScrollShadow,
} from "@heroui/react";
import {
  ArrowLeft,
  HandCoins,
  CalendarClock,
  TrendingDown,
  CheckCircle2,
  AlertTriangle,
  Receipt,
  PlusCircle,
  RefreshCw,
  RotateCcw,
  Wallet,
  Clock,
  Info,
  Landmark,
  Pencil,
} from "lucide-react";

import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/auth-helpers.mjs";
import { apiFetch, ApiError } from "@/lib/api-error";
import { useToast } from "@/hooks/use-toast";
import { broadcastRevalidate, setupSyncListener } from "@/lib/revalidate";
import {
  classifyInstallment,
  formatLoanMoney,
  installmentProgress,
  liveLoanAvailable,
  liveLoanOutstanding,
  loanProgress,
  nextInstallmentDelta,
  normalizeLoanDetailResponse,
  totalPaidOfLoan,
  type LoanInstallmentRecord,
  type LoanRecord,
} from "@/lib/loans.mjs";

const ExpensePaymentModal = dynamic(
  () => import("@/app/(app)/expenses/components/ExpensePaymentModal").then((mod) => mod.ExpensePaymentModal),
  { ssr: false },
);

const LoanExpenseModal = dynamic(() => import("../components/LoanExpenseModal"), { ssr: false });
const LoanFormModal = dynamic(() => import("../components/LoanFormModal"), { ssr: false });

const STATUS_CHIP: Record<string, { label: string; color: "warning" | "success" | "danger" | "default" }> = {
  ACTIVE: { label: "Activo", color: "warning" },
  PAID: { label: "Pagado", color: "success" },
  DEFAULTED: { label: "En mora", color: "danger" },
  CANCELLED: { label: "Cancelado", color: "default" },
};

function LoanDetailInner() {
  const search = useSearchParams();
  const idParam = search?.get("id");
  const { user, loading: authLoading } = useAuth();
  const isAdmin = useMemo(() => isAdminUser(user), [user]);
  const { toast } = useToast();

  const [loan, setLoan] = useState<LoanRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [submittingPay, setSubmittingPay] = useState(false);
  const [submittingExpense, setSubmittingExpense] = useState(false);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const [repairingUsageId, setRepairingUsageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [payingInstallment, setPayingInstallment] = useState<LoanInstallmentRecord | null>(null);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const loadLoan = useCallback(async () => {
    if (!idParam) {
      setError("Falta el identificador del préstamo.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // GET /loans/:id → { loan: LoanRecord }. Normalizamos para unificar.
      const raw = await apiFetch<unknown>(`/loans/${encodeURIComponent(idParam)}`, {
        method: "GET",
        fallbackError: "No se pudo cargar el préstamo",
      });
      const normalized = normalizeLoanDetailResponse(raw);
      if (!normalized) {
        setError("Respuesta inesperada del servidor.");
        setLoan(null);
      } else {
        setLoan(normalized);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        const code = err.data?.error?.code || err.data?.code;
        if (code === "LOAN_NOT_FOUND" || err.status === 404) {
          setError("El préstamo no existe o fue eliminado.");
          setLoan(null);
        } else {
          setError(err.message);
        }
      } else {
        setError(err instanceof Error ? err.message : "Error al cargar el préstamo");
      }
    } finally {
      setLoading(false);
    }
  }, [idParam]);


  const handleRepairOrphanedPayment = useCallback(async (usageId: number | string) => {
    if (!isAdmin || !loan?.id || !usageId) return;
    const key = String(usageId);
    setRepairingUsageId(key);
    try {
      const response = await apiFetch<{ result?: { restoredAmount?: number; releasedPrincipal?: number } }>(
        `/loans/${encodeURIComponent(String(loan.id))}/expenses/${encodeURIComponent(key)}/reverse-orphan`,
        { method: "POST", fallbackError: "No se pudo reparar el pago eliminado" },
      );
      const amount = Number(response?.result?.restoredAmount ?? 0);
      toast({
        variant: "success",
        title: "PAGO ELIMINADO REPARADO",
        description: `${formatLoanMoney(amount)} volvieron a Cuentas por pagar y al disponible del préstamo.`,
      });
      await loadLoan();
      broadcastRevalidate("EXPENSE_UPDATE");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "No se modificó nada.";
      toast({ variant: "destructive", title: "NO SE PUDO REPARAR", description: message });
    } finally {
      setRepairingUsageId(null);
    }
  }, [isAdmin, loan?.id, loadLoan, toast]);

  useEffect(() => {
    void loadLoan();
    const cleanup = setupSyncListener((event) => {
      if (event === "EXPENSE_UPDATE" || event === "DASHBOARD_UPDATE") {
        void loadLoan();
      }
    });
    return cleanup;
  }, [loadLoan]);

  const outstanding = useMemo(() => (loan ? liveLoanOutstanding(loan) : 0), [loan]);
  const paid = useMemo(() => (loan ? totalPaidOfLoan(loan) : 0), [loan]);
  const available = useMemo(() => (loan ? liveLoanAvailable(loan) : 0), [loan]);
  const progress = useMemo(() => (loan ? loanProgress(loan) : 0), [loan]);
  const status = STATUS_CHIP[String(loan?.status || "ACTIVE").toUpperCase()] ?? STATUS_CHIP.ACTIVE;
  const principalUsed = useMemo(() => {
    if (!loan) return 0;
    const principal = Number(loan.principalAmount || 0);
    return Math.max(0, principal - available);
  }, [loan, available]);
  // Snapshot vs cronograma: queda calculado aquí para que la UI muestre el
  // delta sin ocultar discrepancias. Si no hay dato oficial, el banner se
  // oculta sin ruido.
  const bankDelta = useMemo(() => nextInstallmentDelta(loan), [loan]);

  const handlePayInstallment = useCallback(
    async (paymentData: {
      cash: number;
      nequi: number;
      daviplata: number;
      fondo: number;
      coins: number;
      paymentSourceString: string;
      taxAmount: number;
    }) => {
      if (!loan?.id || !payingInstallment) return;
      const amount =
        paymentData.cash + paymentData.nequi + paymentData.daviplata + paymentData.fondo + paymentData.coins;
      if (amount <= 0) {
        toast({ variant: "destructive", title: "Monto inválido", description: "Ingresa al menos un valor en algún canal." });
        return;
      }
      // Contrato actual: el pago cubre el saldo PENDIENTE COMPLETO de la
      // cuota. Si el usuario digita menos, el backend lo rechazará con
      // LOAN_INVALID_INPUT; si digita más, también. Dejamos que el backend
      // sea autoritativo porque es quien verifica contra el saldo real.
      setSubmittingPay(true);
      try {
        await apiFetch(
          `/loans/${encodeURIComponent(String(loan.id))}/installments/${payingInstallment.number}/pay`,
          {
            method: "POST",
            body: JSON.stringify({
              amount,
              cashAmount: paymentData.cash,
              nequiAmount: paymentData.nequi,
              daviplataAmount: paymentData.daviplata,
              fondoAmount: paymentData.fondo,
              coinsAmount: paymentData.coins,
              taxAmount: paymentData.taxAmount,
              paymentSource: paymentData.paymentSourceString,
            }),
            fallbackError: "No se pudo registrar el pago",
          },
        );
        toast({
          variant: "success",
          title: "CUOTA PAGADA",
          description: `Cuota ${payingInstallment.number} abonada por ${formatLoanMoney(amount)}.`,
        });
        setPayingInstallment(null);
        broadcastRevalidate("EXPENSE_UPDATE");
        void loadLoan();
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          const code = err.data?.error?.code || err.data?.code;
          if (code === "LOAN_INSTALLMENT_ALREADY_PAID") {
            toast({
              variant: "destructive",
              title: "Ya pagada",
              description: "Esta cuota ya fue pagada completamente.",
            });
            void loadLoan();
            return;
          }
          if (code === "LOAN_INSTALLMENT_NOT_FOUND") {
            toast({
              variant: "destructive",
              title: "Cuota no encontrada",
              description: "La cuota no existe en el préstamo. Recargando...",
            });
            void loadLoan();
            return;
          }
          if (code === "LOAN_INVALID_INPUT") {
            toast({
              variant: "destructive",
              title: "Pago inválido",
              description: err.message,
            });
            return;
          }
        }
        const msg = err instanceof Error ? err.message : "Error al pagar la cuota";
        toast({ variant: "destructive", title: "ERROR", description: msg });
      } finally {
        setSubmittingPay(false);
      }
    },
    [loadLoan, loan, payingInstallment, toast],
  );

  const handleRegisterExpense = useCallback(
    async (payload: Record<string, unknown>) => {
      if (!loan?.id) return;
      setSubmittingExpense(true);
      try {
        await apiFetch(`/loans/${encodeURIComponent(String(loan.id))}/expenses`, {
          method: "POST",
          body: JSON.stringify(payload),
          fallbackError: "No se pudo registrar el uso",
        });
        toast({
          variant: "success",
          title: "USO REGISTRADO",
          description: `Se asoció al préstamo ${formatLoanMoney(Number(payload.amountUsed || 0))}.`,
        });
        setExpenseOpen(false);
        broadcastRevalidate("EXPENSE_UPDATE");
        void loadLoan();
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          const code = err.data?.error?.code || err.data?.code;
          if (code === "LOAN_PRINCIPAL_EXCEEDED") {
            toast({
              variant: "destructive",
              title: "Excede el principal",
              description: "La suma de usos ya alcanzó el capital del préstamo.",
            });
            return;
          }
          if (code === "LOAN_INVALID_INPUT") {
            toast({
              variant: "destructive",
              title: "Datos inválidos",
              description: err.message,
            });
            return;
          }
        }
        const msg = err instanceof Error ? err.message : "Error al registrar el uso";
        toast({ variant: "destructive", title: "ERROR", description: msg });
      } finally {
        setSubmittingExpense(false);
      }
    },
    [loadLoan, loan, toast],
  );

  /**
   * Guarda cambios del préstamo. El modal entrega un payload PLANO con los
   * nuevos valores (metadata + campos financieros + `recalculate` flag).
   * Aquí lo envolvemos en `{ metadata, schedule }` para `PUT /loans/:id`
   * siguiendo el diseño de la migración 023.
   *
   * El backend es la fuente autoritativa de validación — el frontend sólo
   * mapea los códigos canónicos a toasts legibles.
   */
  const handleEditLoan = useCallback(
    async (payload: Record<string, unknown>) => {
      if (!loan?.id) return;
      const recalculate = Boolean(payload.recalculate);
      const metadata = {
        lenderName: payload.lenderName,
        lenderDni: payload.lenderDni,
        creditNumber: payload.creditNumber,
        loanType: payload.loanType,
        holderName: payload.holderName,
        holderDni: payload.holderDni,
        currency: payload.currency,
        rateType: payload.rateType,
        autoDebit: payload.autoDebit,
        startDate: payload.startDate,
        maturityDate: payload.maturityDate,
        disbursementChannel: payload.disbursementChannel,
        note: payload.note,
        lateAnnualEffectiveRatePct: payload.lateAnnualEffectiveRatePct,
        netDisbursementAmount: payload.netDisbursementAmount,
        fgaTotalAmount: payload.fgaTotalAmount,
        fgaIvaAmount: payload.fgaIvaAmount,
        fgaGmfAmount: payload.fgaGmfAmount,
        bankBalanceAmount: payload.bankBalanceAmount,
        bankBalanceAsOf: payload.bankBalanceAsOf,
        bankPaidAmount: payload.bankPaidAmount,
        officialNextInstallmentAmount: payload.officialNextInstallmentAmount,
        officialNextInstallmentDate: payload.officialNextInstallmentDate,
      };
      const schedule = {
        recalculate,
        principalAmount: payload.principalAmount,
        termCount: payload.termCount,
        paymentFrequency: payload.paymentFrequency,
        interestMode: payload.interestMode,
        interestRatePct: payload.interestRatePct,
        annualEffectiveRatePct: payload.annualEffectiveRatePct,
        firstPaymentDate: payload.firstPaymentDate,
        monthlyInsurance: payload.monthlyInsurance,
        fgaTotal: payload.fgaTotal,
      };
      setSubmittingEdit(true);
      try {
        const raw = await apiFetch<unknown>(
          `/loans/${encodeURIComponent(String(loan.id))}`,
          {
            method: "PUT",
            body: JSON.stringify({ metadata, schedule }),
            fallbackError: "No se pudo guardar el préstamo",
          },
        );
        const updated = normalizeLoanDetailResponse(raw);
        toast({
          variant: "success",
          title: "PRÉSTAMO ACTUALIZADO",
          description: recalculate
            ? "Se guardaron los datos y se recalculó el cronograma."
            : "Se guardaron los datos del préstamo.",
        });
        setEditOpen(false);
        if (updated) setLoan(updated);
        broadcastRevalidate("EXPENSE_UPDATE");
        void loadLoan();
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          const code = err.data?.error?.code || err.data?.code;
          if (code === "LOAN_HAS_PAID_INSTALLMENTS") {
            toast({
              variant: "destructive",
              title: "No se puede recalcular",
              description:
                "Hay cuotas pagadas: el cronograma está anclado contablemente. Desactiva 'Recalcular cuotas' para guardar sólo la metadata.",
            });
            throw err;
          }
          if (code === "LOAN_PRINCIPAL_BELOW_USAGE") {
            toast({
              variant: "destructive",
              title: "Capital nuevo insuficiente",
              description:
                "El principal propuesto es menor que el uso activo del préstamo. Primero revierte usos huérfanos o sube el principal.",
            });
            throw err;
          }
          if (code === "LOAN_INVALID_SCHEDULE") {
            toast({
              variant: "destructive",
              title: "Cronograma inválido",
              description: "Revisa principal, tasa y número de cuotas.",
            });
            throw err;
          }
          if (code === "LOAN_INVALID_INPUT") {
            toast({
              variant: "destructive",
              title: "Datos inválidos",
              description: err.message,
            });
            throw err;
          }
          if (code === "LOAN_NOT_FOUND" || err.status === 404) {
            toast({
              variant: "destructive",
              title: "No existe",
              description: "El préstamo fue eliminado por otro usuario.",
            });
            throw err;
          }
        }
        const msg = err instanceof Error ? err.message : "Error al editar el préstamo";
        toast({ variant: "destructive", title: "ERROR", description: msg });
        throw err;
      } finally {
        setSubmittingEdit(false);
      }
    },
    [loadLoan, loan, toast],
  );

  if (authLoading || loading) {
    return (
      <div className="flex-1 h-full w-full flex items-center justify-center">
        <Spinner color="warning" size="lg" />
      </div>
    );
  }

  if (error || !loan) {
    return (
      <div className="flex-1 h-full w-full flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3 max-w-md text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border-2 border-dashed border-rose-500/40 text-rose-500">
            <AlertTriangle size={28} />
          </div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-900 dark:text-zinc-50">
            {error || "Préstamo no encontrado"}
          </h2>
          <Button
            as={Link}
            href="/loans"
            variant="flat"
            color="warning"
            startContent={<ArrowLeft size={14} />}
            className="font-semibold uppercase"
          >
            Volver a préstamos
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full w-full max-w-[1600px] mx-auto overflow-hidden bg-transparent text-zinc-900 dark:text-zinc-50">
      {/* HEADER */}
      <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50">
        <header className="flex flex-wrap items-center justify-between gap-3 px-1">
          <div className="flex items-center gap-3">
            <Button
              as={Link}
              href="/loans"
              isIconOnly
              variant="light"
              aria-label="Volver a préstamos"
              className="h-10 w-10 rounded-2xl"
            >
              <ArrowLeft size={18} />
            </Button>
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-amber-500/30">
              <HandCoins size={20} />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <h1 className="text-[13px] font-medium uppercase tracking-tighter leading-none">
                  Préstamo con <span className="text-amber-500">{loan.lenderName || "Sin acreedor"}</span>
                </h1>
                <Chip
                  size="sm"
                  color={status.color}
                  variant="flat"
                  classNames={{ base: "h-5 text-[9px] font-bold uppercase tracking-widest" }}
                >
                  {status.label}
                </Chip>
              </div>
              <p className="text-[8px] font-medium text-gray-400 dark:text-zinc-600 uppercase tracking-[0.4em] mt-1">
                Cronograma · {loan.termCount || 0} cuotas · {translateFrequency(loan.paymentFrequency)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <Button
                size="sm"
                variant="flat"
                color="warning"
                onPress={() => setEditOpen(true)}
                startContent={<Pencil size={14} />}
                aria-label="Editar préstamo"
                className="h-10 rounded-2xl font-bold uppercase tracking-widest text-[10px]"
              >
                <span className="hidden sm:inline">Editar</span>
                <span className="sm:hidden">Editar</span>
              </Button>
            )}
            <Button
              isIconOnly
              size="sm"
              onPress={loadLoan}
              isLoading={loading}
              aria-label="Recargar"
              title="Recargar"
              className="h-10 w-10 card-base border-none dark:bg-[#18181b]/80 text-amber-500 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-gray-200 dark:border-white/5 active:scale-95"
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            </Button>
          </div>
        </header>

        {/* TARJETAS */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 px-1">
          <HeadStat label="Principal" value={formatLoanMoney(loan.principalAmount)} icon={Wallet} color="sky" />
          <HeadStat label="Pagado" value={formatLoanMoney(paid)} icon={CheckCircle2} color="emerald" progress={progress} />
          <HeadStat label="Saldo" value={formatLoanMoney(outstanding)} icon={TrendingDown} color="rose" />
          <HeadStat label="Disponible del principal" value={formatLoanMoney(available)} icon={CalendarClock} color="amber" />
        </div>

        {/* BANNER BANCO OFICIAL vs CRONOGRAMA ESTIMADO
            Sólo visible cuando el usuario cargó el snapshot del banco. Expone
            la cuota autoritativa del extracto + delta vs la próxima cuota
            del cronograma estimado. El POS nunca modifica tasa/cuotas para
            ocultar la discrepancia. */}
        {bankDelta?.hasOfficial && (
          <BankOfficialBanner
            delta={bankDelta}
            bankBalanceAmount={Number(loan.bankBalanceAmount ?? 0) || null}
            bankBalanceAsOf={loan.bankBalanceAsOf ?? null}
            internalOutstanding={outstanding}
          />
        )}
      </div>

      {/* CUERPO */}
      <div className="flex flex-col flex-1 min-h-0 lg:grid lg:grid-cols-3 gap-3 px-2 py-3 overflow-y-auto custom-scrollbar">
        {/* AMORTIZACIÓN */}
        <section
          className="lg:col-span-2 flex flex-col gap-2 rounded-2xl border border-gray-200 bg-white dark:border-white/10 dark:bg-[#18181b]/60 p-3"
          aria-labelledby="loan-amortization-title"
        >
          <header className="flex items-center justify-between gap-2 px-1">
            <h2
              id="loan-amortization-title"
              className="text-sm font-bold uppercase tracking-widest text-zinc-900 dark:text-zinc-50"
            >
              Amortización
            </h2>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
              {loan.installments?.length ?? 0} cuotas · pago por saldo completo
            </span>
          </header>
          <ScrollShadow className="flex flex-col gap-1.5">
            {(loan.installments ?? []).length === 0 ? (
              <div className="flex items-center gap-2 rounded-2xl border border-dashed border-gray-200 dark:border-white/10 p-3 text-[11px] font-medium text-gray-500 dark:text-zinc-400">
                <Clock size={14} /> Sin cuotas registradas.
              </div>
            ) : (
              (loan.installments ?? []).map((it) => (
                <InstallmentRow
                  key={`${loan.id}-${it.number}`}
                  installment={it}
                  canPay={isAdmin && loan.status !== "CANCELLED"}
                  onPay={() => setPayingInstallment(it)}
                />
              ))
            )}
          </ScrollShadow>
        </section>

        {/* TRACKER DE USO DEL PRINCIPAL */}
        <section
          className="flex flex-col gap-2 rounded-2xl border border-gray-200 bg-white dark:border-white/10 dark:bg-[#18181b]/60 p-3"
          aria-labelledby="loan-expenses-title"
        >
          <header className="flex items-center justify-between gap-2 px-1">
            <h2
              id="loan-expenses-title"
              className="text-sm font-bold uppercase tracking-widest text-zinc-900 dark:text-zinc-50"
            >
              Uso del principal
            </h2>
            {isAdmin && (
              <Button
                size="sm"
                color="warning"
                variant="flat"
                startContent={<PlusCircle size={14} />}
                onPress={() => setExpenseOpen(true)}
                isDisabled={available <= 0}
                className="font-bold uppercase text-[10px] tracking-widest"
                aria-label="Registrar uso del principal"
              >
                Registrar
              </Button>
            )}
          </header>

          {/* Nota aclaratoria: tracker ≠ gasto contable */}
          <div
            role="note"
            className="flex items-start gap-2 rounded-xl border border-sky-500/30 bg-sky-500/5 p-2.5 text-[10px] leading-tight text-sky-700 dark:text-sky-300"
          >
            <Info size={14} className="shrink-0 mt-0.5" aria-hidden />
            <p>
              Este tracker <strong>no</strong> crea un gasto contable en /egresos.
              Es una bitácora de en qué se gastó el dinero recibido del préstamo
              (control del dueño). El pago de cada cuota sí registra un egreso
              formal con el canal real (Efectivo / Nequi / Daviplata...).
            </p>
          </div>

          <div className="rounded-xl bg-gray-50 dark:bg-[#121214] p-3 border border-gray-200 dark:border-white/10">
            <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
              <span>Disponible</span>
              <span className="text-lg font-bold tracking-tight text-amber-500 tabular-nums">
                {formatLoanMoney(available)}
              </span>
            </div>
            <Progress
              size="sm"
              aria-label="Capital usado"
              value={
                loan.principalAmount
                  ? Math.round((principalUsed / Number(loan.principalAmount)) * 100)
                  : 0
              }
              classNames={{
                indicator: "bg-amber-500",
                track: "bg-gray-100 dark:bg-zinc-800",
              }}
            />
            <p className="mt-1 text-[9px] uppercase tracking-widest text-gray-400 dark:text-zinc-500">
              {formatLoanMoney(principalUsed)} usados / {formatLoanMoney(loan.principalAmount)}
            </p>
          </div>

          <ScrollShadow className="flex flex-col gap-1.5">
            {(loan.expenses ?? []).length === 0 ? (
              <div className="flex items-center gap-2 rounded-2xl border border-dashed border-gray-200 dark:border-white/10 p-3 text-[11px] font-medium text-gray-500 dark:text-zinc-400">
                <Receipt size={14} /> No se ha registrado uso del principal.
              </div>
            ) : (
              (loan.expenses ?? []).map((exp) => (
                <div
                  key={String(exp.id)}
                  className="flex items-center justify-between gap-2 rounded-xl border border-gray-200 bg-white p-2.5 dark:border-white/10 dark:bg-[#18181b]"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Receipt size={14} className="text-amber-500 shrink-0" />
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-bold uppercase tracking-tight">
                        {exp.purpose || "Uso de principal"}
                      </p>
                      <p className="text-[9px] uppercase tracking-widest text-gray-500 dark:text-zinc-500">
                        {exp.createdAt ? new Date(exp.createdAt).toLocaleDateString("es-CO") : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[12px] font-bold tabular-nums text-rose-500">
                      -{formatLoanMoney(Number(exp.amountUsed ?? exp.amount_used ?? 0))}
                    </span>
                    {isAdmin && exp.orphanedPayment && exp.id != null && (
                      <Button
                        size="sm"
                        color="warning"
                        variant="flat"
                        startContent={<RotateCcw size={13} />}
                        isLoading={repairingUsageId === String(exp.id)}
                        isDisabled={repairingUsageId != null}
                        onPress={() => void handleRepairOrphanedPayment(exp.id!)}
                        className="h-8 rounded-xl text-[9px] font-bold uppercase tracking-wider"
                      >
                        Reparar pago eliminado
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </ScrollShadow>
        </section>
      </div>

      {/* MODALES */}
      {isAdmin && payingInstallment && (
        <ExpensePaymentModal
          isOpen={!!payingInstallment}
          onOpenChange={(open) => {
            if (!open && !submittingPay) setPayingInstallment(null);
          }}
          title={`Pagar cuota ${payingInstallment.number}`}
          totalToPay={Math.max(
            0,
            Number(payingInstallment.totalDue ?? 0) - Number(payingInstallment.paidAmount ?? 0),
          )}
          onPay={handlePayInstallment}
        />
      )}

      {isAdmin && (
        <LoanExpenseModal
          isOpen={expenseOpen}
          onOpenChange={(open) => {
            if (submittingExpense && !open) return; // bloquea cerrar durante submit
            setExpenseOpen(open);
          }}
          available={available}
          onSubmit={handleRegisterExpense}
        />
      )}

      {isAdmin && (
        <LoanFormModal
          isOpen={editOpen}
          onOpenChange={(open) => {
            if (submittingEdit && !open) return;
            setEditOpen(open);
          }}
          mode="edit"
          loan={loan}
          onSubmit={handleEditLoan}
        />
      )}
    </div>
  );
}

function translateFrequency(freq: string | null | undefined): string {
  const code = String(freq || "").trim().toUpperCase();
  if (code === "WEEKLY") return "Semanal";
  if (code === "BIWEEKLY") return "Quincenal";
  if (code === "MONTHLY") return "Mensual";
  return "—";
}

interface HeadStatProps {
  label: string;
  value: string;
  icon: React.ElementType;
  color: "amber" | "emerald" | "rose" | "sky";
  progress?: number;
}

interface BankOfficialBannerProps {
  delta: NonNullable<ReturnType<typeof nextInstallmentDelta>>;
  bankBalanceAmount: number | null;
  bankBalanceAsOf: string | null;
  internalOutstanding: number;
}

function formatDeltaAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return `${sign}${formatLoanMoney(Math.abs(value))}`;
}

function formatBankAsOf(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("es-CO", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Banner "Banco oficial vs Cronograma estimado" — regla permanente del POS:
 * las discrepancias NUNCA se ocultan. Se muestra la cuota autoritativa del
 * banco al lado de la próxima cuota del cronograma estimado y el delta
 * absoluto en pesos y días; el POS no re-calcula tasa ni saldo contable
 * para "cuadrar" el valor.
 */
function BankOfficialBanner({
  delta,
  bankBalanceAmount,
  bankBalanceAsOf,
  internalOutstanding,
}: BankOfficialBannerProps) {
  const amountDelta = delta.amountDelta;
  const dateDelta = delta.dateDelta;
  const amountToneClass =
    amountDelta === null
      ? "text-gray-500 dark:text-zinc-400"
      : amountDelta > 0
      ? "text-rose-500"
      : amountDelta < 0
      ? "text-emerald-500"
      : "text-emerald-500";
  const balanceDelta =
    bankBalanceAmount !== null ? Math.round((bankBalanceAmount - internalOutstanding) * 100) / 100 : null;
  return (
    <section
      aria-label="Comparación entre el banco oficial y el cronograma estimado"
      className="px-1"
    >
      <div className="rounded-2xl border border-sky-500/30 bg-sky-500/5 p-3 flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-sky-500/10 text-sky-500 shrink-0">
            <Landmark size={16} />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-widest text-sky-700 dark:text-sky-300">
              Banco oficial vs Cronograma estimado
            </p>
            <p className="text-[10px] font-medium leading-tight text-gray-500 dark:text-zinc-400">
              Datos autoritativos del extracto; el POS nunca ajusta tasa o saldo contable para cuadrar el delta.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <div className="rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-[#18181b] p-2.5 flex flex-col gap-1">
            <span className="text-[9px] font-bold uppercase tracking-widest text-sky-600 dark:text-sky-400">
              Banco oficial · próxima cuota
            </span>
            <span className="text-base font-bold tabular-nums text-zinc-900 dark:text-zinc-50">
              {delta.officialAmount !== null ? formatLoanMoney(delta.officialAmount) : "—"}
            </span>
            <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
              {delta.officialDate ?? "Sin fecha"}
            </span>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-[#18181b] p-2.5 flex flex-col gap-1">
            <span className="text-[9px] font-bold uppercase tracking-widest text-amber-600 dark:text-amber-400">
              Cronograma estimado · próxima cuota
            </span>
            <span className="text-base font-bold tabular-nums text-zinc-900 dark:text-zinc-50">
              {delta.estimatedAmount !== null ? formatLoanMoney(delta.estimatedAmount) : "—"}
            </span>
            <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
              {delta.estimatedDate ?? "Sin cuota pendiente"}
            </span>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-[#18181b] p-2.5 flex flex-col gap-1">
            <span className="text-[9px] font-bold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
              Delta cuota
            </span>
            <span className={`text-base font-bold tabular-nums ${amountToneClass}`}>
              {formatDeltaAmount(amountDelta)}
            </span>
            <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
              {dateDelta === null
                ? "Sin fechas comparables"
                : dateDelta === 0
                ? "Mismo día"
                : dateDelta > 0
                ? `+${dateDelta} día${dateDelta === 1 ? "" : "s"} (banco)`
                : `${dateDelta} día${dateDelta === -1 ? "" : "s"} (banco)`}
            </span>
          </div>
        </div>

        {bankBalanceAmount !== null && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div className="rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-[#18181b] p-2.5 flex flex-col gap-1">
              <span className="text-[9px] font-bold uppercase tracking-widest text-sky-600 dark:text-sky-400">
                Saldo bancario
              </span>
              <span className="text-base font-bold tabular-nums text-zinc-900 dark:text-zinc-50">
                {formatLoanMoney(bankBalanceAmount)}
              </span>
              <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
                Consultado · {formatBankAsOf(bankBalanceAsOf)}
              </span>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-[#18181b] p-2.5 flex flex-col gap-1">
              <span className="text-[9px] font-bold uppercase tracking-widest text-rose-600 dark:text-rose-400">
                Saldo contable del POS
              </span>
              <span className="text-base font-bold tabular-nums text-zinc-900 dark:text-zinc-50">
                {formatLoanMoney(internalOutstanding)}
              </span>
              <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
                Reconstruido desde cuotas
              </span>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-[#18181b] p-2.5 flex flex-col gap-1">
              <span className="text-[9px] font-bold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
                Delta saldo
              </span>
              <span
                className={`text-base font-bold tabular-nums ${
                  balanceDelta === null
                    ? "text-gray-500 dark:text-zinc-400"
                    : balanceDelta > 0
                    ? "text-rose-500"
                    : balanceDelta < 0
                    ? "text-emerald-500"
                    : "text-emerald-500"
                }`}
              >
                {formatDeltaAmount(balanceDelta)}
              </span>
              <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
                Banco − POS (sin conciliar)
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function HeadStat({ label, value, icon: Icon, color, progress }: HeadStatProps) {
  const colorMap = {
    amber: { ring: "border-amber-500/20", icon: "text-amber-500", bg: "bg-amber-500/10" },
    emerald: { ring: "border-emerald-500/20", icon: "text-emerald-500", bg: "bg-emerald-500/10" },
    rose: { ring: "border-rose-500/20", icon: "text-rose-500", bg: "bg-rose-500/10" },
    sky: { ring: "border-sky-500/20", icon: "text-sky-500", bg: "bg-sky-500/10" },
  }[color];
  return (
    <div
      className={`flex flex-col gap-2 rounded-2xl border ${colorMap.ring} bg-white dark:bg-[#18181b]/60 p-3 shadow-[0_8px_30px_rgb(0,0,0,0.06)]`}
      role="group"
      aria-label={label}
    >
      <div className="flex items-start justify-between gap-2">
        <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${colorMap.bg} ${colorMap.icon}`}>
          <Icon size={16} />
        </div>
        <div className="text-right">
          <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
            {label}
          </p>
          <p className="text-lg font-bold leading-none tracking-tight tabular-nums text-zinc-900 dark:text-zinc-50">
            {value}
          </p>
        </div>
      </div>
      {typeof progress === "number" && (
        <Progress
          size="sm"
          value={Math.round(progress * 100)}
          aria-label={`${label} progreso`}
          classNames={{ indicator: colorMap.bg.replace("/10", ""), track: "bg-gray-100 dark:bg-zinc-800" }}
        />
      )}
    </div>
  );
}

interface InstallmentRowProps {
  installment: LoanInstallmentRecord;
  canPay: boolean;
  onPay: () => void;
}

function InstallmentRow({ installment, canPay, onPay }: InstallmentRowProps) {
  const cls = classifyInstallment(installment);
  const totalDue = Number(installment.totalDue ?? 0);
  const paidAmount = Number(installment.paidAmount ?? 0);
  const remaining = Math.max(0, totalDue - paidAmount);
  const prog = installmentProgress(installment);
  const insuranceDue = Number(installment.insuranceDue ?? 0);
  const fgaDue = Number(installment.fgaDue ?? 0);
  const hasExtras = insuranceDue > 0 || fgaDue > 0;

  const toneClass =
    cls === "paid"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : cls === "overdue"
      ? "border-rose-500/40 bg-rose-500/5"
      : cls === "partial"
      ? "border-amber-500/40 bg-amber-500/5"
      : "border-gray-200 dark:border-white/10";

  const statusLabel =
    cls === "paid" ? "Pagada" : cls === "overdue" ? "Vencida" : cls === "partial" ? "Parcial" : "Pendiente";
  const statusColor: "success" | "danger" | "warning" | "default" =
    cls === "paid" ? "success" : cls === "overdue" ? "danger" : cls === "partial" ? "warning" : "default";

  return (
    <div className={`flex items-center gap-3 rounded-xl border ${toneClass} p-2.5`}>
      <div className="h-8 w-8 shrink-0 rounded-xl bg-amber-500/10 text-amber-500 flex items-center justify-center font-bold">
        {installment.number}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-[12px] font-bold uppercase tracking-wide text-zinc-900 dark:text-zinc-50">
            {installment.dueDate ?? "—"}
          </p>
          <Chip
            size="sm"
            color={statusColor}
            variant="flat"
            classNames={{ base: "h-5 text-[9px] font-bold uppercase tracking-widest" }}
          >
            {statusLabel}
          </Chip>
        </div>
        <p className="mt-0.5 text-[10px] font-medium text-gray-500 dark:text-zinc-500">
          Capital {formatLoanMoney(installment.principalDue)} · Interés {formatLoanMoney(installment.interestDue)}
          {hasExtras && (
            <>
              {" · "}
              <span className="text-sky-600 dark:text-sky-400">
                Seguro {formatLoanMoney(insuranceDue)} · FGA {formatLoanMoney(fgaDue)}
              </span>
            </>
          )}
        </p>
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-zinc-800">
          <div
            className={`h-full rounded-full transition-all ${
              cls === "paid" ? "bg-emerald-500" : cls === "overdue" ? "bg-rose-500" : "bg-amber-500"
            }`}
            style={{ width: `${Math.round(prog * 100)}%` }}
            aria-hidden
          />
        </div>
      </div>
      <div className="hidden sm:flex flex-col items-end">
        <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
          {cls === "paid" ? "Pagado" : "Debe"}
        </p>
        <p className="text-sm font-bold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">
          {formatLoanMoney(cls === "paid" ? totalDue : remaining)}
        </p>
      </div>
      {canPay && cls !== "paid" && (
        <Button
          size="sm"
          color="warning"
          variant="flat"
          onPress={onPay}
          className="font-bold uppercase text-[10px] tracking-widest"
          aria-label={`Pagar cuota ${installment.number}`}
        >
          Pagar
        </Button>
      )}
    </div>
  );
}

export default function LoanDetailPage() {
  // useSearchParams exige Suspense en static export, aun si el padre no la pide.
  return (
    <Suspense
      fallback={
        <div className="flex-1 h-full w-full flex items-center justify-center">
          <Spinner color="warning" size="lg" />
        </div>
      }
    >
      <LoanDetailInner />
    </Suspense>
  );
}
