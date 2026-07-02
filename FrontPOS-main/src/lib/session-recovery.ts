"use client";

/**
 * Sistema de Recuperación de Sesión
 * 
 * Cuando una llamada API recibe un 401 (sesión expirada), en lugar de
 * sacar al usuario y perder su trabajo, este sistema:
 * 1. Pausa la llamada fallida
 * 2. Muestra un modal de re-login
 * 3. Espera a que el usuario se re-autentique
 * 4. Reintenta la llamada original con el nuevo token
 * 
 * Funciona a nivel global para TODO el sistema.
 */

type ResolveCallback = (newToken: string) => void;
type RejectCallback = () => void;

interface PendingRecovery {
  resolve: ResolveCallback;
  reject: RejectCallback;
}

// Cola de operaciones esperando re-autenticación
let pendingRecoveries: PendingRecovery[] = [];
let isRecoveryInProgress = false;

// Listeners para que el modal de re-login se entere
type RecoveryListener = (active: boolean) => void;
const listeners: Set<RecoveryListener> = new Set();

export function onSessionRecoveryChange(listener: RecoveryListener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyListeners(active: boolean) {
  listeners.forEach(fn => fn(active));
}

/**
 * Solicita re-autenticación. Retorna una Promise que se resuelve
 * con el nuevo token cuando el usuario se re-autentica exitosamente,
 * o se rechaza si el usuario cancela (y decide ir al login).
 */
export function requestSessionRecovery(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    pendingRecoveries.push({ resolve, reject });

    if (!isRecoveryInProgress) {
      isRecoveryInProgress = true;
      notifyListeners(true); // Activar el modal
    }
  });
}

/**
 * Llamado por el modal de re-login cuando el usuario se re-autentica.
 */
export function resolveSessionRecovery(newToken: string) {
  const pending = [...pendingRecoveries];
  pendingRecoveries = [];
  isRecoveryInProgress = false;
  notifyListeners(false); // Cerrar el modal

  // Resolver todas las operaciones pendientes con el nuevo token
  pending.forEach(p => p.resolve(newToken));
}

/**
 * Llamado cuando el usuario cancela y decide ir al login.
 */
export function rejectSessionRecovery() {
  const pending = [...pendingRecoveries];
  pendingRecoveries = [];
  isRecoveryInProgress = false;
  notifyListeners(false);

  pending.forEach(p => p.reject());
}

/**
 * Devuelve true si hay una recuperación de sesión en progreso.
 */
export function isSessionRecoveryActive(): boolean {
  return isRecoveryInProgress;
}
