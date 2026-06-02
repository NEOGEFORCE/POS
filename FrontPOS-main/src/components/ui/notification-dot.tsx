"use client";

/**
 * NotificationDot — #24 + #28 Catalogo
 * --------------------------------------------------------------
 * Punto solido con un anillo `animate-ping` superpuesto.
 * Usado en headers (Bell), badges y avatars para llamar la atencion.
 *
 *   <NotificationDot />        // verde por defecto (accent)
 *   <NotificationDot tone="warning" />
 *   <button className="relative">
 *     <Bell />
 *     <span className="absolute -top-1 -right-1"><NotificationDot /></span>
 *   </button>
 */

import * as React from "react";

import { cn } from "@/lib/utils";

type Tone = "accent" | "danger" | "warning" | "info";

interface NotificationDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Tamano en pixeles (default 8) */
  size?: number;
  /** Anillo "ping" activado (default true). Off para badges silenciosos. */
  ping?: boolean;
}

const TONE_BG: Record<Tone, string> = {
  accent: "bg-[var(--accent)] shadow-[0_0_8px_var(--accent)]",
  danger: "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]",
  warning: "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]",
  info: "bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.6)]",
};

const TONE_PING: Record<Tone, string> = {
  accent: "bg-[var(--accent)]",
  danger: "bg-rose-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
};

export function NotificationDot({
  tone = "accent",
  size = 8,
  ping = true,
  className,
  style,
  ...rest
}: NotificationDotProps) {
  return (
    <span
      className={cn("relative inline-flex", className)}
      style={{ width: size, height: size, ...style }}
      aria-hidden
      {...rest}
    >
      {ping && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
            TONE_PING[tone],
          )}
        />
      )}
      <span
        className={cn(
          "relative inline-flex h-full w-full rounded-full",
          TONE_BG[tone],
        )}
      />
    </span>
  );
}
