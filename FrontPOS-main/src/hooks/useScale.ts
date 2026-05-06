import { useState, useEffect, useRef, useCallback } from 'react';
import { ScaleBridge } from '@/lib/scaleBridge';

interface ScaleState {
    weight: number;
    isConnected: boolean;
    isScaleOnline: boolean;
    port: string;
    error: string | null;
    rawData: string;
    isReloading: boolean;
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

    return {
        weight: state.weight,
        isConnected: state.isConnected,
        isScaleOnline: state.isScaleOnline,
        port: state.port,
        error: state.error,
        rawData: state.rawData,
        isReloading: state.isReloading,
        reload,
    };
}
