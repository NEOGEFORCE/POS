"use client"

import * as React from "react"
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group"
import { Circle } from "lucide-react"

import { cn } from "@/lib/utils"

const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => {
  return (
    <RadioGroupPrimitive.Root
      className={cn("grid gap-2", className)}
      {...props}
      ref={ref}
    />
  )
})
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName

const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        "group aspect-square h-[22px] w-[22px] rounded-full transition-all duration-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 relative",
        // Base dark look
        "bg-[#1a1c23] border border-[#2f333e]",
        // Unchecked state (Neumorphic dark hole)
        "data-[state=unchecked]:shadow-[inset_3px_3px_6px_rgba(0,0,0,0.8),inset_-3px_-3px_6px_rgba(255,255,255,0.03)]",
        // Checked state (Neon green glow track)
        "data-[state=checked]:shadow-[0_0_15px_rgba(16,185,129,0.5),inset_3px_3px_6px_rgba(0,0,0,0.8)] data-[state=checked]:border-emerald-500/50",
        className
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="flex items-center justify-center relative w-full h-full">
        {/* Glowing dot on the top left */}
        <span 
            className={cn(
                "absolute -top-1 -left-1 w-2 h-2 rounded-full transition-all duration-500",
                "bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.6)]"
            )} 
        />
        <div className="pointer-events-none block h-[12px] w-[12px] rounded-full transition-all duration-500 ease-out bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-[2px_2px_5px_rgba(0,0,0,0.7),-1px_-1px_3px_rgba(255,255,255,0.1)] border border-[#3f434d]/50" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  )
})
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName

export { RadioGroup, RadioGroupItem }
