"use client";

/**
 * Motion utilities — POS Pro
 * --------------------------------------------------------------
 * Catalogo: #1 MotionPage, #2 Stagger/StaggerItem, #3 AnimatedCounter,
 *           #32 useReducedMotionSafe + variants compartidas.
 *
 * Easing del proyecto:
 *   - "Quint out"    [0.16, 1, 0.3, 1]  → entradas/exits suaves (default)
 *   - "Spring soft"  stiffness:320, damping:32 → layout, sidebar
 *   - "Spring bouncy" stiffness:400, damping:14 → iconos importantes
 */

import * as React from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type HTMLMotionProps,
  type MotionProps,
  type Variants,
} from "framer-motion";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

// ============================================================
// Curvas y duraciones estandar
// ============================================================

export const QUINT_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

export const SPRING_SOFT = {
  type: "spring" as const,
  stiffness: 320,
  damping: 32,
};

export const SPRING_BOUNCY = {
  type: "spring" as const,
  stiffness: 400,
  damping: 14,
};

export const SPRING_FIRM = {
  type: "spring" as const,
  stiffness: 500,
  damping: 32,
};

// ============================================================
// Variants compartidas
// ============================================================

export const fadeUpVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: QUINT_OUT },
  },
  exit: {
    opacity: 0,
    y: -8,
    transition: { duration: 0.18, ease: "easeIn" },
  },
};

export const fadeInVariants: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.3, ease: QUINT_OUT } },
  exit: { opacity: 0, transition: { duration: 0.18, ease: "easeIn" } },
};

export const scaleInVariants: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  show: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.25, ease: QUINT_OUT },
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    transition: { duration: 0.16, ease: "easeIn" },
  },
};

/**
 * Genera un container variant para staggered children.
 *
 *   <Stagger staggerChildren={0.08} delayChildren={0.1}>
 *     <StaggerItem>...</StaggerItem>
 *   </Stagger>
 */
export const staggerContainer = (
  staggerChildren = 0.08,
  delayChildren = 0,
): Variants => ({
  hidden: {},
  show: {
    transition: { staggerChildren, delayChildren },
  },
});

// ============================================================
// useReducedMotionSafe (#32)
// ============================================================

/**
 * Wrapper de useReducedMotion que tambien es seguro durante SSR
 * (en SSR siempre devuelve `false` para no perder animaciones en
 * el primer paint, y tras montar respeta la preferencia del SO).
 */
export function useReducedMotionSafe(): boolean {
  const prefers = useReducedMotion();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return false;
  return Boolean(prefers);
}

// ============================================================
// #1 MotionPage — page transitions en App Router
// ============================================================

interface MotionPageProps extends Omit<HTMLMotionProps<"div">, "variants"> {
  /** Clase opcional para el contenedor */
  className?: string;
  /** Override manual de la key (por defecto usePathname) */
  pageKey?: string;
  children: React.ReactNode;
}

/**
 * Envuelve cada pagina con un fade+slide al cambiar de ruta.
 * Adaptado al App Router de Next: usa `usePathname()` como key.
 *
 *   // src/app/(app)/layout.tsx
 *   <MotionPage>{children}</MotionPage>
 */
export function MotionPage({
  className,
  children,
  pageKey,
  ...rest
}: MotionPageProps) {
  const pathname = usePathname();
  const reduced = useReducedMotionSafe();
  const key = pageKey ?? pathname ?? "page";

  if (reduced) {
    return <div className={className}>{children}</div>;
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={key}
        variants={fadeUpVariants}
        initial="hidden"
        animate="show"
        exit="exit"
        className={className}
        {...rest}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

// ============================================================
// #2 Stagger / StaggerItem — list reveal en cascada
// ============================================================

type StaggerProps = Omit<HTMLMotionProps<"div">, "variants"> & {
  staggerChildren?: number;
  delayChildren?: number;
  as?: keyof JSX.IntrinsicElements;
};

export function Stagger({
  staggerChildren = 0.08,
  delayChildren = 0,
  initial = "hidden",
  animate = "show",
  className,
  children,
  ...rest
}: StaggerProps) {
  const reduced = useReducedMotionSafe();
  const variants = React.useMemo(
    () =>
      reduced
        ? staggerContainer(0, 0)
        : staggerContainer(staggerChildren, delayChildren),
    [reduced, staggerChildren, delayChildren],
  );

  return (
    <motion.div
      className={className}
      variants={variants}
      initial={initial}
      animate={animate}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

type StaggerItemProps = Omit<HTMLMotionProps<"div">, "variants"> & {
  variants?: Variants;
};

export function StaggerItem({
  variants = fadeUpVariants,
  className,
  children,
  ...rest
}: StaggerItemProps) {
  return (
    <motion.div className={className} variants={variants} {...rest}>
      {children}
    </motion.div>
  );
}

// ============================================================
// #3 AnimatedCounter — count-up animado
// ============================================================

interface AnimatedCounterProps {
  /** Valor objetivo */
  value: number;
  /** Funcion formateadora (e.g. formatCOP) */
  format?: (n: number) => string;
  /** Spring stiffness (mas alto = mas rapido). Default 90 */
  stiffness?: number;
  /** Spring damping. Default 30 */
  damping?: number;
  /** Punto de partida (default 0) */
  from?: number;
  className?: string;
}

/**
 * Tween con `useSpring` desde `from` hasta `value`. Renderiza texto.
 *
 *   <AnimatedCounter value={48295} format={formatCOP} />
 */
export function AnimatedCounter({
  value,
  format,
  stiffness = 90,
  damping = 30,
  from = 0,
  className,
}: AnimatedCounterProps) {
  const reduced = useReducedMotionSafe();
  const mv = useMotionValue(from);
  const spring = useSpring(mv, { stiffness, damping });
  const display = useTransform(spring, (latest) => {
    const rounded = Math.round(latest);
    return format ? format(rounded) : String(rounded);
  });

  React.useEffect(() => {
    if (reduced) {
      mv.set(value);
      return;
    }
    mv.set(value);
  }, [value, mv, reduced]);

  return <motion.span className={className}>{display}</motion.span>;
}

// ============================================================
// Helpers
// ============================================================

/**
 * Atajo para envolver cualquier elemento en un `motion.div` con whileHover lift.
 *
 *   <HoverLift>
 *     <Card>...</Card>
 *   </HoverLift>
 */
export function HoverLift({
  className,
  children,
  ...rest
}: HTMLMotionProps<"div">) {
  const reduced = useReducedMotionSafe();
  return (
    <motion.div
      whileHover={reduced ? undefined : { y: -2 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      className={cn(className)}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

// Re-exports utiles para no obligar a importar de framer-motion en sitios donde
// solo se necesitan estas piezas.
export { AnimatePresence, motion };
export type { MotionProps, Variants };



// ============================================================
// MoneyDigits / NumberDigits — wrappers universales
// ============================================================

import { RollingDigits } from "@/components/charts/RollingDigits";
import { formatCurrency } from "@/lib/utils";

interface MoneyDigitsProps {
  /** Valor numerico a animar */
  value: number;
  /** Mostrar el "$" antes del numero (default true) */
  prefix?: boolean;
  /** Duracion del rolling (default 1.4s) */
  duration?: number;
  className?: string;
}

/**
 * Muestra un valor monetario con formateo COP y animacion slot-machine.
 * Drop-in replacement para `${formatCurrency(x)}` en cards/widgets.
 *
 *   // Antes:
 *   <span>${formatCurrency(amount)}</span>
 *   // Despues:
 *   <MoneyDigits value={amount} />
 */
export function MoneyDigits({
  value,
  prefix = true,
  duration = 1.4,
  className,
}: MoneyDigitsProps) {
  const safe = Math.round(Number(value) || 0);
  const isNeg = safe < 0;
  const abs = Math.abs(safe);

  return (
    <span className={className}>
      {isNeg && "-"}
      {prefix && "$"}
      <RollingDigits value={abs} format={(n) => formatCurrency(n)} duration={duration} />
    </span>
  );
}

interface NumberDigitsProps {
  value: number;
  duration?: number;
  /** Sufijo opcional ej. "%" o "u" */
  suffix?: string;
  /** Decimales (default 0) */
  decimals?: number;
  className?: string;
}

/**
 * Muestra un numero entero/decimal con animacion slot-machine.
 * Util para conteos, porcentajes, unidades, etc.
 */
export function NumberDigits({
  value,
  duration = 1.2,
  suffix = "",
  decimals = 0,
  className,
}: NumberDigitsProps) {
  const factor = Math.pow(10, decimals);
  const safe = Math.round((Number(value) || 0) * factor);

  return (
    <span className={className}>
      <RollingDigits
        value={Math.abs(safe)}
        format={(n) => {
          const display = decimals > 0 ? (n / factor).toFixed(decimals) : String(n);
          return display + suffix;
        }}
        duration={duration}
      />
    </span>
  );
}
