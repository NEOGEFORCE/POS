"use client";
import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { ScanLine, X, AlertCircle, Plus, Flashlight, FlashlightOff } from 'lucide-react';

export interface ScannerOverlayProps {
    isOpen?: boolean;
    onClose: () => void;
    onResult: (result: string) => void;
    title?: string;
    errorTitle?: string;
    errorMessage?: string;
    onIgnoreError?: () => void;
    onCreateProduct?: () => void;
}

export function ScannerOverlay({ 
    isOpen = true, onClose, onResult, title, 
    errorTitle, errorMessage, onIgnoreError, onCreateProduct 
}: ScannerOverlayProps) {
    const [mounted, setMounted] = useState(false);
    const [torchOn, setTorchOn] = useState(false);
    const [torchSupported, setTorchSupported] = useState(false);
    const [flashActive, setFlashActive] = useState(false);
    const scannerRef = useRef<Html5Qrcode | null>(null);

    useEffect(() => {
        setMounted(true);
    }, []);

    const toggleTorch = useCallback(async () => {
        try {
            const scanner = scannerRef.current;
            if (!scanner) return;

            // Access the underlying video element rendered by html5-qrcode
            const videoEl = document.querySelector('#reader video') as HTMLVideoElement | null;
            if (!videoEl?.srcObject) return;

            const stream = videoEl.srcObject as MediaStream;
            const track = stream.getVideoTracks()[0];
            if (!track) return;

            const newState = !torchOn;
            await track.applyConstraints({
                advanced: [{ torch: newState } as any]
            });
            setTorchOn(newState);
        } catch (err) {
            console.warn("Flash/torch not supported on this device:", err);
        }
    }, [torchOn]);

    const isProcessingRef = useRef(false);

    useEffect(() => {
        if (!isOpen) {
            setTorchOn(false);
            setTorchSupported(false);
            return;
        }

        const html5QrCode = new Html5Qrcode("reader");
        scannerRef.current = html5QrCode;

        // CONFIGURACIÓN DE ALTO RENDIMIENTO (Sin saturación)
        const config = {
            fps: 10, // Suficiente para códigos de barras y ahorra CPU
            disableFlip: false,
            qrbox: (videoWidth: number, videoHeight: number) => {
                const minEdge = Math.min(videoWidth, videoHeight);
                const size = Math.max(minEdge * 0.85, 250);
                return { width: size, height: size };
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
                useBarCodeDetectorIfSupported: true
            }
        };

        const cameraConfig = {
            facingMode: "environment"
        };

        html5QrCode.start(
            cameraConfig,
            config,
            (decodedText) => {
                // EVITAR SATURACIÓN: Si ya estamos procesando un código, ignorar el resto
                if (isProcessingRef.current) return;
                
                isProcessingRef.current = true;
                
                // Feedback visual y táctil inmediato
                setFlashActive(true);
                if (navigator.vibrate) navigator.vibrate(80);
                setTimeout(() => setFlashActive(false), 300);
                
                // Enviar resultado
                onResult(decodedText);

                // Debounce de 1.5 segundos antes de permitir el siguiente escaneo
                setTimeout(() => {
                    isProcessingRef.current = false;
                }, 1500);
            },
            () => {}
        ).then(() => {
            // Check if torch is supported after camera starts
            setTimeout(() => {
                try {
                    const videoEl = document.querySelector('#reader video') as HTMLVideoElement | null;
                    if (videoEl?.srcObject) {
                        const stream = videoEl.srcObject as MediaStream;
                        const track = stream.getVideoTracks()[0];
                        const capabilities = track?.getCapabilities?.() as any;
                        if (capabilities?.torch) {
                            setTorchSupported(true);
                        }
                    }
                } catch (e) {
                    console.warn("Could not check torch capabilities:", e);
                }
            }, 500);
        }).catch(err => {
            console.error("Error al iniciar cámara:", err);
        });

        return () => {
            scannerRef.current = null;
            if (html5QrCode.isScanning) {
                html5QrCode.stop().catch(console.error);
            }
        };
    }, [isOpen, onResult]);

    if (!isOpen || !mounted) return null;

    return createPortal(
        <div 
            className="fixed inset-0 z-[99999] flex items-center justify-center p-4 sm:p-8 bg-black/90 backdrop-blur-md"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scanner-title"
        >
            <div className="relative w-full max-w-lg aspect-[3/4] sm:aspect-square bg-zinc-950 rounded-[2.5rem] overflow-hidden border border-white/10 shadow-2xl">

                <div id="reader" className="w-full h-full object-cover min-h-[250px] min-w-[250px]"></div>

                {/* INTERFAZ VISUAL DEL ESCÁNER */}
                <div className="absolute inset-0 pointer-events-none z-10 flex items-center justify-center">
                    <div className={`w-[85%] h-[85%] min-w-[250px] min-h-[250px] border-2 rounded-[2rem] relative transition-all duration-300 ${flashActive ? 'border-emerald-500 scale-105 bg-emerald-500/10' : 'border-emerald-500/30'}`}>
                        <div className={`absolute top-0 left-0 w-10 h-10 border-t-4 border-l-4 rounded-tl-[2rem] transition-colors ${flashActive ? 'border-white' : 'border-emerald-500'}`}></div>
                        <div className={`absolute top-0 right-0 w-10 h-10 border-t-4 border-r-4 rounded-tr-[2rem] transition-colors ${flashActive ? 'border-white' : 'border-emerald-500'}`}></div>
                        <div className={`absolute bottom-0 left-0 w-10 h-10 border-b-4 border-l-4 rounded-bl-[2rem] transition-colors ${flashActive ? 'border-white' : 'border-emerald-500'}`}></div>
                        <div className={`absolute bottom-0 right-0 w-10 h-10 border-b-4 border-r-4 rounded-br-[2rem] transition-colors ${flashActive ? 'border-white' : 'border-emerald-500'}`}></div>
                        <div className={`absolute top-0 left-0 w-full h-0.5 bg-emerald-500 shadow-[0_0_15px_3px_rgba(16,185,129,0.8)] animate-[scan_2s_ease-in-out_infinite] ${flashActive ? 'hidden' : ''}`}></div>
                    </div>
                </div>

                {/* TOP BAR: Título + Flash + Cerrar */}
                <div className="absolute top-6 left-6 right-6 flex justify-between items-center z-20 pointer-events-auto">
                    <h2 id="scanner-title" className="text-white font-black uppercase tracking-widest text-sm drop-shadow-md flex items-center gap-2 bg-black/40 px-4 py-2 rounded-xl backdrop-blur-sm">
                        <ScanLine className="h-5 w-5 text-emerald-500" />
                        {title || 'ESCÁNER RÁPIDO'}
                    </h2>
                    <div className="flex items-center gap-2">
                        {/* BOTÓN DE FLASH / LINTERNA */}
                        <button
                            onClick={toggleTorch}
                            className={`h-10 w-10 rounded-xl backdrop-blur-md flex items-center justify-center transition-all border ${
                                torchOn 
                                    ? 'bg-amber-500 border-amber-400 text-black shadow-[0_0_20px_rgba(245,158,11,0.6)]' 
                                    : torchSupported
                                        ? 'bg-black/50 border-white/10 text-white hover:bg-amber-500/20 hover:border-amber-500/50'
                                        : 'bg-black/30 border-white/5 text-white/30 cursor-not-allowed'
                            }`}
                            disabled={!torchSupported}
                            title={torchSupported ? (torchOn ? "Apagar Flash" : "Encender Flash") : "Flash no disponible"}
                        >
                            {torchOn 
                                ? <Flashlight className="h-5 w-5" /> 
                                : <FlashlightOff className="h-5 w-5" />
                            }
                        </button>
                        <button
                            onClick={onClose}
                            className="px-4 h-10 bg-black/50 hover:bg-rose-500 text-white rounded-xl backdrop-blur-md flex items-center gap-2 transition-all border border-white/10 font-black uppercase text-[10px] tracking-widest"
                        >
                            <X className="h-4 w-4" /> VOLVER
                        </button>
                    </div>
                </div>

                {/* INDICADOR DE FLASH ACTIVO - Barra inferior */}
                {torchOn && (
                    <div className="absolute bottom-6 left-6 right-6 z-20 pointer-events-none flex justify-center">
                        <div className="bg-amber-500/90 backdrop-blur-md px-4 py-2 rounded-xl flex items-center gap-2 shadow-[0_0_30px_rgba(245,158,11,0.4)] animate-pulse">
                            <Flashlight className="h-4 w-4 text-black" />
                            <span className="text-[10px] font-black text-black uppercase tracking-widest">FLASH ACTIVO</span>
                        </div>
                    </div>
                )}

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
                #reader {
                    min-height: 250px !important;
                    min-width: 250px !important;
                }
                #reader img, #reader video { 
                    object-fit: cover !important; 
                    width: 100% !important; 
                    height: 100% !important; 
                    min-height: 250px !important;
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