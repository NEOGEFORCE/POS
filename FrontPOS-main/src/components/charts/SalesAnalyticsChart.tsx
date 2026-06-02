"use client";

/**
 * SalesAnalyticsChart — #9 Catalogo
 * --------------------------------------------------------------
 * Line chart con:
 *   - Path drawing (pathLength: 0→1)
 *   - Area gradient que aparece despues
 *   - Tooltip auto-tour: cada `tourInterval`s avanza un punto
 *   - Hover override (pausa el tour mientras hay mouse)
 *   - Tooltip + dot + crosshair con spring fluido
 *
 *   <SalesAnalyticsChart
 *     title="Ventas diarias"
 *     scopeLabel="Ventas"
 *     rangeLabel="10–16 abr"
 *     autoTour
 *     tourInterval={2.4}
 *     data={[{label, value, amount?}, ...]}
 *   />
 */

import * as React from "react";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { useReducedMotionSafe, QUINT_OUT } from "@/components/ui/motion";

export interface SalesPoint {
  label: string;
  value: number;
  /** Valor secundario opcional mostrado en tooltip */
  amount?: number;
}

interface SalesAnalyticsChartProps {
  title?: string;
  scopeLabel?: string;
  rangeLabel?: string;
  data: SalesPoint[];
  autoTour?: boolean;
  /** Segundos entre puntos del tour (default 2.4) */
  tourInterval?: number;
  /** Color principal */
  color?: string;
  /** Formateador del valor en tooltip */
  format?: (n: number) => string;
  className?: string;
  height?: number;
}

const ACCENT = "var(--accent, #10b981)";

function catmullRom(points: { x: number; y: number }[]) {
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

export function SalesAnalyticsChart({
  title,
  scopeLabel,
  rangeLabel,
  data,
  autoTour = false,
  tourInterval = 2.4,
  color = ACCENT,
  format = (n) => n.toLocaleString(),
  className,
  height = 220,
}: SalesAnalyticsChartProps) {
  const reduced = useReducedMotionSafe();
  const gradId = React.useId();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(560);

  React.useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 560;
      setWidth(Math.max(280, w));
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const padX = 12;
  const padY = 16;
  const inner = { w: width - padX * 2, h: height - padY * 2 };

  const max = Math.max(...data.map((d) => d.value), 1);
  const min = Math.min(...data.map((d) => d.value), 0);
  const range = Math.max(max - min, 1);

  const points = data.map((d, i) => ({
    x:
      data.length === 1
        ? padX + inner.w / 2
        : padX + (i / (data.length - 1)) * inner.w,
    y: padY + inner.h - ((d.value - min) / range) * inner.h,
  }));

  const linePath = catmullRom(points);
  const areaPath = points.length
    ? `${linePath} L ${points[points.length - 1].x} ${padY + inner.h} L ${points[0].x} ${padY + inner.h} Z`
    : "";

  // ──────────── Auto-tour ────────────
  const [tourIdx, setTourIdx] = React.useState(0);
  const [hoverIdx, setHoverIdx] = React.useState<number | null>(null);
  const [isHovering, setIsHovering] = React.useState(false);

  React.useEffect(() => {
    if (!autoTour || isHovering || reduced || data.length === 0) return;
    const id = window.setInterval(
      () => setTourIdx((i) => (i + 1) % data.length),
      Math.max(400, tourInterval * 1000),
    );
    return () => window.clearInterval(id);
  }, [autoTour, isHovering, data.length, tourInterval, reduced]);

  const activeIdx = hoverIdx ?? (autoTour && !reduced ? tourIdx : null);
  const activePoint = activeIdx != null ? points[activeIdx] : null;
  const activeData = activeIdx != null ? data[activeIdx] : null;

  // ──────────── Mouse → idx ────────────
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (data.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const localX = e.clientX - rect.left - padX;
    const ratio = Math.max(0, Math.min(1, localX / inner.w));
    const idx = Math.round(ratio * (data.length - 1));
    setHoverIdx(idx);
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative flex w-full flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-[var(--shadow-card)]",
        className,
      )}
    >
      {(title || scopeLabel || rangeLabel) && (
        <div className="flex items-end justify-between">
          <div>
            {title && (
              <h3 className="text-sm font-medium tracking-tight text-[var(--text-primary)]">
                {title}
              </h3>
            )}
            {scopeLabel && (
              <p className="text-[10px] font-medium uppercase tracking-widest text-[var(--text-muted)]">
                {scopeLabel}
              </p>
            )}
          </div>
          {rangeLabel && (
            <p className="text-[10px] font-medium uppercase tracking-widest text-[var(--text-muted)]">
              {rangeLabel}
            </p>
          )}
        </div>
      )}

      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          onMouseMove={onMouseMove}
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => {
            setIsHovering(false);
            setHoverIdx(null);
          }}
          className="block w-full overflow-visible"
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>

          {/* Area */}
          <motion.path
            d={areaPath}
            fill={`url(#${gradId})`}
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{
              duration: reduced ? 0 : 0.8,
              delay: reduced ? 0 : 0.6,
              ease: QUINT_OUT,
            }}
          />

          {/* Linea */}
          <motion.path
            d={linePath}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{
              duration: reduced ? 0 : 1.4,
              ease: QUINT_OUT,
            }}
            style={{ filter: `drop-shadow(0 0 6px ${color})` }}
          />

          {/* Crosshair vertical */}
          {activePoint && (
            <motion.line
              x1={activePoint.x}
              x2={activePoint.x}
              y1={padY}
              y2={padY + inner.h}
              stroke="currentColor"
              strokeOpacity={0.18}
              strokeDasharray="2 4"
              initial={false}
              animate={{ x1: activePoint.x, x2: activePoint.x }}
              transition={{ type: "spring", stiffness: 220, damping: 26 }}
            />
          )}

          {/* Dot activo */}
          {activePoint && (
            <motion.g
              initial={false}
              animate={{ x: activePoint.x, y: activePoint.y }}
              transition={{ type: "spring", stiffness: 220, damping: 26 }}
            >
              <circle r={6} fill={color} fillOpacity={0.18} />
              <circle r={3.5} fill={color} />
            </motion.g>
          )}
        </svg>

        {/* Tooltip */}
        {activePoint && activeData && (
          <motion.div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[11px] font-medium text-[var(--text-primary)] shadow-[var(--shadow-card)]"
            initial={false}
            animate={{
              left: activePoint.x,
              top: activePoint.y - 12,
              opacity: 1,
            }}
            transition={{ type: "spring", stiffness: 220, damping: 26 }}
          >
            <div className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
              {activeData.label}
            </div>
            <div className="font-medium tabular-nums">
              {format(activeData.value)}
            </div>
            {activeData.amount != null && (
              <div className="text-[10px] tabular-nums text-[var(--text-secondary)]">
                {format(activeData.amount)}
              </div>
            )}
          </motion.div>
        )}
      </div>

      {/* Eje X */}
      {data.length > 0 && (
        <div className="flex justify-between px-1 text-[9px] font-medium uppercase tracking-widest text-[var(--text-muted)]">
          {data.map((d, i) => (
            <span
              key={i}
              className={cn(
                i === activeIdx && "text-[var(--text-primary)]",
                "transition-colors duration-200",
              )}
            >
              {d.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
