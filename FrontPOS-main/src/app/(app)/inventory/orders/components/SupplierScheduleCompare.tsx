"use client";

import { AlertTriangle, Brain, CalendarDays, Info, Settings, UserCheck } from "lucide-react";

import { Button } from "@heroui/react";

import {
  LEARN_MIN_SAMPLES,
  summarizeSupplierAgenda,
} from "@/lib/order-scheduling.mjs";

import type { RestockSuggestion } from "../hooks/useSmartRestock";

interface SupplierScheduleCompareProps {
  items: RestockSuggestion[];
  supplierName: string;
  onEditSchedule?: () => void;
}

// Capitaliza para mostrar. Los helpers de comparacion trabajan con nombres
// normalizados (minusculas sin acentos), pero al pintar queremos "Lunes".
function toDisplay(day: string): string {
  if (!day) return "";
  const map: Record<string, string> = {
    lunes: "Lunes",
    martes: "Martes",
    miercoles: "Miércoles",
    jueves: "Jueves",
    viernes: "Viernes",
    sabado: "Sábado",
    domingo: "Domingo",
  };
  return map[day] ?? day.charAt(0).toUpperCase() + day.slice(1);
}

function joinDays(days: string[]): string {
  if (!Array.isArray(days) || days.length === 0) return "—";
  return days.map(toDisplay).join(" · ");
}

function formatLearnedAt(iso: string | null): string | null {
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

/**
 * Panel comparativo entre agenda MANUAL (lo que el dueno configuro) y agenda
 * APRENDIDA (lo que el sistema observo en los pedidos reales). El objetivo es
 * que el dueno pueda comparar las dos sin mezclarlas y decidir si actualiza
 * la ficha del proveedor.
 *
 * Estados que soporta:
 *   - Manual configurada, aprendida solida y coherente ⇒ dos columnas verdes.
 *   - Manual configurada, aprendida solida y CONTRADICE ⇒ tarjeta destacada
 *     con boton "Actualizar en proveedores".
 *   - Manual configurada, sin aprendizaje ⇒ una sola columna manual y un
 *     mensaje honesto de "todavia no hay evidencia observada".
 *   - Solo aprendida (dueno no configuro) ⇒ una sola columna aprendida y
 *     boton para configurar manualmente.
 *   - Nada ⇒ el banner existente de "sin agenda" cubre este caso; aqui no se
 *     pinta panel.
 */
export function SupplierScheduleCompare({ items, supplierName, onEditSchedule }: SupplierScheduleCompareProps) {
  const summary = summarizeSupplierAgenda(items);
  const { configured, learned, contradiction, agendaSource } = summary;

  const hasEvidence = learned.sampleCount > 0;
  const learnedReliable = learned.isReliable;
  const hasContradiction = contradiction.hasAny;

  // Si no hay ni agenda manual ni evidencia aprendida, no pintamos el panel:
  // ya existe un banner arriba que le pide al dueno configurar el proveedor.
  if (!configured.hasConfigured && !hasEvidence) return null;

  const learnedAtLabel = formatLearnedAt(learned.learnedAt);
  const sampleCountLabel = learned.sampleCount === 1
    ? "1 pedido observado"
    : `${learned.sampleCount} pedidos observados`;

  const showConfiguredColumn = configured.hasConfigured;
  const showLearnedColumn = hasEvidence;

  return (
    <section
      aria-label={`Comparacion de agenda para ${supplierName}`}
      className="flex flex-col gap-3 border-b border-zinc-200 bg-zinc-50/60 px-4 py-3 dark:border-white/10 dark:bg-zinc-900/60"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <CalendarDays size={16} className="text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
          <h3 className="text-[10px] font-black uppercase tracking-widest text-zinc-600 dark:text-zinc-300">
            Agenda del proveedor
          </h3>
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase ${
              agendaSource === "manual"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : agendaSource === "learned"
                  ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300"
                  : "border-zinc-400/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300"
            }`}
            title="De donde salen las fechas propuestas"
          >
            {agendaSource === "manual" && "Fechas: agenda configurada"}
            {agendaSource === "learned" && "Fechas: agenda aprendida"}
            {agendaSource === "none" && "Fechas: estimadas"}
          </span>
        </div>
      </header>

      {hasContradiction && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-100 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
            <div className="text-xs leading-snug">
              <p className="font-black uppercase tracking-wide">Lo aprendido no coincide con lo configurado</p>
              <p className="mt-0.5 font-medium">
                {contradiction.visit && contradiction.delivery
                  ? "El sistema observo dias de visita y entrega distintos a los que tienes en la ficha."
                  : contradiction.visit
                    ? "El sistema observo un dia de visita distinto al configurado."
                    : "El sistema observo un dia de entrega distinto al configurado."}
                {" "}Revisa la ficha del proveedor si el ruteo cambio.
              </p>
            </div>
          </div>
          {onEditSchedule && (
            <Button
              size="sm"
              color="warning"
              variant="flat"
              startContent={<Settings size={14} />}
              className="self-start sm:self-center"
              aria-label={`Configurar agenda de ${supplierName} aquí`}
              onPress={onEditSchedule}
            >
              Configurar aquí
            </Button>
          )}
        </div>
      )}

      <div
        className={`grid gap-3 ${showConfiguredColumn && showLearnedColumn ? "md:grid-cols-2" : ""}`}
      >
        {showConfiguredColumn && (
          <article
            className={`rounded-xl border p-3 ${
              hasContradiction
                ? "border-emerald-500/40 bg-emerald-500/5"
                : "border-emerald-500/30 bg-emerald-500/5"
            }`}
            aria-label="Agenda configurada por el dueno"
          >
            <div className="mb-2 flex items-center gap-1.5">
              <UserCheck size={13} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              <h4 className="text-[10px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300">
                Tu configuraste
              </h4>
            </div>
            <dl className="grid gap-1.5 text-[11px]">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="font-bold uppercase text-zinc-500 dark:text-zinc-400">Visita</dt>
                <dd
                  className={`text-right font-black text-zinc-900 dark:text-white ${
                    contradiction.visit ? "underline decoration-amber-500 decoration-2 underline-offset-2" : ""
                  }`}
                >
                  {joinDays(configured.visitDays)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="font-bold uppercase text-zinc-500 dark:text-zinc-400">Entrega</dt>
                <dd
                  className={`text-right font-black text-zinc-900 dark:text-white ${
                    contradiction.delivery ? "underline decoration-amber-500 decoration-2 underline-offset-2" : ""
                  }`}
                >
                  {joinDays(configured.deliveryDays)}
                </dd>
              </div>
            </dl>
          </article>
        )}

        {showLearnedColumn ? (
          <article
            className={`rounded-xl border p-3 ${
              hasContradiction
                ? "border-amber-500/40 bg-amber-500/5"
                : learnedReliable
                  ? "border-indigo-500/30 bg-indigo-500/5"
                  : "border-zinc-300/60 bg-zinc-500/5 dark:border-white/10"
            }`}
            aria-label="Agenda aprendida por el sistema"
          >
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Brain size={13} className="text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
              <h4 className="text-[10px] font-black uppercase tracking-widest text-indigo-700 dark:text-indigo-300">
                El sistema observo
              </h4>
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                  learnedReliable
                    ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                }`}
                title={
                  learnedReliable
                    ? `Respaldo solido: ${sampleCountLabel}`
                    : `Respaldo debil: ${sampleCountLabel}. Se necesitan al menos ${LEARN_MIN_SAMPLES} pedidos para considerarlo confiable.`
                }
              >
                {sampleCountLabel}
              </span>
            </div>
            <dl className="grid gap-1.5 text-[11px]">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="font-bold uppercase text-zinc-500 dark:text-zinc-400">Visita</dt>
                <dd
                  className={`text-right font-black text-zinc-900 dark:text-white ${
                    contradiction.visit ? "underline decoration-amber-500 decoration-2 underline-offset-2" : ""
                  }`}
                >
                  {joinDays(learned.visitDays)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="font-bold uppercase text-zinc-500 dark:text-zinc-400">Entrega</dt>
                <dd
                  className={`text-right font-black text-zinc-900 dark:text-white ${
                    contradiction.delivery ? "underline decoration-amber-500 decoration-2 underline-offset-2" : ""
                  }`}
                >
                  {joinDays(learned.deliveryDays)}
                </dd>
              </div>
              {learned.leadTimeDays !== null && (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="font-bold uppercase text-zinc-500 dark:text-zinc-400">Lead time</dt>
                  <dd className="text-right font-black text-zinc-900 dark:text-white">
                    {learned.leadTimeDays} d (mediana)
                  </dd>
                </div>
              )}
            </dl>
            {(learnedAtLabel || !learnedReliable) && (
              <p className="mt-2 flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400">
                <Info size={11} aria-hidden="true" />
                {!learnedReliable ? (
                  <span>
                    Respaldo debil, aun no confiable. Se activa con {LEARN_MIN_SAMPLES}+ pedidos.
                    {learnedAtLabel ? ` Ultimo calculo: ${learnedAtLabel}.` : ""}
                  </span>
                ) : (
                  <span>Ultimo calculo: {learnedAtLabel}</span>
                )}
              </p>
            )}
          </article>
        ) : (
          showConfiguredColumn && (
            <article
              className="rounded-xl border border-dashed border-zinc-300/70 bg-transparent p-3 dark:border-white/10"
              aria-label="Sin agenda aprendida todavia"
            >
              <div className="mb-1 flex items-center gap-1.5">
                <Brain size={13} className="text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
                <h4 className="text-[10px] font-black uppercase tracking-widest text-zinc-600 dark:text-zinc-300">
                  El sistema observo
                </h4>
              </div>
              <p className="text-[11px] leading-snug text-zinc-600 dark:text-zinc-400">
                Todavia no hay evidencia observada para este proveedor. El nocturno necesita al
                menos {LEARN_MIN_SAMPLES} pedidos recibidos para aprender el patron. Mientras tanto,
                las fechas se calculan con lo que configuraste.
              </p>
            </article>
          )
        )}

        {!showConfiguredColumn && showLearnedColumn && (
          <div className="flex items-start gap-2 rounded-xl border border-dashed border-emerald-500/40 bg-emerald-500/5 p-3">
            <div className="flex-1 text-[11px] leading-snug text-emerald-800 dark:text-emerald-200">
              <p className="font-black uppercase tracking-wide">No hay agenda manual</p>
              <p className="mt-0.5 font-medium">
                Las fechas se estan calculando con lo que el sistema aprendio. Configura los dias
                del proveedor para dejarlo fijo.
              </p>
            </div>
            {onEditSchedule && (
              <Button
                size="sm"
                variant="flat"
                color="success"
                startContent={<Settings size={14} />}
                aria-label={`Configurar dias de ${supplierName} aquí`}
                onPress={onEditSchedule}
              >
                Configurar aquí
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
