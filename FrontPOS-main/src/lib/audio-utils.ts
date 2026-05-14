/**
 * Motor de Audio para Notificaciones Cerberus POS
 * Genera tonos premium usando Web Audio API (sin archivos externos)
 */

export const playNotificationSound = (type: 'success' | 'error' | 'warning' | 'info' = 'info') => {
  if (typeof window === 'undefined') return;

  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const oscillator = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();

  oscillator.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  const now = audioCtx.currentTime;

  switch (type) {
    case 'success':
      // Tono doble ascendente (Premium Success)
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, now); // A5
      oscillator.frequency.exponentialRampToValueAtTime(1320, now + 0.1); // E6
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.1, now + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      oscillator.start(now);
      oscillator.stop(now + 0.3);
      break;

    case 'error':
      // Tono grave descendente (Error)
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(150, now);
      oscillator.frequency.linearRampToValueAtTime(100, now + 0.2);
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.2, now + 0.05);
      gainNode.gain.linearRampToValueAtTime(0, now + 0.4);
      oscillator.start(now);
      oscillator.stop(now + 0.4);
      break;

    case 'warning':
      // Tono medio (Alert)
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(440, now);
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.1, now + 0.05);
      gainNode.gain.linearRampToValueAtTime(0, now + 0.2);
      oscillator.start(now);
      oscillator.stop(now + 0.2);
      break;

    default:
      // Tono suave (Info)
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(660, now);
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.05, now + 0.05);
      gainNode.gain.linearRampToValueAtTime(0, now + 0.15);
      oscillator.start(now);
      oscillator.stop(now + 0.15);
  }
};
