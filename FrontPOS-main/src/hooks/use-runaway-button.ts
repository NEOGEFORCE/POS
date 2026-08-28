"use client";

/**
 * useRunawayButton — un botón que huye del cursor.
 * -----------------------------------------------------------------
 * Adaptado del patrón "Runaway Login" (Codrops):
 *  - La distancia al cursor se mide contra el BORDE del botón, no
 *    contra el centro. Un cursor pegado al borde tiene dist = 0 y
 *    empuja al máximo; a `detectionRadius` px el empuje es 0.
 *  - "Cornered spillover": si un eje se satura contra la caja
 *    permitida (`runDistance`), el excedente se transfiere al otro
 *    eje. Efecto: el botón corre a lo largo de la pared en vez de
 *    quedarse acorralado esperando el click.
 *  - El hook devuelve MotionValues (framer-motion) suavizadas con
 *    springs, listas para aplicarlas a un motion.div.
 *
 * NO toca el layout: el consumidor envuelve el botón en un "socket"
 * (contenedor de tamaño fijo). El botón huye con transform sobre ese
 * socket, por eso el resto del formulario no se corre.
 *
 * Accesibilidad:
 *  - Sólo escucha `mousemove`. Touch y teclado no lo activan.
 *  - Cuando `active=false` regresa a (0,0,0) con easing.
 */

import * as React from "react";
import { useMotionValue, useSpring } from "framer-motion";

type UseRunawayButtonOptions = {
  /** Si es `false` el botón se queda quieto en el socket. */
  active: boolean;
  /** Distancia al borde a partir de la cual empieza a huir (px). */
  detectionRadius?: number;
  /** Máximo desplazamiento absoluto en cada eje (px) — la "caja". */
  runDistance?: number;
  /** Fracción del sobrante clampeado que se transfiere al otro eje (0..1). */
  cornerSpill?: number;
  /** Multiplicador global del empuje (0..1+). */
  strength?: number;
};

type UseRunawayButtonReturn = {
  /** Ref para el motion.div (mide su rect en cada movimiento del cursor). */
  ref: (el: HTMLElement | null) => void;
  /** Motion values suavizadas — listas para `style={{ x, y, rotate: rot }}`. */
  x: ReturnType<typeof useSpring>;
  y: ReturnType<typeof useSpring>;
  rot: ReturnType<typeof useSpring>;
};

export function useRunawayButton({
  active,
  detectionRadius = 140,
  runDistance = 180,
  cornerSpill = 0.9,
  strength = 1,
}: UseRunawayButtonOptions): UseRunawayButtonReturn {
  const elRef = React.useRef<HTMLElement | null>(null);
  const setRef = React.useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rot = useMotionValue(0);

  // Springs "spring soft" (mismos parámetros que el resto del POS).
  const springX = useSpring(x, { stiffness: 320, damping: 22, mass: 0.6 });
  const springY = useSpring(y, { stiffness: 320, damping: 22, mass: 0.6 });
  const springRot = useSpring(rot, { stiffness: 240, damping: 18, mass: 0.6 });

  React.useEffect(() => {
    // Si no está activo, regresar al socket con easing y no escuchar nada.
    if (!active) {
      x.set(0);
      y.set(0);
      rot.set(0);
      return;
    }

    const clamp = (v: number, min: number, max: number) =>
      Math.max(min, Math.min(max, v));

    const handleMove = (clientX: number, clientY: number) => {
      const el = elRef.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const hw = rect.width / 2;
      const hh = rect.height / 2;
      const cx = rect.left + hw;
      const cy = rect.top + hh;

      const dx = clientX - cx;
      const dy = clientY - cy;

      // Distancia al BORDE del botón (no al centro).
      const ex = Math.max(Math.abs(dx) - hw, 0);
      const ey = Math.max(Math.abs(dy) - hh, 0);
      const edgeDist = Math.hypot(ex, ey);

      // Cursor lejos → volver al socket.
      if (edgeDist > detectionRadius) {
        x.set(0);
        y.set(0);
        rot.set(0);
        return;
      }

      const proximity = 1 - edgeDist / detectionRadius; // 1 = pegado, 0 = en el borde
      const push = proximity * runDistance * strength;

      const signX = dx === 0 ? 0 : dx > 0 ? -1 : 1; // signo de huida en X
      const signY = dy === 0 ? 0 : dy > 0 ? -1 : 1;

      const rawX = push * signX;
      const rawY = push * signY;

      const clampedX = clamp(rawX, -runDistance, runDistance);
      const clampedY = clamp(rawY, -runDistance, runDistance);

      // "Cornered": el eje saturado dona sus px al otro para correr por la pared.
      const spillX = Math.abs(rawX) - Math.abs(clampedX);
      const spillY = Math.abs(rawY) - Math.abs(clampedY);

      const finalX = clamp(
        clampedX + spillY * cornerSpill * signX,
        -runDistance,
        runDistance
      );
      const finalY = clamp(
        clampedY + spillX * cornerSpill * signY,
        -runDistance,
        runDistance
      );

      x.set(finalX);
      y.set(finalY);
      rot.set(-signX * proximity * 14); // rotación sutil (-14° a +14°) hacia el sentido de huida
    };

    const onMouseMove = (e: MouseEvent) => handleMove(e.clientX, e.clientY);

    window.addEventListener("mousemove", onMouseMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMouseMove);
  }, [active, detectionRadius, runDistance, cornerSpill, strength, x, y, rot]);

  return {
    ref: setRef,
    x: springX,
    y: springY,
    rot: springRot,
  };
}
