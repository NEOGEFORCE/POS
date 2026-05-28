"use client"

import { toast as sonnerToast } from "sonner";
import { playNotificationSound } from "@/lib/audio-utils";

/**
 * Hook puente para usar Sonner en lugar del sistema antiguo de toasts.
 * Añadimos sonido premium a cada notificación y estilos avanzados.
 */

type ToastProps = {
  title?: string;
  description?: string;
  variant?: 'default' | 'destructive' | 'success';
  duration?: number;
  action?: React.ReactNode;
};

// Función auxiliar para formatear los mensajes
function formatMessage(title?: string, description?: string) {
  let mainMessage = title || '';
  let subMessage = description || '';

  // Si el title es genérico como "ERROR", preferimos usar la descripción como título
  if (mainMessage === 'ERROR' && subMessage) {
    mainMessage = subMessage.split(':')[0] || 'Error';
    subMessage = subMessage.substring(mainMessage.length + 1).trim() || subMessage;
  }
  
  // Limpiar mayúsculas excesivas
  if (mainMessage === mainMessage.toUpperCase() && mainMessage.length > 5) {
    mainMessage = mainMessage.charAt(0) + mainMessage.slice(1).toLowerCase();
  }

  return { mainMessage, subMessage };
}

function toast({ title, description, variant, duration, action }: ToastProps) {
  // SILENCIAR NOTIFICACIONES QUE NO SEAN ERRORES (A petición del usuario)
  if (variant !== 'destructive') {
    return;
  }

  const options = {
    duration: duration || 4500,
  };

  playNotificationSound('error');

  const { mainMessage, subMessage } = formatMessage(title, description);

  // Configuración de estilo premium
  const premiumStyles = {
    description: subMessage,
    duration: options.duration,
    className: 'group',
  };

  return sonnerToast.error(mainMessage, premiumStyles);
}

function useToast() {
  return {
    toast,
    dismiss: () => {}, // Sileo se autodespide o tiene su propia lógica
  };
}

export { useToast, toast };
