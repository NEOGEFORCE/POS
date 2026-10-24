"use client";

import { useEffect } from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { HeroUIProvider } from "@heroui/react";
import { SWRConfig } from 'swr';

import { getInstalledPosBridgeWsClient, installWebSocketPosBridge } from "@/lib/pos-bridge-ws";
import { ScaleBridge } from "@/lib/scaleBridge";

/**
 * Conector mínimo: al montar el árbol de providers intenta instalar el
 * cliente WebSocket de `window.posBridge`. Si ya hay un bridge nativo
 * preexistente (electron shell, chromium wrapper), `installWebSocketPosBridge`
 * respeta esa instancia y no la sobreescribe.
 *
 * El PRIMER useEffect queda aislado con una sola llamada para preservar el
 * contrato que validan los tests estáticos (una instalación por sesión).
 * Un SEGUNDO useEffect engancha el evento global `pos-bridge-renegotiate`
 * que el selector de caja de `BridgeStatus` emite al elegir un PC remoto;
 * eso fuerza una renegociación en ambos sockets (balanza + impresión).
 *
 * No montamos el cliente en el initializer de un `useState` ni en el
 * módulo tope: queremos que la conexión se abra sólo una vez por sesión
 * del navegador y que no se intente en SSR (export estático).
 */
function PosBridgeConnector() {
    useEffect(() => {
        installWebSocketPosBridge();
    }, []);

    useEffect(() => {
        const onRenegotiate = () => {
            try {
                const printClient = getInstalledPosBridgeWsClient();
                printClient?.renegotiate();
            } catch { /* ignore: fallo del cliente no debe tumbar la UI */ }
            try {
                ScaleBridge.getInstance().renegotiate();
            } catch { /* ignore */ }
        };

        if (typeof window === "undefined") return undefined;
        window.addEventListener("pos-bridge-renegotiate", onRenegotiate);
        return () => {
            window.removeEventListener("pos-bridge-renegotiate", onRenegotiate);
        };
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
