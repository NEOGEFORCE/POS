"use client";

import React, { useState, useRef } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Progress } from "@heroui/react";
import { Upload, AlertTriangle, X, ShieldCheck, Camera, Receipt, CheckCircle2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import Cookies from 'js-cookie';
import {
  fillInvoiceItemDefaults,
  validateInvoiceFile,
  INVOICE_FILE_MAX_BYTES,
} from '@/lib/invoice-reader-helpers.mjs';

interface InvoiceReaderModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  supplierId: string;
  onExtractedItems: (items: any[]) => void;
}

export { INVOICE_FILE_MAX_BYTES };

export default function InvoiceReaderModal({
  isOpen,
  onOpenChange,
  supplierId,
  onExtractedItems
}: InvoiceReaderModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // Pistas fiscales — el usuario indica que impuestos buscar antes del OCR
  const [expectIVA, setExpectIVA] = useState(false);
  const [expectIBUA, setExpectIBUA] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      // Validacion centralizada (type + tamaño): se delega a un helper puro
      // para que los tests contractuales puedan verificar los limites sin DOM.
      const check = validateInvoiceFile(file);
      if (!check.ok) {
        toast({
          title: check.reason === 'too-large' ? 'Archivo demasiado grande' : 'Formato invalido',
          description: check.message || 'No pude procesar el archivo seleccionado.',
          variant: 'destructive',
        });
        // Limpia el input para permitir re-seleccionar el mismo archivo
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
      setSelectedFile(file);

      const reader = new FileReader();
      reader.onload = (event) => {
        setPreviewUrl(event.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleClearSelection = () => {
    if (isProcessing) return; // No permitir reset en pleno OCR
    setSelectedFile(null);
    setPreviewUrl(null);
  };

  const handleModalOpenChange = (open: boolean) => {
    // No permitir cerrar mientras procesa — evita abortos accidentales que
    // dejan requests colgados y toasts huerfanos.
    if (!open && isProcessing) return;
    onOpenChange(open);
  };

  // Valida que la respuesta sea JSON antes de parsearla.
  // Extrae mensaje de error robusto: soporta shape {error:string},
  // {error:{message,...}}, {userMessage}, {message}.
  const safeJson = async (res: Response) => {
    if (!res.ok) {
      let errMsg = `Error ${res.status} ${res.statusText || ''}`.trim();
      try {
        const text = await res.text();
        // Loguear el body crudo para diagnostico cuando falla
        console.error('[OCR] response body:', text);
        try {
          const errData = JSON.parse(text);
          if (typeof errData?.error === 'string') {
            errMsg = errData.error;
          } else if (errData?.error && typeof errData.error === 'object' && typeof errData.error.message === 'string') {
            errMsg = errData.error.message;
            if (typeof errData.error.details === 'string' && errData.error.details.trim() !== '') {
              errMsg += ` (${errData.error.details})`;
            }
          } else if (typeof errData?.userMessage === 'string') {
            errMsg = errData.userMessage;
          } else if (typeof errData?.message === 'string') {
            errMsg = errData.message;
          }
        } catch {
          // body no es JSON (HTML 404 del SPA fallback) — usar texto crudo abreviado
          if (text && !text.startsWith('<')) {
            errMsg = text.slice(0, 200);
          }
        }
      } catch {
        /* ignore */
      }
      throw new Error(errMsg);
    }
    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      throw new Error('El servidor no devolvio JSON valido. Posible error de ruta (404).');
    }
    return res.json();
  };

  const handleProcess = async () => {
    // Validaciones explicitas con feedback claro al usuario.
    if (!selectedFile || !previewUrl) {
      toast({ title: 'Falta archivo', description: 'Toma una foto o sube una imagen de la factura primero.', variant: 'destructive' });
      return;
    }
    if (!supplierId || supplierId === 'none' || supplierId === '') {
      toast({ title: 'Falta proveedor', description: 'Selecciona un proveedor antes de leer la factura.', variant: 'destructive' });
      return;
    }
    if (isProcessing) {
      // Doble click protection
      return;
    }

    setIsProcessing(true);
    const token = Cookies.get('org-pos-token');
    // Siempre usar la variable de entorno — nunca hardcodear IPs
    const apiUrl = (process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined')
      ? process.env.NEXT_PUBLIC_API_URL
      : '/api';

    try {
      // ── Comprimir y convertir a base64 ──────────────────────────────────
      const base64Image = await new Promise<string>((resolve, reject) => {
        const img = new Image();
        img.src = previewUrl;
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const MAX_WIDTH = 1600;
            const MAX_HEIGHT = 1600;
            let width = img.width;
            let height = img.height;
            if (width > height) {
              if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
            } else {
              if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx?.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.8));
          };
          img.onerror = () => reject(new Error('Error al cargar imagen'));
      });

      const payload = {
        supplierId: Number(supplierId),
        imageBase64: base64Image,
        mimeType: 'image/jpeg', // El canvas toDataURL siempre lo convierte a image/jpeg
        // Pistas fiscales del usuario — el backend ajusta el system prompt
        // para forzar a Claude a extraer estos porcentajes por linea.
        expectedTaxes: {
          iva: expectIVA,
          ibua: expectIBUA,
          icui: false,
        },
      };

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      };

      // Endpoint real del backend Go (ProductHandler.ScanInvoice).
      // El handler ya limpia el prefijo "data:image/...;base64," internamente
      // y usa Claude vision para extraer items.
      const ocrUrl = `${apiUrl}/inventory/scan-invoice`;
      const res = await fetch(ocrUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
      const data = await safeJson(res);

      // ── Auditoria inmediata de la respuesta cruda ──────────────────────
      // eslint-disable-next-line no-console
      console.log("📦 RESPUESTA CRUDA DEL OCR:", data);

      // ── Feedback visual de resultados ──────────────────────────────────
      // El backend retorna { totalDetected, totalMatched, scannedItems, unmatched }.
      // (Algunas versiones legacy pueden usar unmatchedItems en lugar de unmatched.)
      const scannedItems: any[] = Array.isArray(data?.scannedItems) ? data.scannedItems : [];
      const unmatchedRaw: any[] = Array.isArray(data?.unmatched)
        ? data.unmatched
        : Array.isArray(data?.unmatchedItems)
          ? data.unmatchedItems
          : [];

      const totalItems = scannedItems.length + unmatchedRaw.length;

      if (totalItems === 0) {
        toast({
          variant: 'destructive',
          title: 'Sin productos detectados',
          description: 'El OCR proceso la imagen pero no logro extraer productos. Verifica que la foto sea clara y que la factura tenga items legibles.',
        });
        setIsProcessing(false);
        return;
      }

      if (scannedItems.length === 0 && unmatchedRaw.length > 0) {
        toast({
          variant: 'default',
          title: `Detectados ${unmatchedRaw.length} items sin emparejar`,
          description: 'El OCR leyo productos pero ninguno se pudo emparejar con tu inventario. Revisa los nombres en el panel de no-emparejados.',
        });
      } else {
        toast({
          variant: 'success',
          title: `¡Exito! ${scannedItems.length} ${scannedItems.length === 1 ? 'producto' : 'productos'} detectados`,
          description: unmatchedRaw.length > 0
            ? `${unmatchedRaw.length} items sin emparejar requieren revision.`
            : 'Cargados al carrito de recepcion para revision.',
        });
      }

      // ── Inyeccion al padre con shape consistente ───────────────────────
      // El backend ya normaliza impuestos y descuentos vía normalizeExtractedItem
      // + splitBonusItems, así que acá no inventamos defaults monetarios. Solo
      // propagamos los campos tal cual, con clamp defensivo y un identificador
      // local estable (__ocrLocalId) para que el reviewer pueda deduplicar y
      // navegar sin depender del invoiceName.
      const itemsToReview = [
        ...scannedItems.map((item: any) => ({ ...fillInvoiceItemDefaults(item), isMatched: true })),
        ...unmatchedRaw.map((item: any) => ({ ...fillInvoiceItemDefaults(item), isMatched: false })),
      ];

      onExtractedItems(itemsToReview);
      onOpenChange(false);
      setSelectedFile(null);
      setPreviewUrl(null);

    } catch (err: any) {
      const errorText = (err && typeof err === 'object' && 'message' in err)
        ? String(err.message)
        : (typeof err === 'string' ? err : 'Error al leer la factura. Verifica tu conexion.');
      console.error('[OCR] Fallo:', errorText, err);
      toast({ variant: 'destructive', title: 'Error OCR', description: errorText });
    } finally {
      setIsProcessing(false);
    }
  };


  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={handleModalOpenChange}
      size="2xl"
      backdrop="blur"
      // Contrato "modal no descartable durante procesamiento": mientras isProcessing
      // sea true, el usuario NO puede cerrar con ESC, click fuera o botón X. Esto
      // evita que un request OCR quede huérfano y que el toast de resultado llegue
      // a una pantalla sin contexto. UnmatchedItemsReviewer sigue la misma regla.
      isDismissable={!isProcessing}
      isKeyboardDismissDisabled={isProcessing}
      hideCloseButton={isProcessing}
      classNames={{
        base: "bg-white/95 dark:bg-zinc-950/95 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]",
        closeButton: "top-4 right-4"
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1 border-b border-gray-100 dark:border-white/5 pb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 bg-emerald-500/10 rounded-2xl flex items-center justify-center text-emerald-500">
                  <Camera size={20} aria-hidden="true" />
                </div>
                <div>
                  <h2 className="text-xl font-medium tracking-tight text-zinc-900 dark:text-white uppercase">ESCANEO DE FACTURA</h2>
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest font-medium flex items-center gap-1">
                    <ShieldCheck size={10} aria-hidden="true" /> Procesamiento OCR
                  </p>
                </div>
              </div>
            </ModalHeader>
            <ModalBody className="py-6">
              {!selectedFile ? (
                <div className="grid grid-cols-2 gap-4">
                  <label className="w-full h-32 border-2 border-dashed border-emerald-500/50 dark:border-emerald-500/30 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors relative overflow-hidden group">
                    <Camera size={28} className="text-emerald-500 mb-2 group-hover:scale-110 transition-transform" aria-hidden="true" />
                    <p className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-widest text-center">Tomar<br/>Foto</p>
                    <input
                      type="file"
                      capture="environment"
                      className="absolute inset-0 opacity-0 cursor-pointer"
                      accept="image/*"
                      aria-label="Tomar foto de la factura con la camara"
                      onChange={handleFileChange}
                    />
                  </label>

                  <label className="w-full h-32 border-2 border-dashed border-gray-300 dark:border-zinc-700 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-50 dark:bg-zinc-900/50 transition-colors relative overflow-hidden group">
                    <Upload size={28} className="text-gray-400 mb-2 group-hover:scale-110 transition-transform" aria-hidden="true" />
                    <p className="text-[11px] font-bold text-gray-600 dark:text-gray-300 uppercase tracking-widest text-center">Subir<br/>Archivo</p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="absolute inset-0 opacity-0 cursor-pointer"
                      accept="image/*"
                      aria-label="Subir imagen de la factura desde el dispositivo"
                      onChange={handleFileChange}
                    />
                  </label>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4">
                  <div className="relative w-full h-64 bg-gray-100 dark:bg-zinc-900 rounded-2xl overflow-hidden border border-gray-200 dark:border-zinc-800">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={previewUrl!} alt="Previsualizacion de la factura" className="w-full h-full object-contain" />
                    {!isProcessing && (
                      <button
                        type="button"
                        onClick={handleClearSelection}
                        aria-label="Quitar imagen seleccionada"
                        className="absolute top-2 right-2 p-2 bg-red-500 text-white rounded-xl shadow-lg hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-offset-2"
                      >
                        <X size={16} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {isProcessing && (
                    <div className="w-full flex flex-col items-center gap-2" role="status" aria-live="polite">
                      <div className="flex items-center gap-3 text-emerald-500 bg-emerald-500/10 px-4 py-2 rounded-2xl">
                        <span className="text-[10px] font-bold uppercase tracking-widest">Procesando Factura · No cierres esta ventana</span>
                      </div>
                      <Progress
                        aria-label="Progreso del procesamiento OCR"
                        isIndeterminate
                        size="sm"
                        color="success"
                        className="w-full max-w-xs"
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Pistas fiscales — solo visibles cuando ya hay archivo seleccionado */}
              {selectedFile && !isProcessing && (
                <div className="mt-4 p-4 rounded-2xl bg-zinc-100 dark:bg-zinc-900/40 border border-zinc-200 dark:border-white/5">
                  <div className="flex items-center gap-2 mb-3">
                    <Receipt size={14} className="text-emerald-500" aria-hidden="true" />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-700 dark:text-zinc-300">
                      Impuestos esperados en esta factura
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Toggle Card IVA — boton clickable, estado por color emerald */}
                    <button
                      type="button"
                      onClick={() => setExpectIVA(v => !v)}
                      aria-pressed={expectIVA}
                      aria-label="Pedir al OCR buscar porcentaje de IVA"
                      className={`group cursor-pointer transition-all border rounded-xl p-3 flex items-center gap-3 text-left active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${
                        expectIVA
                          ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.08)]'
                          : 'bg-gray-100 dark:bg-[#121214] border-black/5 dark:border-white/5 text-gray-500 dark:text-zinc-400 hover:border-emerald-500/20'
                      }`}
                    >
                      <CheckCircle2
                        size={22}
                        className={`shrink-0 transition-all ${
                          expectIVA ? 'text-emerald-400 fill-emerald-500/20' : 'text-zinc-600'
                        }`}
                        aria-hidden="true"
                      />
                      <div className="flex flex-col">
                        <span className={`text-[11px] font-semibold uppercase tracking-tight ${
                          expectIVA ? 'text-emerald-400' : 'text-zinc-200'
                        }`}>
                          Buscar IVA
                        </span>
                        <span className={`text-[9px] font-medium uppercase tracking-widest ${
                          expectIVA ? 'text-emerald-500/70' : 'text-gray-500 dark:text-zinc-500'
                        }`}>
                          5% / 19% tipicos
                        </span>
                      </div>
                    </button>

                    {/* Toggle Card IBUA / ICUI */}
                    <button
                      type="button"
                      onClick={() => setExpectIBUA(v => !v)}
                      aria-pressed={expectIBUA}
                      aria-label="Pedir al OCR buscar porcentaje de IBUA o ICUI"
                      className={`group cursor-pointer transition-all border rounded-xl p-3 flex items-center gap-3 text-left active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${
                        expectIBUA
                          ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.08)]'
                          : 'bg-gray-100 dark:bg-[#121214] border-black/5 dark:border-white/5 text-gray-500 dark:text-zinc-400 hover:border-emerald-500/20'
                      }`}
                    >
                      <CheckCircle2
                        size={22}
                        className={`shrink-0 transition-all ${
                          expectIBUA ? 'text-emerald-400 fill-emerald-500/20' : 'text-zinc-600'
                        }`}
                        aria-hidden="true"
                      />
                      <div className="flex flex-col">
                        <span className={`text-[11px] font-semibold uppercase tracking-tight ${
                          expectIBUA ? 'text-emerald-400' : 'text-zinc-200'
                        }`}>
                          Buscar IBUA / ICUI
                        </span>
                        <span className={`text-[9px] font-medium uppercase tracking-widest ${
                          expectIBUA ? 'text-emerald-500/70' : 'text-gray-500 dark:text-zinc-500'
                        }`}>
                          Bebidas · 8% / 16% / 18% / 20%
                        </span>
                      </div>
                    </button>
                  </div>
                  {(expectIVA || expectIBUA) && (
                    <p className="text-[9px] font-medium text-emerald-600 dark:text-emerald-400 mt-2 ml-1 uppercase tracking-widest">
                      ✓ El OCR forzara la extraccion de estos porcentajes por linea
                    </p>
                  )}
                  <p className="mt-3 text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest flex items-center gap-1">
                    <AlertTriangle size={10} aria-hidden="true" /> Limite de archivo: 10 MB (JPG / PNG)
                  </p>
                </div>
              )}
            </ModalBody>
            <ModalFooter className="border-t border-gray-100 dark:border-white/5">
              <Button variant="light" onPress={onClose} isDisabled={isProcessing} className="rounded-xl text-[10px] uppercase tracking-widest font-medium">
                Cancelar
              </Button>
              <Button
                color="success"
                onPress={handleProcess}
                isLoading={isProcessing}
                isDisabled={!selectedFile || !supplierId || supplierId === 'none'}
                className="rounded-xl text-[10px] uppercase tracking-widest font-medium text-white shadow-lg"
              >
                Procesar Factura
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
