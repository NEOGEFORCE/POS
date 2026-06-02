"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import { HeroUIProvider } from "@heroui/react";
import { SWRConfig } from 'swr';

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <NextThemesProvider attribute="class" defaultTheme="dark" forcedTheme="dark">
            <HeroUIProvider>
                <SWRConfig value={{
                    revalidateOnFocus: true,
                    revalidateOnMount: true,
                    revalidateOnReconnect: true,
                    dedupingInterval: 5000
                }}>
                    {children}
                </SWRConfig>
            </HeroUIProvider>
        </NextThemesProvider>
    );
}