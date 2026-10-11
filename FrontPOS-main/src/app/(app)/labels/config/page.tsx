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
  Usb,
  Wifi,
  Zap,
} from "lucide-react";

import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useApi } from "@/hooks/use-api";
import { apiFetch, ApiError } from "@/lib/api-error";
import { isAdminUser } from "@/lib/auth-helpers.mjs";
import {
  ACTIVE_MODES,
  BARCODE_ROTATIONS,
  BARCODE_SYMBOLOGIES,
  BOUNDS,
  CUT_MODES,
  DRAWER_EVENTS,
  INTERFACES,
  INTERFACE_PROTOCOLS,
  JAL_838L_CONNECTION_MODES,
  JALTECH_JAL_838L_SPEC,
  LABEL_SIZE_50X30_GAPS,
  LABEL_SIZE_PRESET_DEFAULTS,
  LABEL_SIZE_PRESETS,
  PAPER_PRESETS,
  RECEIPT_DELIVERY_MODES,
  SENSOR_TYPES,
  SPOOLERS,
  TSPL_BUILTIN_FONTS,
  applyJaltechJAL838LPreset,
  applyLabelSizePreset,
  applyReceiptPaperPreset,
  createDefaultPrintingConfig,
  importConfigFromPrinterProfile,
  loadPrintingConfig,
  printingConfigsEqual,
  projectConfigToPrinterProfile,
  sanitizePrintingConfig,
  savePrintingConfig,
  setActiveMode,
  validatePrintingConfig,
} from "@/lib/printing-config.mjs";
import { hasPosBridgePrint, subscribePosBridgeStatus } from "@/lib/pos-bridge";
import {
  MIN_THERMAL_PAGE_HEIGHT_MM,
  buildThermalPageRule,
  resolveThermalPageHeightMm,
} from "@/lib/thermal-page-size.mjs";
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
  ReceiptDeliveryMode,
  ActiveMode,
  BarcodeRotation,
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

function clampStepForInput(raw: string, min: number, max: number, step: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return min;
  const clamped = Math.max(min, Math.min(max, parsed));
  const snapped = Math.round(clamped / step) * step;
  return Number(snapped.toFixed(4));
}


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
      // El tab inicial honra el `activeMode` guardado: si el admin dejó
      // la configuración en modo etiqueta la última vez, abrimos la tab
      // "Etiquetas". En modo recibo abrimos "Recibo". Para activeMode
      // RECEIPT sin preferencia histórica dejamos "Perfil" como default
      // (la mayoría del tiempo lo que se toca primero son los campos
      // físicos de conexión).
      if (stored.activeMode === ACTIVE_MODES.LABEL) {
        setTab("etiquetas");
      } else if (stored.activeMode === ACTIVE_MODES.RECEIPT && stored.source !== "default") {
        setTab("recibo");
      }
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

  /**
   * Selector rápido Factura/Etiqueta.
   *
   * Persiste `activeMode` en la config y hace swap de la tab visible para
   * que el admin aterrice en la sección relevante. No modifica otras ramas
   * de la config: es un hint de UI + bridge.
   */
  const handleActiveModeChange = useCallback((mode: ActiveMode) => {
    setConfig((prev) => setActiveMode(prev, mode));
    if (mode === ACTIVE_MODES.RECEIPT) {
      setTab("recibo");
    } else {
      setTab("etiquetas");
    }
  }, []);

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
              <CardHeader className="pb-0 flex-col items-stretch gap-3">
                {/*
                  Selector rápido Factura/Etiqueta — pattern ToggleGroup
                  construido con botones nativos (no añade dependencias).
                  Cumple contrato de accesibilidad: `role="radiogroup"` +
                  `role="radio"` + `aria-checked` por botón, con un label
                  descriptivo para lectores de pantalla.
                */}
                <ActiveModeToggle
                  value={config.activeMode}
                  onChange={handleActiveModeChange}
                />
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

  // Detectamos si el perfil activo coincide con la especificación Jaltech
  // JAL-838L para marcar visualmente qué preset está aplicado. La
  // comparación es laxa (ancho físico + columnas + corte) porque el admin
  // puede haber ajustado alias/host sin dejar de usar la impresora.
  const matchesJaltechSpec = config.receipt.paper === PAPER_PRESETS.JAL_838L
    && config.receipt.widthMm === JALTECH_JAL_838L_SPEC.physicalWidthMm;
  const activeJaltechMode: "NETWORK" | "SYSTEM" | null = matchesJaltechSpec
    ? (iface === INTERFACES.NETWORK
        ? JAL_838L_CONNECTION_MODES.NETWORK
        : iface === INTERFACES.SYSTEM
          ? JAL_838L_CONNECTION_MODES.SYSTEM
          : null)
    : null;

  return (
    <div className="space-y-5">
      <Section title="Preset físico" icon={<Zap size={14} />}>
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/20 p-3 space-y-3">
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 rounded-2xl bg-emerald-500 flex items-center justify-center shrink-0">
              <Printer size={16} className="text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-widest font-bold text-emerald-700 dark:text-emerald-300">
                Jaltech JAL-838L
              </p>
              <p className="text-[11px] text-zinc-700 dark:text-zinc-300 leading-snug">
                Papel 82 mm · imprimible 76 mm · 48 columnas · corte MANUAL.
                Elige la conexión; conservamos el host o nombre de impresora que ya hayas configurado.
              </p>
              <ul className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400 list-disc pl-4">
                <li>
                  Pendientes de configurar manualmente:
                  <span className="font-mono"> host IP</span> (Ethernet) o
                  <span className="font-mono"> nombre de impresora</span> (USB/Windows).
                </li>
                <li>El puerto 9100 (ESC/POS raw) y el spooler Windows se fijan automáticamente.</li>
              </ul>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              color={activeJaltechMode === JAL_838L_CONNECTION_MODES.NETWORK ? "success" : "default"}
              variant={activeJaltechMode === JAL_838L_CONNECTION_MODES.NETWORK ? "solid" : "flat"}
              startContent={<Wifi size={14} />}
              onPress={() => update((d) => Object.assign(d, applyJaltechJAL838LPreset(d, {
                mode: JAL_838L_CONNECTION_MODES.NETWORK,
              })))}
              className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
              aria-label="Aplicar preset Jaltech JAL-838L por Ethernet"
              data-testid="labels-config-preset-jal838l-ethernet"
              aria-pressed={activeJaltechMode === JAL_838L_CONNECTION_MODES.NETWORK}
            >
              Jaltech · Ethernet (puerto 9100)
            </Button>
            <Button
              size="sm"
              color={activeJaltechMode === JAL_838L_CONNECTION_MODES.SYSTEM ? "success" : "default"}
              variant={activeJaltechMode === JAL_838L_CONNECTION_MODES.SYSTEM ? "solid" : "flat"}
              startContent={<Usb size={14} />}
              onPress={() => update((d) => Object.assign(d, applyJaltechJAL838LPreset(d, {
                mode: JAL_838L_CONNECTION_MODES.SYSTEM,
              })))}
              className="rounded-2xl text-[10px] uppercase tracking-widest font-bold"
              aria-label="Aplicar preset Jaltech JAL-838L por USB / cola de Windows"
              data-testid="labels-config-preset-jal838l-windows"
              aria-pressed={activeJaltechMode === JAL_838L_CONNECTION_MODES.SYSTEM}
            >
              Jaltech · USB / Windows
            </Button>
          </div>
          {matchesJaltechSpec && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-xl bg-white dark:bg-zinc-900 border border-emerald-500/20 p-2">
                <p className="text-[9px] uppercase tracking-widest font-bold text-emerald-700 dark:text-emerald-300">
                  Configurado
                </p>
                <ul className="mt-1 space-y-0.5 text-zinc-700 dark:text-zinc-300">
                  <li>Alias: <span className="font-mono">{config.connection.alias || "—"}</span></li>
                  <li>Interfaz: <span className="font-mono">{config.connection.interface}</span></li>
                  <li>Protocolo: <span className="font-mono">{config.connection.protocol}</span></li>
                  <li>Corte: <span className="font-mono">{config.receipt.cut}</span></li>
                </ul>
              </div>
              <div className="rounded-xl bg-white dark:bg-zinc-900 border border-amber-500/30 p-2">
                <p className="text-[9px] uppercase tracking-widest font-bold text-amber-700 dark:text-amber-300">
                  Datos pendientes de configurar
                </p>
                <ul className="mt-1 space-y-0.5 text-zinc-700 dark:text-zinc-300">
                  {iface === INTERFACES.NETWORK && (
                    <li>
                      Host / IP:{" "}
                      <span className="font-mono">
                        {config.connection.network.host || "sin configurar"}
                      </span>
                    </li>
                  )}
                  {iface === INTERFACES.SYSTEM && (
                    <li>
                      Nombre de impresora:{" "}
                      <span className="font-mono">
                        {config.connection.system.printerName || "sin configurar"}
                      </span>
                    </li>
                  )}
                  <li>
                    Puerto fijo:{" "}
                    <span className="font-mono">
                      {iface === INTERFACES.NETWORK
                        ? config.connection.network.port
                        : "n/a"}
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </Section>

      <Divider className="opacity-50" />

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
        <div className="rounded-2xl border border-zinc-200 dark:border-white/5 bg-zinc-50 dark:bg-zinc-900/40 p-3 flex flex-col gap-2">
          <Switch
            isSelected={config.drawer.openDrawerOnSale}
            onValueChange={(v) => update((d) => { d.drawer.openDrawerOnSale = v; })}
            size="sm"
            isDisabled={!config.drawer.enabled}
            aria-label="Abrir cajón automáticamente al completar venta"
            data-testid="labels-config-drawer-open-on-sale"
          >
            <span className="text-[11px] uppercase tracking-widest">
              Abrir cajón automáticamente al completar venta
            </span>
          </Switch>
          <p className="text-[10px] leading-snug text-zinc-500">
            Aplica al completar una venta, haya o no autoimpresión. Antes / después
            define el orden respecto a la tirilla; Manual nunca abre automáticamente.
            Reimpresiones y cambios del toggle no lo disparan. Sólo el bridge local
            puede enviar el pulso físico.
          </p>
        </div>
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
  // El preset JAL_838L fija su ancho imprimible por especificación pero
  // dejamos editable el valor por si una unidad concreta tuvo variación de
  // fábrica; para 80/58 el ancho imprimible queda bloqueado en el físico
  // (compat con la salida existente).
  const printableEditable = paper === PAPER_PRESETS.CUSTOM
    || paper === PAPER_PRESETS.JAL_838L;

  // Sondeo reactivo del bridge: nos suscribimos al estado si el cliente
  // local lo expone (ej. el WS instalado por providers.tsx). Si no hay
  // suscripción disponible, caemos a un ping estático al montar.
  const [bridgeDetected, setBridgeDetected] = useState(false);
  useEffect(() => {
    setBridgeDetected(hasPosBridgePrint());
    const unsubscribe = subscribePosBridgeStatus((status) => {
      // Honramos el status reportado por el bridge WS: si está desconectado,
      // el chip pasa a rojo aunque `window.posBridge.print` siga existiendo.
      // Para bridges nativos sin `isConnected`, el status trae
      // `connected = hasPosBridgePrint()` como fallback (ver pos-bridge.ts).
      setBridgeDetected(!!status.connected && hasPosBridgePrint());
    });
    return () => unsubscribe();
  }, [config.receipt.deliveryMode]);

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
            <SelectItem key={PAPER_PRESETS.JAL_838L}>Jaltech JAL-838L (82 mm físico / 76 mm imprimible)</SelectItem>
            <SelectItem key={PAPER_PRESETS.CUSTOM}>Personalizado</SelectItem>
          </Select>
          <Input
            type="number"
            label={`Ancho físico (mm) ${BOUNDS.receiptWidthMm.min}..${BOUNDS.receiptWidthMm.max}`}
            value={numberOrEmpty(config.receipt.widthMm)}
            onValueChange={(v) => update((d) => {
              d.receipt.widthMm = clampForInput(v, BOUNDS.receiptWidthMm.min, BOUNDS.receiptWidthMm.max);
              d.receipt.paper = PAPER_PRESETS.CUSTOM;
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            isDisabled={!isCustom}
            aria-label="Ancho físico del rollo en milímetros"
          />
          <Input
            type="number"
            label={`Ancho imprimible (mm) ${BOUNDS.printableWidthMm.min}..${config.receipt.widthMm}`}
            value={numberOrEmpty(config.receipt.printableWidthMm)}
            onValueChange={(v) => update((d) => {
              // El ancho imprimible siempre se clampa contra el físico
              // (`sanitize` repite la validación como última línea de defensa).
              d.receipt.printableWidthMm = clampForInput(
                v,
                BOUNDS.printableWidthMm.min,
                d.receipt.widthMm,
              );
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            isDisabled={!printableEditable}
            description={printableEditable
              ? "Área real que toca el cabezal térmico. Nunca excede al ancho físico."
              : "Para 58/80 mm coincide con el ancho físico. Elige 'Jaltech JAL-838L' o 'Personalizado' para editarlo."}
            aria-label="Ancho imprimible real en milímetros"
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

      <Section title="Entrega del recibo" icon={<Printer size={14} />}>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
          <Select
            label="Modo de impresión"
            selectedKeys={new Set([config.receipt.deliveryMode])}
            onSelectionChange={(keys) => {
              const next = Array.from(keys as Set<string>)[0] as ReceiptDeliveryMode | undefined;
              if (!next) return;
              update((d) => { d.receipt.deliveryMode = next; });
            }}
            classNames={{ trigger: "rounded-2xl" }}
            aria-label="Modo de impresión del recibo"
            description="Bridge: envía directo al bridge local SIN diálogo del navegador. Navegador / PDF: abre el diálogo del navegador."
          >
            <SelectItem key={RECEIPT_DELIVERY_MODES.BRIDGE}>Bridge local (directo, sin diálogo)</SelectItem>
            <SelectItem key={RECEIPT_DELIVERY_MODES.BROWSER}>Navegador / PDF (diálogo)</SelectItem>
          </Select>
          <Chip
            size="sm"
            variant="flat"
            color={bridgeDetected ? "success" : "warning"}
            className="rounded-2xl"
            aria-live="polite"
          >
            {bridgeDetected ? "✓ bridge detectado" : "✗ sin bridge — usará diálogo"}
          </Chip>
        </div>
        {config.receipt.deliveryMode === RECEIPT_DELIVERY_MODES.BRIDGE && !bridgeDetected && (
          <p className="text-[11px] mt-2 text-amber-600 dark:text-amber-400 leading-snug">
            Elegiste "Bridge local" pero este navegador NO expone <code className="font-mono">window.posBridge.print</code>.
            Las impresiones automáticas <strong>no</strong> abrirán el diálogo silenciosamente: el POS mostrará un aviso
            accionable para que el cajero elija "Navegador / PDF" manualmente.
          </p>
        )}
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
  // Para los presets 2col (hoy sólo `30x20-2col`) el gap vertical actúa
  // también como "sensor gap" y se bloquea al valor canónico. En CUSTOM se
  // deja editable.
  const isTwoColumnPreset = config.labels.sizePreset === LABEL_SIZE_PRESETS["30X20_2COL"];
  // El gap horizontal es editable sólo en 50x30 (2|3) y en CUSTOM. Los
  // demás presets lo fijan por diseño físico del troquel.
  const horizontalGapEditable = isCustomSize
    || config.labels.sizePreset === LABEL_SIZE_PRESETS["50X30"];
  // Columnas: sólo CUSTOM admite cambio libre.
  const columnsEditable = isCustomSize;

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
            data-testid="labels-config-label-size-select"
          >
            <SelectItem key={LABEL_SIZE_PRESETS["50X30"]}>50 × 30 mm (1 col)</SelectItem>
            <SelectItem key={LABEL_SIZE_PRESETS["40X30"]}>40 × 30 mm (1 col)</SelectItem>
            <SelectItem key={LABEL_SIZE_PRESETS["30X20"]}>30 × 20 mm (1 col)</SelectItem>
            <SelectItem key={LABEL_SIZE_PRESETS["30X20_2COL"]}>30 × 20 mm (2 col, sensor GAP 2 mm)</SelectItem>
            <SelectItem key={LABEL_SIZE_PRESETS["58X40"]}>58 × 40 mm (1 col)</SelectItem>
            <SelectItem key={LABEL_SIZE_PRESETS["76X50"]}>76 × 50 mm (1 col)</SelectItem>
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
            isDisabled={!columnsEditable}
            description={!columnsEditable ? "Fijo por el preset seleccionado" : undefined}
          >
            <SelectItem key="1">1 columna</SelectItem>
            <SelectItem key="2">2 columnas</SelectItem>
          </Select>
          {/*
            Para 50x30 damos un Select limitado al par (2|3) mm que el
            troquel soporta sin desalinear el precio. Para CUSTOM/otros,
            Input numérico libre dentro de BOUNDS.
          */}
          {config.labels.sizePreset === LABEL_SIZE_PRESETS["50X30"] ? (
            <Select
              label="Separación horizontal (mm)"
              selectedKeys={new Set([String(config.labels.horizontalGapMm)])}
              onSelectionChange={(keys) => {
                const next = Number(Array.from(keys as Set<string>)[0]);
                if (LABEL_SIZE_50X30_GAPS.includes(next as 2 | 3)) {
                  update((d) => { d.labels.horizontalGapMm = next; });
                }
              }}
              classNames={{ trigger: "rounded-2xl" }}
              aria-label="Separación horizontal entre etiquetas"
              data-testid="labels-config-50x30-gap-select"
            >
              {LABEL_SIZE_50X30_GAPS.map((g) => (
                <SelectItem key={String(g)}>{g} mm</SelectItem>
              ))}
            </Select>
          ) : (
            <Input
              type="number"
              label={`Separación horizontal (mm) 0..${BOUNDS.horizontalGapMm.max}`}
              value={numberOrEmpty(config.labels.horizontalGapMm)}
              onValueChange={(v) => update((d) => {
                d.labels.horizontalGapMm = clampForInput(v, BOUNDS.horizontalGapMm.min, BOUNDS.horizontalGapMm.max);
              })}
              classNames={{ inputWrapper: "rounded-2xl" }}
              aria-label="Separación horizontal entre etiquetas"
              isDisabled={!horizontalGapEditable}
              description={!horizontalGapEditable
                ? "Fijo por el preset seleccionado"
                : undefined}
            />
          )}
          <Input
            type="number"
            label={`Separación vertical (mm) 0..${BOUNDS.verticalGapMm.max}`}
            value={numberOrEmpty(config.labels.verticalGapMm)}
            onValueChange={(v) => update((d) => {
              d.labels.verticalGapMm = clampForInput(v, BOUNDS.verticalGapMm.min, BOUNDS.verticalGapMm.max);
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            // Editable sólo en CUSTOM: los presets canónicos fijan el gap
            // vertical (en el troquel 30x20 2col actúa también como "sensor
            // gap" físico).
            isDisabled={!isCustomSize}
            aria-label="Separación vertical entre filas de etiquetas"
            description={isTwoColumnPreset
              ? "Sensor GAP fijo en 2 mm por diseño del troquel 2 columnas"
              : !isCustomSize
                ? "Fijo por el preset seleccionado"
                : undefined}
            data-testid="labels-config-vertical-gap-input"
          />
          <Input
            type="number"
            label={`Margen izquierdo (mm) 0..${BOUNDS.marginLeftMm.max}`}
            value={numberOrEmpty(config.labels.marginLeftMm)}
            onValueChange={(v) => update((d) => {
              d.labels.marginLeftMm = clampForInput(v, BOUNDS.marginLeftMm.min, BOUNDS.marginLeftMm.max);
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            aria-label="Margen izquierdo del área imprimible"
            data-testid="labels-config-margin-left-input"
          />
          <Input
            type="number"
            label={`DPI de la cabeza térmica ${BOUNDS.dpi.min}..${BOUNDS.dpi.max}`}
            value={numberOrEmpty(config.labels.dpi)}
            onValueChange={(v) => update((d) => {
              d.labels.dpi = clampForInput(v, BOUNDS.dpi.min, BOUNDS.dpi.max);
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            aria-label="DPI de la cabeza térmica"
            description="203 cubre la mayoría de impresoras TSPL/ZPL. 300 para modelos premium."
            data-testid="labels-config-dpi-input"
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
            label="Tamaño visual (pt)"
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
          <Input
            type="number"
            label="Nombre X (mm)"
            value={numberOrEmpty(config.labels.layout.name.xMm)}
            onValueChange={(v) => update((d) => {
              d.labels.layout.name.xMm = Math.max(0, Math.min(d.labels.widthMm, Number(v) || 0));
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            aria-label="Posición X del nombre en milímetros"
            data-testid="labels-config-name-x"
          />
          <Input
            type="number"
            label="Nombre Y (mm)"
            value={numberOrEmpty(config.labels.layout.name.yMm)}
            onValueChange={(v) => update((d) => {
              d.labels.layout.name.yMm = Math.max(0, Math.min(d.labels.heightMm, Number(v) || 0));
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            aria-label="Posición Y del nombre en milímetros"
            data-testid="labels-config-name-y"
          />
          <Select
            label="Fuente TSPL (1..8)"
            selectedKeys={new Set([config.labels.layout.name.font || "3"])}
            onSelectionChange={(keys) => {
              const next = String(Array.from(keys as Set<string>)[0] || "");
              if ((TSPL_BUILTIN_FONTS as readonly string[]).includes(next)) {
                update((d) => { d.labels.layout.name.font = next as typeof d.labels.layout.name.font; });
              }
            }}
            classNames={{ trigger: "rounded-2xl" }}
            aria-label="Fuente TSPL del nombre"
            data-testid="labels-config-name-font"
          >
            {TSPL_BUILTIN_FONTS.map((font) => (
              <SelectItem key={font}>Fuente {font}</SelectItem>
            ))}
          </Select>
          <SliderWithInput
            label="Escala nombre"
            min={BOUNDS.layoutFontScale.min}
            max={BOUNDS.layoutFontScale.max}
            step={0.5}
            value={config.labels.layout.name.fontScale}
            onChange={(n) => update((d) => { d.labels.layout.name.fontScale = n; })}
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
            label="Tamaño visual (pt)"
            min={BOUNDS.priceFontPt.min}
            max={BOUNDS.priceFontPt.max}
            value={config.labels.price.fontPt}
            onChange={(n) => update((d) => { d.labels.price.fontPt = n; })}
          />
          <Input
            type="number"
            label="Precio X (mm)"
            value={numberOrEmpty(config.labels.layout.price.xMm)}
            onValueChange={(v) => update((d) => {
              d.labels.layout.price.xMm = Math.max(0, Math.min(d.labels.widthMm, Number(v) || 0));
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            aria-label="Posición X del precio en milímetros"
            data-testid="labels-config-price-x"
          />
          <Input
            type="number"
            label="Precio Y (mm)"
            value={numberOrEmpty(config.labels.layout.price.yMm)}
            onValueChange={(v) => update((d) => {
              d.labels.layout.price.yMm = Math.max(0, Math.min(d.labels.heightMm, Number(v) || 0));
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            aria-label="Posición Y del precio en milímetros"
            data-testid="labels-config-price-y"
          />
          <Select
            label="Fuente TSPL (1..8)"
            selectedKeys={new Set([config.labels.layout.price.font || "4"])}
            onSelectionChange={(keys) => {
              const next = String(Array.from(keys as Set<string>)[0] || "");
              if ((TSPL_BUILTIN_FONTS as readonly string[]).includes(next)) {
                update((d) => { d.labels.layout.price.font = next as typeof d.labels.layout.price.font; });
              }
            }}
            classNames={{ trigger: "rounded-2xl" }}
            aria-label="Fuente TSPL del precio"
            data-testid="labels-config-price-font"
          >
            {TSPL_BUILTIN_FONTS.map((font) => (
              <SelectItem key={font}>Fuente {font}</SelectItem>
            ))}
          </Select>
          <SliderWithInput
            label="Escala precio"
            min={BOUNDS.layoutFontScale.min}
            max={BOUNDS.layoutFontScale.max}
            step={0.5}
            value={config.labels.layout.price.fontScale}
            onChange={(n) => update((d) => { d.labels.layout.price.fontScale = n; })}
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
          <Switch
            isSelected={config.labels.barcode.humanReadable}
            onValueChange={(v) => update((d) => { d.labels.barcode.humanReadable = v; })}
            size="sm"
            aria-label="Imprimir dígitos legibles bajo el barcode"
            data-testid="labels-config-barcode-human-readable"
          >
            <span className="text-[11px] uppercase tracking-widest">Dígitos legibles</span>
          </Switch>
          <Select
            label="Rotación"
            selectedKeys={new Set([String(config.labels.barcode.rotation)])}
            onSelectionChange={(keys) => {
              const next = Number(Array.from(keys as Set<string>)[0]);
              if (BARCODE_ROTATIONS.includes(next as BarcodeRotation)) {
                update((d) => { d.labels.barcode.rotation = next as BarcodeRotation; });
              }
            }}
            classNames={{ trigger: "rounded-2xl" }}
            aria-label="Rotación del código de barras"
            data-testid="labels-config-barcode-rotation-select"
          >
            {BARCODE_ROTATIONS.map((r) => (
              <SelectItem key={String(r)}>{r}°</SelectItem>
            ))}
          </Select>
          <SliderWithInput
            label="Módulo narrow (dots)"
            min={BOUNDS.barcodeModule.min}
            max={BOUNDS.barcodeModule.max}
            value={config.labels.barcode.narrow}
            onChange={(n) => update((d) => { d.labels.barcode.narrow = n; })}
          />
          <SliderWithInput
            label="Módulo wide (dots)"
            min={BOUNDS.barcodeModule.min}
            max={BOUNDS.barcodeModule.max}
            value={config.labels.barcode.wide}
            onChange={(n) => update((d) => { d.labels.barcode.wide = n; })}
          />
          <Input
            type="number"
            label="Barcode X (mm)"
            value={numberOrEmpty(config.labels.layout.barcode.xMm)}
            onValueChange={(v) => update((d) => {
              d.labels.layout.barcode.xMm = Math.max(0, Math.min(d.labels.widthMm, Number(v) || 0));
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            aria-label="Posición X del código de barras en milímetros"
            data-testid="labels-config-barcode-x"
          />
          <Input
            type="number"
            label="Barcode Y (mm)"
            value={numberOrEmpty(config.labels.layout.barcode.yMm)}
            onValueChange={(v) => update((d) => {
              d.labels.layout.barcode.yMm = Math.max(0, Math.min(d.labels.heightMm, Number(v) || 0));
            })}
            classNames={{ inputWrapper: "rounded-2xl" }}
            aria-label="Posición Y del código de barras en milímetros"
            data-testid="labels-config-barcode-y"
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
                      d.labels.widthMm = Math.max(
                        BOUNDS.labelWidthMm.min,
                        Math.min(BOUNDS.labelWidthMm.max, Math.round(t.widthMm)),
                      );
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
  // Margen físico muerto que la cabeza térmica no toca (widthMm -
  // printableWidthMm). Se parte en dos lados visuales para que el admin
  // vea CÓMO queda el ticket dentro del rollo (p.ej. 2mm por lado en 80mm
  // genéricos). Para 58mm con default 48 son 5mm por lado; para JAL-838L
  // 82mm con 76 son 3mm por lado.
  const deadMarginMm = Math.max(
    0,
    config.receipt.widthMm - config.receipt.printableWidthMm,
  );
  const sidePaddingPx = Math.round((deadMarginMm / 2) * 3);
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
          className="bg-white text-black rounded-md shadow-inner relative overflow-hidden"
          style={{ width: `${widthPx}px` }}
          aria-label="Vista previa del recibo"
          role="img"
          data-receipt-preview-width-mm={config.receipt.widthMm}
          data-receipt-preview-printable-mm={config.receipt.printableWidthMm}
        >
          {/* Bandas laterales que representan el margen físico muerto. */}
          {deadMarginMm > 0 && (
            <>
              <div
                aria-hidden="true"
                className="absolute inset-y-0 left-0 bg-[repeating-linear-gradient(45deg,rgba(0,0,0,0.08)_0_2px,transparent_2px_6px)]"
                style={{ width: `${sidePaddingPx}px` }}
              />
              <div
                aria-hidden="true"
                className="absolute inset-y-0 right-0 bg-[repeating-linear-gradient(45deg,rgba(0,0,0,0.08)_0_2px,transparent_2px_6px)]"
                style={{ width: `${sidePaddingPx}px` }}
              />
            </>
          )}
          <div
            className="font-mono text-[10px] leading-snug p-3"
            style={{
              marginLeft: `${sidePaddingPx}px`,
              marginRight: `${sidePaddingPx}px`,
            }}
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
  const verticalGapPx = Math.round(config.labels.verticalGapMm * scale * 0.6);
  const marginLeftPx = Math.round(config.labels.marginLeftMm * scale * 0.6);
  const sensorPx = Math.max(4, Math.round(config.labels.sensor.gapMm * scale * 0.6));
  const twoColumns = config.labels.columns === 2;

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
        <div className="flex flex-col items-center gap-3" data-testid="labels-config-label-preview">
          <div className="flex items-stretch">
            {/* Banda que representa el margen izquierdo físico */}
            {marginLeftPx > 0 && (
              <div
                aria-hidden="true"
                className="bg-[repeating-linear-gradient(45deg,rgba(0,0,0,0.08)_0_2px,transparent_2px_6px)] rounded-l"
                style={{ width: `${marginLeftPx}px` }}
                data-testid="labels-config-label-preview-margin-left"
              />
            )}
            {/* Grid de columnas: horizontal gap + vertical gap (si hay 2 col mostramos dos filas de 2 para dejar ver el gap vertical). */}
            <div
              className="flex flex-col items-center"
              style={{ gap: `${verticalGapPx}px` }}
              data-testid="labels-config-label-preview-grid"
            >
              <div className="flex items-center" style={{ gap: `${gapPx}px` }}>
                {Array.from({ length: config.labels.columns }).map((_, i) => (
                  <SingleLabel
                    key={`row1-${i}`}
                    widthPx={labelW}
                    heightPx={labelH}
                    displayedName={displayedName}
                    config={config}
                    truncated={displayedName.length < sampleName.length}
                  />
                ))}
              </div>
              {/*
                Para presets de 2 columnas pintamos una segunda fila a
                baja opacidad para que el verticalGapMm sea observable.
                No hace falta llenarla con contenido real: es un indicador
                visual del sensor GAP del troquel.
              */}
              {twoColumns && (
                <div
                  className="flex items-center opacity-50"
                  style={{ gap: `${gapPx}px` }}
                  aria-hidden="true"
                >
                  {Array.from({ length: config.labels.columns }).map((_, i) => (
                    <div
                      key={`row2-${i}`}
                      className="rounded border border-dashed border-zinc-300 bg-zinc-50"
                      style={{ width: `${labelW}px`, height: `${labelH}px` }}
                    />
                  ))}
                </div>
              )}
            </div>
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
          <p className="text-[9px] uppercase tracking-widest text-zinc-500 text-center">
            {config.labels.widthMm} × {config.labels.heightMm} mm (vista a escala)
            {" · "}gap H {config.labels.horizontalGapMm}mm · gap V {config.labels.verticalGapMm}mm · margen L {config.labels.marginLeftMm}mm
          </p>
          <p className="text-[9px] text-zinc-500 text-center" data-testid="labels-config-preview-layout-summary">
            Nombre X{config.labels.layout.name.xMm}/Y{config.labels.layout.name.yMm} · fuente {config.labels.layout.name.font || "3"} · escala {config.labels.layout.name.fontScale}
            {" · "}Precio X{config.labels.layout.price.xMm}/Y{config.labels.layout.price.yMm} · fuente {config.labels.layout.price.font || "4"} · escala {config.labels.layout.price.fontScale}
            {" · "}Barcode X{config.labels.layout.barcode.xMm}/Y{config.labels.layout.barcode.yMm} · HRI {config.labels.barcode.humanReadable ? "sí" : "no"} · rotación {config.labels.barcode.rotation}° · {config.labels.barcode.narrow}/{config.labels.barcode.wide}
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
  const toX = (mm: number) => Math.max(0, Math.min(widthPx, (mm / config.labels.widthMm) * widthPx));
  const toY = (mm: number) => Math.max(0, Math.min(heightPx, (mm / config.labels.heightMm) * heightPx));
  const nameLayout = config.labels.layout.name;
  const priceLayout = config.labels.layout.price;
  const barcodeLayout = config.labels.layout.barcode;
  const barcodeHeight = Math.max(8, Math.min(heightPx, toY(config.labels.barcode.heightMm)));
  const narrow = Math.max(1, config.labels.barcode.narrow);
  const wide = Math.max(narrow, config.labels.barcode.wide);
  const bars = useMemo(
    () => [narrow, wide, narrow, narrow, wide, narrow, wide, narrow, narrow, wide, narrow, wide, narrow],
    [narrow, wide],
  );

  return (
    <div
      className="bg-white text-black rounded border border-zinc-300 shadow-sm relative overflow-hidden"
      style={{ width: `${widthPx}px`, height: `${heightPx}px` }}
      aria-label="Vista previa de etiqueta"
      role="img"
      data-name-position={`${nameLayout.xMm},${nameLayout.yMm}`}
      data-price-position={`${priceLayout.xMm},${priceLayout.yMm}`}
      data-barcode-position={`${barcodeLayout.xMm},${barcodeLayout.yMm}`}
    >
      {config.labels.productName.visible && (
        <div
          className="absolute truncate font-semibold max-w-[95%]"
          style={{
            left: `${toX(nameLayout.xMm)}px`,
            top: `${toY(nameLayout.yMm)}px`,
            fontSize: `${Math.max(6, config.labels.productName.fontPt * nameLayout.fontScale * 0.75)}px`,
            lineHeight: 1,
          }}
          title={`${displayedName} · fuente TSPL ${nameLayout.font || "3"}`}
          data-testid="labels-config-preview-name"
        >
          {displayedName || "SIN NOMBRE"}
          {truncated && <span className="opacity-50">…</span>}
        </div>
      )}

      <div
        className="absolute flex flex-col items-start"
        style={{
          left: `${toX(barcodeLayout.xMm)}px`,
          top: `${toY(barcodeLayout.yMm)}px`,
          transform: `rotate(${config.labels.barcode.rotation}deg)`,
          transformOrigin: "top left",
        }}
        data-testid="labels-config-preview-barcode"
      >
        <div className="flex items-end gap-px" style={{ height: `${barcodeHeight}px` }} aria-hidden="true">
          {bars.map((barWidth, idx) => (
            <div
              key={idx}
              style={{
                width: `${barWidth}px`,
                height: "100%",
                background: idx % 2 === 0 ? "#000" : "transparent",
              }}
            />
          ))}
        </div>
        {config.labels.barcode.humanReadable && (
          <span className="text-[6px] leading-none mt-px">7701234567890</span>
        )}
      </div>

      {config.labels.price.visible && (
        <div
          className={`absolute whitespace-nowrap ${config.labels.price.emphasized ? "font-bold" : "font-medium"}`}
          style={{
            left: `${toX(priceLayout.xMm)}px`,
            top: `${toY(priceLayout.yMm)}px`,
            fontSize: `${Math.max(7, config.labels.price.fontPt * priceLayout.fontScale * 0.65)}px`,
            lineHeight: 1,
          }}
          title={`Fuente TSPL ${priceLayout.font || "4"}`}
          data-testid="labels-config-preview-price"
        >
          $12.900
        </div>
      )}

      <div className="absolute top-1 right-1 text-[6px] uppercase tracking-wider text-zinc-400">
        {config.labels.barcode.symbology}
      </div>
      <div className="flex flex-wrap gap-1 absolute bottom-1 left-1 text-[6px] text-zinc-500 uppercase tracking-wider">
        {config.labels.extras.showDate && <span>· fecha</span>}
        {config.labels.extras.showInternalCode && <span>· cód</span>}
        {config.labels.extras.showCategory && <span>· cat</span>}
      </div>
    </div>
  );
}

// =============================================================================
// ActiveModeToggle — Factura / Etiqueta (pattern ToggleGroup accesible)
// =============================================================================
//
// Selector rápido que persiste `activeMode` en la config y navega a la
// tab relevante. Se implementa con botones nativos y atributos ARIA de
// radiogroup para no introducir una dependencia nueva (shadcn ToggleGroup
// requiere @radix-ui/react-toggle-group, que no está en el proyecto).
//
// Accesibilidad:
//   - `role="radiogroup"` en el contenedor + `aria-label`.
//   - `role="radio"` + `aria-checked` en cada botón.
//   - Keyboard: Space/Enter activan el botón enfocado (comportamiento
//     nativo del button); el usuario tabula entre ellos.

function ActiveModeToggle({ value, onChange }: {
  value: ActiveMode;
  onChange: (mode: ActiveMode) => void;
}) {
  const options: Array<{ key: ActiveMode; label: string; icon: ReactNode; description: string }> = [
    {
      key: "RECEIPT",
      label: "Factura",
      icon: <FilePenLine size={14} />,
      description: "Modo caja: imprime tirillas de venta.",
    },
    {
      key: "LABEL",
      label: "Etiqueta",
      icon: <Tag size={14} />,
      description: "Modo etiquetado: imprime etiquetas por rollo.",
    },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Modo activo del equipo: Factura o Etiqueta"
      className="flex flex-col gap-1"
      data-testid="labels-config-active-mode-toggle"
    >
      <p className="text-[9px] uppercase tracking-widest text-zinc-500">
        Modo activo del equipo
      </p>
      <div className="inline-flex rounded-2xl bg-gray-100 dark:bg-zinc-950/50 p-1 gap-1 w-full sm:w-auto self-start">
        {options.map((opt) => {
          const selected = value === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={opt.description}
              data-testid={`labels-config-active-mode-${opt.key.toLowerCase()}`}
              onClick={() => onChange(opt.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[11px] uppercase tracking-widest font-bold transition-all duration-300 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                selected
                  ? "bg-white dark:bg-zinc-800 text-emerald-700 dark:text-emerald-300 shadow-sm border border-zinc-200 dark:border-white/5"
                  : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              {opt.icon}
              <span>{opt.label}</span>
            </button>
          );
        })}
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

function SliderWithInput({ label, min, max, step = 1, value, onChange }: {
  label: string;
  min: number;
  max: number;
  step?: number;
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
          step={step}
          value={safe}
          onChange={(v) => onChange(typeof v === "number" ? v : v[0])}
          className="flex-1"
        />
        <Input
          type="number"
          value={String(safe)}
          onValueChange={(v) => onChange(clampStepForInput(v, min, max, step))}
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

  const pageSize = `${config.labels.widthMm}mm ${config.labels.heightMm}mm`;
  const receiptPageRule = buildThermalPageRule(
    config.receipt.widthMm,
    MIN_THERMAL_PAGE_HEIGHT_MM,
  );

  const html = target === "label"
    ? buildLabelTestHtml(config, pageSize)
    : buildReceiptTestHtml(config, receiptPageRule);

  doc.open();
  doc.write(html);
  doc.close();

  const fire = () => {
    if (target === "receipt") {
      const renderedHeightPx = Math.max(
        doc.body?.scrollHeight ?? 0,
        doc.body?.offsetHeight ?? 0,
        doc.body?.getBoundingClientRect().height ?? 0,
        doc.documentElement?.scrollHeight ?? 0,
      );
      const pageStyle = doc.getElementById("thermal-page-size");
      if (pageStyle) {
        pageStyle.textContent = buildThermalPageRule(
          config.receipt.widthMm,
          resolveThermalPageHeightMm(renderedHeightPx),
        );
        void doc.body.offsetHeight;
      }
    }
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

function buildReceiptTestHtml(config: PrintingConfig, pageRule: string): string {
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
<style id="thermal-page-size">${pageRule}</style>
<style>
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
