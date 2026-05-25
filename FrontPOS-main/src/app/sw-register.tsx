'use client';

import { useEffect } from 'react';

export default function SWRegister() {
  useEffect(() => {
    // DESTROY SERVICE WORKER IN DEV MODE TO AVOID CACHE CORRUPTION WITH NEXT.JS
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (let registration of registrations) {
          registration.unregister();
        }
      });
    }
  }, []);

  return null;
}
