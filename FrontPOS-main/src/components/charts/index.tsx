"use client";

/**
 * Mini charts — Catalogo #5–#8
 * --------------------------------------------------------------
 * #5 MiniBarChart   — bars que crecen desde abajo con stagger
 * #6 MiniCandleChart — candles OHLC mini con fade-up secuencial
 * #7 ArcGauge       — semicirculo SVG con strokeDashoffset animado
 * #8 SparkLine      — curva con pathLength + area gradient
 */

import * as React from "react";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { useReducedMotionSafe, QUINT_OUT } from "@/components/ui/motion";

const ACCENT = "var(--accent, #10b981)";

// ============================================================
// #5 MiniBarChart
// ============================================================

interface MiniBarChartProps {
  data: number[];
  width?: number;
  height?: number;
  /** Indice de la barra "activa" (con glow). Default: penultima. */
  activeIndex?: number;
  /** Color principal (default: var(--accent)) */
  color?: string;
  className?: string;
}

export function MiniBarChart({
  data,
  width = 130,
  height = 48,
  activeIndex,
  color = ACCENT,
  className,
}: MiniBarChartProps) {
  const reduced = useReducedMotionSafe();
  const max = Math.max(...data, 1);
  const gap = 2;
  const barWidth = Math.max(2, (width - gap * (data.length - 1)) / data.length);
  const active = activeIndex ?? data.length - 2;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("overflow-visible", className)}
      preserveAspectRatio="none"
    >
      {data.map((v, i) => {
        const h = Math.max(2, (v / max) * height);
        const x = i * (barWidth + gap);
        const y = height - h;
        const isActive = i === active;

        return (
          <motion.rect
            key={i}
            x={x}
            width={barWidth}
            rx={1.5}
            ry={1.5}
            fill={isActive ? color : "currentColor"}
            opacity={isActive ? 1 : 0.35}
            initial={reduced ? false : { y: height, height: 0 }}
            animate={{ y, height: h }}
            transition={{
              duration: reduced ? 0 : 0.6,
              delay: reduced ? 0 : i * 0.04,
              ease: QUINT_OUT,
            }}
            style={
              isActive
                ? { filter: `drop-shadow(0 0 6px ${color})` }
                : undefined
            }
          />
        );
      })}
    </svg>
  );
}

// ============================================================
// #6 MiniCandleChart
// ============================================================

export interface CandleDatum {
  /** Open */
  o: number;
  /** High */
  h: number;
  /** Low */
  l: number;
  /** Close */
  c: number;
}

interface MiniCandleChartProps {
  data: CandleDatum[];
  width?: number;
  height?: number;
  bullishColor?: string;
  bearishColor?: string;
  className?: string;
}

export function MiniCandleChart({
  data,
  width = 130,
  height = 48,
  bullishColor = ACCENT,
  bearishColor = "#ef4444",
  className,
}: MiniCandleChartProps) {
  const reduced = useReducedMotionSafe();

  const allValues = data.flatMap((d) => [d.h, d.l, d.o, d.c]);
  const max = Math.max(...allValues, 1);
  const min = Math.min(...allValues, 0);
  const range = Math.max(max - min, 1);

  const gap = 2;
  const candleWidth = Math.max(
    2,
    (width - gap * (data.length - 1)) / data.length,
  );

  const scaleY = (v: number) => height - ((v - min) / range) * height;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("overflow-visible", className)}
      preserveAspectRatio="none"
    >
      {data.map((d, i) => {
        const isBullish = d.c >= d.o;
        const color = isBullish ? bullishColor : bearishColor;
        const x = i * (candleWidth + gap);
        const wickX = x + candleWidth / 2;
        const yHigh = scaleY(d.h);
        const yLow = scaleY(d.l);
        const yOpen = scaleY(d.o);
        const yClose = scaleY(d.c);
        const bodyTop = Math.min(yOpen, yClose);
        const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));

        return (
          <motion.g
            key={i}
            initial={reduced ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: reduced ? 0 : 0.35,
              delay: reduced ? 0 : i * 0.04,
              ease: QUINT_OUT,
            }}
          >
            <line
              x1={wickX}
              x2={wickX}
              y1={yHigh}
              y2={yLow}
              stroke={color}
              strokeWidth={1}
              opacity={0.6}
            />
            <rect
              x={x}
              y={bodyTop}
              width={candleWidth}
              height={bodyHeight}
              fill={color}
              opacity={isBullish ? 0.95 : 0.4}
              rx={1}
            />
          </motion.g>
        );
      })}
    </svg>
  );
}

// ============================================================
// #7 ArcGauge — semicirculo
// ============================================================

interface ArcGaugeProps {
  /** 0–100 */
  value: number;
  size?: number;
  thickness?: number;
  showLabel?: boolean;
  color?: string;
  trackColor?: string;
  className?: string;
  /** Sufijo del label (default "%") */
  suffix?: string;
}

export function ArcGauge({
  value,
  size = 130,
  thickness = 14,
  showLabel = true,
  color = ACCENT,
  trackColor = "currentColor",
  className,
  suffix = "%",
}: ArcGaugeProps) {
  const reduced = useReducedMotionSafe();
  const pct = Math.max(0, Math.min(100, value)) / 100;

  const half = size / 2;
  const r = half - thickness / 2;
  const cy = half;
  // Arco de medio circulo: de (thickness/2, half) a (size - thickness/2, half), curvandose hacia arriba.
  const path = `M ${thickness / 2} ${cy} A ${r} ${r} 0 0 1 ${size - thickness / 2} ${cy}`;
  const arcLen = Math.PI * r;

  return (
    <div
      className={cn("relative inline-flex flex-col items-center", className)}
      style={{ width: size, height: size / 2 + (showLabel ? 24 : 0) }}
    >
      <svg
        viewBox={`0 0 ${size} ${size / 2 + thickness}`}
        width={size}
        height={size / 2 + thickness}
        className="overflow-visible"
      >
        <path
          d={path}
          fill="none"
          stroke={trackColor}
          strokeOpacity={0.15}
          strokeWidth={thickness}
          strokeLinecap="round"
        />
        <motion.path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={arcLen}
          initial={reduced ? false : { strokeDashoffset: arcLen }}
          animate={{ strokeDashoffset: arcLen * (1 - pct) }}
          transition={{
            duration: reduced ? 0 : 1.4,
            ease: QUINT_OUT,
            delay: reduced ? 0 : 0.2,
          }}
          style={{ filter: `drop-shadow(0 0 8px ${color})` }}
        />
      </svg>
      {showLabel && (
        <span className="text-xl font-medium tabular-nums tracking-tight text-[var(--text-primary)]">
          {Math.round(value)}
          <span className="text-xs text-[var(--text-secondary)]">{suffix}</span>
        </span>
      )}
    </div>
  );
}

// ============================================================
// #8 SparkLine — path drawing + area gradient
// ============================================================

interface SparkLineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  className?: string;
  /** Mostrar area debajo de la curva con gradient (default true) */
  showArea?: boolean;
  /** Padding superior/inferior en pixeles (default 4) */
  pad?: number;
  strokeWidth?: number;
}

/**
 * Convierte una serie de puntos en un path catmull-rom suavizado a cubic-bezier.
 */
function catmullRomToBezier(points: { x: number; y: number }[]) {
  if (points.length < 2) return "";
  const d: string[] = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d.push(`C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`);
  }
  return d.join(" ");
}

export function SparkLine({
  data,
  width = 120,
  height = 40,
  color = ACCENT,
  className,
  showArea = true,
  pad = 4,
  strokeWidth = 1.75,
}: SparkLineProps) {
  const reduced = useReducedMotionSafe();
  const gradId = React.useId();

  if (data.length === 0) {
    return <svg width={width} height={height} className={className} />;
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = Math.max(max - min, 1);
  const usable = height - pad * 2;

  const points = data.map((v, i) => ({
    x: data.length === 1 ? width / 2 : (i / (data.length - 1)) * width,
    y: pad + usable - ((v - min) / range) * usable,
  }));

  const linePath = catmullRomToBezier(points);
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${height} L ${points[0].x} ${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("overflow-visible", className)}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>

      {showArea && (
        <motion.path
          d={areaPath}
          fill={`url(#${gradId})`}
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{
            duration: reduced ? 0 : 0.6,
            delay: reduced ? 0 : 0.6,
            ease: QUINT_OUT,
          }}
        />
      )}

      <motion.path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={reduced ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{
          duration: reduced ? 0 : 1.4,
          ease: QUINT_OUT,
        }}
        style={{ filter: `drop-shadow(0 0 4px ${color})` }}
      />
    </svg>
  );
}
