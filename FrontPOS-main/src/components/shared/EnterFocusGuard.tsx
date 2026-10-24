"use client";

import { useEffect } from "react";
import { installEnterFocusGuard } from "@/lib/enter-focus-guard.mjs";

/**
 * Evita que Enter vuelva a abrir lo último que se pulsó con el mouse
 * (ver src/lib/enter-focus-guard.mjs). No renderiza nada.
 */
export default function EnterFocusGuard() {
    useEffect(() => installEnterFocusGuard(window), []);
    return null;
}
