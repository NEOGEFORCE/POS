"use client";

/**
 * RunawayButton — wrapper que envuelve un botón (o cualquier hijo) y lo
 * hace huir del cursor mientras `runaway` esté en true.
 *
 * Estructura:
 *   <div class="socket">           ← reserva el espacio original (layout intacto)
 *     <motion.div ref={ref}>       ← el que se mueve con transform (x, y, rotate)
 *       {children}                 ← tu <Button /> real
 *     </motion.div>
 *   </div>
 *
 * Reglas de accesibilidad (siguiendo el patrón de POS Pro):
 *  - `prefers-reduced-motion`: nunca huye.
 *  - `pointer: coarse` (touch): nunca huye — no hay cursor que perseguir.
 *  - El teclado (Tab + Enter) no se ve afectado: el botón real sigue
 *    recibiendo foco desde el socket, sólo cambia su transform visual.
 *  - Cuando `runaway=false`, el botón regresa al socket con easing y queda
 *    100% clickeable.
 */

import * as React from "react";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { useReducedMotionSafe } from "@/components/ui/motion";
import { useRunawayButton } from "@/hooks/use-runaway-button";

export type RunawayButtonProps = {
  /** ¿Está en modo huir? Suele venir de la validación del formulario. */
  runaway: boolean;
  /** El botón (o cualquier hijo) que debe huir del cursor. */
  children: React.ReactNode;
  /** Clases del socket (contenedor que reserva el espacio del botón). */
  socketClassName?: string;
  /** Clases del motion wrapper interno (el que se mueve). */
  className?: string;
  /** Distancia al borde (px) donde empieza a huir. Default 140. */
  detectionRadius?: number;
  /** Máximo desplazamiento absoluto por eje (px). Default 180. */
  runDistance?: number;
  /** % del sobrante que corre por la pared (0..1). Default 0.9. */
  cornerSpill?: number;
};

export function RunawayButton({
  runaway,
  children,
  socketClassName,
  className,
  detectionRadius,
  runDistance,
  cornerSpill,
}: RunawayButtonProps) {
  const reducedMotion = useReducedMotionSafe();
  const isCoarse = useCoarsePointer();

  // El botón huye sólo si (a) el consumidor lo pide, (b) hay puntero fino y
  // (c) el usuario NO tiene prefers-reduced-motion.
  const active = runaway && !reducedMotion && !isCoarse;

  const { ref, x, y, rot } = useRunawayButton({
    active,
    detectionRadius,
    runDistance,
    cornerSpill,
  });

  return (
    <div className={cn("relative isolate", socketClassName)}>
      <motion.div
        ref={ref as React.Ref<HTMLDivElement>}
        // will-change reservado para que el compositor lo suba a GPU.
        style={{ x, y, rotate: rot, willChange: "transform" }}
        className={cn("w-full", className)}
      >
        {children}
      </motion.div>
    </div>
  );
}

/** Devuelve `true` si el puntero principal es "coarse" (touch). SSR-safe. */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(mq.matches);
    update();
    // MediaQueryList API varía entre navegadores viejos y modernos.
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }
    // Fallback para Safari <14 / navegadores muy viejos.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mq as any).addListener(update);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return () => (mq as any).removeListener(update);
  }, []);
  return coarse;
}
