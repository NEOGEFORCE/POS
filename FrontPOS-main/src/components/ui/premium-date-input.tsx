"use client";

import * as React from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";

interface PremiumDateInputProps {
  /** Valor en formato YYYY-MM-DD (input type="date") o YYYY-MM-DDTHH:mm (datetime-local) */
  value: string;
  onChange: (value: string) => void;
  /** Etiqueta arriba del input */
  label?: string;
  /** Texto de ayuda debajo del input */
  hint?: string;
  /** Tipo del input nativo: 'date' (default) o 'datetime-local' */
  type?: "date" | "datetime-local";
  /** Tamaño visual: 'sm' (h-10), 'md' (h-12, default) o 'lg' (h-14) */
  size?: "sm" | "md" | "lg";
  /** Color del acento (clase Tailwind, ej: 'emerald', 'rose', 'blue'). Default 'emerald'. */
  accent?: "emerald" | "rose" | "blue" | "amber" | "violet";
  /** Si true, muestra la fecha formateada en español debajo */
  showFormatted?: boolean;
  /** Min y max dates en formato ISO */
  min?: string;
  max?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
}

const SIZE_CLS: Record<NonNullable<PremiumDateInputProps["size"]>, string> = {
  sm: "h-10 text-[11px]",
  md: "h-12 text-[12px]",
  lg: "h-14 text-sm",
};

const ACCENT_BORDER: Record<NonNullable<PremiumDateInputProps["accent"]>, string> = {
  emerald: "focus-within:border-emerald-500/60 focus-within:shadow-[0_0_0_3px_rgba(16,185,129,0.10)]",
  rose: "focus-within:border-rose-500/60 focus-within:shadow-[0_0_0_3px_rgba(244,63,94,0.10)]",
  blue: "focus-within:border-blue-500/60 focus-within:shadow-[0_0_0_3px_rgba(59,130,246,0.10)]",
  amber: "focus-within:border-amber-500/60 focus-within:shadow-[0_0_0_3px_rgba(245,158,11,0.10)]",
  violet: "focus-within:border-violet-500/60 focus-within:shadow-[0_0_0_3px_rgba(139,92,246,0.10)]",
};

const ACCENT_ICON: Record<NonNullable<PremiumDateInputProps["accent"]>, string> = {
  emerald: "text-emerald-500 bg-emerald-500/10",
  rose: "text-rose-500 bg-rose-500/10",
  blue: "text-blue-500 bg-blue-500/10",
  amber: "text-amber-500 bg-amber-500/10",
  violet: "text-violet-500 bg-violet-500/10",
};

const SPANISH_DAYS = ["DOM", "LUN", "MAR", "MIE", "JUE", "VIE", "SAB"];
const SPANISH_MONTHS = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];

function formatPretty(value: string, type: "date" | "datetime-local"): string {
  if (!value) return "—";
  // Construir Date sin problemas de timezone (parse local)
  const datePart = value.split("T")[0];
  const [y, m, d] = datePart.split("-").map(Number);
  if (!y || !m || !d) return "—";
  const dateObj = new Date(y, m - 1, d);
  const dayName = SPANISH_DAYS[dateObj.getDay()];
  const monthName = SPANISH_MONTHS[m - 1];
  const formatted = `${dayName}, ${d} ${monthName} ${y}`;

  if (type === "datetime-local" && value.includes("T")) {
    const time = value.split("T")[1] || "";
    const [h = "00", min = "00"] = time.split(":");
    return `${formatted} · ${h}:${min}`;
  }
  return formatted;
}

/**
 * Input de fecha con diseño premium:
 *   - Icono calendar a la izquierda con tile colored
 *   - Label en mayusculas con tracking
 *   - Border con focus glow del color accent
 *   - Texto auxiliar debajo mostrando la fecha formateada en español
 *   - Soporta date y datetime-local
 *
 *   <PremiumDateInput
 *     label="Desde"
 *     value={dateFrom}
 *     onChange={setDateFrom}
 *     accent="emerald"
 *     showFormatted
 *   />
 */
export function PremiumDateInput({
  value,
  onChange,
  label,
  hint,
  type = "date",
  size = "md",
  accent = "emerald",
  showFormatted = true,
  min,
  max,
  className,
  disabled,
  id,
}: PremiumDateInputProps) {
  const inputId = id ?? React.useId();

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label
          htmlFor={inputId}
          className="text-[9px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] ml-1"
        >
          {label}
        </label>
      )}

      <motion.div
        whileFocus={{ scale: 1.01 }}
        className={cn(
          "group relative flex items-center gap-2 rounded-2xl",
          "border-2 border-transparent",
          "bg-white dark:bg-zinc-900/60",
          "ring-1 ring-zinc-200 dark:ring-white/5",
          "shadow-[0_2px_8px_rgba(0,0,0,0.04)] dark:shadow-[0_2px_8px_rgba(0,0,0,0.3)]",
          "transition-all duration-200",
          "hover:ring-zinc-300 dark:hover:ring-white/10",
          ACCENT_BORDER[accent],
          SIZE_CLS[size],
          disabled && "opacity-50 cursor-not-allowed",
        )}
      >
        {/* Tile del icono */}
        <div
          className={cn(
            "ml-1.5 my-1.5 flex items-center justify-center rounded-xl shrink-0",
            "transition-all group-hover:scale-105",
            ACCENT_ICON[accent],
            size === "sm" && "h-7 w-7",
            size === "md" && "h-9 w-9",
            size === "lg" && "h-11 w-11",
          )}
        >
          <CalendarIcon size={size === "sm" ? 12 : size === "md" ? 14 : 16} strokeWidth={2.5} />
        </div>

        {/* Input nativo (estilo overlay invisible para que el calendario nativo pop-up funcione) */}
        <input
          id={inputId}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          min={min}
          max={max}
          disabled={disabled}
          className={cn(
            "flex-1 bg-transparent border-0 outline-none ring-0",
            "font-medium tabular-nums tracking-tight",
            "text-zinc-900 dark:text-zinc-50",
            "uppercase",
            "pr-3",
            "[color-scheme:light] dark:[color-scheme:dark]",
            "[&::-webkit-calendar-picker-indicator]:opacity-60",
            "[&::-webkit-calendar-picker-indicator]:cursor-pointer",
            "[&::-webkit-calendar-picker-indicator]:hover:opacity-100",
            "[&::-webkit-calendar-picker-indicator]:transition-opacity",
            "disabled:cursor-not-allowed",
          )}
        />
      </motion.div>

      {/* Linea inferior: hint + fecha formateada */}
      {(hint || showFormatted) && (
        <div className="flex items-center justify-between px-1.5">
          {hint && (
            <span className="text-[9px] font-medium text-zinc-400 dark:text-zinc-600 uppercase tracking-widest">
              {hint}
            </span>
          )}
          {showFormatted && value && (
            <span className="text-[9px] font-bold tabular-nums text-zinc-500 dark:text-zinc-400 uppercase tracking-wider ml-auto">
              {formatPretty(value, type)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
