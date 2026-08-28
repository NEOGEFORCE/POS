"use client"

import { toast as sonnerToast } from "sonner";
import { playNotificationSound } from "@/lib/audio-utils";

/**
 * Hook puente para usar Sonner en lugar del sistema antiguo de toasts.
 * Añadimos sonido premium a cada notificacion y estilos avanzados.
 */

type ToastProps = {
  title?: string;
  description?: string;
  variant?: 'default' | 'destructive' | 'success';
  duration?: number;
  action?: React.ReactNode;
  className?: string;
};

// Funcion auxiliar para formatear los mensajes
function formatMessage(title?: string, description?: string) {
  let mainMessage = title || '';
  let subMessage = description || '';

  // Si el title es generico como "ERROR", preferimos usar la descripcion como titulo
  if (mainMessage === 'ERROR' && subMessage) {
    mainMessage = subMessage.split(':')[0] || 'Error';
    subMessage = subMessage.substring(mainMessage.length + 1).trim() || subMessage;
  }
  
  // Limpiar mayusculas excesivas
  if (mainMessage === mainMessage.toUpperCase() && mainMessage.length > 5) {
    mainMessage = mainMessage.charAt(0) + mainMessage.slice(1).toLowerCase();
  }

  return { mainMessage, subMessage };
}

function toast({ title, description, variant = 'default', duration, action, className }: ToastProps) {
  const options = {
    duration: duration || 4500,
  };

  const { mainMessage, subMessage } = formatMessage(title, description);
  const premiumStyles = {
    description: subMessage,
    duration: options.duration,
    className: className || 'group',
    action,
  };

  if (variant === 'destructive') {
    playNotificationSound('error');
    return sonnerToast.error(mainMessage, premiumStyles);
  }

  if (variant === 'success') {
    playNotificationSound('success');
    return sonnerToast.success(mainMessage, premiumStyles);
  }

  playNotificationSound('info');
  return sonnerToast(mainMessage, premiumStyles);
}

function useToast() {
  return {
    toast,
    dismiss: () => {}, // Sileo se autodespide o tiene su propia logica
  };
}

export { useToast, toast };
