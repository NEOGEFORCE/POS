"use client";

import React, { useEffect, useState } from 'react';
import { Download, X, Share } from 'lucide-react';
import { Button } from '@heroui/react';
import { motion, AnimatePresence } from 'framer-motion';

export default function PWAInstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
    const [showInstallPrompt, setShowInstallPrompt] = useState(false);
    const [isIOS, setIsIOS] = useState(false);
    const [isStandalone, setIsStandalone] = useState(true); // Default true to prevent flash

    useEffect(() => {
        if (localStorage.getItem('pos_pwa_prompt_dismissed') === 'true') {
            return;
        }

        // Detect if already installed (standalone)
        const isStandaloneQuery = window.matchMedia('(display-mode: standalone)').matches;
        const isIOSStandalone = (window.navigator as any).standalone === true;
        
        if (isStandaloneQuery || isIOSStandalone) {
            setIsStandalone(true);
            return;
        } else {
            setIsStandalone(false);
        }

        // Detect iOS
        const userAgent = window.navigator.userAgent.toLowerCase();
        const isIOSDevice = /iphone|ipad|ipod/.test(userAgent);
        setIsIOS(isIOSDevice);

        if (isIOSDevice) {
            // Show iOS prompt after a short delay
            const timer = setTimeout(() => {
                setShowInstallPrompt(true);
            }, 3000);
            return () => clearTimeout(timer);
        }

        // Handle Android/Chrome beforeinstallprompt
        const handleBeforeInstallPrompt = (e: any) => {
            // Prevent Chrome 67 and earlier from automatically showing the prompt
            e.preventDefault();
            // Stash the event so it can be triggered later
            setDeferredPrompt(e);
            // Show the prompt to the user
            setShowInstallPrompt(true);
        };

        window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

        return () => {
            window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
        };
    }, []);

    const handleInstallClick = async () => {
        if (!deferredPrompt) return;

        // Show the install prompt
        deferredPrompt.prompt();

        // Wait for the user to respond to the prompt
        const { outcome } = await deferredPrompt.userChoice;
        
        if (outcome === 'accepted') {
            setShowInstallPrompt(false);
        }
        
        setDeferredPrompt(null);
    };

    const handleClose = () => {
        setShowInstallPrompt(false);
        localStorage.setItem('pos_pwa_prompt_dismissed', 'true');
    };

    if (isStandalone || !showInstallPrompt) return null;

    return (
        <AnimatePresence>
            <motion.div
                initial={{ y: 100, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 100, opacity: 0 }}
                className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-96 bg-gray-50 dark:bg-zinc-900 border border-emerald-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.5)] rounded-2xl p-4 z-[9999] flex flex-col gap-3"
            >
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                        <div className="h-10 w-10 bg-emerald-500/10 rounded-xl flex items-center justify-center border border-emerald-500/20 shrink-0">
                            <Download className="text-emerald-500" size={20} />
                        </div>
                        <div>
                            <h3 className="text-zinc-100 font-bold text-sm tracking-tight uppercase">Instalar POS PRO</h3>
                            <p className="text-gray-500 dark:text-zinc-400 text-[10px] leading-tight mt-0.5">
                                Instala la app para usarla en pantalla completa, sin la barra del navegador y más rápida.
                            </p>
                        </div>
                    </div>
                    <button onClick={handleClose} className="text-gray-500 dark:text-zinc-500 hover:text-gray-600 dark:text-zinc-300 transition-colors p-1 -mr-2 -mt-2">
                        <X size={16} />
                    </button>
                </div>

                {isIOS ? (
                    <div className="bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/5 rounded-xl p-3 flex items-center gap-3 text-xs text-gray-600 dark:text-zinc-300">
                        <Share size={16} className="shrink-0 text-blue-400" />
                        <p className="leading-tight">
                            Toca el botón <strong>Compartir</strong> y luego <strong>"Agregar a inicio"</strong> para instalar.
                        </p>
                    </div>
                ) : (
                    <Button 
                        className="w-full bg-emerald-500 text-white font-bold tracking-widest text-[11px] shadow-lg shadow-emerald-500/20"
                        onPress={handleInstallClick}
                    >
                        INSTALAR AHORA
                    </Button>
                )}
            </motion.div>
        </AnimatePresence>
    );
}
