"use client";

/**
 * Animated Table — #26 Catalogo
 * --------------------------------------------------------------
 * Variante NO destructiva sobre la Table base. Las filas
 * (MotionTableRow) entran con fade-up en cascada (cap 0.4s).
 *
 *   <Table>
 *     <TableHeader>...</TableHeader>
 *     <TableBody>
 *       {items.map((row, i) => (
 *         <MotionTableRow key={row.id} index={i}>
 *           <TableCell>{row.a}</TableCell>
 *           ...
 *         </MotionTableRow>
 *       ))}
 *     </TableBody>
 *   </Table>
 *
 * Este archivo NO modifica src/components/ui/table.tsx; los demas
 * Table/TableHead/TableCell/etc. se siguen importando desde ahi.
 */

import * as React from "react";
import { motion, type HTMLMotionProps } from "framer-motion";

import { cn } from "@/lib/utils";
import { useReducedMotionSafe, QUINT_OUT } from "@/components/ui/motion";

interface MotionTableRowProps extends HTMLMotionProps<"tr"> {
  /** Posicion de la fila para escalonar el delay */
  index?: number;
  /** Cap superior del delay total (segundos). Default 0.4 */
  delayCap?: number;
  /** Step entre filas (segundos). Default 0.025 */
  stepDelay?: number;
}

const MotionTableRow = React.forwardRef<HTMLTableRowElement, MotionTableRowProps>(
  (
    {
      index = 0,
      delayCap = 0.4,
      stepDelay = 0.025,
      className,
      children,
      ...rest
    },
    ref,
  ) => {
    const reduced = useReducedMotionSafe();
    const delay = Math.min(index * stepDelay, delayCap);

    return (
      <motion.tr
        ref={ref}
        initial={reduced ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: reduced ? 0 : 0.25,
          ease: QUINT_OUT,
          delay: reduced ? 0 : delay,
        }}
        className={cn(
          "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
          className,
        )}
        {...rest}
      >
        {children}
      </motion.tr>
    );
  },
);
MotionTableRow.displayName = "MotionTableRow";

export { MotionTableRow };
