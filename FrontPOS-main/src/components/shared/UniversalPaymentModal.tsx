"use client";

import { useState, useEffect, useCallback, useRef, useMemo, ReactNode } from "react";
import {
  Modal, ModalContent, Button, Avatar
} from "@heroui/react";
import { Switch } from "@/components/ui/switch";
import {
  Banknote, Zap, Check, Wallet, ArrowRight, X,
  Calculator, ShieldCheck, TrendingUp, Grid3X3, Users, AlertTriangle,
  Printer, Send, MessageCircle, Trash2, QrCode
} from 'lucide-react';
import { Customer } from '@/lib/definitions';
import { formatCurrency } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-error";
import { API_URL } from "@/lib/constants";
import { getSessionToken } from "@/lib/session";
import { useAuth } from "@/lib/auth";
import ModalPagoBoldQR from "@/components/shared/ModalPagoBoldQR";
import { BOLD_QR_ALREADY_PAID_SENTINEL, BOLD_QR_METHOD_LABEL } from "@/lib/bold-qr-helpers.mjs";
import {
  type TicketData,
  DIRECT_PRINT_UNAVAILABLE,
  formatDateTime,
  getAutoPrint as readAutoPrint,
  hasPosBridgePrint,
  printThermalTicket,
  printThermalTicketDirect,
  saleToTicket,
  sendTicketImageToTelegram,
  setAutoPrint as persistAutoPrint,
  shareTicketImage,
} from "@/lib/thermal-ticket";
import { loadPrintingConfig, RECEIPT_DELIVERY_MODES, DRAWER_EVENTS } from "@/lib/printing-config.mjs";

/* ============================================================================
 * TIPOGRAFÍA — REGLA DE ORO PARA UNA CAJA REGISTRADORA
 * Etiquetas   >= 11px   (uppercase tracking-wider)
 * Datos       >= 13px   (tabular-nums)
 * Dinero KPI  >= 24px md:30px  (tabular-nums tracking-tight)
 * Dinero HERO >= 30px md:48px  (tabular-nums tracking-tight)
 * Un solo tracking por elemento (nunca 'tracking-tight tracking-tighter').
 * ========================================================================== */

interface UniversalPaymentModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  client: Customer | null;
  totalToPay: number; // Total de la venta o total de la deuda
  initialPaidAmounts?: {
    cash: number;
    transfer: number;
    transferSource: string;
    credit: number;
    // Shape extendido: cuando viene desde el historial corregido, el helper
    // `initialPaidAmountsFromSale` entrega Nequi y Daviplata por separado
    // para que el modal precargue ambos canales sin que el cajero tenga
    // que redigitar los montos. Los campos legacy `transfer` y
    // `transferSource` se mantienen para los consumidores que todavia
    // mandan la suma colapsada (p.ej. abonos, egresos).
    nequi?: number;
    daviplata?: number;
    otherTransfer?: number;
    otherTransferSource?: string;
  };
  showSuccessScreen: boolean;
  submittingPayment: boolean;
  lastChange: number;
  lastReceipt?: any;
  onPay: (data: {
    cash: number;
    transfer: number;
    transferSource: string;
    /**
     * Desglose de la transferencia por canal. Se propagan por separado ademas
     * de `transfer` (total) para que el cuadre del turno pueda conciliar
     * contra los saldos reales de Nequi y Daviplata cuando el cliente paga
     * mitad y mitad. `transfer` sigue siendo la suma para no romper a los
     * consumidores existentes.
     */
    transferNequi?: number;
    transferDaviplata?: number;
    credit: number;
    totalPaid: number;
    change: number;
  }) => Promise<void>;
  onCloseComplete?: () => void;
  showCreditTab?: boolean;
  flowType?: "in" | "out";
  reason?: string;
  onReasonChange?: (reason: string) => void;
  isAbono?: boolean;
  isRefund?: boolean;
  onClientSelectorOpen?: () => void;
  pendingReturnAmount?: number;
  originalPaymentMethod?: string;
  /**
   * Se dispara cuando el cajero elige "QR Bold / Bre-B" en la grilla de
   * métodos. Firma `(amount, ventaTempId)` — el UPM genera el
   * `ventaTempId` *antes* de abrir el modal hijo para que el padre
   * pueda pre-registrar un snapshot durable del carrito con ese
   * identificador exacto (migración 027 — snapshot al abrir, no al
   * encolar).
   *
   * El callback **puede devolver `Promise<void>`**: si lo hace, el UPM
   * espera a que resuelva antes de abrir `ModalPagoBoldQR`. Si el
   * callback lanza, el UPM NO abre el modal hijo y muestra un toast
   * explicativo (sin tocar el carrito ni los canales ya acumulados).
   *
   * Si el padre no provee este callback, el tab QR queda deshabilitado
   * silenciosamente (back-compat: consumidores legacy no se enteran
   * del método nuevo).
   *
   * Contrato:
   *   - El callback NO cierra el UniversalPaymentModal; el padre decide
   *     cerrarlo cuando la aprobación del QR dispara el flujo normal
   *     `onPay({ cash:0, transfer: effectiveTotal, transferSource: 'BOLD_QR', ... })`.
   *   - El QR es ESTÁTICO: no acepta montos parciales. Por eso el tab
   *     deshabilita el numpad de montos parciales (no se muestra el
   *     panel de cash/NEQUI/DAVIPLATA cuando activePaymentTab === 'BOLD_QR').
   *   - El `ventaTempId` que recibe el callback es EXACTAMENTE el mismo
   *     que luego se pasa a `onBoldQrEnqueueRequested`, para que el
   *     backend reutilice (reused=true) la intención pre-registrada.
   */
  onBoldQrRequested?: (amount: number, ventaTempId: string) => void | Promise<void>;
  /**
   * Flujo asíncrono QR (migración 027). Si el padre lo provee, el modal
   * `ModalPagoBoldQR` muestra el botón primario "DEJAR EN ESPERA Y
   * SEGUIR ATENDIENDO". El callback debe:
   *   1. Construir el snapshot del carrito con `clientTxId` fresco.
   *   2. POST /api/pos/pagos-qr/encolar y esperar 200.
   *   3. Al éxito, llamar `useNewSale.confirmEnqueuedAndFreeCart()` para
   *      liberar SÓLO el carrito activo y abrir uno limpio.
   * Al fallo debe lanzar una excepción con mensaje legible para que el
   * modal pinte el estado ERROR sin tocar el carrito.
   *
   * **Contrato exacto (migración 027)**: el callback recibe
   * `(ventaTempId, monto)` tomados de las props del modal hijo. El
   * padre NUNCA debe regenerar el `ventaTempId` ni recalcular el
   * `monto`: usar los valores exactos recibidos evita que la bandeja
   * global termine con dos pendientes por el mismo monto.
   *
   * Si el callback no se provee, el botón queda deshabilitado y el
   * modal se comporta como el flujo sincrónico heredado (el cajero
   * espera frente al QR).
   */
  onBoldQrEnqueueRequested?: (ventaTempId: string, monto: number) => Promise<void>;
  /**
   * Solicitud de REAPERTURA de un cobro QR ya encolado. Shape canónico
   * `{ ventaTempId, monto }` tomado literalmente del pending (bandeja).
   * Contrato de **un solo uso**:
   *
   *   - El padre `/sales/new/page.tsx` setea el payload cuando el cajero
   *     pulsa "Reabrir QR" en la bandeja y abre el UPM.
   *   - El UPM detecta el payload presente al abrir, abre el modal QR
   *     hijo con ESOS valores exactos (sin regenerar nada) y dispara
   *     `onBoldQrReopenConsumed()` para que el padre LIMPIE el payload
   *     a `null` inmediatamente.
   *   - Si el padre NO limpia (consumidor legacy), el UPM igual
   *     garantiza que el mismo payload no se reconsuma: cada apertura
   *     requiere un payload fresco; nunca se reabre el QR al reabrir
   *     el UPM.
   *
   * Sin este payload el QR **NUNCA** se abre automáticamente al abrir
   * el UPM; el cajero debe pulsar "QR Bold / Bre-B" explícitamente.
   * Esta regla cierra el bug observado en 2026-10-23 (el modal reabría
   * un QR pagado al abrir cobros de otra cuenta).
   */
  boldQrReopenPayload?: { readonly ventaTempId: string; readonly monto: number } | null;
  /**
   * Callback que el UPM dispara EXACTAMENTE UNA VEZ al consumir un
   * `boldQrReopenPayload`. El padre debe reaccionar poniendo el payload
   * a `null` (y cualquier estado derivado) para evitar que el payload
   * sobreviva al cierre del UPM y se reconsuma al abrir otra cuenta.
   */
  onBoldQrReopenConsumed?: () => void;
  /**
   * Callback explícito del flujo APROBADO con `saleId > 0` (migración
   * 027, DispatchAutoSale post-commit). Se dispara EXACTAMENTE UNA
   * VEZ por intención cuando el backend emite el frame SSE
   * `qr_intent_update` con status=APROBADO + saleId positivo.
   *
   * **Contrato duro**:
   *   - Al recibir APROBADO con `saleId > 0`, el UPM **NO llama
   *     `onPay`**: eso regeneraría un `clientTxId` fresco en
   *     `handleConfirmSale` y crearía una SEGUNDA venta en
   *     `/sales/register`, duplicando el stock. La venta ya existe
   *     canónicamente en el backend (`SaleService.CreateSale` +
   *     `MarkFinalizationSucceeded` vinculó `related_sale_id`).
   *   - El UPM invoca `onBoldQrFinalized` con el `ventaTempId` que
   *     generó al abrir el modal + el `saleId` del backend + los
   *     metadatos del frame SSE. El padre `/sales/new/page.tsx`
   *     deduplica contra la bandeja global (`useBoldQrTray`) con un
   *     Set compartido por `ventaTempId`/`saleId` para no mostrar dos
   *     alertas ni limpiar dos carritos.
   *   - El padre es responsable de cerrar el UPM
   *     (`onOpenChange(false)`), borrar la preparación guardada en
   *     `qrPreparationsRef` y liberar SOLO el carrito actual vía
   *     `confirmEnqueuedAndFreeCart`. El UPM garantiza idempotencia
   *     interna con `isProcessingRef` + el guard
   *     `approvedFiredRef` del modal hijo.
   *   - Si APROBADO llega **sin** `saleId > 0`, el UPM muestra una
   *     alerta UX "Esperando conciliación" y **nunca** llama a
   *     `onPay` automáticamente — el backend reconciliará con el
   *     bridge/webhook y la bandeja global.
   *
   * El flujo heredado donde la aprobación QR disparaba un POST
   * `/sales/register` desde el frontend quedó aislado: ya no vive
   * como fallback de este modal.
   */
  onBoldQrFinalized?: (info: {
    readonly ventaTempId: string;
    readonly saleId: number;
    readonly amountCop?: number;
    readonly reference?: string;
    readonly approvedAt?: string;
    readonly approvedVia?: string;
  }) => void;
}

/* ---------------------------------------------------------------------------
 * Sub-componentes de presentación (mismo archivo para no dispersar la lógica).
 * Ninguno toca math ni callbacks; solo pintan.
 * ------------------------------------------------------------------------- */

interface SummaryTileProps {
  label: string;
  icon: ReactNode;
  value: number;
  valueClassName?: string;
  containerClassName?: string;
  prefix?: string;
}

function SummaryTile({ label, icon, value, valueClassName = "", containerClassName = "", prefix = "$" }: SummaryTileProps) {
  return (
    <div className={`bg-white dark:bg-[#18181b] px-3 py-2 md:px-4 md:py-3 rounded-2xl border shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col justify-center min-w-0 ${containerClassName}`}>
      <p className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 leading-none mb-1.5">
        {icon}
        <span className="truncate">{label}</span>
      </p>
      <p className={`text-xl md:text-3xl font-semibold tabular-nums tracking-tight leading-none truncate ${valueClassName}`} title={`${prefix}${formatCurrency(value)}`}>
        {prefix}{formatCurrency(value)}
      </p>
    </div>
  );
}

interface AccumulatedPillProps {
  label: string;
  icon: ReactNode;
  amount: number;
  colorClass: string;
  bgClass: string;
  borderClass: string;
}

function AccumulatedPill({ label, icon, amount, colorClass, bgClass, borderClass }: AccumulatedPillProps) {
  return (
    <div className={`px-3 py-1.5 ${bgClass} border ${borderClass} rounded-xl flex items-center gap-2`} title={`${label}: $${formatCurrency(amount)}`}>
      {icon}
      <span className={`text-[13px] font-semibold ${colorClass} tabular-nums leading-none`}>
        ${formatCurrency(amount)}
      </span>
    </div>
  );
}

interface NumpadKeyProps {
  value: string | number;
  onPress: () => void;
  variant?: "digit" | "clear" | "add";
  fullHeight?: boolean;
  themeBgClass?: string;
  size?: "compact" | "tall";
}

function NumpadKey({ value, onPress, variant = "digit", fullHeight = false, themeBgClass = "", size }: NumpadKeyProps) {
  const base = "font-semibold rounded-2xl transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-emerald-500/60";
  // Tamaños UNIFICADOS. Antes había 3 variantes visuales (h-12 text-lg móvil
  // cash, h-12 text-lg móvil no-cash, h-full text-2xl desktop fullHeight);
  // ahora se consolidan en dos: `compact` (móvil, h-12 text-lg) y `tall`
  // (desktop, h-14 text-xl). `fullHeight` queda como alias legacy para la
  // forma antigua que estiraba al alto del contenedor; evitamos usarlo en
  // los nuevos renders para mantener alturas constantes al cambiar de tab
  // y evitar que el pad desktop se "achate" según el contenido del centro.
  const resolvedSize = size ?? (fullHeight ? "legacy-full" : "compact");
  const sizing =
    resolvedSize === "tall"
      ? "h-14 text-xl"
      : resolvedSize === "legacy-full"
        ? "h-full text-2xl"
        : "h-12 text-lg";
  const tone =
    variant === "clear"
      ? "text-rose-500 bg-rose-500/10 border border-rose-500/20 hover:bg-rose-500/20 active:bg-rose-500/25 shadow-sm"
      : variant === "add"
        ? `${themeBgClass} text-white border border-transparent shadow-md hover:brightness-110`
        : "bg-white dark:bg-zinc-800 text-gray-900 dark:text-white border border-gray-200 dark:border-white/5 hover:bg-gray-50 dark:hover:bg-zinc-700/70 active:bg-gray-200 dark:active:bg-zinc-700 shadow-sm";
  return (
    <Button
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      className={`${base} ${sizing} ${tone}`}
      onPress={() => {
        onPress();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }}
    >
      {value}
    </Button>
  );
}

/* ---------------------------------------------------------------------------
 * PaymentKeypad — teclado numérico ÚNICO del modal de cobro.
 *
 * Antes del sprint 2026-10 había tres numpads inline con proporciones
 * distintas (dos móviles con `h-12 text-lg` y un desktop con `h-full
 * text-2xl`). Lo que al cajero le parecía "duplicado" era en realidad el
 * mismo teclado reescrito tres veces, con alturas distintas y el flip
 * cash↔billetes acentuando la inconsistencia.
 *
 * Ahora PaymentKeypad centraliza la grilla 4×3 con el array canónico
 * `[1..9, 0, '+', 'CE']` y una variante de tamaño (`compact` para móvil,
 * `tall` para el pad fijo de escritorio). Se renderiza en dos lugares
 * del árbol:
 *   - Móvil (`md:hidden`): se usa en el flujo cash y en los tabs digitales,
 *     siempre con la misma proporción y jerarquía visual.
 *   - Desktop (`hidden md:flex`): vive en el pad derecho, con el mismo
 *     componente pero `size="tall"` para igualar la densidad táctil.
 *
 * Reglas duras del componente:
 *   - NO toca `dialogAmount` directamente: expone callbacks puros
 *     (`onDigit`, `onAdd`, `onClear`) y deja la decisión al padre.
 *   - NO roba foco al input (los `NumpadKey` ya traen tabIndex={-1} +
 *     onMouseDown.preventDefault).
 *   - MANTIENE el array canónico (dígitos 1-9, 0, '+', 'CE')
 *     dentro de su cuerpo. El guardián `payment-combined-ui.test.mjs`
 *     verifica que el `+` siga alcanzable tanto en móvil como en
 *     escritorio (dos renders del PaymentKeypad en el DOM).
 * ------------------------------------------------------------------------- */

interface PaymentKeypadProps {
  size: "compact" | "tall";
  themeBgClass: string;
  onDigit: (digit: string) => void;
  onAdd: () => void;
  onClear: () => void;
  gapClassName?: string;
  containerClassName?: string;
  /**
   * Si es true, el contenedor usa `flex-1` para ocupar el alto disponible.
   * Útil para el pad desktop fijo. En móvil siempre va `false` para
   * respetar la altura compacta del keypad.
   */
  stretchVertical?: boolean;
  ariaLabel?: string;
}

function PaymentKeypad({
  size,
  themeBgClass,
  onDigit,
  onAdd,
  onClear,
  gapClassName,
  containerClassName,
  stretchVertical = false,
  ariaLabel = "Teclado numérico de monto",
}: PaymentKeypadProps) {
  const gap = gapClassName ?? (size === "tall" ? "gap-3" : "gap-2");
  const stretch = stretchVertical ? "flex-1" : "";
  // Array canónico del numpad. La forma 4 filas × 3 columnas con `+` en
  // la fila final permite acumular canales en pagos mixtos sin salir del
  // teclado. Mantener el literal explícito también sirve de ancla para
  // el guardián `payment-combined-ui.test.mjs`.
  const keys: ReadonlyArray<string | number> = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, "+", "CE"];
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`grid grid-cols-3 ${gap} ${stretch} ${containerClassName ?? ""}`.trim()}
    >
      {keys.map((n) => (
        <NumpadKey
          key={n}
          value={n}
          size={size}
          variant={n === "CE" ? "clear" : n === "+" ? "add" : "digit"}
          themeBgClass={themeBgClass}
          onPress={() => {
            if (n === "CE") onClear();
            else if (n === "+") onAdd();
            else onDigit(String(n));
          }}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Componente principal
 * ------------------------------------------------------------------------- */

export default function UniversalPaymentModal({
  isOpen,
  onOpenChange,
  title = "Gestion de Pagos",
  client,
  totalToPay,
  initialPaidAmounts,
  showSuccessScreen,
  submittingPayment,
  lastChange,
  lastReceipt,
  onPay,
  onCloseComplete,
  showCreditTab = true,
  flowType = "in",
  reason,
  onReasonChange,
  isAbono = false,
  isRefund = false,
  onClientSelectorOpen,
  pendingReturnAmount = 0,
  originalPaymentMethod = "EFECTIVO",
  onBoldQrRequested,
  onBoldQrEnqueueRequested,
  boldQrReopenPayload,
  onBoldQrReopenConsumed,
  onBoldQrFinalized,
}: UniversalPaymentModalProps) {

  const netExchangeBalance = totalToPay - (pendingReturnAmount || 0);
  const isReturnExchange = (pendingReturnAmount || 0) > 0;
  const isTransferReturn = isReturnExchange && !!originalPaymentMethod && (originalPaymentMethod.toUpperCase() !== 'EFECTIVO' && originalPaymentMethod.toUpperCase() !== 'CAJA');
  const isBlockedTransferRefund = isTransferReturn && netExchangeBalance < 0;
  const baseReturnRefund = isReturnExchange && netExchangeBalance < 0 && !isTransferReturn ? Math.abs(netExchangeBalance) : 0;
  const effectiveTotal = isReturnExchange ? Math.max(0, netExchangeBalance) : totalToPay;

  const isProcessingRef = useRef(false);
  const [activePaymentTab, setActivePaymentTab] = useState<'cash' | 'NEQUI' | 'DAVIPLATA' | 'credit'>('cash');
  const [isMobileNumpadOpen, setIsMobileNumpadOpen] = useState(false);
  const [dialogAmount, setDialogAmount] = useState('');
  const [cashTendered, setCashTendered] = useState<string>('');

  // --- QR Bold / Bre-B (cobro real) ---
  //
  // El modal ModalPagoBoldQR vive encapsulado aquí para que el cajero no
  // tenga que salir del cobro, elegir un flujo paralelo o cambiar de
  // página. Reglas duras del integración:
  //   - El trigger `handleOpenBoldQr` sólo abre el modal cuando queda
  //     saldo pendiente real (`remainingDebt > 0`) y no es flujo de salida
  //     (reembolsos / egresos no admiten QR entrante).
  //   - El trigger NUNCA fuerza el total: usamos exactamente lo que falta
  //     por cubrir (`remainingDebt`), para que el cajero pueda cobrar
  //     parcialmente en efectivo y el resto por QR si así lo decide.
  //   - La aprobación dispara `processPayment` UNA sola vez tras aplicar
  //     el canal `BOLD_QR` como transferencia; la guarda interna
  //     `isProcessingRef` sigue vigente para prevenir doble envío.
  //   - No se expone BOLD_BRIDGE_TOKEN ni BOLD_SECRET_KEY: la lectura de
  //     `cajaId` (DNI del cajero) viene de `useAuth`.
  const [isBoldQrOpen, setIsBoldQrOpen] = useState(false);
  // QR abierto desde "Reabrir QR" de la bandeja (cobro ya en espera, con
  // su carrito guardado en el servidor). Nunca se encola ni se cancela
  // desde aquí, y cerrar devuelve al cajero a la venta que registraba.
  const [isBoldQrReopen, setIsBoldQrReopen] = useState(false);
  const [boldQrAmount, setBoldQrAmount] = useState(0);
  const boldSessionIdRef = useRef<string>("");
  const boldApprovedPayloadRef = useRef<{ cash: number; transfer: number; transferSource: string; transferNequi: number; transferDaviplata: number; credit: number; totalPaid: number; change: number } | null>(null);
  const { user } = useAuth();
  // `toast` se hoistea aquí porque `handleOpenBoldQr` lo captura en sus
  // dependencias (TDZ con `const` destructurado si lo declaramos más
  // abajo). Antes vivía justo antes de los helpers de impresión; moverlo
  // no cambia su valor runtime pero evita el ReferenceError que apareció
  // al añadir el camino asíncrono de preparación QR.
  const { toast } = useToast();

  // Clases estaticas para evitar problemas con el purgado de Tailwind y errores de referencia
  const isOut = flowType === "out";
  const theme = {
    bg: isOut ? "bg-rose-500" : "bg-gray-100 dark:bg-zinc-800 border border-black/5 dark:border-white/5",
    bgLight: isOut ? "bg-rose-500/10" : "bg-black/5 dark:bg-white/5",
    bgHover: isOut ? "hover:bg-rose-500/10" : "hover:bg-black/5 dark:hover:bg-white/5",
    text: isOut ? "text-rose-500" : "text-zinc-100",
    textDark: isOut ? "text-rose-600" : "text-zinc-100",
    border: isOut ? "border-rose-500" : "border-emerald-500",
    borderLight: isOut ? "border-rose-500/20" : "border-emerald-500/20",
    shadow: isOut ? "shadow-rose-500/30" : "",
    ring: isOut ? "ring-rose-500" : "ring-emerald-500"
  };

  const themeColor = isOut ? 'rose' : 'emerald';

  // Estados internos para pagos acumulados (mixtos)
  const [cashPaid, setCashPaid] = useState<number>(0);
  const [nequiPaid, setNequiPaid] = useState<number>(0);
  const [daviplataPaid, setDaviplataPaid] = useState<number>(0);
  const [creditPaid, setCreditPaid] = useState<number>(0);

  const [isReady, setIsReady] = useState(false);

  // Inicializar estados cuando se abre el modal
  useEffect(() => {
    if (isOpen) {
      // Nuevo shape (desde `initialPaidAmountsFromSale` del historial): trae
      // Nequi y Daviplata por SEPARADO para que la correccion de una venta
      // mixta precargue ambos canales sin colapsar. Si solo esta el shape
      // legacy (`transfer` + `transferSource` singular), caemos a el para no
      // romper a los consumidores viejos (abonos, egresos, caja).
      const presetNequi = typeof initialPaidAmounts?.nequi === "number"
        ? initialPaidAmounts.nequi
        : (initialPaidAmounts?.transferSource === 'NEQUI' ? (initialPaidAmounts?.transfer || 0) : 0);
      const presetDaviplata = typeof initialPaidAmounts?.daviplata === "number"
        ? initialPaidAmounts.daviplata
        : (initialPaidAmounts?.transferSource === 'DAVIPLATA' ? (initialPaidAmounts?.transfer || 0) : 0);

      setCashPaid(initialPaidAmounts?.cash || 0);
      setNequiPaid(presetNequi);
      setDaviplataPaid(presetDaviplata);
      setCreditPaid(initialPaidAmounts?.credit || 0);
      setDialogAmount('');
      setCashTendered('');
      setIsMobileNumpadOpen(false);
      setIsReady(false); // No esta listo inmediatamentente

      // Determinar tab inicial: priorizamos canal con monto cargado para que
      // el cajero vea de inmediato los montos acumulados en el pill del header.
      if (initialPaidAmounts?.credit && initialPaidAmounts.credit > 0) setActivePaymentTab('credit');
      else if (presetNequi > 0 && presetDaviplata === 0) setActivePaymentTab('NEQUI');
      else if (presetDaviplata > 0 && presetNequi === 0) setActivePaymentTab('DAVIPLATA');
      else if (initialPaidAmounts?.transfer && initialPaidAmounts.transfer > 0 && initialPaidAmounts?.transferSource) {
        setActivePaymentTab(initialPaidAmounts.transferSource as any);
      } else setActivePaymentTab('cash');

      // Pequeño retardo de seguridad (300ms) para evitar capturar el Enter que abrio el modal
      const timer = setTimeout(() => setIsReady(true), 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen, initialPaidAmounts]);

  const currentDialogVal = Number(dialogAmount) || 0;
  const totalAlreadyPaid = cashPaid + nequiPaid + daviplataPaid + creditPaid;
  const remainingDebt = Math.max(0, effectiveTotal - totalAlreadyPaid);

  const amountToPayRaw = currentDialogVal > 0
    ? currentDialogVal
    : (Number(cashTendered) > 0
        ? Number(cashTendered)
        : (totalAlreadyPaid > 0 || isAbono ? 0 : remainingDebt));

  const actualPayment = Math.min(amountToPayRaw, remainingDebt);

  const handleAddPayment = useCallback(() => {
    const val = currentDialogVal > 0 ? currentDialogVal : remainingDebt;
    if (val > 0) {
      // Al acumular un canal digital, DEJAMOS el tab activo donde estaba.
      // Antes se forzaba el salto a 'cash' automaticamente, lo que confundia
      // al cajero que acababa de digitar un monto en Nequi y queria sumar
      // otro parcial en el mismo canal. Ahora el cajero decide cuando saltar.
      if (activePaymentTab === 'NEQUI') {
        setNequiPaid(prev => prev + Math.min(val, remainingDebt));
      } else if (activePaymentTab === 'DAVIPLATA') {
        setDaviplataPaid(prev => prev + Math.min(val, remainingDebt));
      } else if (activePaymentTab === 'credit') {
        setCreditPaid(prev => prev + Math.min(val, remainingDebt));
      } else {
        if (val >= remainingDebt) setCashTendered(String(val));
        else setCashPaid(prev => prev + val);
      }
      setDialogAmount('');
    }
  }, [currentDialogVal, remainingDebt, activePaymentTab]);

  // LIMPIAR PAGOS: Resetear todos los pagos parciales acumulados para empezar de cero
  const handleClearPayments = useCallback(() => {
    setCashPaid(0);
    setNequiPaid(0);
    setDaviplataPaid(0);
    setCreditPaid(0);
    setCashTendered('');
    setDialogAmount('');
    setActivePaymentTab('cash');
  }, []);

  const isCreditInvalid = !!(activePaymentTab === 'credit' && (!client || client.id === "0" || client.name === "CONSUMIDOR FINAL"));
  const isOverCreditLimit = !!(activePaymentTab === 'credit' && client && (currentDialogVal > 0 ? currentDialogVal : remainingDebt) > (client.creditLimit - client.currentCredit));

  const processPayment = useCallback(async () => {
        if (isProcessingRef.current || submittingPayment || isCreditInvalid || isOverCreditLimit || isBlockedTransferRefund) return;
        isProcessingRef.current = true;

        let finalCash = cashPaid;
        let finalNequi = nequiPaid;
        let finalDaviplata = daviplataPaid;
        let finalCredit = creditPaid;
        let finalTendered = Number(cashTendered) || 0;

      if (currentDialogVal > 0) {
        if (activePaymentTab === 'cash') {
          finalCash += isAbono ? actualPayment : currentDialogVal;
          finalTendered = currentDialogVal;
        } else if (activePaymentTab === 'NEQUI') {
          finalNequi += isAbono ? actualPayment : currentDialogVal;
        } else if (activePaymentTab === 'DAVIPLATA') {
          finalDaviplata += isAbono ? actualPayment : currentDialogVal;
        } else if (activePaymentTab === 'credit') {
          finalCredit += currentDialogVal;
        }
      } else if (finalTendered > 0 && activePaymentTab === 'cash') {
        finalCash += isAbono ? Math.min(finalTendered, remainingDebt) : remainingDebt;
      } else if (!isAbono) {
        if (activePaymentTab === 'cash') {
          finalCash += remainingDebt;
          finalTendered = finalTendered > 0 ? finalTendered : remainingDebt;
        } else if (activePaymentTab === 'NEQUI') {
          finalNequi += remainingDebt;
        } else if (activePaymentTab === 'DAVIPLATA') {
          finalDaviplata += remainingDebt;
        } else if (activePaymentTab === 'credit') {
          finalCredit += remainingDebt;
        }
      }

      if (!isAbono) {
        const totalCoveredSoFar = finalCash + finalNequi + finalDaviplata + finalCredit;
        const leftToPay = effectiveTotal - totalCoveredSoFar;
        if (leftToPay > 0) {
          finalCash += leftToPay;
          if (finalTendered < finalCash) {
            finalTendered = finalCash;
          }
        }
      }

      const totalPaid = finalCash + finalNequi + finalDaviplata + finalCredit;
      const effectiveCash = finalTendered > 0 ? finalTendered : finalCash;
      const extraCashChange = Math.max(0, effectiveCash - finalCash);
      const change = baseReturnRefund + extraCashChange;

    let mainTransferSource = "MIXTO";
    if (finalNequi > 0 && finalDaviplata === 0) mainTransferSource = "NEQUI";
    if (finalDaviplata > 0 && finalNequi === 0) mainTransferSource = "DAVIPLATA";

    try {
      await onPay({
        cash: finalCash,
        transfer: finalNequi + finalDaviplata,
        transferSource: mainTransferSource,
        // Se manda el desglose por canal para que el backend registre por
        // separado Nequi y Daviplata. Sin esto, un pago mixto (parte Nequi,
        // parte Daviplata) se sumaba en un solo balde "otras transferencias"
        // y el dueno no podia conciliar contra los saldos de los celulares.
        transferNequi: finalNequi,
        transferDaviplata: finalDaviplata,
        credit: finalCredit,
        totalPaid: totalPaid,
        change: change
      });
    } finally {
      isProcessingRef.current = false;
    }
  }, [isCreditInvalid, isOverCreditLimit, isBlockedTransferRefund, submittingPayment, cashPaid, nequiPaid, daviplataPaid, creditPaid, cashTendered, currentDialogVal, activePaymentTab, remainingDebt, effectiveTotal, baseReturnRefund, onPay, isAbono, actualPayment]);

  // --- QR Bold / Bre-B: trigger y aprobación ---
  //
  // El cajero puede abrir el modal con cualquier canal activo (cash,
  // Nequi, Daviplata, fiado); el saldo pendiente real (`remainingDebt`)
  // es lo que se cobra por Bre-B. Si no queda saldo, estamos en flujo
  // de salida (reembolsos) o el padre no provee `onBoldQrRequested`
  // (consumidor legacy), el botón NO se habilita.
  const canUseBoldQr = useMemo(
    () => !!onBoldQrRequested
      && flowType === "in"
      && !isReturnExchange
      && !isAbono
      && !isRefund
      && remainingDebt > 0.5
      && !submittingPayment,
    [onBoldQrRequested, flowType, isReturnExchange, isAbono, isRefund, remainingDebt, submittingPayment],
  );

  const handleOpenBoldQr = useCallback(async () => {
    if (!canUseBoldQr) return;
    // Cada click en "QR Bold" DEBE arrancar fresco. Limpiamos los refs
    // de la sesión anterior ANTES de generar el nuevo ventaTempId: así,
    // si la preparación falla, nunca reutilizamos un identificador
    // viejo ni un monto obsoleto en reaperturas futuras.
    boldApprovedPayloadRef.current = null;
    boldSessionIdRef.current = "";
    setBoldQrAmount(0);
    setIsBoldQrOpen(false);
    // Generamos el ventaTempId ANTES de pedir la preparación al padre:
    // ese mismo identificador quedará escrito en el backend durante
    // `/iniciar` (migración 027 — snapshot durable) y será reutilizado
    // por `/encolar` sin regenerarse. Usamos `crypto.randomUUID` cuando
    // existe y caemos a timestamp+random si el navegador es viejo —
    // nunca reaprovechamos una intención ya cerrada.
    const uuid = typeof globalThis.crypto !== "undefined"
      && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `bold-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const amount = Math.round(remainingDebt);

    // Si el padre provee un callback, lo esperamos ANTES de abrir el
    // modal hijo. Esto permite al padre pre-registrar la intención en
    // el backend con el snapshot del carrito; si el backend responde
    // error (400/500/red caída), el callback debe lanzar y el QR
    // nunca se mostrará al cliente. El carrito queda intacto y el
    // cajero puede escoger otro canal.
    //
    // Caso especial: cuando el backend indica que la intención YA
    // está pagada (`alreadyPaid=true` en `/iniciar`), el padre lanza
    // `BOLD_QR_ALREADY_PAID_SENTINEL`. Lo detectamos aquí y
    // retornamos SIN abrir el modal hijo ni mostrar toast de error:
    // el padre ya cerró el UPM y mostró su propio UX informativo.
    if (typeof onBoldQrRequested === "function") {
      try {
        await onBoldQrRequested(amount, uuid);
      } catch (err) {
        if (err instanceof Error && err.message === BOLD_QR_ALREADY_PAID_SENTINEL) {
          // Flujo "ya pagada" — abortar en silencio, el padre ya
          // finalizó visualmente.
          return;
        }
        const description = err instanceof Error && err.message
          ? err.message
          : "Intenta de nuevo o cambia de método.";
        toast({
          variant: "destructive",
          title: "NO SE PUDO PREPARAR EL QR",
          description,
        });
        return;
      }
    }

    // Preparación OK (o sin callback — flujo legacy): recién ahora
    // publicamos el identificador en el ref y abrimos el modal hijo.
    boldSessionIdRef.current = uuid;
    setIsBoldQrReopen(false);
    setBoldQrAmount(amount);
    setIsBoldQrOpen(true);
  }, [canUseBoldQr, remainingDebt, onBoldQrRequested, toast]);

  const handleBoldQrApproved = useCallback(async (info?: {
    reference: string;
    approvedAt: string;
    approvedVia: string;
    saleId?: number;
    amountCop?: number;
  }) => {
    // ---------------------------------------------------------------
    // Flujo APROBADO con `saleId > 0` — ÚNICA ruta válida post-027.
    //
    // El backend (`DispatchAutoSale` + `MarkFinalizationSucceeded`)
    // ya materializó la venta canónica y vinculó `related_sale_id`.
    // El modal hijo nos entrega el `saleId` dentro del frame SSE
    // `qr_intent_update`. Aquí ÚNICAMENTE delegamos al padre vía
    // `onBoldQrFinalized`: el padre deduplica contra la bandeja
    // global, cierra el UPM, borra la preparación local y libera el
    // carrito activo.
    //
    // **Línea roja:** JAMÁS llamamos a `onPay` en esta rama. Hacerlo
    // regeneraría un `clientTxId` fresco en `handleConfirmSale`
    // (useNewSale.ts) y dispararía un POST `/sales/register`
    // completo, creando una segunda venta duplicada con stock doble
    // descontado. El bug observado "APROBADO post-commit crea otra
    // venta" vivía exactamente aquí.
    //
    // Si APROBADO llega sin `saleId > 0` (snapshot inconsistente,
    // backend fuera de sync), tampoco llamamos a `onPay`: mostramos
    // alerta UX y esperamos conciliación. El backend reconciliará vía
    // bridge/webhook y la bandeja global.
    // ---------------------------------------------------------------
    if (isProcessingRef.current || submittingPayment) return;

    const rawSaleId = info?.saleId;
    const saleId = typeof rawSaleId === "number"
      && Number.isFinite(rawSaleId)
      && Number.isInteger(rawSaleId)
      && rawSaleId > 0
      ? rawSaleId
      : 0;
    const ventaTempId = typeof boldSessionIdRef.current === "string" && boldSessionIdRef.current.trim()
      ? boldSessionIdRef.current.trim()
      : "";

    if (saleId > 0) {
      isProcessingRef.current = true;
      try {
        if (typeof onBoldQrFinalized === "function") {
          onBoldQrFinalized({
            ventaTempId,
            saleId,
            amountCop: typeof info?.amountCop === "number" && Number.isFinite(info.amountCop) && info.amountCop > 0
              ? Math.round(info.amountCop)
              : undefined,
            reference: info?.reference,
            approvedAt: info?.approvedAt,
            approvedVia: info?.approvedVia,
          });
        } else {
          // Consumidor legacy (no proveyó `onBoldQrFinalized`): la
          // venta ya quedó cerrada en el backend. Avisamos sin
          // disparar `onPay` (nunca duplicamos ventas desde el
          // frontend para BOLD_QR).
          toast({
            variant: "success",
            title: "QR APROBADO EN SERVIDOR",
            description: `Venta #${saleId} cerrada por el backend. Recarga el POS para ver el estado.`,
          });
        }
      } finally {
        // Resetear el ventaTempId local y limpiar el sub-modal QR;
        // el UPM lo cierra el padre vía `onOpenChange(false)`. Si el
        // padre no cerró (caso legacy), al menos el QR hijo queda
        // limpio para el siguiente cobro.
        boldSessionIdRef.current = "";
        boldApprovedPayloadRef.current = null;
        setIsBoldQrOpen(false);
        isProcessingRef.current = false;
      }
      return;
    }

    // saleId ausente/<=0: NO toque `onPay`. En el flujo post-027 el
    // backend sólo publica APROBADO después del commit; esta rama
    // es defensiva por si llega un frame histórico corrupto. Mostramos
    // alerta y conservamos la UI para que el cajero decida.
    toast({
      variant: "destructive",
      title: "QR APROBADO — ESPERANDO CONCILIACIÓN",
      description: "El pago llegó pero el servidor aún no vinculó la venta. Consulta la bandeja global antes de reintentar.",
    });
    setIsBoldQrOpen(false);
  }, [submittingPayment, onBoldQrFinalized, toast]);

  // Cancelar / cambiar método: NO disparamos `onPay`. El cajero vuelve al
  // UniversalPaymentModal, puede escoger otro canal o cerrar. El ref de
  // sesión queda inválido para la próxima apertura y se limpia el flag de
  // isBoldQrOpen para que el próximo click de "QR Bold" arranque fresco.
  const handleBoldQrCancel = useCallback(() => {
    boldSessionIdRef.current = "";
    boldApprovedPayloadRef.current = null;
    setBoldQrAmount(0);
    setIsBoldQrOpen(false);
    if (isBoldQrReopen) {
      // Reapertura desde la bandeja: el UPM se abrió sólo para mostrar
      // el QR. Cerramos todo y el cajero sigue con su venta intacta.
      setIsBoldQrReopen(false);
      onOpenChange(false);
    }
  }, [isBoldQrReopen, onOpenChange]);

  // --- Consumidor del `boldQrReopenPayload` (un solo uso) ---
  //
  // El padre (`/sales/new/page.tsx`) coloca `boldQrReopenPayload` cuando
  // el cajero pulsa "Reabrir QR" en la bandeja. El UPM:
  //
  //   1. Al abrirse (o cuando llega un payload fresco), si el payload
  //      es válido, abre el modal hijo con ESOS valores exactos (sin
  //      regenerar nada) y marca el payload como consumido en un ref
  //      local.
  //   2. Inmediatamente dispara `onBoldQrReopenConsumed()` para que el
  //      padre LIMPIE el payload a `null`. Si el padre no provee el
  //      callback (consumidor legacy), igual el ref local anti-replay
  //      evita que la misma referencia de payload se reconsuma al
  //      cerrar/abrir el UPM.
  //
  // **Línea roja (bug 2026-10-23):** si no hay payload, el UPM
  // JAMÁS abre el QR por sí mismo. El cajero debe pulsar "QR Bold /
  // Bre-B" explícitamente dentro de la grilla de métodos. Abrir el
  // modal de pago nunca abre el QR solo.
  const lastConsumedReopenRef = useRef<{ readonly ventaTempId: string; readonly monto: number } | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    if (!boldQrReopenPayload) return;
    const reopenVenta = typeof boldQrReopenPayload.ventaTempId === "string"
      ? boldQrReopenPayload.ventaTempId.trim()
      : "";
    const reopenMonto = typeof boldQrReopenPayload.monto === "number"
      && Number.isFinite(boldQrReopenPayload.monto)
      && boldQrReopenPayload.monto > 0
      ? Math.round(boldQrReopenPayload.monto)
      : 0;
    if (!reopenVenta || reopenMonto <= 0) return;
    const last = lastConsumedReopenRef.current;
    if (last && last.ventaTempId === reopenVenta && last.monto === reopenMonto) {
      // Mismo payload que ya consumimos en esta sesión del UPM. El
      // padre no limpió a tiempo; no reabrimos el QR por nuestra cuenta.
      return;
    }
    lastConsumedReopenRef.current = { ventaTempId: reopenVenta, monto: reopenMonto };
    // Reapertura canónica desde la bandeja: usar exactamente el
    // ventaTempId y monto registrados en el backend. Esto permite al
    // POST /iniciar interno responder reused=true sin duplicar la
    // intención viva.
    boldApprovedPayloadRef.current = null;
    boldSessionIdRef.current = reopenVenta;
    setIsBoldQrReopen(true);
    setBoldQrAmount(reopenMonto);
    setIsBoldQrOpen(true);
    // Pedimos al padre que limpie el payload: contrato de un solo uso.
    if (typeof onBoldQrReopenConsumed === "function") {
      try { onBoldQrReopenConsumed(); } catch { /* no-op defensivo */ }
    }
  }, [isOpen, boldQrReopenPayload, onBoldQrReopenConsumed]);

  // Limpieza al cerrar el UPM: resetea el ref de reopen consumido y las
  // referencias del sub-modal QR para que la próxima apertura (misma u
  // otra factura) arranque fresca y nunca reabra un QR anterior.
  useEffect(() => {
    if (isOpen) return;
    lastConsumedReopenRef.current = null;
    boldSessionIdRef.current = "";
    boldApprovedPayloadRef.current = null;
    setIsBoldQrOpen(false);
    setIsBoldQrReopen(false);
    setBoldQrAmount(0);
  }, [isOpen]);

  const keyboardActionsRef = useRef({ processPayment, handleAddPayment, onOpenChange, onCloseComplete });
  useEffect(() => {
    keyboardActionsRef.current = { processPayment, handleAddPayment, onOpenChange, onCloseComplete };
  }, [processPayment, handleAddPayment, onOpenChange, onCloseComplete]);

  const [isTelegramSending, setIsTelegramSending] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  // Preferencia unificada: se lee desde `thermal-ticket.getAutoPrint`, que
  // honra tanto la clave canónica `pos_auto_print` como la legacy
  // `pos_auto_print_ticket` por retrocompatibilidad.
  const [autoPrint, setAutoPrint] = useState(() => readAutoPrint());

  // Convierte el `lastReceipt` de la caja al shape que entiende saleToTicket.
  // El receipt vive con un formato legacy (cashAmount/transferAmount/...);
  // mapeamos con la cara de un Sale para reusar la misma fuente de ticket
  // que el historial y evitar duplicar la plantilla.
  const buildTicketData = useCallback((): TicketData => {
    const items = (lastReceipt?.items ?? []).map((it: any) => ({
      quantity: Number(it.quantity || it.cartQuantity || 1),
      unitPrice: Number(it.unitPrice || it.salePrice || it.price || 0),
      subtotal: Number(it.subtotal || (it.quantity || it.cartQuantity || 1) * (it.unitPrice || it.salePrice || it.price || 0)),
      barcode: it.barcode,
      product: { productName: it.product?.productName || it.name || it.productName || "PRODUCTO" },
    }));
    const saleLike = {
      id: lastReceipt?.saleId ?? lastReceipt?.id ?? "POS",
      date: lastReceipt?.date,
      total: Number(lastReceipt?.total ?? totalToPay),
      cashAmount: Number(lastReceipt?.cashAmount ?? 0),
      transferAmount: Number(lastReceipt?.transferAmount ?? 0),
      creditAmount: Number(lastReceipt?.creditAmount ?? 0),
      change: Number(lastReceipt?.change ?? lastChange ?? 0),
      employeeName: lastReceipt?.employeeName,
      client: { name: lastReceipt?.clientName || client?.name, dni: lastReceipt?.clientDni || client?.dni, phone: lastReceipt?.clientPhone || client?.phone },
      details: items,
    };
    return saleToTicket(saleLike, lastReceipt?.paymentMethod);
  }, [lastReceipt, totalToPay, lastChange, client]);

  // Texto plano (compat para el endpoint legacy /telegram/ticket).
  const generateTicketText = useCallback(() => {
    const rClient = lastReceipt?.clientName || client?.name || "CONSUMIDOR FINAL";
    const rDni = lastReceipt?.clientDni || client?.dni || "0";
    // `lastReceipt.date` ahora se guarda como ISO 8601 en useNewSale para
    // evitar que `saleToTicket` → `new Date(string)` produzca Invalid Date
    // por locale. Para la factura de texto plano (Telegram), pasamos ese
    // ISO por `formatDateTime` para rendirla como `dd/MM/yyyy hh:mm AM`
    // (y si por alguna razón el campo llegara mal, el helper devuelve
    // `FECHA NO DISPONIBLE` en vez de un ISO crudo o NaN).
    const rDate = formatDateTime(lastReceipt?.date ?? new Date());

    let text = `🧾 *FACTURA DE VENTA N° #${lastReceipt?.saleId || 'POS'}*\n`;
    text += `🏢 *SUPERMERCADO SURTIFAMILIAR*\n`;
    text += `📅 *Fecha:* ${rDate}\n`;
    text += `👤 *Cliente:* ${rClient}\n`;
    text += `📄 *CC/NIT:* ${rDni}\n`;
    text += `--------------------------------\n`;

    (lastReceipt?.items || []).forEach((it: any) => {
      const name = it.product?.productName || it.name || 'Producto';
      const qty = it.quantity || it.cartQuantity || 1;
      const price = it.unitPrice || it.salePrice || it.price || 0;
      const sub = it.subtotal || (qty * price);
      text += `• *${qty}x* ${name}\n  $${formatCurrency(price)} = *$${formatCurrency(sub)}*\n`;
    });

    text += `--------------------------------\n`;
    text += `💰 *TOTAL:* *$${formatCurrency(lastReceipt?.total || totalToPay)}*\n`;
    text += `💳 *MÉTODO:* ${lastReceipt?.paymentMethod || 'EFECTIVO'}\n`;
    if (lastReceipt?.cashAmount > 0) text += `💵 *Efectivo:* $${formatCurrency(lastReceipt.cashAmount)}\n`;
    if (lastReceipt?.transferAmount > 0) text += `📱 *Transferencia:* $${formatCurrency(lastReceipt.transferAmount)}\n`;
    if (lastReceipt?.creditAmount > 0) text += `👥 *Fiado:* $${formatCurrency(lastReceipt.creditAmount)}\n`;
    if ((lastReceipt?.change || lastChange || 0) > 0) text += `🪙 *Cambio:* $${formatCurrency(lastReceipt?.change || lastChange)}\n`;
    text += `\n¡Gracias por su compra! 🙏✨`;
    return text;
  }, [lastReceipt, client, totalToPay, lastChange]);

  const handleTelegramShare = useCallback(async (silent = false) => {
    setIsTelegramSending(true);
    try {
      // 1er intento: imagen con la misma plantilla térmica. El backend valida
      // MIME + firma mágica PNG y reusa TelegramService.SendPhoto. Si el
      // endpoint todavía no está desplegado, caemos al legacy de texto.
      try {
        const token = getSessionToken() ?? "";
        const data = buildTicketData();
        const result = await sendTicketImageToTelegram(data, {
          token,
          apiBase: API_URL,
          caption: `Factura #${data.ticketNumber}`,
        });
        if (result.ok) {
          if (!silent) toast({ title: "FACTURA ENVIADA", description: "Imagen enviada a Telegram." });
          return;
        }
        if (result.status !== 404 && result.status !== 405) {
          throw new Error(`HTTP ${result.status}`);
        }
        // 404/405: endpoint multipart aún no publicado → fallback a texto.
      } catch {
        // No pisamos el flujo: pasamos al legacy. El operador no debería
        // enterarse de la diferencia salvo que ambos fallen.
      }
      const text = generateTicketText();
      if (!text) return;
      await apiFetch('/telegram/ticket', {
        method: 'POST',
        body: JSON.stringify({ text }),
        fallbackError: 'Fallo al enviar comprobante a Telegram'
      });
      if (!silent) {
        toast({ title: "FACTURA ENVIADA", description: "Se envió el ticket a Telegram correctamente." });
      }
    } catch (err: any) {
      if (!silent) {
        toast({ variant: "destructive", title: "FALLO TELEGRAM", description: err.message || "Error al enviar comprobante" });
      }
    } finally {
      setIsTelegramSending(false);
    }
  }, [buildTicketData, generateTicketText, toast]);

  const handleWhatsAppShare = useCallback(async () => {
    setIsSharing(true);
    try {
      const data = buildTicketData();
      // Camino preferido: compartir el PNG. En celular dispara el share nativo
      // (foto adjunta); en escritorio sin share baja el PNG + abre WhatsApp
      // con un texto corto, sin re-mandar el detalle completo con emojis.
      await shareTicketImage(data, {
        phone: lastReceipt?.clientPhone || client?.phone,
      });
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "NO SE PUDO COMPARTIR",
        description: err?.message || "Intenta imprimir y envía la foto manualmente.",
      });
    } finally {
      setIsSharing(false);
    }
  }, [buildTicketData, client?.phone, lastReceipt?.clientPhone, toast]);

  const handlePrintTicket = useCallback(() => {
    // Antes se usaba window.print() de la página entera: la impresora térmica
    // recibía el DOM completo del POS y salía descuadrado. Ahora se delega al
    // iframe aislado que ya usa `printThermalTicket`.
    try {
      printThermalTicket(buildTicketData());
    } catch (err: any) {
      toast({ variant: "destructive", title: "IMPRESIÓN", description: err?.message || "No se pudo imprimir el ticket." });
    }
  }, [buildTicketData, toast]);

  // Impresión directa por bridge local (sin diálogo del navegador).
  // Solo tiene sentido cuando el admin configuró el modo "bridge" en
  // `/labels/config` y el navegador expone `window.posBridge.print`.
  //
  // Si el bridge no está disponible NO abrimos el diálogo silenciosamente:
  // esa confusión fue el bug raíz que el sprint resuelve. Mostramos un
  // toast accionable y el cajero decide usar el botón separado de
  // "Navegador/PDF".
  const [bridgeAvailableState, setBridgeAvailableState] = useState(false);
  useEffect(() => {
    // Sondeo liviano al abrir la pantalla de éxito: así los botones
    // bridge/navegador reflejan la realidad del navegador en vivo. En
    // SSR o sin pantalla de éxito queda `false` por defecto.
    if (!showSuccessScreen) return;
    setBridgeAvailableState(hasPosBridgePrint());
  }, [showSuccessScreen]);

  const handleBridgePrint = useCallback(async () => {
    try {
      await printThermalTicketDirect(buildTicketData());
      toast({ title: "ENVIADO AL BRIDGE", description: "Impresión directa, sin diálogo." });
    } catch (err: any) {
      const msg = err?.message || "";
      if (typeof msg === "string" && msg.startsWith(DIRECT_PRINT_UNAVAILABLE)) {
        toast({
          variant: "destructive",
          title: "BRIDGE NO DISPONIBLE",
          description: 'El bridge local no respondió. Usa "Navegador / PDF" si necesitas imprimir ahora.',
        });
      } else {
        toast({ variant: "destructive", title: "IMPRESIÓN DIRECTA", description: msg || "No se pudo imprimir." });
      }
    }
  }, [buildTicketData, toast]);

  // Dispatcher central del auto-print: aplica el mismo contrato que los
  // botones manuales. Vive aquí porque consumen el mismo `buildTicketData`
  // y comparten lógica de fallback. NO abre diálogo cuando el admin eligió
  // bridge y el bridge no está — en ese caso notifica al cajero.
  //
  // IMPORTANTE: este dispatcher NO embebe `openDrawerOnSale` en el payload
  // del recibo. El flujo UI usa UNA sola ruta física para abrir el cajón
  // al vender: `dispatchDrawerKickOnSale` audit-first (ver el useEffect
  // "Cajón al completar venta"). Combinar ambos mecanismos abría el cajón
  // dos veces (bug reportado antes de printing-v2 defects). El
  // `buildReceiptBytes` del bridge sigue siendo capaz de incluir el pulso
  // del cajón para callers explícitos (p.ej. un futuro flujo ESC/POS-only),
  // pero este path UI jamás lo activa.
  const dispatchAutoPrint = useCallback(async () => {
    let mode: "bridge" | "browser" = "browser";
    try {
      const persisted = loadPrintingConfig();
      mode = persisted.receipt.deliveryMode === RECEIPT_DELIVERY_MODES.BRIDGE ? "bridge" : "browser";
    } catch {
      // Sin storage válido asumimos el camino seguro.
      mode = "browser";
    }

    if (mode === "bridge") {
      try {
        // Sin `openDrawerOnSale`: la apertura la hace el kick separado.
        await printThermalTicketDirect(buildTicketData());
      } catch (err: any) {
        const msg = err?.message || "";
        if (typeof msg === "string" && msg.startsWith(DIRECT_PRINT_UNAVAILABLE)) {
          toast({
            variant: "destructive",
            title: "AUTOIMPRESIÓN DIRECTA FALLÓ",
            description: 'El bridge local no respondió. Usa "Navegador / PDF" para imprimir manualmente.',
          });
        } else {
          toast({ variant: "destructive", title: "AUTOIMPRESIÓN", description: msg || "No se pudo imprimir." });
        }
      }
      return;
    }
    try {
      // Modo navegador: no tiene sentido mandar `openDrawerOnSale` (ni
      // podría abrir el cajón físicamente). El kick post-venta es
      // responsabilidad del `dispatchDrawerKickOnSale` separado.
      printThermalTicket(buildTicketData());
    } catch { /* no debe tumbar la UI */ }
  }, [buildTicketData, toast]);

  // ---------------------------------------------------------------------------
  // Dispatcher del kick al cajón POS-VENTA.
  //
  // Es la ÚNICA ruta física automática por venta: `dispatchAutoPrint` nunca
  // embebe el pulso dentro del recibo, por diseño. El browser NUNCA puede
  // abrir físicamente el cajón, así que si no hay bridge, auditamos y
  // devolvemos un resultado estructurado para que el orquestador decida si
  // avisar al cajero vía toast (nunca bloquea la venta). Si hay bridge, le
  // pasamos:
  //   - `drawer`: comando ESC/POS literal + evento (BEFORE_PRINT /
  //     AFTER_PRINT / MANUAL — MANUAL ya quedó filtrado antes de llegar).
  //   - `connection`: a qué impresora enviar el pulso.
  //   - `openDrawerOnSale: true`: hint explícito de que este kick viene
  //     disparado por una venta recién confirmada. El bridge aplica
  //     `resolveAutoDrawerBytes` para enforce enabled/event/MANUAL como
  //     segunda línea de defensa; con `openDrawerOnSale: false` o ausente,
  //     el bridge ejecuta el pulso directo.
  // La auditoría a `/cash-drawer/open` se hace primero (audit-first) con
  // `override: false`: el backend acepta porque hay una venta reciente
  // asociada al token del cajero (CASH_DRAWER_REQUIRES_SALE_OR_ADMIN).
  // Cuando `lastReceipt.saleId` existe (viene del 201 real del backend),
  // el audit lo adjunta para que la verificación de propiedad del backend
  // (`IsSaleOwnedByCashier`) actúe sobre la venta exacta y no sólo sobre
  // la ventana de 90 s de "venta reciente del cajero".
  //
  // Deliberadamente NO depende de `autoPrint`, `receipt.deliveryMode`,
  // ni de `hasPosBridgePrint`: el único gate es `drawer.enabled` +
  // `drawer.openDrawerOnSale` + `event !== MANUAL`, validado por el
  // orquestador. Si el bridge de impresión está muerto o el modo es
  // "browser", el pulso del cajón sigue intentándose porque es una ruta
  // física independiente del canal del recibo.
  type DrawerKickResult =
    | { readonly status: "ok" }
    | { readonly status: "audit-failed"; readonly message: string }
    | { readonly status: "bridge-missing" }
    | { readonly status: "bridge-failed"; readonly message: string };

  // El dispatcher lee el saleId "último conocido" de un ref porque usamos
  // `useCallback([])` para mantener la referencia estable (el existing
  // contract test ancla la firma `dispatchDrawerKickOnSale(cfg)` sin
  // argumentos extra). El ref se sincroniza desde `lastReceipt?.saleId`
  // en un efecto aparte: `lastReceipt` muta sólo cuando una venta real
  // se registra con éxito, así que el ref siempre refleja la última
  // venta que corresponde al cajero sesión actual.
  const lastReceiptSaleIdRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const candidate = (lastReceipt && typeof lastReceipt === "object")
      ? (lastReceipt as { saleId?: unknown }).saleId
      : undefined;
    if (
      typeof candidate === "number"
      && Number.isFinite(candidate)
      && Number.isInteger(candidate)
      && candidate > 0
    ) {
      lastReceiptSaleIdRef.current = candidate;
    } else {
      lastReceiptSaleIdRef.current = undefined;
    }
  }, [lastReceipt]);

  const dispatchDrawerKickOnSale = useCallback(async (
    cfg: ReturnType<typeof loadPrintingConfig>,
  ): Promise<DrawerKickResult> => {
    // Construimos el body de auditoría. `saleId` se adjunta sólo cuando
    // es entero positivo: nunca inventamos un id y nunca enviamos string
    // vacío/0 al backend. El backend sin `saleId` aún acepta usando la
    // ventana de 90 s de venta reciente del cajero.
    const auditBody: Record<string, unknown> = {
      override: false,
      note: "Autoapertura tras venta exitosa",
      source: "universal-payment-modal",
      event: cfg.drawer.event,
    };
    const saleIdForAudit = lastReceiptSaleIdRef.current;
    if (
      typeof saleIdForAudit === "number"
      && Number.isInteger(saleIdForAudit)
      && saleIdForAudit > 0
    ) {
      auditBody.saleId = saleIdForAudit;
    }
    try {
      await apiFetch("/cash-drawer/open", {
        method: "POST",
        body: JSON.stringify(auditBody),
      });
    } catch (err) {
      // La auditoría falló (sesión caída, backend sin endpoint, 403 de
      // propiedad, etc.). NO interrumpimos la venta ni la revertimos:
      // devolvemos el resultado para que el orquestador avise con un
      // toast claro no bloqueante.
      const message = err instanceof Error ? err.message : "No se pudo registrar la autoapertura.";
      return { status: "audit-failed", message };
    }

    // Llamada directa a window.posBridge.kickDrawer. NO usamos
    // `hasPosBridgePrint`: ese helper mide la ruta de IMPRESIÓN. Aquí
    // sólo nos interesa el pulso lateral, que es un canal independiente
    // y debe intentarse aunque la impresión esté desconectada.
    const w = window as typeof window & {
      posBridge?: { kickDrawer?: (p: unknown) => Promise<unknown> };
    };
    if (!w.posBridge || typeof w.posBridge.kickDrawer !== "function") {
      // Sin bridge, el navegador no puede abrir físicamente. La
      // auditoría ya quedó registrada; avisamos al cajero para que no
      // crea que el equipo está roto cuando el pulso no llega.
      return { status: "bridge-missing" };
    }
    try {
      await w.posBridge.kickDrawer({
        command: cfg.drawer.command,
        event: cfg.drawer.event,
        connection: cfg.connection,
        drawer: cfg.drawer,
        openDrawerOnSale: true,
      });
      return { status: "ok" };
    } catch (err) {
      // El bridge rechazó el pulso (puerto ocupado, impresora apagada,
      // etc.). La auditoría ya quedó registrada; devolvemos para que el
      // orquestador avise. NUNCA se revierte la venta.
      const message = err instanceof Error ? err.message : "El bridge rechazó el pulso.";
      return { status: "bridge-failed", message };
    }
  }, []);

  // Traduce el resultado del dispatcher a un toast NO BLOQUEANTE. El
  // texto evita jerga del dispositivo (hay un guardián que prohíbe la
  // palabra visible, ver `drawer-visible-strings-hidden.test.mjs`) y
  // deja claro que la venta YA quedó registrada: el fallo es lateral.
  const notifyDrawerKickResult = useCallback((result: DrawerKickResult): void => {
    if (result.status === "ok") return;
    if (result.status === "audit-failed") {
      toast({
        variant: "destructive",
        title: "AUDITORÍA LATERAL FALLÓ",
        description: "La venta quedó registrada; no se pudo registrar la autoapertura automática.",
      });
      return;
    }
    if (result.status === "bridge-missing") {
      toast({
        variant: "destructive",
        title: "BRIDGE LATERAL NO DISPONIBLE",
        description: "La venta quedó registrada; sin bridge local no se puede completar el pulso lateral.",
      });
      return;
    }
    toast({
      variant: "destructive",
      title: "PULSO LATERAL FALLÓ",
      description: "La venta quedó registrada; el bridge rechazó el pulso lateral.",
    });
  }, [toast]);

  // Auto-impresión persistente y cajón al completar venta — ORQUESTADOR
  // ÚNICO, SINGLE-FIRE por venta.
  //
  // Una sola guardia evita carreras entre dos effects. El toggle sólo
  // persiste preferencia y nunca re-dispara porque no está en deps. El kick
  // audit-first es la ÚNICA ruta física del cajón; `dispatchAutoPrint` no
  // embebe `openDrawerOnSale` en el recibo.
  //
  // Orden:
  //   - BEFORE_PRINT: kick audit-first → autoimpresión (si está activa).
  //   - AFTER_PRINT:  autoimpresión (si está activa) → kick audit-first.
  //   - MANUAL:       nunca hay kick automático.
  // Si autoPrint está desactivado, BEFORE/AFTER todavía abren el cajón tras
  // la venta (la ruta separada no depende de que exista una tirilla).
  // Reimpresiones y botones manuales no pasan por este efecto.
  const didSaleCompletionEffectsRef = useRef(false);
  useEffect(() => {
    if (!showSuccessScreen) {
      didSaleCompletionEffectsRef.current = false;
      return;
    }
    if (didSaleCompletionEffectsRef.current) return;
    didSaleCompletionEffectsRef.current = true;

    const shouldAutoPrint = readAutoPrint();
    let cfg: ReturnType<typeof loadPrintingConfig> | null = null;
    try {
      cfg = loadPrintingConfig();
    } catch {
      // Una config corrupta no bloquea la impresión con defaults.
    }
    const shouldKick = !!cfg
      && cfg.drawer.enabled
      && cfg.drawer.openDrawerOnSale
      && cfg.drawer.event !== DRAWER_EVENTS.MANUAL;

    const runSaleCompletionEffects = async () => {
      // BEFORE_PRINT: el pulso lateral se intenta ANTES de imprimir,
      // completamente desacoplado de autoPrint y de `receipt.deliveryMode`.
      // Si falla, el orquestador avisa con un toast lateral y sigue; nunca
      // se bloquea la venta.
      if (cfg && shouldKick && cfg.drawer.event === DRAWER_EVENTS.BEFORE_PRINT) {
        const result = await dispatchDrawerKickOnSale(cfg);
        notifyDrawerKickResult(result);
      }
      if (shouldAutoPrint) {
        // `dispatchAutoPrint` nunca lanza: muestra sus propios toasts si
        // falla. Esperamos que termine para preservar el orden lógico
        // AUTO-IMPRESIÓN → AFTER_PRINT, pero su resultado NO condiciona
        // el intento del pulso lateral que viene después.
        await dispatchAutoPrint();
      }
      // AFTER_PRINT: se intenta aunque la impresión directa haya fallado
      // (ej. bridge de impresión muerto, modo browser sin diálogo útil).
      // El pulso lateral es una ruta física independiente del canal del
      // recibo y no debe perderse por un error lateral de impresión.
      if (cfg && shouldKick && cfg.drawer.event === DRAWER_EVENTS.AFTER_PRINT) {
        const result = await dispatchDrawerKickOnSale(cfg);
        notifyDrawerKickResult(result);
      }
    };

    // Conserva el pequeño margen histórico para que lastReceipt termine de
    // hidratarse antes de componer la tirilla, sin crear un segundo trigger.
    const timer = setTimeout(() => { void runSaleCompletionEffects(); }, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSuccessScreen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      // Mientras el QR está abierto, Radix es el único dueño del teclado.
      // Evita que Enter cobre por el método subyacente o que Escape cierre
      // también el modal principal después de cancelar el hijo.
      if (isBoldQrOpen) return;

      const actions = keyboardActionsRef.current;
      if (showSuccessScreen) {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          actions.onCloseComplete?.();
          actions.onOpenChange(false);
        }
        return;
      }

      const target = e.target as HTMLElement;
      if (target?.tagName === 'TEXTAREA') {
        return;
      }

      if (isProcessingRef.current && e.key === 'Enter') {
          e.preventDefault();
          return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        void actions.processPayment();
        return;
      }

      if (target?.tagName === 'INPUT') {
        return;
      }

      if (target?.tagName === 'BUTTON') {
        target.blur();
      }

      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        setDialogAmount(prev => prev + e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        setDialogAmount(prev => prev.slice(0, -1));
      } else if (e.key === '+' || e.key === 'Add') {
        e.preventDefault();
        actions.handleAddPayment();
      } else if (e.key === 'Escape') {
        actions.onOpenChange(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, showSuccessScreen, isBoldQrOpen]);

  if (!isOpen) return null;

  // Derivados de presentación (no de math): qué mostrar en el hero del efectivo.
  const showChangeHero = baseReturnRefund > 0 || amountToPayRaw > remainingDebt;
  const cashHeroValue = baseReturnRefund > 0
    ? baseReturnRefund + Math.max(0, (amountToPayRaw > remainingDebt ? amountToPayRaw - remainingDebt : 0))
    : (amountToPayRaw > remainingDebt ? amountToPayRaw - remainingDebt : amountToPayRaw);
  const cashHeroLabel = baseReturnRefund > 0
    ? 'DEVOLUCIÓN AL CLIENTE (VUELTAS)'
    : (amountToPayRaw > remainingDebt ? 'CAMBIO (VUELTAS)' : 'EFECTIVO RECIBIDO');
  // En escritorio el recuadro de efectivo está oculto: la tarjeta "Restante"
  // pasa a mostrar las vueltas cuando el efectivo supera lo adeudado.
  const tileShowsChange = baseReturnRefund > 0 || (activePaymentTab === 'cash' && amountToPayRaw > remainingDebt);

  const primaryActionLabel = isCreditInvalid
    ? "CLIENTE REQUERIDO"
    : isOverCreditLimit
      ? "CUPO EXCEDIDO"
      : isBlockedTransferRefund
        ? `LLEVAR MÁS PRODUCTOS ($${formatCurrency(Math.abs(netExchangeBalance))})`
        : (flowType === "out" ? "CONFIRMAR REEMBOLSO" : "COMPLETAR VENTA");

  const desktopActionLabel = isCreditInvalid
    ? "CLIENTE NO SELECCIONADO"
    : isOverCreditLimit
      ? "CUPO EXCEDIDO"
      : isBlockedTransferRefund
        ? `LLEVAR MÁS PRODUCTOS ($${formatCurrency(Math.abs(netExchangeBalance))})`
        : (flowType === "out" ? "ENTREGAR EFECTIVO" : "COMPLETAR VENTA");

  const paymentTabs = [
    { id: 'cash' as const, label: 'Efectivo', icon: <Banknote size={18} className="md:w-6 md:h-6" /> },
    { id: 'NEQUI' as const, label: 'Nequi', logo: '/logos/nequi.png' },
    { id: 'DAVIPLATA' as const, label: 'Daviplata', logo: '/logos/daviplata.png' },
    { id: 'credit' as const, label: 'Fiado', icon: <Users size={18} className="md:w-6 md:h-6" /> }
  ]
    .filter(tab => tab.id !== 'credit' || showCreditTab)
    .filter(tab => !isRefund || tab.id === 'cash');
  // Nota: BOLD_QR vive como botón independiente dentro de la grilla de
  // métodos (ver `<button aria-label={BOLD_QR_METHOD_LABEL}>` abajo). NO
  // forma parte de `paymentTabs` porque su interacción es diferente:
  // cambia la vista del mismo `ModalContent` a `ModalPagoBoldQR` en vez de
  // abrir otro modal. Mantener el botón fuera de `paymentTabs` también permite
  // ocultarlo cuando `onBoldQrRequested` no está provisto (back-compat con
  // consumidores legacy del `UniversalPaymentModal`) o cuando el flujo es refund/abono.

  return (
    <>
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      // El mismo ModalContent alterna entre cobro y QR. El padre no se
      // descarta por clic exterior y Escape se deshabilita mientras la vista
      // QR está activa, evitando cierres accidentales del flujo completo.
      isDismissable={false}
      isKeyboardDismissDisabled={isBoldQrOpen}
      placement="center"
      backdrop="blur"
      size="5xl"
      onClose={onCloseComplete}
    classNames={{
        // base: dos envolventes estables según la vista.
        //   - Móvil: `w-screen max-w-[100vw] h-[100dvh]` mantiene pantalla
        //     completa para que ningún control quede fuera del viewport.
        //   - Cobro desktop: 980×500 px, compacto y con scroll interno.
        //   - QR desktop: la vista necesita más altura por el código de
        //     320 px + estado + acciones. El sufijo condicional usa clases
        //     importantes para pasar a 620×720 px (máx. 90vh) sólo mientras
        //     `isBoldQrOpen`; así el QR no se recorta y el cobro no vuelve a
        //     quedar verticalmente largo.
        // HeroUI conserva `size="5xl"`: nunca volver a `size="full"`, que
        // inyecta min-height:100dvh incluso en escritorio.
        base: "bg-gray-50 dark:bg-zinc-950 w-screen md:w-[980px] max-w-[100vw] md:max-w-[1050px] h-[100dvh] md:h-[500px] md:max-h-[78vh] md:rounded-[1.75rem] border-0 md:border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden m-0 md:mx-2 rounded-none" + (isBoldQrOpen ? " md:!w-[620px] md:!max-w-[620px] md:!h-[720px] md:!max-h-[90vh]" : ""),
        closeButton: "hidden",
        wrapper: "fixed top-0 left-0 w-screen h-screen bg-black/70 z-[9999] flex items-center justify-center"
      }}
    >
      <ModalContent>
        {() => isBoldQrOpen ? (
          <ModalPagoBoldQR
            isOpen={isBoldQrOpen}
            onOpenChange={setIsBoldQrOpen}
            monto={Math.round(boldQrAmount)}
            cajaId={user?.dni ?? user?.id ?? "CAJA"}
            ventaTempId={boldSessionIdRef.current || "temp-pos"}
            onApproved={(info) => { void handleBoldQrApproved(info); }}
            onEnqueueAndClose={isBoldQrReopen ? undefined : onBoldQrEnqueueRequested}
            onCancel={handleBoldQrCancel}
            reopened={isBoldQrReopen}
          />
        ) : (
          <div className="flex flex-col md:flex-row h-full min-h-0 min-w-0 overflow-hidden relative">            {showSuccessScreen && (
              <div className="absolute inset-0 z-[100] bg-white dark:bg-zinc-950/95 flex flex-col items-center overflow-y-auto overscroll-contain p-3 md:p-4 animate-in fade-in zoom-in duration-300">
                <div className="my-auto bg-white dark:bg-[#18181b] p-5 md:p-6 rounded-[2rem] flex flex-col items-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-black/5 dark:border-white/10 w-full max-w-md relative overflow-hidden group">
                  <div className={`h-12 w-12 rounded-2xl ${theme.bg} text-white flex items-center justify-center mb-2 shadow-[0_8px_30px_rgb(0,0,0,0.12)]`}>
                    <Check size={28} strokeWidth={3.5} />
                  </div>
                  <h2 className="text-2xl font-semibold text-gray-900 dark:text-white uppercase mb-3 tracking-tight text-center leading-tight">
                    Operación <span className={theme.text}>Exitosa</span>
                  </h2>

                  <div className={`${theme.bgLight} border-2 ${theme.borderLight} px-4 py-3 rounded-2xl text-center w-full mb-3`}>
                    <p className={`text-[11px] font-semibold ${theme.text} uppercase mb-1 tracking-wider`}>CAMBIO A ENTREGAR</p>
                    <p className="text-4xl font-bold text-gray-900 dark:text-white tabular-nums tracking-tight leading-none">${formatCurrency(lastChange)}</p>
                  </div>

                  {/* FACTURA Y COMPARTIR ACCIONES */}
                  <div className="w-full flex flex-col gap-2 pt-2 border-t border-gray-200 dark:border-white/10">
                    <div className="grid grid-cols-2 gap-2 w-full">
                      <Button
                        size="sm"
                        isLoading={isSharing}
                        aria-label="Compartir factura por WhatsApp"
                        className="h-11 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 rounded-xl font-semibold uppercase text-[11px] tracking-wider flex items-center justify-center gap-1.5"
                        onPress={handleWhatsAppShare}
                      >
                        <MessageCircle size={15} /> WhatsApp
                      </Button>
                      <Button
                        size="sm"
                        isLoading={isTelegramSending}
                        className="h-11 bg-sky-500/10 hover:bg-sky-500/20 text-sky-600 dark:text-sky-400 border border-sky-500/30 rounded-xl font-semibold uppercase text-[11px] tracking-wider flex items-center justify-center gap-1.5"
                        onPress={() => handleTelegramShare(false)}
                      >
                        <Send size={15} /> Telegram
                      </Button>
                    </div>

                    {/* Separación clara entre canales digitales (arriba) y
                        canales físicos de impresión (abajo). El cajero
                        elige explícitamente Bridge vs Navegador/PDF: el
                        POS NO decide por él. */}
                    <div className="grid grid-cols-2 gap-2 w-full">
                      <Button
                        size="sm"
                        aria-label="Imprimir directo con bridge local sin diálogo"
                        isDisabled={!bridgeAvailableState}
                        className={`h-11 border rounded-xl font-semibold uppercase text-[11px] tracking-wider flex items-center justify-center gap-1.5 ${
                          bridgeAvailableState
                            ? "bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                            : "bg-zinc-500/5 text-zinc-400 dark:text-zinc-500 border-zinc-500/20 cursor-not-allowed"
                        }`}
                        onPress={handleBridgePrint}
                      >
                        <Printer size={15} /> Impresora (bridge)
                      </Button>
                      <Button
                        size="sm"
                        aria-label="Imprimir en navegador o guardar como PDF"
                        className="h-11 bg-zinc-500/10 hover:bg-zinc-500/20 text-zinc-700 dark:text-zinc-300 border border-zinc-500/30 rounded-xl font-semibold uppercase text-[11px] tracking-wider flex items-center justify-center gap-1.5"
                        onPress={handlePrintTicket}
                      >
                        <Printer size={15} /> Navegador / PDF
                      </Button>
                    </div>
                    {!bridgeAvailableState && (
                      <p className="text-[10px] text-center text-zinc-500 dark:text-zinc-400 leading-tight">
                        Sin bridge local detectado. La ruta directa queda deshabilitada; usa Navegador / PDF.
                      </p>
                    )}

                    {/* INTERRUPTOR DE IMPRESION AUTOMATICA PERSISTENTE */}
                    <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-zinc-900/60 rounded-xl border border-gray-200 dark:border-white/5">
                      <div className="flex items-center gap-3">
                        <Printer size={18} className={autoPrint ? "text-emerald-500" : "text-zinc-400"} />
                        <div className="flex flex-col text-left">
                          <span className="text-[12px] font-semibold text-gray-800 dark:text-zinc-200 uppercase tracking-wider">Impresión automática</span>
                          <span className="text-[11px] font-medium text-gray-500 dark:text-zinc-400">{autoPrint ? "Activa (imprime al cobrar)" : "Inactiva (manual)"}</span>
                        </div>
                      </div>
                      <Switch
                        size="sm"
                        color="success"
                        isSelected={autoPrint}
                        aria-label="Impresión automática del ticket"
                        onValueChange={(val) => {
                          setAutoPrint(val);
                          persistAutoPrint(val);
                        }}
                      />
                    </div>
                  </div>

                  <Button
                    className="mt-3 shrink-0 bg-gray-900 dark:bg-white text-white dark:text-black font-semibold px-8 h-11 rounded-2xl w-full shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center justify-center gap-3 active:scale-95 transition-all text-[13px] tracking-wider uppercase hover:opacity-90"
                    onPress={() => {
                      onCloseComplete?.();
                      onOpenChange(false);
                    }}
                  >
                    CONTINUAR [ENTER] <ArrowRight size={16} />
                  </Button>
                </div>
              </div>
            )}

            <div className="w-full md:w-[190px] md:shrink-0 min-w-0 bg-white dark:bg-[#18181b] border-b md:border-b-0 md:border-r border-gray-200 dark:border-white/5 p-2 md:p-3 flex flex-col gap-2 md:gap-2 z-20">
              <div className="hidden md:flex flex-col mb-3 px-1">
                <h3 className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-widest leading-none">
                  Método de pago
                </h3>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-1 gap-1.5 md:gap-3">
                {paymentTabs.map(tab => (
                  <button
                    key={tab.id}
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      setActivePaymentTab(tab.id);
                      setDialogAmount('');
                      setCashTendered('');
                      (e.currentTarget as HTMLElement)?.blur();
                      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                    }}
                    className={`h-11 md:h-14 px-2 md:px-4 rounded-2xl flex items-center justify-center md:justify-start gap-2 md:gap-3 border transition-all group ${
                      activePaymentTab === tab.id
                        ? `${theme.bgLight} ${theme.border} text-gray-900 dark:text-white`
                        : 'bg-gray-50 dark:bg-zinc-800 border-transparent text-gray-600 dark:text-zinc-400 ' + theme.bgHover
                    }`}
                  >
                    <div className={`p-1.5 md:p-2 rounded-xl transition-colors ${activePaymentTab === tab.id ? theme.bg + ' text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)]' : 'bg-gray-200 dark:bg-zinc-700/50 group-hover:' + theme.bg + ' group-hover:text-white'}`}>
                      {tab.icon ? (
                        tab.icon
                      ) : (
                        <img
                          src={tab.logo}
                          className={`h-5 w-5 md:h-6 md:w-6 object-contain ${activePaymentTab === tab.id ? 'brightness-200' : 'opacity-70 group-hover:opacity-100'}`}
                          alt={tab.label}
                        />
                      )}
                    </div>
                    <span className="text-[12px] md:text-[13px] font-semibold uppercase tracking-wider whitespace-nowrap leading-none">{tab.label}</span>
                  </button>
                ))}

                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    (e.currentTarget as HTMLElement)?.blur();
                    void handleOpenBoldQr();
                  }}
                  disabled={!canUseBoldQr}
                  aria-label={BOLD_QR_METHOD_LABEL}
                  title={canUseBoldQr ? BOLD_QR_METHOD_LABEL : "Sin saldo pendiente para QR Bold"}
                  className={`col-span-2 md:col-span-1 h-11 md:h-14 px-2 md:px-4 rounded-2xl flex items-center justify-center md:justify-start gap-2 md:gap-3 border transition-all group ${
                    canUseBoldQr
                      ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 active:scale-[0.98]"
                      : "bg-gray-50 dark:bg-zinc-800 border-transparent text-gray-400 dark:text-zinc-500 cursor-not-allowed"
                  }`}
                >
                  <div className={`p-1.5 md:p-2 rounded-xl transition-colors ${canUseBoldQr ? "bg-emerald-500 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)]" : "bg-gray-200 dark:bg-zinc-700/50"}`}>
                    <QrCode size={18} className="md:w-6 md:h-6" aria-hidden />
                  </div>
                  <span className="text-[11px] md:text-[12px] font-semibold uppercase tracking-wider leading-tight text-left">
                    QR Bold / Bre-B
                    <span className="hidden md:block text-[10px] font-medium normal-case tracking-normal opacity-80">
                      Nequi · DaviPlata · Bancos
                    </span>
                  </span>
                </button>

                <button
                  onClick={() => onOpenChange(false)}
                  className="h-11 md:hidden px-2 rounded-2xl flex items-center justify-center gap-2 border border-rose-500/20 bg-rose-500/5 text-rose-500 active:scale-95 transition-all"
                >
                  <div className="p-1.5 rounded-xl bg-rose-500/20 text-rose-500">
                    <X size={16} />
                  </div>
                  <span className="text-[12px] font-semibold uppercase tracking-wider leading-none">Cerrar</span>
                </button>
              </div>

              <Button
                variant="flat"
                className="hidden md:flex md:mt-auto h-12 font-semibold text-[12px] px-6 rounded-2xl bg-rose-500/10 text-rose-500 tracking-wider uppercase border border-rose-500/20"
                onPress={() => onOpenChange(false)}
              >
                CANCELAR <X size={14} className="ml-1" />
              </Button>
            </div>

            <div className="flex-1 min-w-0 bg-gray-50 dark:bg-zinc-950 pt-3 px-3 md:px-4 pb-3 flex flex-col relative overflow-hidden z-10">
              <header className="mb-3 flex flex-col md:flex-row md:items-end justify-between gap-2 md:gap-3">
                <div className="flex flex-col min-w-0">
                  <h1 className="text-xl md:text-3xl font-semibold text-gray-900 dark:text-white uppercase tracking-tight leading-tight mb-1 text-center md:text-left">
                    {title.split(' ')[0]} <span className={theme.text}>{title.split(' ').slice(1).join(' ')}</span>
                  </h1>
                  <div className="flex items-center justify-center md:justify-start gap-2">
                    <Avatar
                      size="sm"
                      name={client?.name || 'CF'}
                      className={`h-6 w-6 rounded-full ${theme.bgLight} ${theme.text} text-[10px] font-semibold`}
                    />
                    <p className="text-[12px] font-semibold text-gray-600 dark:text-zinc-400 uppercase tracking-wide truncate">
                      {client?.name || 'CONSUMIDOR FINAL'}{client?.dni ? ` · CC ${client.dni}` : ''}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-center md:justify-end gap-2">
                  {nequiPaid > 0 && (
                    <AccumulatedPill
                      label="Nequi"
                      icon={<img src="/logos/nequi.png" className="h-4 w-4 object-contain" alt="Nequi" />}
                      amount={nequiPaid}
                      colorClass="text-[#23004C] dark:text-fuchsia-300"
                      bgClass="bg-[#23004C]/10"
                      borderClass="border-[#23004C]/20 dark:border-fuchsia-500/30"
                    />
                  )}
                  {daviplataPaid > 0 && (
                    <AccumulatedPill
                      label="Daviplata"
                      icon={<img src="/logos/daviplata.png" className="h-4 w-4 object-contain" alt="Daviplata" />}
                      amount={daviplataPaid}
                      colorClass="text-red-600 dark:text-red-400"
                      bgClass="bg-red-500/10"
                      borderClass="border-red-500/20"
                    />
                  )}
                  {cashPaid > 0 && (
                    <AccumulatedPill
                      label="Efectivo"
                      icon={<Banknote size={14} className={theme.text} />}
                      amount={cashPaid}
                      colorClass={theme.text}
                      bgClass={theme.bgLight}
                      borderClass={theme.borderLight}
                    />
                  )}
                  {creditPaid > 0 && (
                    <AccumulatedPill
                      label="Fiado"
                      icon={<Users size={14} className="text-rose-500" />}
                      amount={creditPaid}
                      colorClass="text-rose-600 dark:text-rose-400"
                      bgClass="bg-rose-500/10"
                      borderClass="border-rose-500/20"
                    />
                  )}
                  {(totalAlreadyPaid > 0 || Number(cashTendered) > 0) && (
                    <button
                      type="button"
                      onClick={handleClearPayments}
                      className="px-3 py-1 bg-amber-500/10 border border-amber-500/30 rounded-full flex items-center gap-1.5 hover:bg-amber-500/20 active:scale-95 transition-all"
                    >
                      <Trash2 size={12} className="text-amber-500" />
                      <span className="text-[11px] font-bold text-amber-500 uppercase tracking-wider">LIMPIAR</span>
                    </button>
                  )}
                </div>
              </header>

              {isBlockedTransferRefund && (
                <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-start gap-3 mb-3">
                  <AlertTriangle className="text-amber-500 shrink-0 mt-0.5" size={22} />
                  <div className="flex flex-col gap-1">
                    <span className="text-[12px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider leading-tight">
                      Devolución en efectivo no permitida (venta original en {originalPaymentMethod.toUpperCase()})
                    </span>
                    <span className="text-[13px] font-medium text-amber-700 dark:text-amber-300 leading-snug">
                      No se puede entregar efectivo por caja para devoluciones de compras pagadas por transferencia. El cliente debe llevar más productos por al menos <strong className="text-amber-500 font-bold">${formatCurrency(Math.abs(netExchangeBalance))}</strong> para cubrir el saldo a favor.
                    </span>
                  </div>
                </div>
              )}

              <div className={`grid ${isReturnExchange ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-3'} gap-2 mb-3`}>
                <SummaryTile
                  label="Total a pagar"
                  icon={<Wallet size={12} className="text-rose-500" />}
                  value={totalToPay}
                  valueClassName="text-rose-500"
                  containerClassName="border-gray-100 dark:border-white/5"
                />
                {isReturnExchange && (
                  <SummaryTile
                    label="Saldo a favor"
                    icon={<Zap size={12} className="text-emerald-500" />}
                    value={pendingReturnAmount}
                    valueClassName="text-emerald-500"
                    containerClassName="bg-emerald-500/10 border-emerald-500/20"
                    prefix="-$"
                  />
                )}
                <SummaryTile
                  label={isRefund ? 'Reembolsando' : 'Ya pagado'}
                  icon={<Check size={12} className={theme.text} />}
                  value={totalAlreadyPaid + actualPayment}
                  valueClassName={theme.text}
                  containerClassName="border-gray-100 dark:border-white/5"
                />
                <SummaryTile
                  label={baseReturnRefund > 0 ? 'Cambio a entregar' : (tileShowsChange ? 'Cambio (vueltas)' : 'Restante')}
                  icon={<TrendingUp size={12} className={tileShowsChange ? 'text-emerald-500' : 'text-sky-500'} />}
                  value={tileShowsChange ? (activePaymentTab === 'cash' ? cashHeroValue : baseReturnRefund) : remainingDebt}
                  valueClassName={tileShowsChange ? 'text-emerald-500' : 'text-sky-500'}
                  containerClassName={tileShowsChange
                    ? 'border-emerald-500/50 bg-emerald-500/5'
                    : 'border-gray-100 dark:border-white/5'}
                />
              </div>

              {activePaymentTab === 'cash' ? (
                <div className="flex flex-col flex-1 min-h-0 overflow-y-auto pr-1 custom-scrollbar">
                  {/* Sólo móvil: en escritorio el monto vive en MONTO INGRESADO
                      y el cambio en la tarjeta de resumen "Cambio (vueltas)". */}
                  <div className={`md:hidden p-4 md:p-5 rounded-2xl border-2 flex flex-col justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] relative overflow-hidden transition-colors duration-300 ${
                    showChangeHero
                      ? 'bg-emerald-500/10 border-emerald-500/40'
                      : 'bg-white dark:bg-[#18181b] border-gray-200 dark:border-white/10'
                  }`}>
                    {Number(cashTendered) > 0 ? (
                      <button 
                        type="button"
                        onClick={() => { setCashTendered(''); setDialogAmount(''); }}
                        className="absolute top-2 right-2 z-10 p-1.5 md:p-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 text-rose-500 active:scale-90 transition-all"
                        title="Limpiar efectivo ingresado"
                      >
                        <Trash2 size={16} />
                      </button>
                    ) : (
                      <div className={`absolute top-2 right-2 opacity-10 ${showChangeHero ? 'text-emerald-500' : theme.text}`}>
                        {showChangeHero ? <Zap size={32} /> : <Banknote size={32} />}
                      </div>
                    )}

                    <p className={`text-[11px] font-semibold uppercase mb-2 tracking-wider ${
                      showChangeHero ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-500 dark:text-zinc-400'
                    }`}>
                      {cashHeroLabel}
                    </p>

                    <p className={`text-3xl md:text-5xl font-bold tabular-nums tracking-tight leading-none ${
                      showChangeHero ? 'text-emerald-500' : 'text-gray-900 dark:text-white'
                    }`}>
                      ${formatCurrency(cashHeroValue)}
                    </p>
                  </div>

                   {!isMobileNumpadOpen ? (
                     <>
                      {/* Grilla de denominaciones:
                          - MOVIL: chips compactos h-10 con cifra ("$100.000"),
                            dos columnas; antes era una galeria aspect-[2.2/1]
                            con <img object-cover> que consumia ~462 px solo en
                            billetes y tapaba el resumen y el boton PROCESAR en
                            360x640. El valor funcional (toque rapido para
                            sumar monto) se preserva.
                          - DESKTOP md+: billete real (image) con aspect ratio
                            original.
                      */}
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mt-3 content-start">
                        {[
                          { v: 100000, img: '100.000.jpg' },
                          { v: 50000, img: '50.000.jpg' },
                          { v: 20000, img: '20.000.jpg' },
                          { v: 10000, img: '10.000.jpg' },
                          { v: 5000, img: '5.000.jpg' },
                          { v: 2000, img: '2.000.png' },
                          { v: 1000, img: '1.000.jpg' },
                          { v: 500, img: '500.jpg' },
                          { v: 200, img: '200.jpg' },
                          { v: 100, img: '100.jpg' }
                        ].map(({ v, img }) => (
                          <Button
                            key={v}
                            tabIndex={-1}
                            onMouseDown={(e) => e.preventDefault()}
                            className="h-10 md:h-auto md:aspect-[2.2/1] w-full bg-white dark:bg-zinc-800 border border-gray-100 dark:border-white/5 group active:scale-95 transition-all rounded-xl md:rounded-2xl p-0 overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
                            aria-label={`Agregar $${formatCurrency(v)}`}
                            onPress={() => {
                              setCashTendered(prev => String(Number(prev || 0) + v));
                              setDialogAmount('');
                              if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                              setTimeout(() => {
                                if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                              }, 0);
                            }}
                          >
                            {/* Chip con cifra visible en movil (<md) */}
                            <span className="md:hidden text-[13px] font-semibold tabular-nums text-gray-900 dark:text-white tracking-tight leading-none">
                              ${formatCurrency(v)}
                            </span>
                            {/* Imagen real del billete en escritorio */}
                            <img
                              src={`/logos/${img}`}
                              className="hidden md:block h-full w-full object-cover group-hover:scale-105 transition-transform duration-500"
                              alt={`Billete de ${v}`}
                            />
                          </Button>
                        ))}
                        {/* Teclado: SOLO en celular. En escritorio el numpad ya
                            vive fijo en la columna derecha; este boton con
                            col-span-2 + aspect-ratio salia el doble de alto que
                            un billete y forzaba scroll en la columna central. */}
                        <Button
                          className={`md:hidden h-10 w-full bg-${themeColor}-500 text-white border-none active:scale-95 transition-all rounded-xl p-0 flex flex-row items-center justify-center gap-1.5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-${themeColor}-500/20`}
                          aria-label="Abrir teclado numérico"
                          onPress={() => setIsMobileNumpadOpen(true)}
                        >
                          <Calculator size={16} />
                          <span className="text-[11px] font-semibold uppercase tracking-wider">Teclado</span>
                        </Button>
                      </div>
                    </>
                   ) : (
                    <>
                      {/* Numpad móvil del tab efectivo. Usa el PaymentKeypad
                          unificado con `size="compact"` para igualar la
                          jerarquía visual con el teclado del pad desktop y
                          con el de los tabs digitales. Antes había tres
                          variantes de tamaño distintas; ahora todas comparten
                          el mismo sub-componente. */}
                      <PaymentKeypad
                        size="compact"
                        themeBgClass={theme.bg}
                        containerClassName="mt-3"
                        ariaLabel="Teclado numérico de efectivo"
                        onDigit={(d) => setDialogAmount((p: string) => p + d)}
                        onAdd={handleAddPayment}
                        onClear={() => setDialogAmount("")}
                      />
                      <div className="flex gap-2 mt-3">
                        <Button
                          className="flex-1 h-12 bg-gray-100 dark:bg-zinc-800 text-zinc-900 dark:text-white font-semibold uppercase rounded-2xl text-[12px] tracking-wider active:scale-95 transition-all flex items-center justify-center gap-2"
                          onPress={() => setIsMobileNumpadOpen(false)}
                        >
                          <Grid3X3 size={16} /> BILLETES
                        </Button>
                      </div>
                    </>
                   )}

                   {/* Sticky action bar en movil: siempre alcanzable sin
                       scroll, respeta safe-area iPhone. En desktop queda
                       oculta porque el boton principal vive en el pad
                       derecho. */}
                   <div className="md:hidden sticky bottom-0 left-0 right-0 -mx-3 mt-3 bg-gray-50 dark:bg-zinc-950 border-t border-gray-200 dark:border-white/5 px-3 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
                     <Button
                       className={`h-14 w-full ${theme.bg} text-white font-semibold uppercase rounded-2xl tracking-wider shadow-[0_8px_30px_rgb(0,0,0,0.12)] text-[13px] active:scale-95 transition-all`}
                       onPress={processPayment}
                       isLoading={submittingPayment}
                     >
                       {isMobileNumpadOpen ? 'REALIZAR' : 'PROCESAR PAGO'} <ShieldCheck size={18} className="ml-2" />
                     </Button>
                   </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col min-h-0 overflow-y-auto pr-1 custom-scrollbar">
                  {/* En escritorio el monto ya se ve en "MONTO INGRESADO" del
                      pad derecho; este recuadro sólo se muestra en móvil, donde
                      no existe ese pad. */}
                  <label className={`md:hidden bg-white dark:bg-[#18181b] p-4 md:p-5 rounded-2xl border-2 border-${themeColor}-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col items-center justify-center gap-2 mb-3 relative overflow-hidden cursor-text`}>
                    <div className={`absolute inset-0 bg-${themeColor}-500/5`} />
                    <div className="text-center relative z-10 w-full">
                      <p className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 tracking-wider uppercase mb-2">
                        {activePaymentTab === 'credit' ? 'MONTO A FIAR' : `MONTO POR ${activePaymentTab}`}
                      </p>
                      <div className="flex items-center justify-center gap-1">
                        <span className={`${theme.text} font-semibold text-3xl md:text-5xl tracking-tight`}>$</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          aria-label={`Monto a pagar por ${activePaymentTab}`}
                          value={(activePaymentTab === 'credit' && !dialogAmount) ? '' : (dialogAmount ? formatCurrency(Number(dialogAmount)) : formatCurrency(Number(amountToPayRaw)))}
                          onFocus={(e) => {
                            const val = e.target.value.replace(/\D/g, '');
                            e.target.value = val;
                            e.target.select();
                          }}
                          onChange={(e) => {
                            const val = e.target.value.replace(/\D/g, '');
                            setDialogAmount(val);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              processPayment();
                            }
                          }}
                          className={`w-full max-w-[280px] font-bold text-3xl md:text-5xl tracking-tight ${theme.text} bg-transparent tabular-nums text-center focus:outline-none leading-none`}
                        />
                      </div>
                    </div>
                  </label>

                  {activePaymentTab === 'credit' && (
                    <div className="mb-4 animate-in slide-in-from-top-2 duration-300">
                        {(!client || client.id === "0" || client.name === "CONSUMIDOR FINAL") ? (
                            <div className="bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/20 rounded-2xl p-4 flex flex-col gap-2 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                <p className="text-amber-700 dark:text-amber-400 font-semibold text-[13px] flex items-center gap-2 uppercase tracking-wider">
                                    ⚠️ Cliente no seleccionado
                                </p>
                                <p className="text-[12px] text-amber-700 dark:text-amber-500/80 font-medium leading-relaxed">
                                    No se puede fiar a Consumidor Final. Cancela y selecciona un cliente registrado para asignar la deuda, o pulsa el botón de abajo.
                                </p>
                                {onClientSelectorOpen && (
                                    <Button
                                        color="warning"
                                        size="sm"
                                        className="font-semibold text-[12px] uppercase tracking-wider rounded-xl"
                                        onPress={onClientSelectorOpen}
                                    >
                                        Seleccionar cliente
                                    </Button>
                                )}
                            </div>
                        ) : (
                            <div className={`border rounded-2xl p-4 transition-all duration-300 shadow-[0_8px_30px_rgb(0,0,0,0.12)] ${
                                amountToPayRaw > (client.creditLimit - client.currentCredit)
                                    ? 'bg-rose-50 border-rose-200 dark:bg-rose-500/10 dark:border-rose-500/20'
                                    : 'bg-blue-50 border-blue-200 dark:bg-blue-500/10 dark:border-blue-500/20'
                            }`}>
                                <div className="flex items-center justify-between mb-3">
                                    <p className={`font-semibold text-[12px] uppercase tracking-wider ${
                                        amountToPayRaw > (client.creditLimit - client.currentCredit)
                                            ? 'text-rose-600 dark:text-rose-400'
                                            : 'text-blue-600 dark:text-blue-400'
                                    }`}>
                                        Cupo de crédito
                                    </p>
                                    <Users size={16} className={ amountToPayRaw > (client.creditLimit - client.currentCredit) ? 'text-rose-500' : 'text-blue-500'} />
                                </div>

                                <div className="grid grid-cols-3 gap-2">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-wider">Deuda actual</span>
                                        <span className="text-[15px] font-semibold text-gray-800 dark:text-zinc-200 tabular-nums tracking-tight">${formatCurrency(client.currentCredit)}</span>
                                    </div>
                                    <div className="flex flex-col gap-1 border-x border-gray-200 dark:border-white/5 px-2">
                                        <span className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-wider">Cupo máximo</span>
                                        <span className="text-[15px] font-semibold text-gray-800 dark:text-zinc-200 tabular-nums tracking-tight">${formatCurrency(client.creditLimit)}</span>
                                    </div>
                                    <div className="flex flex-col gap-1 items-end">
                                        <span className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-wider">Disponible</span>
                                        <span className={`text-[15px] font-semibold tabular-nums tracking-tight ${
                                            (client.creditLimit - client.currentCredit) <= 0 ? 'text-rose-500' : 'text-emerald-600 dark:text-emerald-400'
                                        }`}>
                                            ${formatCurrency(client.creditLimit - client.currentCredit)}
                                        </span>
                                    </div>
                                </div>

                                {amountToPayRaw > (client.creditLimit - client.currentCredit) && (
                                    <div className="mt-3 pt-3 border-t border-rose-200 dark:border-rose-500/20">
                                        <p className="text-[12px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-wider">
                                            🚨 Esta venta supera el cupo disponible
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                  )}

                  {/* Boton explicito '+ AGREGAR CANAL' visible en MOVIL para
                      corregir pagos combinados desde el historial. Antes el
                      '+' solo existia en el pad lateral de escritorio y en
                      movil era imposible acumular. Aparece siempre que la
                      pestana no sea credit, y queda deshabilitado si no hay
                      monto digitado ni restante por asignar. */}
                  <Button
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    isDisabled={(currentDialogVal <= 0 && remainingDebt <= 0) || activePaymentTab === 'credit'}
                    className={`md:hidden h-12 mb-3 w-full font-semibold uppercase rounded-2xl text-[12px] tracking-wider shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 transition-all flex items-center justify-center gap-2 ${
                      (currentDialogVal <= 0 && remainingDebt <= 0) || activePaymentTab === 'credit'
                        ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 border border-zinc-200 dark:border-white/5 cursor-not-allowed'
                        : `${theme.bg} text-white border border-transparent`
                    }`}
                    onPress={handleAddPayment}
                    aria-label="Agregar canal al pago combinado"
                  >
                    + AGREGAR CANAL
                  </Button>

                  {/* Numpad móvil del tab Nequi/Daviplata/Fiado. Mismo
                      componente PaymentKeypad `size="compact"` que el
                      numpad del tab efectivo, para que el cajero no vea
                      dos teclados distintos al cambiar de método en móvil. */}
                  <PaymentKeypad
                    size="compact"
                    themeBgClass={theme.bg}
                    ariaLabel={`Teclado numérico de ${activePaymentTab === 'credit' ? 'fiado' : activePaymentTab}`}
                    onDigit={(d) => setDialogAmount((p: string) => p + d)}
                    onAdd={handleAddPayment}
                    onClear={() => setDialogAmount("")}
                  />

                  {onReasonChange && (
                    <div className="mt-4 animate-in slide-in-from-top-2 duration-300">
                      <label className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-wider mb-2 ml-1 flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${theme.bg}`} /> Justificación / nota
                      </label>
                      <input
                        type="text"
                        value={reason || ''}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => onReasonChange(e.target.value)}
                        placeholder="Motivo..."
                        className={`w-full h-12 bg-white dark:bg-[#18181b] border border-gray-200 dark:border-white/10 rounded-2xl px-4 text-[13px] font-medium focus:outline-none focus:border-${theme.ring} transition-all placeholder:text-gray-400 dark:placeholder:text-zinc-600 shadow-[0_8px_30px_rgb(0,0,0,0.12)]`}
                      />
                    </div>
                  )}

                  <Button
                    className={`md:hidden h-14 w-full font-semibold uppercase rounded-2xl mt-4 sticky bottom-0 shadow-[0_8px_30px_rgb(0,0,0,0.12)] text-[13px] tracking-wider active:scale-95 transition-all mb-[max(env(safe-area-inset-bottom),0.5rem)] ${
                        isCreditInvalid || isOverCreditLimit || isBlockedTransferRefund ? 'bg-amber-500/20 text-amber-500 border border-amber-500/30 cursor-not-allowed' : `${theme.bg} text-white`
                    }`}
                    onPress={processPayment}
                    isLoading={submittingPayment}
                    isDisabled={isCreditInvalid || isOverCreditLimit || isBlockedTransferRefund}
                  >
                    {primaryActionLabel} <Check size={18} className="ml-2" />
                  </Button>
                </div>
              )}
            </div>

            {/* Teclado Pad Derecho Maestro — solo escritorio.
                `hidden md:flex` lo saca del DOM visual en movil pero el
                `shrink-0` sigue siendo clave en desktop para que no se
                comprima al tener mucho contenido en la columna central. */}
            <div className="hidden md:flex w-[280px] shrink-0 min-w-0 bg-white dark:bg-[#18181b] border-l border-gray-200 dark:border-white/5 p-3 flex-col gap-2.5 z-20">
              <label className="bg-gray-50 dark:bg-zinc-950 p-3 rounded-2xl border border-gray-200 dark:border-white/10 text-right shadow-inner relative overflow-hidden cursor-text">
                <div className={`absolute top-2 left-2 opacity-5 ${theme.text}`}><Calculator size={44} /></div>
                <p className={`text-[11px] font-semibold ${theme.text} uppercase tracking-wider flex items-center justify-end gap-2 relative z-10 mb-2`}>
                  <Calculator size={13} /> Monto ingresado
                </p>
                <div className="flex items-center justify-end gap-1 relative z-10">
                  <span className={`${theme.text} font-semibold text-3xl md:text-5xl tracking-tight`}>$</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label="Monto ingresado"
                      value={dialogAmount ? formatCurrency(Number(dialogAmount)) : formatCurrency(Number(amountToPayRaw))}
                      onFocus={(e) => {
                        const val = e.target.value.replace(/\D/g, '');
                        e.target.value = val;
                        e.target.select();
                      }}
                      onChange={(e) => {
                        const val = e.target.value.replace(/\D/g, '');
                        setDialogAmount(val);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          processPayment();
                        }
                      }}
                    className={`w-full font-bold text-3xl md:text-5xl tracking-tight ${theme.text} bg-transparent border-none text-right focus:outline-none tabular-nums leading-none`}
                  />
                </div>
              </label>

              {onReasonChange && (
                <div className="animate-in slide-in-from-top-2 duration-300">
                  <label className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-wider mb-2 ml-1 flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${theme.bg}`} /> Justificación / nota
                  </label>
                  <input
                    type="text"
                    value={reason || ''}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => onReasonChange(e.target.value)}
                    placeholder="Escribir motivo..."
                    className={`w-full h-11 bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-xl px-4 text-[13px] font-medium focus:outline-none focus:border-${theme.ring} transition-all placeholder:text-gray-400 dark:placeholder:text-zinc-600 shadow-inner`}
                  />
                </div>
              )}
              {/* Numpad desktop fijo. Usa el mismo PaymentKeypad que el
                  móvil, con `size="tall"` para elevar la altura táctil al
                  nivel que exige una pantalla de cajero (h-14 text-xl). */}
              <PaymentKeypad
                size="tall"
                themeBgClass={theme.bg}
                stretchVertical
                containerClassName="pb-2"
                ariaLabel="Teclado numérico de monto (escritorio)"
                onDigit={(d) => setDialogAmount((p: string) => p + d)}
                onAdd={handleAddPayment}
                onClear={() => {
                  setDialogAmount("");
                  // La papelera del recuadro de efectivo sólo existe en móvil.
                  if (activePaymentTab === 'cash') setCashTendered('');
                }}
              />
              <Button
                className={`h-16 font-semibold uppercase rounded-2xl tracking-wider shadow-[0_20px_50px_rgba(0,0,0,0.1)] active:scale-95 transition-all text-[13px] border-b-4 ${
                    isCreditInvalid || isOverCreditLimit || isBlockedTransferRefund
                        ? 'bg-amber-500/20 text-amber-500 border-amber-500/40 cursor-not-allowed'
                        : 'bg-gray-900 dark:bg-white text-white dark:text-black border-gray-600 dark:border-gray-300'
                }`}
                onPress={processPayment}
                isLoading={submittingPayment}
                isDisabled={isCreditInvalid || isOverCreditLimit || isBlockedTransferRefund}
              >
                {desktopActionLabel} <ShieldCheck size={20} className="ml-2" />
              </Button>
            </div>
          </div>
        )}
        </ModalContent>

        {/* OVERLAY DE SEGURIDAD ANTIDUPLICADO */}
        {!showSuccessScreen && (submittingPayment || isProcessingRef.current) && (
          <div className="absolute inset-0 z-[999] flex flex-col items-center justify-center bg-white dark:bg-zinc-950/95 animate-in fade-in duration-300">
            <div className="bg-white dark:bg-[#18181b] p-8 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col items-center gap-5 border border-black/5 dark:border-white/10">
              <div className="relative">
                <div className={`h-20 w-20 rounded-full border-4 ${theme.border} border-t-transparent animate-spin`} />
                <div className="absolute inset-0 flex items-center justify-center">
                  <ShieldCheck className={`h-8 w-8 ${theme.text}`} />
                </div>
              </div>
              <div className="flex flex-col items-center text-center">
                <h3 className="text-xl font-semibold text-gray-900 dark:text-white uppercase tracking-tight">
                  Procesando <span className={theme.text}>pago</span>
                </h3>
                <p className="text-[12px] font-medium text-gray-500 dark:text-zinc-400 mt-1">
                  No cierres esta ventana.
                </p>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
