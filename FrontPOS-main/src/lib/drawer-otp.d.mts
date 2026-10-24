// Declaraciones TS para src/lib/drawer-otp.mjs.
// El módulo real es puro JS para que pueda correrse con `node --test`.

export const DRAWER_OTP_LENGTH: 6;
export const DRAWER_CHALLENGE_ID_MIN: 32;
export const DRAWER_CHALLENGE_ID_MAX: 64;

export type DrawerOtpErrorCode =
  | "DRAWER_OTP_NOT_FOUND"
  | "DRAWER_OTP_WRONG_ACTOR"
  | "DRAWER_OTP_EXPIRED"
  | "DRAWER_OTP_ATTEMPTS_EXHAUSTED"
  | "DRAWER_OTP_INVALID"
  | "DRAWER_OTP_ALREADY_USED"
  | "DRAWER_OTP_CANCELLED"
  | "DRAWER_OTP_TELEGRAM_UNAVAILABLE"
  | "DRAWER_OTP_COOLDOWN"
  | "DRAWER_OTP_REQUEST_FAILED"
  | "DRAWER_OTP_FORMAT_INVALID";

export const DRAWER_OTP_ERROR_CODES: Readonly<{
  NOT_FOUND: "DRAWER_OTP_NOT_FOUND";
  WRONG_ACTOR: "DRAWER_OTP_WRONG_ACTOR";
  EXPIRED: "DRAWER_OTP_EXPIRED";
  ATTEMPTS_EXHAUSTED: "DRAWER_OTP_ATTEMPTS_EXHAUSTED";
  INVALID: "DRAWER_OTP_INVALID";
  ALREADY_USED: "DRAWER_OTP_ALREADY_USED";
  CANCELLED: "DRAWER_OTP_CANCELLED";
  TELEGRAM_UNAVAILABLE: "DRAWER_OTP_TELEGRAM_UNAVAILABLE";
  COOLDOWN: "DRAWER_OTP_COOLDOWN";
  REQUEST_FAILED: "DRAWER_OTP_REQUEST_FAILED";
  FORMAT_INVALID: "DRAWER_OTP_FORMAT_INVALID";
}>;

export function isValidOtpFormat(otp: unknown): boolean;
export function isValidChallengeId(challengeId: unknown): boolean;
export function sanitizeOtpInput(raw: unknown): string;

export function computeRemainingMs(
  expiresAt: string | number | Date | null | undefined,
  now?: number,
): number;

export function computeRemainingSeconds(
  expiresAt: string | number | Date | null | undefined,
  now?: number,
): number;

export function hasRemainingAttempts(used: unknown, max: unknown): boolean;

export interface HomeKeyGuardFlags {
  isInputFocused?: boolean;
  isModalOpen?: boolean;
  hasScannerBuffer?: boolean;
  showSuccessScreen?: boolean;
  isSubmitting?: boolean;
  isHomeRepeat?: boolean;
}
export function canCaptureHomeKey(flags: HomeKeyGuardFlags): boolean;

export interface AdminOpenPayload {
  override: true;
  source: "home-manual";
  note: string;
}
export function buildAdminOpenPayload(options?: { note?: string | null }): AdminOpenPayload;

export interface OtpRequestPayload {
  note: string;
}
export function buildOtpRequestPayload(options?: { note?: string | null }): OtpRequestPayload;

export interface OtpConfirmPayload {
  challengeId: string;
  otp: string;
  note: string;
}
export function buildOtpConfirmPayload(input: {
  challengeId: string;
  otp: string;
  note?: string | null;
}): OtpConfirmPayload;

export interface DrawerKickPayload {
  command: string;
  event: string;
  connection: unknown;
  drawer: unknown;
  source: "home-manual";
  openDrawerOnSale: false;
}
export function buildDrawerKickPayload(cfg: {
  command?: string | null;
  event?: string | null;
  connection?: unknown;
  drawer?: unknown;
}): DrawerKickPayload;

export type DrawerOtpErrorAction = "retry" | "new-otp" | "close" | "ask-admin";

export interface DrawerOtpErrorDescription {
  action: DrawerOtpErrorAction;
  message: string;
  code: string | null;
}

export function describeOtpError(payload: {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}): DrawerOtpErrorDescription;
