"use client";

/**
 * Diálogo de fusión de marcador histórico.
 *
 * Se abre desde la pantalla de edición de productos cuando el backend
 * responde 409 con `code === 'HISTORICAL_MARKER_RESERVED'`. El operador
 * entiende que el código de barras que quiere asignar está oculto porque
 * guarda historial de kárdex/ventas de un producto discontinuado, y decide
 * si fusiona o cancela.
 *
 * Reglas:
 *  - No usa `window.confirm`. El estilo del sistema exige un modal propio.
 *  - Sólo administradores ven el botón de confirmar. El resto ve una
 *    indicación clara de que hay que pedir la fusión a un administrador.
 *  - Cancelar cierra el diálogo sin tocar la BD. El formulario padre debe
 *    quedar abierto con los mismos valores.
 *  - Cuando `isMerging` está en true, los botones se deshabilitan para
 *    prevenir doble envío.
 */

import * as React from 'react';
import { AlertTriangle, Barcode, ShieldAlert, GitMerge, Loader2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import type { HistoricalMarkerMetadata } from '@/lib/historical-marker.d.mts';

export interface HistoricalMarkerMergeDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  metadata: HistoricalMarkerMetadata | null;
  /** Nombre del producto real, tomado del formulario (editingProduct.productName). */
  realProductName?: string;
  /** Rol del usuario. Sólo admin/superadmin ven el botón de fusionar. */
  isAdmin: boolean;
  /** True mientras la petición al backend está en curso. */
  isMerging: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function HistoricalMarkerMergeDialog({
  isOpen,
  onOpenChange,
  metadata,
  realProductName,
  isAdmin,
  isMerging,
  onConfirm,
  onCancel,
}: HistoricalMarkerMergeDialogProps) {
  const markerBarcode = metadata?.markerBarcode ?? '';
  const realBarcode = metadata?.realBarcode ?? '';
  const markerName = metadata?.markerName ?? '';
  const productLabel = (realProductName ?? '').trim() || 'Producto sin nombre';

  const handleOpenChange = (open: boolean) => {
    if (isMerging) return; // No se puede cerrar mientras se fusiona.
    onOpenChange(open);
    if (!open) onCancel();
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        aria-describedby="historical-marker-desc"
        className={cn(
          'bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50',
          'border border-amber-500/40 dark:border-amber-500/40',
          'rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]',
          'max-w-lg'
        )}
      >
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <AlertTriangle size={20} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <AlertDialogTitle className="text-base font-medium uppercase tracking-tight text-zinc-900 dark:text-zinc-50">
                Código reservado por un marcador histórico
              </AlertDialogTitle>
              <AlertDialogDescription
                id="historical-marker-desc"
                className="mt-1 text-sm text-zinc-600 dark:text-zinc-300"
              >
                El código de barras que ingresaste está oculto porque conserva
                el historial de kárdex y ventas de un producto dado de baja.
                Sólo debes fusionarlos si se trata del mismo producto físico.
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        <div className="mt-1 grid gap-3">
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-3">
            <p className="text-[10px] font-medium uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
              Producto real (código actual)
            </p>
            <p className="mt-1 truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
              {productLabel}
            </p>
            <p className="mt-1 flex items-center gap-1.5 font-mono text-xs text-zinc-600 dark:text-zinc-300">
              <Barcode size={12} aria-hidden="true" />
              <span>{realBarcode || '—'}</span>
            </p>
          </div>

          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-[10px] font-medium uppercase tracking-widest text-amber-600 dark:text-amber-400">
              Código deseado (ocupado por marcador oculto)
            </p>
            <p className="mt-1 truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
              {markerName || 'Marcador histórico'}
            </p>
            <p className="mt-1 flex items-center gap-1.5 font-mono text-xs text-zinc-600 dark:text-zinc-300">
              <Barcode size={12} aria-hidden="true" />
              <span>{markerBarcode || '—'}</span>
            </p>
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-300">
            <p>
              La fusión mueve el kárdex, ventas y devoluciones del marcador
              hacia el producto real y libera el código.{' '}
              <span className="font-medium text-zinc-900 dark:text-zinc-50">
                Es una acción irreversible
              </span>{' '}
              y queda registrada en auditoría.
            </p>
          </div>

          {!isAdmin && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-700 dark:text-rose-300"
            >
              <ShieldAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <p>
                Solo un administrador puede ejecutar esta fusión.
                <span className="mt-0.5 block">
                  Pide al administrador que edite este producto y confirme la fusión,
                  o solicita otro código de barras.
                </span>
              </p>
            </div>
          )}
        </div>

        <AlertDialogFooter className="mt-3 gap-2">
          <AlertDialogCancel
            disabled={isMerging}
            className="rounded-2xl border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-100 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-white/5"
          >
            Cancelar
          </AlertDialogCancel>
          {isAdmin && (
            <AlertDialogAction
              disabled={isMerging || !metadata}
              onClick={(event) => {
                // Radix cierra el diálogo por defecto al hacer click en
                // AlertDialogAction. Prevenimos ese cierre porque queremos
                // mantenerlo abierto mientras corre la fusión y cerrarlo
                // explícitamente desde el padre cuando el flujo termina
                // (éxito o error del segundo guardado).
                event.preventDefault();
                if (isMerging || !metadata) return;
                onConfirm();
              }}
              className="rounded-2xl bg-amber-500 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:bg-amber-600 focus-visible:ring-amber-500 disabled:opacity-60"
            >
              {isMerging ? (
                <>
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  <span>Fusionando…</span>
                </>
              ) : (
                <>
                  <GitMerge size={14} aria-hidden="true" />
                  <span>Fusionar y guardar</span>
                </>
              )}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default HistoricalMarkerMergeDialog;
