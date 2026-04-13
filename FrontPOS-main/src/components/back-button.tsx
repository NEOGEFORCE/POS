"use client";

import { useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { ArrowLeft } from "lucide-react";

interface BackButtonProps {
    className?: string;
    variant?: "flat" | "solid" | "bordered" | "light" | "ghost";
    size?: "sm" | "md" | "lg";
    showText?: boolean;
    color?: "default" | "primary" | "secondary" | "success" | "warning" | "danger";
}

export function BackButton({ 
    className = "", 
    variant = "flat", 
    size = "md", 
    showText = true,
    color = "default"
}: BackButtonProps) {
    const router = useRouter();

    return (
        <Button
            size={size}
            variant={variant}
            color={color}
            isIconOnly={!showText}
            onPress={() => router.back()}
            className={`font-black uppercase tracking-widest transition-all hover:scale-105 active:scale-95 shadow-sm rounded-xl py-0 ${
                variant === "flat" && color === "default" ? "bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 border border-divider dark:border-white/5" : ""
            } ${className}`}
        >
            <ArrowLeft className={`${showText ? "mr-2" : ""} h-5 w-5`} strokeWidth={3} />
            {showText && <span className="text-[10px]">Volver</span>}
        </Button>
    );
}
