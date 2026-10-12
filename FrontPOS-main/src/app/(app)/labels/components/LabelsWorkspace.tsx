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
//         (`sizeTemplateId: null`, `meta.layout` derivado del formato activo
//         en `gondola.format`: `gondola-80x40-letter-landscape-3x5` o
//         `gondola-80x40-legal-landscape-4x5`) → iframe aislado con
//         `@page { size: Letter|Legal landscape; margin: 0 }` que se
//         imprime EXCLUSIVAMENTE con `iframe.contentWindow.print()`
//         (diálogo normal del navegador). Nunca se usa el bridge térmico
//         ni se abre el cajón para góndola.
//
// La invariante AUDIT-FIRST se mantiene: siempre registramos el lote en
// `/labels/print-jobs` ANTES de delegar al bridge o abrir el `print()`.
// La geometría de la hoja de góndola vive en `shelf-labels.mjs` y se
// resuelve dinámicamente desde el formato persistido en
// `printing-config.mjs` → `gondola.format`.
//
// Rutas que usan este workspace:
//   - `/labels/page.tsx`       → `<LabelsWorkspace mode="thermal" />`
//   - `/labels/shelf/page.tsx` → `<LabelsWorkspace mode="shelf" />`
//
// El sidebar linkea a `/labels/config` como entrada independiente — el
// botón "Configurar" dentro de este workspace es un atajo para admins pero
// no es la única puerta.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Button, Chip, Input, Spinner } from "@heroui/react";
import {
    Barcode,
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
    load as loadPersistentQueue,
    remove as removePersistentEntry,
    updateQuantity as persistentUpdateQuantity,
    QUEUE_STORAGE_KEY as PERSISTENT_QUEUE_KEY,
    QUEUE_REASONS as PERSISTENT_QUEUE_REASONS,
} from "@/lib/label-print-queue.mjs";
import type { LabelQueueEntry } from "@/lib/label-print-queue.d.mts";
import {
    buildBridgeConfigPayload,
    loadPrintingConfig,
} from "@/lib/printing-config.mjs";
import type { GondolaFormat } from "@/lib/printing-config.d.mts";
import {
    buildAuditMeta,
    buildShelfLabelsPrintHtml,
    resolveGondolaLayout,
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
    /**
     * Cantidad TOTAL mostrada en la cola = `persistentQuantity + manualQuantity`.
     * Deriva de los dos componentes y se mantiene sincronizada por el
     * reducer `recomputeQuantity`.
     */
    quantity: number;
    /**
     * Cantidad proveniente de la cola persistente (localStorage). SOLO
     * esta porción se escribe de vuelta al storage al editar; la porción
     * `manualQuantity` nunca contamina el storage.
     */
    persistentQuantity: number;
    /**
     * Cantidad añadida manualmente por el workspace (escaneo, búsqueda,
     * +1). Al descartar/limpiar/completar la fila persistente, esta
     * porción se preserva en memoria.
     */
    manualQuantity: number;
    /**
     * `true` cuando `POST /labels/codes` creó el code en esta sesión;
     * `false` cuando reutilizó uno existente (idempotencia). Se usa para
     * derivar `triggerSource` del lote. Un re-click sobre un item nacido en
     * este batch sigue siendo "new"; si existía antes, sigue siendo
     * "reprint" para no camuflar reimpresiones.
     */
    created: boolean;
    /**
     * Origen de la entrada:
     *   - 'manual'    → sin componente persistente — todo manualQuantity.
     *   - 'persistent'→ tiene componente persistente activo
     *     (persistentQuantity > 0). Al imprimir, la porción persistente
     *     se elimina del storage; la porción manual (si existe) sobrevive
     *     y la fila queda convertida a 'manual' tras limpiarse la parte
     *     persistente.
     *   - Al descartar/limpiar/completar la porción persistente, la fila
     *     NO desaparece si manualQuantity > 0: se queda en memoria como
     *     'manual' con la cantidad manual intacta.
     */
    source: 'manual' | 'persistent';
    /** ID canónico en storage. Solo presente cuando source === 'persistent'. */
    persistentId?: string;
    /** Motivo persistente (sólo PRICE_CHANGE). Solo persistent. */
    reason?: string;
    /** Precio viejo (antes del cambio). Solo persistent. */
    oldSalePrice?: number;
    /** Nuevo precio (snapshot en el momento del enqueue). Solo persistent. */
    persistentSalePrice?: number;
    /** Ref de recepción origen. Solo persistent. */
    receptionRef?: string;
    /**
     * Barcode canónico (product-level) usado para fusionar manuales y
     * persistentes por MISMO BARCODE. Se persiste en memoria independiente
     * de `code.code` porque el backend puede devolver code === barcode o
     * un code distinto; la fusión debe ser por producto, no por code.
     */
    productBarcode: string;
    /**
     * Error de resolución en /labels/codes para esta entrada persistente.
     * Si está presente, pintamos un badge y permitimos reintento manual.
     */
    resolveError?: string;
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

    // Formato de hoja de góndola (Carta / Oficio). Se hidrata desde la
    // config persistida (`pos_printing_config_v1 → gondola.format`) al
    // montar y se refresca cuando otro tab la cambia (`storage` event). El
    // workspace NUNCA llama al bridge para góndola: el formato sólo altera
    // la geometría del documento aislado que va al diálogo del navegador.
    const [gondolaFormat, setGondolaFormat] = useState<GondolaFormat>("LETTER");
    useEffect(() => {
        if (typeof window === "undefined") return;
        const hydrate = () => {
            try {
                const cfg = loadPrintingConfig();
                setGondolaFormat(cfg.gondola?.format ?? "LETTER");
            } catch {
                setGondolaFormat("LETTER");
            }
        };
        hydrate();
        const onStorage = (ev: StorageEvent) => {
            if (!ev.key || ev.key === "pos_printing_config_v1") hydrate();
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);

    const gondolaLayout = useMemo(
        () => resolveGondolaLayout(gondolaFormat),
        [gondolaFormat],
    );

    // -------------------------------------------------------------------------
    // Hidratación de la cola PERSISTENTE (ver src/lib/label-print-queue.mjs).
    //
    // Al montar y cada vez que otro tab modifique
    // `pos_label_print_queue_v1`, cargamos las entradas canónicas (shape:
    // { id, productBarcode, salePrice, newSalePrice, oldSalePrice,
    //   queuedAt, receptionRef, reason: 'PRICE_CHANGE', quantity }),
    // resolvemos su `code` canónico vía POST /labels/codes (idempotente) y
    // las fusionamos con la cola local manteniendo:
    //   - El `source: 'persistent'` cuando la porción persistente > 0; al
    //     imprimir eliminamos la entrada de storage. Si manualQuantity>0,
    //     la fila sobrevive como 'manual' con esa porción.
    //   - La `persistentQuantity` del storage (fuente autoritativa de la
    //     cantidad persistida; no se le suma nada por hidratación).
    //   - La `manualQuantity` acumulada por el usuario en el workspace
    //     (escaneo, +1). Se PRESERVA siempre que haya un match por
    //     MISMO BARCODE (product-level), no sólo por `code.code`.
    //   - Errores de resolución en `resolveError` para que la UI pueda
    //     pintar el badge y el botón "Reintentar".
    //
    // Esta rutina NUNCA borra entradas de storage: la limpieza se hace
    // sólo después de audit + print exitoso en el handler.
    //
    // Guard anti-reentrancy + pending re-run: si llega un `storage` event
    // mientras una hidratación está en curso, marcamos la bandera
    // `hydrationPendingRef` para disparar otra ronda al terminar — así no
    // se pierden eventos durante vuelos en progreso.
    // -------------------------------------------------------------------------
    const hydrationInFlightRef = useRef(false);
    const hydrationPendingRef = useRef(false);
    const hydratePersistentQueue = useCallback(async () => {
        if (typeof window === "undefined") return;
        if (hydrationInFlightRef.current) {
            // Un storage event llegó durante hidratación: marcamos pending
            // para re-ejecutar al terminar y no perder el evento.
            hydrationPendingRef.current = true;
            return;
        }
        hydrationInFlightRef.current = true;
        try {
            const persistent = loadPersistentQueue(window.localStorage);
            if (persistent.length === 0) {
                // No hay nada persistido: desactivamos la porción persistente
                // de las filas actuales. Si quedaba manualQuantity>0, la fila
                // sobrevive como 'manual'; si no, se descarta.
                setQueue((prev) =>
                    prev
                        .map((q) =>
                            q.source === "persistent"
                                ? {
                                      ...q,
                                      source: "manual" as const,
                                      persistentId: undefined,
                                      persistentQuantity: 0,
                                      reason: undefined,
                                      oldSalePrice: undefined,
                                      persistentSalePrice: undefined,
                                      receptionRef: undefined,
                                      resolveError: undefined,
                                      quantity: q.manualQuantity,
                                  }
                                : q,
                        )
                        .filter((q) => q.quantity > 0),
                );
                return;
            }
            // Resolver cada entrada contra /labels/codes. Idempotente —
            // conserva errores por entrada para que el workspace pinte el
            // badge y permita reintento.
            const resolved = await Promise.all(
                persistent.map(async (entry: LabelQueueEntry) => {
                    try {
                        const resp = await apiFetch<{ code: LabelCode; created: boolean }>(
                            "/labels/codes",
                            {
                                method: "POST",
                                body: JSON.stringify({ productBarcode: entry.productBarcode }),
                            },
                        );
                        if (!resp?.code) {
                            return { entry, error: "respuesta inválida del backend" };
                        }
                        return { entry, resp };
                    } catch (err: any) {
                        return {
                            entry,
                            error: err?.message || "No se pudo resolver el código",
                        };
                    }
                }),
            );
            // IMPORTANTE: construimos el próximo estado FUERA del setQueue
            // updater (sin side effects dentro del reducer de React). El
            // updater sólo hace el merge con la cola previa.
            setQueue((prev) => {
                // Index previo por productBarcode (clave canónica para la
                // fusión por MISMO BARCODE a nivel producto). Buscamos
                // tanto en entradas marcadas como persistentes (para
                // actualizar su persistentQuantity) como en manuales (para
                // adoptarlas en una nueva fila fusionada).
                const prevByBarcode = new Map<string, QueueItem>();
                for (const q of prev) {
                    const key = (q.productBarcode || q.code.productBarcode || "").toUpperCase();
                    if (key) prevByBarcode.set(key, q);
                }
                const nextByBarcode = new Map<string, QueueItem>();
                for (const item of resolved) {
                    const entry = item.entry;
                    const bc = (entry.productBarcode || "").toUpperCase();
                    const existing = prevByBarcode.get(bc);
                    const manualQuantity = existing?.manualQuantity ?? 0;
                    const persistentQuantity = entry.quantity;
                    if ("error" in item && item.error) {
                        // Fallback: entrada con error. La mantenemos para
                        // que el usuario pueda reintentar. Usamos un
                        // placeholder como "code.code" temporal para la
                        // fila (no se envía nunca al audit si no se
                        // resuelve).
                        nextByBarcode.set(bc, {
                            code: {
                                code: `__pending__${entry.id}`,
                                productBarcode: bc,
                                productName: entry.productName,
                                salePrice: entry.salePrice,
                            },
                            product: existing?.product ?? null,
                            quantity: persistentQuantity + manualQuantity,
                            persistentQuantity,
                            manualQuantity,
                            created: false,
                            source: "persistent",
                            persistentId: entry.id,
                            reason: entry.reason,
                            oldSalePrice: entry.oldSalePrice,
                            persistentSalePrice: entry.newSalePrice,
                            receptionRef: entry.receptionRef,
                            productBarcode: bc,
                            resolveError: item.error,
                        });
                        continue;
                    }
                    const resp = (item as { resp: { code: LabelCode; created: boolean } }).resp;
                    nextByBarcode.set(bc, {
                        code: {
                            ...resp.code,
                            salePrice:
                                typeof resp.code.salePrice === "number"
                                    ? resp.code.salePrice
                                    : entry.newSalePrice,
                            productName:
                                resp.code.productName || entry.productName,
                        },
                        product: existing?.product ?? null,
                        quantity: persistentQuantity + manualQuantity,
                        persistentQuantity,
                        manualQuantity,
                        created: !!resp.created,
                        source: "persistent",
                        persistentId: entry.id,
                        reason: entry.reason,
                        oldSalePrice: entry.oldSalePrice,
                        persistentSalePrice: entry.newSalePrice,
                        receptionRef: entry.receptionRef,
                        productBarcode: bc,
                    });
                }
                // Manuales previas que NO coincidieron con ninguna
                // persistente nueva: se conservan tal cual.
                const persistentManualPreserved: QueueItem[] = [];
                for (const q of prev) {
                    const key = (q.productBarcode || q.code.productBarcode || "").toUpperCase();
                    if (!key) continue;
                    if (nextByBarcode.has(key)) continue;
                    if (q.source === "manual") {
                        // Manual sin match persistente: preservar tal cual.
                        persistentManualPreserved.push(q);
                        continue;
                    }
                    // Fila que ERA persistente y ya no está en storage:
                    // conservar la porción manual si existe.
                    if (q.manualQuantity > 0) {
                        persistentManualPreserved.push({
                            ...q,
                            source: "manual",
                            persistentId: undefined,
                            persistentQuantity: 0,
                            reason: undefined,
                            oldSalePrice: undefined,
                            persistentSalePrice: undefined,
                            receptionRef: undefined,
                            resolveError: undefined,
                            quantity: q.manualQuantity,
                        });
                    }
                }
                // Orden determinista: primero persistent (orden FIFO del
                // storage, dado por `resolved`), luego manual.
                const persistentList = Array.from(nextByBarcode.values());
                return [...persistentList, ...persistentManualPreserved];
            });
        } finally {
            hydrationInFlightRef.current = false;
            // Si llegó un storage event durante el vuelo, re-ejecutamos.
            if (hydrationPendingRef.current) {
                hydrationPendingRef.current = false;
                void hydratePersistentQueue();
            }
        }
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") return;
        void hydratePersistentQueue();
        const onStorage = (ev: StorageEvent) => {
            if (!ev.key || ev.key === PERSISTENT_QUEUE_KEY) {
                void hydratePersistentQueue();
            }
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, [hydratePersistentQueue]);

    const discardPersistentEntry = useCallback((persistentId: string) => {
        if (!persistentId || typeof window === "undefined") return;
        // Side effect de storage FUERA del updater de setState: así React
        // puede re-ejecutar el updater en Strict Mode sin disparar
        // múltiples removeItem (contrato: no side effects dentro del
        // reducer).
        removePersistentEntry(window.localStorage, persistentId);
        setQueue((prev) =>
            prev
                .map((q) => {
                    if (q.persistentId !== persistentId) return q;
                    // Si la fila tenía porción manual añadida por el
                    // usuario, la fila sobrevive como 'manual' con esa
                    // cantidad. Si no, cae a 0 y se filtra.
                    const manual = q.manualQuantity;
                    return {
                        ...q,
                        source: "manual" as const,
                        persistentId: undefined,
                        persistentQuantity: 0,
                        reason: undefined,
                        oldSalePrice: undefined,
                        persistentSalePrice: undefined,
                        receptionRef: undefined,
                        resolveError: undefined,
                        manualQuantity: manual,
                        quantity: manual,
                    };
                })
                .filter((q) => q.quantity > 0),
        );
    }, []);

    const retryPersistentEntry = useCallback(
        async (persistentId: string) => {
            if (!persistentId || typeof window === "undefined") return;
            await hydratePersistentQueue();
        },
        [hydratePersistentQueue],
    );

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
                const resolvedBarcode = (
                    resp.code.productBarcode || bc
                ).toUpperCase();
                setQueue((prev) => {
                    // FUSIÓN POR MISMO BARCODE (nivel producto). No basta
                    // con `code.code` porque la cola persistente usa el
                    // placeholder `__pending__{id}` para entradas sin
                    // resolver, y porque los códigos derivados pueden
                    // cambiar. El pivote es `productBarcode`.
                    const existing = prev.findIndex(
                        (q) =>
                            (q.productBarcode || q.code.productBarcode || "")
                                .toUpperCase() === resolvedBarcode,
                    );
                    if (existing >= 0) {
                        const copy = [...prev];
                        const current = copy[existing];
                        // Sumamos 1 a la porción MANUAL: la porción
                        // persistente nunca se infla por escaneo (sigue
                        // reflejando lo acordado en recepción).
                        const nextManual = current.manualQuantity + 1;
                        copy[existing] = {
                            ...current,
                            code: {
                                ...current.code,
                                // Si estábamos en placeholder, adoptamos
                                // el code real que acabamos de resolver.
                                ...resp.code,
                            },
                            manualQuantity: nextManual,
                            quantity: current.persistentQuantity + nextManual,
                            product: current.product ?? product,
                        };
                        return copy;
                    }
                    return [
                        {
                            code: resp.code,
                            product,
                            quantity: 1,
                            persistentQuantity: 0,
                            manualQuantity: 1,
                            created: !!resp.created,
                            source: "manual" as const,
                            productBarcode: resolvedBarcode,
                        },
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

    // La cantidad editable de una entrada persistente modifica su porción
    // persistida y se escribe antes de actualizar React. La porción manual
    // fusionada permanece independiente y no contamina localStorage.
    const updateQuantity = useCallback((code: string, delta: number) => {
        const target = queue.find((item) => item.code.code === code);
        if (!target) return;

        if (target.source === "persistent" && target.persistentId) {
            const nextPersistent = Math.max(1, target.persistentQuantity + delta);
            if (nextPersistent === target.persistentQuantity) return;
            if (typeof window !== "undefined") {
                persistentUpdateQuantity(
                    window.localStorage,
                    target.persistentId,
                    nextPersistent,
                );
            }
            setQueue((prev) =>
                prev.map((item) =>
                    item.persistentId === target.persistentId
                        ? {
                              ...item,
                              persistentQuantity: nextPersistent,
                              quantity: nextPersistent + item.manualQuantity,
                          }
                        : item,
                ),
            );
            return;
        }

        const nextManual = Math.max(1, target.manualQuantity + delta);
        setQueue((prev) =>
            prev.map((item) =>
                item.code.code === code && item.source === "manual"
                    ? {
                          ...item,
                          manualQuantity: nextManual,
                          quantity: nextManual,
                      }
                    : item,
            ),
        );
    }, [queue]);

    const removeFromQueue = useCallback((code: string) => {
        setQueue((prev) => prev.filter((q) => q.code.code !== code));
    }, []);

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
        // AUDIT-FIRST: si alguna entrada persistente no se pudo resolver
        // en /labels/codes, se queda en pantalla con badge rojo y no se
        // envía al lote. Bloquear aquí antes de computar los payloads
        // mantiene las referencias `queue.map(q => ...)` intactas con el
        // contrato de los tests estáticos.
        if (queue.some((q) => q.resolveError)) {
            toast({
                variant: "destructive",
                title: "Resuelve los errores antes de imprimir",
                description:
                    "Hay entradas pendientes en la cola con error. Pulsa Reintentar en cada una o descártala.",
            });
            return;
        }
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
            // 1. AUDIT PRIMERO. Si falla, conservamos la cola intacta y
            //    salimos — nada se borra del storage persistente.
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
                    q.source === "persistent"
                    && typeof q.persistentSalePrice === "number"
                        ? q.persistentSalePrice
                        : typeof q.product?.salePrice === "number"
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
            // 2. ENVÍO: bridge si está disponible, si no fallback a
            //    window.print(). printInvoked=true requiere que al menos
            //    una de las dos vías haya corrido sin lanzar.
            const w = window as any;
            let printInvoked = false;
            if (w.posBridge?.print) {
                try {
                    await w.posBridge.print(bridgePayload);
                    printInvoked = true;
                } catch {
                    try {
                        window.print();
                        printInvoked = true;
                    } catch {
                        printInvoked = false;
                    }
                }
            } else {
                try {
                    window.print();
                    printInvoked = true;
                } catch {
                    printInvoked = false;
                }
            }
            // Si NO se logró invocar el envío físico (bridge rechazó y
            // window.print lanzó), NO limpiamos la cola, NO borramos
            // persistentes y NO mostramos éxito. El usuario reintenta.
            if (!printInvoked) {
                toast({
                    variant: "destructive",
                    title: "No se pudo imprimir",
                    description:
                        "El bridge local y el diálogo del navegador fallaron. La cola se conserva para reintento.",
                });
                return;
            }
            // 3. LIMPIEZA DE STORAGE: SOLO los persistentIds incluidos en
            //    este lote se eliminan del storage. Las porciones MANUAL
            //    fusionadas en esas mismas filas sobreviven en memoria
            //    como entradas 'manual' standalone (contrato: no perder
            //    la porción manual al descartar/limpiar/completar la
            //    persistente). Las entradas MANUALES puras tampoco se
            //    tocan automáticamente — "Vaciar" las limpia por aparte.
            if (printInvoked && typeof window !== "undefined") {
                const persistentIdsPrinted = queue
                    .filter((q) => q.source === "persistent" && q.persistentId)
                    .map((q) => q.persistentId as string);
                // Side effect de storage FUERA del updater: una pasada
                // por id, antes del reducer de React.
                for (const pid of persistentIdsPrinted) {
                    removePersistentEntry(window.localStorage, pid);
                }
                setQueue((prev) =>
                    prev
                        .map((q) => {
                            if (
                                q.source === "persistent"
                                && q.persistentId
                                && persistentIdsPrinted.includes(q.persistentId)
                            ) {
                                // Transformamos a 'manual' preservando la
                                // porción manual fusionada; si no hay
                                // porción manual, el filter de abajo la quita.
                                const manual = q.manualQuantity;
                                return {
                                    ...q,
                                    source: "manual" as const,
                                    persistentId: undefined,
                                    persistentQuantity: 0,
                                    reason: undefined,
                                    oldSalePrice: undefined,
                                    persistentSalePrice: undefined,
                                    receptionRef: undefined,
                                    resolveError: undefined,
                                    manualQuantity: manual,
                                    quantity: manual,
                                };
                            }
                            return q;
                        })
                        .filter((q) => q.quantity > 0),
                );
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
    // Impresión hoja de góndola — modo "shelf".
    //
    // El formato activo (LETTER u OFICIO/LEGAL) se resuelve en runtime
    // desde `gondolaFormat`, hidratado desde `pos_printing_config_v1 →
    // gondola.format` por `loadPrintingConfig()`. El default es LETTER.
    //
    // Igual que el térmico, es AUDIT-FIRST: antes de generar el documento
    // aislado registramos el lote. El `sizeTemplateId: null` y el
    // `meta.layout` canónico (vía `buildAuditMeta`) distinguen a este
    // lote de las etiquetas térmicas. Los dos ids posibles son
    // `gondola-80x40-letter-landscape-3x5` y
    // `gondola-80x40-legal-landscape-4x5`.
    //
    // La geometría (dimensiones de página, grid, padding centrado y
    // capacidad) la impone `resolveGondolaLayout(format)` en
    // `shelf-labels.mjs`: no está fija y no se duplica en el caller.
    // -------------------------------------------------------------------------
    // El resumen contable usa el precio PERSISTIDO cuando viene de una
    // entrada tras cambio en recepción (`persistentSalePrice`), de forma
    // que la hoja de góndola refleje el PRECIO NUEVO. Para entradas
    // manuales usamos el salePrice del producto o del code en ese orden.
    const shelfPriceOf = useCallback((q: QueueItem): number => {
        if (q.source === "persistent" && typeof q.persistentSalePrice === "number") {
            return q.persistentSalePrice;
        }
        if (typeof q.product?.salePrice === "number") return q.product.salePrice;
        return q.code.salePrice ?? 0;
    }, []);

    const shelfSummary = useMemo(
        () =>
            summarizeShelfLabels(
                queue
                    .filter((q) => !q.resolveError)
                    .map((q) => ({
                        code: q.code.code,
                        productName:
                            q.product?.productName || q.code.productName || "ETIQUETA",
                        salePrice: shelfPriceOf(q),
                        quantity: q.quantity,
                    })),
                gondolaFormat,
            ),
        [queue, gondolaFormat, shelfPriceOf],
    );

    const handlePrintShelfSheet = useCallback(async () => {
        if (queue.length === 0) return;
        // AUDIT-FIRST: si alguna entrada persistente no se pudo resolver
        // en /labels/codes, se queda en pantalla con badge rojo y no se
        // envía al lote. Bloquear aquí antes de computar los payloads
        // mantiene las referencias `queue.map(q => ...)` intactas con el
        // contrato de los tests estáticos.
        if (queue.some((q) => q.resolveError)) {
            toast({
                variant: "destructive",
                title: "Resuelve los errores antes de imprimir",
                description:
                    "Hay entradas pendientes en la cola con error. Pulsa Reintentar en cada una o descártala.",
            });
            return;
        }
        setIsBusy(true);
        try {
            const triggerSource = labelBatchTriggerSource(queue.map((q) => q.created));
            const items = queue.map((q) => ({
                code: q.code.code,
                productName:
                    q.product?.productName || q.code.productName || "ETIQUETA",
                // Precio NUEVO en la hoja de góndola — ver shelfPriceOf.
                salePrice: shelfPriceOf(q),
                quantity: q.quantity,
            }));
            // 1. Auditoría: `sizeTemplateId: null` + `meta.layout` canónico
            //    derivado del formato de góndola activo (letter/legal
            //    landscape). `buildAuditMeta` impone el layout y las
            //    dimensiones del formato — el caller no puede pisarlos.
            const payload = {
                printerProfileId: defaultPrinter?.id ?? null,
                sizeTemplateId: null,
                triggerSource,
                items: queue.map((q) => ({ code: q.code.code, quantity: q.quantity })),
                meta: buildAuditMeta(
                    {
                        printedBy: user?.name || user?.dni || "",
                        printerName: defaultPrinter?.name || "navegador",
                        totalLabels: shelfSummary.totalLabels,
                        totalPages: shelfSummary.totalPages,
                    },
                    gondolaFormat,
                ),
            };
            // AUDIT FIRST: si falla, salimos y conservamos la cola intacta.
            await apiFetch("/labels/print-jobs", {
                method: "POST",
                body: JSON.stringify(payload),
            });

            // 2. Documento aislado en iframe con su propio
            //    `@page { size: Letter|Legal landscape; margin: 0 }`.
            //    La impresión usa EXCLUSIVAMENTE el diálogo del navegador
            //    (iframe.contentWindow.print()) — nunca el bridge térmico.
            const html = buildShelfLabelsPrintHtml(items, {
                now: new Date(),
                format: gondolaFormat,
            });
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

            // Lista de ids persistentes que debemos eliminar DESPUÉS del
            // print(): tomamos snapshot aquí para no leer `queue` dentro
            // del cleanup (el closure captura).
            const persistentIdsToRemove = queue
                .filter((q) => q.source === "persistent" && q.persistentId)
                .map((q) => q.persistentId as string);

            // Flag compartido entre `fire` y `cleanup`: la limpieza del
            // storage sólo ocurre cuando `print()` se invocó físicamente.
            // Si el iframe falla por completo antes de llamar a print(),
            // no limpiamos nada ni mostramos éxito.
            let shelfPrintInvoked = false;

            const cleanup = () => {
                try {
                    if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
                } catch {
                    /* el nodo ya fue removido */
                }
                if (!shelfPrintInvoked) {
                    // print() nunca se invocó: NO limpiamos storage, NO
                    // tocamos la cola in-memory y NO mostramos éxito.
                    toast({
                        variant: "destructive",
                        title: "No se pudo imprimir la hoja",
                        description:
                            "El diálogo del navegador no se abrió. La cola se conserva para reintento.",
                    });
                    return;
                }
                // ELIMINAR ENTRADAS PERSISTENTES del storage SOLO
                // después de print() invocado. Side effect FUERA del
                // reducer: una sola pasada por id.
                if (typeof window !== "undefined") {
                    for (const pid of persistentIdsToRemove) {
                        removePersistentEntry(window.localStorage, pid);
                    }
                }
                // Checkbox "Limpiar cola al cerrar impresión": limpieza
                // manual explícita del usuario. Vaciamos todo (incluyendo
                // la porción manual de filas que acabamos de convertir).
                if (clearQueueOnPrintClose) {
                    setQueue([]);
                } else {
                    // Preservamos las porciones MANUAL de las filas que
                    // tenían porción persistente: convertimos esas filas
                    // a 'manual' standalone con `manualQuantity > 0`.
                    setQueue((prev) =>
                        prev
                            .map((q) => {
                                if (
                                    q.source === "persistent"
                                    && q.persistentId
                                    && persistentIdsToRemove.includes(q.persistentId)
                                ) {
                                    const manual = q.manualQuantity;
                                    return {
                                        ...q,
                                        source: "manual" as const,
                                        persistentId: undefined,
                                        persistentQuantity: 0,
                                        reason: undefined,
                                        oldSalePrice: undefined,
                                        persistentSalePrice: undefined,
                                        receptionRef: undefined,
                                        resolveError: undefined,
                                        manualQuantity: manual,
                                        quantity: manual,
                                    };
                                }
                                return q;
                            })
                            .filter((q) => q.quantity > 0),
                    );
                }
                toast({
                    variant: "default",
                    title: "HOJA DE GÓNDOLA ENVIADA",
                    description: `${shelfSummary.totalLabels} etiqueta(s) · ${shelfSummary.totalPages} página(s)`,
                });
            };

            const fire = () => {
                try {
                    if (typeof iframe.contentWindow?.print !== "function") {
                        shelfPrintInvoked = false;
                    } else {
                        iframe.contentWindow?.focus();
                        iframe.contentWindow?.print();
                        shelfPrintInvoked = true;
                    }
                } catch {
                    shelfPrintInvoked = false;
                } finally {
                    setTimeout(cleanup, 500);
                }
            };
            if (iframe.contentWindow?.document.readyState === "complete") fire();
            else iframe.onload = fire;
            // El toast de "enviada" se emite en el cleanup, cuando
            // sabemos si print() se invocó.
        } catch (e: any) {
            toast({
                variant: "destructive",
                title: "Error",
                description: e?.message || "No se pudo imprimir la hoja",
            });
        } finally {
            setIsBusy(false);
        }
    }, [
        queue,
        defaultPrinter,
        user,
        shelfSummary,
        clearQueueOnPrintClose,
        toast,
        gondolaFormat,
        shelfPriceOf,
    ]);

    // -------------------------------------------------------------------------
    // Renderizado
    // -------------------------------------------------------------------------

    const headerTitle = mode === "thermal" ? "Etiquetas térmicas" : "Precios de góndola";
    const headerSubtitle =
        mode === "thermal"
            ? `Generador térmico · ${products.length} productos cargados`
            : `Hoja ${gondolaLayout.label} landscape · grid ${gondolaLayout.columns}×${gondolaLayout.rows} · ${products.length} productos cargados`;

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
                            aria-label={`Imprimir hoja de góndola en papel ${gondolaLayout.label} (impresora normal, diálogo del navegador)`}
                            data-gondola-format={gondolaFormat}
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
                            <li>El navegador NO controla directamente impresoras USB.</li>
                            <li>Con bridge local (scale-bridge o similar) se envía el pulso ESC/POS real.</li>
                            <li>Sin bridge, Imprimir usa el diálogo del navegador.</li>
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
                                // "Vaciar" NUNCA toca entradas persistentes: estas
                                // vienen de la cola localStorage (cambios de precio
                                // encolados tras una recepción) y deben descartarse
                                // explícitamente con el botón "Descartar" de cada
                                // entrada. Así protegemos al cajero de perder una
                                // lista de reimpresión por un click apresurado.
                                // "Vaciar" limpia la porción MANUAL
                                // añadida en este workspace. Las filas que
                                // tienen porción persistente conservan
                                // sólo esa porción (manualQuantity → 0);
                                // las filas puramente manuales se filtran.
                                // La persistente nunca se descarta aquí,
                                // porque viene del flujo de recepción y
                                // debe descartarse explícitamente con el
                                // botón "Descartar" de cada fila.
                                onPress={() =>
                                    setQueue((prev) =>
                                        prev
                                            .map((q) =>
                                                q.source === "persistent"
                                                    ? {
                                                          ...q,
                                                          manualQuantity: 0,
                                                          quantity: q.persistentQuantity,
                                                      }
                                                    : q,
                                            )
                                            .filter((q) => q.source === "persistent"),
                                    )
                                }
                                className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
                                data-testid="labels-clear-manual-btn"
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
                            {queue.map((item) => {
                                const isPersistent = item.source === "persistent";
                                const hasError = Boolean(item.resolveError);
                                return (
                                    <li
                                        key={isPersistent && item.persistentId
                                            ? `pq-${item.persistentId}`
                                            : item.code.code}
                                        data-queue-code={item.code.code}
                                        data-queue-source={item.source}
                                        data-queue-persistent-id={item.persistentId || ""}
                                        data-queue-reason={item.reason || ""}
                                        className={`flex items-center gap-3 p-2 rounded-xl border transition-colors ${hasError
                                            ? "bg-rose-50 dark:bg-rose-500/10 border-rose-500/40"
                                            : isPersistent
                                                ? "bg-amber-50/60 dark:bg-amber-500/5 border-amber-500/30"
                                                : "bg-zinc-50 dark:bg-zinc-800/50 border-zinc-200 dark:border-white/5"
                                            }`}
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <p className="text-xs font-bold truncate max-w-[220px]">
                                                    {item.product?.productName
                                                        || item.code.productName
                                                        || "Etiqueta libre"}
                                                </p>
                                                {isPersistent && item.reason === PERSISTENT_QUEUE_REASONS.PRICE_CHANGE && (
                                                    <Chip
                                                        size="sm"
                                                        variant="flat"
                                                        color="warning"
                                                        className="rounded-xl text-[9px] font-bold uppercase"
                                                        data-testid="labels-queue-badge-reason"
                                                    >
                                                        Cambio de precio
                                                    </Chip>
                                                )}
                                                {hasError && (
                                                    <Chip
                                                        size="sm"
                                                        variant="flat"
                                                        color="danger"
                                                        className="rounded-xl text-[9px] font-bold uppercase"
                                                    >
                                                        Error · reintentar
                                                    </Chip>
                                                )}
                                            </div>
                                            <p className="text-[9px] font-mono text-zinc-500 truncate">
                                                {item.code.code}
                                                {item.code.printCount != null && item.code.printCount > 0
                                                    ? ` · ${item.code.printCount} prints`
                                                    : ""}
                                            </p>
                                            {isPersistent && typeof item.oldSalePrice === "number" && typeof item.persistentSalePrice === "number" && (
                                                <p
                                                    className="text-[10px] text-amber-700 dark:text-amber-300 mt-0.5 flex items-center gap-1"
                                                    data-testid="labels-queue-badge-change"
                                                >
                                                    <span className="line-through text-zinc-500 tabular-nums">
                                                        ${item.oldSalePrice.toLocaleString("es-CO")}
                                                    </span>
                                                    <span>→</span>
                                                    <span className="font-bold tabular-nums">
                                                        ${item.persistentSalePrice.toLocaleString("es-CO")}
                                                    </span>
                                                </p>
                                            )}
                                            {isPersistent && item.receptionRef && (
                                                <p
                                                    className="text-[9px] font-mono text-zinc-500 truncate"
                                                    data-testid="labels-queue-badge-ref"
                                                >
                                                    Lote: {item.receptionRef}
                                                </p>
                                            )}
                                            {hasError && (
                                                <p className="text-[9px] text-rose-600 dark:text-rose-400 mt-1 truncate">
                                                    {item.resolveError}
                                                </p>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-1">
                                            {hasError && item.persistentId && (
                                                <Button
                                                    isIconOnly
                                                    size="sm"
                                                    variant="flat"
                                                    color="warning"
                                                    className="rounded-xl"
                                                    aria-label="Reintentar resolución"
                                                    onPress={() => void retryPersistentEntry(item.persistentId!)}
                                                    data-testid="labels-queue-retry"
                                                >
                                                    <RefreshCw size={12} />
                                                </Button>
                                            )}
                                            {!hasError && (
                                                <>
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
                                                </>
                                            )}
                                            {isPersistent && item.persistentId ? (
                                                <Button
                                                    isIconOnly
                                                    size="sm"
                                                    variant="light"
                                                    color="danger"
                                                    className="rounded-xl ml-1"
                                                    aria-label="Descartar entrada persistente"
                                                    title="Descartar: elimina la entrada de la cola persistente"
                                                    onPress={() => discardPersistentEntry(item.persistentId!)}
                                                    data-testid="labels-queue-discard"
                                                >
                                                    <Trash2 size={12} />
                                                </Button>
                                            ) : (
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
                                            )}
                                        </div>
                                    </li>
                                );
                            })}
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
                                <span
                                    className="text-[9px] uppercase tracking-widest text-zinc-500"
                                    data-testid="labels-shelf-format-caption"
                                >
                                    {`${gondolaLayout.label} landscape · 80mm × 40mm · grid ${gondolaLayout.columns}×${gondolaLayout.rows} · ${gondolaLayout.labelsPerPage} por hoja`}
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
                                        format={gondolaFormat}
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
