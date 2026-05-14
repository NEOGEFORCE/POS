"use client"

import { sileo } from "sileo";
import { playNotificationSound } from "@/lib/audio-utils";

/**
 * Hook puente para usar Sileo en lugar del sistema antiguo de toasts.
 * Añadimos sonido premium a cada notificación.
 */

type ToastProps = {
  title?: string;
  description?: string;
  variant?: 'default' | 'destructive' | 'success';
  duration?: number;
  action?: React.ReactNode;
};

function toast({ title, description, variant, duration, action }: ToastProps) {
  const options = {
    title: title || '',
    description: description || '',
    duration: duration || 4000,
  };

  const soundType = variant === 'destructive' ? 'error' : 
                    variant === 'success' ? 'success' : 'info';
  
  playNotificationSound(soundType);

  const message = title || description || '';
  const secondary = title ? description : '';

  // Configuración de estilo premium (Verde Esmeralda Vibrante para éxito)
  const successStyles = {
    style: { 
      background: '#059669', // Un verde un poco más oscuro y vibrante
      color: '#ffffff',
      border: '1px solid #10b981',
      boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)'
    },
    className: "font-black uppercase italic tracking-tight text-white"
  };

  switch (variant) {
    case 'success':
      return sileo.success(message, { 
        description: secondary, 
        duration: options.duration,
        ...successStyles
      });
    case 'destructive':
      return sileo.error(message, { 
        description: secondary, 
        duration: options.duration 
      });
    default:
      return sileo.info(message, { 
        description: secondary, 
        duration: options.duration 
      });
  }
}

function useToast() {
  return {
    toast,
    dismiss: () => {}, // Sileo se autodespide o tiene su propia lógica
  };
}

export { useToast, toast };
