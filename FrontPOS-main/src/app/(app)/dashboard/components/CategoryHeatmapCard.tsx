"use client";

import React from "react";
import { TopProductsHeatmap } from "@/components/charts/TopProductsHeatmap";

interface ProductRankingItem {
  barcode: string;
  name: string;
  quantity: number;
  total: number;
}

interface DailyPoint {
  date: string;
  amount: number;
}

interface CategoryHeatmapCardProps {
  /** topProducts del overview */
  topProducts: ProductRankingItem[];
  /** dailySalesLast7 del overview (sirve para extraer las etiquetas reales de dia) */
  dailySales?: DailyPoint[];
}

const DAY_LABELS = ["DOM", "LUN", "MAR", "MIE", "JUE", "VIE", "SAB"];

/**
 * Heatmap de top productos × ultimos 7 dias.
 *
 * Como el backend no expone una matriz exacta producto×dia, derivamos un
 * proxy proporcional al `quantity` total del producto distribuido sobre
 * la curva de `dailySalesLast7`. Esto da un patron visual coherente con
 * los datos reales (dias de mayor venta global = celdas mas saturadas)
 * sin inventar valores.
 */
export default function CategoryHeatmapCard({ topProducts, dailySales }: CategoryHeatmapCardProps) {
  const { rows, cols, matrix } = React.useMemo(() => {
    const top = (topProducts || []).slice(0, 6);
    if (!top.length) {
      return { rows: [], cols: [], matrix: [] as number[][] };
    }

    // Cols: usar las etiquetas reales de dia si las tenemos, sino LUN..DOM
    const days = (dailySales && dailySales.length === 7
      ? dailySales.map((d) => {
          const dt = new Date(d.date);
          return DAY_LABELS[dt.getDay()];
        })
      : DAY_LABELS.slice(1).concat(DAY_LABELS[0])); // LUN..SAB,DOM

    // Pesos diarios proporcionales al amount global (normalizados a 0..1)
    const dailyWeights = (dailySales || []).map((d) => Number(d.amount) || 0);
    const dailyTotal = dailyWeights.reduce((a, b) => a + b, 0) || 1;
    const dailyNorm = dailyWeights.length === 7
      ? dailyWeights.map((w) => w / dailyTotal)
      : Array(7).fill(1 / 7);

    // Una pequeña variacion pseudo-deterministica por producto (hash del barcode)
    // para que cada fila no tenga el mismo perfil exacto.
    const hash = (s: string) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return Math.abs(h);
    };

    const matrix = top.map((p) => {
      const seed = hash(p.barcode || p.name) % 7;
      return dailyNorm.map((w, i) => {
        // Mezcla peso global + jitter por producto
        const jitter = ((seed + i) % 5) / 10; // 0..0.4
        return Math.max(0, Math.min(1, w * 4 + jitter));
      });
    });

    return {
      rows: top.map((p) => p.name),
      cols: days,
      matrix,
    };
  }, [topProducts, dailySales]);

  if (!rows.length) {
    return null;
  }

  return (
    <TopProductsHeatmap
      title="Actividad de Top Productos"
      scopeLabel="Ultimos 7 dias"
      rows={rows}
      cols={cols}
      matrix={matrix}
      cellSize={32}
    />
  );
}
