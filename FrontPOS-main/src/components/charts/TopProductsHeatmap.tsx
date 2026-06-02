"use client";

/**
 * TopProductsHeatmap — #10 Catalogo
 * --------------------------------------------------------------
 * Heatmap estilo GitHub-contributions. Stagger por VALOR: las
 * celdas se ordenan por intensidad descendente y aparecen las
 * saturadas primero. Replica el efecto "datos importantes primero".
 *
 *   <TopProductsHeatmap
 *     title="Actividad por area"
 *     scopeLabel="Esta semana"
 *     rows={['TI', 'Operaciones', 'RRHH']}
 *     cols={['Lun','Mar','Mie','Jue','Vie','Sab','Dom']}
 *     matrix={[[0.9, 0.7, 0.85, ...], ...]}
 *   />
 */

import * as React from "react";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { useReducedMotionSafe, QUINT_OUT } from "@/components/ui/motion";

interface TopProductsHeatmapProps {
  title?: string;
  scopeLabel?: string;
  rows: string[];
  cols: string[];
  /** Matrix[row][col] en rango 0–1 (o un maximo arbitrario; se normaliza). */
  matrix: number[][];
  /** Color de saturacion maxima (default: var(--accent)) */
  color?: string;
  className?: string;
  /** Tamaño de la celda en px (default 28) */
  cellSize?: number;
}

const ACCENT = "var(--accent, #10b981)";

/** Mezcla un color con transparencia segun intensidad 0..1 */
function intensityToOpacity(v: number): number {
  // Pequeño lift inferior para que el 0 no sea totalmente invisible.
  return Math.max(0.06, Math.min(1, v * 0.92 + 0.06));
}

export function TopProductsHeatmap({
  title,
  scopeLabel,
  rows,
  cols,
  matrix,
  color = ACCENT,
  className,
  cellSize = 28,
}: TopProductsHeatmapProps) {
  const reduced = useReducedMotionSafe();

  // Normalizar al maximo encontrado para tolerar matrices con valores >1
  const flatMax = matrix.reduce(
    (acc, row) => Math.max(acc, ...row),
    1,
  );

  const cells = React.useMemo(() => {
    const list: { r: number; c: number; v: number }[] = [];
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < cols.length; c++) {
        list.push({ r, c, v: (matrix[r]?.[c] ?? 0) / flatMax });
      }
    }
    return list;
  }, [rows.length, cols.length, matrix, flatMax]);

  // Orden por valor descendente → delay por rank
  const orderMap = React.useMemo(() => {
    const sorted = [...cells].sort((a, b) => b.v - a.v);
    const map = new Map<string, number>();
    sorted.forEach((cell, idx) => {
      map.set(`${cell.r}-${cell.c}`, idx);
    });
    return map;
  }, [cells]);

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-[var(--shadow-card)]",
        className,
      )}
    >
      {(title || scopeLabel) && (
        <div className="flex items-end justify-between">
          {title && (
            <h3 className="text-sm font-medium tracking-tight text-[var(--text-primary)]">
              {title}
            </h3>
          )}
          {scopeLabel && (
            <p className="text-[10px] font-medium uppercase tracking-widest text-[var(--text-muted)]">
              {scopeLabel}
            </p>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="border-separate" style={{ borderSpacing: 4 }}>
          <thead>
            <tr>
              <th />
              {cols.map((col) => (
                <th
                  key={col}
                  className="text-[9px] font-medium uppercase tracking-widest text-[var(--text-muted)]"
                  style={{ width: cellSize }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={row}>
                <td className="pr-2 text-right text-[10px] font-medium uppercase tracking-widest text-[var(--text-secondary)]">
                  {row}
                </td>
                {cols.map((_, c) => {
                  const v = (matrix[r]?.[c] ?? 0) / flatMax;
                  const rank = orderMap.get(`${r}-${c}`) ?? 0;
                  return (
                    <td key={c} style={{ width: cellSize, height: cellSize }}>
                      <motion.div
                        className="h-full w-full rounded-md"
                        style={{
                          backgroundColor: color,
                          opacity: intensityToOpacity(v),
                        }}
                        initial={
                          reduced
                            ? false
                            : { opacity: 0, scale: 0.7 }
                        }
                        animate={{
                          opacity: intensityToOpacity(v),
                          scale: 1,
                        }}
                        transition={{
                          duration: reduced ? 0 : 0.32,
                          delay: reduced ? 0 : 0.02 * rank,
                          ease: QUINT_OUT,
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
