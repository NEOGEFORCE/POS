"use client"

import * as React from "react"
import { Volume2, VolumeX } from "lucide-react"
import { isSoundMuted, setSoundMuted } from "@/lib/audio-utils"

/**
 * Selector de Sonido del Sistema (SONIDO / MUTE).
 * Ubicado junto al botón de tema claro/oscuro.
 * Controla el silenciado global de notificaciones, beeps y alertas del sistema.
 */
export function SoundToggle() {
  const [muted, setMutedState] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMutedState(isSoundMuted());
    setMounted(true);

    const handleMuteChange = (e: Event) => {
      const customEv = e as CustomEvent;
      if (customEv?.detail?.muted !== undefined) {
        setMutedState(customEv.detail.muted);
      } else {
        setMutedState(isSoundMuted());
      }
    };

    window.addEventListener('pos-sound-mute-change', handleMuteChange);
    window.addEventListener('storage', handleMuteChange);
    return () => {
      window.removeEventListener('pos-sound-mute-change', handleMuteChange);
      window.removeEventListener('storage', handleMuteChange);
    };
  }, []);

  if (!mounted) {
    return (
      <div className="h-8 w-20 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] animate-pulse" />
    );
  }

  const base =
    "flex items-center gap-1.5 px-2.5 py-1 rounded-2xl text-[9px] font-medium uppercase tracking-widest transition-all cursor-pointer select-none";
  const idle =
    "text-[var(--text-secondary)] hover:text-[var(--text-primary)]";

  return (
    <div className="flex p-1 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] scale-90 sm:scale-100">
      <button
        type="button"
        title="Activar sonido del sistema"
        aria-pressed={!muted}
        onClick={() => setSoundMuted(false)}
        className={`${base} ${!muted ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold shadow-sm" : idle}`}
      >
        <Volume2 className="h-3.5 w-3.5 text-emerald-500" />
        <span className="hidden sm:inline">SONIDO</span>
      </button>
      <button
        type="button"
        title="Mutear todo el sistema"
        aria-pressed={muted}
        onClick={() => setSoundMuted(true)}
        className={`${base} ${muted ? "bg-rose-500/10 text-rose-600 dark:text-rose-400 font-bold shadow-sm" : idle}`}
      >
        <VolumeX className="h-3.5 w-3.5 text-rose-500" />
        <span className="hidden sm:inline">MUTE</span>
      </button>
    </div>
  );
}
