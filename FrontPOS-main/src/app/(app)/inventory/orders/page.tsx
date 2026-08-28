"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Cookies from "js-cookie";
import {
  AlertTriangle,
  CheckCircle2,
  DollarSign,
  Package,
  RefreshCw,
  Search,
  ShoppingBag,
  Sparkles,
  Truck,
  X,
} from "lucide-react";
import { Autocomplete, AutocompleteItem, Button, Card, CardBody, Input, Skeleton } from "@heroui/react";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/lib/auth";
import { API_URL } from "@/lib/constants";
import { Supplier } from "@/lib/definitions";
import { formatPrice } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  ABCCategory,
  RestockSuggestion,
  useSmartRestock,
} from "./hooks/useSmartRestock";

type CategoryFilter = "ALL" | ABCCategory;

interface GroupForm {
  expectedDate: string;
  invoiceRef: string;
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
  C: "No sugerir",
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
  const date = new Date();
  date.setDate(date.getDate() + Math.max(0, days));
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function groupSuggestions(items: RestockSuggestion[]): SuggestionGroup[] {
  const groups = new Map<string, SuggestionGroup>();
  for (const item of items) {
    const key = item.primarySupplierId ? String(item.primarySupplierId) : "unassigned";
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    groups.set(key, {
      key,
      supplierId: item.primarySupplierId,
      supplierName: item.supplierName || "Sin proveedor asignado",
      items: [item],
    });
  }
  return Array.from(groups.values()).sort((left, right) =>
    left.supplierName.localeCompare(right.supplierName, "es")
  );
}

function SmartRestockContent() {
  const { user } = useAuth();
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const editOrderId = searchParams.get("edit_order") ?? "";
  const initialSupplier = searchParams.get("supplier") ?? "global";
  const [selectedSupplier, setSelectedSupplier] = useState(initialSupplier);
  const [category, setCategory] = useState<CategoryFilter>("ALL");
  const [search, setSearch] = useState("");
  const [forms, setForms] = useState<Record<string, GroupForm>>({});
  const [submittingGroup, setSubmittingGroup] = useState<string | null>(null);
  const [recalculating, setRecalculating] = useState(false);
  const editLoaded = useRef(false);

  const { data: suppliers = [] } = useApi<Supplier[]>("/suppliers/all-suppliers");

  // Opciones del buscador de proveedores: "Todos" primero y el resto alfabético.
  const supplierOptions = useMemo(() => {
    const options = suppliers
      .map((supplier) => ({ key: String(supplier.id), label: supplier.name ?? "" }))
      .filter((option) => option.label.trim() !== "")
      .sort((left, right) => left.label.localeCompare(right.label, "es"));
    return [{ key: "global", label: "Todos los proveedores" }, ...options];
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

  // Refleja el proveedor activo sólo cuando cambia la selección. Antes también
  // dependía de la lista, así que al revalidarse los proveedores el texto que
  // estabas escribiendo se borraba.
  const supplierOptionsRef = useRef(supplierOptions);
  useEffect(() => {
    supplierOptionsRef.current = supplierOptions;
  }, [supplierOptions]);

  useEffect(() => {
    if (selectedSupplier === "global") {
      setSupplierQuery("");
      return;
    }
    const match = supplierOptionsRef.current.find((option) => option.key === selectedSupplier);
    if (match) setSupplierQuery(match.label);
  }, [selectedSupplier]);

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
  } = useSmartRestock(selectedSupplier);

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
        setForms((current) => ({
          ...current,
          [key]: {
            expectedDate: (order.expectedDate ?? order.expected_date ?? "").slice(0, 10),
            invoiceRef: order.invoiceRef ?? order.invoice_ref ?? "",
          },
        }));
      }
    })().catch(() => {
      toast({ title: "Error", description: "No se pudo cargar el pedido para edición", variant: "destructive" });
    });
  }, [editOrderId, selectedSupplier, setQuantity, suggestions.length, toast]);

  const allGroups = useMemo(() => groupSuggestions(suggestions), [suggestions]);
  const normalizedSearch = search.trim().toLocaleLowerCase("es");
  const visibleGroups = useMemo(() => allGroups.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      const matchesCategory = category === "ALL" || item.abcCategory === category;
      const matchesSearch = !normalizedSearch
        || item.productName.toLocaleLowerCase("es").includes(normalizedSearch)
        || item.productId.toLocaleLowerCase("es").includes(normalizedSearch);
      return matchesCategory && matchesSearch;
    }),
  })).filter((group) => group.items.length > 0), [allGroups, category, normalizedSearch]);

  const getForm = useCallback((group: SuggestionGroup): GroupForm => {
    const current = forms[group.key];
    if (current) return current;
    const leadDays = group.items.reduce(
      (maximum, item) => Math.max(maximum, item.supplierLeadDays || 7),
      0
    );
    return { expectedDate: dateAfter(leadDays), invoiceRef: "" };
  }, [forms]);

  const updateForm = useCallback((key: string, patch: Partial<GroupForm>) => {
    setForms((current) => ({
      ...current,
      [key]: {
        expectedDate: current[key]?.expectedDate ?? dateAfter(7),
        invoiceRef: current[key]?.invoiceRef ?? "",
        ...patch,
      },
    }));
  }, []);

  const confirmGroup = useCallback(async (group: SuggestionGroup) => {
    if (!group.supplierId) {
      toast({ title: "Proveedor requerido", description: "Asigna un proveedor antes de confirmar el pedido", variant: "destructive" });
      return;
    }
    const items: ConfirmOrderItem[] = group.items.flatMap((item) => {
      const quantity = orderQuantities[item.productId] ?? 0;
      return quantity > 0 ? [{
        product_id: item.productId,
        barcode: item.productId,
        quantity,
        unit_cost: item.unitCost,
      }] : [];
    });
    if (items.length === 0) {
      toast({ title: "Pedido vacío", description: "Selecciona al menos una cantidad mayor que cero", variant: "destructive" });
      return;
    }

    const form = getForm(group);
    const total = items.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0);
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
          const detail = products
            .map((product) => `• ${product.productName}: ${product.quantity} en camino`)
            .join("\n");
          const shouldContinue = window.confirm(
            `Estos productos ya fueron pedidos:\n\n${detail}\n\n¿Deseas pedir cantidad adicional de todas formas?`
          );
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
      toast({ title: "Pedido confirmado", description: `${items.length} productos enviados a ${group.supplierName}`, variant: "success" });
      if (editOrderId) router.push("/inventory");
      else await mutate();
    } catch (caught: unknown) {
      toast({
        title: "Error",
        description: caught instanceof Error ? caught.message : "No se pudo confirmar el pedido",
        variant: "destructive",
      });
    } finally {
      setSubmittingGroup(null);
    }
  }, [clearProducts, editOrderId, getForm, mutate, orderQuantities, router, toast, user?.name]);

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

  const role = (user?.role ?? user?.Role ?? "").toLocaleLowerCase("es");
  const isAdmin = ["admin", "administrador", "superadmin"].includes(role);

  return (
    <main className="min-h-screen bg-zinc-50 px-3 pb-10 pt-4 dark:bg-zinc-950 md:px-6 md:pt-6">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-4">
        {orderItemCount > 0 && (
          <aside className="sticky top-0 z-40 -mx-1 flex items-center justify-between gap-3 rounded-xl border border-emerald-500/40 bg-white/95 px-3 py-2 shadow-md backdrop-blur dark:bg-zinc-950/95">
            <div className="flex items-center gap-2">
              <div className="grid h-7 w-7 place-items-center rounded-lg bg-emerald-500/20 text-xs font-black text-emerald-600 dark:text-emerald-400">
                {orderItemCount}
              </div>
              <p className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
                Orden seleccionada
              </p>
            </div>
            <div className="flex items-baseline gap-2">
              <p className="text-[9px] font-bold uppercase text-zinc-500">Total</p>
              <p className="text-sm font-black tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatPrice(orderTotal)}
              </p>
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
          <Input
            value={search}
            onValueChange={setSearch}
            placeholder="Buscar producto o código…"
            startContent={<Search size={16} className="text-zinc-400" />}
            aria-label="Buscar producto"
          />
          <Autocomplete
            aria-label="Filtrar proveedor"
            placeholder="Buscar proveedor…"
            items={filteredSupplierOptions}
            selectedKey={selectedSupplier}
            inputValue={supplierQuery}
            onInputChange={setSupplierQuery}
            onSelectionChange={(key) => {
              const value = key ? String(key) : "global";
              setSelectedSupplier(value);
              if (value === "global") {
                setSupplierQuery("");
                return;
              }
              const match = supplierOptions.find((option) => option.key === value);
              setSupplierQuery(match?.label ?? "");
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
                  "h-10 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-white/10 rounded-xl shadow-none data-[focus=true]:border-amber-500",
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
                selectedSupplier !== "global" ? (
                  <>
                    <Truck className="text-sky-500" size={42} />
                    <p className="font-black uppercase">Este proveedor no tiene productos asociados</p>
                    <p className="max-w-md text-sm text-zinc-500">
                      Asigna el proveedor en la ficha de cada producto, o elige{" "}
                      <span className="font-bold">Todos los proveedores</span> para ver el listado completo.
                    </p>
                  </>
                ) : (
                  <>
                    <RefreshCw className="text-amber-500" size={42} />
                    <p className="font-black uppercase">Aún no hay métricas calculadas</p>
                    <p className="max-w-md text-sm text-zinc-500">
                      El análisis de demanda corre automáticamente a las 9:00 p. m. Para verlo ahora,
                      pulsa <span className="font-bold">Recalcular</span> arriba.
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
            {visibleGroups.map((visibleGroup) => {
              const completeGroup = allGroups.find((group) => group.key === visibleGroup.key) ?? visibleGroup;
              const form = getForm(completeGroup);
              const selectedItems = completeGroup.items.filter((item) => (orderQuantities[item.productId] ?? 0) > 0);
              const groupTotal = selectedItems.reduce(
                (sum, item) => sum + (orderQuantities[item.productId] ?? 0) * item.unitCost,
                0
              );
              return (
                <Card key={visibleGroup.key} className="overflow-hidden border border-zinc-200 shadow-sm dark:border-white/10">
                  <CardBody className="gap-0 p-0">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-100 px-4 py-3 dark:border-white/10 dark:bg-zinc-900">
                      <div className="flex items-center gap-2">
                        <Truck size={18} className="text-amber-500" />
                        <h2 className="font-black uppercase">{visibleGroup.supplierName}</h2>
                        <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-bold dark:bg-zinc-800">{visibleGroup.items.length}</span>
                      </div>
                      <div className="text-right">
                        <p className="text-[9px] font-bold uppercase text-zinc-500">Seleccionado</p>
                        <p className="font-black text-emerald-600">{formatPrice(groupTotal)}</p>
                      </div>
                    </div>

                    <div className="divide-y divide-zinc-100 dark:divide-white/5">
                      {visibleGroup.items.map((item) => {
                        const quantity = orderQuantities[item.productId] ?? 0;
                        const projected = item.currentStock + item.inTransitQty;
                        const selectedSavings = quantity * (item.cheaperSupplier?.savings ?? 0);
                        return (
                          <article key={item.productId} className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="truncate font-bold">{item.productName}</h3>
                                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-black ${categoryStyles[item.abcCategory]}`}>
                                  {item.abcCategory} · {categoryLabels[item.abcCategory]}
                                </span>
                                {item.inTransit && (
                                  <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold text-sky-700 dark:text-sky-300">
                                    <Truck size={11} /> {item.inTransitQty} en camino · ya pedido
                                  </span>
                                )}
                              </div>
                              <p className="mt-1 text-[11px] text-zinc-500">{item.productId}</p>
                              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
                                <span>Vendido 30d: <strong>{item.totalSold30d}</strong></span>
                                <span>Demanda real: <strong>{item.avgDailySales.toFixed(2)}/día</strong></span>
                                <span>Días agotado: <strong>{item.daysZeroStock}</strong></span>
                                <span>Stock: <strong>{item.currentStock}</strong></span>
                                <span>Proyectado: <strong>{projected}</strong></span>
                                <span>Ideal {item.supplierLeadDays}d: <strong>{item.idealStock}</strong></span>
                                {typeof item.daysSinceReception === "number" && (
                                  <span>
                                    Recibido hace <strong>{item.daysSinceReception}d</strong>
                                    {typeof item.soldSinceReception === "number" && item.soldSinceReception > 0
                                      ? ` · ${item.soldSinceReception} vendidas desde entonces`
                                      : ""}
                                  </span>
                                )}
                              </div>
                              {item.recommendation && (
                                <p
                                  className={`mt-2 inline-flex rounded-lg px-2 py-1 text-[11px] font-bold ${
                                    item.recommendationLevel === "urgent"
                                      ? "bg-rose-500/10 text-rose-700 dark:text-rose-300"
                                      : item.recommendationLevel === "order"
                                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                        : item.recommendationLevel === "wait"
                                          ? "bg-sky-500/10 text-sky-700 dark:text-sky-300"
                                          : "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400"
                                  }`}
                                >
                                  {item.recommendation}
                                </p>
                              )}
                              {item.cheaperSupplier && (
                                <div className="mt-3 flex max-w-2xl items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-800 dark:text-emerald-200">
                                  <DollarSign size={15} className="mt-0.5 shrink-0" />
                                  <span>
                                    <strong>{item.cheaperSupplier.supplierName}</strong> vende a {formatPrice(item.cheaperSupplier.unitPrice)}.
                                    Ahorro: {formatPrice(item.cheaperSupplier.savings)}/unidad
                                    {selectedSavings > 0 ? ` · ${formatPrice(selectedSavings)} en esta selección` : ""}.
                                  </span>
                                </div>
                              )}
                            </div>

                            <div className="flex items-center justify-between gap-3 md:justify-end">
                              <div className="text-right">
                                <p className="text-[9px] font-bold uppercase text-zinc-500">Sugerencia</p>
                                <button
                                  type="button"
                                  onClick={() => setQuantity(item.productId, item.suggestedOrderQty)}
                                  className="font-black text-indigo-600 hover:underline disabled:cursor-not-allowed disabled:text-zinc-400"
                                  disabled={item.abcCategory === "C"}
                                >
                                  {item.suggestedOrderQty}
                                </button>
                              </div>
                              <div className="flex items-center rounded-xl border border-zinc-200 bg-zinc-50 p-1 dark:border-white/10 dark:bg-zinc-950">
                                <button type="button" aria-label={`Restar ${item.productName}`} className="h-8 w-8 rounded-lg font-black hover:bg-zinc-200 dark:hover:bg-zinc-800" onClick={() => setQuantity(item.productId, quantity - 1)}>−</button>
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={quantity}
                                  onChange={(event) => setQuantity(item.productId, Number(event.target.value))}
                                  aria-label={`Cantidad de ${item.productName}`}
                                  className="w-16 bg-transparent text-center text-sm font-black outline-none"
                                />
                                <button type="button" aria-label={`Sumar ${item.productName}`} className="h-8 w-8 rounded-lg font-black hover:bg-zinc-200 dark:hover:bg-zinc-800" onClick={() => setQuantity(item.productId, quantity + 1)}>+</button>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>

                    <div className="grid gap-3 border-t border-amber-500/20 bg-amber-500/5 p-4 md:grid-cols-[180px_minmax(180px,1fr)_auto] md:items-end">
                      <label className="text-[10px] font-bold uppercase text-zinc-500">
                        Fecha de entrega
                        <input
                          type="date"
                          value={form.expectedDate}
                          onChange={(event) => updateForm(completeGroup.key, { expectedDate: event.target.value })}
                          className="mt-1 h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-900 dark:border-white/10 dark:bg-zinc-950 dark:text-white"
                        />
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
                      <Button
                        color="warning"
                        isDisabled={!completeGroup.supplierId || selectedItems.length === 0}
                        isLoading={submittingGroup === completeGroup.key}
                        onPress={() => confirmGroup(completeGroup)}
                        startContent={submittingGroup !== completeGroup.key && <Package size={16} />}
                      >
                        Confirmar {selectedItems.length || ""}
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )}
      </section>
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
