"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Chip,
  Progress,
  Autocomplete,
  AutocompleteItem,
} from "@heroui/react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  PlusCircle,
  SkipForward,
  Sparkles,
  X,
  Search,
  Camera,
  ArrowLeft,
  Loader2,
  Pencil,
  Link2,
} from "lucide-react";
import dynamic from "next/dynamic";

import { useToast } from "@/hooks/use-toast";
import { makeOcrLocalId } from "@/lib/invoice-reader-helpers.mjs";
import {
  validateProposedName,
} from "@/lib/product-rename.mjs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const ScannerOverlay = dynamic(() => import('@/components/ScannerOverlay').then(m => m.ScannerOverlay), { ssr: false });

// ============================================================
// Tipos
// ============================================================

export interface UnmatchedItem {
  invoiceName: string;
  quantity: number;
  unitPrice: number;
  /** Porcentajes que el OCR extrajo de la factura (0 si no se pudo). */
  iva_percentage?: number;
  ibua_percentage?: number;
  icui_percentage?: number;
  /**
   * Porcentaje de descuento ya normalizado por el backend (gana porcentaje
   * sobre monto, clamp [0, 100]). Es la ÚNICA fuente de verdad del DTO —
   * nunca viajan montos monetarios desde el OCR aquí.
   */
  discount_percentage?: number;
  /** Tipo de línea tal como la emitió el backend tras splitBonusItems. */
  lineType?: 'REGULAR' | 'BONUS' | 'RETURN' | string;
  /** Unidades regaladas si vino un patrón combinado "pague X lleve Y". */
  bonus_quantity?: number;
  /**
   * Trazabilidad del empaque convertido en el modal: cantidad original en
   * paquetes (antes de multiplicar) y multiplicador N confirmado por el
   * usuario. Si `packConversionApplied` es true, `quantity` y `unitPrice`
   * ya están expresados en UNIDADES INDIVIDUALES y no deben re-multiplicarse
   * aguas abajo. Son opcionales porque no todos los items pasan por la
   * revisión de empaques.
   */
  invoicePackageQuantity?: number;
  confirmedUnitsPerPack?: number;
  packConversionApplied?: boolean;
  /**
   * Identidad estable aguas arriba del OCR. Permite deduplicar entradas con
   * el mismo invoiceName (facturas con saltos de página, líneas BONUS) y
   * navegar con "Volver" sin colisionar.
   */
  __ocrLocalId?: string;
  suggestions?: Array<{
    barcode: string;
    productName: string;
    confidence: number;
  }>;
}

export interface ResolvedReceiveLine {
  barcode: string;
  productName: string;
  addedQuantity: number;
  newPurchasePrice: number;
  newSalePrice: number;
  marginPercentage: number;
  iva: number;
  icui: number;
  ibua: number;
  /**
   * Porcentaje de descuento que se traslada al carrito. Nunca es un monto.
   * Para RETURN se preserva el DTO original de la factura; para BONUS se
   * fuerza a 0 porque un regalo no admite descuento.
   */
  discount: number;
  /** True = producto recien creado en este flujo; False = se asigno a uno existente. */
  isNew: boolean;
  invoiceName: string;
  supplierId: number;
  /** oldPurchasePrice tomado del catálogo cuando el reviewer asignó a existente. */
  oldPurchasePrice?: number;
  oldSalePrice?: number;
  /** Metadata del OCR original — permite al padre tomar decisiones adicionales. */
  __ocrLocalId?: string;
  lineType?: string;
  bonus_quantity?: number;
}

/** Datos pre-llenados que se mandan al ProductFormModal del padre */
export interface CreateProductPrefill {
  productName: string;
  purchasePrice: number;
  iva: number;
  ibua: number;
  icui: number;
  /**
   * Descuento (%) sugerido para el nuevo producto. Si el OCR lo extrajo de
   * la factura, viaja aquí para que el ProductFormModal lo guarde en
   * `product.discount` desde el inicio.
   */
  discount_percentage: number;
  /** Cantidad que viene en la factura — para usarla luego en el carrito */
  invoiceQuantity: number;
  /** Nombre original de factura para guardarlo como alias del proveedor */
  invoiceName: string;
}

/** Cuando el padre completa la creacion, manda este objeto al reviewer
    para que avance al siguiente item automaticamente. */
export interface ExternalResolution {
  barcode: string;
  productName: string;
  salePrice: number;
  marginPercentage: number;
  iva: number;
  ibua: number;
  icui: number;
  /** ID interno para evitar reaplicar la misma resolucion dos veces */
  resolutionId: number;
}

/**
 * Veredicto que el reviewer espera recibir del callback `onSaveAlias` para
 * decidir si surface un toast al operario. Se mantiene plano para que el
 * reviewer no dependa del tipo exacto del helper puro.
 */
export interface AliasSaveOutcome {
  ok: boolean;
  reason?: string;
  message?: string;
}

export interface AliasLinkRequest {
  invoiceName: string;
  productBarcode: string;
  /** True = producto recién creado en este flujo. */
  isNew: boolean;
  /**
   * Origen del enlace, para que el padre pueda diferenciar auditorías o
   * banderas. Nunca cambia el payload del endpoint.
   */
  source: 'suggestion' | 'manual' | 'scanner' | 'created';
}

/**
 * Request que el reviewer envía al padre cuando el operario pulsa
 * "Actualizar nombre y enlazar" en el diálogo de confirmación. El padre es
 * responsable de ejecutar el PUT a `/products/update-products/:barcode`
 * con `sanitizeProductPayload`, actualizar el estado local de productos y
 * emitir el broadcast `PRODUCT_UPDATE` SÓLO si el PUT fue exitoso.
 *
 * El reviewer no construye el payload del PUT: tipea la intención y espera
 * un `RenameOutcome` del padre para decidir si avanza o mantiene el
 * diálogo abierto.
 */
export interface RenameLinkRequest {
  /** Código de barras del producto existente en catálogo. */
  productBarcode: string;
  /** Nombre que viene en la factura (contexto para auditoría/UX). */
  invoiceName: string;
  /** Nombre que el operario escribió en el input, ya normalizado. */
  newName: string;
  /** Nombre que tenía el producto en el catálogo antes del rename. */
  previousName: string;
  /**
   * Origen del enlace. 'created' nunca aparece aquí: los productos recién
   * creados no reciben prompt de rename.
   */
  source: 'suggestion' | 'manual' | 'scanner';
}

/**
 * Resultado que el reviewer espera recibir del padre tras el PUT. Mantiene
 * paralelismo con `AliasSaveOutcome` para que la UI del diálogo decida si
 * avanza (`ok: true`) o si mantiene abierto con mensaje (`ok: false`).
 */
export interface RenameOutcome {
  ok: boolean;
  /** Nombre final del producto (puede diferir del enviado si el backend
   *  lo normaliza aún más). Si el padre no lo devuelve, el reviewer usa
   *  el que escribió el usuario. */
  productName?: string;
  message?: string;
}

interface UnmatchedItemsReviewerProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  items: UnmatchedItem[];
  supplierId: string | number;
  /** Callback cuando termina la revision — recibe TODOS los items resueltos */
  onResolved: (resolved: ResolvedReceiveLine[]) => void;
  /** Solicita al padre abrir el ProductFormModal con estos datos pre-llenados */
  onRequestCreateNewProduct: (prefill: CreateProductPrefill) => void;
  /** Resolucion externa: cuando el padre completa la creacion, setea esto y
      el reviewer avanza al siguiente item automaticamente. */
  externalResolution?: ExternalResolution | null;
  /** El reviewer marca cuando "consumio" la externalResolution para que el padre
      la limpie y no re-aplique. */
  onExternalResolutionConsumed?: () => void;
  /**
   * Persistencia inmediata del alias de proveedor hacia
   * `POST /inventory/save-alias`. El padre inyecta esta función con acceso
   * al supplierId real y al token para que:
   *   1. Se dispare EN EL MOMENTO del enlace explícito (sugerencia, búsqueda
   *      manual, escáner, producto recién creado) y no al cerrar el modal.
   *   2. El reviewer pueda surfacer un toast si el aprendizaje falla sin
   *      perderlo silenciosamente.
   * Devuelve el veredicto `{ ok, reason?, message? }` o nada si el padre
   * no quiere delegar feedback. En producción el padre ya muestra el toast,
   * así que el reviewer solo loggea cuando el callback retorna `ok: false`.
   */
  onSaveAlias?: (
    link: AliasLinkRequest,
  ) => Promise<AliasSaveOutcome | void> | AliasSaveOutcome | void;
  /**
   * Callback tipado que ejecuta el PUT a
   * `/products/update-products/:barcode` para renombrar el producto
   * existente. El reviewer sólo lo invoca cuando el operario pulsa
   * deliberadamente "Actualizar nombre y enlazar"; nunca hace rename
   * automático.
   *
   * Contrato:
   *   - El padre debe usar `sanitizeProductPayload` para armar el PUT.
   *   - Solo tras `response.ok` el padre actualiza su estado local de
   *     productos y emite `broadcastRevalidate('PRODUCT_UPDATE')`.
   *   - Debe retornar `{ ok: true, productName? }` en éxito o
   *     `{ ok: false, message }` en error; nunca lanzar.
   *   - El reviewer, al recibir `{ ok: true }`, guarda el alias y avanza.
   *     Si recibe `{ ok: false }`, mantiene el diálogo abierto y muestra
   *     el mensaje para que el operario reintente o pulse "Volver".
   */
  onRenameProduct?: (req: RenameLinkRequest) => Promise<RenameOutcome>;
  products?: any[]; // Products passed from parent for manual search
}

// ============================================================
// Helpers internos
// ============================================================

/**
 * Devuelve una clave estable para el item: prioriza el `__ocrLocalId` que
 * añade `InvoiceReaderModal` y cae a una composición "invoiceName|idx" si no
 * viene. Nunca retorna el `invoiceName` solo: dos BONUS/RETURN con el mismo
 * texto romperían el "Volver" si lo usáramos.
 */
function stableKeyFor(item: UnmatchedItem | undefined, idx: number): string {
  if (!item) return `__empty-${idx}`;
  if (typeof item.__ocrLocalId === 'string' && item.__ocrLocalId) return item.__ocrLocalId;
  return `${item.invoiceName || 'sin-nombre'}#${idx}`;
}

/**
 * Lee `discount_percentage` del item actual con clamp defensivo. BONUS fuerza
 * 0 porque un regalo no admite descuento; RETURN preserva el DTO original.
 */
function discountForCart(item: UnmatchedItem): number {
  const lt = typeof item.lineType === 'string' ? item.lineType.toUpperCase() : '';
  if (lt === 'BONUS') return 0;
  const n = Number(item.discount_percentage);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 100) return 100;
  return n;
}

// ============================================================
// Componente
// ============================================================

export default function UnmatchedItemsReviewer({
  isOpen,
  onOpenChange,
  items,
  supplierId,
  onResolved,
  onRequestCreateNewProduct,
  externalResolution,
  onExternalResolutionConsumed,
  onSaveAlias,
  onRenameProduct,
  products = [],
}: UnmatchedItemsReviewerProps) {
  const { toast } = useToast();

  const [currentIdx, setCurrentIdx] = useState(0);
  const [resolvedItems, setResolvedItems] = useState<ResolvedReceiveLine[]>([]);
  const [lastResolutionId, setLastResolutionId] = useState<number | null>(null);

  const [manualSearchKey, setManualSearchKey] = useState<string | number | null>(null);

  // Para el escaner
  const [isScannerOpen, setIsScannerOpen] = useState(false);

  // ───────────────────────────────────────────────────────────────────
  // Estado del diálogo "Rename-and-link"
  // ───────────────────────────────────────────────────────────────────
  //
  // Cuando el operario enlaza un producto EXISTENTE desde cualquiera de las
  // tres ramas (sugerencia, búsqueda manual o escáner) NO avanzamos
  // inmediatamente al siguiente item. En cambio, capturamos el producto
  // emparejado + el item del OCR en `pendingLink` y abrimos el diálogo
  // para que el operario decida:
  //   - "Solo enlazar"               → scheduleAliasSave + advanceTo
  //   - "Actualizar nombre y enlazar" → onRenameProduct + (si ok)
  //                                     scheduleAliasSave + advanceTo
  //   - "Volver"                     → cierra diálogo sin cambios
  //
  // El rename nunca es automático; depende de un click explícito.
  interface PendingLink {
    source: 'suggestion' | 'manual' | 'scanner';
    product: any; // Producto resuelto del catálogo (barcode, productName…)
    item: UnmatchedItem;
    /** Snapshot del índice del item en el momento del click — para que el
     *  diálogo pueda avanzar aunque el padre refresque `products` entre
     *  medias. */
    itemIdx: number;
  }
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
  const [draftName, setDraftName] = useState<string>('');
  const [isRenaming, setIsRenaming] = useState<boolean>(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  // Ref anti-doble-submit: aunque React 18 StrictMode re-renderice,
  // bloqueamos el handler imperativamente.
  const renameInFlight = useRef<boolean>(false);

  // Reset al abrir
  useEffect(() => {
    if (isOpen) {
      setCurrentIdx(0);
      setResolvedItems([]);
      setLastResolutionId(null);
      // Al reabrir una revisión limpiamos cualquier residuo del diálogo
      // de rename para que no quede "pegado" al próximo item.
      setPendingLink(null);
      setDraftName('');
      setIsRenaming(false);
      setRenameError(null);
      renameInFlight.current = false;
    }
  }, [isOpen]);

  /**
   * Dispara la persistencia del alias en el momento del enlace explícito.
   *
   * Reglas:
   *   - NUNCA fuerza una entrada en setState (que puede duplicarse en React
   *     18 Strict Mode); vive fuera del updater.
   *   - Si el padre no proporcionó `onSaveAlias` o la invoiceName/barcode
   *     viajan vacíos, salta sin ruido. El supplierId=0 se filtra en el
   *     helper puro aguas abajo.
   *   - Si el callback retorna un veredicto con `ok:false`, surface un toast
   *     informativo (no destructivo del flujo) para que el aprendizaje no se
   *     pierda silenciosamente. El padre tiene permitido mostrar su propio
   *     toast también; si lo hace, retorna `void` o `{ok:true}` y aquí
   *     no se agrega ruido extra.
   */
  const scheduleAliasSave = (link: AliasLinkRequest) => {
    if (typeof onSaveAlias !== 'function') return;
    if (!link.invoiceName || !link.productBarcode) return;
    try {
      const outcome = onSaveAlias(link);
      if (outcome && typeof (outcome as Promise<unknown>).then === 'function') {
        (outcome as Promise<AliasSaveOutcome | void>)
          .then((verdict) => {
            if (verdict && verdict.ok === false) {
              toast({
                variant: 'destructive',
                title: 'No se pudo recordar el alias',
                description:
                  verdict.message ||
                  'El producto quedó en el carrito, pero el OCR volverá a pedirlo. Intenta de nuevo cuando haya conexión.',
              });
            }
          })
          .catch((err) => {
            // Último paracaídas: el helper puro ya atrapa network errors y
            // devuelve verdict en lugar de lanzar, pero por si el padre
            // envuelve en algo que sí lanza, aquí no perdemos la señal.
            console.error('[UnmatchedReviewer] onSaveAlias threw:', err);
            toast({
              variant: 'destructive',
              title: 'No se pudo recordar el alias',
              description:
                'El producto quedó en el carrito, pero el OCR volverá a pedirlo. Intenta de nuevo cuando haya conexión.',
            });
          });
      } else if (outcome && (outcome as AliasSaveOutcome).ok === false) {
        toast({
          variant: 'destructive',
          title: 'No se pudo recordar el alias',
          description:
            (outcome as AliasSaveOutcome).message ||
            'El producto quedó en el carrito, pero el OCR volverá a pedirlo.',
        });
      }
    } catch (err) {
      console.error('[UnmatchedReviewer] onSaveAlias threw synchronously:', err);
      toast({
        variant: 'destructive',
        title: 'No se pudo recordar el alias',
        description:
          'El producto quedó en el carrito, pero el OCR volverá a pedirlo. Intenta de nuevo cuando haya conexión.',
      });
    }
  };

  const current = items[currentIdx];
  const progressPct = items.length > 0 ? ((currentIdx + 1) / items.length) * 100 : 0;

  // Resolver el producto en el catálogo (si existe) para hidratar precio y
  // margen cuando el reviewer asigna a un existente. Centralizamos la búsqueda
  // en un helper para que las tres ramas (sugerencia, manual, escáner)
  // compartan el mismo contrato.
  const findProductByBarcode = (bc: string | undefined) => {
    if (!bc) return undefined;
    return products.find((p: any) =>
      p.barcode === bc ||
      (p.alternateCodes && String(p.alternateCodes).split(',').map((s: string) => s.trim()).includes(bc)),
    );
  };

  // ============================================================
  // Avanzar al siguiente item (o cerrar si fue el ultimo)
  // ============================================================
  const advanceTo = (next: ResolvedReceiveLine | null) => {
    const updatedResolved = next ? [...resolvedItems, next] : resolvedItems;
    if (next) setResolvedItems(updatedResolved);

    const isLast = currentIdx >= items.length - 1;
    if (isLast) {
      onResolved(updatedResolved);
      onOpenChange(false);
      toast({
        variant: "success",
        title: "Revision completada",
        description: `${updatedResolved.length} de ${items.length} items resueltos. Ahora puedes guardar la factura.`,
      });
      return;
    }
    setCurrentIdx(idx => idx + 1);
  };

  /**
   * Construye una `ResolvedReceiveLine` para el caso "el reviewer asignó este
   * item de factura a un producto que YA existe en catálogo".
   *
   * Reglas:
   *   - El precio de venta y el margen se toman del catálogo (no se fuerzan
   *     a 0 / 20) para preservar la rentabilidad calculada previamente.
   *   - Los impuestos del OCR prevalecen cuando > 0; si no, caemos al producto.
   *   - El descuento viaja como porcentaje puro desde el OCR (BONUS = 0).
   *   - `oldPurchasePrice/oldSalePrice` del catálogo viajan para que el carrito
   *     pueda proyectar el WAC sin colapsar.
   */
  const buildResolvedForExisting = (prod: any, item: UnmatchedItem): ResolvedReceiveLine => {
    const ivaOcr = Number(item.iva_percentage) || 0;
    const icuiOcr = Number(item.icui_percentage) || 0;
    const ibuaOcr = Number(item.ibua_percentage) || 0;
    const iva = ivaOcr > 0 ? ivaOcr : Number(prod.iva) || 0;
    const icui = icuiOcr > 0 ? icuiOcr : Number(prod.icui) || 0;
    const ibua = ibuaOcr > 0 ? ibuaOcr : Number(prod.ibua) || 0;
    return {
      barcode: prod.barcode,
      productName: prod.productName,
      addedQuantity: Number(item.quantity) || 0,
      newPurchasePrice: Number(item.unitPrice) || 0,
      // Precio de venta y margen del catálogo (no hardcoded a 0/20).
      newSalePrice: Number(prod.salePrice) || 0,
      marginPercentage: Number(prod.marginPercentage) || 20,
      iva,
      icui,
      ibua,
      discount: discountForCart(item),
      // Es falso porque estamos usando un producto existente; esto fuerza
      // a que page.tsx lo trate como 'match'.
      isNew: false,
      invoiceName: item.invoiceName,
      supplierId: Number(supplierId),
      oldPurchasePrice: Number(prod.purchasePrice) || 0,
      oldSalePrice: Number(prod.salePrice) || 0,
      __ocrLocalId: item.__ocrLocalId,
      lineType: typeof item.lineType === 'string' ? item.lineType.toUpperCase() : item.lineType,
      bonus_quantity: Number(item.bonus_quantity) || 0,
    };
  };

  // ============================================================
  // Aceptar resolucion externa (cuando el padre crea el producto)
  // ============================================================
  useEffect(() => {
    if (!externalResolution) return;
    if (externalResolution.resolutionId === lastResolutionId) return;
    if (!current) return;

    setLastResolutionId(externalResolution.resolutionId);

    const resolved: ResolvedReceiveLine = {
      barcode: externalResolution.barcode,
      productName: externalResolution.productName,
      addedQuantity: Number(current.quantity) || 0,
      newPurchasePrice: Number(current.unitPrice) || 0,
      newSalePrice: Number(externalResolution.salePrice) || 0,
      marginPercentage: Number(externalResolution.marginPercentage) || 20,
      iva: Number(externalResolution.iva) || 0,
      ibua: Number(externalResolution.ibua) || 0,
      icui: Number(externalResolution.icui) || 0,
      // Un producto recién creado no hereda DTO histórico, pero sí el que
      // extrajo el OCR de la factura actual (BONUS fuerza 0).
      discount: discountForCart(current),
      isNew: true,
      invoiceName: current.invoiceName,
      supplierId: Number(supplierId),
      __ocrLocalId: current.__ocrLocalId,
      lineType: typeof current.lineType === 'string' ? current.lineType.toUpperCase() : current.lineType,
      bonus_quantity: Number(current.bonus_quantity) || 0,
    };

    // RAMA 4: producto recién creado. También dispara save-alias para que la
    // próxima factura del mismo proveedor reconozca el invoiceName sin que
    // el OCR tenga que proponerlo. El guard `!r.isNew` del padre quedó
    // eliminado precisamente por esto: aprender al momento de crear.
    scheduleAliasSave({
      invoiceName: current.invoiceName,
      productBarcode: externalResolution.barcode,
      isNew: true,
      source: 'created',
    });

    advanceTo(resolved);
    onExternalResolutionConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalResolution]);

  // ============================================================
  // Acciones
  // ============================================================

  // ============================================================
  // Rename-and-link: helpers compartidos por las 3 ramas
  // ============================================================

  /**
   * Abre el diálogo de confirmación "Solo enlazar / Actualizar nombre y
   * enlazar / Volver" para una rama existente. Nunca avanza por su cuenta:
   * la decisión queda en manos del operario.
   *
   * El producto puede llegar hidratado (manual, scanner) o parcialmente
   * (sugerencia sin match completo contra el catálogo). En ambos casos
   * capturamos su `productName` actual como "nombre actual" para el
   * diálogo.
   */
  const openRenamePrompt = (
    source: 'suggestion' | 'manual' | 'scanner',
    product: any,
    item: UnmatchedItem,
  ) => {
    if (!product || !item) return;
    const currentName = typeof product.productName === 'string' ? product.productName : '';
    const invoiceName = typeof item.invoiceName === 'string' ? item.invoiceName : '';
    // El input se pre-llena con el invoiceName tal cual (el operario
    // decide si lo deja o lo edita). La normalización se aplica al
    // momento de validar/enviar.
    setDraftName(invoiceName);
    setRenameError(null);
    setIsRenaming(false);
    renameInFlight.current = false;
    setPendingLink({
      source,
      product: { ...product, productName: currentName },
      item,
      itemIdx: currentIdx,
    });
  };

  /** Cierra y limpia estado del diálogo de rename. */
  const closeRenamePrompt = () => {
    setPendingLink(null);
    setDraftName('');
    setIsRenaming(false);
    setRenameError(null);
    renameInFlight.current = false;
  };

  // Asignar el item actual a una sugerencia existente (sin crear producto nuevo)
  const handleAssignToSuggestion = (suggestion: NonNullable<UnmatchedItem["suggestions"]>[number]) => {
    if (!current) return;
    const prod = findProductByBarcode(suggestion.barcode) || {
      // Fallback: la sugerencia trae barcode + nombre pero no el resto del
      // catálogo. En ese caso usamos valores mínimos para que la línea del
      // carrito pueda crearse y el usuario corrija el precio después.
      barcode: suggestion.barcode,
      productName: suggestion.productName,
      salePrice: 0,
      marginPercentage: 20,
      purchasePrice: 0,
      iva: 0,
      icui: 0,
      ibua: 0,
    };
    // RAMA 1: sugerencia del OCR. NO avanzamos inmediatamente: abrimos el
    // diálogo para que el operario confirme si solo enlaza o también
    // actualiza el nombre del producto en catálogo. El alias se persiste
    // dentro del handler del diálogo (handleLinkOnly / handleRenameAndLink)
    // justo antes de advanceTo.
    openRenamePrompt('suggestion', prod, current);
  };

  // Asignar el item actual a un producto buscado manualmente
  const handleAssignToManual = (key: any) => {
    if (!key || !current) return;
    const selectedProd = findProductByBarcode(String(key));
    if (!selectedProd) return;
    // RAMA 2: búsqueda manual en el autocomplete. Mismo contrato que la
    // sugerencia — nunca advance directo.
    setManualSearchKey(null);
    openRenamePrompt('manual', selectedProd, current);
  };

  const handleScanResult = (code: string) => {
    setIsScannerOpen(false);
    if (!current) return;
    const selectedProd = findProductByBarcode(code);
    if (!selectedProd) {
      toast({
        title: "No encontrado",
        description: `El codigo ${code} no existe en la base de datos.`,
        variant: "destructive"
      });
      return;
    }
    // RAMA 3: escaneo del código físico sobre el producto. Igual que las
    // otras ramas, confirmamos primero vía diálogo.
    openRenamePrompt('scanner', selectedProd, current);
  };

  // ============================================================
  // Rename-and-link: handlers del diálogo
  // ============================================================

  /**
   * "Solo enlazar": no toca el nombre del producto, sólo guarda el alias
   * del proveedor (OCR → producto) y avanza al siguiente item.
   *
   * Flujo:
   *   1. scheduleAliasSave con source original (suggestion/manual/scanner)
   *      → el padre persiste contra POST /inventory/save-alias
   *   2. advanceTo(buildResolvedForExisting(product, item))
   *   3. closeRenamePrompt()
   *
   * Nunca hace PUT a /products/update-products. El contrato con el padre
   * es claro: rename sólo si el operario lo pidió explícitamente.
   */
  const handleLinkOnly = useCallback(() => {
    if (!pendingLink) return;
    if (renameInFlight.current) return; // Doble click defensivo.
    const { source, product, item } = pendingLink;
    scheduleAliasSave({
      invoiceName: item.invoiceName,
      productBarcode: product.barcode,
      isNew: false,
      source,
    });
    advanceTo(buildResolvedForExisting(product, item));
    closeRenamePrompt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLink]);

  /**
   * "Actualizar nombre y enlazar": pide al padre ejecutar el PUT a
   * /products/update-products/:barcode. Si falla, mantiene el diálogo
   * abierto con el mensaje de error. Si tiene éxito, guarda el alias
   * (con el invoiceName original, no el nuevo nombre) y avanza.
   *
   * Importante:
   *   - El rename se dispara una sola vez por click: `renameInFlight` +
   *     `isRenaming` bloquean doble submit.
   *   - El reviewer usa el `newName` del input tras `validateProposedName`;
   *     si el usuario dejó el input idéntico al nombre actual, se avisa en
   *     el diálogo y no se pega al endpoint.
   *   - El alias se guarda con el `invoiceName` original porque el
   *     backend indexa el aprendizaje OCR por ese texto, no por el
   *     productName canónico.
   */
  const handleRenameAndLink = useCallback(async () => {
    if (!pendingLink) return;
    if (renameInFlight.current || isRenaming) return;
    const { source, product, item } = pendingLink;
    if (!product?.barcode) {
      setRenameError('El producto no tiene código de barras válido.');
      return;
    }
    const validation = validateProposedName(draftName, product.productName);
    if (!validation.ok) {
      setRenameError(validation.message);
      return;
    }
    if (typeof onRenameProduct !== 'function') {
      // Sin callback no podemos ejecutar el PUT: degradamos a "solo enlazar"
      // y avisamos. Mejor que silenciar el click.
      setRenameError('No se puede actualizar el nombre en este flujo. Pulsa "Solo enlazar".');
      return;
    }
    renameInFlight.current = true;
    setIsRenaming(true);
    setRenameError(null);
    try {
      const outcome = await onRenameProduct({
        productBarcode: product.barcode,
        invoiceName: item.invoiceName,
        newName: validation.name,
        previousName: product.productName || '',
        source,
      });
      if (!outcome || outcome.ok !== true) {
        // Mantenemos el diálogo abierto para que el operario reintente o
        // pulse "Volver".
        setRenameError(
          (outcome && outcome.message)
            || 'No se pudo actualizar el nombre; vuelve a intentarlo.',
        );
        return;
      }
      // ÉXITO: el padre ya hizo el PUT, actualizó estado y emitió el
      // broadcast. Nosotros usamos el nombre devuelto (o, en su defecto,
      // el que escribió el usuario) para componer la línea del carrito.
      const resolvedName = typeof outcome.productName === 'string' && outcome.productName.trim()
        ? outcome.productName
        : validation.name;
      scheduleAliasSave({
        invoiceName: item.invoiceName,
        productBarcode: product.barcode,
        isNew: false,
        source,
      });
      advanceTo(buildResolvedForExisting(
        { ...product, productName: resolvedName },
        item,
      ));
      closeRenamePrompt();
    } catch (err: any) {
      // Último paracaídas: el padre no debería lanzar porque el contrato
      // pide retornar `{ ok: false, message }`. Si lo hace, surface el
      // mensaje y mantenemos el diálogo abierto.
      setRenameError(
        (err && typeof err.message === 'string' && err.message.trim())
          ? err.message
          : 'No se pudo actualizar el nombre; vuelve a intentarlo.',
      );
    } finally {
      renameInFlight.current = false;
      setIsRenaming(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLink, draftName, isRenaming, onRenameProduct]);

  /**
   * "Volver": cierra el diálogo sin enlazar ni cambiar el producto. El
   * item sigue sin resolver, el cursor permanece en el mismo índice y el
   * operario puede elegir otra sugerencia / buscar manualmente / escanear
   * / abrir el protocolo de nuevo producto.
   */
  const handleCancelRename = useCallback(() => {
    if (isRenaming) return; // No se puede cancelar en medio del PUT.
    closeRenamePrompt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRenaming]);

  // Pedir al padre que abra el ProductFormModal con datos pre-llenados
  const handleOpenProtocol = () => {
    if (!current) return;
    onRequestCreateNewProduct({
      productName: current.invoiceName.toUpperCase().trim(),
      purchasePrice: current.unitPrice || 0,
      iva: Number(current.iva_percentage) || 0,
      ibua: Number(current.ibua_percentage) || 0,
      icui: Number(current.icui_percentage) || 0,
      discount_percentage: discountForCart(current),
      invoiceQuantity: current.quantity,
      invoiceName: current.invoiceName,
    });
  };

  // Saltar este item
  const handleSkip = () => {
    advanceTo(null);
  };

  // Volver al item anterior
  const handleGoBack = () => {
    if (currentIdx > 0) {
      // Usamos la identidad estable (__ocrLocalId cuando viene, "invoiceName#idx"
      // como fallback) para no borrar resoluciones de items que comparten
      // invoiceName (facturas con BONUS repetido).
      const prevItem = items[currentIdx - 1];
      const prevKey = stableKeyFor(prevItem, currentIdx - 1);
      setResolvedItems(prev => prev.filter(r => {
        const rKey = r.__ocrLocalId
          ? r.__ocrLocalId
          : `${r.invoiceName || 'sin-nombre'}#${currentIdx - 1}`;
        return rKey !== prevKey;
      }));
      setCurrentIdx(idx => idx - 1);
    }
  };

  // ============================================================
  // Render
  // ============================================================

  if (!current) return null;

  // Indicador visual de impuestos y descuento detectados
  const hasOcrTaxes = (Number(current.iva_percentage) || 0) > 0
    || (Number(current.ibua_percentage) || 0) > 0
    || (Number(current.icui_percentage) || 0) > 0;
  const ocrDiscountPct = discountForCart(current);
  const hasOcrDiscount = ocrDiscountPct > 0;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="2xl"
      backdrop="blur"
      // Mantener el modal no descartable preserva el flujo "item a item":
      // cerrar accidentalmente perdería las resoluciones ya acumuladas.
      isDismissable={false}
      hideCloseButton
      classNames={{
        base: "bg-white dark:bg-zinc-950 border border-amber-500/20 rounded-[2rem]",
        header: "border-b border-amber-500/10 px-6 py-4",
        body: "p-6",
        footer: "border-t border-zinc-200 dark:border-white/5 px-6 py-4",
      }}
    >
      <ModalContent>
        <>
          <ModalHeader className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center">
                  <AlertCircle size={20} aria-hidden="true" />
                </div>
                <div className="flex flex-col">
                  <h2 className="text-base font-medium tracking-tight uppercase text-zinc-900 dark:text-zinc-50">
                    Productos sin emparejar
                  </h2>
                  <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-amber-600">
                    Revisa uno a uno · {currentIdx + 1} de {items.length}
                  </p>
                </div>
              </div>
              <Chip
                size="sm"
                variant="flat"
                className="bg-emerald-500/10 text-emerald-600 font-medium text-[9px] uppercase tracking-widest"
                startContent={<CheckCircle2 size={10} className="ml-1" aria-hidden="true" />}
              >
                {resolvedItems.length} resueltos
              </Chip>
            </div>
            <Progress
              aria-label={`Progreso de revision: ${currentIdx + 1} de ${items.length}`}
              value={progressPct}
              size="sm"
              color="warning"
              className="mt-2"
            />
          </ModalHeader>

          <ModalBody>
            {/* Datos del item actual */}
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-4">
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-amber-600 mb-1">
                    Nombre en factura
                  </p>
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 uppercase break-words">
                    {current.invoiceName}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500 dark:text-zinc-500">Cant</p>
                  <p className="text-base font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{current.quantity}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500 dark:text-zinc-500">Precio</p>
                  <p className="text-base font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                    ${Math.round(current.unitPrice).toLocaleString("es-CO")}
                  </p>
                </div>
              </div>

              {/* Pista de impuestos y descuento detectados */}
              {(hasOcrTaxes || hasOcrDiscount) && (
                <div className="mt-3 pt-3 border-t border-amber-500/10 flex items-center gap-3 flex-wrap">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-emerald-600">
                    ✨ OCR detecto:
                  </span>
                  {(Number(current.iva_percentage) || 0) > 0 && (
                    <Chip size="sm" variant="flat" className="bg-emerald-500/10 text-emerald-600 font-medium text-[9px] uppercase tabular-nums">
                      IVA {current.iva_percentage}%
                    </Chip>
                  )}
                  {(Number(current.ibua_percentage) || 0) > 0 && (
                    <Chip size="sm" variant="flat" className="bg-emerald-500/10 text-emerald-600 font-medium text-[9px] uppercase tabular-nums">
                      IBUA {current.ibua_percentage}%
                    </Chip>
                  )}
                  {(Number(current.icui_percentage) || 0) > 0 && (
                    <Chip size="sm" variant="flat" className="bg-emerald-500/10 text-emerald-600 font-medium text-[9px] uppercase tabular-nums">
                      ICUI {current.icui_percentage}%
                    </Chip>
                  )}
                  {hasOcrDiscount && (
                    <Chip size="sm" variant="flat" className="bg-blue-500/10 text-blue-600 font-medium text-[9px] uppercase tabular-nums">
                      DTO {ocrDiscountPct}%
                    </Chip>
                  )}
                  {typeof current.lineType === 'string' && current.lineType.toUpperCase() !== 'REGULAR' && current.lineType && (
                    <Chip size="sm" variant="flat" className="bg-purple-500/10 text-purple-600 font-medium text-[9px] uppercase tabular-nums">
                      {current.lineType.toUpperCase()}
                    </Chip>
                  )}
                </div>
              )}
            </div>

            {/* Sugerencias del OCR */}
            {current.suggestions && current.suggestions.length > 0 && (
              <div className="space-y-2 mt-4">
                <div className="flex items-center gap-2">
                  <Sparkles size={12} className="text-emerald-500" aria-hidden="true" />
                  <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-600 dark:text-zinc-400">
                    ¿Es alguno de estos productos?
                  </p>
                </div>
                <div className="space-y-2">
                  {current.suggestions.slice(0, 5).map((sug, i) => (
                    <button
                      key={`${sug.barcode}-${i}`}
                      type="button"
                      onClick={() => handleAssignToSuggestion(sug)}
                      className="w-full p-3 rounded-xl border border-zinc-200 dark:border-white/5 bg-white dark:bg-zinc-900 hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-all flex items-center gap-3 text-left group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100 uppercase truncate">
                          {sug.productName}
                        </p>
                        <p className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 tabular-nums tracking-wider">
                          {sug.barcode}
                        </p>
                      </div>
                      <Chip
                        size="sm"
                        variant="flat"
                        className={`font-medium text-[9px] uppercase tabular-nums ${
                          sug.confidence >= 0.6
                            ? "bg-emerald-500/10 text-emerald-600"
                            : sug.confidence >= 0.4
                              ? "bg-amber-500/10 text-amber-600"
                              : "bg-zinc-500/10 text-gray-500 dark:text-zinc-500"
                        }`}
                      >
                        {Math.round(sug.confidence * 100)}%
                      </Chip>
                      <ArrowRight size={14} className="text-gray-500 dark:text-zinc-400 group-hover:text-emerald-500 group-hover:translate-x-1 transition-all" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Buscador manual de productos existentes */}
            <div className="mt-6">
              <div className="flex items-center gap-2 mb-2">
                <Search size={12} className="text-blue-500" aria-hidden="true" />
                <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-600 dark:text-zinc-400">
                  ¿El producto ya existe? Buscalo aqui:
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Autocomplete
                  key={currentIdx}
                  aria-label="Buscar producto existente"
                  placeholder="Escribe codigo o nombre del producto..."
                  defaultItems={products}
                  selectedKey={manualSearchKey}
                  onSelectionChange={handleAssignToManual}
                  size="lg"
                  classNames={{
                    base: "w-full",
                    listboxWrapper: "max-h-[250px]",
                    selectorButton: "text-gray-500 dark:text-zinc-500",
                  }}
                  inputProps={{
                    classNames: {
                      inputWrapper: "h-14 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 rounded-2xl shadow-inner",
                      input: "font-medium text-sm text-zinc-900 dark:text-zinc-100",
                    }
                  }}
                  popoverProps={{
                    classNames: {
                      content: "p-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 shadow-2xl",
                    }
                  }}
                >
                  {(item) => (
                    <AutocompleteItem key={item.barcode} textValue={`${item.productName} - ${item.barcode}`}>
                      <div className="flex flex-col py-1">
                        <span className="text-sm font-medium uppercase text-zinc-900 dark:text-zinc-100">{item.productName}</span>
                        <span className="text-[10px] font-mono text-gray-500 dark:text-zinc-500">#{item.barcode}</span>
                      </div>
                    </AutocompleteItem>
                  )}
                </Autocomplete>
                <Button
                  isIconOnly
                  aria-label="Escanear codigo de barras para asignar"
                  onPress={() => setIsScannerOpen(true)}
                  className="h-14 w-14 shrink-0 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 rounded-2xl text-gray-500 dark:text-zinc-500 hover:text-emerald-500 hover:border-emerald-500/50 transition-all shadow-inner"
                >
                  <Camera size={22} aria-hidden="true" />
                </Button>
              </div>
            </div>

            {/* CTA principal: abrir Protocolo de nuevo producto */}
            <div className="mt-6 pt-4 border-t border-dashed border-zinc-200 dark:border-white/10">
              <Button
                onPress={handleOpenProtocol}
                size="lg"
                className="w-full h-14 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-bold text-[11px] uppercase tracking-[0.2em] rounded-2xl shadow-[0_8px_30px_rgba(59,130,246,0.25)]"
                startContent={<PlusCircle size={18} strokeWidth={2.5} aria-hidden="true" />}
              >
                + Abrir Protocolo de Nuevo Producto
              </Button>
              <p className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest text-center mt-2">
                Pre-cargado con nombre, costo, impuestos y descuento detectados
              </p>
            </div>
          </ModalBody>

          <ModalFooter className="flex justify-between items-center gap-2">
            <div className="flex items-center gap-2">
              <Button
                variant="light"
                onPress={handleGoBack}
                isDisabled={currentIdx === 0}
                startContent={<ArrowLeft size={14} aria-hidden="true" />}
                className="text-[10px] font-medium uppercase tracking-widest text-gray-500 dark:text-zinc-500"
              >
                Volver
              </Button>
              <Button
                variant="light"
                onPress={handleSkip}
                startContent={<SkipForward size={14} aria-hidden="true" />}
                className="text-[10px] font-medium uppercase tracking-widest text-gray-500 dark:text-zinc-500"
              >
                Saltar
              </Button>
            </div>
            <Button
              variant="light"
              onPress={() => onOpenChange(false)}
              startContent={<X size={14} aria-hidden="true" />}
              className="text-[10px] font-medium uppercase tracking-widest text-gray-500 dark:text-zinc-500"
            >
              Cancelar
            </Button>
          </ModalFooter>
        </>
      </ModalContent>
      {isScannerOpen && (
        <ScannerOverlay
          isOpen={isScannerOpen}
          onClose={() => setIsScannerOpen(false)}
          onResult={handleScanResult}
          title="ESCANEAR PARA ASIGNAR"
        />
      )}
      {/*
        Diálogo de confirmación "Rename-and-link".

        Se abre al enlazar un producto EXISTENTE (sugerencia, búsqueda manual
        o escáner). NO se abre para productos recién creados vía Protocolo
        — esos ya fueron bautizados en el ProductFormModal y la rama
        `externalResolution` avanza por su cuenta.

        El diálogo es blocante (nunca se descarta por click fuera) mientras
        el PUT está en curso para no quedar en estado inconsistente. Las
        tres acciones:
          · "Solo enlazar"               → scheduleAliasSave + advanceTo
          · "Actualizar nombre y enlazar" → onRenameProduct → éxito: idem
                                            · falla: mantener diálogo abierto
          · "Volver"                     → cerrar sin cambios
      */}
      <AlertDialog
        open={pendingLink !== null}
        onOpenChange={(open) => {
          if (!open) handleCancelRename();
        }}
      >
        <AlertDialogContent
          aria-describedby="unmatched-rename-desc"
          className={cn(
            'bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50',
            'border border-blue-500/40 dark:border-blue-500/40',
            'rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]',
            'max-w-lg',
          )}
        >
          <AlertDialogHeader>
            <div className="flex items-start gap-3">
              <div
                className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-blue-500/15 text-blue-600 dark:text-blue-400"
                aria-hidden="true"
              >
                <Link2 size={20} />
              </div>
              <div className="min-w-0">
                <AlertDialogTitle className="text-base font-medium uppercase tracking-tight text-zinc-900 dark:text-zinc-50">
                  Enlazar con producto existente
                </AlertDialogTitle>
                <AlertDialogDescription
                  id="unmatched-rename-desc"
                  className="mt-1 text-sm text-zinc-600 dark:text-zinc-300"
                >
                  Confirma si quieres solo enlazar este producto o también
                  actualizar su nombre en el catálogo con el de la factura.
                  Nada se guarda sin tu confirmación.
                </AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>

          {pendingLink && (
            <div className="mt-1 grid gap-3">
              <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-3 dark:border-white/10 dark:bg-zinc-900">
                <p className="text-[10px] font-medium uppercase tracking-widest text-gray-500 dark:text-zinc-500">
                  Nombre actual del producto
                </p>
                <p className="mt-1 break-words text-sm font-medium text-zinc-900 dark:text-zinc-50">
                  {pendingLink.product.productName || '— sin nombre —'}
                </p>
                <p className="mt-1 font-mono text-[11px] text-gray-500 dark:text-zinc-500">
                  {pendingLink.product.barcode}
                </p>
              </div>

              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-[10px] font-medium uppercase tracking-widest text-amber-600 dark:text-amber-400">
                  Nombre en la factura (OCR)
                </p>
                <p className="mt-1 break-words text-sm font-medium text-zinc-900 dark:text-zinc-50">
                  {pendingLink.item.invoiceName}
                </p>
              </div>

              <div className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-3">
                <label
                  htmlFor="unmatched-rename-input"
                  className="text-[10px] font-medium uppercase tracking-widest text-blue-600 dark:text-blue-400"
                >
                  Nombre que se guardaría si eliges "Actualizar nombre y enlazar"
                </label>
                <Input
                  id="unmatched-rename-input"
                  value={draftName}
                  onChange={(e) => {
                    setDraftName(e.target.value);
                    if (renameError) setRenameError(null);
                  }}
                  disabled={isRenaming}
                  autoFocus
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode="text"
                  maxLength={120}
                  aria-invalid={renameError ? 'true' : 'false'}
                  aria-describedby={renameError ? 'unmatched-rename-error' : undefined}
                  className={cn(
                    'mt-2 h-12 w-full text-base font-medium uppercase',
                    'bg-white dark:bg-[#121214]',
                    'border-blue-500/30 dark:border-blue-500/40',
                    'focus-visible:ring-blue-500',
                  )}
                  style={{ textTransform: 'uppercase' }}
                />
                {renameError && (
                  <p
                    id="unmatched-rename-error"
                    role="alert"
                    className="mt-2 text-xs font-medium text-rose-600 dark:text-rose-400"
                  >
                    {renameError}
                  </p>
                )}
                <p className="mt-2 text-[10px] text-gray-500 dark:text-zinc-500">
                  Se enviará como PUT a <code className="font-mono">/products/update-products/{pendingLink.product.barcode}</code>.
                  Si falla, el diálogo se mantiene abierto y nada se enlaza.
                </p>
              </div>
            </div>
          )}

          <AlertDialogFooter className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-2">
            <AlertDialogCancel
              disabled={isRenaming}
              onClick={(event) => {
                // Radix cierra por sí mismo; preventDefault es defensivo
                // para que no cerremos mientras `isRenaming` esté activo.
                if (isRenaming) {
                  event.preventDefault();
                  return;
                }
                handleCancelRename();
              }}
              className={cn(
                'h-11 min-w-[120px] rounded-2xl',
                'border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-100',
                'dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-white/5',
              )}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              <span>Volver</span>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isRenaming || !pendingLink}
              onClick={(event) => {
                // Mantener el AlertDialog abierto hasta que terminemos de
                // avanzar — luego cerramos manualmente con
                // closeRenamePrompt() desde handleLinkOnly.
                event.preventDefault();
                handleLinkOnly();
              }}
              className={cn(
                'h-11 min-w-[140px] rounded-2xl',
                'border border-emerald-500/30 bg-white text-emerald-600',
                'hover:bg-emerald-500/10 hover:text-emerald-700',
                'dark:border-emerald-500/40 dark:bg-zinc-900 dark:text-emerald-400 dark:hover:bg-emerald-500/10',
                'disabled:opacity-60',
              )}
            >
              <Link2 size={14} aria-hidden="true" />
              <span>Solo enlazar</span>
            </AlertDialogAction>
            <AlertDialogAction
              disabled={isRenaming || !pendingLink}
              aria-busy={isRenaming}
              onClick={(event) => {
                event.preventDefault();
                void handleRenameAndLink();
              }}
              className={cn(
                'h-11 min-w-[200px] rounded-2xl',
                'bg-blue-600 text-white hover:bg-blue-500',
                'focus-visible:ring-blue-500 disabled:opacity-60',
              )}
            >
              {isRenaming ? (
                <>
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  <span>Actualizando…</span>
                </>
              ) : (
                <>
                  <Pencil size={14} aria-hidden="true" />
                  <span>Actualizar nombre y enlazar</span>
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Modal>
  );
}

// Re-export para que tests y otros consumidores puedan generar ids locales
// sin importar directamente del `.mjs` cuando ya tienen el .tsx referenciado.
export { makeOcrLocalId };
