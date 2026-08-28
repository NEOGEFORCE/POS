"use client";

import Cookies from "js-cookie";

import type { User } from "@/lib/definitions";

const TOKEN_COOKIE = "org-pos-token";
const USER_COOKIE = "org-pos-user";
const AUTH_CHANNEL = "pos-auth";
const AUTH_SIGNAL_KEY = "pos-auth-signal";
const LEGACY_SESSION_KEYS = [TOKEN_COOKIE, USER_COOKIE, "accessToken", "last-sale"] as const;

export type SessionState = { token: string; user: User };
export type AuthMessage = {
  type: "logout" | "session-updated";
  reason?: string;
  timestamp: number;
  nonce: string;
};

function browserAvailable(): boolean {
  return typeof window !== "undefined";
}

export function getSessionCookieOptions(expires = 0.5) {
  const secure = browserAvailable() && window.location.protocol === "https:";
  return {
    expires,
    secure,
    sameSite: "lax" as const,
    path: "/",
  };
}

export function getSessionToken(): string | null {
  if (!browserAvailable()) return null;
  return Cookies.get(TOKEN_COOKIE) ?? null;
}

export function readSession(): SessionState | null {
  if (!browserAvailable()) return null;
  const token = Cookies.get(TOKEN_COOKIE);
  const serializedUser = Cookies.get(USER_COOKIE);
  if (!token || !serializedUser) return null;
  try {
    const user = JSON.parse(serializedUser) as User;
    if (!user || typeof user !== "object") return null;
    return { token, user: { ...user, token } };
  } catch {
    return null;
  }
}

export function writeSession(token: string, user: User, options: { broadcast?: boolean; expires?: number } = {}): void {
  if (!browserAvailable()) return;
  const normalizedToken = String(token ?? "").trim();
  if (!normalizedToken || !user) throw new Error("Sesión inválida");
  const cookieOptions = getSessionCookieOptions(options.expires ?? 0.5);
  Cookies.set(USER_COOKIE, JSON.stringify(user), cookieOptions);
  Cookies.set(TOKEN_COOKIE, normalizedToken, cookieOptions);
  localStorage.removeItem(TOKEN_COOKIE);
  localStorage.removeItem(USER_COOKIE);
  localStorage.removeItem("accessToken");
  if (options.broadcast !== false) publishAuthMessage("session-updated", "reauthenticated");
}

export function migrateLegacySession(): SessionState | null {
  if (!browserAvailable()) return null;
  const current = readSession();
  if (current) {
    for (const key of LEGACY_SESSION_KEYS) localStorage.removeItem(key);
    return current;
  }

  const legacyToken = localStorage.getItem(TOKEN_COOKIE);
  const legacyUser = localStorage.getItem(USER_COOKIE);
  if (!legacyToken || !legacyUser) return null;
  try {
    const user = JSON.parse(legacyUser) as User;
    writeSession(legacyToken, user, { broadcast: false, expires: 0.5 });
    const migrated = readSession();
    if (!migrated) return null;
    for (const key of LEGACY_SESSION_KEYS) localStorage.removeItem(key);
    return migrated;
  } catch {
    return null;
  }
}

export function clearSession(reason = "logout", options: { broadcast?: boolean } = {}): void {
  if (!browserAvailable()) return;
  const cookieOptions = getSessionCookieOptions();
  Cookies.remove(TOKEN_COOKIE, cookieOptions);
  Cookies.remove(USER_COOKIE, cookieOptions);
  for (const key of LEGACY_SESSION_KEYS) localStorage.removeItem(key);
  if (options.broadcast !== false) publishAuthMessage("logout", reason);
}

export function publishAuthMessage(type: AuthMessage["type"], reason?: string): void {
  if (!browserAvailable()) return;
  const message: AuthMessage = {
    type,
    reason,
    timestamp: Date.now(),
    nonce: typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };

  window.dispatchEvent(new CustomEvent<AuthMessage>("pos-auth-message", { detail: message }));
  localStorage.setItem(AUTH_SIGNAL_KEY, JSON.stringify(message));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(AUTH_CHANNEL);
    channel.postMessage(message);
    channel.close();
  }
}

export function subscribeAuthMessages(listener: (message: AuthMessage) => void): () => void {
  if (!browserAvailable()) return () => undefined;
  const seen = new Set<string>();
  const deliver = (message: AuthMessage | null | undefined) => {
    if (!message || !message.nonce || seen.has(message.nonce)) return;
    seen.add(message.nonce);
    if (seen.size > 100) seen.clear();
    listener(message);
  };
  const localHandler = (event: Event) => deliver((event as CustomEvent<AuthMessage>).detail);
  const storageHandler = (event: StorageEvent) => {
    if (event.key !== AUTH_SIGNAL_KEY || !event.newValue) return;
    try {
      deliver(JSON.parse(event.newValue) as AuthMessage);
    } catch {
      // Señal inválida de una versión antigua: ignorar.
    }
  };
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(AUTH_CHANNEL) : null;
  const channelHandler = (event: MessageEvent<AuthMessage>) => deliver(event.data);

  window.addEventListener("pos-auth-message", localHandler);
  window.addEventListener("storage", storageHandler);
  channel?.addEventListener("message", channelHandler);
  return () => {
    window.removeEventListener("pos-auth-message", localHandler);
    window.removeEventListener("storage", storageHandler);
    channel?.removeEventListener("message", channelHandler);
    channel?.close();
  };
}
