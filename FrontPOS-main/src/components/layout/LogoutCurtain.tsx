"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { LogOut } from "lucide-react";

import { useReducedMotionSafe } from "@/components/ui/motion";

interface LogoutCurtainProps {
  /** Cuando pasa a true, las cortinas entran desde los lados y cubren la pantalla */
  active: boolean;
}

/**
 * Overlay full-screen con dos paneles que entran desde los lados (izq → derecha,
 * der → izquierda) cubriendo la app antes del redirect a /login.
 *
 * Usado cuando el usuario hace click en "Salir" — se monta sobre todo y aparece
 * brevemente para señalar la transicion de sesion.
 */
export function LogoutCurtain({ active }: LogoutCurtainProps) {
  const reduced = useReducedMotionSafe();

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          key="logout-curtain"
          className="fixed inset-0 z-[9999] flex pointer-events-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* Panel izquierdo entra desde la izquierda */}
          <motion.div
            initial={reduced ? { x: 0 } : { x: "-100%" }}
            animate={{ x: 0 }}
            transition={{ type: "spring", stiffness: 90, damping: 22 }}
            className="w-1/2 h-full bg-[var(--bg-sidebar)] border-r border-[var(--border)] flex items-center justify-end px-12"
          >
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-2xl bg-[var(--accent-soft)] border border-[var(--accent-border)] flex items-center justify-center text-[var(--accent)]">
                <LogOut size={18} />
              </div>
              <span className="text-[11px] font-medium uppercase tracking-[0.4em] text-[var(--text-secondary)]">
                Cerrando sesion
              </span>
            </div>
          </motion.div>

          {/* Panel derecho entra desde la derecha */}
          <motion.div
            initial={reduced ? { x: 0 } : { x: "100%" }}
            animate={{ x: 0 }}
            transition={{ type: "spring", stiffness: 90, damping: 22 }}
            className="w-1/2 h-full bg-[var(--bg-app)] flex items-center justify-start px-12"
          >
            <span className="text-[10px] font-bold uppercase tracking-[0.5em] text-[var(--text-muted)]">
              Hasta pronto…
            </span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
