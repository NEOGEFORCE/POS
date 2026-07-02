"use client";
import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { ScanLine, X, AlertCircle, Plus, Flashlight, FlashlightOff, AlertTriangle } from 'lucide-react';

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
    const [isInsecure, setIsInsecure] = useState(false);
    const [initError, setInitError] = useState<string | null>(null);
    const [uniqueId] = useState(() => `reader-${Math.random().toString(36).substring(2, 11)}`);
    const scannerRef = useRef<Html5Qrcode | null>(null);
    const elementRef = useRef<HTMLDivElement>(null);

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
        if (!isOpen || !mounted) {
            setTorchOn(false);
            setTorchSupported(false);
            return;
        }

        // Asegurarse de que el elemento existe antes de crear el objeto
        if (!elementRef.current) return;

        const html5QrCode = new Html5Qrcode(uniqueId);
        scannerRef.current = html5QrCode;

        // Verificar contexto seguro
        if (typeof window !== 'undefined' && !window.isSecureContext && window.location.hostname !== 'localhost') {
            setIsInsecure(true);
            return;
        }

        // CONFIGURACION OPTIMIZADA PARA MAXIMA VELOCIDAD Y PRECISION
        const config = {
            fps: 25,
            qrbox: (viewfinderWidth: number, viewfinderHeight: number) => {
                const size = Math.min(viewfinderWidth, viewfinderHeight) * 0.95;
                return { width: size, height: size };
            },
            aspectRatio: 1.0,
            formatsToSupport: [
                Html5QrcodeSupportedFormats.EAN_13,
                Html5QrcodeSupportedFormats.EAN_8,
                Html5QrcodeSupportedFormats.CODE_128,
                Html5QrcodeSupportedFormats.CODE_39,
                Html5QrcodeSupportedFormats.UPC_A,
                Html5QrcodeSupportedFormats.UPC_E,
            ]
        };

        const onScanSuccess = (decodedText: string) => {
            // EVITAR SATURACION: Si ya estamos procesando un codigo, ignorar el resto
            if (isProcessingRef.current) return;
            
            isProcessingRef.current = true;
            
            // Feedback visual y tactil inmediato
            setFlashActive(true);
            if (navigator.vibrate) navigator.vibrate(80);
            setTimeout(() => setFlashActive(false), 300);
            
            // Enviar resultado
            onResult(decodedText);

            // MASTER SPRINT 1.1: Anti-Bucle (One-Shot Scan)
            // Detenemos el stream de inmediato y cerramos el componente
            if (html5QrCode && html5QrCode.isScanning) {
                html5QrCode.stop().then(() => {
                    onClose();
                }).catch(() => {
                    onClose(); // Cerrar de todos modos si falla el stop
                });
            } else {
                onClose();
            }
        };

        const checkTorch = () => {
            setTimeout(() => {
                try {
                    const videoEl = document.querySelector(`#${uniqueId} video`) as HTMLVideoElement | null;
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
        };

        const startScanner = async () => {
            try {
                await html5QrCode.start(
                    { facingMode: "environment" },
                    config,
                    onScanSuccess,
                    () => {}
                );
                checkTorch();
            } catch (err) {
                console.warn("Failed with facingMode, trying getCameras...", err);
                try {
                    const devices = await Html5Qrcode.getCameras();
                    if (devices && devices.length > 0) {
                        const backCamera = devices.find(d => d.label.toLowerCase().includes('back') || d.label.toLowerCase().includes('trasera')) || devices[devices.length - 1];
                        await html5QrCode.start(
                            backCamera.id,
                            config,
                            onScanSuccess,
                            () => {}
                        );
                        checkTorch();
                    } else {
                        throw new Error("No cameras found");
                    }
                } catch (fallbackErr) {
                    console.error("Error al iniciar camara:", fallbackErr);
                    setInitError(String(fallbackErr));
                }
            }
        };

        startScanner();

        return () => {
            isProcessingRef.current = false;
            const scanner = scannerRef.current;
            scannerRef.current = null;
            if (scanner) {
                if (scanner.isScanning) {
                    scanner.stop().then(() => {
                        scanner.clear();
                    }).catch(err => console.warn("Error stopping scanner:", err));
                } else {
                    try { scanner.clear(); } catch (_) {}
                }
            }
            // Detener todos los tracks de video activos
            const videoEl = document.querySelector(`#${uniqueId} video`) as HTMLVideoElement | null;
            if (videoEl?.srcObject) {
                (videoEl.srcObject as MediaStream).getTracks().forEach(t => t.stop());
                videoEl.srcObject = null;
            }
        };
    }, [isOpen, onResult, mounted]);

    if (!isOpen || !mounted) return null;

    return createPortal(
        <div 
            className="fixed inset-0 z-[999999] flex items-center justify-center p-4 sm:p-8 bg-black/95"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scanner-title"
        >
            <div className="relative w-full max-w-lg aspect-[3/4] sm:aspect-square bg-white dark:bg-zinc-950 rounded-[2.5rem] overflow-hidden border border-black/5 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                
                {/* AVISO DE CONTEXTO NO SEGURO (HTTP) */}
                {isInsecure && (
                    <div className="absolute inset-0 z-[100] bg-white dark:bg-zinc-950 flex flex-col items-center justify-center p-8 text-center">
                        <div className="h-16 w-16 rounded-2xl bg-amber-500/10 flex items-center justify-center mb-4 border border-amber-500/20">
                            <AlertCircle className="h-8 w-8 text-amber-500" />
                        </div>
                        <h3 className="text-xl font-medium text-white uppercase tracking-tight tracking-tighter mb-4">CAMARA BLOQUEADA POR SEGURIDAD</h3>
                        <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-400 mb-6 uppercase tracking-widest leading-relaxed">
                            El navegador bloquea la camara en conexiones <span className="text-amber-500 font-medium">HTTP</span>.
                            <br/><br/>
                            Para usar la camara desde esta IP (<span className="text-white underline">{typeof window !== 'undefined' ? window.location.hostname : ''}</span>), necesitas configurar <span className="text-zinc-100 font-medium tracking-tight text-[11px]">HTTPS</span> o acceder via <span className="text-sky-400 font-medium tracking-tight text-[11px]">localhost</span>.
                        </p>
                        <button onClick={onClose} className="px-8 h-12 bg-white text-black rounded-2xl font-medium uppercase text-xs active:scale-95 transition-all"> ENTENDIDO </button>
                    </div>
                )}

                {/* ERROR DE INICIALIZACION (Permisos denegados, etc) */}
                {initError && !isInsecure && (
                    <div className="absolute inset-0 z-[100] bg-white dark:bg-zinc-950 flex flex-col items-center justify-center p-8 text-center">
                        <div className="h-16 w-16 rounded-2xl bg-rose-500/10 flex items-center justify-center mb-4 border border-rose-500/20">
                            <AlertCircle className="h-8 w-8 text-rose-500" />
                        </div>
                        <h3 className="text-xl font-medium text-white uppercase tracking-tight tracking-tighter mb-4">ERROR DE CAMARA</h3>
                        <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-400 mb-6 uppercase tracking-widest leading-relaxed">
                            No se pudo acceder a la camara. Asegurate de haber concedido los permisos necesarios.
                            <br/><br/>
                            <span className="text-rose-500/50 font-mono text-[8px] break-all">{initError}</span>
                        </p>
                        <button onClick={onClose} className="px-8 h-12 bg-rose-500 text-white rounded-2xl font-medium uppercase text-xs active:scale-95 transition-all"> VOLVER </button>
                    </div>
                )}

                <div id={uniqueId} ref={elementRef} className="w-full h-full object-cover min-h-[250px] min-w-[250px]"></div>

                {/* INTERFAZ VISUAL DEL ESCANER (Omnidireccional / Full-Screen) */}
                <div className="absolute inset-0 pointer-events-none z-10">
                    <div className={`absolute left-0 right-0 h-0.5 bg-gray-100 dark:bg-zinc-800 border border-black/5 dark:border-white/5 shadow-[0_0_15px_3px_rgba(16,185,129,0.8)] animate-[scan_2s_ease-in-out_infinite] ${flashActive ? 'hidden' : ''}`}></div>
                </div>

                {/* TOP BAR: Titulo + Flash + Cerrar */}
                <div className="absolute top-6 left-6 right-6 flex justify-between items-center z-20 pointer-events-auto">
                    <h2 id="scanner-title" className="text-white font-medium uppercase tracking-widest text-sm drop-shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center gap-2 bg-black/40 px-4 py-2 rounded-2xl">
                        <ScanLine className="h-5 w-5 text-zinc-100" />
                        {title || 'ESCANER RAPIDO'}
                    </h2>
                    <div className="flex items-center gap-2">
                        {/* BOTON DE FLASH / LINTERNA */}
                        <button
                            onClick={toggleTorch}
                            className={`h-10 w-10 rounded-2xl  flex items-center justify-center transition-all border ${
                                torchOn 
                                    ? 'bg-amber-500 border-amber-400 text-black shadow-[0_0_20px_rgba(245,158,11,0.6)]' 
                                    : torchSupported
                                        ? 'bg-black/50 border-black/5 dark:border-white/10 text-white hover:bg-amber-500/20 hover:border-amber-500/50'
                                        : 'bg-black/30 border-black/5 dark:border-white/5 text-white/30 cursor-not-allowed'
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
                            className="px-4 h-10 bg-black/50 hover:bg-rose-500 text-white rounded-2xl flex items-center gap-2 transition-all border border-black/5 dark:border-white/10 font-medium uppercase text-[10px] tracking-widest"
                        >
                            <X className="h-4 w-4" /> VOLVER
                        </button>
                    </div>
                </div>

                {/* INDICADOR DE FLASH ACTIVO - Barra inferior */}
                {torchOn && (
                    <div className="absolute bottom-6 left-6 right-6 z-20 pointer-events-none flex justify-center">
                        <div className="bg-amber-500/90 px-4 py-2 rounded-2xl flex items-center gap-2 shadow-[0_0_30px_rgba(245,158,11,0.4)] animate-pulse">
                            <Flashlight className="h-4 w-4 text-black" />
                            <span className="text-[10px] font-medium text-black uppercase tracking-widest">FLASH ACTIVO</span>
                        </div>
                    </div>
                )}

                {/* OVERLAY DE ERROR (Producto no encontrado) */}
                {errorTitle && (() => {
                    const scannedBarcode = errorMessage ? (errorMessage.match(/\d{8,14}/)?.[0] || '') : '';
                    return (
                        <div className="absolute inset-0 z-50 bg-black/60 flex items-center justify-center p-6 animate-in fade-in zoom-in duration-300 pointer-events-auto">
                            <div className="bg-white dark:bg-zinc-950/80 border border-gray-200 dark:border-zinc-800/50 p-8 rounded-[2.5rem] shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-emerald-900/10 text-center max-w-sm">
                                <div className="h-16 w-16 rounded-2xl bg-amber-500/10 flex items-center justify-center mx-auto mb-4 border border-amber-500/20">
                                    <AlertTriangle className="h-8 w-8 text-amber-500" />
                                </div>
                                <h3 className="text-xl font-medium text-white uppercase tracking-tight tracking-tighter mb-2">{errorTitle}</h3>
                                
                                {scannedBarcode && (
                                    <div className="mb-4">
                                        <span className="bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-300 border border-zinc-700/30 px-3 py-1.5 rounded-2xl font-mono text-xs font-bold tracking-wider">
                                            {scannedBarcode}
                                        </span>
                                    </div>
                                )}
                                
                                <p className="text-xs font-bold text-gray-500 dark:text-zinc-400 mb-6 tracking-tight leading-relaxed">{errorMessage}</p>
                                <div className="flex flex-col gap-3">
                                    <button
                                        onClick={onCreateProduct}
                                        className="w-full h-12 bg-gray-100 dark:bg-zinc-800 border border-black/5 dark:border-white/5 text-white rounded-2xl font-medium uppercase text-xs shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center justify-center gap-2 hover:scale-105 hover:bg-gray-100 dark:bg-zinc-800 border border-black/5 dark:border-white/5 transition-all"
                                    >
                                        <Plus size={16} /> CREAR PRODUCTO
                                    </button>
                                    <button
                                        onClick={onIgnoreError}
                                        className="w-full h-12 border border-gray-200 dark:border-zinc-800 bg-transparent text-gray-600 dark:text-zinc-300 hover:text-white hover:bg-[#18181b] rounded-2xl font-medium uppercase text-[10px] tracking-widest transition-colors"
                                    >
                                        VOLVER / IGNORAR
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })()}
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
                /* Ocultar el cuadro rojo que trae la libreria por defecto cuando le pasas un qrbox */
                #qr-shaded-region { border-color: rgba(0,0,0,0.5) !important; }
            `}} />
        </div>,
        document.body
    );
}