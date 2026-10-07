"use client"

/**
 * Switch compartido — único Switch del POS.
 *
 * Objetivos:
 *   - Reemplazar en toda la app al Switch de @heroui/react.
 *   - Mantener API retrocompatible (acepta tanto los props de HeroUI
 *     `isSelected / onValueChange / isDisabled / defaultSelected` como
 *     los canónicos de Radix `checked / onCheckedChange / disabled /
 *     defaultChecked`), para no romper los call-sites existentes.
 *   - Estética neon/3D neumórfica (track oscuro, glow al activar,
 *     perilla con relieve, dot verde/rojo de estado, aro de focus visible).
 *   - Accesibilidad: `role="switch"` + `aria-checked` provistos por Radix,
 *     `aria-label` reenviado, label clicable sincronizado con `htmlFor`.
 *   - Responde a `prefers-reduced-motion` desactivando transiciones.
 *   - Soporta tamaños (`sm | md | lg`) y variantes de color de glow
 *     (`default | primary | success | warning | danger | secondary`).
 *
 * El componente convive con otros controles especializados que NO deben
 * migrarse (ThemeToggle segmentado, ThemeTogglePill, SoundToggle, los
 * checkboxes custom del generador de reportes y el Checkbox de alias
 * en recepción). Ver inventario estático en los tests app-wide.
 */

import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

type SwitchSize = "sm" | "md" | "lg"
type SwitchColor =
  | "default"
  | "primary"
  | "secondary"
  | "success"
  | "warning"
  | "danger"

/**
 * Mapa HeroUI → nuestro contrato. Se preserva para que `classNames={{...}}`
 * siga teniendo el efecto esperado por quien ya lo pase, aunque los
 * call-sites actuales no lo requieren después de la migración.
 */
export interface SwitchClassNames {
  /** Clases sobre el wrapper externo (label clicable). */
  base?: string
  /** Clases sobre el track (botón `role="switch"`). */
  wrapper?: string
  /** Clases sobre la perilla deslizante. */
  thumb?: string
  /** Clases sobre el dot de estado (esquina superior izquierda). */
  dot?: string
  /** Clases sobre el label de texto a la derecha del switch. */
  label?: string
}

type RadixRootProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>

export interface SwitchProps
  extends Omit<RadixRootProps, "onCheckedChange" | "children" | "color"> {
  // ────── Contrato canónico (Radix) ──────
  onCheckedChange?: (checked: boolean) => void
  // ────── Alias HeroUI (retrocompatibles) ──────
  isSelected?: boolean
  defaultSelected?: boolean
  onValueChange?: (checked: boolean) => void
  isDisabled?: boolean
  // ────── Visual / layout ──────
  size?: SwitchSize
  color?: SwitchColor
  classNames?: SwitchClassNames
  /**
   * Etiqueta clicable asociada al switch. Si está presente, el componente
   * se envuelve en un `<label htmlFor={id}>` para que todo el bloque sea
   * un hit-target accesible.
   */
  children?: React.ReactNode
}

/**
 * Tokens de tamaño. Mantienen la relación visual del Switch de referencia
 * (track oscuro ancho con perilla sobresalida) escalada en tres pasos.
 */
const SIZE_TOKENS: Record<SwitchSize, {
  track: string
  thumb: string
  thumbTranslate: string
  dot: string
  dotPos: string
  gap: string
  label: string
}> = {
  sm: {
    track: "h-6 w-11",
    thumb: "h-[18px] w-[18px]",
    thumbTranslate:
      "data-[state=checked]:translate-x-[22px] data-[state=unchecked]:translate-x-[3px]",
    dot: "h-[7px] w-[7px]",
    dotPos: "-top-[3px] -left-[3px]",
    gap: "gap-2.5",
    label: "text-[11px]",
  },
  md: {
    track: "h-[30px] w-[52px]",
    thumb: "h-[22px] w-[22px]",
    thumbTranslate:
      "data-[state=checked]:translate-x-[26px] data-[state=unchecked]:translate-x-[3px]",
    dot: "h-2 w-2",
    dotPos: "-top-1 -left-1",
    gap: "gap-3",
    label: "text-xs",
  },
  lg: {
    track: "h-9 w-16",
    thumb: "h-[26px] w-[26px]",
    thumbTranslate:
      "data-[state=checked]:translate-x-[32px] data-[state=unchecked]:translate-x-[4px]",
    dot: "h-2.5 w-2.5",
    dotPos: "-top-1 -left-1",
    gap: "gap-3",
    label: "text-sm",
  },
}

/**
 * Tokens de color. Alteran únicamente el aro/glow al activar y el color
 * del dot encendido. Los estados "off" y las sombras internas se mantienen
 * invariantes para preservar la metáfora de "pozo apagado".
 */
const COLOR_TOKENS: Record<SwitchColor, {
  glow: string
  border: string
  dotOn: string
  ring: string
}> = {
  default: {
    glow:
      "data-[state=checked]:shadow-[0_0_15px_rgba(34,211,238,0.55),inset_3px_3px_6px_rgba(0,0,0,0.75)]",
    border: "data-[state=checked]:border-cyan-400/60",
    dotOn:
      "group-data-[state=checked]:bg-cyan-300 group-data-[state=checked]:shadow-[0_0_8px_2px_rgba(103,232,249,0.65)]",
    ring: "focus-visible:ring-cyan-400",
  },
  primary: {
    glow:
      "data-[state=checked]:shadow-[0_0_15px_rgba(59,130,246,0.55),inset_3px_3px_6px_rgba(0,0,0,0.75)]",
    border: "data-[state=checked]:border-blue-500/60",
    dotOn:
      "group-data-[state=checked]:bg-blue-400 group-data-[state=checked]:shadow-[0_0_8px_2px_rgba(96,165,250,0.65)]",
    ring: "focus-visible:ring-blue-500",
  },
  secondary: {
    glow:
      "data-[state=checked]:shadow-[0_0_15px_rgba(168,85,247,0.55),inset_3px_3px_6px_rgba(0,0,0,0.75)]",
    border: "data-[state=checked]:border-violet-500/60",
    dotOn:
      "group-data-[state=checked]:bg-violet-400 group-data-[state=checked]:shadow-[0_0_8px_2px_rgba(167,139,250,0.65)]",
    ring: "focus-visible:ring-violet-500",
  },
  success: {
    glow:
      "data-[state=checked]:shadow-[0_0_15px_rgba(16,185,129,0.55),inset_3px_3px_6px_rgba(0,0,0,0.75)]",
    border: "data-[state=checked]:border-emerald-500/60",
    dotOn:
      "group-data-[state=checked]:bg-emerald-400 group-data-[state=checked]:shadow-[0_0_8px_2px_rgba(52,211,153,0.65)]",
    ring: "focus-visible:ring-emerald-500",
  },
  warning: {
    glow:
      "data-[state=checked]:shadow-[0_0_15px_rgba(245,158,11,0.55),inset_3px_3px_6px_rgba(0,0,0,0.75)]",
    border: "data-[state=checked]:border-amber-400/60",
    dotOn:
      "group-data-[state=checked]:bg-amber-400 group-data-[state=checked]:shadow-[0_0_8px_2px_rgba(251,191,36,0.65)]",
    ring: "focus-visible:ring-amber-400",
  },
  danger: {
    glow:
      "data-[state=checked]:shadow-[0_0_15px_rgba(244,63,94,0.55),inset_3px_3px_6px_rgba(0,0,0,0.75)]",
    border: "data-[state=checked]:border-rose-500/60",
    dotOn:
      "group-data-[state=checked]:bg-rose-400 group-data-[state=checked]:shadow-[0_0_8px_2px_rgba(251,113,133,0.65)]",
    ring: "focus-visible:ring-rose-500",
  },
}

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  SwitchProps
>(function Switch(
  {
    className,
    classNames,
    size = "sm",
    color = "success",
    checked,
    defaultChecked,
    onCheckedChange,
    isSelected,
    defaultSelected,
    onValueChange,
    disabled,
    isDisabled,
    children,
    id: idProp,
    ...rest
  },
  ref,
) {
  const generatedId = React.useId()
  const id = idProp ?? `switch-${generatedId.replace(/:/g, "")}`

  // Normalizamos ambos contratos: HeroUI gana si se pasan los dos, lo cual
  // es lo que esperaban los call-sites actuales.
  const resolvedChecked = isSelected ?? checked
  const resolvedDefaultChecked = defaultSelected ?? defaultChecked
  const resolvedDisabled = isDisabled ?? disabled

  const handleChange = React.useCallback(
    (next: boolean) => {
      onCheckedChange?.(next)
      onValueChange?.(next)
    },
    [onCheckedChange, onValueChange],
  )

  const sizeTokens = SIZE_TOKENS[size]
  const colorTokens = COLOR_TOKENS[color]

  const trackClassName = cn(
    "group peer relative inline-flex shrink-0 cursor-pointer items-center rounded-full",
    "bg-[#1a1c23] border border-[#2f333e]",
    sizeTokens.track,
    // Estado off: pozo neumórfico (sombra interior pronunciada).
    "data-[state=unchecked]:shadow-[inset_3px_3px_6px_rgba(0,0,0,0.8),inset_-3px_-3px_6px_rgba(255,255,255,0.03)]",
    // Estado on: glow externo (color según `color`) + leve sombra interior
    // para no perder volumen.
    colorTokens.glow,
    colorTokens.border,
    // Transiciones (respetan `prefers-reduced-motion`).
    "transition-all duration-500 motion-reduce:transition-none motion-reduce:duration-0",
    // Focus visible accesible (aro de 2px separado del track).
    "outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    colorTokens.ring,
    // Disabled estándar: cursor + opacidad.
    "disabled:cursor-not-allowed disabled:opacity-50",
    // Hooks de personalización.
    classNames?.wrapper,
    className,
  )

  const dotClassName = cn(
    "pointer-events-none absolute rounded-full",
    sizeTokens.dot,
    sizeTokens.dotPos,
    // Estado off: dot rojo con glow sutil (status indicator "apagado").
    "bg-rose-500 shadow-[0_0_8px_2px_rgba(244,63,94,0.6)]",
    // Estado on: dot encendido en el color del switch.
    colorTokens.dotOn,
    "transition-all duration-500 motion-reduce:transition-none motion-reduce:duration-0",
    classNames?.dot,
  )

  const thumbClassName = cn(
    "pointer-events-none block rounded-full",
    sizeTokens.thumb,
    // Perilla 3D: gradiente + sombra proyectada + highlight superior.
    "bg-gradient-to-br from-[#2a2d35] to-[#1c1e24] border border-[#3f434d]/50",
    "shadow-[2px_2px_5px_rgba(0,0,0,0.7),-1px_-1px_3px_rgba(255,255,255,0.1)]",
    // Desplazamiento según tamaño.
    sizeTokens.thumbTranslate,
    // Transición respetando reduced-motion.
    "transition-transform duration-500 ease-out motion-reduce:transition-none motion-reduce:duration-0",
    classNames?.thumb,
  )

  const root = (
    <SwitchPrimitives.Root
      {...rest}
      id={id}
      ref={ref}
      checked={resolvedChecked}
      defaultChecked={resolvedDefaultChecked}
      onCheckedChange={handleChange}
      disabled={resolvedDisabled}
      className={trackClassName}
    >
      <span className={dotClassName} aria-hidden="true" />
      <SwitchPrimitives.Thumb className={thumbClassName} />
    </SwitchPrimitives.Root>
  )

  if (!children) return root

  return (
    <label
      htmlFor={id}
      className={cn(
        "inline-flex items-center select-none",
        sizeTokens.gap,
        resolvedDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        classNames?.base,
      )}
    >
      {root}
      <span
        className={cn(
          "text-foreground",
          sizeTokens.label,
          classNames?.label,
        )}
      >
        {children}
      </span>
    </label>
  )
})

Switch.displayName = "Switch"

export { Switch }
