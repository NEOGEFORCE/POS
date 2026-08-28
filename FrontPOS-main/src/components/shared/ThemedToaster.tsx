"use client";

import { Toaster } from "sonner";
import { useTheme } from "next-themes";

/**
 * Notificaciones compactas centradas en la parte superior, por debajo de la
 * cabecera para no tapar los controles ni el selector de facturas.
 */
export function ThemedToaster() {
    const { resolvedTheme } = useTheme();
    const theme = resolvedTheme === "light" ? "light" : "dark";

    return (
        <Toaster
            position="top-center"
            richColors
            expand={false}
            theme={theme}
            duration={3000}
            visibleToasts={2}
            gap={6}
            offset={{ top: "34px" }}
            mobileOffset={{ top: "30px" }}
            style={{ ["--width" as string]: "240px" }}
            toastOptions={{
                classNames: {
                    toast: "!min-h-0 !w-auto !max-w-[240px] !gap-2 !rounded-xl !px-2.5 !py-2 !shadow-md",
                    title: "!text-[11px] !font-bold !leading-tight",
                    description: "!text-[10px] !leading-snug !opacity-80",
                    icon: "!m-0 [&>svg]:!h-3.5 [&>svg]:!w-3.5",
                    closeButton: "!h-4 !w-4",
                },
            }}
        />
    );
}
