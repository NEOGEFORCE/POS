export function sanitizeNextParam(raw: string | null | undefined): string | null;
export function defaultRoleTarget(role?: string | null): "/dashboard" | "/sales/new";
export function resolvePostLoginTarget(role: string | null | undefined, nextRaw: string | null | undefined): string;
