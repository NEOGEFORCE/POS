"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Cookies from "js-cookie";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Package,
  RefreshCw,
  Search,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Truck,
  X,
} from "lucide-react";
import { Autocomplete, AutocompleteItem, Button, Card, CardBody, Input, Skeleton, Switch } from "@heroui/react";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/lib/auth";
import { API_URL } from "@/lib/constants";
import { Supplier } from "@/lib/definitions";
import { formatPrice } from "@/lib/utils";
// Reglas de envío del pedido (valor a mano, pedido sin desglosar). Viven en un
// .mjs aparte para poder probarlas con `node --test`; el espejo en Go está en
// restock_handler.go (validateConfirmOrder / declaredOrderValue).
import {
  buildConfirmItems,
  canConfirmOrder,
  formatOrderValueInput,
  normalizeOrderValueInput,
  parseOrderValue,
  resolveOrderTotal,
} from "@/lib/order-submission.mjs";
import { useToast } from "@/hooks/use-toast";
import { SupplierScheduleCompare } from "./components/SupplierScheduleCompare";
import { IncrementalSuggestionList } from "./components/VirtualizedSuggestionList";
import { ProductSupplierLinkDialog } from "./components/ProductSupplierLinkDialog";
import { OrderCartModal } from "./components/OrderCartModal";
import { SupplierScheduleEditor } from "./components/SupplierScheduleEditor";
import {
  ABCCategory,
  RestockSuggestion,
  useSmartRestock,
} from "./hooks/useSmartRestock";
import {
  buildProductSupplierLinkPayload,
  buildSupplierSchedulePayload,
} from "@/lib/orders-admin-actions.mjs";
import type { SupplierSchedulePayload } from "@/lib/orders-admin-actions.mjs";
import {
  addDaysBogotaIso,
  describeLeadTimeSource,
  groupSuggestionsBySupplier,
  isSupplierFilterActive,
  resolveExpectedDeliveryDate,
  summarizeGroupSchedule,
  summarizeSupplierAgenda,
} from "@/lib/order-scheduling.mjs";

type CategoryFilter = "ALL" | ABCCategory;

// Debounce del buscador. 300 ms es el punto de equilibrio: rapido para el
// dueno pero no le manda al backend una peticion por cada tecla en celular.
const SEARCH_DEBOUNCE_MS = 300;
const INITIAL_RENDER_LIMIT = 24;
const RENDER_INCREMENT = 24;

interface GroupForm {
  expectedDate: string;
  invoiceRef: string;
  /**
   * Valor del pedido escrito a mano, como texto para no pelear con el input
   * mientras el operador escribe. Permite enviar un pedido SIN desglosar los
   * productos: el preventista pasa, acuerdan un monto y lo que hay que dejar
   * registrado es el compromiso con el proveedor y la fecha en que llega.
   * Vacío significa "calcular el total a partir de los productos".
   */
  orderValue: string;
}

interface SuggestionGroup {
  key: string;
  supplierId: number | null;
  supplierName: string;
  items: RestockSuggestion[];
}

interface ConfirmOrderItem {
  product_id: string;
  barcode: string;
  quantity: number;
  unit_cost: number;
}

interface ConfirmOrderPayload {
  supplier_id: number;
  expected_date: string;
  invoice_ref: string;
  items: ConfirmOrderItem[];
  estimated_total: number;
  real_invoice_total: number;
  confirmed_by: string;
  edit_order_id: string;
  allow_in_transit: boolean;
}

interface TransitWarningProduct {
  productId: string;
  productName: string;
  quantity: number;
}

interface TransitWarningResponse {
  code?: string;
  products?: TransitWarningProduct[];
}

interface PendingOrderItem {
  productId?: string;
  product_id?: string;
  quantity: number;
}

interface PendingOrder {
  supplierId?: number;
  supplier_id?: number;
  expectedDate?: string;
  expected_date?: string;
  invoiceRef?: string;
  invoice_ref?: string;
  /**
   * Totales guardados del pedido. Se usan al editar un pedido que se registró
   * SIN desglosar productos: en ese caso el valor es el único contenido del
   * pedido y hay que devolverlo al formulario para no perderlo.
   */
  estimatedTotal?: number;
  estimated_total?: number;
  realInvoiceTotal?: number;
  real_invoice_total?: number;
  items: PendingOrderItem[];
}

const categoryStyles: Record<ABCCategory, string> = {
  A: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300",
  B: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  C: "border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300",
};

const categoryLabels: Record<ABCCategory, string> = {
  A: "Alta rotación",
  B: "Rotación media",
  C: "Baja rotación",
};

// Compara sin acentos ni mayúsculas para que "alqueria" encuentre "ALQUERÍA".
function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

interface MissingItemReport {
  id: number;
  product_name: string;
  status: string;
  reported_by: string;
  note: string;
  created_at: string;
  reporter?: { name?: string };
}

function authHeaders(): HeadersInit {
  const token = Cookies.get("org-pos-token") ?? "";
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function readError(response: Response, fallback: string): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  if (payload && typeof payload === "object" && "error" in payload) {
    const message = (payload as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function dateAfter(days: number): string {
  return addDaysBogotaIso(new Date(), days);
}

// Convierte "YYYY-MM-DD" a un texto legible en espanol, en zona Bogota.
function formatIsoDateEs(iso: string | null | undefined): string {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "";
  // Ancla al mediodia UTC para que la conversion a Bogota (UTC-5) caiga en
  // el mismo dia calendario que el string original.
  const anchor = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(anchor);
}

function SmartRestockContent() {
  const { user } = useAuth();
  const role = (user?.role ?? user?.Role ?? "").toLocaleLowerCase("es");
  const isAdmin = ["admin", "administrador", "superadmin"].includes(role);
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const editOrderId = searchParams.get("edit_order") ?? "";
  const initialSupplier = searchParams.get("supplier") ?? "unassigned";
  const [selectedSupplier, setSelectedSupplier] = useState(initialSupplier);
  const [category, setCategory] = useState<CategoryFilter>("ALL");

  // Busqueda server-side: la caja recibe el texto crudo, y un debounce de
  // ~300 ms manda al backend el valor estabilizado. La lista NO se vuelve a
  // filtrar en memoria (guardado por tests/orders-search-serverside.test.mjs).
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // La preferencia se lee en el inicializador para construir una sola key SWR;
  // un useEffect posterior provocaba dos fetches (false y luego true).
  const [includeAll, setIncludeAll] = useState(() =>
    typeof window !== "undefined" && window.localStorage.getItem("pos_orders_include_all") === "true"
  );
  const toggleIncludeAll = useCallback((next: boolean) => {
    setIncludeAll(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("pos_orders_include_all", String(next));
    }
  }, []);

  const [forms, setForms] = useState<Record<string, GroupForm>>({});
  const [submittingGroup, setSubmittingGroup] = useState<string | null>(null);
  // Carrito de revisión: muestra sólo lo que tiene cantidad puesta.
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const editLoaded = useRef(false);

  // ---------------------------------------------------------------------------
  // AVISO DE MERCANCÍA YA PEDIDA
  // ---------------------------------------------------------------------------
  // Cuando el backend responde 409 porque uno o más productos ya vienen en
  // camino, hay que preguntarle al operador si quiere pedir cantidad adicional.
  //
  // Antes se usaba window.confirm(), que abre el cuadro gris del navegador con
  // la IP del servidor en el título ("192.168.1.6:3000 dice"). Además de verse
  // ajeno al POS, aplasta la lista de productos en un bloque de texto plano.
  //
  // Ahora se resuelve con un modal propio. window.confirm era síncrono y
  // bloqueante, así que para que confirmGroup pueda seguir esperando la
  // respuesta con un await, se guarda el `resolve` de una promesa en el estado
  // y el modal lo llama al aceptar o cancelar.
  const [transitPrompt, setTransitPrompt] = useState<{
    products: TransitWarningProduct[];
    resolve: (accepted: boolean) => void;
  } | null>(null);

  const askTransitConfirmation = useCallback(
    (products: TransitWarningProduct[]) => new Promise<boolean>((resolve) => {
      setTransitPrompt({ products, resolve });
    }),
    []
  );

  const answerTransitPrompt = useCallback((accepted: boolean) => {
    setTransitPrompt((current) => {
      current?.resolve(accepted);
      return null;
    });
  }, []);

  const { data: suppliers = [], mutate: mutateSuppliers } = useApi<Supplier[]>("/suppliers/all-suppliers");

  // Huérfanos sigue preseleccionado como modo operativo, pero las opciones
  // especiales quedan debajo de los proveedores reales para elegir rápido.
  const supplierOptions = useMemo(() => {
    const options = suppliers
      .map((supplier) => ({ key: String(supplier.id), label: supplier.name ?? "" }))
      .filter((option) => option.label.trim() !== "")
      .sort((left, right) => left.label.localeCompare(right.label, "es"));
    return [
      ...options,
      { key: "unassigned", label: "Sin proveedor · por vincular" },
      { key: "global", label: "Todos los proveedores" },
    ];
  }, [suppliers]);

  const [supplierQuery, setSupplierQuery] = useState("");

  // HeroUI sólo filtra solo cuando se usa defaultItems. Al pasar items
  // controlados el filtrado corre por nuestra cuenta.
  const filteredSupplierOptions = useMemo(() => {
    const query = normalizeForSearch(supplierQuery);
    if (!query) return supplierOptions;
    return supplierOptions.filter((option) => normalizeForSearch(option.label).includes(query));
  }, [supplierOptions, supplierQuery]);

  // Faltantes que reportan los cajeros desde la pantalla de ventas.
  const { data: missingItemsData = [], mutate: mutateMissingItems } =
    useApi<MissingItemReport[]>("/missing-items");
  const pendingMissingItems = useMemo(
    () => missingItemsData.filter((item) => (item.status ?? "").toUpperCase() === "PENDIENTE"),
    [missingItemsData]
  );
  const [resolvingMissingItem, setResolvingMissingItem] = useState<number | null>(null);

  const resolveMissingItem = useCallback(async (id: number) => {
    setResolvingMissingItem(id);
    try {
      const response = await fetch(`${API_URL}/admin/missing-items/status`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ id, status: "ADQUIRIDO" }),
      });
      if (!response.ok) throw new Error(await readError(response, "No se pudo quitar el faltante"));
      await mutateMissingItems();
      toast({ title: "Faltante resuelto", description: "Salió de la lista de pedidos", variant: "success" });
    } catch (caught: unknown) {
      toast({
        title: "Error",
        description: caught instanceof Error ? caught.message : "No se pudo quitar el faltante",
        variant: "destructive",
      });
    } finally {
      setResolvingMissingItem(null);
    }
  }, [mutateMissingItems, toast]);

  // NO se refleja el proveedor activo en el texto del campo.
  //
  // Antes un efecto escribía la etiqueta del seleccionado en supplierQuery, y
  // como ese mismo texto alimenta el filtro de la lista, el desplegable se
  // reducía a UNA sola opción: la ya seleccionada. Con el arranque en
  // "Sin proveedor" el resultado era que los proveedores reales no aparecían y
  // no se podía elegir ni escribir ninguno.
  //
  // Ahora supplierQuery representa SÓLO lo que el usuario tecleó. El campo
  // llega vacío con su placeholder, así que se puede escribir de inmediato, y
  // al abrirlo se ven todos los proveedores. Qué vista está activa lo dice la
  // tarjeta de resultados, que ya trae el nombre del proveedor en su cabecera.

  const isUnassignedMode = selectedSupplier === "unassigned";
  const effectiveIncludeAll = isUnassignedMode || includeAll;

  // Etiqueta legible de la vista activa. El campo del selector queda vacío para
  // poder teclear de inmediato, así que este texto es el que informa qué se está
  // mirando.
  const activeSupplierLabel = useMemo(() => {
    const match = supplierOptions.find((option) => option.key === selectedSupplier);
    return match?.label ?? "Sin proveedor · por vincular";
  }, [supplierOptions, selectedSupplier]);

  const {
    suggestions,
    error,
    isLoading,
    isValidating,
    mutate,
    categorized,
    orderQuantities,
    setQuantity,
    resetToSuggestions,
    clearAll,
    clearProducts,
    orderTotal,
    orderItemCount,
    selectedItems,
  } = useSmartRestock(selectedSupplier, {
    search: debouncedSearch,
    includeAll: effectiveIncludeAll,
    unassignedOnly: isUnassignedMode,
  });

  // Estado "buscando en el servidor" para dar feedback visible. isValidating de
  // SWR es la senal correcta cuando ya habia data cargada; isLoading solo es
  // true en la primera carga.
  const isSearching = Boolean(debouncedSearch) && (isLoading || isValidating);
  const searchDeferred = searchInput.trim() !== debouncedSearch;

  // Guarda el mínimo del producto. El semáforo depende de este valor, así que se
  // revalidan las sugerencias en cuanto el backend confirma.
  const saveMinStock = useCallback(async (productId: string, minStock: number): Promise<boolean> => {
    try {
      const response = await fetch(
        `${API_URL}/products/update-min-stock/${encodeURIComponent(productId)}`,
        { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ minStock }) }
      );
      if (!response.ok) throw new Error(await readError(response, "No se pudo guardar el stock mínimo"));
      await mutate();
      toast({ title: "Stock mínimo actualizado", description: `Nuevo mínimo: ${minStock}`, variant: "success" });
      return true;
    } catch (caught: unknown) {
      toast({
        title: "Error",
        description: caught instanceof Error ? caught.message : "No se pudo guardar el stock mínimo",
        variant: "destructive",
      });
      return false;
    }
  }, [mutate, toast]);

  // Desasociar es destructivo desde el punto de vista del catálogo, así que se
  // confirma antes de ejecutar.
  const [unlinkTarget, setUnlinkTarget] = useState<RestockSuggestion | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  const requestUnlink = useCallback((item: RestockSuggestion) => {
    setUnlinkTarget(item);
  }, []);

  const confirmUnlink = useCallback(async () => {
    if (!unlinkTarget?.primarySupplierId) return;
    setUnlinking(true);
    try {
      const response = await fetch(
        `${API_URL}/inventory/products/${encodeURIComponent(unlinkTarget.productId)}/unlink-supplier`,
        {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify({ supplierId: unlinkTarget.primarySupplierId }),
        }
      );
      if (!response.ok) throw new Error(await readError(response, "No se pudo quitar el producto del proveedor"));
      clearProducts([unlinkTarget.productId]);
      await mutate();
      toast({
        title: "Producto desasociado",
        description: `${unlinkTarget.productName} ya no pertenece a ${unlinkTarget.supplierName}`,
        variant: "success",
      });
      setUnlinkTarget(null);
    } catch (caught: unknown) {
      toast({
        title: "Error",
        description: caught instanceof Error ? caught.message : "No se pudo quitar el producto del proveedor",
        variant: "destructive",
      });
    } finally {
      setUnlinking(false);
    }
  }, [clearProducts, mutate, toast, unlinkTarget]);

  const activeSuppliers = useMemo(
    () => suppliers.filter((supplier) => {
      const status = (supplier.status ?? "").toLocaleLowerCase("es");
      return supplier.isActive !== false && status !== "inactivo";
    }),
    [suppliers],
  );

  const [linkTarget, setLinkTarget] = useState<RestockSuggestion | null>(null);
  const [linkingSupplier, setLinkingSupplier] = useState(false);

  const saveSupplierLink = useCallback(async (supplierId: number) => {
    if (!linkTarget) return;
    setLinkingSupplier(true);
    try {
      const response = await fetch(
        `${API_URL}/inventory/products/${encodeURIComponent(linkTarget.productId)}/link-supplier`,
        {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify(buildProductSupplierLinkPayload(supplierId)),
        },
      );
      if (!response.ok) throw new Error(await readError(response, "No se pudo vincular el proveedor"));
      const productName = linkTarget.productName;
      clearProducts([linkTarget.productId]);
      setLinkTarget(null);
      await mutate();
      toast({
        title: "Proveedor vinculado",
        description: `${productName} salió de la lista de productos pendientes por vincular.`,
        variant: "success",
      });
    } catch (caught: unknown) {
      toast({
        title: "Error",
        description: caught instanceof Error ? caught.message : "No se pudo vincular el proveedor",
        variant: "destructive",
      });
    } finally {
      setLinkingSupplier(false);
    }
  }, [clearProducts, linkTarget, mutate, toast]);

  const [scheduleTarget, setScheduleTarget] = useState<Supplier | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);

  const openScheduleEditor = useCallback((group: SuggestionGroup) => {
    if (!isAdmin || !group.supplierId) return;
    const current = suppliers.find((supplier) => Number(supplier.id) === group.supplierId);
    if (current) {
      setScheduleTarget(current);
      return;
    }
    const sample = group.items[0];
    setScheduleTarget({
      id: group.supplierId,
      name: group.supplierName,
      visitDays: sample?.visitDays ?? [],
      deliveryDays: sample?.deliveryDays ?? [],
      leadTimeDays: null,
    });
  }, [isAdmin, suppliers]);

  const saveSupplierSchedule = useCallback(async (draft: SupplierSchedulePayload) => {
    if (!isAdmin || !scheduleTarget) return;
    setSavingSchedule(true);
    try {
      const payload = buildSupplierSchedulePayload(draft);
      const response = await fetch(`${API_URL}/admin/suppliers/${encodeURIComponent(scheduleTarget.id)}/schedule`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await readError(response, "No se pudo guardar la agenda"));
      await Promise.all([mutateSuppliers(), mutate()]);
      toast({
        title: "Agenda actualizada",
        description: `Se guardó la agenda manual de ${scheduleTarget.name}.`,
        variant: "success",
      });
      setScheduleTarget(null);
    } catch (caught: unknown) {
      toast({
        title: "Error",
        description: caught instanceof Error ? caught.message : "No se pudo guardar la agenda",
        variant: "destructive",
      });
    } finally {
      setSavingSchedule(false);
    }
  }, [isAdmin, mutate, mutateSuppliers, scheduleTarget, toast]);

  useEffect(() => {
    if (!editOrderId || editLoaded.current || suggestions.length === 0) return;
    editLoaded.current = true;
    void (async () => {
      const response = await fetch(
        `${API_URL}/inventory/receive/pending/${encodeURIComponent(editOrderId)}`,
        { headers: authHeaders(), cache: "no-store" }
      );
      if (!response.ok) {
        toast({ title: "Error", description: "No se pudo cargar el pedido para edición", variant: "destructive" });
        return;
      }
      const order = await response.json() as PendingOrder;
      const supplierId = order.supplierId ?? order.supplier_id;
      if (supplierId && selectedSupplier !== String(supplierId)) {
        setSelectedSupplier(String(supplierId));
        editLoaded.current = false;
        return;
      }
      for (const item of order.items ?? []) {
        const productId = item.productId ?? item.product_id;
        if (productId) setQuantity(productId, Number(item.quantity) || 0);
      }
      if (supplierId) {
        const key = String(supplierId);
        // Un pedido sin ítems se registró solo con su valor: hay que
        // devolverlo al campo para que al guardar no se pierda. Si el pedido
        // tiene ítems, el campo queda vacío y el total se recalcula de ellos.
        const savedTotal = order.realInvoiceTotal ?? order.real_invoice_total
          ?? order.estimatedTotal ?? order.estimated_total ?? 0;
        const hasSavedItems = (order.items ?? []).length > 0;
        setForms((current) => ({
          ...current,
          [key]: {
            expectedDate: (order.expectedDate ?? order.expected_date ?? "").slice(0, 10),
            invoiceRef: order.invoiceRef ?? order.invoice_ref ?? "",
            orderValue: !hasSavedItems && savedTotal > 0 ? String(Math.round(savedTotal)) : "",
          },
        }));
      }
    })().catch(() => {
      toast({ title: "Error", description: "No se pudo cargar el pedido para edición", variant: "destructive" });
    });
  }, [editOrderId, selectedSupplier, setQuantity, suggestions.length, toast]);

  const allGroups = useMemo(
    () => groupSuggestionsBySupplier(suggestions, selectedSupplier) as SuggestionGroup[],
    [suggestions, selectedSupplier],
  );

  // Nota importante: la busqueda NO se aplica aca. El backend ya devolvio
  // la lista recortada por el parametro `search` de la URL. El unico filtro
  // que sigue siendo local es el ABC, porque opera sobre la respuesta
  // recortada y no vale la pena una peticion mas por eso. Ver
  // tests/orders-search-serverside.test.mjs para el guardian estatico.
  const visibleGroups = useMemo(() => allGroups.map((group) => ({
    ...group,
    items: group.items.filter((item) => category === "ALL" || item.abcCategory === category),
  })).filter((group) => group.items.length > 0), [allGroups, category]);

  // Presupuesto GLOBAL de DOM: incluso la vista secundaria "Todos" monta
  // inicialmente sólo 24 tarjetas sumando todos los proveedores.
  const [visibleProductLimit, setVisibleProductLimit] = useState(INITIAL_RENDER_LIMIT);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const visibleProductsSignature = useMemo(
    () => visibleGroups.flatMap((group) => group.items.map((item) => item.productId)).join("\u001f"),
    [visibleGroups],
  );
  useEffect(() => {
    setVisibleProductLimit(INITIAL_RENDER_LIMIT);
  }, [visibleProductsSignature]);

  const totalVisibleProducts = useMemo(
    () => visibleGroups.reduce((total, group) => total + group.items.length, 0),
    [visibleGroups],
  );
  const incrementalGroups = useMemo(() => {
    let remaining = visibleProductLimit;
    const limited: SuggestionGroup[] = [];
    for (const group of visibleGroups) {
      if (remaining <= 0) break;
      const items = group.items.slice(0, remaining);
      if (items.length > 0) limited.push({ ...group, items });
      remaining -= items.length;
    }
    return limited;
  }, [visibleGroups, visibleProductLimit]);
  const mountedProductCount = Math.min(visibleProductLimit, totalVisibleProducts);
  const hasMoreProducts = mountedProductCount < totalVisibleProducts;
  const loadMoreProducts = useCallback(() => {
    setVisibleProductLimit((current) => Math.min(totalVisibleProducts, current + RENDER_INCREMENT));
  }, [totalVisibleProducts]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel || !hasMoreProducts || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreProducts();
      },
      { root: null, rootMargin: "360px 0px", threshold: 0.01 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreProducts, loadMoreProducts]);

  const getForm = useCallback((group: SuggestionGroup): GroupForm => {
    const current = forms[group.key];
    if (current) return current;
    const resolved = resolveExpectedDeliveryDate(group.items);
    return { expectedDate: resolved.isoDate, invoiceRef: "", orderValue: "" };
  }, [forms]);

  const updateForm = useCallback((key: string, patch: Partial<GroupForm>) => {
    setForms((current) => ({
      ...current,
      [key]: {
        expectedDate: current[key]?.expectedDate ?? dateAfter(7),
        invoiceRef: current[key]?.invoiceRef ?? "",
        orderValue: current[key]?.orderValue ?? "",
        ...patch,
      },
    }));
  }, []);

  const confirmGroup = useCallback(async (group: SuggestionGroup) => {
    if (!group.supplierId) {
      toast({ title: "Proveedor requerido", description: "Asigna un proveedor antes de confirmar el pedido", variant: "destructive" });
      return;
    }
    // EL PEDIDO SE ARMA CON TODO LO SELECCIONADO, NO CON LO VISIBLE.
    //
    // Antes esto era `group.items.flatMap(...)`. La busqueda de esta pantalla es
    // del lado del servidor: al escribir, el backend devuelve solo las
    // coincidencias y los grupos se construyen desde esa respuesta recortada.
    // Resultado: si el dueno cargaba 12 productos y despues buscaba el numero
    // 13, al enviar salia UNO SOLO y los otros 12 se perdian sin aviso.
    //
    // `selectedItems` viene del hook y ya sobrevive al filtro gracias a las
    // fotos de cada producto elegido; es la unica fuente fiable de "que pedi".
    const items: ConfirmOrderItem[] = buildConfirmItems({
      selectedItems,
      groupSupplierId: group.supplierId,
      supplierFilterActive: isSupplierFilterActive(selectedSupplier),
    });

    const form = getForm(group);
    const itemsTotal = items.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0);
    const declaredValue = parseOrderValue(form.orderValue);

    // Un pedido puede ir de dos formas:
    //   (a) Con productos desglosados: el total sale de las cantidades y
    //       costos, y el valor escrito a mano lo puede corregir si el
    //       preventista cerró en otro número.
    //   (b) SIN productos, solo con el valor. Queda registrado el compromiso y
    //       la fecha de llegada, que es lo que el dueño necesita para prever la
    //       plata. El backend valida lo mismo (validateConfirmOrder).
    if (items.length === 0 && declaredValue <= 0) {
      toast({
        title: "Pedido vacío",
        description: "Pon cantidades a los productos o escribe el valor del pedido",
        variant: "destructive",
      });
      return;
    }

    const total = resolveOrderTotal(itemsTotal, declaredValue);
    const payload: ConfirmOrderPayload = {
      supplier_id: group.supplierId,
      expected_date: form.expectedDate,
      invoice_ref: form.invoiceRef,
      items,
      estimated_total: total,
      real_invoice_total: total,
      confirmed_by: user?.name ?? "Usuario POS",
      edit_order_id: editOrderId,
      allow_in_transit: false,
    };

    setSubmittingGroup(group.key);
    try {
      let response = await fetch(`${API_URL}/inventory/restock/confirm`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });

      if (response.status === 409) {
        const warning = await response.json() as TransitWarningResponse;
        if (warning.code === "PRODUCTS_IN_TRANSIT_CONFIRMATION_REQUIRED") {
          const products = warning.products ?? [];
          // Antes esto era un window.confirm(), el cuadro gris del navegador
          // que muestra la IP del servidor ("192.168.1.6:3000 dice"). Ahora se
          // pregunta con un modal propio, en el idioma visual del POS y con la
          // lista de productos legible.
          const shouldContinue = await askTransitConfirmation(products);
          if (!shouldContinue) {
            toast({
              title: "Pedido no enviado",
              description: "Se conservaron las cantidades para que puedas revisarlas.",
            });
            return;
          }
          payload.allow_in_transit = true;
          response = await fetch(`${API_URL}/inventory/restock/confirm`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(payload),
          });
        }
      }

      if (!response.ok) throw new Error(await readError(response, "No se pudo confirmar el pedido"));
      clearProducts(items.map((item) => item.product_id));
      toast({
        title: "Pedido confirmado",
        description: items.length > 0
          ? `${items.length} productos enviados a ${group.supplierName}`
          : `Pedido por ${formatPrice(total)} registrado a ${group.supplierName}`,
        variant: "success",
      });
      // Siempre se sale a inventario: quedarse en la lista invitaba a volver a
      // pedir lo mismo antes de que la pantalla reflejara lo que ya va en camino.
      router.push("/inventory");
    } catch (caught: unknown) {
      toast({
        title: "Error",
        description: caught instanceof Error ? caught.message : "No se pudo confirmar el pedido",
        variant: "destructive",
      });
    } finally {
      setSubmittingGroup(null);
    }
  }, [askTransitConfirmation, clearProducts, editOrderId, getForm, selectedItems, selectedSupplier, router, toast, user?.name]);

  const recalculate = useCallback(async () => {
    setRecalculating(true);
    try {
      const response = await fetch(`${API_URL}/admin/run-nightly-restock`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!response.ok) throw new Error(await readError(response, "Falló el recálculo"));
      await mutate();
      toast({ title: "Radar actualizado", description: "Las métricas V2 se recalcularon correctamente", variant: "success" });
    } catch (caught: unknown) {
      toast({
        title: "Error",
        description: caught instanceof Error ? caught.message : "Falló el recálculo",
        variant: "destructive",
      });
    } finally {
      setRecalculating(false);
    }
  }, [mutate, toast]);

  return (
    <main className="bg-zinc-50 px-3 pb-10 pt-4 dark:bg-zinc-950 md:px-6 md:pt-6">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-4">
        {orderItemCount > 0 && (
          <aside className="sticky top-0 z-40 -mx-1 flex items-center justify-between gap-3 rounded-xl border border-emerald-500/40 bg-white px-3 py-2 shadow-md dark:bg-zinc-950">
            <div className="flex items-center gap-2">
              <div className="grid h-7 w-7 place-items-center rounded-lg bg-emerald-500/20 text-xs font-black text-emerald-600 dark:text-emerald-400">
                {orderItemCount}
              </div>
              <p className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
                Orden seleccionada
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-baseline gap-2">
                <p className="text-[9px] font-bold uppercase text-zinc-500">Total</p>
                <p className="text-sm font-black tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatPrice(orderTotal)}
                </p>
              </div>
              {/* CARRITO: lleva SOLO lo que tiene cantidad puesta, para revisar
                  y confirmar sin tener que recorrer toda la lista. */}
              <Button
                size="sm"
                onPress={() => setIsCartOpen(true)}
                aria-label={`Ver el pedido: ${orderItemCount} productos por ${formatPrice(orderTotal)}`}
                className="h-9 rounded-xl bg-emerald-600 px-3 text-[11px] font-bold uppercase tracking-wide text-white transition-transform active:scale-95"
                startContent={<ShoppingCart size={15} />}
              >
                Ver pedido
              </Button>
            </div>
          </aside>
        )}
        <header className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-zinc-900 md:flex-row md:items-center md:justify-between md:p-6">
          <div>
            <div className="flex items-center gap-2">
              <ShoppingBag className="text-amber-500" size={25} />
              <h1 className="text-xl font-black uppercase tracking-tight md:text-2xl">Pedidos inteligentes V2</h1>
            </div>
            <p className="mt-1 text-xs text-zinc-500">Demanda real corregida por agotados, lead time y mercancía en tránsito.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="flat" onPress={resetToSuggestions} startContent={<Sparkles size={15} />}>
              Aplicar sugerencias
            </Button>
            <Button size="sm" variant="flat" color="danger" onPress={clearAll}>Limpiar</Button>
            {isAdmin && (
              <Button
                size="sm"
                color="warning"
                isLoading={recalculating}
                onPress={recalculate}
                startContent={!recalculating && <RefreshCw size={15} />}
              >
                Recalcular
              </Button>
            )}
          </div>
        </header>

        {editOrderId && (
          <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs font-bold text-amber-700 dark:text-amber-300">
            <AlertTriangle size={16} /> Editando pedido {editOrderId}
          </div>
        )}

        {pendingMissingItems.length > 0 && (
          <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="mb-2 flex items-center gap-2">
              <AlertTriangle className="text-amber-500" size={16} />
              <h2 className="text-xs font-black uppercase tracking-wide text-amber-700 dark:text-amber-300">
                Faltantes pedidos por clientes ({pendingMissingItems.length})
              </h2>
            </div>
            <ul className="flex flex-col gap-1.5">
              {pendingMissingItems.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-amber-500/20 bg-white px-2.5 py-1.5 dark:bg-zinc-900"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-bold uppercase">{item.product_name}</p>
                    <p className="truncate text-[10px] text-zinc-500">
                      {item.reporter?.name || item.reported_by || "Caja"}
                      {item.note ? ` · ${item.note}` : ""}
                    </p>
                  </div>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    aria-label={`Quitar ${item.product_name} de la lista`}
                    title="Ya lo pedí, quitar de la lista"
                    isLoading={resolvingMissingItem === item.id}
                    onPress={() => resolveMissingItem(item.id)}
                    className="h-7 w-7 shrink-0 text-rose-500"
                  >
                    {resolvingMissingItem !== item.id && <X size={15} />}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="grid grid-cols-4 gap-1.5 md:gap-2">
          {(["A", "B", "C"] as ABCCategory[]).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={category === value}
              onClick={() => setCategory(category === value ? "ALL" : value)}
              className={`rounded-xl border px-2 py-1.5 text-left leading-tight transition ${category === value ? "ring-2 ring-zinc-900 dark:ring-white" : ""} ${categoryStyles[value]}`}
            >
              <span className="text-[11px] font-black uppercase">Clase {value}</span>
              <span className="block truncate text-[8px] font-bold uppercase tracking-wide opacity-70">{categoryLabels[value]}</span>
              <span className="block text-xs font-black tabular-nums">{categorized[value].length}</span>
            </button>
          ))}
          <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/10 px-2 py-1.5 leading-tight text-indigo-700 dark:text-indigo-300">
            <span className="text-[11px] font-black tabular-nums">{suggestions.length}</span>
            <span className="block truncate text-[8px] font-bold uppercase tracking-wide opacity-70">Analizados</span>
            <span className="block truncate text-[9px]">{isValidating ? "Actualizando…" : "Batch nocturno"}</span>
          </div>
        </section>

        <section className="grid gap-3 rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-white/10 dark:bg-zinc-900 md:grid-cols-[minmax(0,1fr)_260px]">
          <div className="flex flex-col gap-2">
            <Input
              value={searchInput}
              onValueChange={setSearchInput}
              placeholder="Buscar producto o código…"
              // Alto minimo 44 px (touch target de Apple/Google) para no
              // castigar el uso en celular.
              size="lg"
              startContent={<Search size={16} className="text-zinc-400" />}
              endContent={
                searchInput ? (
                  <button
                    type="button"
                    aria-label="Limpiar busqueda"
                    onClick={() => setSearchInput("")}
                    className="rounded-lg p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-white/5 dark:hover:text-white"
                  >
                    <X size={14} />
                  </button>
                ) : null
              }
              aria-label="Buscar producto en el catalogo"
              // Feedback visible del estado de busqueda: bordeado ambar cuando
              // esta esperando al backend, para que el dueno sepa que hay algo
              // en camino en el celular con red lenta.
              classNames={{
                inputWrapper: `min-h-[44px] transition-colors ${isSearching || searchDeferred ? "border-amber-500 ring-1 ring-amber-500/40" : ""}`,
              }}
            />
            {!isUnassignedMode && (
              <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-white/10 dark:bg-zinc-950">
                <Switch
                  size="sm"
                  color="warning"
                  isSelected={includeAll}
                  onValueChange={toggleIncludeAll}
                  aria-label="Ver todo el catálogo del proveedor, no solo las prioridades"
                />
                <div className="flex min-w-0 flex-col leading-tight">
                  <span className="text-[10px] font-black uppercase tracking-wide text-zinc-700 dark:text-zinc-200">
                    Ver todo el catálogo
                  </span>
                  <span className="text-[9px] font-medium text-zinc-500 dark:text-zinc-400">
                    {includeAll
                      ? "Se muestra todo el catálogo del proveedor"
                      : "Por defecto se muestran solo las prioridades (rojo/amarillo o con sugerencia)"}
                  </span>
                </div>
              </div>
            )}
            {(isSearching || searchDeferred) && (
              <p
                role="status"
                aria-live="polite"
                className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-amber-600 dark:text-amber-400"
              >
                <RefreshCw size={11} className="animate-spin" /> Buscando en el servidor…
              </p>
            )}
          </div>
          <Autocomplete
            aria-label="Filtrar proveedor"
            placeholder="Escribe o elige un proveedor…"
            items={filteredSupplierOptions}
            selectedKey={selectedSupplier}
            inputValue={supplierQuery}
            onInputChange={setSupplierQuery}
            onSelectionChange={(key) => {
              const value = key ? String(key) : "unassigned";
              setSelectedSupplier(value);
              // Se LIMPIA la búsqueda tras elegir. Si acá se escribiera la
              // etiqueta del seleccionado, ese texto volvería a filtrar la lista
              // y el desplegable quedaría con un solo ítem.
              setSupplierQuery("");
            }}
            allowsCustomValue={false}
            menuTrigger="focus"
            classNames={{
              listbox: "bg-white dark:bg-zinc-950 p-1",
              popoverContent:
                "bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-white/10 shadow-lg p-1 rounded-2xl",
            }}
            inputProps={{
              classNames: {
                inputWrapper:
                  "min-h-[44px] bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-white/10 rounded-xl shadow-none data-[focus=true]:border-amber-500",
                input: "text-sm font-semibold uppercase",
              },
            }}
          >
            {(option) => (
              <AutocompleteItem
                key={option.key}
                textValue={option.label}
                className="rounded-xl data-[hover=true]:bg-zinc-100 dark:data-[hover=true]:bg-white/5"
              >
                <span className="text-xs font-semibold uppercase">{option.label}</span>
              </AutocompleteItem>
            )}
          </Autocomplete>
          {/* El campo queda vacío a propósito (para poder escribir de una), así
              que la vista activa se indica acá abajo. */}
          <p className="mt-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            <Truck size={12} className="shrink-0 text-amber-500" />
            <span className="truncate" title={activeSupplierLabel}>
              Viendo: {activeSupplierLabel}
            </span>
          </p>
        </section>

        {error && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
            No se pudieron cargar las métricas V2. Verifica que la migración 010 esté aplicada y ejecuta el recálculo nocturno.
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((value) => <Skeleton key={value} className="h-32 rounded-2xl" />)}
          </div>
        ) : visibleGroups.length === 0 ? (
          <Card className="border border-zinc-200 dark:border-white/10">
            <CardBody className="items-center gap-2 py-16 text-center">
              {suggestions.length === 0 ? (
                isUnassignedMode ? (
                  <>
                    <CheckCircle2 className="text-emerald-500" size={42} />
                    <p className="font-black uppercase">
                      {debouncedSearch ? "No hay huérfanos que coincidan" : "Todos los productos tienen proveedor"}
                    </p>
                    <p className="max-w-md text-sm text-zinc-500">
                      {debouncedSearch
                        ? "Prueba con otro nombre o código. La búsqueda se realiza en el servidor."
                        : "No quedan productos pendientes por vincular. Puedes usar Todos los proveedores como vista secundaria."}
                    </p>
                  </>
                ) : selectedSupplier !== "global" ? (
                  <>
                    <Truck className="text-sky-500" size={42} />
                    <p className="font-black uppercase">
                      {debouncedSearch
                        ? "Nada coincide con la busqueda para este proveedor"
                        : "Este proveedor no tiene productos asociados"}
                    </p>
                    <p className="max-w-md text-sm text-zinc-500">
                      {debouncedSearch ? (
                        <>Prueba con otro texto, o activa <span className="font-bold">Ver todo el catalogo</span> para revisar los que no estan en zona critica.</>
                      ) : (
                        <>Elige <span className="font-bold">Sin proveedor · por vincular</span> para asignar los productos pendientes.</>
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <RefreshCw className="text-amber-500" size={42} />
                    <p className="font-black uppercase">
                      {debouncedSearch ? "Nada coincide con la busqueda" : "Aún no hay métricas calculadas"}
                    </p>
                    <p className="max-w-md text-sm text-zinc-500">
                      {debouncedSearch ? (
                        <>Prueba con otro texto. Activa <span className="font-bold">Ver todo el catálogo</span> para ampliar.</>
                      ) : (
                        <>El análisis de demanda corre automáticamente a las 9:00 p. m. Para verlo ahora,
                          pulsa <span className="font-bold">Recalcular</span> arriba.</>
                      )}
                    </p>
                  </>
                )
              ) : (
                <>
                  <CheckCircle2 className="text-emerald-500" size={42} />
                  <p className="font-black uppercase">Sin productos para este filtro</p>
                  <p className="text-sm text-zinc-500">Cambia la categoría, proveedor o búsqueda.</p>
                </>
              )}
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-5">
            {incrementalGroups.map((visibleGroup) => {
              const completeGroup = allGroups.find((group) => group.key === visibleGroup.key) ?? visibleGroup;
              const form = getForm(completeGroup);
              const selectedItems = completeGroup.items.filter((item) => (orderQuantities[item.productId] ?? 0) > 0);
              const groupTotal = selectedItems.reduce(
                (sum, item) => sum + (orderQuantities[item.productId] ?? 0) * item.unitCost,
                0
              );
              // Un pedido se puede enviar de dos formas: con productos
              // desglosados, o sin ellos pero con un valor escrito a mano. El
              // proveedor sigue siendo obligatorio en los dos casos porque sin
              // el el pedido no se le puede atribuir a nadie.
              const hasSelection = selectedItems.length > 0;
              const declaredOrderValue = parseOrderValue(form.orderValue);
              const canConfirm = canConfirmOrder({
                hasSupplier: Boolean(completeGroup.supplierId),
                selectedCount: selectedItems.length,
                declaredValue: declaredOrderValue,
              });
              // Estado de agenda del proveedor: si ninguna fila trae dias
              // configurados avisamos al dueno con un banner accionable.
              const schedule = summarizeGroupSchedule(completeGroup.items);
              const agendaSummary = summarizeSupplierAgenda(completeGroup.items);
              const resolvedDate = resolveExpectedDeliveryDate(completeGroup.items);
              const sourceInfo = describeLeadTimeSource(resolvedDate.source);
              // La etiqueta de la fecha propuesta debe decir de donde sale:
              // agenda configurada (verde), aprendida (indigo) o estimada
              // (ambar). El dueno tiene que poder decidir si confiar.
              const dateSourceLabel = resolvedDate.hasConfiguredDays
                ? `Segun agenda configurada · ${formatIsoDateEs(resolvedDate.nextDeliveryDate)}`
                : resolvedDate.hasLearnedDays
                  ? `Segun agenda aprendida · ${formatIsoDateEs(resolvedDate.nextDeliveryDate)}`
                  : `Fecha estimada (${sourceInfo.label}, ${resolvedDate.leadDaysUsed} d)`;
              const dateSourceTone = resolvedDate.hasConfiguredDays
                ? "text-emerald-700 dark:text-emerald-300"
                : resolvedDate.hasLearnedDays
                  ? "text-indigo-700 dark:text-indigo-300"
                  : "text-amber-700 dark:text-amber-300";
              // Cuando el proveedor tiene alguna agenda (manual o aprendida)
              // pintamos el panel comparativo, para que el dueno vea las dos
              // por separado y detecte contradicciones.
              const showAgendaCompare = agendaSummary.configured.hasConfigured
                || agendaSummary.learned.sampleCount > 0;

              const isOrphanGroup = completeGroup.supplierId === null;

              return (
                <Card key={visibleGroup.key} className="overflow-hidden border border-zinc-200 shadow-sm dark:border-white/10">
                  <CardBody className="gap-0 p-0">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-100 px-4 py-3 dark:border-white/10 dark:bg-zinc-900">
                      <div className="flex items-center gap-2">
                        <Truck size={18} className="text-amber-500" />
                        <h2 className="font-black uppercase">{visibleGroup.supplierName}</h2>
                        <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-bold dark:bg-zinc-800">{completeGroup.items.length}</span>
                        {!isOrphanGroup && schedule.allConfigured && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300"
                            title="Fechas calculadas con los dias de visita y entrega configurados"
                          >
                            <CalendarClock size={11} /> Agenda configurada
                          </span>
                        )}
                        {!isOrphanGroup && !schedule.allConfigured && resolvedDate.hasLearnedDays && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-700 dark:text-indigo-300"
                            title="Fechas calculadas con la agenda que el sistema aprendio de los pedidos observados"
                          >
                            <CalendarClock size={11} /> Agenda aprendida
                          </span>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-[9px] font-bold uppercase text-zinc-500">Seleccionado</p>
                        <p className="font-black text-emerald-600">{formatPrice(groupTotal)}</p>
                      </div>
                    </div>

                    {!isOrphanGroup && schedule.missingSchedule && (
                      <div
                        role="status"
                        className="flex flex-col gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-800 dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="flex items-start gap-2">
                          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" />
                          <div className="text-xs leading-snug">
                            <p className="font-black uppercase tracking-wide">
                              {visibleGroup.supplierName} no tiene dias de visita y entrega configurados
                            </p>
                            <p className="mt-0.5 font-medium">
                              {isAdmin ? (
                                <>
                                  Proponemos una fecha estimada ({resolvedDate.leadDaysUsed} dias). Configura los dias
                                  del proveedor para que la fecha se calcule automaticamente y no te quedes sin
                                  producto entre visitas.
                                </>
                              ) : (
                                <>
                                  Proponemos una fecha estimada ({resolvedDate.leadDaysUsed} dias). La agenda solo
                                  puede ser configurada por un administrador.
                                </>
                              )}
                            </p>
                          </div>
                        </div>
                        {isAdmin && (
                          <Button
                            size="sm"
                            variant="flat"
                            color="warning"
                            startContent={<Settings size={14} />}
                            className="self-start sm:self-center"
                            onPress={() => openScheduleEditor(completeGroup)}
                          >
                            Configurar aquí
                          </Button>
                        )}
                      </div>
                    )}

                    {!isOrphanGroup && showAgendaCompare && (
                      <SupplierScheduleCompare
                        items={completeGroup.items}
                        supplierName={visibleGroup.supplierName}
                        onEditSchedule={isAdmin ? () => openScheduleEditor(completeGroup) : undefined}
                      />
                    )}

                    <IncrementalSuggestionList
                      items={visibleGroup.items}
                      orderQuantities={orderQuantities}
                      onQuantityChange={setQuantity}
                      onSaveMinStock={saveMinStock}
                      onUnlinkSupplier={requestUnlink}
                      onLinkSupplier={setLinkTarget}
                      canUnlink={!isOrphanGroup}
                      canLink={isOrphanGroup}
                    />

                    {!isOrphanGroup && (
                      <div
                        data-order-confirm-form
                        className="grid gap-3 border-t border-amber-500/20 bg-amber-500/5 p-4 md:grid-cols-[minmax(180px,200px)_minmax(140px,1fr)_minmax(160px,180px)_auto] md:items-end"
                      >
                      <label className="text-[10px] font-bold uppercase text-zinc-500">
                        Fecha de entrega
                        <input
                          type="date"
                          value={form.expectedDate}
                          onChange={(event) => updateForm(completeGroup.key, { expectedDate: event.target.value })}
                          className="mt-1 h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-900 dark:border-white/10 dark:bg-zinc-950 dark:text-white"
                          aria-describedby={`fecha-fuente-${completeGroup.key}`}
                        />
                        <span
                          id={`fecha-fuente-${completeGroup.key}`}
                          className={`mt-1 block text-[9px] font-semibold normal-case tracking-normal ${dateSourceTone}`}
                        >
                          {dateSourceLabel}
                        </span>
                      </label>
                      <label className="text-[10px] font-bold uppercase text-zinc-500">
                        Referencia / factura
                        <input
                          type="text"
                          value={form.invoiceRef}
                          onChange={(event) => updateForm(completeGroup.key, { invoiceRef: event.target.value })}
                          placeholder="Opcional"
                          className="mt-1 h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm font-normal text-zinc-900 dark:border-white/10 dark:bg-zinc-950 dark:text-white"
                        />
                      </label>
                      {/*
                        Valor del pedido. Permite enviar el pedido SIN desglosar
                        los productos: el preventista pasa, acuerdan un monto y
                        lo que hay que dejar registrado es el compromiso y la
                        fecha de llegada. Si hay productos seleccionados, este
                        campo corrige el total cuando se cerró en otro número.
                      */}
                      <label className="text-[10px] font-bold uppercase text-zinc-500">
                        Valor del pedido
                        <div className="relative mt-1">
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm font-bold text-emerald-600 dark:text-emerald-400"
                          >
                            $
                          </span>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={formatOrderValueInput(form.orderValue)}
                            onChange={(event) => updateForm(completeGroup.key, {
                              orderValue: normalizeOrderValueInput(event.target.value),
                            })}
                            placeholder={hasSelection
                              ? `${formatOrderValueInput(String(Math.round(groupTotal)))},00`
                              : "Sin desglosar"}
                            className="h-10 w-full rounded-xl border border-zinc-200 bg-white py-2 pl-7 pr-12 text-sm font-semibold tabular-nums text-zinc-900 dark:border-white/10 dark:bg-zinc-950 dark:text-white"
                            aria-label="Valor del pedido en pesos colombianos"
                            aria-describedby={`valor-ayuda-${completeGroup.key}`}
                          />
                          {form.orderValue && (
                            <span
                              aria-hidden="true"
                              className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm font-semibold tabular-nums text-zinc-500"
                            >
                              ,00
                            </span>
                          )}
                        </div>
                        <span
                          id={`valor-ayuda-${completeGroup.key}`}
                          className="mt-1 block text-[9px] font-semibold normal-case tracking-normal text-zinc-500"
                        >
                          {declaredOrderValue > 0
                            ? `Se enviará por ${formatPrice(declaredOrderValue)}`
                            : hasSelection
                              ? "Vacío: se usa el total de los productos"
                              : "Escribe un valor para pedir sin desglosar"}
                        </span>
                      </label>
                      <Button
                        isDisabled={!canConfirm}
                        isLoading={submittingGroup === completeGroup.key}
                        onPress={() => confirmGroup(completeGroup)}
                        startContent={submittingGroup !== completeGroup.key && <Package size={16} />}
                        className="h-12 rounded-2xl border-2 border-black/10 bg-amber-600 px-8 text-[11px] font-bold uppercase tracking-widest text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-amber-500/30 transition-all hover:bg-amber-500 active:scale-95 disabled:opacity-50 dark:border-white/20"
                      >
                        Confirmar {selectedItems.length || ""}
                      </Button>
                    </div>
                    )}
                  </CardBody>
                </Card>
              );
            })}
            {hasMoreProducts && (
              <div
                ref={loadMoreSentinelRef}
                className="flex flex-col items-center gap-1 rounded-2xl border border-zinc-200 bg-white px-4 py-4 dark:border-white/10 dark:bg-zinc-900"
              >
                <Button
                  type="button"
                  size="sm"
                  variant="flat"
                  onPress={loadMoreProducts}
                  aria-label={`Cargar más productos. ${totalVisibleProducts - mountedProductCount} pendientes`}
                >
                  Cargar más
                </Button>
                <p className="text-[10px] font-medium text-zinc-500" aria-live="polite">
                  Mostrando {mountedProductCount} de {totalVisibleProducts}
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      <OrderCartModal
        isOpen={isCartOpen}
        onOpenChange={setIsCartOpen}
        items={selectedItems}
        total={orderTotal}
        formatPrice={formatPrice}
        onSetQuantity={setQuantity}
        isConfirming={submittingGroup !== null}
        onConfirm={() => {
          // El envío real necesita la fecha de entrega y el valor del pedido,
          // que se completan en la tarjeta del proveedor. En vez de mandar el
          // pedido sin esos datos, se cierra el carrito y se lleva al usuario
          // al formulario, que ya envía únicamente los productos con cantidad.
          setIsCartOpen(false);
          if (typeof document !== "undefined") {
            requestAnimationFrame(() => {
              document
                .querySelector("[data-order-confirm-form]")
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
            });
          }
        }}
      />

      <ProductSupplierLinkDialog
        isOpen={linkTarget !== null}
        product={linkTarget}
        suppliers={activeSuppliers}
        isSaving={linkingSupplier}
        onOpenChange={(open) => { if (!open && !linkingSupplier) setLinkTarget(null); }}
        onSave={saveSupplierLink}
      />

      {isAdmin && (
        <SupplierScheduleEditor
          isOpen={scheduleTarget !== null}
          supplier={scheduleTarget}
          isSaving={savingSchedule}
          onOpenChange={(open) => { if (!open && !savingSchedule) setScheduleTarget(null); }}
          onSave={saveSupplierSchedule}
        />
      )}

      {unlinkTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="titulo-desasociar"
        >
          <Card className="w-full max-w-md border border-zinc-200 dark:border-white/10">
            <CardBody className="gap-3">
              <div className="flex items-start gap-2">
                <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-500" />
                <div>
                  <h2 id="titulo-desasociar" className="font-black uppercase text-zinc-900 dark:text-white">
                    Quitar del proveedor
                  </h2>
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
                    <strong>{unlinkTarget.productName}</strong> dejará de aparecer en los pedidos de{" "}
                    <strong>{unlinkTarget.supplierName}</strong>.
                  </p>
                  <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                    No se borra el producto ni su historial: sólo se rompe la asociación con este proveedor.
                    Puedes volver a asignarlo desde la ficha del producto.
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="flat" onPress={() => setUnlinkTarget(null)} isDisabled={unlinking}>
                  Cancelar
                </Button>
                <Button
                  size="sm"
                  color="danger"
                  isLoading={unlinking}
                  onPress={() => void confirmUnlink()}
                  startContent={!unlinking && <X size={15} />}
                >
                  Quitar del proveedor
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      )}
      {transitPrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="titulo-ya-pedido"
        >
          <Card className="w-full max-w-md border border-zinc-200 dark:border-white/10">
            <CardBody className="gap-3">
              <div className="flex items-start gap-2">
                <Truck size={20} className="mt-0.5 shrink-0 text-sky-500" />
                <div className="min-w-0">
                  <h2 id="titulo-ya-pedido" className="font-black uppercase text-zinc-900 dark:text-white">
                    Ya viene en camino
                  </h2>
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
                    {transitPrompt.products.length === 1
                      ? "Este producto ya está pedido y todavía no ha llegado:"
                      : "Estos productos ya están pedidos y todavía no han llegado:"}
                  </p>
                </div>
              </div>

              <ul className="space-y-1.5 rounded-2xl border border-sky-500/20 bg-sky-500/5 p-3">
                {transitPrompt.products.map((product) => (
                  <li
                    key={product.productId}
                    className="flex items-baseline justify-between gap-3 text-sm"
                  >
                    <span className="min-w-0 truncate font-bold text-zinc-900 dark:text-white">
                      {product.productName}
                    </span>
                    <span className="shrink-0 font-black text-sky-600 dark:text-sky-300">
                      {product.quantity} en camino
                    </span>
                  </li>
                ))}
              </ul>

              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                Si pides de nuevo vas a sumar cantidad sobre lo que ya viene. Cancela si preferías
                esperar a que llegue este pedido.
              </p>

              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="flat"
                  onPress={() => answerTransitPrompt(false)}
                >
                  Cancelar
                </Button>
                <Button
                  size="sm"
                  onPress={() => answerTransitPrompt(true)}
                  startContent={<Package size={15} />}
                  className="rounded-2xl border-2 border-black/10 bg-amber-600 px-5 font-bold uppercase tracking-wide text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-amber-500/30 transition-all hover:bg-amber-500 active:scale-95 dark:border-white/20"
                >
                  Pedir de todas formas
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      )}
    </main>
  );
}

export default function SmartRestockPage() {
  return (
    <Suspense fallback={(
      <div className="p-6">
        <Skeleton className="h-40 rounded-2xl" />
      </div>
    )}>
      <SmartRestockContent />
    </Suspense>
  );
}
