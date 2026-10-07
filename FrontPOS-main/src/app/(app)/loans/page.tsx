"use client";

/**
 * /loans — Centro unificado de deuda del negocio.
 *
 * Esta pantalla cubre DOS flujos financieros hermanos bajo un mismo techo:
 *
 *   1. **Préstamos formales** (`GET /loans`): préstamos con cronograma,
 *      interés y amortización. Fuente única `@/lib/loans.mjs`.
 *   2. **Cuentas por pagar legacy** (`GET /expenses/list` + `selectLiveDebts`):
 *      lo que llamábamos "Centro de Pagos" y vivía dentro de /expenses.
 *      Fuente única `@/lib/payables.mjs`.
 *
 * La navegación entre ambos es por **pestañas** (HeroUI Tabs) — así el
 * usuario tiene UN SOLO lugar en el POS donde cerrar deudas, sin tener
 * que recordar que las cuentas por pagar estaban en Egresos y los
 * préstamos en Préstamos.
 *
 * Query param `?pagos=1` abre directamente la pestaña de cuentas por
 * pagar (deep link desde emails/accesos directos).
 *
 * Los préstamos nuevos NO escriben `paymentSource='PRESTAMO'` en expenses:
 * cada pago de cuota genera un `expense` individual con el canal real
 * (EFECTIVO/NEQUI/DAVIPLATA/FONDO). Las cuentas por pagar legacy sí viven
 * en expenses con `paymentSource='PRESTAMO'`; `payables.mjs` las captura
 * sin doble conteo con `loan_installments` (son conjuntos disjuntos).
 *
 * Contratos de backend intactos:
 *   GET  /loans                                 → { loans:[...] , total }
 *   POST /loans                                 → { loan: LoanRecord }
 *   GET  /expenses/list                         → Expense[]
 *   PATCH /expenses/settle/:id                  → saldar deuda (abono)
 *   PUT   /expenses/:id                         → condonar (admin)
 */

import { useEffect, useMemo, useState, useCallback, memo, Suspense } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Button,
  Input,
  Spinner,
  Chip,
  Progress,
  Tabs,
  Tab,
} from "@heroui/react";
import {
  HandCoins,
  PlusCircle,
  RefreshCw,
  Search,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  TrendingDown,
  Wallet,
  Users,
  ChevronRight,
} from "lucide-react";
import Cookies from "js-cookie";

import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/auth-helpers.mjs";
import { apiFetch, ApiError } from "@/lib/api-error";
import { useToast } from "@/hooks/use-toast";
import { broadcastRevalidate, setupSyncListener } from "@/lib/revalidate";
import {
  formatLoanMoney,
  liveLoanAvailable,
  liveLoanOutstanding,
  loanProgress,
  normalizeLoanDetailResponse,
  normalizeLoanListResponse,
  normalizeLoanPayExpenseResponse,
  summarizeLoans,
  type LoanRecord,
} from "@/lib/loans.mjs";
import { selectLiveDebts, sumPayables } from "@/lib/payables.mjs";
import { Expense } from "@/lib/definitions";

const LoanFormModal = dynamic(() => import("./components/LoanFormModal"), { ssr: false });
const PayablesCenter = dynamic(() => import("./components/PayablesCenter"), { ssr: false });

// ============================================================================
// Tarjeta analítica (patrón de ExpenseStats, sin recharts para quedar liviana)
// ============================================================================

interface StatCardProps {
  label: string;
  value: string;
  caption?: string;
  icon: React.ElementType;
  color: "amber" | "emerald" | "rose" | "sky";
  progress?: number;
}

const COLOR_MAP = {
  amber: { ring: "border-amber-500/20", icon: "text-amber-500", bg: "bg-amber-500/10" },
  emerald: { ring: "border-emerald-500/20", icon: "text-emerald-500", bg: "bg-emerald-500/10" },
  rose: { ring: "border-rose-500/20", icon: "text-rose-500", bg: "bg-rose-500/10" },
  sky: { ring: "border-sky-500/20", icon: "text-sky-500", bg: "bg-sky-500/10" },
};

const StatCard = memo(function StatCard({ label, value, caption, icon: Icon, color, progress }: StatCardProps) {
  const tone = COLOR_MAP[color];
  return (
    <div
      role="group"
      aria-label={label}
      className={`relative flex flex-col gap-2 rounded-2xl border ${tone.ring} bg-white/60 p-3.5 shadow-[0_8px_30px_rgb(0,0,0,0.06)] transition-all duration-300 dark:bg-[#18181b]/60`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${tone.bg} ${tone.icon}`}>
          <Icon size={16} />
        </div>
        <div className="text-right min-w-0">
          <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500 truncate">
            {label}
          </p>
          <p className="text-xl font-medium leading-none tracking-tight tabular-nums text-zinc-900 dark:text-zinc-50">
            {value}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
        <span className="truncate">{caption}</span>
      </div>
      {typeof progress === "number" && (
        <Progress
          size="sm"
          aria-label={`Progreso de ${label}`}
          value={Math.round(progress * 100)}
          classNames={{
            indicator: tone.bg.replace("/10", ""),
            track: "bg-gray-100 dark:bg-zinc-800",
          }}
        />
      )}
    </div>
  );
});

// ============================================================================
// Fila de préstamo — rediseñada: saldo visible en TODO breakpoint, chip
// debajo del nombre (no compite con truncate), chevron permanente, meta de
// próxima cuota cuando el backend la trae.
// ============================================================================

const STATUS_CHIP: Record<
  string,
  { label: string; color: "warning" | "success" | "danger" | "default" }
> = {
  ACTIVE: { label: "Activo", color: "warning" },
  PAID: { label: "Pagado", color: "success" },
  DEFAULTED: { label: "En mora", color: "danger" },
  CANCELLED: { label: "Cancelado", color: "default" },
};

interface LoanRowProps {
  loan: LoanRecord;
  onOpen: (id: number | string) => void;
}

const LoanRow = memo(function LoanRow({ loan, onOpen }: LoanRowProps) {
  const outstanding = liveLoanOutstanding(loan);
  const progress = loanProgress(loan);
  const status = STATUS_CHIP[String(loan.status || "ACTIVE").toUpperCase()] ?? STATUS_CHIP.ACTIVE;
  const nextDueDate = loan.nextDueDate ?? null;
  const nextDueAmount = Number(loan.nextDueAmount ?? 0);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Ver préstamo de ${loan.lenderName}`}
      onClick={() => loan.id != null && onOpen(loan.id)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && loan.id != null) {
          e.preventDefault();
          onOpen(loan.id);
        }
      }}
      className="group flex min-h-[44px] cursor-pointer flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-3 transition-colors hover:border-amber-500/30 hover:bg-amber-500/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/70 dark:border-white/10 dark:bg-[#18181b]/60 sm:flex-row sm:items-center sm:gap-3 sm:py-3"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500 self-start sm:self-center">
        <HandCoins size={18} />
      </div>

      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        {/* Primer renglón: nombre + saldo (saldo SIEMPRE visible). */}
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 flex-1 truncate text-sm font-bold uppercase tracking-tight text-zinc-900 dark:text-zinc-50">
            {loan.lenderName || "Sin acreedor"}
          </h3>
          <div className="shrink-0 text-right">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
              Saldo
            </p>
            <p className="text-base font-bold leading-none tracking-tight tabular-nums text-rose-500 sm:text-lg">
              {formatLoanMoney(outstanding)}
            </p>
          </div>
        </div>

        {/* Chip de estado debajo del nombre, no compite con truncate. */}
        <div className="flex flex-wrap items-center gap-2">
          <Chip
            size="sm"
            color={status.color}
            variant="flat"
            classNames={{ base: "h-5 text-[9px] font-bold uppercase tracking-widest" }}
          >
            {status.label}
          </Chip>
          <p className="text-[11px] font-medium text-gray-500 dark:text-zinc-400">
            Principal {formatLoanMoney(loan.principalAmount || 0)} · {loan.termCount || 0} cuotas
            {loan.paymentFrequency ? ` · ${translateFrequency(loan.paymentFrequency)}` : ""}
          </p>
        </div>

        {/* Barra de progreso + próxima cuota (dato de alto valor cuando existe). */}
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${Math.round(progress * 100)}%` }}
              aria-hidden
            />
          </div>
          <span className="text-[10px] font-bold tabular-nums text-gray-500 dark:text-zinc-500">
            {Math.round(progress * 100)}%
          </span>
        </div>

        {nextDueDate && nextDueAmount > 0 && (
          <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
            Próxima cuota · {nextDueDate} · {formatLoanMoney(nextDueAmount)}
          </p>
        )}
      </div>

      <ChevronRight
        size={18}
        className="hidden shrink-0 self-center text-gray-300 transition-transform group-hover:translate-x-0.5 group-hover:text-amber-500 dark:text-zinc-600 sm:block"
        aria-hidden
      />
    </div>
  );
});

function translateFrequency(freq: string | null | undefined): string {
  const code = String(freq || "").trim().toUpperCase();
  if (code === "WEEKLY") return "Semanal";
  if (code === "BIWEEKLY") return "Quincenal";
  if (code === "MONTHLY") return "Mensual";
  return "";
}

// ============================================================================
// Página principal
// ============================================================================

type LoansTab = "loans" | "payables";

function LoansPageInner() {
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();

  const isAdmin = useMemo(() => isAdminUser(user), [user]);

  // Estado de préstamos
  const [loading, setLoading] = useState(true);
  const [loans, setLoans] = useState<LoanRecord[]>([]);
  const [serverTotal, setServerTotal] = useState<number>(0);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "PAID" | "DEFAULTED" | "CANCELLED">("ACTIVE");
  const [formOpen, setFormOpen] = useState(false);

  // Estado de cuentas por pagar (expenses PENDING + préstamos legacy)
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expensesLoading, setExpensesLoading] = useState(true);

  // Pestaña activa — ?pagos=1 abre la pestaña de deudas por default.
  const initialTab: LoansTab = (searchParams?.get("pagos") ?? searchParams?.get("tab")) ? "payables" : "loans";
  const [activeTab, setActiveTab] = useState<LoansTab>(initialTab);

  // ---------------------------------------------------------------------------
  // Loaders
  // ---------------------------------------------------------------------------

  const loadLoans = useCallback(async () => {
    if (authLoading) return;
    setLoading(true);
    try {
      const raw = await apiFetch<unknown>("/loans", {
        method: "GET",
        fallbackError: "No se pudieron cargar los préstamos",
      });
      const { loans: normalized, total } = normalizeLoanListResponse(raw);
      setLoans(normalized);
      setServerTotal(total);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error al cargar préstamos";
      toast({ variant: "destructive", title: "Préstamos", description: msg });
      setLoans([]);
      setServerTotal(0);
    } finally {
      setLoading(false);
    }
  }, [authLoading, toast]);

  const loadExpenses = useCallback(async () => {
    if (authLoading) return;
    const token = Cookies.get("org-pos-token");
    if (!token) {
      setExpensesLoading(false);
      return;
    }
    setExpensesLoading(true);
    try {
      // Mismo endpoint que /expenses, sin filtros: traemos todo y filtramos
      // con `selectLiveDebts` para no duplicar peticiones ni fuentes.
      const data = await apiFetch<Expense[]>("/expenses/list", {
        method: "GET",
        fallbackError: "No se pudieron cargar las cuentas por pagar",
      }, token);
      setExpenses(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error al cargar cuentas por pagar";
      toast({ variant: "destructive", title: "Cuentas por pagar", description: msg });
      setExpenses([]);
    } finally {
      setExpensesLoading(false);
    }
  }, [authLoading, toast]);

  useEffect(() => {
    void loadLoans();
    void loadExpenses();
    const cleanup = setupSyncListener((event) => {
      if (event === "EXPENSE_UPDATE" || event === "DASHBOARD_UPDATE") {
        void loadLoans();
        void loadExpenses();
      }
    });
    return cleanup;
  }, [loadLoans, loadExpenses]);

  // ---------------------------------------------------------------------------
  // Memos derivados
  // ---------------------------------------------------------------------------

  const summary = useMemo(() => summarizeLoans(loans), [loans]);
  const liveDebts = useMemo(() => selectLiveDebts(expenses), [expenses]);
  const totalPayables = useMemo(() => sumPayables(expenses), [expenses]);

  // ---------------------------------------------------------------------------
  // Opción de pago con préstamo para el Centro de Pagos.
  //
  // Sólo admin, préstamos ACTIVE o DEFAULTED con disponible > 0. Si no hay
  // ninguno, pasamos `enabled: true` igual con `loans: []` para que el
  // modal muestre el mensaje "No hay préstamos activos..." (NO rompe).
  // Si `isAdmin` es false, no pasamos loanOption en absoluto para que la
  // pestaña ni aparezca.
  // ---------------------------------------------------------------------------
  const loanOptionForPayables = useMemo(() => {
    if (!isAdmin) return undefined;
    const activeLoans = loans
      .filter((l) => {
        const status = String(l?.status || "").toUpperCase();
        return status === "ACTIVE" || status === "DEFAULTED";
      })
      .map((l) => ({
        id: l.id!,
        lenderName: l.lenderName || "Sin acreedor",
        available: liveLoanAvailable(l),
      }))
      .filter((l) => l.available > 0);
    return { enabled: true as const, loans: activeLoans };
  }, [isAdmin, loans]);

  const filteredLoans = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return loans
      .filter((l) => {
        if (statusFilter !== "ALL") {
          const status = String(l.status || "ACTIVE").toUpperCase();
          if (statusFilter === "ACTIVE") {
            if (status !== "ACTIVE" && status !== "DEFAULTED") return false;
          } else if (status !== statusFilter) {
            return false;
          }
        }
        if (!query) return true;
        return (
          (l.lenderName || "").toLowerCase().includes(query) ||
          (l.note || "").toLowerCase().includes(query)
        );
      })
      .sort((a, b) => {
        const sa = (a.status || "").toUpperCase();
        const sb = (b.status || "").toUpperCase();
        const activeA = sa === "ACTIVE" || sa === "DEFAULTED" ? 0 : 1;
        const activeB = sb === "ACTIVE" || sb === "DEFAULTED" ? 0 : 1;
        if (activeA !== activeB) return activeA - activeB;
        return liveLoanOutstanding(b) - liveLoanOutstanding(a);
      });
  }, [loans, filter, statusFilter]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleOpenDetail = useCallback(
    (id: number | string) => {
      router.push(`/loans/detail?id=${encodeURIComponent(String(id))}`);
    },
    [router],
  );

  const handleCreateLoan = useCallback(
    async (payload: Record<string, unknown>) => {
      try {
        const raw = await apiFetch<unknown>("/loans", {
          method: "POST",
          body: JSON.stringify(payload),
          fallbackError: "No se pudo registrar el préstamo",
        });
        const created = normalizeLoanDetailResponse(raw);
        toast({
          variant: "success",
          title: "PRÉSTAMO CREADO",
          description: `Se registró el préstamo de ${created?.lenderName || payload.lenderName}.`,
        });
        setFormOpen(false);
        await loadLoans();
        broadcastRevalidate("EXPENSE_UPDATE");
        if (created?.id != null) handleOpenDetail(created.id);
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          const code = err.data?.error?.code || err.data?.code;
          if (code === "LOAN_INVALID_SCHEDULE") {
            toast({
              variant: "destructive",
              title: "Cronograma inválido",
              description: "Revisa monto, tasa y número de cuotas.",
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
        const msg = err instanceof Error ? err.message : "Error al crear préstamo";
        toast({ variant: "destructive", title: "ERROR", description: msg });
      }
    },
    [handleOpenDetail, loadLoans, toast],
  );

  /**
   * Saldar una deuda. ES EL MISMO handler que vivía en /expenses: mismo
   * endpoint `PATCH /expenses/settle/:id`, mismo desglose por canal. Lo
   * movimos aquí para que el Centro de Pagos quede completo en /loans.
   *
   * Si el modal entrega `loanId`, se enruta a
   * `POST /loans/:id/pay-expense` y el abono se cobra contra el principal
   * disponible — NO toca ninguna caja. El backend crea el egreso de abono
   * con `paymentSource='PRESTAMO'` dentro de la misma transacción; el
   * frontend NUNCA fabrica ese canal en el payload (lo valida el guardián
   * `tests/loans-ui-contract.test.mjs`).
   */
  const handleSettleDebt = useCallback(
    async (id: string, paymentData: unknown, amount: number) => {
      const token = Cookies.get("org-pos-token");
      if (!token) return;
      const data = paymentData as {
        paymentSourceString?: string;
        cash?: number;
        nequi?: number;
        daviplata?: number;
        fondo?: number;
        loanId?: number | string;
      };
      try {
        // --- Rama préstamo: abono contra el principal del préstamo ---
        if (data.loanId != null && data.loanId !== "") {
          const debt = expenses.find((e) => String(e.id) === id);
          const purpose = debt?.description ? String(debt.description) : undefined;
          const raw = await apiFetch<unknown>(
            `/loans/${encodeURIComponent(String(data.loanId))}/pay-expense`,
            {
              method: "POST",
              body: JSON.stringify({
                expenseId: Number(id),
                amount,
                ...(purpose ? { purpose } : {}),
              }),
              fallbackError: "FALLO AL PAGAR CON EL PRÉSTAMO",
            },
            token,
          );
          normalizeLoanPayExpenseResponse(raw); // valida shape, no requerimos los campos
          const chosenLoan = loans.find((l) => String(l.id) === String(data.loanId));
          const lenderName = chosenLoan?.lenderName || "préstamo";
          toast({
            variant: "success",
            title: "ABONO CON PRÉSTAMO",
            description: `Pagado con el préstamo de ${lenderName}; no afecta la caja.`,
          });
          void loadLoans();
          void loadExpenses();
          broadcastRevalidate("EXPENSE_UPDATE");
          return;
        }

        // --- Flujo normal: abono con canales reales de caja ---
        await apiFetch(`/expenses/settle/${id}`, {
          method: "PATCH",
          body: JSON.stringify({
            paymentSource: data.paymentSourceString,
            amount,
            cashAmount: data.cash || 0,
            nequiAmount: data.nequi || 0,
            daviplataAmount: data.daviplata || 0,
            fondoAmount: data.fondo || 0,
          }),
          fallbackError: "FALLO AL SALDAR DEUDA",
        }, token);
        toast({
          variant: "success",
          title: "DEUDA SALDADA",
          description: `El egreso se marcó como pagado con ${data.paymentSourceString || "canal"}.`,
        });
        void loadExpenses();
        broadcastRevalidate("EXPENSE_UPDATE");
      } catch (err: unknown) {
        // Mapeo de códigos específicos del endpoint de préstamo.
        if (err instanceof ApiError) {
          const code = err.data?.error?.code || err.data?.code;
          if (code === "LOAN_NOT_FOUND") {
            toast({ variant: "destructive", title: "PRÉSTAMO NO EXISTE", description: "Recarga la lista de préstamos." });
          } else if (code === "LOAN_NOT_ACTIVE") {
            toast({ variant: "destructive", title: "PRÉSTAMO INACTIVO", description: "Sólo puedes abonar con préstamos ACTIVOS o EN MORA." });
          } else if (code === "LOAN_PRINCIPAL_EXCEEDED") {
            toast({ variant: "destructive", title: "EXCEDE EL PRÉSTAMO", description: "El monto supera el disponible del préstamo." });
          } else {
            toast({ variant: "destructive", title: "FALLO AL SALDAR", description: err.message });
          }
        } else {
          const msg = err instanceof Error ? err.message : "FALLO AL SALDAR DEUDA";
          toast({ variant: "destructive", title: "FALLO AL SALDAR", description: msg });
        }
        // El modal sólo debe mostrar éxito cuando el backend confirmó.
        throw err;
      }
    },
    [expenses, loadExpenses, loadLoans, loans, toast],
  );

  /**
   * Condonar deuda — path irregular `PUT /expenses/:id` (NO
   * `/expenses/update/:id`) heredado del flujo original. Se conserva tal
   * cual: el backend acepta este endpoint específicamente para marcar como
   * PAID sin registrar egreso de caja. Es destructivo y sólo admin.
   */
  const handleForceCloseDebt = useCallback(
    async (id: string) => {
      const token = Cookies.get("org-pos-token");
      if (!token) return;
      try {
        const expenseToUpdate = expenses.find((e) => String(e.id) === id);
        if (!expenseToUpdate) return;
        const updateData = { ...expenseToUpdate, status: "PAID", remainingAmount: 0 };
        await apiFetch(`/expenses/${id}`, {
          method: "PUT",
          body: JSON.stringify(updateData),
          fallbackError: "FALLO AL CONDONAR DEUDA",
        }, token);
        toast({
          variant: "success",
          title: "DEUDA CONDONADA",
          description: "El egreso se marcó como pagado forzosamente.",
        });
        void loadExpenses();
        broadcastRevalidate("EXPENSE_UPDATE");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "FALLO AL CONDONAR DEUDA";
        toast({ variant: "destructive", title: "FALLO AL CONDONAR", description: msg });
      }
    },
    [expenses, loadExpenses, toast],
  );

  if (authLoading) {
    return (
      <div className="flex-1 h-full w-full flex items-center justify-center">
        <Spinner color="warning" size="lg" />
      </div>
    );
  }

  const payablesCount = liveDebts.length;

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full w-full max-w-[1600px] mx-auto overflow-hidden bg-transparent text-zinc-900 dark:text-zinc-50">
      {/* HEADER */}
      <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50">
        <header className="flex flex-wrap items-center justify-between gap-3 px-1">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-amber-500 flex items-center justify-center text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-amber-500/30 shrink-0">
              <HandCoins size={20} />
            </div>
            <div className="flex flex-col">
              <h1 className="text-[13px] font-medium uppercase tracking-tighter leading-none">
                CONTROL DE <span className="text-amber-500">DEUDA</span>
              </h1>
              <p className="text-[8px] font-medium text-gray-400 dark:text-zinc-600 uppercase tracking-[0.4em] mt-1">
                Préstamos · Cuentas por pagar · Centro de pagos
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              isIconOnly
              size="sm"
              onPress={() => {
                void loadLoans();
                void loadExpenses();
              }}
              isLoading={loading || expensesLoading}
              aria-label="Recargar"
              title="Recargar"
              className="h-10 w-10 card-base border-none dark:bg-[#18181b]/80 text-amber-500 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-gray-200 dark:border-white/5 active:scale-95"
            >
              <RefreshCw size={16} className={loading || expensesLoading ? "animate-spin" : ""} />
            </Button>
            {isAdmin && activeTab === "loans" && (
              <Button
                size="sm"
                onPress={() => setFormOpen(true)}
                className="h-10 bg-amber-500 text-white font-medium uppercase text-[9px] px-4 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-amber-500/20 tracking-widest active:scale-95 shrink-0"
                aria-label="Registrar nuevo préstamo"
              >
                <PlusCircle size={16} />
                <span className="ml-2">Nuevo préstamo</span>
              </Button>
            )}
          </div>
        </header>

        {/* NAVEGACIÓN PRINCIPAL: PRÉSTAMOS ↔ CUENTAS POR PAGAR */}
        <Tabs
          aria-label="Navegar entre préstamos y cuentas por pagar"
          selectedKey={activeTab}
          onSelectionChange={(key) => setActiveTab(String(key) as LoansTab)}
          variant="solid"
          color="warning"
          classNames={{
            base: "px-1",
            tabList: "w-full gap-2 bg-gray-100 dark:bg-zinc-950 p-1 rounded-2xl border border-gray-200 dark:border-white/5",
            cursor: "bg-amber-500 shadow-md rounded-xl",
            // OJO: el slot `tab` de HeroUI ya trae `w-full`. Con `flex-none`
            // la primera pestaña ocupaba el 100% sin poder encogerse y
            // "Cuentas por pagar" quedaba fuera del área visible del tabList.
            // `flex-1` reparte el ancho entre las dos en todo breakpoint.
            tab: "h-9 px-4 flex-1 min-w-0",
            tabContent:
              "font-bold text-[10px] uppercase tracking-widest group-data-[selected=true]:text-white",
          }}
        >
          <Tab
            key="loans"
            title={
              <div className="flex items-center gap-2">
                <HandCoins size={14} />
                <span>Préstamos</span>
                {loans.length > 0 && (
                  <span className="inline-flex min-w-[20px] items-center justify-center rounded-full bg-amber-500/20 px-1.5 text-[9px] font-bold tabular-nums text-amber-600 dark:text-amber-300 group-data-[selected=true]:bg-white/20 group-data-[selected=true]:text-white">
                    {loans.length}
                  </span>
                )}
              </div>
            }
          />
          <Tab
            key="payables"
            title={
              <div className="flex items-center gap-2">
                <Users size={14} />
                <span>Cuentas por pagar</span>
                {payablesCount > 0 && (
                  <span className="inline-flex min-w-[20px] items-center justify-center rounded-full bg-rose-500 px-1.5 text-[9px] font-bold tabular-nums text-white">
                    {payablesCount}
                  </span>
                )}
              </div>
            }
          />
        </Tabs>
      </div>

      {/* CONTENIDO: SE RENDERIZA SEGÚN TAB */}
      {activeTab === "loans" ? (
        <LoansSection
          loading={loading}
          loans={filteredLoans}
          summary={summary}
          serverTotal={serverTotal}
          filter={filter}
          onFilter={setFilter}
          statusFilter={statusFilter}
          onStatusFilter={setStatusFilter}
          onOpenDetail={handleOpenDetail}
          isAdmin={isAdmin}
          onOpenNew={() => setFormOpen(true)}
        />
      ) : (
        <section
          aria-label="Panel de cuentas por pagar"
          className="flex flex-col flex-1 min-h-0 px-3 py-3 overflow-hidden"
        >
          {expensesLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Spinner color="warning" size="lg" />
            </div>
          ) : (
            <PayablesCenter
              debts={liveDebts}
              onSettle={handleSettleDebt}
              isAdmin={isAdmin}
              onForceClose={handleForceCloseDebt}
              loanOption={loanOptionForPayables}
            />
          )}
          {/* Resumen inferior siempre visible como backup del header del center */}
          <p className="shrink-0 mt-2 text-[10px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500 text-right">
            Total adeudado · <span className="tabular-nums text-rose-500">{formatLoanMoney(totalPayables)}</span>
          </p>
        </section>
      )}

      {isAdmin && (
        <LoanFormModal
          isOpen={formOpen}
          onOpenChange={setFormOpen}
          onSubmit={handleCreateLoan}
        />
      )}
    </div>
  );
}

// ============================================================================
// Sección "Préstamos" extraída para que el JSX principal quede legible.
// ============================================================================

interface LoansSectionProps {
  loading: boolean;
  loans: LoanRecord[];
  summary: ReturnType<typeof summarizeLoans>;
  serverTotal: number;
  filter: string;
  onFilter: (v: string) => void;
  statusFilter: "ALL" | "ACTIVE" | "PAID" | "DEFAULTED" | "CANCELLED";
  onStatusFilter: (v: "ALL" | "ACTIVE" | "PAID" | "DEFAULTED" | "CANCELLED") => void;
  onOpenDetail: (id: number | string) => void;
  isAdmin: boolean;
  onOpenNew: () => void;
}

function LoansSection({
  loading,
  loans,
  summary,
  serverTotal,
  filter,
  onFilter,
  statusFilter,
  onStatusFilter,
  onOpenDetail,
  isAdmin,
  onOpenNew,
}: LoansSectionProps) {
  return (
    <>
      <div className="shrink-0 px-3 py-2 flex flex-col gap-3 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50">
        {/* ESTADÍSTICAS */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 px-1">
          <StatCard
            label="Principal activo"
            value={formatLoanMoney(summary.totalPrincipal)}
            caption={`${summary.activeCount} préstamo${summary.activeCount === 1 ? "" : "s"}${
              serverTotal && serverTotal !== summary.activeCount ? ` · ${serverTotal} total` : ""
            }`}
            icon={Wallet}
            color="sky"
          />
          <StatCard
            label="Saldo pendiente"
            value={formatLoanMoney(summary.totalOutstanding)}
            caption="Por pagar al día"
            icon={TrendingDown}
            color="rose"
            progress={
              summary.totalPrincipal > 0
                ? summary.totalPaid / (summary.totalPaid + summary.totalOutstanding)
                : 0
            }
          />
          <StatCard
            label="En mora"
            value={formatLoanMoney(summary.overdueAmount)}
            caption={`${summary.overdueCount} cuota${summary.overdueCount === 1 ? "" : "s"} vencida${summary.overdueCount === 1 ? "" : "s"}`}
            icon={AlertTriangle}
            color="amber"
          />
          <StatCard
            label="Próximos 30 días"
            value={String(summary.upcoming30d.length)}
            caption="Vencimientos cercanos"
            icon={CalendarClock}
            color="emerald"
          />
        </div>

        {/* BUSCADOR + FILTRO DE ESTADO (segmented control táctil) */}
        <div className="flex flex-col sm:flex-row gap-2 px-1">
          <Input
            size="sm"
            placeholder="Buscar por acreedor o nota..."
            value={filter}
            onValueChange={onFilter}
            aria-label="Buscar préstamos"
            classNames={{
              base: "sm:min-w-[260px] flex-1",
              inputWrapper:
                "h-11 px-4 rounded-2xl bg-black/5 dark:bg-[#18181b] border border-gray-200 dark:border-white/5 focus-within:!border-amber-500/30 transition-all w-full shadow-inner",
              input:
                "font-medium text-[11px] uppercase text-zinc-900 dark:text-zinc-50 placeholder:text-gray-400 dark:placeholder:text-zinc-600 bg-transparent tracking-widest",
            }}
            startContent={<Search size={14} className="text-amber-500 mr-1" />}
          />

          <div
            role="radiogroup"
            aria-label="Filtrar por estado"
            className="flex items-center gap-1 bg-gray-100 dark:bg-zinc-950 p-1 rounded-2xl border border-gray-200 dark:border-white/5 overflow-x-auto"
          >
            {([
              { id: "ACTIVE" as const, label: "Activos" },
              { id: "DEFAULTED" as const, label: "Mora" },
              { id: "PAID" as const, label: "Pagados" },
              { id: "CANCELLED" as const, label: "Cancelados" },
              { id: "ALL" as const, label: "Todos" },
            ]).map((opt) => (
              <Button
                key={opt.id}
                size="sm"
                role="radio"
                aria-checked={statusFilter === opt.id}
                variant={statusFilter === opt.id ? "solid" : "light"}
                color={statusFilter === opt.id ? "warning" : "default"}
                onPress={() => onStatusFilter(opt.id)}
                className={`h-9 min-w-[72px] px-3 text-[10px] font-bold uppercase tracking-wider rounded-xl shrink-0 ${
                  statusFilter === opt.id
                    ? "bg-amber-500 text-white font-bold shadow-sm"
                    : "text-zinc-600 dark:text-zinc-400"
                }`}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* LISTA */}
      <div className="flex flex-col flex-1 min-h-0 px-2 py-3 overflow-y-auto custom-scrollbar">
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Spinner color="warning" size="lg" />
          </div>
        ) : loans.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl border-2 border-dashed border-amber-500/40 text-amber-500">
              <CheckCircle2 size={28} />
            </div>
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-bold uppercase tracking-wide text-zinc-900 dark:text-zinc-50">
                {statusFilter === "ACTIVE" ? "Sin préstamos activos" : "Sin préstamos para este filtro"}
              </h3>
              <p className="text-[11px] font-medium text-gray-500 dark:text-zinc-400">
                {isAdmin
                  ? "Registra un nuevo préstamo con el botón de arriba."
                  : "Cuando se registre un préstamo aparecerá aquí."}
              </p>
            </div>
            {isAdmin && (
              <Button
                size="sm"
                onPress={onOpenNew}
                className="h-10 bg-amber-500 text-white font-medium uppercase text-[9px] px-4 rounded-2xl shadow-md tracking-widest active:scale-95"
              >
                <PlusCircle size={16} />
                <span className="ml-2">Nuevo préstamo</span>
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {loans.map((loan) => (
              <LoanRow key={String(loan.id)} loan={loan} onOpen={onOpenDetail} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ============================================================================
// Export por default — envuelve en Suspense porque useSearchParams lo exige
// en static export (misma convención que /loans/detail).
// ============================================================================

export default function LoansPage() {
  return (
    <Suspense
      fallback={
        <div className="flex-1 h-full w-full flex items-center justify-center">
          <Spinner color="warning" size="lg" />
        </div>
      }
    >
      <LoansPageInner />
    </Suspense>
  );
}
