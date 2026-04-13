"use client";
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { ScanLine, X, AlertCircle, Plus } from 'lucide-react';

interface ScannerOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    onResult: (result: string) => void;
    title?: string;
    errorTitle?: string;
    errorMessage?: string;
    onIgnoreError?: () => void;
    onCreateProduct?: () => void;
}

export function ScannerOverlay({ 
    isOpen, onClose, onResult, title, 
    errorTitle, errorMessage, onIgnoreError, onCreateProduct 
}: ScannerOverlayProps) {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    useEffect(() => {
        if (!isOpen) return;

        const html5QrCode = new Html5Qrcode("reader");

        // CONFIGURACIÓN DE MÁXIMA VELOCIDAD
        const config = {
            fps: 15, // 15-20 es el punto dulce para que el CPU tenga tiempo de leer
            disableFlip: false, // Permite leer de cabeza (Omnidireccional)

            // EL SECRETO DE LA VELOCIDAD: 
            // Un cuadro dinámico que ocupa el 85% de la pantalla. 
            // Se siente pantalla completa, pero evita procesar bordes inútiles.
            qrbox: (videoWidth: number, videoHeight: number) => {
                const minEdge = Math.min(videoWidth, videoHeight);
                return { width: minEdge * 0.85, height: minEdge * 0.85 };
            },

            formatsToSupport: [
                Html5QrcodeSupportedFormats.EAN_13,
                Html5QrcodeSupportedFormats.EAN_8,
                Html5QrcodeSupportedFormats.CODE_128,
                Html5QrcodeSupportedFormats.CODE_39,
                Html5QrcodeSupportedFormats.UPC_A,
                Html5QrcodeSupportedFormats.UPC_E,
            ],
            experimentalFeatures: {
                useBarCodeDetectorIfSupported: true // Mantener ML Kit de Android activado
            }
        };

        // Dejamos que el celular decida su mejor resolución nativa en lugar de forzar 1080p
        const cameraConfig = {
            facingMode: "environment"
        };

        html5QrCode.start(
            cameraConfig,
            config,
            (decodedText) => {
                // ÉXITO: Detenemos rápido y enviamos
                html5QrCode.stop().then(() => {
                    onResult(decodedText);
                }).catch(err => console.error("Error al detener cámara:", err));
            },
            (errorMessage) => {
                // Silenciamos el spam de errores del lector
            }
        ).catch(err => {
            console.error("Error al iniciar cámara:", err);
        });

        return () => {
            if (html5QrCode.isScanning) {
                html5QrCode.stop().catch(console.error);
            }
        };
    }, [isOpen, onResult]);

    if (!isOpen || !mounted) return null;

    return createPortal(
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 sm:p-8 bg-black/90 backdrop-blur-md">
            <div className="relative w-full max-w-lg aspect-[3/4] sm:aspect-square bg-zinc-950 rounded-[2.5rem] overflow-hidden border border-white/10 shadow-2xl">

                <div id="reader" className="w-full h-full object-cover"></div>

                {/* INTERFAZ VISUAL DEL ESCÁNER */}
                <div className="absolute inset-0 pointer-events-none z-10 flex items-center justify-center">
                    <div className="w-[85%] h-[85%] border-2 border-emerald-500/30 rounded-[2rem] relative">
                        <div className="absolute top-0 left-0 w-10 h-10 border-t-4 border-l-4 border-emerald-500 rounded-tl-[2rem]"></div>
                        <div className="absolute top-0 right-0 w-10 h-10 border-t-4 border-r-4 border-emerald-500 rounded-tr-[2rem]"></div>
                        <div className="absolute bottom-0 left-0 w-10 h-10 border-b-4 border-l-4 border-emerald-500 rounded-bl-[2rem]"></div>
                        <div className="absolute bottom-0 right-0 w-10 h-10 border-b-4 border-r-4 border-emerald-500 rounded-br-[2rem]"></div>
                        <div className="absolute top-0 left-0 w-full h-0.5 bg-emerald-500 shadow-[0_0_15px_3px_rgba(16,185,129,0.8)] animate-[scan_2s_ease-in-out_infinite]"></div>
                    </div>
                </div>

                <div className="absolute top-6 left-6 right-6 flex justify-between items-center z-20 pointer-events-auto">
                    <h2 className="text-white font-black uppercase tracking-widest text-sm drop-shadow-md flex items-center gap-2 bg-black/40 px-4 py-2 rounded-xl backdrop-blur-sm">
                        <ScanLine className="h-5 w-5 text-emerald-500" />
                        {title || 'ESCÁNER RÁPIDO'}
                    </h2>
                    <button
                        onClick={onClose}
                        className="px-4 h-10 bg-black/50 hover:bg-rose-500 text-white rounded-xl backdrop-blur-md flex items-center gap-2 transition-all border border-white/10 font-black uppercase text-[10px] tracking-widest"
                    >
                        <X className="h-4 w-4" /> VOLVER
                    </button>
                </div>

                {/* OVERLAY DE ERROR (Producto no encontrado) */}
                {errorTitle && (
                    <div className="absolute inset-0 z-50 bg-rose-500/20 backdrop-blur-md flex items-center justify-center p-6 animate-in fade-in zoom-in duration-300">
                        <div className="bg-white dark:bg-zinc-950 p-8 rounded-[2.5rem] shadow-3xl text-center max-w-sm border border-rose-500/20">
                            <div className="h-16 w-16 rounded-2xl bg-rose-500/10 flex items-center justify-center mx-auto mb-4 border border-rose-500/20">
                                <AlertCircle className="h-8 w-8 text-rose-500" />
                            </div>
                            <h3 className="text-xl font-black text-gray-900 dark:text-white uppercase italic tracking-tighter mb-2">{errorTitle}</h3>
                            <p className="text-xs font-bold text-gray-500 dark:text-zinc-400 mb-6 italic leading-relaxed">{errorMessage}</p>
                            <div className="flex flex-col gap-3">
                                <button
                                    onClick={onCreateProduct}
                                    className="w-full h-12 bg-emerald-500 text-white rounded-xl font-black uppercase text-xs shadow-xl shadow-emerald-500/20 flex items-center justify-center gap-2 hover:scale-105 transition-transform"
                                >
                                    <Plus size={16} /> CREAR AHORA
                                </button>
                                <button
                                    onClick={onIgnoreError}
                                    className="w-full h-12 bg-gray-100 dark:bg-zinc-900 text-gray-900 dark:text-white rounded-xl font-black uppercase text-[10px] tracking-widest hover:bg-gray-200 dark:hover:bg-zinc-800 transition-colors"
                                >
                                    VOLVER / IGNORAR
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <style dangerouslySetInnerHTML={{
                __html: `
                @keyframes scan {
                    0% { top: 5%; opacity: 0; }
                    10% { opacity: 1; }
                    90% { opacity: 1; }
                    100% { top: 95%; opacity: 0; }
                }
                #reader img, #reader video { 
                    object-fit: cover !important; 
                    width: 100% !important; 
                    height: 100% !important; 
                }
                /* Ocultar UI nativa fea */
                #reader__dashboard_section_csr, 
                #reader__dashboard_section_swaplink,
                #reader__status_span { display: none !important; }
                /* Ocultar el cuadro rojo que trae la librería por defecto cuando le pasas un qrbox */
                #qr-shaded-region { border-color: rgba(0,0,0,0.5) !important; }
            `}} />
        </div>,
        document.body
    );
}