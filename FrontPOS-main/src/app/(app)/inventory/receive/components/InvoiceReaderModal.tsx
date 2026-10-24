"use client";

import React, { useState, useRef, useMemo, useEffect } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Progress,
} from "@heroui/react";
import {
  Upload,
  AlertTriangle,
  X,
  ShieldCheck,
  Camera,
  Receipt,
  CheckCircle2,
  Package,
  ArrowLeft,
  Boxes,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import Cookies from 'js-cookie';
import {
  fillInvoiceItemDefaults,
  validateInvoiceFile,
  INVOICE_FILE_MAX_BYTES,
  neutralizeTaxFields,
  anyItemRequiresPackConfirmation,
  itemRequiresPackConfirmation,
  getPackHintUnits,
  isValidUnitsPerPack,
  convertItemToIndividualUnits,
  convertItemAsPresentation,
  classifyPackMode,
  PACK_MODE_EMPAQUE,
  PACK_MODE_PRESENTACION,
  PACK_MIN_UNITS,
  PACK_MAX_UNITS,
} from '@/lib/invoice-reader-helpers.mjs';

interface InvoiceReaderModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  supplierId: string;
  onExtractedItems: (items: any[]) => void;
}

export { INVOICE_FILE_MAX_BYTES };

/**
 * Fase interna del modal. En `upload` el usuario sube la foto y marca los
 * impuestos esperados; en `packReview` el usuario confirma el multiplicador
 * de empaque para cada item que lo requiere antes de dispararlo al padre.
 */
type Stage = 'upload' | 'packReview';

/**
 * Representa una fila de la etapa de revisión de empaques. Mantiene la
 * referencia al item original (por `__ocrLocalId` cuando viene y por
 * `isMatched` + nombre como fallback) para que al confirmar podamos aplicar
 * la conversión al objeto correcto sin alterar los demás items.
 *
 * El `mode` captura la decisión del operario entre:
 *   - EMPAQUE: el número detectado es un multiplicador real
 *     (p.ej. "CAP X 24" = 24 unidades sueltas). Pide input de unidades.
 *   - PRESENTACION: el número es parte del gramaje/presentación del
 *     producto (p.ej. "X 58 ML" = una crema de 58 ml). Cada paquete entra
 *     como 1 unidad; no se pide input.
 */
type PackMode = 'EMPAQUE' | 'PRESENTACION';

interface PackReviewRow {
  key: string;
  isMatched: boolean;
  displayName: string;
  invoiceQuantity: number;
  hint: number;
  /** Texto crudo del input para preservar edición (solo útil en EMPAQUE). */
  unitsInput: string;
  /** Modo elegido por el operario para este producto. */
  mode: PackMode;
}

export default function InvoiceReaderModal({
  isOpen,
  onOpenChange,
  supplierId,
  onExtractedItems,
}: InvoiceReaderModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // Pistas fiscales independientes — el usuario indica qué impuestos buscar.
  // El payload `expectedTaxes` refleja exactamente estos 3 bool. Si alguno
  // queda apagado, el frontend neutraliza defensivamente los campos del OCR
  // para ese impuesto antes de pasar al padre.
  const [expectIVA, setExpectIVA] = useState(false);
  const [expectIBUA, setExpectIBUA] = useState(false);
  const [expectICUI, setExpectICUI] = useState(false);

  // Etapa interna. Mientras `packReview` esté activa, el modal retiene los
  // items (sin cerrarse ni llamar onExtractedItems) hasta que todas las filas
  // tengan un entero válido en [PACK_MIN_UNITS, PACK_MAX_UNITS].
  const [stage, setStage] = useState<Stage>('upload');
  const [pendingItems, setPendingItems] = useState<any[]>([]);
  const [packReviewRows, setPackReviewRows] = useState<PackReviewRow[]>([]);
  const [isCommittingPacks, setIsCommittingPacks] = useState(false);

  // ──────────────────────────────────────────────────────────────────────
  // Reset de estado — se dispara cuando el modal se cierra y también al
  // volver desde la etapa de empaques por "Cancelar".
  // ──────────────────────────────────────────────────────────────────────
  const resetAllState = () => {
    setSelectedFile(null);
    setPreviewUrl(null);
    setExpectIVA(false);
    setExpectIBUA(false);
    setExpectICUI(false);
    setStage('upload');
    setPendingItems([]);
    setPackReviewRows([]);
    setIsCommittingPacks(false);
  };

  // Si el modal se cierra desde fuera, limpiamos todo el estado para que la
  // próxima apertura empiece desde cero. Nunca dejamos el checkbox marcado
  // o la etapa de empaques "colgada".
  useEffect(() => {
    if (!isOpen) resetAllState();
  }, [isOpen]);

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
    if (isProcessing) return;
    setSelectedFile(null);
    setPreviewUrl(null);
  };

  const handleModalOpenChange = (open: boolean) => {
    // No permitir cerrar mientras procesa — evita abortos accidentales que
    // dejan requests colgados y toasts huerfanos.
    if (!open && (isProcessing || isCommittingPacks)) return;
    onOpenChange(open);
  };

  // ──────────────────────────────────────────────────────────────────────
  // Comunicación con el endpoint OCR — safeJson parsea respuestas y surface
  // mensajes humanos.
  // ──────────────────────────────────────────────────────────────────────
  const safeJson = async (res: Response) => {
    if (!res.ok) {
      let errMsg = `Error ${res.status} ${res.statusText || ''}`.trim();
      try {
        const text = await res.text();
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

  // ──────────────────────────────────────────────────────────────────────
  // Pipeline post-OCR: neutralización de impuestos + decisión de empaques
  // ──────────────────────────────────────────────────────────────────────
  //
  // Entrada: items normalizados por fillInvoiceItemDefaults, cada uno con la
  //          bandera `isMatched` ya puesta.
  // Salida 1: si NINGÚN item requiere confirmación, dispara onExtractedItems
  //           y cierra el modal.
  // Salida 2: si al menos uno la requiere, almacena los items y arma las
  //           filas de la etapa interna; el modal NO se cierra.
  //
  // La neutralización se aplica SIEMPRE, independientemente de la rama de
  // salida, para que ningún item quede con un impuesto "fantasma".
  const expectedTaxes = useMemo(() => ({
    iva: expectIVA,
    ibua: expectIBUA,
    icui: expectICUI,
  }), [expectIVA, expectIBUA, expectICUI]);

  const handleScanResult = (rawItems: any[]) => {
    // Neutralización defensiva: honra el checkbox del usuario para los 3
    // campos. El objeto neutralizado conserva los demás atributos intactos.
    const neutralized = rawItems.map((it) =>
      neutralizeTaxFields(it, expectedTaxes),
    );

    if (!anyItemRequiresPackConfirmation(neutralized)) {
      // Flujo rápido: nada que confirmar.
      onExtractedItems(neutralized);
      onOpenChange(false);
      setSelectedFile(null);
      setPreviewUrl(null);
      return;
    }

    // Hay empaques detectados — retenemos los items y mostramos la etapa de
    // revisión. NUNCA cerramos el modal aquí.
    const rows: PackReviewRow[] = [];
    neutralized.forEach((it: any, idx: number) => {
      if (!itemRequiresPackConfirmation(it)) return;
      const hint = getPackHintUnits(it);
      const name = typeof it.invoiceName === 'string' && it.invoiceName.trim()
        ? it.invoiceName
        : (typeof it.productName === 'string' && it.productName.trim()
            ? it.productName
            : (typeof it.name === 'string' ? it.name : 'Sin nombre'));
      // Default inteligente: nombres con magnitud ("X 58 ML", "X 450 GRS")
      // caen en PRESENTACION; nombres con marcador explícito ("X 24 UND")
      // caen en EMPAQUE. El operario puede cambiarlo en la UI.
      const mode: PackMode = classifyPackMode(it);
      rows.push({
        key: typeof it.__ocrLocalId === 'string' && it.__ocrLocalId
          ? it.__ocrLocalId
          : `${it.isMatched ? 'm' : 'u'}-${idx}-${name}`,
        isMatched: Boolean(it.isMatched),
        displayName: name,
        invoiceQuantity: Number(it.quantity) || 0,
        hint,
        // Input vacío si el default es PRESENTACION (no se usa); el hint
        // sólo se muestra como placeholder cuando el modo es EMPAQUE.
        unitsInput: mode === PACK_MODE_EMPAQUE ? String(hint || '') : '',
        mode,
      });
    });
    setPendingItems(neutralized);
    setPackReviewRows(rows);
    setStage('packReview');
    toast({
      variant: 'default',
      title: `${rows.length} ${rows.length === 1 ? 'empaque detectado' : 'empaques detectados'}`,
      description: 'Elige presentación o empaque por producto antes de cargar al carrito.',
    });
  };

  const handleProcess = async () => {
    if (!selectedFile || !previewUrl) {
      toast({ title: 'Falta archivo', description: 'Toma una foto o sube una imagen de la factura primero.', variant: 'destructive' });
      return;
    }
    if (!supplierId || supplierId === 'none' || supplierId === '') {
      toast({ title: 'Falta proveedor', description: 'Selecciona un proveedor antes de leer la factura.', variant: 'destructive' });
      return;
    }
    if (isProcessing) return;

    setIsProcessing(true);
    const token = Cookies.get('org-pos-token');
    const apiUrl = (process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined')
      ? process.env.NEXT_PUBLIC_API_URL
      : '/api';

    try {
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
        mimeType: 'image/jpeg',
        // Pistas fiscales independientes — el backend ajusta el system prompt
        // para pedirle a Claude extraer SÓLO los porcentajes que el usuario
        // marcó. Los demás vendrán en 0 por contrato y el frontend los
        // neutraliza defensivamente de todas formas.
        expectedTaxes: {
          iva: expectIVA,
          ibua: expectIBUA,
          icui: expectICUI,
        },
      };

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      };

      const ocrUrl = `${apiUrl}/inventory/scan-invoice`;
      const res = await fetch(ocrUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
      const data = await safeJson(res);

      // eslint-disable-next-line no-console
      console.log("📦 RESPUESTA CRUDA DEL OCR:", data);

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

      // Shape consistente para el pipeline post-OCR. fillInvoiceItemDefaults
      // ya hace clamp defensivo de porcentajes, uppercase de lineType, y
      // asigna un __ocrLocalId estable.
      const itemsToReview = [
        ...scannedItems.map((item: any) => ({
          ...fillInvoiceItemDefaults(item),
          isMatched: true,
          // Propagamos los campos del contrato backend aunque
          // fillInvoiceItemDefaults no los conozca; el casting a `any` evita
          // perder keys como packHintUnits/requiresPackConfirmation.
          packHintUnits: item?.packHintUnits ?? item?.pack_hint_units,
          requiresPackConfirmation:
            item?.requiresPackConfirmation ?? item?.requires_pack_confirmation,
        })),
        ...unmatchedRaw.map((item: any) => ({
          ...fillInvoiceItemDefaults(item),
          isMatched: false,
          packHintUnits: item?.packHintUnits ?? item?.pack_hint_units,
          requiresPackConfirmation:
            item?.requiresPackConfirmation ?? item?.requires_pack_confirmation,
        })),
      ];

      handleScanResult(itemsToReview);

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

  // ──────────────────────────────────────────────────────────────────────
  // Etapa de empaques — handlers
  // ──────────────────────────────────────────────────────────────────────

  const updateRowUnits = (key: string, raw: string) => {
    // Solo aceptamos dígitos. Esto evita que un pegado tipo "24.5" o "24,5"
    // deje la fila en estado inválido que no se puede validar.
    const sanitized = raw.replace(/[^\d]/g, '').slice(0, 3);
    setPackReviewRows(prev => prev.map(r => r.key === key ? { ...r, unitsInput: sanitized } : r));
  };

  /**
   * Cambia el modo de carga para una fila. Al pasar a PRESENTACION limpiamos
   * el input de unidades (visualmente no se usa) y al volver a EMPAQUE
   * rehidratamos con el hint para no obligar a tipear de nuevo si el OCR
   * ya había sugerido un número.
   */
  const setRowMode = (key: string, mode: PackMode) => {
    setPackReviewRows(prev => prev.map(r => {
      if (r.key !== key) return r;
      if (mode === PACK_MODE_PRESENTACION) {
        return { ...r, mode, unitsInput: '' };
      }
      return {
        ...r,
        mode,
        unitsInput: r.unitsInput && r.unitsInput !== ''
          ? r.unitsInput
          : String(r.hint || ''),
      };
    }));
  };

  const allRowsValid = packReviewRows.length > 0
    && packReviewRows.every(r =>
      r.mode === PACK_MODE_PRESENTACION || isValidUnitsPerPack(r.unitsInput),
    );

  /**
   * Al confirmar, para cada fila:
   *   - Modo PRESENTACION → aplicamos `convertItemAsPresentation` (deja
   *     cantidad/precio intactos, limpia requiresPackConfirmation y hint,
   *     marca trazabilidad simétrica).
   *   - Modo EMPAQUE → aplicamos `convertItemToIndividualUnits` con el N
   *     tecleado (multiplica cantidad y divide precio).
   *
   * Los items que no requerían confirmación pasan intactos.
   */
  const handleConfirmPacks = () => {
    if (!allRowsValid || isCommittingPacks) return;
    setIsCommittingPacks(true);
    const decisions = new Map<string, { mode: PackMode; units?: number }>();
    packReviewRows.forEach(r => {
      if (r.mode === PACK_MODE_PRESENTACION) {
        decisions.set(r.key, { mode: PACK_MODE_PRESENTACION });
        return;
      }
      const n = Number(r.unitsInput);
      if (isValidUnitsPerPack(n)) {
        decisions.set(r.key, { mode: PACK_MODE_EMPAQUE, units: n });
      }
    });

    const converted = pendingItems.map((it: any, idx: number) => {
      const key = typeof it.__ocrLocalId === 'string' && it.__ocrLocalId
        ? it.__ocrLocalId
        : `${it.isMatched ? 'm' : 'u'}-${idx}-${
            it.invoiceName || it.productName || it.name || 'Sin nombre'
          }`;
      const decision = decisions.get(key);
      if (!decision) return it; // No requirió confirmación.
      if (decision.mode === PACK_MODE_PRESENTACION) {
        return convertItemAsPresentation(it);
      }
      return convertItemToIndividualUnits(it, decision.units!);
    });

    onExtractedItems(converted);
    onOpenChange(false);
    // El efecto de cierre dispara resetAllState vía useEffect.
  };

  const handleBackToUpload = () => {
    if (isCommittingPacks) return;
    // Cancelar la etapa — limpia los items retenidos y vuelve al estado
    // inicial del modal. El usuario puede volver a subir o salir.
    setStage('upload');
    setPendingItems([]);
    setPackReviewRows([]);
    setSelectedFile(null);
    setPreviewUrl(null);
  };

  // ──────────────────────────────────────────────────────────────────────
  // Render helpers
  // ──────────────────────────────────────────────────────────────────────

  const renderTaxToggle = (opts: {
    pressed: boolean;
    onToggle: () => void;
    title: string;
    hint: string;
    ariaLabel: string;
  }) => (
    <button
      type="button"
      onClick={opts.onToggle}
      aria-pressed={opts.pressed}
      aria-label={opts.ariaLabel}
      className={`group cursor-pointer transition-all border rounded-xl p-3 flex items-center gap-3 text-left active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${
        opts.pressed
          ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.08)]'
          : 'bg-gray-100 dark:bg-[#121214] border-black/5 dark:border-white/5 text-gray-500 dark:text-zinc-400 hover:border-emerald-500/20'
      }`}
    >
      <CheckCircle2
        size={22}
        className={`shrink-0 transition-all ${
          opts.pressed ? 'text-emerald-400 fill-emerald-500/20' : 'text-zinc-600'
        }`}
        aria-hidden="true"
      />
      <div className="flex flex-col">
        <span className={`text-[11px] font-semibold uppercase tracking-tight ${
          opts.pressed ? 'text-emerald-400' : 'text-zinc-800 dark:text-zinc-200'
        }`}>
          {opts.title}
        </span>
        <span className={`text-[9px] font-medium uppercase tracking-widest ${
          opts.pressed ? 'text-emerald-500/70' : 'text-gray-500 dark:text-zinc-500'
        }`}>
          {opts.hint}
        </span>
      </div>
    </button>
  );

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={handleModalOpenChange}
      size="2xl"
      backdrop="blur"
      // Contrato "modal no descartable durante procesamiento": mientras el
      // OCR o la confirmación de empaques están en curso, el modal NO se
      // puede cerrar con ESC / click fuera / botón X. Esto preserva estados
      // intermedios (toast colgado, items retenidos) y evita abortos.
      isDismissable={!isProcessing && !isCommittingPacks && stage !== 'packReview'}
      isKeyboardDismissDisabled={isProcessing || isCommittingPacks || stage === 'packReview'}
      hideCloseButton={isProcessing || isCommittingPacks}
      classNames={{
        base: "bg-white/95 dark:bg-zinc-950/95 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]",
        closeButton: "top-4 right-4",
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1 border-b border-gray-100 dark:border-white/5 pb-4">
              <div className="flex items-center gap-3">
                <div className={`h-10 w-10 ${stage === 'packReview' ? 'bg-blue-500/10 text-blue-500' : 'bg-emerald-500/10 text-emerald-500'} rounded-2xl flex items-center justify-center`}>
                  {stage === 'packReview'
                    ? <Package size={20} aria-hidden="true" />
                    : <Camera size={20} aria-hidden="true" />}
                </div>
                <div>
                  <h2 className="text-xl font-medium tracking-tight text-zinc-900 dark:text-white uppercase">
                    {stage === 'packReview' ? 'MODO DE CARGA POR PRODUCTO' : 'ESCANEO DE FACTURA'}
                  </h2>
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest font-medium flex items-center gap-1">
                    {stage === 'packReview'
                      ? <>
                          <Boxes size={10} aria-hidden="true" /> Elige presentación o empaque por item
                        </>
                      : <>
                          <ShieldCheck size={10} aria-hidden="true" /> Procesamiento OCR
                        </>}
                  </p>
                </div>
              </div>
            </ModalHeader>
            <ModalBody className="py-6">
              {stage === 'upload' ? (
                <>
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

                      <label className="w-full h-32 border-2 border-dashed border-gray-300 dark:border-zinc-700 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-900/50 transition-colors relative overflow-hidden group">
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

                  {/* Pistas fiscales — 3 opciones independientes */}
                  {selectedFile && !isProcessing && (
                    <div className="mt-4 p-4 rounded-2xl bg-zinc-100 dark:bg-zinc-900/40 border border-zinc-200 dark:border-white/5">
                      <div className="flex items-center gap-2 mb-3">
                        <Receipt size={14} className="text-emerald-500" aria-hidden="true" />
                        <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-700 dark:text-zinc-300">
                          Impuestos esperados en esta factura
                        </span>
                      </div>
                      <div
                        role="group"
                        aria-label="Selección de impuestos esperados"
                        className="grid grid-cols-1 sm:grid-cols-3 gap-3"
                      >
                        {renderTaxToggle({
                          pressed: expectIVA,
                          onToggle: () => setExpectIVA(v => !v),
                          title: 'Buscar IVA',
                          hint: '5% / 19% tipicos',
                          ariaLabel: 'Pedir al OCR buscar porcentaje de IVA',
                        })}
                        {renderTaxToggle({
                          pressed: expectIBUA,
                          onToggle: () => setExpectIBUA(v => !v),
                          title: 'Buscar IBUA',
                          hint: 'Bebidas · 8% / 16% / 18% / 20%',
                          ariaLabel: 'Pedir al OCR buscar porcentaje de IBUA',
                        })}
                        {renderTaxToggle({
                          pressed: expectICUI,
                          onToggle: () => setExpectICUI(v => !v),
                          title: 'Buscar ICUI',
                          hint: 'Impuesto consumo ultraproc.',
                          ariaLabel: 'Pedir al OCR buscar porcentaje de ICUI',
                        })}
                      </div>
                      {(expectIVA || expectIBUA || expectICUI) && (
                        <p className="text-[9px] font-medium text-emerald-600 dark:text-emerald-400 mt-2 ml-1 uppercase tracking-widest">
                          ✓ El OCR forzara la extraccion de estos porcentajes por linea
                        </p>
                      )}
                      <p className="mt-3 text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest flex items-center gap-1">
                        <AlertTriangle size={10} aria-hidden="true" /> Limite de archivo: 10 MB (JPG / PNG)
                      </p>
                    </div>
                  )}
                </>
              ) : (
                /* ───────────────── Etapa interna: modo de carga por producto ───────────────── */
                <section
                  aria-label="Selección de modo de carga por producto"
                  className="flex flex-col gap-3"
                >
                  <div className="rounded-2xl bg-blue-500/5 border border-blue-500/20 p-3">
                    <p className="text-[11px] font-medium text-blue-700 dark:text-blue-300 leading-snug">
                      El OCR detectó un número junto a <strong>x</strong> / <strong>*</strong> en estos
                      productos. Puede ser un empaque (p.ej. <em>CAP X 24</em>) o parte de la
                      presentación (p.ej. <em>CREMA X 58 ML</em>). Elige el modo por producto:
                      <strong> PRESENTACIÓN</strong> entra como 1 unidad por renglón;{' '}
                      <strong>EMPAQUE</strong> multiplica cantidad y divide precio.
                    </p>
                  </div>

                  <ul
                    role="list"
                    className="flex flex-col gap-2 max-h-[55vh] overflow-y-auto pr-1"
                  >
                    {packReviewRows.map(row => {
                      const n = Number(row.unitsInput);
                      const isEmpaque = row.mode === PACK_MODE_EMPAQUE;
                      const inputValid = isEmpaque && isValidUnitsPerPack(row.unitsInput);
                      const rowValid = row.mode === PACK_MODE_PRESENTACION || inputValid;
                      const total = inputValid ? row.invoiceQuantity * n : 0;
                      const inputId = `pack-row-${row.key}`;
                      const modeGroupId = `pack-mode-${row.key}`;
                      return (
                        <li
                          key={row.key}
                          className="flex flex-col gap-3 rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 p-3 sm:p-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
                                {row.isMatched ? 'Producto emparejado' : 'Sin emparejar'}
                              </p>
                              <p className="text-sm font-medium uppercase text-zinc-900 dark:text-zinc-100 break-words">
                                {row.displayName}
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500 dark:text-zinc-500">Renglones</p>
                              <p className="text-base font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                                {row.invoiceQuantity}
                              </p>
                            </div>
                          </div>

                          {/* Selector de modo PRESENTACION / EMPAQUE */}
                          <div
                            role="radiogroup"
                            aria-labelledby={`${modeGroupId}-label`}
                            className="grid grid-cols-2 gap-2"
                          >
                            <span id={`${modeGroupId}-label`} className="sr-only">
                              Modo de carga para {row.displayName}
                            </span>
                            <button
                              type="button"
                              role="radio"
                              aria-checked={row.mode === PACK_MODE_PRESENTACION}
                              onClick={() => setRowMode(row.key, PACK_MODE_PRESENTACION)}
                              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${
                                row.mode === PACK_MODE_PRESENTACION
                                  ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-700 dark:text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.08)]'
                                  : 'bg-gray-100 dark:bg-[#121214] border-black/5 dark:border-white/5 text-gray-500 dark:text-zinc-400 hover:border-emerald-500/20'
                              }`}
                            >
                              <Package
                                size={16}
                                aria-hidden="true"
                                className={row.mode === PACK_MODE_PRESENTACION ? 'text-emerald-500' : 'text-zinc-500'}
                              />
                              <div className="flex flex-col min-w-0">
                                <span className="text-[10px] font-bold uppercase tracking-tight">
                                  Presentación
                                </span>
                                <span className="text-[9px] font-medium uppercase tracking-widest opacity-70">
                                  1 unidad por renglón
                                </span>
                              </div>
                            </button>

                            <button
                              type="button"
                              role="radio"
                              aria-checked={row.mode === PACK_MODE_EMPAQUE}
                              onClick={() => setRowMode(row.key, PACK_MODE_EMPAQUE)}
                              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
                                row.mode === PACK_MODE_EMPAQUE
                                  ? 'bg-blue-500/10 border-blue-500/50 text-blue-700 dark:text-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.08)]'
                                  : 'bg-gray-100 dark:bg-[#121214] border-black/5 dark:border-white/5 text-gray-500 dark:text-zinc-400 hover:border-blue-500/20'
                              }`}
                            >
                              <Boxes
                                size={16}
                                aria-hidden="true"
                                className={row.mode === PACK_MODE_EMPAQUE ? 'text-blue-500' : 'text-zinc-500'}
                              />
                              <div className="flex flex-col min-w-0">
                                <span className="text-[10px] font-bold uppercase tracking-tight">
                                  Empaque
                                </span>
                                <span className="text-[9px] font-medium uppercase tracking-widest opacity-70">
                                  × unidades / ÷ precio
                                </span>
                              </div>
                            </button>
                          </div>

                          {/* Input + preview — layout depende del modo */}
                          {row.mode === PACK_MODE_EMPAQUE ? (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                              <div className="flex flex-col gap-1">
                                <label
                                  htmlFor={inputId}
                                  className="text-[10px] font-bold uppercase tracking-widest text-blue-600 dark:text-blue-400"
                                >
                                  Unidades por paquete
                                </label>
                                <input
                                  id={inputId}
                                  type="text"
                                  inputMode="numeric"
                                  autoComplete="off"
                                  value={row.unitsInput}
                                  onChange={(e) => updateRowUnits(row.key, e.target.value)}
                                  aria-invalid={!inputValid}
                                  aria-describedby={`${inputId}-hint`}
                                  required
                                  className={`h-11 w-full text-center text-base font-bold rounded-xl bg-white dark:bg-[#121214] border transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                                    inputValid
                                      ? 'border-emerald-500/50 text-emerald-700 dark:text-emerald-400'
                                      : 'border-amber-500/50 text-amber-700 dark:text-amber-400'
                                  }`}
                                  placeholder={row.hint > 0 ? String(row.hint) : 'Ej. 24'}
                                />
                                <p id={`${inputId}-hint`} className="text-[9px] font-medium uppercase tracking-widest text-gray-500 dark:text-zinc-500">
                                  Entero entre {PACK_MIN_UNITS} y {PACK_MAX_UNITS}
                                  {row.hint > 0 ? ` · OCR sugirió ${row.hint}` : ''}
                                </p>
                              </div>

                              <div className="flex flex-col gap-1">
                                <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
                                  Entrará al stock como
                                </span>
                                <div
                                  className={`h-11 rounded-xl border px-3 flex items-center justify-between gap-2 ${
                                    inputValid
                                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400'
                                      : 'bg-gray-100 dark:bg-zinc-800/50 border-dashed border-gray-300 dark:border-white/10 text-gray-500 dark:text-zinc-500'
                                  }`}
                                  aria-live="polite"
                                >
                                  <span className="text-[11px] font-medium tabular-nums tracking-wide">
                                    {row.invoiceQuantity} × {inputValid ? n : '—'}
                                  </span>
                                  <span className="text-base font-bold tabular-nums">
                                    {inputValid ? total.toLocaleString('es-CO') : '—'}
                                    <span className="ml-1 text-[9px] uppercase tracking-widest font-medium">UND</span>
                                  </span>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-col gap-1">
                              <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500 dark:text-zinc-500">
                                Entrará al stock como
                              </span>
                              <div
                                className="h-11 rounded-xl border bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400 px-3 flex items-center justify-between gap-2"
                                aria-live="polite"
                              >
                                <span className="text-[11px] font-medium uppercase tracking-widest">
                                  Sin conversión · precio intacto
                                </span>
                                <span className="text-base font-bold tabular-nums">
                                  {row.invoiceQuantity.toLocaleString('es-CO')}
                                  <span className="ml-1 text-[9px] uppercase tracking-widest font-medium">
                                    {row.invoiceQuantity === 1 ? 'UND' : 'UNDS'}
                                  </span>
                                </span>
                              </div>
                            </div>
                          )}
                          {/* Marcador invisible: ayuda a tests detectar invalidez a nivel fila */}
                          <span className="sr-only" aria-hidden="true" data-row-valid={rowValid ? '1' : '0'} />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </ModalBody>
            <ModalFooter className="border-t border-gray-100 dark:border-white/5">
              {stage === 'upload' ? (
                <>
                  <Button
                    variant="light"
                    onPress={onClose}
                    isDisabled={isProcessing}
                    className="rounded-xl text-[10px] uppercase tracking-widest font-medium"
                  >
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
                </>
              ) : (
                <>
                  <Button
                    variant="light"
                    onPress={handleBackToUpload}
                    isDisabled={isCommittingPacks}
                    startContent={<ArrowLeft size={14} aria-hidden="true" />}
                    className="rounded-xl text-[10px] uppercase tracking-widest font-medium"
                  >
                    Cancelar
                  </Button>
                  <Button
                    color="primary"
                    onPress={handleConfirmPacks}
                    isDisabled={!allRowsValid || isCommittingPacks}
                    isLoading={isCommittingPacks}
                    className="rounded-xl text-[10px] uppercase tracking-widest font-medium text-white shadow-lg"
                  >
                    Confirmar y Continuar
                  </Button>
                </>
              )}
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
