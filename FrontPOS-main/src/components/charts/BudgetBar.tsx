"use client";

/**
 * BudgetBar — #11 Catalogo
 * --------------------------------------------------------------
 * Barra horizontal con `width: 0 → ${pct}%` (1.2s) + delay
 * escalonado por indice. Glow esmeralda con drop-shadow.
 *
 *   <BudgetBar label="Nomina" current={4_200_000} max={6_000_000} index={0} />
 */

import * as React from "react";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { useReducedMotionSafe, QUINT_OUT } from "@/components/ui/motion";

interface BudgetBarProps {
  label: string;
  current: number;
  max: number;
  /** Indice para escalonar el delay */
  index?: number;
  /** Formateador de numeros (default toLocaleString) */
  format?: (n: number) => string;
  /** Color del progreso (default: var(--accent)) */
  color?: string;
  className?: string;
}

const ACCENT = "var(--accent, #10b981)";

export function BudgetBar({
  label,
  current,
  max,
  index = 0,
  format = (n) => n.toLocaleString(),
  color = ACCENT,
  className,
}: BudgetBarProps) {
  const reduced = useReducedMotionSafe();
  const pct = Math.max(0, Math.min(100, max > 0 ? (current / max) * 100 : 0));

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium uppercase tracking-wider text-[var(--text-secondary)]">
          {label}
        </span>
        <span className="font-medium tabular-nums text-[var(--text-primary)]">
          {format(current)}
          <span className="text-[var(--text-muted)]"> / {format(max)}</span>
        </span>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--bg-elevated)]">
        <motion.div
          className="h-full rounded-full"
          style={{
            backgroundColor: color,
            filter: `drop-shadow(0 0 6px ${color})`,
          }}
          initial={reduced ? false : { width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{
            duration: reduced ? 0 : 1.2,
            ease: QUINT_OUT,
            delay: reduced ? 0 : 0.6 + index * 0.15,
          }}
        />
      </div>
    </div>
  );
}
