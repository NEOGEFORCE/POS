"use client";

// =============================================================================
// /labels/config — Configuración de Impresora y Formatos.
//
// Esta pantalla NO envía bytes a la impresora: eso requiere un bridge local
// (window.posBridge). Lo que hace es:
//
//   1. Editar el estado versionado `pos_printing_config_v1` en LocalStorage,
//      que es la fuente de verdad del lado del navegador.
//   2. Mostrar previews interactivos del recibo y de la etiqueta a escala.
//   3. Botón "Imprimir página de prueba" que arma un iframe con @page acorde
//      al preset activo. Si existe `window.posBridge.printTestPage` o
//      `posBridge.print({type:'test-page', config})` delega al bridge; sino,
//      cae a `iframe.print()`.
//   4. Botón "Probar cajón" que hace POST auditado a /cash-drawer/open con
//      override admin, y acto seguido llama `posBridge.kickDrawer({...})`.
//   5. Importa best-effort desde GET /labels/printers y GET /labels/sizes
//      (DB 016) cuando existan. Al guardar intenta POST al mismo endpoint
//      como proyección: si el backend no tiene la migración, el guardado
//      LocalStorage no falla.
//
// Toda la pantalla exige rol admin: usamos `isAdminUser` del helper central.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Divider,
  Input,
  Select,
  SelectItem,
  Slider,
  Spinner,
  Tab,
  Tabs,
  Tooltip,
} from "@heroui/react";
import { Switch } from "@/components/ui/switch";
import {
  AlertTriangle,
  CheckCircle2,
  DoorOpen,
  Download,
  FilePenLine,
  Printer,
  RotateCcw,
  Save,
  Tag,
  TestTube2,
} from "lucide-react";

import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useApi } from "@/hooks/use-api";
import { apiFetch, ApiError } from "@/lib/api-error";
import { isAdminUser } from "@/lib/auth-helpers.mjs";
import {
  BARCODE_SYMBOLOGIES,
  BOUNDS,
  CUT_MODES,
  DRAWER_EVENTS,
  INTERFACES,
  INTERFACE_PROTOCOLS,
  LABEL_SIZE_PRESETS,
  PAPER_PRESETS,
  SENSOR_TYPES,
  SPOOLERS,
  applyLabelSizePreset,
  applyReceiptPaperPreset,
  createDefaultPrintingConfig,
  importConfigFromPrinterProfile,
  loadPrintingConfig,
  printingConfigsEqual,
  projectConfigToPrinterProfile,
  sanitizePrintingConfig,
  savePrintingConfig,
  validatePrintingConfig,
} from "@/lib/printing-config.mjs";
import type {
  PrintingConfig,
  PrinterInterface,
  PrinterProtocol,
  PaperPreset,
  LabelSizePreset,
  BarcodeSymbology,
  SensorType,
  CutMode,
  DrawerEvent,
} from "@/lib/printing-config.d.mts";

// -----------------------------------------------------------------------------
// Tipos auxiliares de la UI (contratos con el backend DB 016, best-effort)
// -----------------------------------------------------------------------------

interface PrinterProfileRow {
  id?: number;
  name: string;
  protocol: string;
  target: string;
  model?: string;
  drawerConnected?: boolean;
  isDefault?: boolean;
  rollWidthMm?: number | null;
}

interface SizeTemplateRow {
  id?: number;
  name: string;
  widthMm: number;
  heightMm: number;
  isDefault?: boolean;
  barcodeFormat?: string;
  columnsCount?: number;
}

type TabKey = "perfil" | "recibo" | "etiquetas";

// -----------------------------------------------------------------------------
// Helpers de escape — nunca inyectamos strings del usuario sin escapar.
// -----------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * `numberOrEmpty` toggle para inputs numéricos de HeroUI: `""` cuando el
 * campo está vacío, el número en cualquier otro caso.
 */
function numberOrEmpty(n: number | string | undefined): string {
  if (n === undefined || n === null || n === "") return "";
  const parsed = typeof n === "number" ? n : Number(n);
  return Number.isFinite(parsed) ? String(parsed) : "";
}

function clampForInput(raw: string, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

// -----------------------------------------------------------------------------
// Página
// -----------------------------------------------------------------------------

export default function LabelsConfigPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = isAdminUser(user);

  const [config, setConfig] = useState<PrintingConfig>(createDefaultPrintingConfig);
  const [savedSnapshot, setSavedSnapshot] = useState<PrintingConfig>(createDefaultPrintingConfig);
  const [tab, setTab] = useState<TabKey>("perfil");
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [drawerBusy, setDrawerBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Al montar, hidratamos desde LocalStorage. No lo hacemos en el initializer
  // de useState para evitar divergencia SSR → cliente (output: 'export').
  useEffect(() => {
    try {
      const stored = loadPrintingConfig();
      setConfig(stored);
      setSavedSnapshot(stored);
    } catch {
      // ignore — defaults
    } finally {
      setHydrated(true);
    }
  }, []);

  // Importes read-only desde el backend (si el endpoint existe).
  const { data: profilesResp } = useApi<{ profiles: PrinterProfileRow[] }>(isAdmin ? "/labels/printers" : null);
  const { data: sizesResp } = useApi<{ templates: SizeTemplateRow[] }>(isAdmin ? "/labels/sizes" : null);
  const dbProfiles = useMemo(() => profilesResp?.profiles ?? [], [profilesResp]);
  const dbSizes = useMemo(() => sizesResp?.templates ?? [], [sizesResp]);

  const validation = useMemo(() => validatePrintingConfig(config), [config]);
  const isDirty = useMemo(() => !printingConfigsEqual(config, savedSnapshot), [config, savedSnapshot]);
  const canSave = isDirty && !submitting && validation.valid;

  // ---------------------------------------------------------------------------
  // Mutadores atómicos del estado (hooks ANTES del early return — las reglas
  // de React exigen que el orden de llamadas no cambie entre renders).
  // ---------------------------------------------------------------------------

  const update = useCallback((mutator: (draft: PrintingConfig) => PrintingConfig | void) => {
    setConfig((prev) => {
      const draft: PrintingConfig = JSON.parse(JSON.stringify(prev));
      const next = mutator(draft) ?? draft;
      return sanitizePrintingConfig(next);
    });
  }, []);

  const resetDirty = useCallback(() => {
    setConfig(savedSnapshot);
  }, [savedSnapshot]);

  const handleSave = useCallback(async () => {
    if (submitting) return;
    if (!validation.valid) {
      toast({
        variant: "destructive",
        title: "REVISA LOS ERRORES",
        description: validation.errors[0]?.message || "Hay campos inválidos.",
      });
      return;
    }
    setSubmitting(true);
    try {
      const persisted = savePrintingConfig(config);
      setConfig(persisted);
      setSavedSnapshot(persisted);
      // Proyección BEST-EFFORT. Si el backend no tiene DB 016 el POST tirará
      // 404 y el guardado local se mantiene.
      try {
        await apiFetch("/labels/printers", {
          method: "POST",
          body: JSON.stringify(projectConfigToPrinterProfile(persisted)),
          fallbackError: "proyección no aplicada",
        });
        toast({
          variant: "success",
          title: "CONFIGURACIÓN GUARDADA",
          description: "Guardado local y publicado como perfil en /labels/printers.",
        });
      } catch (projErr) {
        const status = projErr instanceof ApiError ? projErr.status : 0;
        if (status === 404 || status === 405) {
          toast({
            variant: "success",
            title: "GUARDADO LOCAL",
            description: "El endpoint DB 016 no está disponible: la configuración vive sólo en este navegador.",
          });
        } else {
          toast({
            variant: "success",
            title: "GUARDADO LOCAL",
            description: "La proyección al backend falló pero el navegador conserva los cambios.",
          });
        }
      }
    } finally {
      setSubmitting(false);
    }
  }, [config, submitting, toast, validation]);

  const importProfile = useCallback((row: PrinterProfileRow) => {
    const imported = importConfigFromPrinterProfile(row, config);
    setConfig(imported);
    toast({ variant: "default", title: "PERFIL IMPORTADO", description: row.name });
  }, [config, toast]);

  const printTestPage = useCallback(async () => {
    if (typeof window === "undefined" || testing) return;
    setTesting(true);
    try {
      const target: "receipt" | "label" = tab === "etiquetas" ? "label" : "receipt";
      const payload = {
        type: "test-page" as const,
        target,
        config: sanitizePrintingConfig(config),
      };
      const w = window as Window & { posBridge?: {
        printTestPage?: (data: unknown) => Promise<unknown>;
        print?: (data: unknown) => Promise<unknown>;
      } };
      let delegatedToBridge = false;
      if (w.posBridge && typeof w.posBridge.printTestPage === "function") {
        try {
          await w.posBridge.printTestPage(payload);
          delegatedToBridge = true;
          toast({ variant: "success", title: "PRUEBA ENVIADA", description: "El bridge local tomó el control." });
        } catch (err) {
          console.warn("[labels/config] printTestPage falló, caerá a iframe", err);
        }
      } else if (w.posBridge && typeof w.posBridge.print === "function") {
        try {
          await w.posBridge.print(payload);
          delegatedToBridge = true;
          toast({ variant: "success", title: "PRUEBA ENVIADA", description: "El bridge local tomó el control." });
        } catch (err) {
          console.warn("[labels/config] print({test-page}) falló, caerá a iframe", err);
        }
      }
      if (!delegatedToBridge) {
        runIframeTestPrint(target, config);
        toast({
          variant: "default",
          title: "DIÁLOGO ABIERTO",
          description: "Sin bridge local se usó el diálogo del navegador.",
        });
      }
    } finally {
      setTesting(false);
    }
  }, [config, tab, testing, toast]);

  const testDrawer = useCallback(async () => {
    if (!config.drawer.enabled) {
      toast({
        variant: "destructive",
        title: "CAJÓN DESHABILITADO",
        description: "Activa el cajón en la pestaña Perfil antes de probar.",
      });
      return;
    }
    if (drawerBusy) return;
    setDrawerBusy(true);
    try {
      await apiFetch("/cash-drawer/open", {
        method: "POST",
        body: JSON.stringify({
          override: true,
          note: "Prueba de cajón desde /labels/config",
          source: "labels-config",
        }),
      });
      const w = window as Window & { posBridge?: {
        kickDrawer?: (data: unknown) => Promise<unknown>;
      } };
      if (w.posBridge && typeof w.posBridge.kickDrawer === "function") {
        try {
          await w.posBridge.kickDrawer({
            command: config.drawer.command,
            event: config.drawer.event,
            connection: config.connection,
          });
        } catch (err) {
          console.warn("[labels/config] kickDrawer falló tras auditoría", err);
        }
      }
      toast({
        variant: "success",
        title: "PULSO ENVIADO",
        description: "Verifica físicamente si el cajón se abrió.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "No se pudo auditar la apertura.";
      toast({ variant: "destructive", title: "Error al probar cajón", description: msg });
    } finally {
      setDrawerBusy(false);
    }
  }, [config, drawerBusy, toast]);

  // ---------------------------------------------------------------------------
  // Early return: acceso restringido
  // ---------------------------------------------------------------------------

  if (!isAdmin) {
    return (
      <div className="p-6">
        <Card className="rounded-2xl border border-rose-500/30 bg-rose-50 dark:bg-rose-950/20">
          <CardBody className="p-5">
            <p className="text-xs uppercase tracking-widest font-bold text-rose-700 dark:text-rose-300">
              Acceso restringido
            </p>
            <p className="text-[11px] mt-1 text-rose-700/80 dark:text-rose-200/80">
              La configuración de impresora y formatos es sólo para administradores.
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="p-4 space-y-4 bg-gray-50 dark:bg-zinc-950 min-h-screen">
      {/* Header */}
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
            <Printer size={18} />
          </div>
          <div>
            <h1 className="text-sm font-bold uppercase tracking-widest">Configuración de impresora y formatos</h1>
            <p className="text-[10px] uppercase tracking-widest text-zinc-500">
              Perfil · Recibo · Etiquetas · Cajón
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip
            size="sm"
            variant="flat"
            color={isDirty ? "warning" : "success"}
            className="rounded-2xl"
            aria-live="polite"
          >
            {isDirty ? "Cambios sin guardar" : "Sin cambios"}
          </Chip>
          <Button
            size="sm"
            variant="flat"
            color="default"
            isDisabled={!isDirty || submitting}
            onPress={resetDirty}
            startContent={<RotateCcw size={14} />}
            className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
          >
            Restablecer
          </Button>
          <Button
            size="sm"
            color="warning"
            variant="flat"
            isDisabled={!config.drawer.enabled || drawerBusy}
            onPress={testDrawer}
            startContent={<DoorOpen size={14} />}
            isLoading={drawerBusy}
            className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
          >
            Probar cajón
          </Button>
          <Button
            size="sm"
            color="primary"
            variant="flat"
            isDisabled={testing}
            onPress={printTestPage}
            startContent={<TestTube2 size={14} />}
            isLoading={testing}
            className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
          >
            Imprimir página de prueba
          </Button>
          <Button
            size="sm"
            color="success"
            isDisabled={!canSave}
            onPress={handleSave}
            startContent={<Save size={14} />}
            isLoading={submitting}
            className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
          >
            Guardar
          </Button>
        </div>
      </header>

      {/* Validación */}
      {validation.errors.length > 0 && (
        <Card className="rounded-2xl border border-rose-500/40 bg-rose-50 dark:bg-rose-950/20">
          <CardBody className="p-4 text-[11px]">
            <div className="flex items-center gap-2 text-rose-700 dark:text-rose-300 font-bold uppercase tracking-widest mb-1">
              <AlertTriangle size={14} /> Errores
            </div>
            <ul className="list-disc pl-6 space-y-1 text-rose-800 dark:text-rose-200">
              {validation.errors.map((e) => (
                <li key={e.path}><span className="font-mono text-[10px] opacity-70">{e.path}</span> — {e.message}</li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
      {validation.warnings.length > 0 && (
        <Card className="rounded-2xl border border-amber-500/40 bg-amber-50 dark:bg-amber-950/20">
          <CardBody className="p-4 text-[11px]">
            <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 font-bold uppercase tracking-widest mb-1">
              <AlertTriangle size={14} /> Advertencias
            </div>
            <ul className="list-disc pl-6 space-y-1 text-amber-800 dark:text-amber-200">
              {validation.warnings.map((w) => (
                <li key={w.path}><span className="font-mono text-[10px] opacity-70">{w.path}</span> — {w.message}</li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {!hydrated ? (
        <div className="flex items-center justify-center p-10">
          <Spinner size="sm" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Columna de formulario */}
          <div className="lg:col-span-7 space-y-3">
            <Card className="rounded-2xl">
              <CardHeader className="pb-0">
                <Tabs
                  aria-label="Secciones de configuración"
                  color="success"
                  selectedKey={tab}
                  onSelectionChange={(k) => setTab(String(k) as TabKey)}
                  classNames={{
                    tabList: "bg-gray-100 dark:bg-zinc-950/50 p-1 rounded-2xl w-full",
                    cursor: "bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-white/5",
                    tabContent: "font-medium text-[10px] uppercase tracking-widest",
                  }}
                >
                  <Tab key="perfil" title="Perfil" />
                  <Tab key="recibo" title="Recibo" />
                  <Tab key="etiquetas" title="Etiquetas" />
                </Tabs>
              </CardHeader>
              <CardBody className="p-5 space-y-5">
                {tab === "perfil" && (
                  <PerfilTab
                    config={config}
                    update={update}
                    dbProfiles={dbProfiles}
                    onImportProfile={importProfile}
                  />
                )}
                {tab === "recibo" && (
                  <ReciboTab config={config} update={update} />
                )}
                {tab === "etiquetas" && (
                  <EtiquetasTab config={config} update={update} dbSizes={dbSizes} />
                )}
              </CardBody>
            </Card>
          </div>

          {/* Columna de preview */}
          <div className="lg:col-span-5">
            <div className="lg:sticky lg:top-4 space-y-3">
              <PreviewPanel config={config} activeTab={tab} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Perfil (connection + drawer)
// =============================================================================

interface TabProps {
  config: PrintingConfig;
  update: (mutator: (draft: PrintingConfig) => PrintingConfig | void) => void;
}

interface PerfilTabProps extends TabProps {
  dbProfiles: PrinterProfileRow[];
  onImportProfile: (row: PrinterProfileRow) => void;
}

function PerfilTab({ config, update, dbProfiles, onImportProfile }: PerfilTabProps) {
  const iface = config.connection.interface;
  const allowedProtocols = INTERFACE_PROTOCOLS[iface];

  return (
    <div className="space-y-5">
      <Section title="Conexión" icon={<Printer size={14} />}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="Alias"
            value={config.connection.alias}
            onValueChange={(v) => update((d) => { d.connection.alias = v; })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            isRequired
            aria-label="Alias de la impresora"
          />
          <Select
            label="Interfaz"
            selectedKeys={new Set([iface])}
            onSelectionChange={(keys) => {
              const next = Array.from(keys as Set<string>)[0] as PrinterInterface | undefined;
              if (!next) return;
              update((d) => {
                d.connection.interface = next;
                // Al cambiar interfaz, cae a su primer protocolo compatible.
                const allowed = INTERFACE_PROTOCOLS[next];
                if (!allowed.includes(d.connection.protocol)) {
                  d.connection.protocol = allowed[0];
                }
              });
            }}
            classNames={{ trigger: "rounded-2xl" }}
            aria-label="Interfaz física"
          >
            <SelectItem key={INTERFACES.USB}>USB (requiere bridge local)</SelectItem>
            <SelectItem key={INTERFACES.NETWORK}>Ethernet / Wi-Fi (TCP)</SelectItem>
            <SelectItem key={INTERFACES.SYSTEM}>Sistema operativo (spooler)</SelectItem>
          </Select>
          <Select
            label="Protocolo"
            selectedKeys={new Set([config.connection.protocol])}
            onSelectionChange={(keys) => {
              const next = Array.from(keys as Set<string>)[0] as PrinterProtocol | undefined;
              if (!next) return;
              update((d) => { d.connection.protocol = next; });
            }}
            classNames={{ trigger: "rounded-2xl" }}
            aria-label="Protocolo soportado"
          >
            {allowedProtocols.map((p) => (
              <SelectItem key={p}>{p.toUpperCase()}</SelectItem>
            ))}
          </Select>
          {iface === INTERFACES.USB && (
            <>
              <Input
                type="number"
                label="VendorId (0..65535)"
                value={numberOrEmpty(config.connection.usb.vendorId)}
                onValueChange={(v) => update((d) => {
                  d.connection.usb.vendorId = clampForInput(v, 0, 0xFFFF);
                })}
                classNames={{ inputWrapper: "rounded-2xl" }}
                aria-label="VendorId USB"
              />
              <Input
                type="number"
                label="ProductId (0..65535)"
                value={numberOrEmpty(config.connection.usb.productId)}
                onValueChange={(v) => update((d) => {
                  d.connection.usb.productId = clampForInput(v, 0, 0xFFFF);
                })}
                classNames={{ inputWrapper: "rounded-2xl" }}
                aria-label="ProductId USB"
              />
              <Input
                label="Ruta del dispositivo (opcional)"
                value={config.connection.usb.devicePath}
                onValueChange={(v) => update((d) => { d.connection.usb.devicePath = v; })}
                classNames={{ inputWrapper: "rounded-2xl" }}
                aria-label="Ruta del dispositivo USB"
                className="sm:col-span-2"
              />
            </>
          )}
          {iface === INTERFACES.NETWORK && (
            <>
              <Input
                label="Host o IP"
                value={config.connection.network.host}
                onValueChange={(v) => update((d) => { d.connection.network.host = v; })}
                classNames={{ inputWrapper: "rounded-2xl" }}
                aria-label="Host o IP de la impresora"
                isRequired
              />
              <Input
                type="number"
                label={`Puerto (${BOUNDS.port.min}..${BOUNDS.port.max})`}
                value={numberOrEmpty(config.connection.network.port)}
                onValueChange={(v) => update((d) => {
                  d.connection.network.port = clampForInput(v, BOUNDS.port.min, BOUNDS.port.max);
                })}
                classNames={{ inputWrapper: "rounded-2xl" }}
                aria-label="Puerto TCP"
              />
            </>
          )}
          {iface === INTERFACES.SYSTEM && (
            <>
              <Input
                label="Nombre de la impresora en el SO"
                value={config.connection.system.printerName}
                onValueChange={(v) => update((d) => { d.connection.system.printerName = v; })}
                classNames={{ inputWrapper: "rounded-2xl" }}
                aria-label="Nombre de la impresora en el SO"
              />
              <Select
                label="Spooler"
                selectedKeys={new Set([config.connection.system.spooler])}
                onSelectionChange={(keys) => {
                  const next = Array.from(keys as Set<string>)[0];
                  if (next === SPOOLERS.WINDOWS || next === SPOOLERS.CUPS) {
                    update((d) => { d.connection.system.spooler = next; });
                  }
                }}
                classNames={{ trigger: "rounded-2xl" }}
                aria-label="Spooler del sistema"
              >
                <SelectItem key={SPOOLERS.WINDOWS}>Windows</SelectItem>
                <SelectItem key={SPOOLERS.CUPS}>CUPS (Linux/macOS)</SelectItem>
              </Select>
            </>
          )}
        </div>
      </Section>

      <Divider className="opacity-50" />

      <Section title="Cajón de dinero" icon={<DoorOpen size={14} />}>
        <div className="flex flex-wrap items-center gap-4">
          <Switch
            isSelected={config.drawer.enabled}
            onValueChange={(v) => update((d) => { d.drawer.enabled = v; })}
            size="sm"
            aria-label="Cajón conectado a esta impresora"
          >
            <span className="text-[11px] uppercase tracking-widest">Cajón conectado</span>
          </Switch>
          <Select
            label="Evento de apertura"
            selectedKeys={new Set([config.drawer.event])}
            onSelectionChange={(keys) => {
              const next = Array.from(keys as Set<string>)[0] as DrawerEvent | undefined;
              if (!next) return;
              update((d) => { d.drawer.event = next; });
            }}
            classNames={{ trigger: "rounded-2xl" }}
            aria-label="Evento que dispara el pulso al cajón"
            isDisabled={!config.drawer.enabled}
            className="flex-1 min-w-[220px]"
          >
            <SelectItem key={DRAWER_EVENTS.BEFORE_PRINT}>Antes de imprimir</SelectItem>
            <SelectItem key={DRAWER_EVENTS.AFTER_PRINT}>Después de imprimir</SelectItem>
            <SelectItem key={DRAWER_EVENTS.MANUAL}>Manual (solo con botón)</SelectItem>
          </Select>
        </div>
        <Input
          label="Comando del cajón (ESC/POS literal)"
          value={config.drawer.command}
          onValueChange={(v) => update((d) => { d.drawer.command = v; })}
          classNames={{ inputWrapper: "rounded-2xl" }}
          description={'El valor por defecto `\\x1B\\x70\\x00\\x19\\xFA` es la secuencia ESC p 0 25 250. El frontend lo guarda como texto y NO lo evalúa.'}
          isDisabled={!config.drawer.enabled}
          aria-label="Comando literal del cajón"
        />
      </Section>

      {dbProfiles.length > 0 && (
        <>
          <Divider className="opacity-50" />
          <Section title="Perfiles existentes en el servidor" icon={<Download size={14} />}>
            <p className="text-[10px] text-zinc-500 mb-2">
              Importa un perfil guardado en /labels/printers para hidratar la configuración actual.
            </p>
            <ul className="space-y-1">
              {dbProfiles.map((p) => (
                <li
                  key={p.id ?? p.name}
                  className="flex items-center justify-between gap-2 p-2 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-white/5"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-bold">
                      {p.name}
                      {p.isDefault && (
                        <Chip size="sm" variant="flat" color="success" className="ml-2 rounded-xl">default</Chip>
                      )}
                      {p.drawerConnected && (
                        <Chip size="sm" variant="flat" color="warning" className="ml-2 rounded-xl">cajón</Chip>
                      )}
                    </p>
                    <p className="text-[9px] text-zinc-500 truncate">
                      {p.protocol} · {p.target} {p.model ? `· ${p.model}` : ""}
                    </p>
                  </div>
                  <Tooltip content="Reemplazar conexión actual con este perfil">
                    <Button
                      size="sm"
                      variant="flat"
                      onPress={() => onImportProfile(p)}
                      className="rounded-xl text-[10px] uppercase tracking-widest font-bold"
                      startContent={<Download size={12} />}
                    >
                      Importar
                    </Button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}

// =============================================================================
// Recibo
// =============================================================================

function ReciboTab({ config, update }: TabProps) {
  const paper = config.receipt.paper;
  const isCustom = paper === PAPER_PRESETS.CUSTOM;

  return (
    <div className="space-y-5">
      <Section title="Papel y columnas" icon={<FilePenLine size={14} />}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Select
            label="Ancho del rollo"
            selectedKeys={new Set([paper])}
            onSelectionChange={(keys) => {
              const next = Array.from(keys as Set<string>)[0] as PaperPreset | undefined;
              if (!next) return;
              update((d) => Object.assign(d, applyReceiptPaperPreset(d, next)));
            }}
            classNames={{ trigger: "rounded-2xl" }}
            aria-label="Preset de ancho del rollo"
          >
            <SelectItem key={PAPER_PRESETS.WIDTH_80}>80 mm (48 columnas)</SelectItem>
            <SelectItem key={PAPER_PRESETS.WIDTH_58}>58 mm (32 columnas)</SelectItem>
            <SelectItem key={PAPER_PRESETS.CUSTOM}>Personalizado</SelectItem>
          </Select>
          <Input
            type="number"
            label={`Ancho (mm) ${BOUNDS.receiptWidthMm.min}..${BOUNDS.receiptWidthMm.max}`}
            value={numberOrEmpty(config.receipt.widthMm)}
            onValueChange={(v) => update((d) => {
              d.receipt.widthMm = clampForInput(v, BOUNDS.receiptWidthMm.min, BOUNDS.receiptWidthMm.max);
              d.receipt.paper = PAPER_PRESETS.CUSTOM;
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            isDisabled={!isCustom}
            aria-label="Ancho del rollo en milímetros"
          />
          <Input
            type="number"
            label={`Columnas (${BOUNDS.receiptColumns.min}..${BOUNDS.receiptColumns.max})`}
            value={numberOrEmpty(config.receipt.columns)}
            onValueChange={(v) => update((d) => {
              d.receipt.columns = clampForInput(v, BOUNDS.receiptColumns.min, BOUNDS.receiptColumns.max);
              d.receipt.paper = PAPER_PRESETS.CUSTOM;
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            isDisabled={!isCustom}
            aria-label="Cantidad de columnas monoespacio"
          />
        </div>
        <Select
          label="Modo de corte"
          selectedKeys={new Set([config.receipt.cut])}
          onSelectionChange={(keys) => {
            const next = Array.from(keys as Set<string>)[0] as CutMode | undefined;
            if (!next) return;
            update((d) => { d.receipt.cut = next; });
          }}
          classNames={{ trigger: "rounded-2xl" }}
          aria-label="Modo de corte"
        >
          <SelectItem key={CUT_MODES.AUTO}>Automático (cuchilla)</SelectItem>
          <SelectItem key={CUT_MODES.MANUAL}>Manual (marca línea)</SelectItem>
          <SelectItem key={CUT_MODES.NONE}>Sin corte</SelectItem>
        </Select>
      </Section>

      <Divider className="opacity-50" />

      <Section title="Encabezado">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="Nombre del negocio"
            value={config.receipt.header.businessName}
            onValueChange={(v) => update((d) => { d.receipt.header.businessName = v; })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            aria-label="Nombre del negocio"
          />
          <Input
            label="NIT / Documento"
            value={config.receipt.header.nit}
            onValueChange={(v) => update((d) => { d.receipt.header.nit = v; })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            aria-label="NIT"
          />
          <Input
            label="Dirección"
            value={config.receipt.header.address}
            onValueChange={(v) => update((d) => { d.receipt.header.address = v; })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            aria-label="Dirección"
          />
          <Input
            label="Teléfono"
            value={config.receipt.header.phone}
            onValueChange={(v) => update((d) => { d.receipt.header.phone = v; })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            aria-label="Teléfono"
          />
          <Input
            label="Resolución DIAN / Legal"
            value={config.receipt.header.resolution}
            onValueChange={(v) => update((d) => { d.receipt.header.resolution = v; })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            className="sm:col-span-2"
            aria-label="Resolución DIAN"
          />
        </div>
      </Section>

      <Divider className="opacity-50" />

      <Section title="Pie y contenido">
        <Input
          label="Mensaje de agradecimiento"
          value={config.receipt.footer.thankYou}
          onValueChange={(v) => update((d) => { d.receipt.footer.thankYou = v; })}
          classNames={{ inputWrapper: "rounded-2xl" }}
          aria-label="Mensaje de agradecimiento"
        />
        <div className="flex flex-wrap gap-4">
          <Switch
            isSelected={config.receipt.content.showLogo}
            onValueChange={(v) => update((d) => { d.receipt.content.showLogo = v; })}
            size="sm"
            aria-label="Mostrar logo"
          >
            <span className="text-[11px] uppercase tracking-widest">Logo</span>
          </Switch>
          <Switch
            isSelected={config.receipt.content.showTaxes}
            onValueChange={(v) => update((d) => { d.receipt.content.showTaxes = v; })}
            size="sm"
            aria-label="Mostrar impuestos"
          >
            <span className="text-[11px] uppercase tracking-widest">Impuestos</span>
          </Switch>
          <Switch
            isSelected={config.receipt.content.showValidationQR}
            onValueChange={(v) => update((d) => { d.receipt.content.showValidationQR = v; })}
            size="sm"
            aria-label="Mostrar QR de validación"
          >
            <span className="text-[11px] uppercase tracking-widest">QR de validación</span>
          </Switch>
        </div>
      </Section>
    </div>
  );
}

// =============================================================================
// Etiquetas
// =============================================================================

interface EtiquetasTabProps extends TabProps {
  dbSizes: SizeTemplateRow[];
}

function EtiquetasTab({ config, update, dbSizes }: EtiquetasTabProps) {
  const isCustomSize = config.labels.sizePreset === LABEL_SIZE_PRESETS.CUSTOM;

  return (
    <div className="space-y-5">
      <Section title="Formato de la etiqueta" icon={<Tag size={14} />}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Select
            label="Tamaño"
            selectedKeys={new Set([config.labels.sizePreset])}
            onSelectionChange={(keys) => {
              const next = Array.from(keys as Set<string>)[0] as LabelSizePreset | undefined;
              if (!next) return;
              update((d) => Object.assign(d, applyLabelSizePreset(d, next)));
            }}
            classNames={{ trigger: "rounded-2xl" }}
            aria-label="Preset de tamaño"
          >
            <SelectItem key={LABEL_SIZE_PRESETS["50X30"]}>50 × 30 mm</SelectItem>
            <SelectItem key={LABEL_SIZE_PRESETS["40X30"]}>40 × 30 mm</SelectItem>
            <SelectItem key={LABEL_SIZE_PRESETS["30X20"]}>30 × 20 mm</SelectItem>
            <SelectItem key={LABEL_SIZE_PRESETS.CUSTOM}>Personalizado</SelectItem>
          </Select>
          <Input
            type="number"
            label={`Ancho (mm) ${BOUNDS.labelWidthMm.min}..${BOUNDS.labelWidthMm.max}`}
            value={numberOrEmpty(config.labels.widthMm)}
            onValueChange={(v) => update((d) => {
              d.labels.widthMm = clampForInput(v, BOUNDS.labelWidthMm.min, BOUNDS.labelWidthMm.max);
              d.labels.sizePreset = LABEL_SIZE_PRESETS.CUSTOM;
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            isDisabled={!isCustomSize}
            aria-label="Ancho de etiqueta"
          />
          <Input
            type="number"
            label={`Alto (mm) ${BOUNDS.labelHeightMm.min}..${BOUNDS.labelHeightMm.max}`}
            value={numberOrEmpty(config.labels.heightMm)}
            onValueChange={(v) => update((d) => {
              d.labels.heightMm = clampForInput(v, BOUNDS.labelHeightMm.min, BOUNDS.labelHeightMm.max);
              d.labels.sizePreset = LABEL_SIZE_PRESETS.CUSTOM;
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            isDisabled={!isCustomSize}
            aria-label="Alto de etiqueta"
          />
          <Select
            label="Columnas"
            selectedKeys={new Set([String(config.labels.columns)])}
            onSelectionChange={(keys) => {
              const next = Number(Array.from(keys as Set<string>)[0]);
              if (next === 1 || next === 2) {
                update((d) => { d.labels.columns = next; });
              }
            }}
            classNames={{ trigger: "rounded-2xl" }}
            aria-label="Columnas de etiqueta"
          >
            <SelectItem key="1">1 columna</SelectItem>
            <SelectItem key="2">2 columnas</SelectItem>
          </Select>
          <Input
            type="number"
            label={`Separación horizontal (mm) 0..${BOUNDS.horizontalGapMm.max}`}
            value={numberOrEmpty(config.labels.horizontalGapMm)}
            onValueChange={(v) => update((d) => {
              d.labels.horizontalGapMm = clampForInput(v, BOUNDS.horizontalGapMm.min, BOUNDS.horizontalGapMm.max);
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            aria-label="Separación horizontal entre etiquetas"
          />
        </div>
      </Section>

      <Divider className="opacity-50" />

      <Section title="Sensor del papel">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select
            label="Tipo de sensor"
            selectedKeys={new Set([config.labels.sensor.type])}
            onSelectionChange={(keys) => {
              const next = Array.from(keys as Set<string>)[0] as SensorType | undefined;
              if (!next) return;
              update((d) => { d.labels.sensor.type = next; });
            }}
            classNames={{ trigger: "rounded-2xl" }}
            aria-label="Tipo de sensor"
          >
            <SelectItem key={SENSOR_TYPES.GAP}>GAP (separación transparente)</SelectItem>
            <SelectItem key={SENSOR_TYPES.BLACK_MARK}>Black mark (marca negra)</SelectItem>
          </Select>
          <Input
            type="number"
            label={`Separación / marca (mm) 0..${BOUNDS.sensorGapMm.max}`}
            value={numberOrEmpty(config.labels.sensor.gapMm)}
            onValueChange={(v) => update((d) => {
              d.labels.sensor.gapMm = clampForInput(v, BOUNDS.sensorGapMm.min, BOUNDS.sensorGapMm.max);
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            aria-label="Separación/marca del sensor"
          />
        </div>
      </Section>

      <Divider className="opacity-50" />

      <Section title="Nombre del producto">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <Switch
            isSelected={config.labels.productName.visible}
            onValueChange={(v) => update((d) => { d.labels.productName.visible = v; })}
            size="sm"
            aria-label="Mostrar nombre de producto"
          >
            <span className="text-[11px] uppercase tracking-widest">Mostrar</span>
          </Switch>
          <SliderWithInput
            label="Tamaño (pt)"
            min={BOUNDS.productNameFontPt.min}
            max={BOUNDS.productNameFontPt.max}
            value={config.labels.productName.fontPt}
            onChange={(n) => update((d) => { d.labels.productName.fontPt = n; })}
          />
          <SliderWithInput
            label="Máx. caracteres"
            min={BOUNDS.productNameMaxChars.min}
            max={120}
            value={config.labels.productName.maxChars}
            onChange={(n) => update((d) => { d.labels.productName.maxChars = n; })}
          />
        </div>
      </Section>

      <Divider className="opacity-50" />

      <Section title="Precio">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <div className="space-y-2">
            <Switch
              isSelected={config.labels.price.visible}
              onValueChange={(v) => update((d) => { d.labels.price.visible = v; })}
              size="sm"
              aria-label="Mostrar precio"
            >
              <span className="text-[11px] uppercase tracking-widest">Mostrar</span>
            </Switch>
            <Switch
              isSelected={config.labels.price.emphasized}
              onValueChange={(v) => update((d) => { d.labels.price.emphasized = v; })}
              size="sm"
              isDisabled={!config.labels.price.visible}
              aria-label="Resaltar precio en negrita"
            >
              <span className="text-[11px] uppercase tracking-widest">Negrita</span>
            </Switch>
          </div>
          <SliderWithInput
            label="Tamaño (pt)"
            min={BOUNDS.priceFontPt.min}
            max={BOUNDS.priceFontPt.max}
            value={config.labels.price.fontPt}
            onChange={(n) => update((d) => { d.labels.price.fontPt = n; })}
          />
        </div>
      </Section>

      <Divider className="opacity-50" />

      <Section title="Código de barras">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <Select
            label="Simbología"
            selectedKeys={new Set([config.labels.barcode.symbology])}
            onSelectionChange={(keys) => {
              const next = Array.from(keys as Set<string>)[0] as BarcodeSymbology | undefined;
              if (!next) return;
              update((d) => { d.labels.barcode.symbology = next; });
            }}
            classNames={{ trigger: "rounded-2xl" }}
            aria-label="Simbología del código de barras"
          >
            <SelectItem key={BARCODE_SYMBOLOGIES.CODE128}>CODE128</SelectItem>
            <SelectItem key={BARCODE_SYMBOLOGIES.EAN13}>EAN13</SelectItem>
            <SelectItem key={BARCODE_SYMBOLOGIES.CODE39}>CODE39</SelectItem>
          </Select>
          <SliderWithInput
            label="Altura (mm)"
            min={BOUNDS.barcodeHeightMm.min}
            max={BOUNDS.barcodeHeightMm.max}
            value={config.labels.barcode.heightMm}
            onChange={(n) => update((d) => { d.labels.barcode.heightMm = n; })}
          />
        </div>
      </Section>

      <Divider className="opacity-50" />

      <Section title="Extras">
        <div className="flex flex-wrap gap-4">
          <Switch
            isSelected={config.labels.extras.showDate}
            onValueChange={(v) => update((d) => { d.labels.extras.showDate = v; })}
            size="sm"
          >
            <span className="text-[11px] uppercase tracking-widest">Fecha</span>
          </Switch>
          <Switch
            isSelected={config.labels.extras.showInternalCode}
            onValueChange={(v) => update((d) => { d.labels.extras.showInternalCode = v; })}
            size="sm"
          >
            <span className="text-[11px] uppercase tracking-widest">Código interno</span>
          </Switch>
          <Switch
            isSelected={config.labels.extras.showCategory}
            onValueChange={(v) => update((d) => { d.labels.extras.showCategory = v; })}
            size="sm"
          >
            <span className="text-[11px] uppercase tracking-widest">Categoría</span>
          </Switch>
        </div>
      </Section>

      {dbSizes.length > 0 && (
        <>
          <Divider className="opacity-50" />
          <Section title="Plantillas existentes en el servidor" icon={<Download size={14} />}>
            <ul className="space-y-1">
              {dbSizes.map((t) => (
                <li
                  key={t.id ?? t.name}
                  className="flex items-center justify-between gap-2 p-2 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-white/5"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-bold">
                      {t.name}
                      {t.isDefault && (
                        <Chip size="sm" variant="flat" color="success" className="ml-2 rounded-xl">default</Chip>
                      )}
                    </p>
                    <p className="text-[9px] text-zinc-500 truncate">
                      {t.widthMm} × {t.heightMm} mm · {t.barcodeFormat || "—"} · {t.columnsCount ?? 1} col
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="flat"
                    onPress={() => update((d) => {
                      d.labels.widthMm = Math.max(BOUNDS.labelWidthMm.min, Math.round(t.widthMm));
                      d.labels.heightMm = Math.max(BOUNDS.labelHeightMm.min, Math.round(t.heightMm));
                      d.labels.sizePreset = LABEL_SIZE_PRESETS.CUSTOM;
                      if (t.columnsCount === 1 || t.columnsCount === 2) {
                        d.labels.columns = t.columnsCount;
                      }
                      const sym = (t.barcodeFormat || "").toUpperCase();
                      if (sym === "EAN13" || sym === "CODE128" || sym === "CODE39") {
                        d.labels.barcode.symbology = sym;
                      }
                    })}
                    className="rounded-xl text-[10px] uppercase tracking-widest font-bold"
                    startContent={<Download size={12} />}
                  >
                    Importar
                  </Button>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}

// =============================================================================
// Preview panel (receipt + label)
// =============================================================================

interface PreviewProps {
  config: PrintingConfig;
  activeTab: TabKey;
}

function PreviewPanel({ config, activeTab }: PreviewProps) {
  // En móvil mostramos sólo el preview relacionado al tab para no abrumar.
  return (
    <>
      {(activeTab === "recibo" || typeof window === "undefined") && (
        <ReceiptPreview config={config} />
      )}
      {(activeTab === "etiquetas" || typeof window === "undefined") && (
        <LabelPreview config={config} />
      )}
      {activeTab === "perfil" && (
        <>
          <ReceiptPreview config={config} />
          <LabelPreview config={config} />
        </>
      )}
      <PreviewLegend config={config} />
    </>
  );
}

function PreviewLegend({ config }: { config: PrintingConfig }) {
  return (
    <Card className="rounded-2xl bg-sky-50 dark:bg-sky-950/20 border border-sky-500/30">
      <CardBody className="p-4 text-[11px] text-sky-800 dark:text-sky-200">
        <div className="flex items-center gap-2 font-bold uppercase tracking-widest mb-2">
          <CheckCircle2 size={14} /> Resumen físico
        </div>
        <ul className="list-disc pl-5 space-y-1">
          <li>Recibo: {config.receipt.widthMm} mm · {config.receipt.columns} columnas · corte {config.receipt.cut}</li>
          <li>Etiqueta: {config.labels.widthMm} × {config.labels.heightMm} mm · {config.labels.columns} columna{config.labels.columns === 2 ? "s" : ""} · gap {config.labels.horizontalGapMm} mm</li>
          <li>Sensor {config.labels.sensor.type.toLowerCase()} · {config.labels.sensor.gapMm} mm</li>
          <li>Barcode {config.labels.barcode.symbology} · altura {config.labels.barcode.heightMm} mm</li>
        </ul>
      </CardBody>
    </Card>
  );
}

function ReceiptPreview({ config }: { config: PrintingConfig }) {
  // Escalamos el papel a 3× su ancho en mm → mm×3 px para que se vea legible
  // sin tapar la columna. Un recibo de 80mm quedará a 240px, uno de 58mm a
  // 174px. El clamp evita que un ancho exagerado explote el layout.
  const widthPx = Math.max(140, Math.min(360, Math.round(config.receipt.widthMm * 3)));
  const cols = config.receipt.columns;
  const lines = [
    { name: "Arroz premium 1kg", qty: 2, unit: 4500 },
    { name: "Aceite veg. 1L", qty: 1, unit: 7200 },
    { name: "Azúcar morena 500g", qty: 3, unit: 3800 },
  ];
  const subtotal = lines.reduce((acc, l) => acc + l.qty * l.unit, 0);
  const taxes = Math.round(subtotal * 0.08);
  const total = subtotal + (config.receipt.content.showTaxes ? taxes : 0);
  const header = config.receipt.header;

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-0">
        <div className="flex items-center gap-2">
          <FilePenLine size={14} />
          <span className="text-[10px] uppercase tracking-widest font-bold">Preview recibo</span>
        </div>
      </CardHeader>
      <CardBody className="p-4 flex justify-center">
        <div
          className="bg-white text-black rounded-md shadow-inner p-3 font-mono text-[10px] leading-snug"
          style={{ width: `${widthPx}px` }}
          aria-label="Vista previa del recibo"
          role="img"
        >
          {config.receipt.content.showLogo && (
            <div className="h-10 border border-dashed border-zinc-400 flex items-center justify-center text-[9px] mb-2 uppercase tracking-widest">
              Logo
            </div>
          )}
          <div className="text-center font-bold uppercase tracking-tight">
            {header.businessName || "NOMBRE DEL NEGOCIO"}
          </div>
          {header.nit && <div className="text-center text-[9px]">{header.nit}</div>}
          {header.address && <div className="text-center text-[9px]">{header.address}</div>}
          {header.phone && <div className="text-center text-[9px]">{header.phone}</div>}
          <div className="my-1 border-b border-dashed border-zinc-400" />
          <div className="flex justify-between text-[9px]"><span>Ticket</span><span>#0001</span></div>
          <div className="flex justify-between text-[9px]"><span>Cajero</span><span>DEMO</span></div>
          <div className="my-1 border-b border-dashed border-zinc-400" />
          <div className="text-[9px]">
            {`CANT PRODUCTO`.padEnd(cols - 10)}{"TOTAL".padStart(10)}
          </div>
          <div className="border-b border-dashed border-zinc-400 my-0.5" />
          {lines.map((l) => (
            <div key={l.name} className="text-[9px] flex justify-between gap-2">
              <span>{l.qty} × {l.name}</span>
              <span>${(l.qty * l.unit).toLocaleString("es-CO")}</span>
            </div>
          ))}
          <div className="border-b border-dashed border-zinc-400 my-0.5" />
          <div className="flex justify-between text-[9px]"><span>Subtotal</span><span>${subtotal.toLocaleString("es-CO")}</span></div>
          {config.receipt.content.showTaxes && (
            <div className="flex justify-between text-[9px]"><span>IVA 8%</span><span>${taxes.toLocaleString("es-CO")}</span></div>
          )}
          <div className="flex justify-between text-[10px] font-bold mt-0.5"><span>TOTAL</span><span>${total.toLocaleString("es-CO")}</span></div>
          <div className="border-b border-dashed border-zinc-400 my-1" />
          {config.receipt.content.showValidationQR && (
            <div className="flex items-center justify-center my-1">
              <div
                className="w-14 h-14 bg-[repeating-linear-gradient(45deg,#000_0_2px,#fff_2px_4px)]"
                aria-hidden="true"
              />
            </div>
          )}
          {header.resolution && (
            <div className="text-[8px] text-center opacity-70 leading-tight">{header.resolution}</div>
          )}
          <div className="text-center font-bold mt-1">{config.receipt.footer.thankYou}</div>
          <div className="mt-2 text-[8px] text-center uppercase tracking-widest text-rose-600">
            {config.receipt.cut === "AUTO" && "— — — corte automático — — —"}
            {config.receipt.cut === "MANUAL" && "— ✂ corta aquí ✂ —"}
            {config.receipt.cut === "NONE" && "(sin corte)"}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function LabelPreview({ config }: { config: PrintingConfig }) {
  // Escalamos la etiqueta por ancho mínimo visual (12px/mm). Para columnas
  // dibujamos dos cajas una al lado de la otra separadas por horizontalGap.
  const scale = 10; // 10 px por mm → 50mm = 500px antes de clamp
  const labelW = Math.min(240, Math.max(80, config.labels.widthMm * scale * 0.6));
  const labelH = Math.min(240, Math.max(60, config.labels.heightMm * scale * 0.6));
  const gapPx = Math.round(config.labels.horizontalGapMm * scale * 0.6);
  const sensorPx = Math.max(4, Math.round(config.labels.sensor.gapMm * scale * 0.6));

  // El nombre truncado respeta maxChars.
  const sampleName = "Arroz premium especial × 1000g con fibras naturales";
  const nameMax = config.labels.productName.maxChars;
  const displayedName = sampleName.slice(0, nameMax);

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-0">
        <div className="flex items-center gap-2">
          <Tag size={14} />
          <span className="text-[10px] uppercase tracking-widest font-bold">Preview etiqueta</span>
        </div>
      </CardHeader>
      <CardBody className="p-4">
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-0" style={{ gap: `${gapPx}px` }}>
            {Array.from({ length: config.labels.columns }).map((_, i) => (
              <SingleLabel
                key={i}
                widthPx={labelW}
                heightPx={labelH}
                displayedName={displayedName}
                config={config}
                truncated={displayedName.length < sampleName.length}
              />
            ))}
          </div>
          {/* Marcador del sensor */}
          <div className="flex items-center gap-2 text-[9px] uppercase tracking-widest text-zinc-500">
            <span>{config.labels.sensor.type === "GAP" ? "GAP" : "BLACK MARK"}:</span>
            {config.labels.sensor.type === "GAP" ? (
              <div className="h-3 bg-zinc-200 dark:bg-zinc-800 rounded" style={{ width: `${sensorPx}px` }} aria-hidden />
            ) : (
              <div className="h-3 bg-black rounded" style={{ width: `${sensorPx}px` }} aria-hidden />
            )}
            <span>{config.labels.sensor.gapMm} mm</span>
          </div>
          <p className="text-[9px] uppercase tracking-widest text-zinc-500">
            {config.labels.widthMm} × {config.labels.heightMm} mm (vista a escala)
          </p>
        </div>
      </CardBody>
    </Card>
  );
}

function SingleLabel({ widthPx, heightPx, displayedName, config, truncated }: {
  widthPx: number;
  heightPx: number;
  displayedName: string;
  config: PrintingConfig;
  truncated: boolean;
}) {
  const barcodeHeight = Math.max(16, Math.min(heightPx * 0.4, config.labels.barcode.heightMm * 6));
  const bars = useMemo(() => {
    const seq = [1, 2, 1, 1, 3, 1, 2, 1, 1, 1, 3, 2, 1, 1, 2, 1, 3, 1, 1, 2, 1, 2, 1];
    return seq;
  }, []);
  return (
    <div
      className="bg-white text-black rounded border border-zinc-300 shadow-sm p-2 flex flex-col justify-between relative overflow-hidden"
      style={{ width: `${widthPx}px`, height: `${heightPx}px` }}
      aria-label="Vista previa de etiqueta"
      role="img"
    >
      {config.labels.productName.visible && (
        <div
          className="truncate font-semibold"
          style={{ fontSize: `${Math.max(7, config.labels.productName.fontPt * 0.9)}px` }}
          title={displayedName}
        >
          {displayedName || "SIN NOMBRE"}
          {truncated && <span className="opacity-50">…</span>}
        </div>
      )}
      <div className="flex items-end justify-between gap-2">
        <div className="flex items-end gap-[1px]" style={{ height: `${barcodeHeight}px` }} aria-hidden="true">
          {bars.map((w, idx) => (
            <div
              key={idx}
              style={{
                width: `${w}px`,
                height: "100%",
                background: idx % 2 === 0 ? "#000" : "transparent",
              }}
            />
          ))}
        </div>
        {config.labels.price.visible && (
          <div
            className={config.labels.price.emphasized ? "font-bold" : "font-medium"}
            style={{ fontSize: `${config.labels.price.fontPt}px`, lineHeight: 1 }}
          >
            $12.900
          </div>
        )}
      </div>
      <div className="flex justify-between text-[7px] uppercase tracking-widest text-zinc-500">
        <span>{config.labels.barcode.symbology}</span>
        <span>7701234567890</span>
      </div>
      <div className="flex flex-wrap gap-1 absolute bottom-1 left-2 text-[7px] text-zinc-500 uppercase tracking-widest">
        {config.labels.extras.showDate && <span>· fecha</span>}
        {config.labels.extras.showInternalCode && <span>· cód</span>}
        {config.labels.extras.showCategory && <span>· cat</span>}
      </div>
    </div>
  );
}

// =============================================================================
// Section / SliderWithInput primitives
// =============================================================================

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-[11px] uppercase tracking-widest font-bold text-zinc-700 dark:text-zinc-200">
        {icon ? icon : null}
        {title}
      </h3>
      {children}
    </section>
  );
}

function SliderWithInput({ label, min, max, value, onChange }: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (n: number) => void;
}) {
  const safe = Math.max(min, Math.min(max, value));
  return (
    <div className="space-y-1">
      <label className="text-[10px] uppercase tracking-widest text-zinc-500">{label}</label>
      <div className="flex items-center gap-2">
        <Slider
          aria-label={label}
          size="sm"
          minValue={min}
          maxValue={max}
          step={1}
          value={safe}
          onChange={(v) => onChange(typeof v === "number" ? v : v[0])}
          className="flex-1"
        />
        <Input
          type="number"
          value={String(safe)}
          onValueChange={(v) => onChange(clampForInput(v, min, max))}
          classNames={{
            inputWrapper: "rounded-xl",
            input: "text-center tabular-nums",
          }}
          className="w-20"
          aria-label={`${label} (valor exacto)`}
        />
      </div>
    </div>
  );
}

// =============================================================================
// Impresión de página de prueba (iframe aislado)
// =============================================================================

/**
 * Dibuja la página de prueba dentro de un iframe oculto con @page acorde al
 * target. El HTML se arma concatenando STRINGS ESCAPADOS: ningún valor del
 * usuario llega sin pasar por `escapeHtml`.
 */
function runIframeTestPrint(target: "receipt" | "label", config: PrintingConfig) {
  if (typeof document === "undefined") return;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.left = "-9999px";
  iframe.style.top = "0";
  iframe.style.width = "1px";
  iframe.style.height = "1px";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document;
  if (!doc) {
    iframe.remove();
    return;
  }

  const pageSize = target === "label"
    ? `${config.labels.widthMm}mm ${config.labels.heightMm}mm`
    : `${config.receipt.widthMm}mm auto`;

  const html = target === "label"
    ? buildLabelTestHtml(config, pageSize)
    : buildReceiptTestHtml(config, pageSize);

  doc.open();
  doc.write(html);
  doc.close();

  const fire = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch {
      // El navegador puede denegar imprimir si el usuario cerró el diálogo.
    } finally {
      setTimeout(() => { if (iframe.parentNode) iframe.remove(); }, 1500);
    }
  };
  if (iframe.contentWindow?.document.readyState === "complete") fire();
  else iframe.onload = fire;
}

function buildReceiptTestHtml(config: PrintingConfig, pageSize: string): string {
  const h = config.receipt.header;
  const cols = config.receipt.columns;
  const businessName = escapeHtml(h.businessName || "PRUEBA DE RECIBO");
  const nit = escapeHtml(h.nit);
  const address = escapeHtml(h.address);
  const phone = escapeHtml(h.phone);
  const resolution = escapeHtml(h.resolution);
  const thankYou = escapeHtml(config.receipt.footer.thankYou);
  const widthMm = Math.max(20, config.receipt.widthMm);
  const ruler = "·".repeat(Math.max(1, cols));
  const scaleRow = Array.from({ length: Math.min(cols, 20) }).map((_, i) => (i % 2 === 0 ? "|" : "·")).join("");

  // Nunca inyectamos HTML dinámico: todo pasa por escapeHtml.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Prueba de recibo</title>
<style>
  @page { size: ${pageSize}; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${widthMm}mm; background: #fff; color: #000; }
  body { font-family: "Courier New", Consolas, monospace; font-weight: 700; font-size: 11px; line-height: 1.3; padding: 3mm 2mm; }
  .center { text-align: center; }
  .sep { border-bottom: 1px dashed #000; margin: 1mm 0; }
  .ruler { font-size: 10px; letter-spacing: 0; }
  .scale { font-size: 11px; margin-top: 2mm; }
  .cut { border-top: 1px dashed #000; margin-top: 4mm; padding-top: 1mm; text-align:center; font-size: 10px; }
</style></head>
<body>
  <div class="center">${businessName}</div>
  ${nit ? `<div class="center">${nit}</div>` : ""}
  ${address ? `<div class="center">${address}</div>` : ""}
  ${phone ? `<div class="center">${phone}</div>` : ""}
  <div class="sep"></div>
  <div>PÁGINA DE PRUEBA</div>
  <div>Columnas: ${cols}</div>
  <div>Ancho: ${widthMm} mm</div>
  <div>Regla de alineación:</div>
  <div class="ruler">${escapeHtml(ruler)}</div>
  <div class="scale">${escapeHtml(scaleRow)}</div>
  <div class="sep"></div>
  <div>SUBTOTAL        $10.000</div>
  <div>IVA 8%          $   800</div>
  <div>TOTAL           $10.800</div>
  <div class="sep"></div>
  ${resolution ? `<div class="center">${resolution}</div>` : ""}
  <div class="center">${thankYou}</div>
  <div class="cut">— — corte ${escapeHtml(config.receipt.cut)} — —</div>
</body></html>`;
}

function buildLabelTestHtml(config: PrintingConfig, pageSize: string): string {
  const widthMm = config.labels.widthMm;
  const heightMm = config.labels.heightMm;
  const columns = config.labels.columns;
  const gapMm = config.labels.horizontalGapMm;
  const nameFont = config.labels.productName.fontPt;
  const priceFont = config.labels.price.fontPt;
  const barcodeH = config.labels.barcode.heightMm;
  const symbology = escapeHtml(config.labels.barcode.symbology);
  const testCode = "7701234567890";
  const barWidths = [1, 2, 1, 1, 3, 1, 2, 1, 1, 1, 3, 2, 1, 1, 2, 1, 3, 1, 1, 2, 1, 2, 1, 1, 3, 2];

  const singleLabel = `
    <div class="label">
      ${config.labels.productName.visible
        ? `<div class="name" style="font-size: ${nameFont}pt;">PRUEBA DE ETIQUETA</div>`
        : ""}
      <div class="barcode" style="height: ${barcodeH}mm;">
        ${barWidths.map((w, i) => `<span style="width:${w}px;background:${i % 2 === 0 ? "#000" : "#fff"}"></span>`).join("")}
      </div>
      <div class="row">
        <div class="code">${symbology} · ${escapeHtml(testCode)}</div>
        ${config.labels.price.visible
          ? `<div class="price" style="font-size:${priceFont}pt; font-weight:${config.labels.price.emphasized ? "900" : "600"}">$12.900</div>`
          : ""}
      </div>
    </div>
  `;

  const labels = Array.from({ length: columns }).map(() => singleLabel).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Prueba de etiqueta</title>
<style>
  @page { size: ${pageSize}; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #fff; color: #000; font-family: "Arial", "Helvetica", sans-serif; }
  body { display: flex; gap: ${gapMm}mm; padding: 1mm; }
  .label {
    width: ${widthMm}mm;
    height: ${heightMm}mm;
    border: 1px dashed #999;
    padding: 1mm;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
  }
  .name { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .barcode { display: flex; align-items: flex-end; }
  .barcode span { display: block; }
  .row { display: flex; justify-content: space-between; align-items: flex-end; }
  .code { font-size: 7pt; letter-spacing: 0.5px; }
  .price { white-space: nowrap; }
</style></head>
<body>${labels}</body></html>`;
}
