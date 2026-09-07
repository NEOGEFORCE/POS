"use client";

import { useEffect, useState } from "react";
import { Check, DollarSign, Pencil, Sparkles, Trash2, Truck, Wand2, X } from "lucide-react";
import { Button } from "@heroui/react";

import { formatPrice } from "@/lib/utils";
import { STOCK_HEALTH, getCoverageDays, getStockHealth } from "@/lib/stock-health.mjs";
import { LEAD_TIME_SOURCE, describeLeadTimeSource } from "@/lib/order-scheduling.mjs";

import type { ABCCategory, RestockSuggestion } from "../hooks/useSmartRestock";

const categoryLabels: Record<ABCCategory, string> = {
  A: "Alta rotación",
  B: "Rotación media",
  C: "Baja rotación",
};

const categoryStyles: Record<ABCCategory, string> = {
  A: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300",
  B: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  C: "border-zinc-400/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300",
};

/** Estilos del semáforo. Un color por nivel, sin ambigüedad entre temas.
 *  Regla del dueño (25/75): rojo <25 %, amarillo 25-75 %, verde >=75 %.
 *  El nivel BAJO desapareció: el rango 75-100 % ahora es verde. */
const healthStyles: Record<string, { chip: string; bar: string; dot: string }> = {
  [STOCK_HEALTH.CRITICAL]: {
    chip: "border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300",
    bar: "bg-rose-500",
    dot: "bg-rose-500",
  },
  [STOCK_HEALTH.WARNING]: {
    chip: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    bar: "bg-amber-500",
    dot: "bg-amber-500",
  },
  [STOCK_HEALTH.OPTIMAL]: {
    chip: "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    bar: "bg-emerald-500",
    dot: "bg-emerald-500",
  },
  [STOCK_HEALTH.UNSET]: {
    chip: "border-zinc-400/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300",
    bar: "bg-zinc-400",
    dot: "bg-zinc-400",
  },
};

interface MetricProps {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}

function Metric({ label, value, hint, emphasis }: MetricProps) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50/80 px-2.5 py-2 dark:border-white/10 dark:bg-white/[0.03]">
      <p className="text-[9px] font-bold uppercase leading-tight tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </p>
      <p className={`leading-tight ${emphasis ? "text-base font-black" : "text-sm font-bold"} text-zinc-900 dark:text-white`}>
        {value}
      </p>
      {hint && <p className="text-[9px] leading-tight text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </div>
  );
}

export interface SuggestionCardProps {
  item: RestockSuggestion;
  quantity: number;
  onQuantityChange: (productId: string, quantity: number) => void;
  /** Guarda el mínimo en el producto. Debe resolver cuando el backend confirmó. */
  onSaveMinStock: (productId: string, minStock: number) => Promise<boolean>;
  /** Quita el producto del proveedor del grupo. */
  onUnlinkSupplier: (item: RestockSuggestion) => void;
  /** Sólo se puede desasociar cuando el grupo tiene proveedor real. */
  canUnlink: boolean;
  /** Abre el único modal compartido para asignar un proveedor. */
  onLinkSupplier: (item: RestockSuggestion) => void;
  /** Sólo se muestra para productos sin proveedor. */
  canLink: boolean;
}

export function SuggestionCard({
  item,
  quantity,
  onQuantityChange,
  onSaveMinStock,
  onUnlinkSupplier,
  canUnlink,
  onLinkSupplier,
  canLink,
}: SuggestionCardProps) {
  // El stock vivo es el del producto en este momento; el de las métricas es del
  // último recálculo. Para el semáforo manda el vivo.
  const stock = typeof item.liveStock === "number" ? item.liveStock : item.currentStock;
  const minStock = item.minStock ?? 0;
  const health = getStockHealth(stock, minStock);
  const styles = healthStyles[health.level] ?? healthStyles[STOCK_HEALTH.UNSET];
  const coverage = getCoverageDays(stock, item.avgDailySales);
  const fillPercent = minStock > 0 ? Math.min(100, Math.round((Math.max(0, stock) / minStock) * 100)) : 0;

  const [editingMin, setEditingMin] = useState(false);
  // Igual que la cantidad: en cero el campo va vacío, nunca con un "0" que se
  // concatene con lo que se escriba.
  const [minDraft, setMinDraft] = useState(minStock > 0 ? String(minStock) : "");
  const [savingMin, setSavingMin] = useState(false);

  useEffect(() => {
    if (!editingMin) setMinDraft(minStock > 0 ? String(minStock) : "");
  }, [minStock, editingMin]);

  const commitMinStock = async () => {
    const raw = minDraft.trim();
    const parsed = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    if (parsed === minStock) {
      setEditingMin(false);
      return;
    }
    setSavingMin(true);
    const saved = await onSaveMinStock(item.productId, parsed);
    setSavingMin(false);
    if (saved) setEditingMin(false);
  };

  // Sugerencia del backend para ajustar el minimo. Fase 1 acepta ambas
  // direcciones: SUBIR (increase) cuando el minimo se queda corto para la
  // demanda observada, o BAJAR (decrease) cuando esta muy por encima de lo que
  // realmente se vende. La aplicacion es SIEMPRE manual: solo el boton
  // dispara el PATCH, nunca un useEffect.
  const rawSuggestedMin = item.suggestedMinStock;
  const suggestedMinStock =
    typeof rawSuggestedMin === "number" && Number.isFinite(rawSuggestedMin) && rawSuggestedMin >= 0
      ? Math.round(rawSuggestedMin)
      : null;
  // Direccion del cambio segun el backend. Si el campo no llega, la inferimos
  // del delta entre sugerido y actual. Se muestra el bloque solo si hay
  // diferencia real (no se propone "cambiar de 20 a 20").
  const suggestedMinDirection: "increase" | "decrease" | null =
    suggestedMinStock === null
      ? null
      : item.suggestedMinStockReason === "increase"
        ? "increase"
        : item.suggestedMinStockReason === "decrease"
          ? "decrease"
          : suggestedMinStock > minStock
            ? "increase"
            : suggestedMinStock < minStock
              ? "decrease"
              : null;
  const showMinSuggestion =
    suggestedMinStock !== null &&
    suggestedMinDirection !== null &&
    suggestedMinStock !== minStock &&
    // Para "increase" no exigimos minStock > 0 (podria estar sin configurar y
    // el back propone empezar en X). Para "decrease" solo tiene sentido si hay
    // minimo actual mayor que 0.
    (suggestedMinDirection === "increase" || minStock > 0);
  const [applyingSuggestedMin, setApplyingSuggestedMin] = useState(false);

  // Linea compacta de demanda 30/90. Se muestra solo si el backend envia al
  // menos uno de los promedios; el resto de valores degrada a lo que ya
  // teniamos (avgDailySales general).
  const daily30 = typeof item.avgDailySales30d === "number" && Number.isFinite(item.avgDailySales30d)
    ? item.avgDailySales30d
    : null;
  const daily90 = typeof item.avgDailySales90d === "number" && Number.isFinite(item.avgDailySales90d)
    ? item.avgDailySales90d
    : null;
  const bestDaily = daily30 !== null && daily90 !== null
    ? Math.max(daily30, daily90)
    : daily30 ?? daily90 ?? (Number.isFinite(item.avgDailySales) ? item.avgDailySales : 0);
  const hasDualSignal = daily30 !== null || daily90 !== null;

  const applySuggestedMinStock = async () => {
    if (!showMinSuggestion || suggestedMinStock === null) return;
    setApplyingSuggestedMin(true);
    const saved = await onSaveMinStock(item.productId, suggestedMinStock);
    setApplyingSuggestedMin(false);
    // No hace falta ajustar minDraft acá: el useEffect de arriba lo sincroniza
    // en cuanto el padre revalida y llega el nuevo minStock por props.
    if (saved && editingMin) setEditingMin(false);
  };

  // Mensaje en lenguaje de tendero: usa el que mande el backend si viene;
  // si no, se compone uno breve segun la direccion sugerida.
  const suggestedMinReason = (() => {
    if (!showMinSuggestion || suggestedMinStock === null || !suggestedMinDirection) return "";
    // El campo suggestedMinStockReason del contrato v2 es enum ("increase"|
    // "decrease"), no un texto libre. Cualquier otro string se trata como
    // razon libre para no romper si el backend cambia.
    const rawReason = item.suggestedMinStockReason?.trim();
    if (rawReason && rawReason !== "increase" && rawReason !== "decrease") {
      return rawReason;
    }
    const dailyRaw = daily30 ?? daily90 ?? (Number.isFinite(item.avgDailySales) ? item.avgDailySales : 0);
    const ventaTxt = dailyRaw > 0
      ? `Vende ${dailyRaw.toFixed(2)}/dia`
      : "Casi no se vende";
    if (suggestedMinDirection === "increase") {
      return `${ventaTxt}: el minimo de ${minStock} se queda corto para lo que se vende. Subirlo a ${suggestedMinStock} evita quiebres antes de la proxima entrega.`;
    }
    return `${ventaTxt}: el minimo de ${minStock} esta muy por encima de lo que rota. Bajarlo a ${suggestedMinStock} deja de aparecer en rojo o amarillo sin arriesgar quiebres.`;
  })();

  const selectedSavings = quantity * (item.cheaperSupplier?.savings ?? 0);
  const suggestion = Math.max(0, item.suggestedOrderQty);

  // Fuente del "ideal": si el backend confirma dias configurados, decirlo. Si
  // el aprendizaje del sistema esta activo, se dice "aprendido" para no
  // vender lo aprendido como si fuera lo que el dueno configuro. Si es una
  // estimacion, se muestra tal cual.
  const leadSource = describeLeadTimeSource(item.leadTimeSource);
  const idealHint = item.leadTimeSource === LEAD_TIME_SOURCE.CONFIGURED_DAYS
    ? "segun dias configurados"
    : item.leadTimeSource === LEAD_TIME_SOURCE.LEARNED_DAYS
      ? "segun agenda aprendida"
      : item.abcCategory === "C"
        ? `hasta la visita (${leadSource.label})`
        : `visita + margen (${leadSource.label})`;
  const idealLabel = item.leadTimeSource === LEAD_TIME_SOURCE.CONFIGURED_DAYS
    ? `Ideal ${item.supplierLeadDays} d · agenda`
    : item.leadTimeSource === LEAD_TIME_SOURCE.LEARNED_DAYS
      ? `Ideal ${item.supplierLeadDays} d · aprendido`
      : `Ideal ${item.supplierLeadDays} d · estimado`;

  return (
    <article className="grid gap-3 p-3.5 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-4">
      <div className="min-w-0 space-y-2.5">
        {/* Identidad y estado */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-black uppercase ${styles.chip}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${styles.dot}`} aria-hidden="true" />
            {health.label}
          </span>
          <h3 className="truncate text-sm font-black text-zinc-900 dark:text-white">{item.productName}</h3>
          <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase ${categoryStyles[item.abcCategory]}`}>
            {item.abcCategory} · {categoryLabels[item.abcCategory]}
          </span>
          {item.inTransit && (
            <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold text-sky-700 dark:text-sky-300">
              <Truck size={11} /> {item.inTransitQty} en camino · ya pedido
            </span>
          )}
        </div>

        {/* Barra de existencia contra el mínimo */}
        {minStock > 0 && (
          <div className="max-w-md">
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-white/10">
              <div
                className={`h-full rounded-full transition-all ${styles.bar}`}
                style={{ width: `${Math.max(fillPercent, stock > 0 ? 4 : 0)}%` }}
                role="progressbar"
                aria-valuenow={fillPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Existencia de ${item.productName} frente al mínimo`}
              />
            </div>
            <p className="mt-1 text-[9px] font-medium text-zinc-500 dark:text-zinc-400">
              {stock} de {minStock} mínimo · {fillPercent}%
            </p>
          </div>
        )}

        {/* Cifras que importan, con nombre claro */}
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-5">
          <Metric label="Existencia" value={String(stock)} emphasis />

          <div className="rounded-xl border border-zinc-200 bg-zinc-50/80 px-2.5 py-2 dark:border-white/10 dark:bg-white/[0.03]">
            <p className="text-[9px] font-bold uppercase leading-tight tracking-wide text-zinc-500 dark:text-zinc-400">
              Stock mínimo
            </p>
            {editingMin ? (
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={minDraft}
                  autoFocus
                  disabled={savingMin}
                  onChange={(event) => setMinDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void commitMinStock();
                    if (event.key === "Escape") setEditingMin(false);
                  }}
                  aria-label={`Stock mínimo de ${item.productName}`}
                  className="w-12 rounded-md border border-indigo-400 bg-white px-1 text-sm font-bold text-zinc-900 outline-none dark:bg-zinc-900 dark:text-white"
                />
                <button
                  type="button"
                  onClick={() => void commitMinStock()}
                  disabled={savingMin}
                  aria-label="Guardar stock mínimo"
                  className="rounded-md p-1 text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-50 dark:text-emerald-400"
                >
                  <Check size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setEditingMin(false)}
                  disabled={savingMin}
                  aria-label="Cancelar edición del stock mínimo"
                  className="rounded-md p-1 text-zinc-500 hover:bg-zinc-500/10 disabled:opacity-50"
                >
                  <X size={13} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setEditingMin(true)}
                aria-label={`Editar stock mínimo de ${item.productName}`}
                className="flex items-center gap-1 text-sm font-bold text-zinc-900 hover:text-indigo-600 dark:text-white dark:hover:text-indigo-400"
              >
                {minStock > 0 ? minStock : "—"}
                <Pencil size={11} className="opacity-60" />
              </button>
            )}
          </div>

          <Metric label="Cobertura" value={coverage === null ? "—" : `${coverage} d`} hint={coverage === null ? "sin rotación" : "al ritmo actual"} />
          <Metric
            label="Venta 14 días"
            value={String(
              typeof item.totalSold14d === "number" && Number.isFinite(item.totalSold14d)
                ? item.totalSold14d
                : item.totalSold30d
            )}
            hint={
              typeof item.avgDailySales14d === "number" && Number.isFinite(item.avgDailySales14d)
                ? `${item.avgDailySales14d.toFixed(2)}/día · señal principal`
                : `${item.avgDailySales.toFixed(2)}/día`
            }
          />
          <Metric
            label={idealLabel}
            value={String(item.idealStock)}
            hint={idealHint}
          />
          {item.inTransitQty > 0 && (
            <Metric
              label="Con lo pedido"
              value={String(stock + item.inTransitQty)}
              hint={`+${item.inTransitQty} en camino`}
            />
          )}
          {item.daysZeroStock > 0 && (
            <Metric label="Días agotado" value={`${item.daysZeroStock} d`} hint="en los últimos 30" />
          )}
        </div>

        {/* Linea compacta de demanda 30/90. Solo aparece si el backend la envia. */}
        {hasDualSignal && (
          <p className="text-[10px] leading-snug text-zinc-600 dark:text-zinc-300">
            Demanda: <strong className="text-zinc-900 dark:text-white">{bestDaily.toFixed(2)}/dia</strong>{" "}
            <span className="text-zinc-500 dark:text-zinc-400">(últimos 14 días · señal principal)</span>
            {daily30 !== null && daily90 !== null && (
              <span className="ml-1 text-zinc-500 dark:text-zinc-400">
                · 30d {daily30.toFixed(2)} · 90d {daily90.toFixed(2)}
              </span>
            )}
            {typeof item.totalSold90d === "number" && Number.isFinite(item.totalSold90d) && (
              <span className="ml-1 text-zinc-500 dark:text-zinc-400">· 90d total {item.totalSold90d}</span>
            )}
          </p>
        )}

        {/* Historia de reposición */}
        {typeof item.daysSinceReception === "number" && (
          <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
            Recibido hace <strong className="text-zinc-700 dark:text-zinc-200">{item.daysSinceReception} d</strong>
            {typeof item.soldSinceReception === "number" && item.soldSinceReception > 0
              ? ` · ${item.soldSinceReception} vendidas desde entonces`
              : " · sin ventas desde entonces"}
          </p>
        )}

        {/* Veredicto de la IA */}
        {item.recommendation && (
          <p
            className={`inline-flex items-start gap-1.5 rounded-lg px-2 py-1 text-[11px] font-bold ${
              item.recommendationLevel === "urgent"
                ? "bg-rose-500/10 text-rose-700 dark:text-rose-300"
                : item.recommendationLevel === "order"
                  ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : item.recommendationLevel === "wait"
                    ? "bg-sky-500/10 text-sky-700 dark:text-sky-300"
                    : "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400"
            }`}
          >
            <Sparkles size={12} className="mt-0.5 shrink-0" />
            <span>{item.recommendation}</span>
          </p>
        )}

        {/*
          Sugerencia de mínimo del backend. Un solo click aplica el valor
          nuevo reusando el mismo camino de guardado que ya usa la edición
          manual (onSaveMinStock). Fase 1: acepta subir Y bajar el minimo,
          pero SIEMPRE con click manual. Degrada limpio: si el backend no
          manda el campo, este bloque directamente no se renderiza.
        */}
        {showMinSuggestion && suggestedMinStock !== null && suggestedMinDirection !== null && (
          <div
            className={`flex max-w-2xl flex-col gap-2 rounded-2xl border p-2.5 text-[11px] shadow-[0_8px_30px_rgb(0,0,0,0.12)] sm:flex-row sm:items-center sm:justify-between ${
              suggestedMinDirection === "increase"
                ? "border-rose-500/30 bg-rose-500/10 text-rose-900 dark:text-rose-100"
                : "border-indigo-500/30 bg-indigo-500/10 text-indigo-900 dark:text-indigo-100"
            }`}
            role="note"
            aria-label={`Sugerencia de ${suggestedMinDirection === "increase" ? "subir" : "bajar"} el stock mínimo de ${item.productName}`}
          >
            <div className="flex items-start gap-2">
              <Wand2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                Sugerido {suggestedMinDirection === "increase" ? "subir" : "bajar"} el minimo de{" "}
                <strong>{minStock > 0 ? minStock : "—"}</strong> a{" "}
                <strong>{suggestedMinStock}</strong>. {suggestedMinReason}
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              color={suggestedMinDirection === "increase" ? "danger" : "primary"}
              variant="solid"
              radius="lg"
              onPress={() => void applySuggestedMinStock()}
              isLoading={applyingSuggestedMin}
              isDisabled={applyingSuggestedMin}
              startContent={applyingSuggestedMin ? null : <Check size={14} aria-hidden="true" />}
              className="shrink-0 rounded-2xl font-black uppercase tracking-wide shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95"
              aria-label={`Aplicar mínimo sugerido de ${suggestedMinStock} a ${item.productName}`}
            >
              {applyingSuggestedMin
                ? "Aplicando"
                : suggestedMinDirection === "increase"
                  ? `Subir a ${suggestedMinStock}`
                  : `Bajar a ${suggestedMinStock}`}
            </Button>
          </div>
        )}

        {item.cheaperSupplier && (
          <div
            className="flex max-w-2xl items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2 text-[11px] text-emerald-800 dark:text-emerald-200"
            role="note"
            aria-label="Informacion de proveedor alternativo mas barato"
          >
            <DollarSign size={14} className="mt-0.5 shrink-0" />
            <span>
              Este producto lo trae mas barato <strong>{item.cheaperSupplier.supplierName}</strong> a{" "}
              {formatPrice(item.cheaperSupplier.unitPrice)}. Te ahorras{" "}
              {formatPrice(item.cheaperSupplier.savings)}/unidad
              {selectedSavings > 0
                ? ` (${formatPrice(selectedSavings)} en esta seleccion)`
                : typeof item.cheaperSupplier.totalSavings === "number" && item.cheaperSupplier.totalSavings > 0
                  ? ` · sugerido ${formatPrice(item.cheaperSupplier.totalSavings)}`
                  : ""}
              . <span className="opacity-70">Solo informativo, no cambia el proveedor de la orden.</span>
            </span>
          </div>
        )}

        <p className="text-[10px] text-zinc-400 dark:text-zinc-500">{item.productId}</p>
      </div>

      {/* Acciones */}
      <div className="flex items-center justify-between gap-2 md:flex-col md:items-end md:gap-2.5">
        <div className="flex items-center gap-2">
          <div className="text-right">
            <p className="flex items-center justify-end gap-1 text-[9px] font-bold uppercase tracking-wide text-indigo-500 dark:text-indigo-400">
              <Sparkles size={10} /> Sugerencia IA
            </p>
            <button
              type="button"
              onClick={() => onQuantityChange(item.productId, suggestion)}
              disabled={suggestion <= 0}
              aria-label={`Aplicar sugerencia de ${suggestion} para ${item.productName}`}
              className="text-xl font-black leading-none text-indigo-600 hover:underline disabled:cursor-not-allowed disabled:text-zinc-400 disabled:no-underline dark:text-indigo-400 dark:disabled:text-zinc-600"
            >
              {suggestion}
            </button>
          </div>
          {canUnlink && (
            <button
              type="button"
              onClick={() => onUnlinkSupplier(item)}
              aria-label={`Quitar ${item.productName} de este proveedor`}
              title="Quitar de este proveedor"
              className="rounded-lg border border-zinc-200 p-1.5 text-zinc-400 transition-colors hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-600 dark:border-white/10 dark:hover:text-rose-400"
            >
              <Trash2 size={14} />
            </button>
          )}
          {canLink && (
            <Button
              type="button"
              size="sm"
              color="warning"
              variant="flat"
              onPress={() => onLinkSupplier(item)}
              startContent={<Truck size={13} aria-hidden="true" />}
              aria-label={`Vincular proveedor para ${item.productName}`}
              className="rounded-xl text-[10px] font-black uppercase"
            >
              Vincular proveedor
            </Button>
          )}
        </div>

        <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 p-1 dark:border-white/10 dark:bg-zinc-950">
          <button
            type="button"
            aria-label={`Restar ${item.productName}`}
            className="h-8 w-8 rounded-lg font-black text-zinc-700 hover:bg-zinc-200 dark:text-zinc-200 dark:hover:bg-zinc-800"
            onClick={() => onQuantityChange(item.productId, quantity - 1)}
          >
            −
          </button>
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            /* Vacío en lugar de 0: con un "0" impreso, escribir 2 dejaba 20. */
            value={quantity === 0 ? "" : String(quantity)}
            placeholder="0"
            onChange={(event) => {
              const raw = event.target.value.trim();
              if (raw === "") {
                onQuantityChange(item.productId, 0);
                return;
              }
              const parsed = Number(raw);
              onQuantityChange(item.productId, Number.isFinite(parsed) ? parsed : 0);
            }}
            aria-label={`Cantidad de ${item.productName}`}
            className="w-14 bg-transparent text-center text-sm font-black text-zinc-900 outline-none placeholder:font-normal placeholder:text-zinc-400 dark:text-white dark:placeholder:text-zinc-600"
          />
          <button
            type="button"
            aria-label={`Sumar ${item.productName}`}
            className="h-8 w-8 rounded-lg font-black text-zinc-700 hover:bg-zinc-200 dark:text-zinc-200 dark:hover:bg-zinc-800"
            onClick={() => onQuantityChange(item.productId, quantity + 1)}
          >
            +
          </button>
        </div>
      </div>
    </article>
  );
}
