"use client";

import React from "react";
import { SalesAnalyticsChart, type SalesPoint } from "@/components/charts/SalesAnalyticsChart";
import { formatCurrency } from "@/lib/utils";

interface DailyPoint {
  date: string;
  amount: number;
}

interface SalesAutoTourCardProps {
  /** dailySalesLast7 del overview del dashboard */
  data: DailyPoint[];
  /** Etiqueta del rango (e.g. "Ultimos 7 dias") */
  rangeLabel?: string;
}

const DAY_FORMATTER = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
  timeZone: "America/Bogota",
});

/**
 * Card de tendencia de ventas con auto-tour estilo Yann.uiux:
 *  - Path drawing al cargar
 *  - Tooltip que recorre solo los puntos cada 2.4s
 *  - Hover override (pausa el tour mientras hay mouse)
 */
export default function SalesAutoTourCard({ data, rangeLabel }: SalesAutoTourCardProps) {
  const points: SalesPoint[] = React.useMemo(
    () =>
      (data || []).map((d) => ({
        label: d?.date ? DAY_FORMATTER.format(new Date(d.date)).toUpperCase() : "—",
        value: Number(d?.amount) || 0,
      })),
    [data],
  );

  if (!points.length) {
    return null;
  }

  // Calcular rango legible para el header
  const computedRange = rangeLabel
    ? rangeLabel
    : data.length > 0
      ? `${DAY_FORMATTER.format(new Date(data[0].date)).toUpperCase()} — ${DAY_FORMATTER.format(new Date(data[data.length - 1].date)).toUpperCase()}`
      : "Ultimos 7 dias";

  return (
    <SalesAnalyticsChart
      title="Tendencia de Ventas"
      scopeLabel="Ventas Diarias"
      rangeLabel={computedRange}
      autoTour
      tourInterval={2.4}
      data={points}
      format={(n) => `$${formatCurrency(n)}`}
      height={240}
    />
  );
}
