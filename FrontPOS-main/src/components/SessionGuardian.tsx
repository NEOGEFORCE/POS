"use client";

import { useEffect, useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Cookies from 'js-cookie';
import { toast } from '@/hooks/use-toast';
import { Wifi, WifiOff, ShieldCheck, AlertCircle } from 'lucide-react';

export default function SessionGuardian() {
    const router = useRouter();
    const pathname = usePathname();
    const [isOnline, setIsOnline] = useState(true);
    const [lastActivity, setLastActivity] = useState(Date.now());

    // 1. SINCRONIZACION DE LOGOUT (Multi-pestaña)
    useEffect(() => {
        const handleStorageChange = (e: StorageEvent) => {
            // Si detectamos que el token fue removido o cambio en otra pestaña
            if (e.key === 'org-pos-token' && !e.newValue) {
                toast({
                    title: "SESION FINALIZADA",
                    description: "Se ha cerrado la sesion en otra ventana.",
                    variant: "destructive"
                });
                router.push('/login');
            }
        };

        window.addEventListener('storage', handleStorageChange);
        return () => window.removeEventListener('storage', handleStorageChange);
    }, [router]);

    // 2. DETECCION DE ESTADO DE RED PROACTIVO
    useEffect(() => {
        const updateOnlineStatus = () => {
            const online = navigator.onLine;
            setIsOnline(online);
            if (!online) {
                toast({
                    title: "MODO OFFLINE ACTIVADO",
                    description: "Se ha perdido la conexion. Las ventas se guardaran localmente.",
                    variant: "destructive"
                });
            } else {
                toast({
                    title: "CONEXION RESTAURADA",
                    description: "El sistema vuelve a estar en linea.",
                    variant: "default"
                });
            }
        };

        window.addEventListener('online', updateOnlineStatus);
        window.addEventListener('offline', updateOnlineStatus);
        
        return () => {
            window.removeEventListener('online', updateOnlineStatus);
            window.removeEventListener('offline', updateOnlineStatus);
        };
    }, []);

    // 3. HEARTBEAT / REFRESH DE TOKEN / AUTO-LOGOUT (MEGA-SPRINT)
    useEffect(() => {
        const checkSession = setInterval(() => {
            const token = Cookies.get('org-pos-token');
            if (!token && !pathname.includes('/login')) {
                router.push('/login');
                return;
            }

            // MEGA-SPRINT: Auto-Logout tras 1 hora de inactividad (3,600,000 ms)
            const inactiveTime = Date.now() - lastActivity;
            if (inactiveTime > 3600000 && !pathname.includes('/login')) {
                Cookies.remove('org-pos-token');
                Cookies.remove('org-pos-user');
                toast({
                    title: "SESION EXPIRADA",
                    description: "Se ha cerrado la sesion por inactividad (1 hora).",
                    variant: "destructive"
                });
                router.push('/login?reason=timeout');
            }
        }, 60000); // Revisar cada minuto

        return () => clearInterval(checkSession);
    }, [lastActivity, pathname, router]);

    // 4. REGISTRO DE ACTIVIDAD
    useEffect(() => {
        const activityEvents = ['mousedown', 'keydown', 'touchstart', 'scroll'];
        const updateActivity = () => setLastActivity(Date.now());

        activityEvents.forEach(event => window.addEventListener(event, updateActivity));
        return () => activityEvents.forEach(event => window.removeEventListener(event, updateActivity));
    }, []);

    // Este componente no renderiza nada visible por defecto, 
    // pero podemos retornar un pequeño indicador si lo deseamos.
    return null;
}
