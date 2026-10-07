"use client";

// =============================================================================
// /labels — Generador y gestor de códigos de barras + control de cajón.
//
// Reemplaza la pantalla antigua (impresión directa con window.print, cola en
// memoria, sin persistencia). Esta versión:
//
//   1. Busca productos por tres canales a la vez:
//      - Lector USB (keyboard-wedge): el input textual atrapa Enter y lanza
//        la búsqueda.
//      - Cámara: BarcodeDetector si el navegador lo expone; sino, cae a
//        html5-qrcode (ya instalado en el proyecto).
//      - Texto libre: búsqueda incremental contra /api/labels/codes/search
//        + /api/products/all-products para producto nuevo.
//
//   2. Para cada producto, PIDE al backend "asegurar código" vía
//      POST /api/labels/codes. El backend es idempotente: si ya existe
//      código para ese barcode (no voided), lo reutiliza. Si no, genera
//      uno libre de colisiones contra products.barcode, alternateCodes y
//      label_codes.code.
//
//   3. Permite imprimir N etiquetas. Al hacer click en "Imprimir":
//      - POST /api/labels/print-jobs con el payload — queda en auditoría.
//      - Lanza window.print() en modo etiqueta (fallback sin bridge).
//      - Si hay un bridge local disponible (window.posBridge), le pasa el
//        job para impresión real ESC/POS/TSPL.
//
//   4. Botón "Abrir cajón" aquí (admin) y en /sales/new (empleado con
//      venta reciente). La UI muestra claramente si hay bridge o no:
//      sin bridge, el POST /api/cash-drawer/open sólo audita; el pulso
//      físico lo manda el bridge local.
//
// ADVERTENCIA DE CAPACIDADES
// --------------------------
// Un navegador moderno NO puede escribir en una impresora térmica USB
// directamente. Las opciones reales son:
//   a) WebUSB (Chromium only, HTTPS obligatorio, permiso explícito del
//      usuario cada vez). Fuera de alcance de este sprint.
//   b) Bridge local tipo scale-bridge: un servicio Node en localhost que
//      expone POST /print y POST /drawer. Este es el camino viable.
//
// Hasta que exista el bridge, los perfiles con protocol="pdf" o "system"
// imprimen por el diálogo del navegador. La UI lo documenta explícitamente
// en /labels/config.
// =============================================================================

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Button, Chip, Input, Spinner, Tooltip } from "@heroui/react";
import { Barcode, Printer, RefreshCw, Scan, Search, Trash2, Minus, Plus as PlusIcon, DoorOpen } from "lucide-react";

import { useApi } from "@/hooks/use-api";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-error";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/auth-helpers.mjs";
import { labelBatchTriggerSource } from "@/lib/label-print-trigger.mjs";
import { loadPrintingConfig } from "@/lib/printing-config.mjs";

const ScannerOverlay = dynamic(() => import("@/components/ScannerOverlay").then(m => m.ScannerOverlay), { ssr: false });

interface Product {
  barcode: string;
  productName: string;
  salePrice?: number;
  purchasePrice?: number;
}

interface LabelCode {
  code: string;
  productBarcode?: string | null;
  productName?: string;
  salePrice?: number;
  lastPrintedAt?: string | null;
  printCount?: number;
}

interface QueueItem {
  code: LabelCode;
  product: Product | null;
  quantity: number;
  /**
   * `true` cuando `POST /labels/codes` creó el code en esta sesión;
   * `false` cuando reutilizó uno existente (idempotencia). Se usa para
   * derivar el `triggerSource` del lote en handlePrint. Si se descartara
   * aquí, el page quedaría obligado a disparar un segundo request a
   * `/labels/codes/search` o similar para distinguir new/reprint, cosa
   * que ya se hizo al encolar.
   */
  created: boolean;
}

interface PrinterProfile {
  id: number;
  name: string;
  protocol: string;
  target: string;
  drawerConnected: boolean;
  isDefault: boolean;
}

interface SizeTemplate {
  id: number;
  name: string;
  widthMm: number;
  heightMm: number;
  isDefault: boolean;
}

export default function LabelsPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  // Fuente unica: src/lib/auth-helpers.mjs. Antes esta pantalla tenia su
  // propio set hardcodeado que no reconocia "super_admin" / "root".
  const isAdmin = isAdminUser(user);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [query, setQuery] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const { data: productsResponse } = useApi<any>("/products/all-products");
  const { data: profilesResp } = useApi<{ profiles: PrinterProfile[] }>("/labels/printers");
  const { data: sizesResp } = useApi<{ templates: SizeTemplate[] }>("/labels/sizes");

  const products: Product[] = useMemo(() => {
    const raw = productsResponse;
    if (Array.isArray(raw)) return raw;
    if (raw?.items && Array.isArray(raw.items)) return raw.items;
    return [];
  }, [productsResponse]);

  const printers = profilesResp?.profiles ?? [];
  const sizes = sizesResp?.templates ?? [];
  const defaultPrinter = printers.find(p => p.isDefault) ?? printers[0] ?? null;
  const defaultSize = sizes.find(s => s.isDefault) ?? sizes[0] ?? null;

  // El input autoFocus se mantiene activo al cargar la pantalla, lo cual
  // permite al lector USB (keyboard-wedge) emitir el código seguido de
  // Enter sin que el usuario tenga que hacer click. useEffect se encarga
  // de reenfocar tras cada acción.

  const findLocalProduct = useCallback((barcode: string): Product | null => {
    const needle = barcode.trim().toUpperCase();
    return products.find(p => (p.barcode || "").toUpperCase() === needle) ?? null;
  }, [products]);

  const addToQueue = useCallback(async (barcode: string) => {
    const bc = barcode.trim();
    if (!bc) return;
    setIsBusy(true);
    try {
      const product = findLocalProduct(bc);
      // POST /labels/codes: si el producto ya tiene code, lo reutiliza
      // (idempotente). Si no, el backend genera uno nuevo validando colisión
      // contra TODOS los códigos existentes (barcode + alternateCodes + label_codes).
      const resp = await apiFetch<{ code: LabelCode; created: boolean }>("/labels/codes", {
        method: "POST",
        body: JSON.stringify({ productBarcode: bc }),
      });
      if (!resp?.code) throw new Error("respuesta inválida del backend");
      setQueue(prev => {
        const existing = prev.findIndex(q => q.code.code === resp.code.code);
        if (existing >= 0) {
          const copy = [...prev];
          // Un code reencontrado conserva su `created` original: si en este
          // batch nació nuevo, sigue siendo "new" aunque el usuario lo
          // re-agregue; si existía antes, sigue siendo "reprint". Así un
          // re-click no camufla una reimpresión al colapsar el lote.
          copy[existing] = { ...copy[existing], quantity: copy[existing].quantity + 1 };
          return copy;
        }
        return [{ code: resp.code, product, quantity: 1, created: !!resp.created }, ...prev];
      });
      if (resp.created) {
        toast({ variant: "default", title: "CÓDIGO GENERADO", description: resp.code.code });
      }
    } catch (e: any) {
      toast({ variant: "destructive", title: "Error", description: e?.message || "No se pudo generar el código" });
    } finally {
      setIsBusy(false);
      setQuery("");
    }
  }, [findLocalProduct, toast]);

  // Búsqueda textual: cuando el usuario escribe el nombre del producto,
  // mostramos sugerencias locales (contra el catálogo cargado). El Enter
  // valida como lectura USB y añade por barcode.
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return products
      .filter(p => (p.productName || "").toLowerCase().includes(q) || (p.barcode || "").toLowerCase().includes(q))
      .slice(0, 6);
  }, [products, query]);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && query.trim()) {
      e.preventDefault();
      void addToQueue(query.trim());
    }
  }, [query, addToQueue]);

  const updateQuantity = (code: string, delta: number) => {
    setQueue(prev => prev.map(q => q.code.code === code ? { ...q, quantity: Math.max(1, q.quantity + delta) } : q));
  };

  const removeFromQueue = (code: string) => {
    setQueue(prev => prev.filter(q => q.code.code !== code));
  };

  const totalLabels = queue.reduce((acc, q) => acc + q.quantity, 0);

  const handlePrint = useCallback(async () => {
    if (queue.length === 0) return;
    setIsBusy(true);
    try {
      // Trigger del lote: si TODAS las etiquetas usan codes recién creados
      // en esta sesión → "new"; si hay al menos una reimpresión (code ya
      // existente), el batch queda marcado como "reprint" en auditoría.
      // La semántica individual la fija LabelPrintSheet
      // (`ensure.created ? "new" : "reprint"`); aquí la colapsamos para el
      // payload único de /labels/print-jobs sin disparar un segundo
      // request a /labels/codes/search.
      const triggerSource = labelBatchTriggerSource(queue.map(q => q.created));
      const payload = {
        printerProfileId: defaultPrinter?.id ?? null,
        sizeTemplateId: defaultSize?.id ?? null,
        triggerSource,
        items: queue.map(q => ({ code: q.code.code, quantity: q.quantity })),
        meta: {
          printedBy: user?.name || user?.dni || "",
          printerName: defaultPrinter?.name || "navegador",
          sizeName: defaultSize?.name || "default",
        },
      };
      await apiFetch("/labels/print-jobs", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      // Capacidad real: si existe un bridge local, se le pide imprimir con
      // el payload de auditoría + la configuración de conexión y etiqueta
      // persistida en /labels/config (sanitizada por el helper puro).
      // Sin bridge, caemos al diálogo del navegador.
      const printingConfig = loadPrintingConfig();
      const bridgePayload = {
        ...payload,
        connection: printingConfig.connection,
        labels: printingConfig.labels,
      };
      const w = window as any;
      if (w.posBridge?.print) {
        try { await w.posBridge.print(bridgePayload); }
        catch { window.print(); }
      } else {
        window.print();
      }
      toast({ variant: "default", title: "LOTE REGISTRADO", description: `${totalLabels} etiqueta(s) enviadas` });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Error", description: e?.message || "No se pudo imprimir" });
    } finally {
      setIsBusy(false);
    }
  }, [queue, defaultPrinter, defaultSize, user, totalLabels, toast]);

  const handleOpenDrawer = useCallback(async () => {
    try {
      await apiFetch("/cash-drawer/open", {
        method: "POST",
        body: JSON.stringify({
          override: isAdmin,
          note: "Apertura manual desde /labels",
          printerProfileId: defaultPrinter?.id ?? null,
        }),
      });
      const w = window as any;
      if (w.posBridge?.kickDrawer) {
        try { await w.posBridge.kickDrawer({ printerProfileId: defaultPrinter?.id ?? null }); }
        catch { /* ignorar: la auditoría ya quedó */ }
      }
      toast({ variant: "default", title: "CAJÓN AUTORIZADO", description: "Si no se abrió físicamente, verifica el bridge local." });
    } catch (e: any) {
      const msg = e?.message || "No se pudo abrir el cajón";
      toast({ variant: "destructive", title: "BLOQUEADO", description: msg });
    }
  }, [isAdmin, defaultPrinter, toast]);

  return (
    <div className="flex flex-col min-h-screen gap-2 p-2 bg-gray-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50 transition-colors duration-500 pb-24">
      <style dangerouslySetInnerHTML={{
        __html: `
          @media print {
            @page { margin: 0.4cm; }
            body { -webkit-print-color-adjust: exact; background: white !important; }
            .print\\:hidden { display: none !important; }
            .print\\:show { display: block !important; }
          }
        `,
      }} />

      <header className="flex items-center justify-between gap-2 p-3 bg-white dark:bg-zinc-900 rounded-2xl shadow-sm print:hidden">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
            <Barcode size={18} />
          </div>
          <div>
            <h1 className="text-sm font-bold uppercase tracking-widest">Etiquetas y Códigos</h1>
            <p className="text-[9px] uppercase tracking-widest text-zinc-500">
              Generador persistente · {products.length} productos cargados
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip content={isAdmin ? "Abrir cajón (admin)" : "Sólo con venta reciente"}>
            <Button
              size="sm"
              color="warning"
              variant="flat"
              startContent={<DoorOpen size={14} />}
              onPress={handleOpenDrawer}
              className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
            >
              Abrir cajón
            </Button>
          </Tooltip>
          {isAdmin && (
            <Button
              size="sm"
              variant="flat"
              onPress={() => { if (typeof window !== "undefined") window.location.href = "/labels/config"; }}
              className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
            >
              Configurar
            </Button>
          )}
          <Button
            size="sm"
            color="success"
            isDisabled={queue.length === 0 || isBusy}
            onPress={handlePrint}
            startContent={<Printer size={14} />}
            className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
          >
            Imprimir ({totalLabels})
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-2 print:hidden">
        {/* Columna 1: búsqueda + escáner */}
        <section className="lg:col-span-5 flex flex-col gap-2">
          <div className="p-3 bg-white dark:bg-zinc-900 rounded-2xl shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <Search size={14} />
              <h2 className="text-[10px] uppercase tracking-widest font-bold">Buscar producto</h2>
            </div>
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleInputKeyDown}
              autoFocus
              placeholder="Lee con lector USB (Enter) · Escribe nombre o barcode · Enter"
              startContent={<Barcode size={14} className="text-zinc-500" />}
              classNames={{ inputWrapper: "rounded-2xl" }}
              aria-label="Buscar producto por barcode, nombre o lector USB"
              data-testid="labels-search-input"
            />
            <div className="flex gap-2 mt-2">
              <Button
                size="sm"
                variant="flat"
                startContent={<Scan size={14} />}
                onPress={() => setScannerOpen(true)}
                className="rounded-2xl text-[10px] uppercase tracking-widest font-bold flex-1"
              >
                Escanear cámara
              </Button>
              <Button
                size="sm"
                variant="flat"
                isIconOnly
                onPress={() => { setQuery(""); }}
                className="rounded-2xl"
                aria-label="Limpiar búsqueda"
              >
                <RefreshCw size={14} />
              </Button>
            </div>

            {suggestions.length > 0 && (
              <div className="mt-3 space-y-1 max-h-80 overflow-auto">
                {suggestions.map(p => (
                  <button
                    key={p.barcode}
                    onClick={() => addToQueue(p.barcode)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left rounded-xl bg-zinc-50 hover:bg-emerald-50 dark:bg-zinc-800 dark:hover:bg-emerald-900/20 border border-zinc-200 dark:border-white/5 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-bold truncate">{p.productName}</p>
                      <p className="text-[9px] text-zinc-500 truncate">{p.barcode}</p>
                    </div>
                    {typeof p.salePrice === "number" && (
                      <Chip size="sm" variant="flat" className="rounded-xl">
                        ${p.salePrice.toLocaleString("es-CO")}
                      </Chip>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="p-3 bg-amber-50 dark:bg-amber-950/20 rounded-2xl border border-amber-500/30 text-[11px] leading-relaxed">
            <p className="font-bold uppercase tracking-widest text-amber-700 dark:text-amber-400 mb-1">Capacidades reales</p>
            <ul className="list-disc pl-4 space-y-1 text-zinc-700 dark:text-zinc-300">
              <li>El navegador NO controla directamente impresoras USB ni el cajón.</li>
              <li>Con bridge local (scale-bridge o similar) se envía el pulso ESC/POS real.</li>
              <li>Sin bridge, Imprimir usa el diálogo del navegador y "Abrir cajón" sólo audita.</li>
              {!defaultPrinter && (
                <li className="font-bold text-amber-700 dark:text-amber-400">No hay impresora configurada. Admin → "Configurar".</li>
              )}
            </ul>
          </div>
        </section>

        {/* Columna 2: cola de impresión */}
        <section className="lg:col-span-7 p-3 bg-white dark:bg-zinc-900 rounded-2xl shadow-sm">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-[10px] uppercase tracking-widest font-bold">Cola de impresión · {queue.length}</h2>
            {queue.length > 0 && (
              <Button
                size="sm"
                color="danger"
                variant="light"
                onPress={() => setQueue([])}
                className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
              >
                Vaciar
              </Button>
            )}
          </div>

          {queue.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
              <Barcode size={32} className="opacity-30 mb-2" />
              <p className="text-xs uppercase tracking-widest">Agrega productos para imprimir</p>
            </div>
          ) : (
            <ul className="space-y-2 max-h-[60vh] overflow-auto">
              {queue.map(item => (
                <li
                  key={item.code.code}
                  data-queue-code={item.code.code}
                  className="flex items-center gap-3 p-2 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-white/5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold truncate">
                      {item.product?.productName || item.code.productName || "Etiqueta libre"}
                    </p>
                    <p className="text-[9px] font-mono text-zinc-500 truncate">
                      {item.code.code}
                      {item.code.printCount != null && item.code.printCount > 0 ? ` · ${item.code.printCount} prints` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button isIconOnly size="sm" variant="flat" className="rounded-xl" aria-label="menos" onPress={() => updateQuantity(item.code.code, -1)}>
                      <Minus size={12} />
                    </Button>
                    <span className="text-xs font-bold w-8 text-center tabular-nums">{item.quantity}</span>
                    <Button isIconOnly size="sm" variant="flat" className="rounded-xl" aria-label="más" onPress={() => updateQuantity(item.code.code, 1)}>
                      <PlusIcon size={12} />
                    </Button>
                    <Button isIconOnly size="sm" variant="light" color="danger" className="rounded-xl ml-1" aria-label="quitar" onPress={() => removeFromQueue(item.code.code)}>
                      <Trash2 size={12} />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Scanner por cámara (BarcodeDetector si está disponible, sino html5-qrcode). */}
      {scannerOpen && (
        <ScannerOverlay
          isOpen={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onResult={(code: string) => {
            void addToQueue(code);
            setScannerOpen(false);
          }}
          title="Lector de códigos"
        />
      )}

      {/* Área imprimible: una página por etiqueta × cantidad. */}
      <div className="hidden print:show bg-white w-full">
        {queue.flatMap(q => Array.from({ length: q.quantity }).map((_, idx) => (
          <div key={`${q.code.code}-${idx}`} className="print-label">
            <div style={{ fontSize: 10, fontWeight: 700 }}>
              {q.product?.productName || q.code.productName || "Etiqueta"}
            </div>
            <div style={{ fontFamily: "monospace", fontSize: 12 }}>{q.code.code}</div>
            {typeof q.product?.salePrice === "number" && (
              <div style={{ fontSize: 11 }}>${q.product.salePrice.toLocaleString("es-CO")}</div>
            )}
          </div>
        )))}
      </div>

      {isBusy && (
        <div className="fixed bottom-4 right-4 bg-white dark:bg-zinc-900 shadow-lg rounded-2xl p-3 flex items-center gap-2 print:hidden">
          <Spinner size="sm" />
          <span className="text-[10px] uppercase tracking-widest font-bold">Procesando…</span>
        </div>
      )}
    </div>
  );
}
