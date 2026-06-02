"use client";

/**
 * AuthShell — #25 Catalogo (cortinas)
 * --------------------------------------------------------------
 * Layout de pantalla de auth con dos paneles. Al cerrar (login OK)
 * cada pane sale en direccion opuesta, dejando ver el dashboard
 * detras. `onClosed` se invoca al terminar el exit (perfecto para
 * `router.replace('/dashboard')`).
 *
 *   const shell = useAuthShell();
 *
 *   const onSubmit = async () => {
 *     await login(...);
 *     shell.close();
 *   };
 *
 *   <AuthShell
 *     splash={<MarketingPanel />}
 *     closing={shell.closing}
 *     onClosed={() => router.replace('/dashboard')}
 *   >
 *     <LoginForm />
 *   </AuthShell>
 */

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { useReducedMotionSafe } from "@/components/ui/motion";

interface AuthShellProps {
  /** Panel izquierdo (hero / marketing). Si se omite, solo se muestra el form. */
  splash?: React.ReactNode;
  /** Contenido del panel derecho (form). */
  children: React.ReactNode;
  /** True para disparar la salida con cortinas. */
  closing?: boolean;
  /** Callback cuando termina la animacion de salida. */
  onClosed?: () => void;
  /** Proporcion del splash en desktop. Default `55%`. */
  splashWidth?: string;
  className?: string;
}

const SPRING = { type: "spring" as const, stiffness: 90, damping: 22 };

export function AuthShell({
  splash,
  children,
  closing = false,
  onClosed,
  splashWidth = "55%",
  className,
}: AuthShellProps) {
  const reduced = useReducedMotionSafe();

  return (
    <AnimatePresence onExitComplete={onClosed}>
      {!closing && (
        <motion.div
          key="auth-shell"
          className={cn(
            "fixed inset-0 z-[200] flex min-h-screen w-full bg-[var(--bg-app)]",
            className,
          )}
          initial={false}
        >
          {splash && (
            <motion.aside
              className="relative hidden h-full flex-col justify-between overflow-hidden border-r border-[var(--border)] bg-[var(--bg-sidebar)] p-12 lg:flex"
              style={{ width: splashWidth }}
              initial={reduced ? false : { x: "-100%" }}
              animate={{ x: 0 }}
              exit={reduced ? { opacity: 0 } : { x: "-100%" }}
              transition={SPRING}
            >
              {splash}
            </motion.aside>
          )}

          <motion.section
            className={cn(
              "relative flex h-full flex-1 flex-col justify-center px-8 sm:px-16 lg:px-24",
              "bg-[var(--bg-app)]",
            )}
            initial={reduced ? false : { x: "100%" }}
            animate={{ x: 0 }}
            exit={reduced ? { opacity: 0 } : { x: "100%" }}
            transition={SPRING}
          >
            {children}
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ============================================================
// Hook de control
// ============================================================

interface UseAuthShellResult {
  /** Estado actual: si las cortinas estan saliendo */
  closing: boolean;
  /** Disparar la salida (login exitoso) */
  close: () => void;
  /** Resetear a estado inicial */
  reset: () => void;
}

export function useAuthShell(): UseAuthShellResult {
  const [closing, setClosing] = React.useState(false);
  return {
    closing,
    close: React.useCallback(() => setClosing(true), []),
    reset: React.useCallback(() => setClosing(false), []),
  };
}
