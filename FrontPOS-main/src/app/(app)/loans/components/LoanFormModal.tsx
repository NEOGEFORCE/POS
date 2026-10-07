"use client";

/**
 * LoanFormModal — formulario para registrar un préstamo nuevo + preview del
 * cronograma de amortización en vivo.
 *
 * REDISEÑO (sprint actual):
 *   - Modal `size="full"` en móvil → `md:size="5xl"` en desktop para dar
 *     espacio al preview sin apretar los selects.
 *   - Grid del formulario: 1 columna en móvil, 2 columnas sólo con ancho
 *     suficiente (sm+). Antes se usaba `grid-cols-2` fijo y con ~175 px
 *     por celda los labels se superponían con el input adyacente.
 *   - Labels propios (<Field>, un <label htmlFor> arriba del control). NO se
 *     usa el `label` de HeroUI: su posicionamiento absoluto se montaba
 *     sobre el input en producción.
 *   - Secciones agrupadas en 3 pasos visuales: Prestamista · Montos y
 *     plazo · Fecha y canal. Cada una con su `h4` tracking-widest.
 *   - Preview: tabla compacta (N° · Vence · Cuota), con Capital/Interés en
 *     una línea secundaria para no competir en viewports <lg.
 *   - Footer SIEMPRE visible, apilado en móvil, con "Total a pagar" en una
 *     fila y botones en la siguiente (`flex-col sm:flex-row`).
 *
 * El cálculo del cronograma vive en `@/lib/loans.mjs` — este componente
 * nunca lo reimplementa. Preview backend con debounce 300ms y fallback
 * local a `buildSchedule`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Textarea,
  Select,
  SelectItem,
  Divider,
  ScrollShadow,
  Spinner,
  Chip,
} from "@heroui/react";
import {
  Calculator,
  HandCoins,
  Percent,
  Hash,
  User,
  Banknote,
  Sparkles,
  X,
  AlertCircle,
  Landmark,
  Building2,
  CalendarDays,
  Shield,
  AlertTriangle,
  Lock,
  CheckCircle2,
} from "lucide-react";

import { apiFetch } from "@/lib/api-error";
import { useToast } from "@/hooks/use-toast";
import { formatInputCOP } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import {
  INTEREST_MODES,
  PAYMENT_FREQUENCIES,
  LOAN_TYPES,
  RATE_TYPES,
  LOAN_CURRENCIES,
  buildSchedule,
  formatLoanMoney,
  frenchDisplayTotals,
  normalizeLoanPreviewResponse,
  parseLoanAmount,
  type ScheduleResult,
  type LoanInterestMode,
  type LoanPaymentFrequency,
  type LoanRecord,
  type LoanType,
  type LoanRateType,
  type LoanCurrency,
} from "@/lib/loans.mjs";

export type LoanFormMode = "create" | "edit";

/**
 * Payload que emite el modal. En `create` sale sin `recalculate` (el POST
 * del backend siempre reemplaza el cronograma). En `edit` incluye
 * `recalculate`: cuando es `false`, los campos financieros vienen igual
 * que estaban en el préstamo original y el backend sólo aplica metadata;
 * cuando es `true`, los campos financieros vienen con los valores nuevos
 * y el backend reconstruye las cuotas (requiere 0 cuotas pagadas).
 *
 * El parent decide cómo envolver este payload para el endpoint que llame
 * (POST plano vs PUT con `{ metadata, schedule }`); el modal es
 * shape-agnostic a propósito para no acoplarse al contrato del backend.
 */
export type LoanFormPayload = Record<string, unknown>;

interface LoanFormModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: LoanFormPayload) => Promise<void>;
  mode?: LoanFormMode;
  /** Préstamo a precargar (sólo en `mode="edit"`). */
  loan?: LoanRecord | null;
}

interface FormState {
  lenderName: string;
  lenderDni: string;
  principalAmount: string;
  interestRatePct: string;
  interestMode: LoanInterestMode;
  termCount: string;
  paymentFrequency: LoanPaymentFrequency;
  startDate: string;
  firstPaymentDate: string;
  disbursementChannel: string;
  note: string;
  // Campos exclusivos de FRENCH (Sistema francés banca).
  monthlyInsurance: string;
  fgaTotal: string;
  // ───────── Metadata bancaria (sección 4) ─────────
  creditNumber: string;
  loanType: LoanType;
  holderName: string;
  holderDni: string;
  currency: LoanCurrency;
  rateType: LoanRateType;
  autoDebit: boolean;
  maturityDate: string;
  lateAnnualEffectiveRatePct: string;
  netDisbursementAmount: string;
  fgaIvaAmount: string;
  fgaGmfAmount: string;
  // ───────── Snapshot banco (sección 5) ─────────
  bankBalanceAmount: string;
  bankBalanceAsOf: string;
  bankPaidAmount: string;
  officialNextInstallmentAmount: string;
  officialNextInstallmentDate: string;
}

const DEFAULT_FORM: FormState = {
  lenderName: "",
  lenderDni: "",
  principalAmount: "",
  // Por defecto Sistema Francés (créditos bancarios reales). La EA arranca
  // vacía: 0% no es válido en FRENCH y obliga a digitar la tasa del banco.
  interestRatePct: "",
  interestMode: INTEREST_MODES.FRENCH as LoanInterestMode,
  termCount: "6",
  paymentFrequency: PAYMENT_FREQUENCIES.MONTHLY as LoanPaymentFrequency,
  startDate: todayISO(),
  firstPaymentDate: addDaysISO(todayISO(), 30),
  disbursementChannel: "EFECTIVO",
  note: "",
  monthlyInsurance: "",
  fgaTotal: "",
  creditNumber: "",
  loanType: LOAN_TYPES.OTRO as LoanType,
  holderName: "",
  holderDni: "",
  currency: LOAN_CURRENCIES.COP as LoanCurrency,
  rateType: RATE_TYPES.FIJO as LoanRateType,
  autoDebit: false,
  maturityDate: "",
  lateAnnualEffectiveRatePct: "",
  netDisbursementAmount: "",
  fgaIvaAmount: "",
  fgaGmfAmount: "",
  bankBalanceAmount: "",
  bankBalanceAsOf: "",
  bankPaidAmount: "",
  officialNextInstallmentAmount: "",
  officialNextInstallmentDate: "",
};

function stringifyMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "";
  return formatInputCOP(String(Math.round(n)));
}

function stringifyNumber(value: number | null | undefined, allowZero = false): string {
  if (value === null || value === undefined) return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  if (!allowZero && n === 0) return "";
  return String(n);
}

function dateOnly(value: string | null | undefined): string {
  if (!value) return "";
  // Acepta "YYYY-MM-DD" o ISO completo "YYYY-MM-DDTHH:MM...".
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function datetimeLocal(value: string | null | undefined): string {
  if (!value) return "";
  // El <input type="datetime-local"> acepta "YYYY-MM-DDTHH:MM".
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
  return m ? m[1] : "";
}

/**
 * Convierte un `LoanRecord` cargado del backend al estado inicial del
 * formulario en modo edición. Los campos monetarios se emiten como string
 * formateado COP para que el input los muestre tal cual.
 */
function stateFromLoan(loan: LoanRecord | null | undefined): FormState {
  if (!loan) return { ...DEFAULT_FORM };
  const mode = (String(loan.interestMode || "FRENCH").toUpperCase() as LoanInterestMode) ||
    (INTEREST_MODES.FRENCH as LoanInterestMode);
  const isFrench = mode === INTEREST_MODES.FRENCH;
  // Para el input de tasa: en FRENCH mostramos EA, en NONE/SIMPLE la tasa flat.
  const rateDisplay = isFrench
    ? loan.annualEffectiveRatePct !== undefined && loan.annualEffectiveRatePct !== null
      ? String(loan.annualEffectiveRatePct)
      : ""
    : loan.interestRatePct !== undefined && loan.interestRatePct !== null
    ? String(loan.interestRatePct)
    : "";
  return {
    lenderName: loan.lenderName ?? "",
    lenderDni: loan.lenderDni ?? "",
    principalAmount: stringifyMoney(loan.principalAmount),
    interestRatePct: rateDisplay,
    interestMode: mode,
    termCount: stringifyNumber(loan.termCount, true) || "0",
    paymentFrequency:
      (String(loan.paymentFrequency || "MONTHLY").toUpperCase() as LoanPaymentFrequency) ||
      (PAYMENT_FREQUENCIES.MONTHLY as LoanPaymentFrequency),
    startDate: dateOnly(loan.startDate) || todayISO(),
    firstPaymentDate: dateOnly(loan.firstPaymentDate) || addDaysISO(todayISO(), 30),
    disbursementChannel: String(loan.disbursementChannel || "EFECTIVO"),
    note: loan.note ?? "",
    monthlyInsurance: isFrench ? stringifyMoney(loan.monthlyInsurance) : "",
    fgaTotal: isFrench ? stringifyMoney(loan.fgaTotal) : "",
    creditNumber: loan.creditNumber ?? "",
    loanType:
      ((String(loan.loanType || "OTRO").toUpperCase() as LoanType) || (LOAN_TYPES.OTRO as LoanType)),
    holderName: loan.holderName ?? "",
    holderDni: loan.holderDni ?? "",
    currency:
      ((String(loan.currency || "COP").toUpperCase() as LoanCurrency) ||
        (LOAN_CURRENCIES.COP as LoanCurrency)),
    rateType:
      ((String(loan.rateType || "FIJO").toUpperCase() as LoanRateType) ||
        (RATE_TYPES.FIJO as LoanRateType)),
    autoDebit: Boolean(loan.autoDebit),
    maturityDate: dateOnly(loan.maturityDate),
    lateAnnualEffectiveRatePct: stringifyNumber(loan.lateAnnualEffectiveRatePct, true),
    netDisbursementAmount: stringifyMoney(loan.netDisbursementAmount),
    fgaIvaAmount: stringifyMoney(loan.fgaIvaAmount),
    fgaGmfAmount: stringifyMoney(loan.fgaGmfAmount),
    bankBalanceAmount: stringifyMoney(loan.bankBalanceAmount),
    bankBalanceAsOf: datetimeLocal(loan.bankBalanceAsOf),
    bankPaidAmount: stringifyMoney(loan.bankPaidAmount),
    officialNextInstallmentAmount: stringifyMoney(loan.officialNextInstallmentAmount),
    officialNextInstallmentDate: dateOnly(loan.officialNextInstallmentDate),
  };
}

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysISO(baseISO: string, days: number): string {
  const [y, m, d] = baseISO.split("-").map(Number);
  if (!y || !m || !d) return baseISO;
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Clases compartidas de los controles.
// ---------------------------------------------------------------------------
//
// CORRECCIÓN 2026-10-05: forzar `!static` sobre el label de HeroUI con
// `labelPlacement="outside"` lo sacaba de su contenedor y en producción el
// texto quedaba DEBAJO o ENCIMA del control (todo "montonado"). Ahora el
// label es nuestro: <Field> pinta un <label htmlFor> normal arriba del
// control y los componentes HeroUI ya no reciben `label`, así que no hay
// posicionamiento absoluto que pelear.
const INPUT_CLASSES = {
  base: "w-full",
  inputWrapper:
    "h-11 bg-white dark:bg-[#121214] border border-gray-200 dark:border-white/10 shadow-inner rounded-xl",
  input: "text-[13px] font-medium",
  description: "text-[10px] text-gray-500 dark:text-zinc-500",
} as const;

const SELECT_CLASSES = {
  base: "w-full",
  trigger:
    "h-11 bg-white dark:bg-[#121214] border border-gray-200 dark:border-white/10 shadow-inner rounded-xl",
  value: "text-[13px] font-medium",
} as const;

interface FieldProps {
  id: string;
  label: string;
  required?: boolean;
  children: React.ReactNode;
}

/** Label visible fuera del control, en flujo normal del documento. */
function Field({ id, label, required, children }: FieldProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label
        id={`${id}-label`}
        htmlFor={id}
        className="text-[10px] font-bold uppercase tracking-widest text-gray-600 dark:text-zinc-400"
      >
        {label}
        {required && <span className="ml-0.5 text-rose-500" aria-hidden>*</span>}
      </label>
      {children}
    </div>
  );
}

export default function LoanFormModal({
  isOpen,
  onOpenChange,
  onSubmit,
  mode = "create",
  loan = null,
}: LoanFormModalProps) {
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(() =>
    mode === "edit" && loan ? stateFromLoan(loan) : DEFAULT_FORM,
  );
  const [preview, setPreview] = useState<ScheduleResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewSource, setPreviewSource] = useState<"server" | "local" | "idle">("idle");
  const [submitting, setSubmitting] = useState(false);
  // Edit mode: por defecto los inputs del cronograma (principal, tasa, plazo,
  // frecuencia, firstPaymentDate, monthlyInsurance, fgaTotal) están
  // deshabilitados. Para recalcular, el admin debe activar explícitamente el
  // switch — y sólo cuando no haya cuotas pagadas (ancla contable).
  const [recalculate, setRecalculate] = useState(false);
  const installmentsPaid = useMemo(() => {
    if (mode !== "edit" || !loan) return 0;
    const stat = Number(loan.installmentsPaid ?? loan.stats?.installmentsPaid ?? 0);
    if (Number.isFinite(stat) && stat > 0) return stat;
    const items = Array.isArray(loan.installments) ? loan.installments : [];
    return items.reduce((acc, it) => {
      const paid = Number(it?.paidAmount ?? 0);
      const totalDue = Number(it?.totalDue ?? 0);
      const status = String(it?.status || "").toUpperCase();
      if (status === "PAID") return acc + 1;
      if (totalDue > 0 && paid >= totalDue - 0.01) return acc + 1;
      return acc;
    }, 0);
  }, [mode, loan]);
  const canRecalculate = installmentsPaid === 0;

  useEffect(() => {
    if (isOpen) {
      setForm(mode === "edit" && loan ? stateFromLoan(loan) : DEFAULT_FORM);
      setPreview(null);
      setPreviewSource("idle");
      setRecalculate(false);
    }
  }, [isOpen, mode, loan]);

  // Edit sin recalculate: no bloquea el preview porque los campos financieros
  // vienen con los valores actuales y el preview actúa como "verificación
  // informativa". Edit con recalculate: igual que create.
  const scheduleLocked = mode === "edit" && !recalculate;

  const toPayload = useCallback(
    (state: FormState) => {
      const interestModeValue = state.interestMode;
      const ratePctRaw = parseLoanAmount(state.interestRatePct);
      const isFrench = interestModeValue === INTEREST_MODES.FRENCH;
      const interestRatePct =
        interestModeValue === INTEREST_MODES.NONE ? 0 : isFrench ? 0 : ratePctRaw;
      const monthlyInsurance = isFrench ? parseLoanAmount(state.monthlyInsurance) : 0;
      const fgaTotal = isFrench ? parseLoanAmount(state.fgaTotal) : 0;
      const payload: Record<string, unknown> = {
        lenderName: state.lenderName.trim().toUpperCase(),
        lenderDni: state.lenderDni.trim() || null,
        principalAmount: parseLoanAmount(state.principalAmount),
        interestRatePct,
        interestMode: interestModeValue,
        termCount: Math.floor(parseLoanAmount(state.termCount)),
        // FRENCH fuerza frecuencia MONTHLY (el input se bloquea en la UI).
        paymentFrequency: isFrench ? "MONTHLY" : state.paymentFrequency,
        startDate: state.startDate,
        firstPaymentDate: state.firstPaymentDate,
        disbursementChannel: state.disbursementChannel,
        note: state.note.trim() || null,
      };
      if (isFrench) {
        payload.annualEffectiveRatePct = ratePctRaw;
        payload.monthlyInsurance = monthlyInsurance;
        payload.fgaTotal = fgaTotal;
      }
      // ───── Metadata bancaria (sección 4) ─────
      payload.creditNumber = state.creditNumber.trim() || null;
      payload.loanType = state.loanType;
      payload.holderName = state.holderName.trim().toUpperCase() || null;
      payload.holderDni = state.holderDni.trim() || null;
      payload.currency = state.currency;
      payload.rateType = state.rateType;
      payload.autoDebit = Boolean(state.autoDebit);
      payload.maturityDate = state.maturityDate || null;
      // Mora EA puede valer 0 explícitamente — enviamos siempre un número.
      payload.lateAnnualEffectiveRatePct = parseLoanAmount(state.lateAnnualEffectiveRatePct);
      payload.netDisbursementAmount = state.netDisbursementAmount
        ? parseLoanAmount(state.netDisbursementAmount)
        : null;
      // El FGA total ya se pasa arriba cuando el modo es FRENCH. En NONE/SIMPLE
      // no aplica (va 0). Los dos impuestos del FGA se emiten como campos
      // propios para que el backend los persista por separado.
      payload.fgaTotalAmount = isFrench ? fgaTotal : null;
      payload.fgaIvaAmount = state.fgaIvaAmount ? parseLoanAmount(state.fgaIvaAmount) : 0;
      payload.fgaGmfAmount = state.fgaGmfAmount ? parseLoanAmount(state.fgaGmfAmount) : 0;
      // ───── Snapshot banco (sección 5) ─────
      payload.bankBalanceAmount = state.bankBalanceAmount
        ? parseLoanAmount(state.bankBalanceAmount)
        : null;
      payload.bankBalanceAsOf = state.bankBalanceAsOf
        ? new Date(state.bankBalanceAsOf).toISOString()
        : null;
      payload.bankPaidAmount = state.bankPaidAmount
        ? parseLoanAmount(state.bankPaidAmount)
        : null;
      payload.officialNextInstallmentAmount = state.officialNextInstallmentAmount
        ? parseLoanAmount(state.officialNextInstallmentAmount)
        : null;
      payload.officialNextInstallmentDate = state.officialNextInstallmentDate || null;

      // En edit, le decimos al parent si debe reconstruir el cronograma. El
      // parent es quien envuelve este flag en `schedule.recalculate` para la
      // llamada PUT; el modal se mantiene shape-agnostic.
      if (mode === "edit") {
        payload.recalculate = recalculate;
      }
      return payload;
    },
    [mode, recalculate],
  );

  const payloadPreview = useMemo(() => toPayload(form), [form, toPayload]);

  const canPreview = useMemo(() => {
    const principal = parseLoanAmount(form.principalAmount);
    const term = Math.floor(parseLoanAmount(form.termCount));
    const rate = parseLoanAmount(form.interestRatePct);
    if (!(principal > 0) || term < 1) return false;
    if (!form.firstPaymentDate) return false;
    if (form.interestMode === INTEREST_MODES.FRENCH) {
      // EA > 0 obligatoria. Seguro y FGA pueden ser 0.
      if (!(rate > 0)) return false;
      if (parseLoanAmount(form.monthlyInsurance) < 0) return false;
      if (parseLoanAmount(form.fgaTotal) < 0) return false;
      return true;
    }
    if (form.interestMode === INTEREST_MODES.NONE) return rate === 0;
    if (form.interestMode === INTEREST_MODES.SIMPLE) return rate > 0;
    return rate >= 0;
  }, [
    form.principalAmount,
    form.termCount,
    form.interestRatePct,
    form.interestMode,
    form.monthlyInsurance,
    form.fgaTotal,
    form.firstPaymentDate,
  ]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!canPreview) {
      setPreview(null);
      setPreviewSource("idle");
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setPreviewLoading(true);
      const payload = payloadPreview;
      const isFrench = form.interestMode === INTEREST_MODES.FRENCH;
      // Preview local — fuente única `buildSchedule`. En FRENCH pasamos la
      // EA explícita y los extras; en NONE/SIMPLE sólo `interestRatePct`.
      const local = buildSchedule({
        principal: parseLoanAmount(form.principalAmount),
        interestRatePct: isFrench ? 0 : parseLoanAmount(form.interestRatePct),
        annualEffectiveRatePct: isFrench ? parseLoanAmount(form.interestRatePct) : undefined,
        monthlyInsurance: isFrench ? parseLoanAmount(form.monthlyInsurance) : undefined,
        fgaTotal: isFrench ? parseLoanAmount(form.fgaTotal) : undefined,
        mode: form.interestMode,
        termCount: Math.floor(parseLoanAmount(form.termCount)),
        frequency: isFrench ? "MONTHLY" : form.paymentFrequency,
        firstPaymentDate: form.firstPaymentDate,
      });
      setPreview(local);
      setPreviewSource("local");

      try {
        const raw = await apiFetch<unknown>("/loans/preview", {
          method: "POST",
          body: JSON.stringify(payload),
          signal: controller.signal,
          fallbackError: "Preview no disponible",
          timeoutMs: 4000,
        });
        if (!controller.signal.aborted) {
          const serverPreview = normalizeLoanPreviewResponse(raw);
          if (
            serverPreview &&
            Array.isArray(serverPreview.installments) &&
            serverPreview.installments.length > 0
          ) {
            setPreview(serverPreview);
            setPreviewSource("server");
          }
        }
      } catch (err: unknown) {
        if (!(err instanceof Error) || err.name !== "AbortError") {
          setPreviewSource("local");
        }
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [payloadPreview, canPreview, form]);

  const canSubmit = useMemo(() => {
    const principal = parseLoanAmount(form.principalAmount);
    const term = Math.floor(parseLoanAmount(form.termCount));
    if (submitting) return false;
    if (form.lenderName.trim().length === 0) return false;
    if (principal <= 0) return false;
    if (term < 1) return false;
    // En edición sólo-metadata, no exigimos un preview válido: los campos
    // financieros vienen inmutables y lo único que valida el backend es la
    // metadata. En creación o recalculate, el preview debe estar sano.
    if (!scheduleLocked) {
      if (!preview || preview.error) return false;
    }
    return true;
  }, [form, preview, submitting, scheduleLocked]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    const payload = toPayload(form);
    setSubmitting(true);
    try {
      await onSubmit(payload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "No se pudo guardar el préstamo";
      toast({ variant: "destructive", title: "ERROR", description: msg });
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, form, onSubmit, toPayload, toast]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const totals = preview?.totals;
  const isFrenchMode = form.interestMode === INTEREST_MODES.FRENCH;
  // FRENCH: cuota mensual final = cuota base + cargos; total = final × cuotas.
  const frenchView = isFrenchMode
    ? frenchDisplayTotals(totals, preview?.installments?.length || parseLoanAmount(form.termCount))
    : null;
  const displayTotalToPay = frenchView ? frenchView.totalToPay : totals?.totalPayable || 0;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      // Responsive: `size="full"` en móvil (teclado no tapa el form) y
      // `md:size="5xl"` para dar aire al preview en desktop. HeroUI
      // acepta tamaño responsive sólo vía classNames.wrapper → aquí
      // combinamos `size="full"` + override para desktop.
      size="full"
      scrollBehavior="inside"
      placement="center"
      hideCloseButton
      classNames={{
        base:
          "bg-white dark:bg-zinc-950 rounded-none md:rounded-3xl border-0 md:border md:border-gray-200 dark:md:border-white/10 h-[100dvh] md:h-auto md:max-h-[92vh] md:w-[min(1120px,96vw)] md:mx-auto",
        header: "border-b border-gray-200 dark:border-white/10 px-6 py-4 shrink-0",
        footer: "border-t border-gray-200 dark:border-white/10 px-6 py-4 bg-gray-50 dark:bg-[#18181b] shrink-0",
        body: "p-0 overflow-hidden",
        wrapper: "items-center",
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-md">
                  <HandCoins size={22} />
                </div>
                <div className="flex min-w-0 flex-col">
                  <h2 className="text-base sm:text-xl font-bold uppercase leading-tight tracking-tight">
                    {mode === "edit" ? (
                      <>
                        Editar <span className="text-amber-500">préstamo</span>
                      </>
                    ) : (
                      <>
                        Nuevo <span className="text-amber-500">préstamo</span>
                      </>
                    )}
                  </h2>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] font-medium text-gray-500 dark:text-zinc-400">
                    <span className="hidden sm:inline">
                      {mode === "edit"
                        ? "Metadatos siempre editables · Cronograma protegido por cuotas pagadas ·"
                        : "El cronograma se calcula al momento ·"}
                    </span>
                    <Chip
                      size="sm"
                      variant="flat"
                      color={previewSource === "server" ? "success" : previewSource === "local" ? "warning" : "default"}
                      classNames={{ base: "h-5 text-[9px] font-bold uppercase tracking-widest" }}
                    >
                      {previewSource === "server"
                        ? "Confirmado"
                        : previewSource === "local"
                        ? "Estimado local"
                        : "—"}
                    </Chip>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Cerrar formulario"
                className="rounded-xl p-2 text-gray-400 transition-colors hover:bg-rose-500/10 hover:text-rose-500 shrink-0"
              >
                <X size={22} />
              </button>
            </ModalHeader>

            <ModalBody>
              {/* Scroll único dentro del body — ambas columnas comparten
                  el scrollBehavior="inside" del modal pero cada una tiene
                  su propio límite para no estirar la silueta. */}
              <div className="h-full overflow-y-auto custom-scrollbar">
                <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 lg:gap-5 p-5 lg:p-6">
                  {/* ---------- FORM ---------- */}
                  <form
                    className="flex min-w-0 flex-col gap-5 lg:col-span-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleSubmit();
                    }}
                    aria-label={
                      mode === "edit"
                        ? "Formulario de edición de préstamo"
                        : "Formulario de nuevo préstamo"
                    }
                  >
                    {/* PASO 1 · PRESTAMISTA */}
                    <section className="flex flex-col gap-3" aria-labelledby="loan-step-lender">
                      <h4
                        id="loan-step-lender"
                        className="text-[10px] font-bold uppercase tracking-[0.3em] text-amber-500"
                      >
                        1 · Prestamista
                      </h4>

                      <Field id="loan-lender-name" label="Prestamista" required>
                        <Input
                          id="loan-lender-name"
                          isRequired
                          size="sm"
                          placeholder="Ej. Banco de Bogotá o nombre de la persona"
                          value={form.lenderName}
                          onValueChange={(v) => update("lenderName", v)}
                          startContent={<User size={14} className="text-amber-500 shrink-0" />}
                          description="Para bancos o entidades, escribe únicamente su nombre."
                          classNames={INPUT_CLASSES}
                          aria-label="Nombre del prestamista"
                        />
                      </Field>

                      <Field id="loan-lender-dni" label="Documento de referencia (opcional)">
                        <Input
                          id="loan-lender-dni"
                          size="sm"
                          placeholder="Puedes dejarlo vacío"
                          value={form.lenderDni}
                          onValueChange={(v) => update("lenderDni", v)}
                          description="Úsalo solo si necesitas identificar a una persona o guardar el NIT; nunca bloquea el registro."
                          classNames={INPUT_CLASSES}
                          aria-label="Documento opcional del prestamista"
                        />
                      </Field>
                    </section>

                    <Divider />

                    {/* PASO 2 · MONTOS Y PLAZO */}
                    <section className="flex flex-col gap-3" aria-labelledby="loan-step-amount">
                      <h4
                        id="loan-step-amount"
                        className="text-[10px] font-bold uppercase tracking-[0.3em] text-amber-500"
                      >
                        2 · Montos y plazo
                      </h4>

                      {mode === "edit" && (
                        <div
                          role="group"
                          aria-labelledby="loan-recalc-title"
                          className={`flex flex-col gap-2 rounded-2xl border p-3 ${
                            recalculate
                              ? "border-amber-500/40 bg-amber-500/5"
                              : "border-sky-500/30 bg-sky-500/5"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-2 min-w-0">
                              {recalculate ? (
                                <AlertTriangle size={16} className="shrink-0 mt-0.5 text-amber-500" />
                              ) : (
                                <Lock size={16} className="shrink-0 mt-0.5 text-sky-500" />
                              )}
                              <div className="flex flex-col gap-0.5">
                                <p
                                  id="loan-recalc-title"
                                  className="text-[11px] font-bold uppercase tracking-widest text-zinc-900 dark:text-zinc-50"
                                >
                                  Recalcular cuotas
                                </p>
                                <p className="text-[10px] font-medium leading-tight text-gray-500 dark:text-zinc-400">
                                  {canRecalculate
                                    ? "Sólo se habilita cuando no hay cuotas pagadas. Al confirmar, el backend elimina las cuotas pendientes y crea un cronograma nuevo."
                                    : `Bloqueado: hay ${installmentsPaid} cuota${installmentsPaid === 1 ? "" : "s"} pagada${installmentsPaid === 1 ? "" : "s"}. El cronograma está anclado contablemente.`}
                                </p>
                              </div>
                            </div>
                            <Switch
                              size="sm"
                              color="warning"
                              checked={recalculate}
                              onCheckedChange={(checked) => {
                                if (!canRecalculate) return;
                                setRecalculate(checked);
                              }}
                              disabled={!canRecalculate}
                              aria-label="Recalcular cronograma del préstamo"
                            />
                          </div>
                        </div>
                      )}

                      <Field id="loan-principal" label="Monto principal (COP)" required>
                        <Input
                          id="loan-principal"
                          isRequired
                          size="sm"
                          inputMode="numeric"
                          placeholder="1.000.000"
                          value={form.principalAmount}
                          onValueChange={(v) => update("principalAmount", formatInputCOP(v))}
                          startContent={<Banknote size={14} className="text-amber-500 shrink-0" />}
                          isDisabled={scheduleLocked}
                          description={
                            scheduleLocked
                              ? "Activa 'Recalcular cuotas' para modificar."
                              : undefined
                          }
                          classNames={INPUT_CLASSES}
                          aria-label="Monto principal del préstamo en pesos colombianos"
                        />
                      </Field>

                      {/* Grid 1→2 cols: en móvil se apila, en sm+ dos columnas. */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field id="loan-interest-mode" label="Modo de interés">
                          <Select
                            id="loan-interest-mode"
                            size="sm"
                            selectedKeys={new Set([form.interestMode])}
                            onSelectionChange={(keys) => {
                              const [first] = Array.from(keys);
                              if (!first) return;
                              const mode = String(first) as LoanInterestMode;
                              update("interestMode", mode);
                              if (mode === INTEREST_MODES.NONE) {
                                update("interestRatePct", "0");
                              }
                              if (mode === INTEREST_MODES.FRENCH) {
                                // FRENCH fuerza MONTHLY (banca liquida mes
                                // vencido). El select se bloquea abajo.
                                update(
                                  "paymentFrequency",
                                  PAYMENT_FREQUENCIES.MONTHLY as LoanPaymentFrequency,
                                );
                                // Reiniciamos el "0" por defecto que viene de
                                // SIMPLE/NONE: EA 0% no es válido en FRENCH.
                                if (parseLoanAmount(form.interestRatePct) === 0) {
                                  update("interestRatePct", "");
                                }
                              }
                            }}
                            classNames={SELECT_CLASSES}
                            isDisabled={scheduleLocked}
                            aria-label="Modo de interés"
                          >
                            <SelectItem key="FRENCH">Sistema Francés (Sobre saldos)</SelectItem>
                            <SelectItem key="SIMPLE">Interés simple</SelectItem>
                            <SelectItem key="NONE">Sin interés</SelectItem>
                          </Select>
                        </Field>
                        <Field
                          id="loan-interest-pct"
                          label={
                            form.interestMode === INTEREST_MODES.FRENCH
                              ? "Tasa Efectiva Anual (E.A.)"
                              : "% interés total"
                          }
                        >
                          <Input
                            id="loan-interest-pct"
                            size="sm"
                            inputMode="decimal"
                            placeholder={
                              form.interestMode === INTEREST_MODES.FRENCH ? "21.3" : "0"
                            }
                            value={form.interestRatePct}
                            onValueChange={(v) => update("interestRatePct", v.replace(/[^0-9.,]/g, ""))}
                            startContent={<Percent size={14} className="text-amber-500 shrink-0" />}
                            isDisabled={scheduleLocked || form.interestMode === INTEREST_MODES.NONE}
                            description={
                              form.interestMode === INTEREST_MODES.FRENCH
                                ? "El motor convierte EA → M.V. mensual."
                                : "Porcentaje total sobre el principal."
                            }
                            classNames={INPUT_CLASSES}
                            aria-label={
                              form.interestMode === INTEREST_MODES.FRENCH
                                ? "Tasa efectiva anual (porcentaje)"
                                : "Porcentaje de interés total flat"
                            }
                          />
                        </Field>
                      </div>

                      {/* Sistema Francés: un único valor MENSUAL de seguros y
                          otros cargos (seguro de vida + FGA ya prorrateado,
                          etc.). Se suma tal cual a la cuota base de cada mes.
                          Para NONE/SIMPLE el formulario no cambia. */}
                      {form.interestMode === INTEREST_MODES.FRENCH && (
                        <div
                          className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3"
                          aria-label="Cargos bancarios mensuales"
                        >
                          <Field
                            id="loan-monthly-insurance"
                            label="Valor mensual de seguros y otros cargos (Ej: Seguro de Vida + FGA diferido)"
                          >
                            <Input
                              id="loan-monthly-insurance"
                              size="sm"
                              inputMode="numeric"
                              placeholder="0 (opcional)"
                              value={form.monthlyInsurance}
                              onValueChange={(v) =>
                                update("monthlyInsurance", formatInputCOP(v))
                              }
                              startContent={
                                <Banknote size={14} className="text-amber-500 shrink-0" />
                              }
                              isDisabled={scheduleLocked}
                              description="Opcional. Se suma a la cuota base de cada mes."
                              classNames={INPUT_CLASSES}
                              aria-label="Valor mensual de seguros y otros cargos"
                            />
                          </Field>
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field id="loan-term-count" label="Número de cuotas" required>
                          <Input
                            id="loan-term-count"
                            isRequired
                            size="sm"
                            type="number"
                            inputMode="numeric"
                            placeholder="6"
                            value={form.termCount}
                            onValueChange={(v) => update("termCount", v.replace(/[^0-9]/g, ""))}
                            startContent={<Hash size={14} className="text-amber-500 shrink-0" />}
                            isDisabled={scheduleLocked}
                            classNames={INPUT_CLASSES}
                            aria-label="Número de cuotas"
                          />
                        </Field>
                        <Field id="loan-frequency" label="Frecuencia">
                          <Select
                            id="loan-frequency"
                            size="sm"
                            selectedKeys={new Set([form.paymentFrequency])}
                            onSelectionChange={(keys) => {
                              const [first] = Array.from(keys);
                              if (first) update("paymentFrequency", String(first) as LoanPaymentFrequency);
                            }}
                            classNames={SELECT_CLASSES}
                            isDisabled={scheduleLocked || form.interestMode === INTEREST_MODES.FRENCH}
                            description={
                              form.interestMode === INTEREST_MODES.FRENCH
                                ? "Francés banca: mensual obligatorio."
                                : undefined
                            }
                            aria-label="Frecuencia de pago"
                          >
                            <SelectItem key="WEEKLY">Semanal</SelectItem>
                            <SelectItem key="BIWEEKLY">Quincenal</SelectItem>
                            <SelectItem key="MONTHLY">Mensual</SelectItem>
                          </Select>
                        </Field>
                      </div>
                    </section>

                    <Divider />

                    {/* PASO 3 · FECHA Y CANAL */}
                    <section className="flex flex-col gap-3" aria-labelledby="loan-step-channel">
                      <h4
                        id="loan-step-channel"
                        className="text-[10px] font-bold uppercase tracking-[0.3em] text-amber-500"
                      >
                        3 · Fecha y canal
                      </h4>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {/* Sin ícono a la izquierda: el input date nativo ya
                            trae su propio botón y con el ícono la fecha se
                            cortaba ("10/0"). */}
                        <Field id="loan-start-date" label="Fecha de desembolso">
                          <Input
                            id="loan-start-date"
                            size="sm"
                            type="date"
                            value={form.startDate}
                            onValueChange={(v) => update("startDate", v)}
                            classNames={INPUT_CLASSES}
                            aria-label="Fecha de desembolso del préstamo"
                          />
                        </Field>
                        <Field id="loan-first-payment" label="Primera cuota">
                          <Input
                            id="loan-first-payment"
                            size="sm"
                            type="date"
                            value={form.firstPaymentDate}
                            onValueChange={(v) => update("firstPaymentDate", v)}
                            isDisabled={scheduleLocked}
                            classNames={INPUT_CLASSES}
                            aria-label="Fecha de la primera cuota"
                          />
                        </Field>
                      </div>

                      <Field id="loan-channel" label="Canal de desembolso">
                        <Select
                          id="loan-channel"
                          size="sm"
                          selectedKeys={new Set([form.disbursementChannel])}
                          onSelectionChange={(keys) => {
                            const [first] = Array.from(keys);
                            if (first) update("disbursementChannel", String(first));
                          }}
                          classNames={SELECT_CLASSES}
                          aria-label="Canal por el que se recibe el dinero"
                        >
                          <SelectItem key="EFECTIVO">Efectivo</SelectItem>
                          <SelectItem key="FONDO">Fondo / Bóveda</SelectItem>
                          <SelectItem key="NEQUI">Nequi</SelectItem>
                          <SelectItem key="DAVIPLATA">Daviplata</SelectItem>
                          <SelectItem key="BANCO">Transferencia bancaria</SelectItem>
                        </Select>
                      </Field>

                      <Field id="loan-note" label="Nota (opcional)">
                        <Textarea
                          id="loan-note"
                          size="sm"
                          minRows={2}
                          maxRows={4}
                          value={form.note}
                          onValueChange={(v) => update("note", v)}
                          placeholder="Garantía, propósito, condiciones..."
                          classNames={{
                            base: "w-full",
                            inputWrapper: "bg-white dark:bg-[#121214] border border-gray-200 dark:border-white/10 shadow-inner rounded-xl",
                            input: INPUT_CLASSES.input,
                          }}
                          aria-label="Notas del préstamo"
                        />
                      </Field>
                    </section>

                    <Divider />

                    {/* PASO 4 · DATOS DEL BANCO
                        Metadata del crédito que el banco pacta por contrato
                        y que la UI muestra como "Banco oficial" vs el
                        cronograma estimado del motor. Todos los campos son
                        opcionales — préstamos no bancarios no los llenan y
                        la validación del backend es tolerante. */}
                    <section className="flex flex-col gap-3" aria-labelledby="loan-step-bank">
                      <div className="flex items-center justify-between gap-2">
                        <h4
                          id="loan-step-bank"
                          className="text-[10px] font-bold uppercase tracking-[0.3em] text-amber-500"
                        >
                          4 · Datos del banco
                        </h4>
                        <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-zinc-500">
                          Opcional · metadata del contrato
                        </span>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field id="loan-credit-number" label="Número de crédito">
                          <Input
                            id="loan-credit-number"
                            size="sm"
                            placeholder="0013-0021-96-00322102"
                            value={form.creditNumber}
                            onValueChange={(v) => update("creditNumber", v)}
                            startContent={<Hash size={14} className="text-amber-500 shrink-0" />}
                            classNames={INPUT_CLASSES}
                            aria-label="Número de crédito del banco"
                          />
                        </Field>
                        <Field id="loan-type" label="Tipo de crédito">
                          <Select
                            id="loan-type"
                            size="sm"
                            selectedKeys={new Set([form.loanType])}
                            onSelectionChange={(keys) => {
                              const [first] = Array.from(keys);
                              if (first) update("loanType", String(first) as LoanType);
                            }}
                            classNames={SELECT_CLASSES}
                            aria-label="Tipo de crédito"
                          >
                            <SelectItem key="CONSUMO">Consumo</SelectItem>
                            <SelectItem key="HIPOTECARIO">Hipotecario</SelectItem>
                            <SelectItem key="LIBRANZA">Libranza</SelectItem>
                            <SelectItem key="COMERCIAL">Comercial</SelectItem>
                            <SelectItem key="VEHICULO">Vehículo</SelectItem>
                            <SelectItem key="OTRO">Otro</SelectItem>
                          </Select>
                        </Field>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field id="loan-holder-name" label="Titular del crédito">
                          <Input
                            id="loan-holder-name"
                            size="sm"
                            placeholder="Nombre del deudor en el banco"
                            value={form.holderName}
                            onValueChange={(v) => update("holderName", v)}
                            startContent={<User size={14} className="text-amber-500 shrink-0" />}
                            description="Si es distinto al prestamista (ej. persona natural)."
                            classNames={INPUT_CLASSES}
                            aria-label="Nombre del titular del crédito"
                          />
                        </Field>
                        <Field id="loan-holder-dni" label="Documento del titular">
                          <Input
                            id="loan-holder-dni"
                            size="sm"
                            placeholder="Cédula/NIT"
                            value={form.holderDni}
                            onValueChange={(v) => update("holderDni", v)}
                            classNames={INPUT_CLASSES}
                            aria-label="Documento del titular"
                          />
                        </Field>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field id="loan-currency" label="Moneda">
                          <Select
                            id="loan-currency"
                            size="sm"
                            selectedKeys={new Set([form.currency])}
                            onSelectionChange={(keys) => {
                              const [first] = Array.from(keys);
                              if (first) update("currency", String(first) as LoanCurrency);
                            }}
                            classNames={SELECT_CLASSES}
                            aria-label="Moneda del préstamo"
                          >
                            <SelectItem key="COP">COP · Peso colombiano</SelectItem>
                            <SelectItem key="USD">USD · Dólar</SelectItem>
                          </Select>
                        </Field>
                        <Field id="loan-rate-type" label="Tipo de interés">
                          <Select
                            id="loan-rate-type"
                            size="sm"
                            selectedKeys={new Set([form.rateType])}
                            onSelectionChange={(keys) => {
                              const [first] = Array.from(keys);
                              if (first) update("rateType", String(first) as LoanRateType);
                            }}
                            classNames={SELECT_CLASSES}
                            aria-label="Tipo de interés fijo o variable"
                          >
                            <SelectItem key="FIJO">FIJO</SelectItem>
                            <SelectItem key="VARIABLE">VARIABLE</SelectItem>
                          </Select>
                        </Field>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field id="loan-maturity-date" label="Vencimiento final">
                          <Input
                            id="loan-maturity-date"
                            size="sm"
                            type="date"
                            value={form.maturityDate}
                            onValueChange={(v) => update("maturityDate", v)}
                            classNames={INPUT_CLASSES}
                            aria-label="Fecha de vencimiento final del crédito"
                          />
                        </Field>
                        <Field id="loan-late-rate" label="Mora EA (%)">
                          <Input
                            id="loan-late-rate"
                            size="sm"
                            inputMode="decimal"
                            placeholder="0"
                            value={form.lateAnnualEffectiveRatePct}
                            onValueChange={(v) =>
                              update(
                                "lateAnnualEffectiveRatePct",
                                v.replace(/[^0-9.,]/g, ""),
                              )
                            }
                            startContent={<Percent size={14} className="text-amber-500 shrink-0" />}
                            classNames={INPUT_CLASSES}
                            aria-label="Tasa efectiva anual de mora"
                          />
                        </Field>
                      </div>

                      <div
                        className="flex items-start justify-between gap-3 rounded-xl border border-gray-200 bg-white p-3 dark:border-white/10 dark:bg-[#18181b]"
                        role="group"
                        aria-labelledby="loan-auto-debit-title"
                      >
                        <div className="flex items-start gap-2 min-w-0">
                          <Building2 size={16} className="shrink-0 mt-0.5 text-amber-500" />
                          <div className="flex flex-col gap-0.5">
                            <p
                              id="loan-auto-debit-title"
                              className="text-[11px] font-bold uppercase tracking-widest text-zinc-900 dark:text-zinc-50"
                            >
                              Pago automático (débito)
                            </p>
                            <p className="text-[10px] font-medium leading-tight text-gray-500 dark:text-zinc-400">
                              El banco debita la cuota de la cuenta de origen sin acción manual.
                            </p>
                          </div>
                        </div>
                        <Switch
                          size="sm"
                          color="warning"
                          checked={form.autoDebit}
                          onCheckedChange={(checked) => update("autoDebit", checked)}
                          aria-label="Pago automático activo"
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <Field id="loan-net-disbursement" label="Neto desembolsado (COP)">
                          <Input
                            id="loan-net-disbursement"
                            size="sm"
                            inputMode="numeric"
                            placeholder="25.000.000"
                            value={form.netDisbursementAmount}
                            onValueChange={(v) =>
                              update("netDisbursementAmount", formatInputCOP(v))
                            }
                            startContent={<Banknote size={14} className="text-amber-500 shrink-0" />}
                            description="Dinero realmente abonado en cuenta (antes del FGA)."
                            classNames={INPUT_CLASSES}
                            aria-label="Neto desembolsado"
                          />
                        </Field>
                        <Field id="loan-fga-iva" label="IVA del FGA (COP)">
                          <Input
                            id="loan-fga-iva"
                            size="sm"
                            inputMode="numeric"
                            placeholder="47.500"
                            value={form.fgaIvaAmount}
                            onValueChange={(v) => update("fgaIvaAmount", formatInputCOP(v))}
                            startContent={<Shield size={14} className="text-amber-500 shrink-0" />}
                            classNames={INPUT_CLASSES}
                            aria-label="IVA del FGA"
                          />
                        </Field>
                        <Field id="loan-fga-gmf" label="GMF del FGA (COP)">
                          <Input
                            id="loan-fga-gmf"
                            size="sm"
                            inputMode="numeric"
                            placeholder="1.190"
                            value={form.fgaGmfAmount}
                            onValueChange={(v) => update("fgaGmfAmount", formatInputCOP(v))}
                            startContent={<Shield size={14} className="text-amber-500 shrink-0" />}
                            classNames={INPUT_CLASSES}
                            aria-label="GMF del FGA"
                          />
                        </Field>
                      </div>
                    </section>

                    <Divider />

                    {/* PASO 5 · SNAPSHOT BANCO
                        Datos autoritativos del extracto: NO modifican el saldo
                        contable interno (remainingBalance) ni el cronograma.
                        Se muestran en el detalle como "Banco oficial" al lado
                        del cronograma estimado para que las discrepancias
                        queden siempre visibles. */}
                    <section className="flex flex-col gap-3" aria-labelledby="loan-step-snapshot">
                      <div className="flex items-center justify-between gap-2">
                        <h4
                          id="loan-step-snapshot"
                          className="text-[10px] font-bold uppercase tracking-[0.3em] text-amber-500"
                        >
                          5 · Snapshot banco (dato autoritativo)
                        </h4>
                        <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-zinc-500">
                          Nunca ajusta el saldo contable
                        </span>
                      </div>

                      <div
                        className="flex items-start gap-2 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 text-[10px] font-medium leading-tight text-sky-700 dark:text-sky-300"
                        role="note"
                      >
                        <AlertCircle size={14} className="shrink-0 mt-0.5" aria-hidden />
                        <p>
                          <strong>Banco oficial vs Cronograma estimado:</strong> estos valores
                          se muestran lado a lado en el detalle del préstamo; el POS nunca
                          modifica tasa, cuotas ni saldo para "cuadrar" el delta.
                        </p>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field id="loan-bank-balance" label="Saldo bancario (COP)">
                          <Input
                            id="loan-bank-balance"
                            size="sm"
                            inputMode="numeric"
                            placeholder="25.326.046"
                            value={form.bankBalanceAmount}
                            onValueChange={(v) =>
                              update("bankBalanceAmount", formatInputCOP(v))
                            }
                            startContent={
                              <Landmark size={14} className="text-amber-500 shrink-0" />
                            }
                            classNames={INPUT_CLASSES}
                            aria-label="Saldo bancario"
                          />
                        </Field>
                        <Field id="loan-bank-balance-asof" label="Fecha de corte">
                          <Input
                            id="loan-bank-balance-asof"
                            size="sm"
                            type="datetime-local"
                            value={form.bankBalanceAsOf}
                            onValueChange={(v) => update("bankBalanceAsOf", v)}
                            classNames={INPUT_CLASSES}
                            aria-label="Fecha y hora de la consulta del saldo bancario"
                          />
                        </Field>
                      </div>

                      <Field id="loan-bank-paid" label="Saldo pagado al banco (COP)">
                        <Input
                          id="loan-bank-paid"
                          size="sm"
                          inputMode="numeric"
                          placeholder="0"
                          value={form.bankPaidAmount}
                          onValueChange={(v) =>
                            update("bankPaidAmount", formatInputCOP(v))
                          }
                          startContent={
                            <CheckCircle2 size={14} className="text-amber-500 shrink-0" />
                          }
                          description="Lo que el banco reporta como pagado hasta la fecha de corte."
                          classNames={INPUT_CLASSES}
                          aria-label="Saldo pagado al banco"
                        />
                      </Field>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field
                          id="loan-official-amount"
                          label="Próxima cuota oficial (COP)"
                        >
                          <Input
                            id="loan-official-amount"
                            size="sm"
                            inputMode="numeric"
                            placeholder="693.951"
                            value={form.officialNextInstallmentAmount}
                            onValueChange={(v) =>
                              update("officialNextInstallmentAmount", formatInputCOP(v))
                            }
                            startContent={
                              <Banknote size={14} className="text-amber-500 shrink-0" />
                            }
                            classNames={INPUT_CLASSES}
                            aria-label="Monto de la próxima cuota oficial del banco"
                          />
                        </Field>
                        <Field id="loan-official-date" label="Próximo vencimiento">
                          <Input
                            id="loan-official-date"
                            size="sm"
                            type="date"
                            value={form.officialNextInstallmentDate}
                            onValueChange={(v) =>
                              update("officialNextInstallmentDate", v)
                            }
                            startContent={
                              <CalendarDays size={14} className="text-amber-500 shrink-0" />
                            }
                            classNames={INPUT_CLASSES}
                            aria-label="Fecha de la próxima cuota oficial del banco"
                          />
                        </Field>
                      </div>
                    </section>
                  </form>

                  {/* ---------- PREVIEW ---------- */}
                  <aside
                    className="flex min-w-0 flex-col gap-3 lg:col-span-2 bg-gray-50 dark:bg-[#121214] rounded-2xl p-4 border border-gray-200 dark:border-white/10 min-h-[320px]"
                    aria-label="Vista previa del cronograma de amortización"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Calculator size={16} className="text-amber-500" />
                        <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-900 dark:text-zinc-50">
                          Cronograma estimado
                        </h3>
                      </div>
                      <div className="flex items-center gap-2">
                        {previewLoading && <Spinner size="sm" color="warning" />}
                        <Chip
                          size="sm"
                          variant="flat"
                          color={previewSource === "server" ? "success" : previewSource === "local" ? "warning" : "default"}
                          classNames={{ base: "h-5 text-[9px] font-bold uppercase tracking-widest" }}
                        >
                          {previewSource === "server" ? "Backend" : previewSource === "local" ? "Local" : "—"}
                        </Chip>
                      </div>
                    </div>

                    {preview && preview.error ? (
                      <div
                        role="alert"
                        className="flex items-center gap-2 rounded-2xl border border-rose-500/40 bg-rose-500/10 p-3 text-[11px] font-medium text-rose-500"
                      >
                        <AlertCircle size={16} />
                        Datos insuficientes para calcular el cronograma. Revisa monto, cuotas y tasa.
                      </div>
                    ) : !preview ? (
                      <div className="flex items-center gap-2 rounded-2xl border border-dashed border-gray-300 dark:border-white/10 p-4 text-[11px] font-medium text-gray-500 dark:text-zinc-400">
                        <Sparkles size={16} className="text-amber-500 shrink-0" />
                        Llena el monto, tasa y número de cuotas para ver el cronograma.
                      </div>
                    ) : (
                      <>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <SummaryCell label="Principal" value={formatLoanMoney(totals?.principal)} />
                          <SummaryCell
                            label={
                              form.interestMode === INTEREST_MODES.FRENCH
                                ? "Interés total"
                                : "Interés total flat"
                            }
                            value={formatLoanMoney(totals?.interest)}
                            tone="amber"
                          />
                          <SummaryCell
                            label="Total a pagar"
                            value={formatLoanMoney(displayTotalToPay)}
                            tone="emerald"
                          />
                        </div>

                        {isFrenchMode && (
                          <>
                            {/* Fila 1 Francés: tasa M.V. + cuota base */}
                            <div
                              className="grid grid-cols-1 sm:grid-cols-2 gap-2"
                              aria-label="Desglose del Sistema Francés"
                            >
                              <SummaryCell
                                label="Tasa M.V."
                                value={
                                  totals && totals.monthlyRatePct !== undefined
                                    ? `${(totals.monthlyRatePct as number).toFixed(4)}%`
                                    : "—"
                                }
                                tone="sky"
                              />
                              <SummaryCell
                                label="Cuota base (capital + interés)"
                                value={formatLoanMoney(frenchView?.baseInstallment)}
                                tone="sky"
                              />
                            </div>
                            {/* Fila 2 Francés: cargos mensuales + cuota final */}
                            <div
                              className="grid grid-cols-1 sm:grid-cols-2 gap-2"
                              aria-label="Componentes mensuales"
                            >
                              <SummaryCell
                                label="Seguros y otros cargos / mes"
                                value={formatLoanMoney(frenchView?.monthlyCharges)}
                                tone="amber"
                              />
                              <SummaryCell
                                label="Cuota mensual final"
                                value={formatLoanMoney(frenchView?.finalMonthly)}
                                tone="emerald"
                              />
                            </div>
                          </>
                        )}

                        <Divider className="my-1" />

                        <ScrollShadow className="flex-1 max-h-[280px] md:max-h-[42vh]">
                          <table
                            className="w-full text-left text-[11px] tabular-nums"
                            aria-label="Tabla del cronograma de amortización"
                          >
                            <thead className="sticky top-0 z-10 bg-gray-50 dark:bg-[#121214]">
                              <tr className="border-b border-gray-200 dark:border-white/10 text-[9px] uppercase tracking-widest text-gray-500 dark:text-zinc-500">
                                <th scope="col" className="py-2 px-2">N°</th>
                                <th scope="col" className="py-2 px-2">Vence</th>
                                <th scope="col" className="hidden py-2 px-2 text-right lg:table-cell">Capital</th>
                                <th scope="col" className="hidden py-2 px-2 text-right lg:table-cell">Interés</th>
                                <th scope="col" className="py-2 px-2 text-right">Cuota</th>
                                {isFrenchMode && (
                                  <th scope="col" className="hidden py-2 px-2 text-right sm:table-cell">Saldo</th>
                                )}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200 dark:divide-white/5">
                              {preview.installments.map((it) => (
                                <tr key={it.number} className="hover:bg-amber-500/5">
                                  <td className="py-1.5 px-2 font-bold text-gray-500 dark:text-zinc-400">
                                    {it.number}
                                  </td>
                                  <td className="py-1.5 px-2 font-medium">
                                    {it.dueDate ?? "—"}
                                    {/* Capital/Interés compactos en viewport angosto. */}
                                    <span className="mt-0.5 block text-[9px] font-medium text-gray-400 dark:text-zinc-500 lg:hidden">
                                      Cap {formatLoanMoney(it.principalDue)} ·{" "}
                                      <span className="text-amber-500">
                                        Int {formatLoanMoney(it.interestDue)}
                                      </span>
                                      {(Number(it.insuranceDue) > 0 || Number(it.fgaDue) > 0) && (
                                        <>
                                          {" · "}
                                          <span className="text-sky-500">
                                            Cargos {formatLoanMoney(Number(it.insuranceDue) + Number(it.fgaDue))}
                                          </span>
                                        </>
                                      )}
                                      {it.balance !== undefined && (
                                        <span className="sm:hidden"> · Saldo {formatLoanMoney(it.balance)}</span>
                                      )}
                                    </span>
                                  </td>
                                  <td className="hidden py-1.5 px-2 text-right lg:table-cell">
                                    {formatLoanMoney(it.principalDue)}
                                  </td>
                                  <td className="hidden py-1.5 px-2 text-right text-amber-500 lg:table-cell">
                                    {formatLoanMoney(it.interestDue)}
                                    {(Number(it.insuranceDue) > 0 || Number(it.fgaDue) > 0) && (
                                      <span className="block text-[9px] text-sky-500">
                                        +{formatLoanMoney(Number(it.insuranceDue) + Number(it.fgaDue))} cargos
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-1.5 px-2 text-right font-bold text-zinc-900 dark:text-zinc-50">
                                    {formatLoanMoney(it.totalDue)}
                                  </td>
                                  {isFrenchMode && (
                                    <td className="hidden py-1.5 px-2 text-right text-gray-500 dark:text-zinc-400 sm:table-cell">
                                      {it.balance !== undefined ? formatLoanMoney(it.balance) : "—"}
                                    </td>
                                  )}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </ScrollShadow>
                      </>
                    )}
                  </aside>
                </div>
              </div>
            </ModalBody>

            {/* FOOTER APILADO EN MÓVIL · HORIZONTAL EN SM+ */}
            <ModalFooter className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col text-[11px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-400">
                <span>Total a pagar</span>
                <span className="text-xl sm:text-2xl font-bold text-amber-500 tabular-nums">
                  {formatLoanMoney(displayTotalToPay)}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-col sm:flex-row w-full sm:w-auto">
                <Button
                  variant="light"
                  onPress={onClose}
                  className="font-semibold uppercase w-full sm:w-auto"
                >
                  Cancelar
                </Button>
                <Button
                  isLoading={submitting}
                  isDisabled={!canSubmit}
                  onPress={handleSubmit}
                  className="rounded-xl bg-amber-500 px-6 font-bold uppercase tracking-wide text-white w-full sm:w-auto"
                >
                  {mode === "edit" ? "Guardar cambios" : "Registrar préstamo"}
                </Button>
              </div>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

interface SummaryCellProps {
  label: string;
  value: string;
  tone?: "amber" | "emerald" | "sky" | "neutral";
}

function SummaryCell({ label, value, tone = "neutral" }: SummaryCellProps) {
  const toneClass =
    tone === "amber"
      ? "text-amber-500"
      : tone === "emerald"
      ? "text-emerald-500"
      : tone === "sky"
      ? "text-sky-500"
      : "text-zinc-900 dark:text-zinc-50";
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-white dark:bg-[#18181b] p-2.5 border border-gray-200 dark:border-white/10">
      <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
        {label}
      </span>
      <span className={`text-sm font-bold tabular-nums tracking-tight ${toneClass}`}>{value}</span>
    </div>
  );
}
