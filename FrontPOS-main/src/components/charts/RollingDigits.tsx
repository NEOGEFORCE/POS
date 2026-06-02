"use client";

/**
 * RollingDigits — #4 Catalogo
 * --------------------------------------------------------------
 * Cada digito es una columna `overflow-hidden` que rueda 3 vueltas
 * + el target hasta detenerse. Replica el efecto slot-machine.
 *
 *   <RollingDigits value={48295} format={formatCOP} duration={1.8} />
 */

import * as React from "react";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { useReducedMotionSafe, QUINT_OUT } from "@/components/ui/motion";

interface RollingDigitsProps {
  /** Valor numerico final */
  value: number;
  /** Formateador opcional (e.g. formatCOP). Devuelve la cadena que se muestra. */
  format?: (n: number) => string;
  /** Duracion del rolling completo en segundos */
  duration?: number;
  /** Stagger entre digitos (default 0.04) */
  stagger?: number;
  /** Vueltas completas antes de detenerse en el target (default 3) */
  loops?: number;
  className?: string;
}

const RANGE = Array.from({ length: 10 }, (_, i) => i);

interface DigitColumnProps {
  digit: string;
  index: number;
  duration: number;
  delay: number;
  loops: number;
  reduced: boolean;
}

function DigitColumn({
  digit,
  index,
  duration,
  delay,
  loops,
  reduced,
}: DigitColumnProps) {
  const target = Number(digit);
  const validTarget = Number.isFinite(target) ? target : 0;

  // Si el caracter no es digito (separador, simbolo), no rueda.
  if (!/^\d$/.test(digit)) {
    return (
      <span className="inline-block tabular-nums" aria-hidden>
        {digit}
      </span>
    );
  }

  if (reduced) {
    return <span className="inline-block tabular-nums">{digit}</span>;
  }

  const offset = loops * 10 + validTarget;

  return (
    <span
      className="inline-block overflow-hidden tabular-nums leading-[1em] align-bottom"
      style={{ height: "1em" }}
      aria-hidden
    >
      <motion.span
        className="flex flex-col leading-[1em]"
        initial={{ y: 0 }}
        animate={{ y: `-${offset}em` }}
        transition={{
          duration,
          delay: index * delay,
          ease: QUINT_OUT,
        }}
      >
        {Array.from({ length: loops }).flatMap((_, l) =>
          RANGE.map((d) => (
            <span key={`l${l}-${d}`} style={{ height: "1em" }}>
              {d}
            </span>
          )),
        )}
        {RANGE.slice(0, validTarget + 1).map((d) => (
          <span key={`final-${d}`} style={{ height: "1em" }}>
            {d}
          </span>
        ))}
      </motion.span>
    </span>
  );
}

export function RollingDigits({
  value,
  format,
  duration = 1.8,
  stagger = 0.04,
  loops = 3,
  className,
}: RollingDigitsProps) {
  const reduced = useReducedMotionSafe();
  const text = format ? format(value) : String(value);

  return (
    <span
      className={cn("inline-flex items-baseline tabular-nums", className)}
      aria-label={text}
    >
      {text.split("").map((char, i) => (
        <DigitColumn
          key={`${i}-${char}`}
          digit={char}
          index={i}
          duration={duration}
          delay={stagger}
          loops={loops}
          reduced={reduced}
        />
      ))}
    </span>
  );
}
