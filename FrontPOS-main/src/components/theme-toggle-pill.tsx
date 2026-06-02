"use client";

/**
 * ThemeTogglePill — #23 Catalogo
 * --------------------------------------------------------------
 * Pill horizontal con bola que se desliza de izquierda a derecha
 * usando `layout` de framer-motion (sin animar `x` manualmente).
 * El icono dentro de la bola hace cross-fade con AnimatePresence.
 *
 * NO reemplaza al componente existente <ThemeToggle/> (segmented).
 * Importa este si quieres el estilo iOS con bola.
 */

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { AnimatePresence, motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { useReducedMotionSafe, SPRING_FIRM } from "@/components/ui/motion";

interface ThemeTogglePillProps {
  className?: string;
  /** Si true muestra labels (claro/oscuro) tras la bola. Default false. */
  showLabels?: boolean;
}

export function ThemeTogglePill({
  className,
  showLabels = false,
}: ThemeTogglePillProps) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const reduced = useReducedMotionSafe();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Evitamos hydration mismatch: render placeholder hasta montar
  if (!mounted) {
    return (
      <div
        className={cn(
          "flex h-8 w-16 items-center rounded-full border border-[var(--border)] bg-[var(--bg-elevated)]",
          className,
        )}
        aria-hidden
      />
    );
  }

  const current = (theme === "system" ? resolvedTheme : theme) ?? "dark";
  const isDark = current === "dark";

  const toggle = () => {
    const next = isDark ? "light" : "dark";
    setTheme(next);
    // Espejo manual para coherencia con el sistema CSS legacy del POS
    if (next === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
      onClick={toggle}
      className={cn(
        "relative inline-flex h-8 w-16 items-center rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] p-1 transition-colors",
        "hover:border-[var(--accent-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        className,
      )}
    >
      {/* Iconos del fondo */}
      <Sun
        className={cn(
          "absolute left-2 h-3.5 w-3.5 transition-colors",
          isDark ? "text-[var(--text-muted)]" : "text-amber-500",
        )}
      />
      <Moon
        className={cn(
          "absolute right-2 h-3.5 w-3.5 transition-colors",
          isDark ? "text-[var(--accent)]" : "text-[var(--text-muted)]",
        )}
      />

      {/* Bola */}
      <motion.span
        layout={!reduced}
        transition={reduced ? { duration: 0 } : SPRING_FIRM}
        className={cn(
          "z-10 flex h-6 w-6 items-center justify-center rounded-full shadow-md",
          isDark
            ? "ml-auto bg-gradient-brand"
            : "ml-0 mr-auto bg-white",
        )}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={isDark ? "moon" : "sun"}
            initial={
              reduced
                ? false
                : { scale: 0.6, opacity: 0, rotate: -45 }
            }
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            exit={
              reduced
                ? { opacity: 0 }
                : { scale: 0.6, opacity: 0, rotate: 45 }
            }
            transition={{ duration: 0.18 }}
            className="flex items-center justify-center"
          >
            {isDark ? (
              <Moon className="h-3.5 w-3.5 text-white" />
            ) : (
              <Sun className="h-3.5 w-3.5 text-amber-500" />
            )}
          </motion.span>
        </AnimatePresence>
      </motion.span>

      {showLabels && (
        <span className="sr-only">
          {isDark ? "Tema oscuro activo" : "Tema claro activo"}
        </span>
      )}
    </button>
  );
}
