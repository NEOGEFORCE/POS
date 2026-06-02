"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Card — extendido con prop `interactive` (#13 Catalogo)
 * --------------------------------------------------------------
 * - `interactive` activa el efecto spotlight (radial gradient verde
 *   que sigue al cursor, definido en globals.css `.card-spotlight`).
 * - El spotlight usa CSS variables `--spotlight-x/--spotlight-y`
 *   actualizadas en `onMouseMove`.
 * - API base sin cambios (forwardRef, mismas clases por defecto).
 */

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, interactive = false, onMouseMove, ...props }, ref) => {
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
          onMouseMove?.(e);
        },
        [interactive, onMouseMove],
      );

    return (
      <div
        ref={ref}
        onMouseMove={handleMouseMove}
        className={cn(
          "rounded-2xl border bg-card text-card-foreground shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all duration-300",
          interactive && "card-spotlight hover:border-[var(--accent-border)]",
          className,
        )}
        {...props}
      />
    );
  },
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "text-2xl font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
};
