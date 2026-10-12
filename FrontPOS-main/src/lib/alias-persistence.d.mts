/**
 * Tipos para los helpers de persistencia de alias de proveedor. Mantener en
 * sincronía con `alias-persistence.mjs`.
 */

export interface AliasPayload {
  supplierId: number;
  invoiceName: string;
  productBarcode: string;
}

export type AliasBuildReason =
  | 'missing-supplier'
  | 'missing-invoice-name'
  | 'missing-barcode';

export type AliasFailureReason =
  | AliasBuildReason
  | 'http-error'
  | 'network-error'
  | 'unauthorized';

export interface AliasBuildOk {
  ok: true;
  payload: AliasPayload;
}
export interface AliasBuildErr {
  ok: false;
  reason: AliasBuildReason;
}
export type AliasBuildResult = AliasBuildOk | AliasBuildErr;

export function buildAliasPayload(params: {
  supplierId: unknown;
  invoiceName: unknown;
  productBarcode: unknown;
}): AliasBuildResult;

export interface AliasResponseOk {
  ok: true;
  status: number;
}
export interface AliasResponseErr {
  ok: false;
  status: number;
  reason: 'http-error' | 'unauthorized';
  message: string;
}
export type AliasResponseVerdict = AliasResponseOk | AliasResponseErr;

export function classifyAliasResponse(res: {
  ok: boolean;
  status: number;
} | null | undefined): AliasResponseVerdict;

export interface AliasPersistResultOk {
  ok: true;
  status: number;
  payload: AliasPayload;
}
export interface AliasPersistResultErr {
  ok: false;
  status: number;
  reason: AliasFailureReason;
  message: string;
  payload?: AliasPayload;
  error?: unknown;
}
export type AliasPersistResult = AliasPersistResultOk | AliasPersistResultErr;

export const ALIAS_FAILURE_MESSAGES: Readonly<Record<AliasFailureReason, string>>;

export function persistAlias(params: {
  supplierId: unknown;
  invoiceName: unknown;
  productBarcode: unknown;
  token?: string | null;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AliasPersistResult>;
