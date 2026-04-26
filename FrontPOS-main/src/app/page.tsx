"use client";

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner } from "@heroui/react";
import { ShoppingCart } from 'lucide-react';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const checkStatusWithRetry = async (retries = 3, delay = 1000) => {
      for (let i = 0; i < retries; i++) {
        try {
          const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/check-setup`);
          if (response.ok) {
            return await response.json();
          }
        } catch (error) {
          console.log(`Intento ${i + 1} de ${retries} falló. Reintentando en ${delay}ms...`);
          if (i < retries - 1) await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      return { needsSetup: false }; // Por defecto a login si falla todo
    };

    const initialize = async () => {
      const { needsSetup } = await checkStatusWithRetry();

      if (needsSetup) {
        router.replace('/setup');
        return;
      }

      const userStr = localStorage.getItem('org-pos-user');
      if (userStr) {
        try {
          const user = JSON.parse(userStr);
          const role = (user.role || user.Role || "").toLowerCase();
          if (role === 'admin' || role === 'administrador' || role === 'superadmin') {
            router.replace('/dashboard');
          } else {
            router.replace('/sales/new');
          }
        } catch (e) {
          router.replace('/login');
        }
      } else {
        router.replace('/login');
      }
    };

    const timer = setTimeout(initialize, 500);
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div className="flex h-screen w-full flex-col items-center justify-center bg-gray-50 dark:bg-[#09090b] transition-colors duration-500 overflow-hidden select-none">

      <div className="flex flex-col items-center gap-10 animate-in fade-in zoom-in duration-700">

        {/* LOGO Y BRANDING */}
        <div className="flex flex-col items-center gap-4">
          <div className="h-24 w-24 bg-emerald-100 dark:bg-emerald-500/10 rounded-[2rem] flex items-center justify-center border border-emerald-200 dark:border-emerald-500/20 shadow-[0_0_50px_rgba(16,185,129,0.15)] dark:shadow-[0_0_50px_rgba(16,185,129,0.1)]">
            <ShoppingCart className="h-12 w-12 text-emerald-600 dark:text-emerald-500" />
          </div>
          <div className="text-center mt-2">
            <h1 className="text-4xl font-black text-gray-900 dark:text-white tracking-tighter">POS PRO</h1>
            <p className="text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase tracking-widest mt-1">Terminal V4.2</p>
          </div>
        </div>

        {/* INDICADOR DE CARGA */}
        <div className="flex flex-col items-center gap-5">
          <div className="flex flex-col items-center gap-3">
            <Spinner color="success" size="lg" label="Verificando entorno" />
            <div className="w-32 h-1 bg-gray-200 dark:bg-white/10 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 w-1/2 animate-[pulse_1s_ease-in-out_infinite_alternate]" />
            </div>
          </div>
        </div>

      </div>

    </div>
  );
}