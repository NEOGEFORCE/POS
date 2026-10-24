"use client";

// =============================================================================
// HomeDrawerModal.tsx
//
// Modal shadcn (Dialog + Input + Button + Alert) que dispara la tecla física
// `Home` en /sales/new para abrir el cajón manualmente, SIN pasar por una
// venta. Hay dos ramas visuales/lógicas excluyentes según el rol:
//
//   • Admin (isAdminUser === true):
//     Flujo directo "audit-first". Un solo botón grande dispara
//     `POST /cash-drawer/open {override:true, source:'home-manual'}` y, SÓLO
//     cuando el backend respondió 200, intenta el pulso físico vía
//     `window.posBridge.kickDrawer`. Si el bridge no existe o rechaza, la
//     autorización YA quedó auditada y mostramos un `Alert` destructivo
//     explicando que el pulso físico falló sin ocultar la seguridad.
//
//   • Empleado (isAdminUser === false):
//     Flujo challenge/response OTP.
//       1. Click "Solicitar OTP" → `POST /cash-drawer/otp/request`.
//          Respuesta 200 trae `challengeId` + `expiresAt` + `attemptsMax`.
//          El OTP viaja por Telegram directamente al chat del admin.
//          El cliente NUNCA recibe el OTP en el response (contrato
//          verificado por tests contractuales — `drawer-otp-ui-contract`).
//       2. UI muestra: "OTP enviado por Telegram", contador descendente
//          `mm:ss`, intentos restantes, input accesible de 6 dígitos.
//       3. Click "Confirmar" → `POST /cash-drawer/otp/confirm` con
//          `{challengeId, otp}`.
//          - 200: la auditoría quedó registrada y el servidor insertó la
//            apertura. Entonces, y SÓLO entonces, intentamos el pulso
//            físico `kickDrawer`. Fallos del bridge se muestran como
//            `Alert` destructivo pero no revierten la auditoría.
//          - 422 (DRAWER_OTP_INVALID): sigue intentos disponibles.
//          - 410 (EXPIRED/EXHAUSTED): invitamos a pedir uno nuevo.
//          - 409/404: código ya quemado, pedir uno nuevo.
//
// Contrato de seguridad que este archivo nunca puede violar:
//
//   1. NUNCA imprime nada. El pulso físico es un canal totalmente
//      independiente de impresión (como ya documenta
//      `drawer-kick-decoupled-contract.test.mjs`).
//   2. NUNCA llama a `kickDrawer` antes de que el backend auditara
//      exitosamente la apertura. Un fallo del backend aborta el flujo
//      físico; un fallo del bridge NO revierte la auditoría.
//   3. NUNCA renderiza el OTP tecleado por consola (`console.log`) ni lo
//      incluye en un error toast. Tratamos el input como material
//      sensible.
//   4. NUNCA confía en que el response de `/otp/request` traiga el OTP;
//      el flujo lo asume ausente y bloquea cualquier intento de leerlo
//      del body (contrato audit-only).
//   5. NUNCA permite doble-submit (botones deshabilitados mientras hay
//      un request in-flight; input bloqueado y buffer limpiado al
//      cerrar).
//
// La integración en /sales/new la hace `page.tsx`: captura `e.key==='Home'`
// aplicando `canCaptureHomeKey(flags)` y abre este modal.
// =============================================================================

import React from "react";
import { AlertTriangle, KeyRound, Loader2, Lock, Send, ShieldCheck, Timer, Unlock } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";

import { apiFetch, ApiError } from "@/lib/api-error";
import { loadPrintingConfig } from "@/lib/printing-config.mjs";
import { isAdminUser } from "@/lib/auth-helpers.mjs";
import type { User } from "@/lib/definitions";
import {
  DRAWER_OTP_LENGTH,
  buildAdminOpenPayload,
  buildDrawerKickPayload,
  buildOtpConfirmPayload,
  buildOtpRequestPayload,
  computeRemainingSeconds,
  describeOtpError,
  isValidOtpFormat,
  sanitizeOtpInput,
  type DrawerOtpErrorDescription,
} from "@/lib/drawer-otp.mjs";

// -----------------------------------------------------------------------------
// Tipos del contrato con el backend. Reflejan EXACTAMENTE las respuestas
// definidas en `cash_drawer_otp_handler.go`. Si el backend cambia nombres,
// el cambio queda localizado en este archivo + el helper puro.
// -----------------------------------------------------------------------------

interface OtpRequestResponse {
  readonly ok: boolean;
  readonly challengeId: string;
  readonly expiresAt: string;
  readonly attemptsMax: number;
  readonly ttlSeconds: number;
  readonly message?: string;
}

interface OtpConfirmResponse {
  readonly ok: boolean;
  readonly drawerOpenId: number;
  readonly openedAt: string;
  readonly challengeId: string;
  readonly driverAvailable: boolean;
  readonly note?: string;
}

interface AdminOpenResponse {
  readonly ok: boolean;
  readonly opened: unknown;
  readonly driverAvailable: boolean;
  readonly note?: string;
}

export interface HomeDrawerModalProps {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly user: User | null;
  /** Callback opcional para devolver foco al escáner oculto al cerrar. */
  readonly onCloseComplete?: () => void;
}

// Estado interno discriminado. Hacerlo discriminado evita renders
// inconsistentes (ej. "idle con challengeId" o "awaiting-otp sin expiry").
type ModalPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "requesting-otp" }
  | {
      readonly kind: "awaiting-otp";
      readonly challengeId: string;
      readonly expiresAt: string;
      readonly attemptsMax: number;
    }
  | { readonly kind: "confirming-otp" }
  | { readonly kind: "opening-admin" }
  | {
      readonly kind: "success";
      readonly bridgeOk: boolean;
      readonly bridgeMessage?: string;
    };

interface BridgeDispatchResult {
  readonly status: "ok" | "bridge-missing" | "bridge-failed";
  readonly message?: string;
}

/**
 * Dispara el pulso físico. NUNCA se llama antes de que el backend haya
 * auditado la apertura. Es un canal lateral e independiente de impresión.
 */
async function dispatchKickDrawer(): Promise<BridgeDispatchResult> {
  if (typeof window === "undefined") {
    return { status: "bridge-missing" };
  }
  const w = window as typeof window & {
    posBridge?: { kickDrawer?: (payload: unknown) => Promise<unknown> };
  };
  if (!w.posBridge || typeof w.posBridge.kickDrawer !== "function") {
    return { status: "bridge-missing" };
  }
  try {
    const cfg = loadPrintingConfig();
    const payload = buildDrawerKickPayload({
      command: cfg.drawer.command,
      event: cfg.drawer.event,
      connection: cfg.connection,
      drawer: cfg.drawer,
    });
    await w.posBridge.kickDrawer(payload);
    return { status: "ok" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "El bridge local rechazó el pulso.";
    return { status: "bridge-failed", message };
  }
}

/**
 * Formatea segundos como `mm:ss` para el contador descendente. Valor
 * negativo o inválido cae a `00:00`.
 */
function formatCountdown(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0
    ? Math.floor(totalSeconds)
    : 0;
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function HomeDrawerModal({
  isOpen,
  onOpenChange,
  user,
  onCloseComplete,
}: HomeDrawerModalProps): JSX.Element {
  const isAdmin = isAdminUser(user);

  const [phase, setPhase] = React.useState<ModalPhase>({ kind: "idle" });
  const [otpInput, setOtpInput] = React.useState<string>("");
  const [attemptsLeft, setAttemptsLeft] = React.useState<number>(0);
  const [errorInfo, setErrorInfo] = React.useState<DrawerOtpErrorDescription | null>(null);
  const [remainingSec, setRemainingSec] = React.useState<number>(0);

  // Guardia anti doble-submit a nivel de ref. El estado React alterna
  // demasiado tarde durante el handler del botón; el ref garantiza que
  // dos clicks rápidos no disparen dos requests.
  const inFlightRef = React.useRef<boolean>(false);

  // Autofocus del input del OTP cuando entramos en awaiting-otp. useRef
  // + useEffect garantiza foco incluso cuando el DOM se recrea.
  const otpInputRef = React.useRef<HTMLInputElement | null>(null);

  // Reset total al cerrar. Preserva la invariante "nunca queda estado
  // caliente colgando" (OTP buffer, challengeId, countdown). Si alguien
  // reabre el modal, parte limpio en idle.
  const resetAll = React.useCallback((): void => {
    setPhase({ kind: "idle" });
    setOtpInput("");
    setAttemptsLeft(0);
    setErrorInfo(null);
    setRemainingSec(0);
    inFlightRef.current = false;
  }, []);

  // Al abrir: reseteamos todo. Al cerrar: reseteamos y devolvemos foco al
  // escáner oculto si el padre nos pasó el callback.
  React.useEffect(() => {
    if (!isOpen) {
      resetAll();
      return;
    }
    resetAll();
  }, [isOpen, resetAll]);

  // Ticker del contador. Sólo corre durante awaiting-otp; recalcula a
  // 1 Hz basándose en `computeRemainingSeconds` (fuente única pura).
  React.useEffect(() => {
    if (phase.kind !== "awaiting-otp") return;
    const tick = (): void => {
      const remaining = computeRemainingSeconds(phase.expiresAt);
      setRemainingSec(remaining);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  // Autofocus del input OTP al entrar en awaiting-otp.
  React.useEffect(() => {
    if (phase.kind === "awaiting-otp") {
      // El Dialog termina de montar su contenido en el próximo tick;
      // esperamos 1 frame para asegurar que el ref está listo.
      const id = window.setTimeout(() => {
        otpInputRef.current?.focus();
        otpInputRef.current?.select();
      }, 20);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [phase.kind]);

  // --------------------------------------------------------------------
  // Admin: audit → kick, sin OTP. Audit-first; el pulso es independiente.
  // --------------------------------------------------------------------
  const handleAdminOpen = React.useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setErrorInfo(null);
    setPhase({ kind: "opening-admin" });
    try {
      await apiFetch<AdminOpenResponse>("/cash-drawer/open", {
        method: "POST",
        body: JSON.stringify(buildAdminOpenPayload({ note: "Apertura manual desde tecla Home" })),
        fallbackError: "No se pudo autorizar la apertura.",
      });
    } catch (err) {
      inFlightRef.current = false;
      const status = err instanceof ApiError ? err.status : 0;
      const message = err instanceof Error ? err.message : "No se pudo autorizar la apertura.";
      setPhase({ kind: "idle" });
      setErrorInfo({
        action: status === 401 ? "close" : "retry",
        message,
        code: null,
      });
      return;
    }
    // Audit OK → pulso físico. Fallo del bridge NO revierte auditoría.
    const bridge = await dispatchKickDrawer();
    inFlightRef.current = false;
    setPhase({
      kind: "success",
      bridgeOk: bridge.status === "ok",
      bridgeMessage:
        bridge.status === "ok"
          ? undefined
          : bridge.status === "bridge-missing"
            ? "El bridge local no está disponible. La autorización quedó registrada; abra el cajón con la llave manual."
            : bridge.message ?? "El bridge rechazó el pulso físico.",
    });
  }, []);

  // --------------------------------------------------------------------
  // Empleado: paso 1, solicitar OTP.
  // --------------------------------------------------------------------
  const handleRequestOtp = React.useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setErrorInfo(null);
    setOtpInput("");
    setPhase({ kind: "requesting-otp" });
    try {
      const resp = await apiFetch<OtpRequestResponse>("/cash-drawer/otp/request", {
        method: "POST",
        body: JSON.stringify(buildOtpRequestPayload({ note: "Apertura manual desde tecla Home" })),
        fallbackError: "No se pudo solicitar el OTP.",
      });
      if (!resp || typeof resp.challengeId !== "string" || typeof resp.expiresAt !== "string") {
        throw new Error("Respuesta inválida del servidor");
      }
      inFlightRef.current = false;
      setAttemptsLeft(Math.max(0, Number(resp.attemptsMax) || 0));
      setPhase({
        kind: "awaiting-otp",
        challengeId: resp.challengeId,
        expiresAt: resp.expiresAt,
        attemptsMax: Math.max(1, Number(resp.attemptsMax) || 1),
      });
    } catch (err) {
      inFlightRef.current = false;
      const status = err instanceof ApiError ? err.status : 0;
      const data = err instanceof ApiError ? err.data : null;
      const code = data && typeof data === "object" && typeof data.code === "string" ? data.code : null;
      const message = err instanceof Error ? err.message : "No se pudo solicitar el OTP.";
      setPhase({ kind: "idle" });
      setErrorInfo(describeOtpError({ code, status, message }));
    }
  }, []);

  // --------------------------------------------------------------------
  // Empleado: paso 2, confirmar OTP.
  // --------------------------------------------------------------------
  const handleConfirmOtp = React.useCallback(async (): Promise<void> => {
    if (phase.kind !== "awaiting-otp") return;
    if (inFlightRef.current) return;
    if (!isValidOtpFormat(otpInput)) {
      setErrorInfo({
        action: "retry",
        message: `El OTP debe ser de ${DRAWER_OTP_LENGTH} dígitos.`,
        code: "DRAWER_OTP_FORMAT_INVALID",
      });
      return;
    }
    inFlightRef.current = true;
    setErrorInfo(null);
    const challengeIdSnapshot = phase.challengeId;
    const attemptsMaxSnapshot = phase.attemptsMax;
    setPhase({ kind: "confirming-otp" });
    let auditOk = false;
    try {
      const payload = buildOtpConfirmPayload({
        challengeId: challengeIdSnapshot,
        otp: otpInput,
        note: "Apertura manual desde tecla Home",
      });
      await apiFetch<OtpConfirmResponse>("/cash-drawer/otp/confirm", {
        method: "POST",
        body: JSON.stringify(payload),
        fallbackError: "No se pudo validar el OTP.",
      });
      auditOk = true;
    } catch (err) {
      inFlightRef.current = false;
      const status = err instanceof ApiError ? err.status : 0;
      const data = err instanceof ApiError ? err.data : null;
      const code = data && typeof data === "object" && typeof data.code === "string" ? data.code : null;
      const message = err instanceof Error ? err.message : "No se pudo validar el OTP.";
      const described = describeOtpError({ code, status, message });
      setErrorInfo(described);
      if (described.action === "new-otp" || described.action === "close") {
        // El challenge quedó inservible: volvemos a idle para forzar un
        // nuevo "Solicitar OTP". NO borramos el input por si el cajero
        // quiere ver qué tecleó.
        setPhase({ kind: "idle" });
        setAttemptsLeft(0);
      } else {
        // Reintentable: volvemos al estado awaiting con el mismo
        // challenge y descontamos un intento visualmente. El backend es
        // la fuente de verdad; esto es sólo guía UX.
        setPhase({
          kind: "awaiting-otp",
          challengeId: challengeIdSnapshot,
          expiresAt: (phase as { expiresAt?: string }).expiresAt ?? "",
          attemptsMax: attemptsMaxSnapshot,
        });
        setAttemptsLeft((prev) => Math.max(0, prev - 1));
        // Vaciamos y re-enfocamos el input para el reintento.
        setOtpInput("");
        window.setTimeout(() => {
          otpInputRef.current?.focus();
          otpInputRef.current?.select();
        }, 20);
      }
      return;
    }
    if (!auditOk) {
      inFlightRef.current = false;
      return;
    }
    // Audit OK → pulso físico. Fallo del bridge NO revierte auditoría.
    const bridge = await dispatchKickDrawer();
    inFlightRef.current = false;
    setPhase({
      kind: "success",
      bridgeOk: bridge.status === "ok",
      bridgeMessage:
        bridge.status === "ok"
          ? undefined
          : bridge.status === "bridge-missing"
            ? "El bridge local no está disponible. La autorización quedó registrada; abra el cajón con la llave manual."
            : bridge.message ?? "El bridge rechazó el pulso físico.",
    });
  }, [otpInput, phase]);

  const handleClose = React.useCallback((): void => {
    if (inFlightRef.current) return; // nunca cerrar mientras hay request vivo
    onOpenChange(false);
    onCloseComplete?.();
  }, [onCloseComplete, onOpenChange]);

  // Enter dentro del input confirma. Las guards del input (6 dígitos)
  // evitan submits malformados y el estado inFlightRef evita doble-tap.
  const handleOtpKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (phase.kind === "awaiting-otp" && isValidOtpFormat(otpInput)) {
          void handleConfirmOtp();
        }
      }
    },
    [handleConfirmOtp, otpInput, phase.kind],
  );

  // ------------------------------------------------------------------
  // Render — ramas excluyentes bajo un Dialog shadcn.
  // ------------------------------------------------------------------
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (inFlightRef.current && !open) return;
        onOpenChange(open);
        if (!open) onCloseComplete?.();
      }}
    >
      <DialogContent
        className="sm:max-w-md bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-white/10"
        aria-describedby="home-drawer-modal-desc"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-bold uppercase tracking-widest">
            <KeyRound className="h-4 w-4 text-emerald-500" aria-hidden="true" />
            Apertura manual
          </DialogTitle>
          <DialogDescription
            id="home-drawer-modal-desc"
            className="text-xs text-zinc-500 dark:text-zinc-400"
          >
            {isAdmin
              ? "Autorización inmediata registrada por auditoría. El pulso físico se envía después."
              : "Pida un código temporal por Telegram y confírmalo aquí. La apertura queda registrada antes del pulso."}
          </DialogDescription>
        </DialogHeader>

        {errorInfo ? (
          <Alert variant="destructive" role="alert">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>No se pudo completar</AlertTitle>
            <AlertDescription>{errorInfo.message}</AlertDescription>
          </Alert>
        ) : null}

        {/* ------------------- RAMA ADMIN ------------------- */}
        {isAdmin ? (
          <AdminBody
            phase={phase}
            onConfirm={handleAdminOpen}
          />
        ) : (
          /* ------------------- RAMA EMPLEADO ------------------- */
          <EmployeeBody
            phase={phase}
            otpInput={otpInput}
            otpInputRef={otpInputRef}
            attemptsLeft={attemptsLeft}
            remainingSec={remainingSec}
            onOtpChange={(raw) => {
              // sanitize garantiza "sólo dígitos y máximo 6".
              setOtpInput(sanitizeOtpInput(raw));
            }}
            onOtpKeyDown={handleOtpKeyDown}
            onRequestOtp={handleRequestOtp}
            onConfirmOtp={handleConfirmOtp}
          />
        )}

        <DialogFooter className="flex flex-row justify-between gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={inFlightRef.current}
          >
            Cancelar
          </Button>
          {phase.kind === "success" ? (
            <Button
              type="button"
              variant="default"
              onClick={handleClose}
              autoFocus
            >
              Cerrar
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Sub-componentes de rama. Separarlos ayuda a:
//  - Aislar el estado por rama (no se cruza).
//  - Que un lector humano vea de un vistazo las condiciones de cada
//    botón (admin: 1 botón; empleado: solicitar → ingresar → confirmar).
// -----------------------------------------------------------------------------

function AdminBody({
  phase,
  onConfirm,
}: {
  phase: ModalPhase;
  onConfirm: () => void | Promise<void>;
}): JSX.Element {
  const busy = phase.kind === "opening-admin";
  const done = phase.kind === "success";
  const bridgeOk = phase.kind === "success" ? phase.bridgeOk : false;
  const bridgeMessage = phase.kind === "success" ? phase.bridgeMessage : undefined;
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      <div className="flex items-center gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100">
        <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        <div className="leading-tight">
          <p className="font-semibold">Autorización como administrador</p>
          <p className="text-xs text-emerald-800/80 dark:text-emerald-200/70">
            Al confirmar, la apertura queda auditada y luego se envía el pulso físico al dispositivo.
          </p>
        </div>
      </div>

      {done ? (
        bridgeOk ? (
          <Alert>
            <Unlock className="h-4 w-4 text-emerald-600" />
            <AlertTitle>Apertura confirmada</AlertTitle>
            <AlertDescription>
              La autorización quedó registrada y el pulso físico se envió correctamente.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Autorizada, pero sin pulso físico</AlertTitle>
            <AlertDescription>{bridgeMessage}</AlertDescription>
          </Alert>
        )
      ) : (
        <Button
          type="button"
          variant="default"
          className="h-11 w-full gap-2 text-sm font-bold uppercase tracking-widest"
          onClick={() => {
            void onConfirm();
          }}
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Autorizando…
            </>
          ) : (
            <>
              <Unlock className="h-4 w-4" aria-hidden="true" />
              Autorizar y abrir
            </>
          )}
        </Button>
      )}
    </div>
  );
}

function EmployeeBody({
  phase,
  otpInput,
  otpInputRef,
  attemptsLeft,
  remainingSec,
  onOtpChange,
  onOtpKeyDown,
  onRequestOtp,
  onConfirmOtp,
}: {
  phase: ModalPhase;
  otpInput: string;
  otpInputRef: React.MutableRefObject<HTMLInputElement | null>;
  attemptsLeft: number;
  remainingSec: number;
  onOtpChange: (raw: string) => void;
  onOtpKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onRequestOtp: () => void | Promise<void>;
  onConfirmOtp: () => void | Promise<void>;
}): JSX.Element {
  const requesting = phase.kind === "requesting-otp";
  const awaiting = phase.kind === "awaiting-otp";
  const confirming = phase.kind === "confirming-otp";
  const done = phase.kind === "success";
  const bridgeOk = phase.kind === "success" ? phase.bridgeOk : false;
  const bridgeMessage = phase.kind === "success" ? phase.bridgeMessage : undefined;
  const expired = awaiting && remainingSec <= 0;
  const canConfirm = awaiting && isValidOtpFormat(otpInput) && !expired;

  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      <div className="flex items-start gap-3 rounded-2xl border border-sky-500/20 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100">
        <Lock className="h-5 w-5 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden="true" />
        <div className="leading-tight">
          <p className="font-semibold">Validación por OTP</p>
          <p className="text-xs text-sky-800/80 dark:text-sky-200/70">
            El código se enviará al chat de administración. No viajará a esta pantalla.
          </p>
        </div>
      </div>

      {!awaiting && !confirming && !done ? (
        <Button
          type="button"
          variant="default"
          className="h-11 w-full gap-2 text-sm font-bold uppercase tracking-widest"
          onClick={() => {
            void onRequestOtp();
          }}
          disabled={requesting}
          aria-busy={requesting}
        >
          {requesting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Enviando por Telegram…
            </>
          ) : (
            <>
              <Send className="h-4 w-4" aria-hidden="true" />
              Solicitar OTP
            </>
          )}
        </Button>
      ) : null}

      {awaiting || confirming ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1">
              <Timer className="h-3 w-3" aria-hidden="true" />
              <span>
                Expira en{" "}
                <span className="font-mono font-semibold tabular-nums" aria-live="polite">
                  {formatCountdown(remainingSec)}
                </span>
              </span>
            </span>
            <span>
              Intentos restantes:{" "}
              <span className="font-semibold tabular-nums">{attemptsLeft}</span>
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="home-drawer-otp-input" className="text-xs font-semibold uppercase tracking-widest">
              Código OTP
            </Label>
            <Input
              id="home-drawer-otp-input"
              ref={otpInputRef}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={DRAWER_OTP_LENGTH}
              placeholder="------"
              value={otpInput}
              disabled={confirming || expired}
              onChange={(event) => onOtpChange(event.target.value)}
              onKeyDown={onOtpKeyDown}
              aria-label="Código OTP de 6 dígitos recibido por Telegram"
              aria-invalid={otpInput.length > 0 && !isValidOtpFormat(otpInput)}
              className="h-12 text-center text-2xl font-bold tracking-[0.5em] tabular-nums"
            />
            {expired ? (
              <p className="text-xs text-rose-500" role="status">
                El código expiró. Solicite uno nuevo.
              </p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => {
                void onRequestOtp();
              }}
              disabled={confirming}
            >
              Reenviar OTP
            </Button>
            <Button
              type="button"
              variant="default"
              className="flex-1 gap-2 font-bold uppercase tracking-widest"
              onClick={() => {
                void onConfirmOtp();
              }}
              disabled={!canConfirm || confirming}
              aria-busy={confirming}
            >
              {confirming ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Validando…
                </>
              ) : (
                <>
                  <Unlock className="h-4 w-4" aria-hidden="true" />
                  Confirmar
                </>
              )}
            </Button>
          </div>
        </div>
      ) : null}

      {done ? (
        bridgeOk ? (
          <Alert>
            <Unlock className="h-4 w-4 text-emerald-600" />
            <AlertTitle>Apertura confirmada</AlertTitle>
            <AlertDescription>
              El código fue validado y el pulso físico se envió correctamente.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Autorizada, pero sin pulso físico</AlertTitle>
            <AlertDescription>{bridgeMessage}</AlertDescription>
          </Alert>
        )
      ) : null}
    </div>
  );
}

export default HomeDrawerModal;
