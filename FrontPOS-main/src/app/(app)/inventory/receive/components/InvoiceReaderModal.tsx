"use client";

import React, { useState, useRef } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Spinner } from "@heroui/react";
import { Upload, Sparkles, AlertTriangle, Check, X, ShieldCheck, Image as ImageIcon, Camera } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import Cookies from 'js-cookie';

interface InvoiceReaderModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  supplierId: string;
  onExtractedItems: (items: any[]) => void;
}

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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      // Validar que sea imagen
      if (!file.type.startsWith('image/')) {
        toast({ title: 'Error', description: 'Por favor, selecciona una imagen', variant: 'destructive' });
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

  // Valida que la respuesta sea JSON antes de parsearla
  const safeJson = async (res: Response) => {
    if (!res.ok) {
       const errData = await res.json().catch(() => ({}));
       throw new Error(errData.error || errData.message || `Fallo en el servidor: ${res.status}`);
    }
    const contentType = res.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      throw new Error("El servidor no devolvió JSON válido. Posible error de ruta (404).");
    }
    return res.json();
  };

  const handleProcess = async () => {
    if (!selectedFile || !previewUrl) return;
    if (!supplierId || supplierId === 'none') {
        toast({ title: 'Atención', description: 'Selecciona un proveedor antes de leer la factura.', variant: 'destructive' });
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
        mimeType: selectedFile.type || 'image/jpeg'
      };

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      };

      let data: any = null;

      // ── INTENTO 1: OCR Estándar ─────────────────────────────────────────
      try {
        const ocrUrl = `${apiUrl}/inventory/process-invoice`;
        console.log("Enviando OCR a URL:", ocrUrl);
        const res1 = await fetch(ocrUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
        data = await safeJson(res1);
        console.log("[Pipeline] OCR Estándar exitoso:", data);
      } catch (ocrError: any) {
        // ── FALLBACK: Claude AI ─────────────────────────────────────────────
        console.warn("[Pipeline] OCR Estándar falló, activando IA de respaldo...", ocrError?.message);
        const aiUrl = `${apiUrl}/inventory/invoice-ai`;
        console.log("Enviando OCR a URL:", aiUrl);
        const res2 = await fetch(aiUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
        data = await safeJson(res2);
        console.log("[Pipeline] Claude AI exitoso:", data);
      }

      // ── Procesar resultado final ────────────────────────────────────────
      const itemsToReview = [
        ...(data.scannedItems || data.items || []).map((item: any) => ({ ...item, isMatched: true })),
        ...(data.unmatchedItems || []).map((item: any) => ({ ...item, isMatched: false }))
      ];

      toast({ variant: 'success', title: 'Lectura Completada', description: `Se detectaron ${itemsToReview.length} ítems.` });
      onExtractedItems(itemsToReview);
      onOpenChange(false);
      setSelectedFile(null);
      setPreviewUrl(null);

    } catch (err: any) {
      // Ambos intentos fallaron
      const errorText = err?.message || (typeof err === 'string' ? err : 'Error al leer la factura. Verifica tu conexión.');
      console.error("[Pipeline] Ambos intentos fallaron:", errorText);
      toast({ variant: 'destructive', title: 'Error OCR', description: errorText });
    } finally {
      setIsProcessing(false);
    }
  };


  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="2xl" backdrop="blur" classNames={{
      base: "bg-white/95 dark:bg-zinc-950/95 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]",
      closeButton: "top-4 right-4"
    }}>
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1 border-b border-gray-100 dark:border-white/5 pb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 bg-emerald-500/10 rounded-2xl flex items-center justify-center text-emerald-500">
                  <Camera size={20} />
                </div>
                <div>
                  <h2 className="text-xl font-medium tracking-tight text-zinc-900 dark:text-white uppercase">ESCANEO DE FACTURA</h2>
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest font-medium flex items-center gap-1">
                    <ShieldCheck size={10} /> Procesamiento OCR
                  </p>
                </div>
              </div>
            </ModalHeader>
            <ModalBody className="py-6">
              {!selectedFile ? (
                <div className="grid grid-cols-2 gap-4">
                  <label className="w-full h-32 border-2 border-dashed border-emerald-500/50 dark:border-emerald-500/30 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors relative overflow-hidden group">
                    <Camera size={28} className="text-emerald-500 mb-2 group-hover:scale-110 transition-transform" />
                    <p className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-widest text-center">Tomar<br/>Foto</p>
                    <input 
                      type="file" 
                      capture="environment"
                      className="absolute inset-0 opacity-0 cursor-pointer" 
                      accept="image/*" 
                      onChange={handleFileChange}
                    />
                  </label>
                  
                  <label className="w-full h-32 border-2 border-dashed border-gray-300 dark:border-zinc-700 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-900/50 transition-colors relative overflow-hidden group">
                    <Upload size={28} className="text-gray-400 mb-2 group-hover:scale-110 transition-transform" />
                    <p className="text-[11px] font-bold text-gray-600 dark:text-gray-300 uppercase tracking-widest text-center">Subir<br/>Archivo</p>
                    <input 
                      type="file" 
                      className="absolute inset-0 opacity-0 cursor-pointer" 
                      accept="image/*" 
                      onChange={handleFileChange}
                    />
                  </label>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4">
                  <div className="relative w-full h-64 bg-gray-100 dark:bg-zinc-900 rounded-2xl overflow-hidden border border-gray-200 dark:border-zinc-800">
                    <img src={previewUrl!} alt="Preview" className="w-full h-full object-contain" />
                    <button 
                      onClick={() => { setSelectedFile(null); setPreviewUrl(null); }}
                      className="absolute top-2 right-2 p-2 bg-red-500 text-white rounded-xl shadow-lg hover:bg-red-600"
                    >
                      <X size={16} />
                    </button>
                  </div>
                  {isProcessing && (
                    <div className="flex items-center gap-3 text-emerald-500 bg-emerald-500/10 px-4 py-2 rounded-2xl">
                      <Spinner size="sm" color="success" />
                      <span className="text-[10px] font-bold uppercase tracking-widest">Procesando Factura...</span>
                    </div>
                  )}
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
                isDisabled={!selectedFile || isProcessing || !supplierId}
                isLoading={isProcessing}
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
