"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { useReducedMotionSafe } from "@/components/ui/motion";

interface RouteCurtainProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * RouteCurtain — al cambiar de ruta dispara una transicion de cortinas:
 *   1. Dos paneles entran desde los lados cubriendo la pantalla brevemente.
 *   2. Inmediatamente los paneles se separan (uno hacia la izquierda, otro
 *      hacia la derecha) revelando la nueva pagina debajo.
 *
 * El contenido (children) se renderiza con un fade-up sutil cuando las
 * cortinas terminan de abrir.
 *
 * En reduced-motion se omite la cortina y solo se renderizan los children.
 */
export function RouteCurtain({ children, className }: RouteCurtainProps) {
  const pathname = usePathname() ?? "default";
  const reduced = useReducedMotionSafe();

  if (reduced) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div className={cn("relative flex-1 min-h-0 flex flex-col w-full h-full", className)}>
      {/* Cortinas: dos paneles que cubren brevemente al cambiar de ruta */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`curtain-${pathname}`}
          className="pointer-events-none fixed inset-0 z-[200] flex"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          exit={{ opacity: 0 }}
          transition={{ delay: 0.45, duration: 0.15 }}
          aria-hidden
        >
          <motion.div
            className="h-full w-1/2 bg-[var(--bg-sidebar)] border-r border-[var(--border)]"
            initial={{ x: "-100%" }}
            animate={{ x: ["-100%", "0%", "-100%"] }}
            transition={{
              times: [0, 0.45, 1],
              duration: 0.6,
              ease: [0.16, 1, 0.3, 1],
            }}
          />
          <motion.div
            className="h-full w-1/2 bg-[var(--bg-app)]"
            initial={{ x: "100%" }}
            animate={{ x: ["100%", "0%", "100%"] }}
            transition={{
              times: [0, 0.45, 1],
              duration: 0.6,
              ease: [0.16, 1, 0.3, 1],
            }}
          />
        </motion.div>
      </AnimatePresence>

      {/* Contenido de la nueva ruta — fade-up cuando las cortinas se abren */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`page-${pathname}`}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{
            delay: 0.3,
            duration: 0.35,
            ease: [0.16, 1, 0.3, 1],
          }}
          className="flex-1 flex flex-col w-full h-full min-h-0"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
