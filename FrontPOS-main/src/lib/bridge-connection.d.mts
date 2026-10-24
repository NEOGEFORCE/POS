// =============================================================================
// src/lib/bridge-connection.d.mts
//
// Tipos públicos del módulo compartido para la nueva arquitectura
// "bridge local → relay por servidor". Replica la API documentada en
// `bridge-connection.mjs` para que TypeScript estricto pueda consumirla
// con tipos completos.
// =============================================================================

export const POS_BRIDGE_CAJA_STORAGE_KEY: "pos_bridge_caja_id";
export const LOCAL_BRIDGE_PROBE_TIMEOUT_MS: 1500;

export type RelayErrorCode = "RELAY_AGENT_OFFLINE" | "RELAY_FORBIDDEN" | "RELAY_TIMEOUT";

export const RELAY_ERROR_CODES: Readonly<{
    AGENT_OFFLINE: "RELAY_AGENT_OFFLINE";
    FORBIDDEN: "RELAY_FORBIDDEN";
    TIMEOUT: "RELAY_TIMEOUT";
}>;

export type BridgeConnectionMode = "local" | "relay";

export interface BridgeAgentInfo {
    readonly cajaId: string;
    readonly connected: boolean;
    readonly connectedAt: string | null;
    readonly lastSeenAt: string | null;
}

export interface BridgeEnvLike {
    readonly NEXT_PUBLIC_API_URL?: string;
    readonly NEXT_PUBLIC_POS_BRIDGE_WS_URL?: string;
    readonly NEXT_PUBLIC_SCALE_WS_URL?: string;
    readonly [key: string]: string | undefined;
}

export interface BridgeLocationLike {
    readonly hostname?: string;
    readonly protocol?: string;
    readonly host?: string;
}

export interface BridgeStorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export function resolveLocalBridgeUrl(opts?: {
    env?: BridgeEnvLike;
    location?: BridgeLocationLike;
}): string;

export function httpBaseToWsBase(opts?: {
    apiUrl?: string;
    location?: BridgeLocationLike;
}): string;

export function buildRelayWsUrl(opts: {
    apiUrl?: string;
    location?: BridgeLocationLike;
    ticket: string;
}): string;

export function getRelayEndpoints(opts?: { apiUrl?: string }): {
    agentsPath: string;
    ticketPath: string;
};

export function normalizeAgents(input: unknown): BridgeAgentInfo[];

export function selectCajaId(opts: {
    agents: ReadonlyArray<Pick<BridgeAgentInfo, "cajaId" | "connected"> & Partial<BridgeAgentInfo>>;
    savedCajaId?: string | null;
}): string | null;

export function readSavedCajaId(storage: BridgeStorageLike | null | undefined): string | null;
export function writeSavedCajaId(
    storage: BridgeStorageLike | null | undefined,
    cajaId: string | null | undefined,
): void;

export function describeRelayError(code: string | null | undefined): string;
export function extractRelayErrorCode(message: unknown): RelayErrorCode | null;

export interface BridgeAgentsResponseLike {
    agents?: unknown[];
}

export interface BridgeTicketResponseLike {
    ticket?: string;
    expiresInSeconds?: number;
}

export interface NegotiateBridgeOptions {
    env?: BridgeEnvLike;
    location?: BridgeLocationLike;
    storage?: BridgeStorageLike | null;
    cajaIdOverride?: string | null;
    localProbeTimeoutMs?: number;
    /** Devuelve un socket "abierto" si funcionó, o null si no. */
    probeLocal: (url: string, timeoutMs: number) => Promise<unknown | null>;
    fetchAgents: () => Promise<BridgeAgentsResponseLike>;
    requestTicket: (cajaId: string) => Promise<BridgeTicketResponseLike>;
}

export interface NegotiateBridgeResult {
    readonly url: string;
    readonly mode: BridgeConnectionMode;
    readonly cajaId: string | null;
    readonly socket: unknown | null;
}

export function negotiateBridgeConnection(
    opts: NegotiateBridgeOptions,
): Promise<NegotiateBridgeResult>;
