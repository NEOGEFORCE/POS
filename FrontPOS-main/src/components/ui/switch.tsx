"use client"

import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "group peer inline-flex h-[32px] w-[56px] shrink-0 cursor-pointer items-center rounded-full transition-all duration-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 relative",
      // Base dark look
      "bg-[#1a1c23] border border-[#2f333e]",
      // Unchecked state (Neumorphic dark hole)
      "data-[state=unchecked]:shadow-[inset_3px_3px_6px_rgba(0,0,0,0.8),inset_-3px_-3px_6px_rgba(255,255,255,0.03)]",
      // Checked state (Neon green glow track)
      "data-[state=checked]:shadow-[0_0_15px_rgba(16,185,129,0.5),inset_3px_3px_6px_rgba(0,0,0,0.8)] data-[state=checked]:border-emerald-500/50",
      className
    )}
    {...props}
    ref={ref}
  >
    {/* Glowing dot on the top left */}
    <span 
        className={cn(
            "absolute -top-1 -left-1 w-2 h-2 rounded-full transition-all duration-500",
            "group-data-[state=unchecked]:bg-rose-500 group-data-[state=unchecked]:shadow-[0_0_8px_2px_rgba(244,63,94,0.6)]",
            "group-data-[state=checked]:bg-emerald-400 group-data-[state=checked]:shadow-[0_0_8px_2px_rgba(52,211,153,0.6)]"
        )} 
    />

    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-[22px] w-[22px] rounded-full transition-all duration-500 ease-out",
        // Thumb neumorphism (popping out)
        "bg-gradient-to-br from-[#2a2d35] to-[#1c1e24] shadow-[2px_2px_5px_rgba(0,0,0,0.7),-1px_-1px_3px_rgba(255,255,255,0.1)] border border-[#3f434d]/50",
        "group-data-[state=checked]:translate-x-[28px] group-data-[state=unchecked]:translate-x-[4px]"
      )}
    />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
