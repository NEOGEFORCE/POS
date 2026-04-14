"use client";

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/app-sidebar';
import { AppHeader } from '@/components/app-header';
import { Spinner } from "@heroui/react"; // Usamos el Spinner premium

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading) {
      if (!user) {
        router.replace('/login');
      } else {
        const role = user.role?.toLowerCase() || user.Role?.toLowerCase() || "";
        const isAdmin = role === "admin" || role === "administrador" || role === "auditor";
        const pathname = window.location.pathname;

        // Rutas protegidas para No-Admins
        const adminRoutes = ['/dashboard', '/users'];
        const isTryingAdminRoute = adminRoutes.some(route => pathname.startsWith(route));

        if (!isAdmin && isTryingAdminRoute) {
          router.replace('/sales/new');
        }
      }
    }
  }, [user, loading, router]);

  // Pantalla de carga con soporte Claro/Oscuro y animación premium
  if (loading || !user) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-[#09090b] transition-colors duration-500">
        <div className="flex flex-col items-center gap-4 animate-in fade-in zoom-in duration-500">
          <Spinner color="success" size="lg" />
          <p className="text-[10px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-widest animate-pulse">
            Cargando interfaz...
          </p>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider defaultOpen={false}>
      <AppSidebar />
      <SidebarInset className="max-w-[100vw] min-w-0 w-full overflow-x-hidden overflow-y-auto">
        {/* Contenedor principal con transición de Claro/Oscuro */}
        <div className="flex flex-col min-h-[100dvh] bg-gray-50 dark:bg-[#09090b] transition-colors duration-500 relative min-w-0 w-full max-w-full">

          {/* Resplandores de fondo (Glows) adaptados para ambos modos */}
          <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-500/5 dark:bg-emerald-500/10 blur-[100px] md:blur-[120px] rounded-full pointer-events-none transition-colors duration-500" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-emerald-500/5 dark:bg-emerald-500/5 blur-[100px] md:blur-[120px] rounded-full pointer-events-none transition-colors duration-500" />

          {/* Cabecera de la App */}
          <AppHeader />

          {/* Contenido (Aquí se inyectan las pantallas como Nueva Venta, Devoluciones, etc.) */}
          <main className="flex-1 p-2 md:p-3 min-w-0 flex flex-col z-10">
            {children}
          </main>

        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}