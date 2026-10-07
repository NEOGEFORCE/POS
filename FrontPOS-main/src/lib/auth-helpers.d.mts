export function normalizeRole(role: unknown): string;

export interface RoleBearer {
  role?: unknown;
  Role?: unknown;
}

export function roleOfUser(user: RoleBearer | null | undefined): string;

export function isAdminRole(role: string | null | undefined): boolean;
export function isAdminUser(user: RoleBearer | null | undefined): boolean;
export function isSuperAdminUser(user: RoleBearer | null | undefined): boolean;

export function isEmployeeRole(role: string | null | undefined): boolean;

export function listAdminAliases(): string[];
