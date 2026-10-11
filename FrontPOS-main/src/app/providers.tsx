"use client";

import { useEffect } from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { HeroUIProvider } from "@heroui/react";
import { SWRConfig } from 'swr';

import { installWebSocketPosBridge } from "@/lib/pos-bridge-ws";

/**
 * Conector mínimo: al montar el árbol de providers intenta instalar el
 * cliente WebSocket de `window.posBridge`. Si ya hay un bridge nativo
 * preexistente (electron shell, chromium wrapper), `installWebSocketPosBridge`
 * respeta esa instancia y no la sobreescribe.
 *
 * No montamos el cliente en el initializer de un `useState` ni en el
 * módulo tope: queremos que la conexión se abra sólo una vez por sesión
 * del navegador y que no se intente en SSR (export estático).
 */
function PosBridgeConnector() {
    useEffect(() => {
        installWebSocketPosBridge();
    }, []);
    return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <NextThemesProvider attribute="class" defaultTheme="dark" enableSystem={false}>
            <HeroUIProvider>
                <SWRConfig value={{
                    revalidateOnFocus: true,
                    revalidateOnMount: true,
                    revalidateOnReconnect: true,
                    dedupingInterval: 5000
                }}>
                    <PosBridgeConnector />
                    {children}
                </SWRConfig>
            </HeroUIProvider>
        </NextThemesProvider>
    );
}
