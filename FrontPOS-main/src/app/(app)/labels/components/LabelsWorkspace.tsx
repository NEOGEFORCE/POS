"use client";

// =============================================================================
// src/app/(app)/labels/components/LabelsWorkspace.tsx
//
// Workspace compartido entre `/labels` (etiquetas térmicas) y `/labels/shelf`
// (precios góndola). Encapsula el 100% de la lógica de catálogo:
//   - Carga de productos vía `/products/all-products`.
//   - Alta en cola idempotente contra `POST /labels/codes` (el flag `created`
//     se propaga a `QueueItem.created` para que el batch distinga `new` de
//     `reprint` en auditoría).
//   - Búsqueda textual + sugerencias.
//   - Lector por cámara (ScannerOverlay) y por lector USB (keyboard-wedge).
//   - Dos handlers de impresión mutuamente excluyentes:
//       · thermal: `handlePrint` → POST /labels/print-jobs → bridge.print(payload)
//         con `bridgePayload` enriquecido (connection + labels + labelItems).
//       · shelf: `handlePrintShelfSheet` → POST /labels/print-jobs
//         (`sizeTemplateId: null`, `meta.layout: gondola-80x40-letter-2x6`) →
//         iframe aislado con `@page Letter margin 0`.
//
// La invariante AUDIT-FIRST se mantiene: siempre registramos el lote en
// `/labels/print-jobs` ANTES de delegar al bridge o abrir el `print()`.
// La hoja de góndola es inmutable (Letter 2×6) y vive en `shelf-labels.mjs`;
// nunca la tocamos acá.
//
// Rutas que usan este workspace:
//   - `/labels/page.tsx`       → `<LabelsWorkspace mode="thermal" />`
//   - `/labels/shelf/page.tsx` → `<LabelsWorkspace mode="shelf" />`
//
// El sidebar linkea a `/labels/config` como entrada independiente — el
// botón "Configurar" dentro de este workspace es un atajo para admins pero
// no es la única puerta.
// =============================================================================

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Button, Chip, Input, Spinner, Tooltip } from "@heroui/react";
import {
    Barcode,
    DoorOpen,
    FileText,
    Minus,
    Plus as PlusIcon,
    Printer,
    RefreshCw,
    Scan,
    Search,
    Trash2,
} from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-error";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/auth-helpers.mjs";
import { labelBatchTriggerSource } from "@/lib/label-print-trigger.mjs";
import {
    buildBridgeConfigPayload,
    loadPrintingConfig,
} from "@/lib/printing-config.mjs";
import {
    buildAuditMeta,
    buildShelfLabelsPrintHtml,
    summarizeShelfLabels,
} from "@/lib/shelf-labels.mjs";
import { ShelfLabelsPreview } from "@/app/(app)/labels/components/ShelfLabelsPreview";

const ScannerOverlay = dynamic(
    () => import("@/components/ScannerOverlay").then((m) => m.ScannerOverlay),
    { ssr: false },
);

export type LabelsWorkspaceMode = "thermal" | "shelf";

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
     * derivar `triggerSource` del lote. Un re-click sobre un item nacido en
     * este batch sigue siendo "new"; si existía antes, sigue siendo
     * "reprint" para no camuflar reimpresiones.
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

interface LabelsWorkspaceProps {
    mode: LabelsWorkspaceMode;
}

export function LabelsWorkspace({ mode }: LabelsWorkspaceProps) {
    const { toast } = useToast();
    const { user } = useAuth();
    const isAdmin = isAdminUser(user);

    const [queue, setQueue] = useState<QueueItem[]>([]);
    const [query, setQuery] = useState("");
    const [scannerOpen, setScannerOpen] = useState(false);
    const [isBusy, setIsBusy] = useState(false);
    // Checkbox del flujo góndola: la cola se vacía DESPUÉS de invocar/cerrar
    // print(). Nunca antes: si el usuario cancela el diálogo del navegador
    // podría querer reintentar sin perder los items.
    const [clearQueueOnPrintClose, setClearQueueOnPrintClose] = useState(false);
    const [showShelfPreview, setShowShelfPreview] = useState(false);

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
    const defaultPrinter = printers.find((p) => p.isDefault) ?? printers[0] ?? null;
    const defaultSize = sizes.find((s) => s.isDefault) ?? sizes[0] ?? null;

    const findLocalProduct = useCallback(
        (barcode: string): Product | null => {
            const needle = barcode.trim().toUpperCase();
            return products.find((p) => (p.barcode || "").toUpperCase() === needle) ?? null;
        },
        [products],
    );

    const addToQueue = useCallback(
        async (barcode: string) => {
            const bc = barcode.trim();
            if (!bc) return;
            setIsBusy(true);
            try {
                const product = findLocalProduct(bc);
                // POST /labels/codes: si el producto ya tiene code, lo reutiliza
                // (idempotente). Si no, el backend genera uno nuevo validando colisión
                // contra TODOS los códigos existentes.
                const resp = await apiFetch<{ code: LabelCode; created: boolean }>(
                    "/labels/codes",
                    {
                        method: "POST",
                        body: JSON.stringify({ productBarcode: bc }),
                    },
                );
                if (!resp?.code) throw new Error("respuesta inválida del backend");
                setQueue((prev) => {
                    const existing = prev.findIndex((q) => q.code.code === resp.code.code);
                    if (existing >= 0) {
                        const copy = [...prev];
                        copy[existing] = {
                            ...copy[existing],
                            quantity: copy[existing].quantity + 1,
                        };
                        return copy;
                    }
                    return [
                        { code: resp.code, product, quantity: 1, created: !!resp.created },
                        ...prev,
                    ];
                });
                if (resp.created) {
                    toast({
                        variant: "default",
                        title: "CÓDIGO GENERADO",
                        description: resp.code.code,
                    });
                }
            } catch (e: any) {
                toast({
                    variant: "destructive",
                    title: "Error",
                    description: e?.message || "No se pudo generar el código",
                });
            } finally {
                setIsBusy(false);
                setQuery("");
            }
        },
        [findLocalProduct, toast],
    );

    const suggestions = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (q.length < 2) return [];
        return products
            .filter(
                (p) =>
                    (p.productName || "").toLowerCase().includes(q)
                    || (p.barcode || "").toLowerCase().includes(q),
            )
            .slice(0, 6);
    }, [products, query]);

    const handleInputKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter" && query.trim()) {
                e.preventDefault();
                void addToQueue(query.trim());
            }
        },
        [query, addToQueue],
    );

    const updateQuantity = (code: string, delta: number) => {
        setQueue((prev) =>
            prev.map((q) =>
                q.code.code === code
                    ? { ...q, quantity: Math.max(1, q.quantity + delta) }
                    : q,
            ),
        );
    };

    const removeFromQueue = (code: string) => {
        setQueue((prev) => prev.filter((q) => q.code.code !== code));
    };

    const totalLabels = queue.reduce((acc, q) => acc + q.quantity, 0);

    // -------------------------------------------------------------------------
    // Impresión térmica — modo "thermal".
    //
    // Preserva orden audit-first:
    //   1. POST /labels/print-jobs con items = [{code, quantity}] (contrato
    //      con el backend; nunca se enriquece).
    //   2. window.posBridge.print(bridgePayload) con el detalle (labelItems)
    //      + la config completa derivada de printing-config (connection,
    //      labels, drawer, activeMode) para que el bridge no tenga que leer
    //      LocalStorage.
    //   3. Fallback window.print() si no hay bridge disponible.
    // -------------------------------------------------------------------------
    const handlePrint = useCallback(async () => {
        if (queue.length === 0) return;
        setIsBusy(true);
        try {
            const triggerSource = labelBatchTriggerSource(queue.map((q) => q.created));
            const payload = {
                printerProfileId: defaultPrinter?.id ?? null,
                sizeTemplateId: defaultSize?.id ?? null,
                triggerSource,
                items: queue.map((q) => ({ code: q.code.code, quantity: q.quantity })),
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
            // Payload enriquecido para el bridge: connection + labels +
            // drawer + activeMode. `openDrawerOnSale=false` porque esta ruta
            // es manual (no auto-print post-venta): el cajón NUNCA se abre
            // por un trabajo de etiquetas.
            const printingConfig = loadPrintingConfig();
            const bridgeConfig = buildBridgeConfigPayload(printingConfig, {
                openDrawerOnSale: false,
            });
            const labelItems = queue.map((q) => ({
                code: q.code.code,
                quantity: q.quantity,
                productName:
                    q.product?.productName || q.code.productName || "ETIQUETA",
                salePrice:
                    typeof q.product?.salePrice === "number"
                        ? q.product.salePrice
                        : q.code.salePrice ?? 0,
            }));
            const bridgePayload = {
                ...payload,
                connection: printingConfig.connection,
                labels: printingConfig.labels,
                drawer: printingConfig.drawer,
                activeMode: printingConfig.activeMode,
                receipt: printingConfig.receipt,
                openDrawerOnSale: false,
                bridgeConfig,
                labelItems,
            };
            const w = window as any;
            if (w.posBridge?.print) {
                try {
                    await w.posBridge.print(bridgePayload);
                } catch {
                    window.print();
                }
            } else {
                window.print();
            }
            toast({
                variant: "default",
                title: "LOTE REGISTRADO",
                description: `${totalLabels} etiqueta(s) enviadas`,
            });
        } catch (e: any) {
            toast({
                variant: "destructive",
                title: "Error",
                description: e?.message || "No se pudo imprimir",
            });
        } finally {
            setIsBusy(false);
        }
    }, [queue, defaultPrinter, defaultSize, user, totalLabels, toast]);

    // -------------------------------------------------------------------------
    // Impresión hoja de góndola — modo "shelf" (Letter 2×6).
    //
    // Igual que el térmico, es AUDIT-FIRST: antes de generar el documento
    // aislado registramos el lote. El `sizeTemplateId: null` y `meta.layout:
    // gondola-80x40-letter-2x6` (vía `buildAuditMeta`) distinguen a este
    // lote de las etiquetas térmicas. La geometría del grid Letter 2×6
    // vive en `shelf-labels.mjs` y es inmutable.
    // -------------------------------------------------------------------------
    const shelfSummary = useMemo(
        () =>
            summarizeShelfLabels(
                queue.map((q) => ({
                    code: q.code.code,
                    productName:
                        q.product?.productName || q.code.productName || "ETIQUETA",
                    salePrice:
                        typeof q.product?.salePrice === "number"
                            ? q.product.salePrice
                            : q.code.salePrice ?? 0,
                    quantity: q.quantity,
                })),
            ),
        [queue],
    );

    const handlePrintShelfSheet = useCallback(async () => {
        if (queue.length === 0) return;
        setIsBusy(true);
        try {
            const triggerSource = labelBatchTriggerSource(queue.map((q) => q.created));
            const items = queue.map((q) => ({
                code: q.code.code,
                productName:
                    q.product?.productName || q.code.productName || "ETIQUETA",
                salePrice:
                    typeof q.product?.salePrice === "number"
                        ? q.product.salePrice
                        : q.code.salePrice ?? 0,
                quantity: q.quantity,
            }));
            // 1. Auditoría: `sizeTemplateId: null` + `meta.layout` canónico.
            const payload = {
                printerProfileId: defaultPrinter?.id ?? null,
                sizeTemplateId: null,
                triggerSource,
                items: queue.map((q) => ({ code: q.code.code, quantity: q.quantity })),
                meta: buildAuditMeta({
                    printedBy: user?.name || user?.dni || "",
                    printerName: defaultPrinter?.name || "navegador",
                    sheet: "letter-portrait",
                    sheetWidthMm: 215.9,
                    sheetHeightMm: 279.4,
                    labelWidthMm: 80,
                    labelHeightMm: 40,
                    totalLabels: shelfSummary.totalLabels,
                    totalPages: shelfSummary.totalPages,
                }),
            };
            await apiFetch("/labels/print-jobs", {
                method: "POST",
                body: JSON.stringify(payload),
            });

            // 2. Documento aislado en iframe con su propio @page Letter margin 0.
            const html = buildShelfLabelsPrintHtml(items, { now: new Date() });
            const iframe = document.createElement("iframe");
            iframe.setAttribute("aria-hidden", "true");
            iframe.setAttribute("title", "Impresión de etiquetas de góndola");
            iframe.setAttribute("scrolling", "no");
            iframe.style.position = "fixed";
            iframe.style.right = "0";
            iframe.style.bottom = "0";
            iframe.style.width = "0";
            iframe.style.height = "0";
            iframe.style.border = "0";
            iframe.style.opacity = "0";
            iframe.style.visibility = "hidden";
            iframe.style.overflow = "hidden";
            iframe.style.pointerEvents = "none";
            document.body.appendChild(iframe);
            const doc = iframe.contentWindow?.document;
            if (!doc) {
                document.body.removeChild(iframe);
                throw new Error("No se pudo crear el documento de impresión");
            }
            doc.open();
            doc.write(html);
            doc.close();

            const cleanup = () => {
                // Limpieza DESPUÉS de iframe.print(): nunca antes, para no
                // perder la cola si el usuario cancela el diálogo del navegador.
                try {
                    if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
                } catch {
                    /* el nodo ya fue removido */
                }
                if (clearQueueOnPrintClose) {
                    setQueue([]);
                }
            };

            const fire = () => {
                try {
                    iframe.contentWindow?.focus();
                    iframe.contentWindow?.print();
                } finally {
                    setTimeout(cleanup, 500);
                }
            };
            if (iframe.contentWindow?.document.readyState === "complete") fire();
            else iframe.onload = fire;

            toast({
                variant: "default",
                title: "HOJA DE GÓNDOLA ENVIADA",
                description: `${shelfSummary.totalLabels} etiqueta(s) · ${shelfSummary.totalPages} página(s)`,
            });
        } catch (e: any) {
            toast({
                variant: "destructive",
                title: "Error",
                description: e?.message || "No se pudo imprimir la hoja",
            });
        } finally {
            setIsBusy(false);
        }
    }, [queue, defaultPrinter, user, shelfSummary, clearQueueOnPrintClose, toast]);

    // -------------------------------------------------------------------------
    // Apertura manual del cajón — compartida entre ambos modos.
    //
    // Siempre audit-first. Enriquecemos el payload del bridge con
    // connection + drawer para que el bridge sepa a qué impresora enviar
    // el pulso ESC/POS sin leer LocalStorage por su cuenta. Reimpresión y
    // auto-print no pasan por acá; esta ruta es exclusivamente manual.
    // -------------------------------------------------------------------------
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
                try {
                    const printingConfig = loadPrintingConfig();
                    await w.posBridge.kickDrawer({
                        printerProfileId: defaultPrinter?.id ?? null,
                        command: printingConfig.drawer.command,
                        event: printingConfig.drawer.event,
                        connection: printingConfig.connection,
                        drawer: printingConfig.drawer,
                    });
                } catch {
                    /* ignorar: la auditoría ya quedó */
                }
            }
            toast({
                variant: "default",
                title: "CAJÓN AUTORIZADO",
                description: "Si no se abrió físicamente, verifica el bridge local.",
            });
        } catch (e: any) {
            const msg = e?.message || "No se pudo abrir el cajón";
            toast({ variant: "destructive", title: "BLOQUEADO", description: msg });
        }
    }, [isAdmin, defaultPrinter, toast]);

    // -------------------------------------------------------------------------
    // Renderizado
    // -------------------------------------------------------------------------

    const headerTitle = mode === "thermal" ? "Etiquetas térmicas" : "Precios de góndola";
    const headerSubtitle =
        mode === "thermal"
            ? `Generador térmico · ${products.length} productos cargados`
            : `Hoja Letter 2×6 · ${products.length} productos cargados`;

    return (
        <div
            className="flex flex-col min-h-screen gap-2 p-2 bg-gray-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50 transition-colors duration-500 pb-24"
            data-labels-workspace-mode={mode}
        >
            <style
                dangerouslySetInnerHTML={{
                    __html: `
          @media print {
            @page { margin: 0.4cm; }
            body { -webkit-print-color-adjust: exact; background: white !important; }
            .print\\:hidden { display: none !important; }
            .print\\:show { display: block !important; }
          }
        `,
                }}
            />

            <header className="flex items-center justify-between gap-2 p-3 bg-white dark:bg-zinc-900 rounded-2xl shadow-sm print:hidden">
                <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
                        <Barcode size={18} />
                    </div>
                    <div>
                        <h1 className="text-sm font-bold uppercase tracking-widest">{headerTitle}</h1>
                        <p className="text-[9px] uppercase tracking-widest text-zinc-500">
                            {headerSubtitle}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Tooltip
                        content={isAdmin ? "Abrir cajón (admin)" : "Sólo con venta reciente"}
                    >
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
                            onPress={() => {
                                if (typeof window !== "undefined")
                                    window.location.href = "/labels/config";
                            }}
                            className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
                        >
                            Configurar
                        </Button>
                    )}
                    {mode === "thermal" && (
                        <Button
                            size="sm"
                            color="success"
                            isDisabled={queue.length === 0 || isBusy}
                            onPress={handlePrint}
                            startContent={<Printer size={14} />}
                            className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
                            data-testid="labels-thermal-print-btn"
                            aria-label="Imprimir etiquetas térmicas"
                        >
                            Térmica ({totalLabels})
                        </Button>
                    )}
                    {mode === "shelf" && (
                        <Button
                            size="sm"
                            color="primary"
                            variant="flat"
                            isDisabled={queue.length === 0 || isBusy}
                            onPress={handlePrintShelfSheet}
                            startContent={<FileText size={14} />}
                            className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
                            data-testid="labels-shelf-print-btn"
                            aria-label="Imprimir hoja de góndola en papel Letter"
                        >
                            Hoja góndola ({shelfSummary.totalPages})
                        </Button>
                    )}
                </div>
            </header>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-2 print:hidden">
                {/* Columna 1: búsqueda + escáner */}
                <section className="lg:col-span-5 flex flex-col gap-2">
                    <div className="p-3 bg-white dark:bg-zinc-900 rounded-2xl shadow-sm">
                        <div className="flex items-center gap-2 mb-2">
                            <Search size={14} />
                            <h2 className="text-[10px] uppercase tracking-widest font-bold">
                                Buscar producto
                            </h2>
                        </div>
                        <Input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
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
                                onPress={() => {
                                    setQuery("");
                                }}
                                className="rounded-2xl"
                                aria-label="Limpiar búsqueda"
                            >
                                <RefreshCw size={14} />
                            </Button>
                        </div>

                        {suggestions.length > 0 && (
                            <div className="mt-3 space-y-1 max-h-80 overflow-auto">
                                {suggestions.map((p) => (
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
                        <p className="font-bold uppercase tracking-widest text-amber-700 dark:text-amber-400 mb-1">
                            Capacidades reales
                        </p>
                        <ul className="list-disc pl-4 space-y-1 text-zinc-700 dark:text-zinc-300">
                            <li>El navegador NO controla directamente impresoras USB ni el cajón.</li>
                            <li>Con bridge local (scale-bridge o similar) se envía el pulso ESC/POS real.</li>
                            <li>Sin bridge, Imprimir usa el diálogo del navegador y &quot;Abrir cajón&quot; sólo audita.</li>
                            {!defaultPrinter && (
                                <li className="font-bold text-amber-700 dark:text-amber-400">
                                    No hay impresora configurada. Admin → &quot;Configurar&quot;.
                                </li>
                            )}
                        </ul>
                    </div>
                </section>

                {/* Columna 2: cola de impresión */}
                <section className="lg:col-span-7 p-3 bg-white dark:bg-zinc-900 rounded-2xl shadow-sm">
                    <div className="flex items-center justify-between gap-2 mb-3">
                        <h2 className="text-[10px] uppercase tracking-widest font-bold">
                            Cola de impresión · {queue.length}
                        </h2>
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
                            <p className="text-xs uppercase tracking-widest">
                                Agrega productos para imprimir
                            </p>
                        </div>
                    ) : (
                        <ul className="space-y-2 max-h-[60vh] overflow-auto">
                            {queue.map((item) => (
                                <li
                                    key={item.code.code}
                                    data-queue-code={item.code.code}
                                    className="flex items-center gap-3 p-2 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-white/5"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="text-xs font-bold truncate">
                                            {item.product?.productName
                                                || item.code.productName
                                                || "Etiqueta libre"}
                                        </p>
                                        <p className="text-[9px] font-mono text-zinc-500 truncate">
                                            {item.code.code}
                                            {item.code.printCount != null && item.code.printCount > 0
                                                ? ` · ${item.code.printCount} prints`
                                                : ""}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Button
                                            isIconOnly
                                            size="sm"
                                            variant="flat"
                                            className="rounded-xl"
                                            aria-label="menos"
                                            onPress={() => updateQuantity(item.code.code, -1)}
                                        >
                                            <Minus size={12} />
                                        </Button>
                                        <span className="text-xs font-bold w-8 text-center tabular-nums">
                                            {item.quantity}
                                        </span>
                                        <Button
                                            isIconOnly
                                            size="sm"
                                            variant="flat"
                                            className="rounded-xl"
                                            aria-label="más"
                                            onPress={() => updateQuantity(item.code.code, 1)}
                                        >
                                            <PlusIcon size={12} />
                                        </Button>
                                        <Button
                                            isIconOnly
                                            size="sm"
                                            variant="light"
                                            color="danger"
                                            className="rounded-xl ml-1"
                                            aria-label="quitar"
                                            onPress={() => removeFromQueue(item.code.code)}
                                        >
                                            <Trash2 size={12} />
                                        </Button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}

                    {/* Resumen contable + checkbox — SOLO modo shelf.
                        Formato exigido por el contrato de góndola:
                          "X etiquetas en cola (Y páginas completas + Z sobrantes)"
                        + total de páginas. */}
                    {mode === "shelf" && queue.length > 0 && (
                        <div
                            className="mt-4 pt-4 border-t border-zinc-200 dark:border-white/5 flex flex-col gap-3"
                            data-testid="labels-shelf-summary"
                        >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <p
                                    className="text-[11px] uppercase tracking-widest font-bold text-zinc-700 dark:text-zinc-200"
                                    data-testid="labels-shelf-counter"
                                    aria-live="polite"
                                >
                                    {`${shelfSummary.totalLabels} etiquetas en cola (${shelfSummary.fullPages} páginas completas + ${shelfSummary.remainder} sobrantes)`}
                                </p>
                                <Chip size="sm" variant="flat" className="rounded-xl">
                                    {shelfSummary.totalPages} página(s)
                                </Chip>
                            </div>
                            <label
                                className="flex items-center gap-2 text-[11px] text-zinc-700 dark:text-zinc-200 cursor-pointer select-none"
                                htmlFor="clear-queue-on-print-close"
                            >
                                <Checkbox
                                    id="clear-queue-on-print-close"
                                    data-testid="labels-clear-on-close-checkbox"
                                    checked={clearQueueOnPrintClose}
                                    onCheckedChange={(v) =>
                                        setClearQueueOnPrintClose(v === true)
                                    }
                                    aria-label="Limpiar cola al cerrar impresión"
                                />
                                <span>Limpiar cola al cerrar impresión</span>
                            </label>
                            <div className="flex items-center justify-between gap-2">
                                <Button
                                    size="sm"
                                    variant="light"
                                    onPress={() => setShowShelfPreview((v) => !v)}
                                    className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
                                    aria-expanded={showShelfPreview}
                                    aria-controls="labels-shelf-preview-region"
                                >
                                    {showShelfPreview
                                        ? "Ocultar vista previa"
                                        : "Ver vista previa"}
                                </Button>
                                <span className="text-[9px] uppercase tracking-widest text-zinc-500">
                                    Hoja Letter · 80mm × 40mm · grid 2×6
                                </span>
                            </div>
                            {showShelfPreview && (
                                <div
                                    id="labels-shelf-preview-region"
                                    className="pt-2 max-h-[480px] overflow-auto rounded-xl bg-zinc-100 dark:bg-zinc-800/40 p-3"
                                    role="region"
                                    aria-label="Vista previa paginada de la hoja de góndola"
                                >
                                    <ShelfLabelsPreview
                                        items={queue.map((q) => ({
                                            code: q.code.code,
                                            productName:
                                                q.product?.productName
                                                || q.code.productName
                                                || "ETIQUETA",
                                            salePrice:
                                                typeof q.product?.salePrice === "number"
                                                    ? q.product.salePrice
                                                    : q.code.salePrice ?? 0,
                                            quantity: q.quantity,
                                        }))}
                                        scale={0.4}
                                    />
                                </div>
                            )}
                        </div>
                    )}
                </section>
            </div>

            {/* Scanner por cámara. */}
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

            {/* Área imprimible fallback para el modo térmico (window.print). */}
            {mode === "thermal" && (
                <div className="hidden print:show bg-white w-full">
                    {queue.flatMap((q) =>
                        Array.from({ length: q.quantity }).map((_, idx) => (
                            <div key={`${q.code.code}-${idx}`} className="print-label">
                                <div style={{ fontSize: 10, fontWeight: 700 }}>
                                    {q.product?.productName
                                        || q.code.productName
                                        || "Etiqueta"}
                                </div>
                                <div style={{ fontFamily: "monospace", fontSize: 12 }}>
                                    {q.code.code}
                                </div>
                                {typeof q.product?.salePrice === "number" && (
                                    <div style={{ fontSize: 11 }}>
                                        ${q.product.salePrice.toLocaleString("es-CO")}
                                    </div>
                                )}
                            </div>
                        )),
                    )}
                </div>
            )}

            {isBusy && (
                <div className="fixed bottom-4 right-4 bg-white dark:bg-zinc-900 shadow-lg rounded-2xl p-3 flex items-center gap-2 print:hidden">
                    <Spinner size="sm" />
                    <span className="text-[10px] uppercase tracking-widest font-bold">
                        Procesando…
                    </span>
                </div>
            )}
        </div>
    );
}

export default LabelsWorkspace;
