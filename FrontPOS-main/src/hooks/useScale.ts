import { useState, useEffect, useRef, useCallback } from 'react';
import { ScaleBridge } from '@/lib/scaleBridge';
import type { BridgeConnectionMode } from '@/lib/bridge-connection.mjs';

interface ScaleState {
    weight: number;
    isConnected: boolean;
    isScaleOnline: boolean;
    port: string;
    error: string | null;
    rawData: string;
    isReloading: boolean;
    mode: BridgeConnectionMode | null;
    cajaId: string | null;
}

export function useScale() {
    const bridgeRef = useRef<ScaleBridge | null>(null);
    const [state, setState] = useState<ScaleState>({
        weight: 0,
        isConnected: false,
        isScaleOnline: false,
        port: '',
        error: null,
        rawData: '',
        isReloading: false,
        mode: null,
        cajaId: null,
    });

    useEffect(() => {
        bridgeRef.current = ScaleBridge.getInstance();

        const unsubscribe = bridgeRef.current.subscribe((newState) => {
            setState(newState);
        });

        return () => {
            unsubscribe();
        };
    }, []);

    const reload = useCallback(() => {
        bridgeRef.current?.reload();
    }, []);

    const renegotiate = useCallback(() => {
        bridgeRef.current?.renegotiate();
    }, []);

    return {
        weight: state.weight,
        isConnected: state.isConnected,
        isScaleOnline: state.isScaleOnline,
        port: state.port,
        error: state.error,
        rawData: state.rawData,
        isReloading: state.isReloading,
        /** `"local"` cuando el navegador alcanza el bridge directo; `"relay"` cuando atraviesa el servidor. */
        mode: state.mode,
        /** Caja atendida por el relay cuando `mode === "relay"`. `null` en modo local. */
        cajaId: state.cajaId,
        reload,
        /**
         * Fuerza una renegociación de la conexión. Útil después de cambiar
         * la preferencia de caja en el selector del header.
         */
        renegotiate,
    };
}
