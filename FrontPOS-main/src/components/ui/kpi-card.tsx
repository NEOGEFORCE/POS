"use client";

/**
 * KpiCard — #12 Catalogo (hover-lift)
 * --------------------------------------------------------------
 * Wrapper sobre Card con whileHover { y: -2 } y spring suave.
 * Acepta `interactive` para activar tambien el spotlight (#13).
 *
 *   <KpiCard interactive>
 *     <CardHeader>...</CardHeader>
 *     <CardContent>...</CardContent>
 *   </KpiCard>
 */

import * as React from "react";
import { motion, type HTMLMotionProps } from "framer-motion";

import { cn } from "@/lib/utils";
import { useReducedMotionSafe } from "@/components/ui/motion";

type KpiCardProps = HTMLMotionProps<"div"> & {
  /** Activa el spotlight cursor-follow (.card-spotlight) */
  interactive?: boolean;
};

const KpiCard = React.forwardRef<HTMLDivElement, KpiCardProps>(
  ({ className, interactive = false, children, onMouseMove, ...rest }, ref) => {
    const reduced = useReducedMotionSafe();

    const handleMouseMove: React.MouseEventHandler<HTMLDivElement> =
      React.useCallback(
        (e) => {
          if (interactive) {
            const target = e.currentTarget;
            const rect = target.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;
            target.style.setProperty("--spotlight-x", `${x}%`);
            target.style.setProperty("--spotlight-y", `${y}%`);
          }
          onMouseMove?.(e as unknown as React.MouseEvent<HTMLDivElement>);
        },
        [interactive, onMouseMove],
      );

    return (
      <motion.div
        ref={ref}
        whileHover={reduced ? undefined : { y: -2 }}
        transition={{ type: "spring", stiffness: 400, damping: 25 }}
        onMouseMove={handleMouseMove}
        className={cn(
          "rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] shadow-[var(--shadow-card)] transition-colors",
          interactive && "card-spotlight hover:border-[var(--accent-border)]",
          className,
        )}
        {...rest}
      >
        {children}
      </motion.div>
    );
  },
);
KpiCard.displayName = "KpiCard";

export { KpiCard };
