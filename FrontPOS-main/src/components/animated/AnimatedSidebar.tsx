"use client";

/**
 * AnimatedSidebar — Catalogo #19, #20, #21
 * --------------------------------------------------------------
 * Componente OPCIONAL e independiente que demuestra:
 *   #19 Sidebar collapse — width spring (256 ↔ 68)
 *   #20 Active indicator — `layoutId` shared (magic-move)
 *   #21 Items stagger    — entran en cascada
 *
 * Pensado para usarse en su propio layout (no reemplaza al
 * AppSidebar existente). Es plug-and-play con next/navigation.
 *
 *   const items = [
 *     { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
 *     ...
 *   ];
 *
 *   <AnimatedSidebar items={items} />
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import type { LucideProps } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  useReducedMotionSafe,
  SPRING_SOFT,
  staggerContainer,
} from "@/components/ui/motion";

export interface AnimatedSidebarItem {
  href: string;
  label: string;
  icon: React.ComponentType<LucideProps>;
}

interface AnimatedSidebarProps {
  items: AnimatedSidebarItem[];
  /** Default `false`. Si quieres iniciar colapsado. */
  defaultCollapsed?: boolean;
  /** Ancho expandido (default 256). */
  expandedWidth?: number;
  /** Ancho colapsado (default 68). */
  collapsedWidth?: number;
  className?: string;
  /** Slot para el header (logo + boton collapse). */
  header?: React.ReactNode;
  /** Slot para el footer (logout, user info). */
  footer?: React.ReactNode;
}

const ITEM_VARIANTS = {
  hidden: { opacity: 0, y: 6 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] as const },
  },
};

export function AnimatedSidebar({
  items,
  defaultCollapsed = false,
  expandedWidth = 256,
  collapsedWidth = 68,
  className,
  header,
  footer,
}: AnimatedSidebarProps) {
  const pathname = usePathname() ?? "";
  const reduced = useReducedMotionSafe();
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? collapsedWidth : expandedWidth }}
      transition={reduced ? { duration: 0 } : SPRING_SOFT}
      className={cn(
        "relative flex h-full flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--bg-sidebar)] py-3",
        className,
      )}
    >
      {header && <div className="px-3 pb-3">{header}</div>}

      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? "Expandir menu" : "Colapsar menu"}
        className="mx-3 mb-3 inline-flex h-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent-border)] hover:text-[var(--accent)]"
      >
        <span className="text-[10px] font-bold uppercase tracking-widest">
          {collapsed ? "›" : "‹"}
        </span>
      </button>

      <motion.ul
        variants={
          reduced
            ? staggerContainer(0, 0)
            : staggerContainer(0.05, 0.1)
        }
        initial="hidden"
        animate="show"
        className="flex flex-1 flex-col gap-1 px-3"
      >
        {items.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;

          return (
            <motion.li
              key={item.href}
              variants={ITEM_VARIANTS}
              className="relative"
            >
              <Link
                href={item.href}
                className={cn(
                  "group/btn relative flex h-10 items-center gap-3 overflow-hidden rounded-xl px-3 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]",
                )}
              >
                {/* #20 Active indicator con layoutId compartido */}
                {isActive && (
                  <motion.span
                    layoutId="animated-sidebar-active"
                    transition={
                      reduced
                        ? { duration: 0 }
                        : { type: "spring", stiffness: 400, damping: 32 }
                    }
                    className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-gradient-brand"
                  />
                )}

                <Icon
                  className={cn(
                    "h-[18px] w-[18px] shrink-0 transition-transform duration-300 group-hover/btn:scale-110",
                    isActive ? "text-[var(--accent)]" : "",
                  )}
                />

                <AnimatePresence initial={false}>
                  {!collapsed && (
                    <motion.span
                      key="label"
                      initial={
                        reduced ? false : { opacity: 0, x: -6 }
                      }
                      animate={{ opacity: 1, x: 0 }}
                      exit={
                        reduced
                          ? { opacity: 0 }
                          : { opacity: 0, x: -6 }
                      }
                      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                      className="whitespace-nowrap"
                    >
                      {item.label}
                    </motion.span>
                  )}
                </AnimatePresence>
              </Link>
            </motion.li>
          );
        })}
      </motion.ul>

      {footer && <div className="px-3 pt-3">{footer}</div>}
    </motion.aside>
  );
}
