"use client";

import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/app-sidebar';
import { AppHeader } from '@/components/app-header';
import { Spinner } from "@heroui/react"; // Usamos el Spinner premium
import SyncBackground from '@/components/shared/SyncBackground';
import SessionGuardian from '@/components/SessionGuardian';
import { MotionPage } from '@/components/ui/motion';
import { LogoutCurtain } from '@/components/layout/LogoutCurtain';
import { RouteCurtain } from '@/components/layout/RouteCurtain';

export default function AppLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { user, loading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();

    // CORTINAS AL LOGOUT
    // Cuando user pasa de algo→null disparamos las cortinas y luego redirigimos.
    const [showCurtain, setShowCurtain] = useState(false);
    const wasAuthed = useRef(false);

    useEffect(() => {
        if (loading) return;

        if (user) {
            wasAuthed.current = true;
            return;
        }

        // user === null/undefined
        if (wasAuthed.current) {
            // Fue una sesion activa que se acaba de cerrar → cortinas
            setShowCurtain(true);
            wasAuthed.current = false;
            const t = setTimeout(() => {
                router.replace('/login');
            }, 700); // Tiempo del spring de las cortinas
            return () => clearTimeout(t);
        }

        // Nunca estuvo autenticado: redirect inmediato
        router.replace('/login');
    }, [user, loading, router]);

    useEffect(() => {
        // DESTROY OLD SERVICE WORKERS THAT MIGHT BE CACHING TURBOPACK CHUNKS
        if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(function(registrations) {
                for(let registration of registrations) {
                    registration.unregister();
                }
            });
        }

        if (!loading && user) {
            const role = user.role?.toLowerCase() || user.Role?.toLowerCase() || "";
            const isAdmin = role === "admin" || role === "administrador" || role === "superadmin" || role === "auditor";
            const pathname = window.location.pathname;

            // Rutas protegidas para No-Admins
            const adminRoutes = ['/dashboard', '/users'];
            const isTryingAdminRoute = adminRoutes.some(route => pathname.startsWith(route));

            if (!isAdmin && isTryingAdminRoute) {
                router.replace('/sales/new');
            }
        }
    }, [user, loading, router]);

    useEffect(() => {
        const saved = localStorage.getItem('theme')
        if (saved === 'light') {
            document.documentElement.setAttribute('data-theme', 'light')
        }
    }, [])

    // FIX PREVENTIVO: Evitar que el scroll del window se quede desplazado al navegar
    // o cuando el navegador hace scroll automatico hacia un input
    useEffect(() => {
        const resetScroll = () => {
            window.scrollTo(0, 0);
            document.body.scrollTop = 0;
            document.documentElement.scrollTop = 0;
            
            // Reset ALL main containers and any divs that might have gotten scrolled
            document.querySelectorAll('main, div').forEach(el => {
                // Solo resetear si esta desplazado para no matar el performance
                if (el.scrollTop > 0) {
                    el.scrollTop = 0;
                }
            });
        };
        resetScroll();
        // Tambien interceptar despues de un pequeño delay por si Next.js intenta restaurar el scroll
        const t = setTimeout(resetScroll, 50);
        return () => clearTimeout(t);
    }, [pathname]);

    // Pantalla de carga con soporte Claro/Oscuro y animacion premium
    if (loading) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-[#09090b]">
                <div className="flex flex-col flex-1 bg-[#09090b] relative min-w-0 w-full max-w-full">
                    <Spinner color="success" size="lg" label="Cargando interfaz" />
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-[100dvh] md:h-screen w-screen overflow-hidden bg-[#09090b]">
            <SidebarProvider defaultOpen={false}>
                <AppSidebar />
                <SidebarInset className="max-w-[100vw] min-w-0 min-h-0 w-full flex-1 md:h-full flex flex-col relative overflow-hidden">

                    <div className="flex flex-col flex-1 h-full min-h-0 w-full md:h-full relative z-0">

                        {/* Resplandores de fondo (Glows) */}
                        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 dark:bg-white/5 blur-[100px] md:blur-[120px] rounded-2xl pointer-events-none transition-colors duration-500" />
                        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 blur-[100px] md:blur-[120px] rounded-2xl pointer-events-none transition-colors duration-500" />

                        <AppHeader />
                        <SessionGuardian />
                        <SyncBackground />

                        <main className="flex-1 h-full min-h-0 md:h-full overflow-y-auto custom-scrollbar flex flex-col relative z-10 p-0">
                            <RouteCurtain>{children}</RouteCurtain>
                        </main>

                    </div>
                </SidebarInset>

                {/* Cortinas al cerrar sesion */}
                <LogoutCurtain active={showCurtain} />
            </SidebarProvider>
        </div>
    );
}