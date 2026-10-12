/**
 * Tipos para los helpers del flujo "rename-and-link" del
 * UnmatchedItemsReviewer. Mantener en sincronía con `product-rename.mjs`.
 */

export type RenameFailureReason =
  | 'empty-name'
  | 'identical-name'
  | 'missing-barcode'
  | 'http-error'
  | 'network-error'
  | 'unauthorized';

export const RENAME_FAILURE_MESSAGES: Readonly<Record<RenameFailureReason, string>>;

export function normalizeProposedName(value: unknown): string;

export function shouldPromptRename(params: {
  currentName: unknown;
  invoiceName: unknown;
}): boolean;

export interface ValidateProposedNameOk {
  ok: true;
  name: string;
}
export interface ValidateProposedNameErr {
  ok: false;
  reason: 'empty-name' | 'identical-name';
  message: string;
}
export type ValidateProposedNameResult =
  | ValidateProposedNameOk
  | ValidateProposedNameErr;

export function validateProposedName(
  value: unknown,
  currentName: unknown,
): ValidateProposedNameResult;

export interface BuildRenameUrlOk {
  ok: true;
  url: string;
  barcode: string;
}
export interface BuildRenameUrlErr {
  ok: false;
  reason: 'missing-barcode';
  message: string;
}
export type BuildRenameUrlResult = BuildRenameUrlOk | BuildRenameUrlErr;

export function buildRenameUrl(
  apiBase: unknown,
  barcode: unknown,
): BuildRenameUrlResult;

export interface RenameResponseOk {
  ok: true;
  status: number;
}
export interface RenameResponseErr {
  ok: false;
  status: number;
  reason: 'http-error' | 'unauthorized';
  message: string;
}
export type RenameResponseVerdict = RenameResponseOk | RenameResponseErr;

export function classifyRenameResponse(res: {
  ok: boolean;
  status: number;
} | null | undefined): RenameResponseVerdict;

export function extractRenameErrorMessage(err: unknown): string;
