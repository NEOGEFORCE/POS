'use client';

import { useEffect } from 'react';

export default function SWRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('/sw.js')
          .then((registration) => {
            console.log('SW Ultra-Instinto registrado con éxito:', registration.scope);
          })
          .catch((error) => {
            console.error('Fallo al registrar SW Ultra-Instinto:', error);
          });
      });
    }
  }, []);

  return null;
}
