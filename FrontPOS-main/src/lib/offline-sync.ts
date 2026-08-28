"use client";

import { API_URL } from "@/lib/constants";
import {
  getSyncQueue,
  moveToDeadLetter,
  removeFromSyncQueue,
  type SyncQueueItem,
  updateSyncQueueItem,
} from "@/lib/offline-db";
import { classifySyncStatus, computeSyncRetryDelay } from "@/lib/resilience-policy.mjs";
import { requestSessionRecovery } from "@/lib/session-recovery";
import { getSessionToken } from "@/lib/session";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 6;

export type OfflineSyncResult = {
  attempted: number;
  succeeded: number;
  remaining: number;
  deadLettered: number;
};

let activeSync: Promise<OfflineSyncResult> | null = null;

async function submitSale(item: SyncQueueItem, token: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${API_URL}/sales/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(item.payload),
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function deferOrDeadLetter(
  item: SyncQueueItem,
  reason: string,
  status?: number,
): Promise<boolean> {
  const attempts = (item.attempts ?? 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await moveToDeadLetter({ ...item, attempts, lastError: reason }, reason, status);
    return true;
  }
  await updateSyncQueueItem({
    ...item,
    attempts,
    lastError: reason,
    nextAttemptAt: Date.now() + computeSyncRetryDelay(attempts - 1),
  });
  return false;
}

async function drainQueue(): Promise<OfflineSyncResult> {
  const initialQueue = await getSyncQueue();
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { attempted: 0, succeeded: 0, remaining: initialQueue.length, deadLettered: 0 };
  }

  let token = getSessionToken();
  if (!token || initialQueue.length === 0) {
    return { attempted: 0, succeeded: 0, remaining: initialQueue.length, deadLettered: 0 };
  }

  let attempted = 0;
  let succeeded = 0;
  let deadLettered = 0;

  for (const item of initialQueue) {
    if (item.type !== "SALE" || (item.nextAttemptAt ?? 0) > Date.now()) continue;
    attempted++;

    try {
      let response = await submitSale(item, token);
      if (response.status === 401) {
        try {
          token = await requestSessionRecovery();
          response = await submitSale(item, token);
        } catch {
          await updateSyncQueueItem({
            ...item,
            lastError: "Sesión no recuperada",
            nextAttemptAt: Date.now() + computeSyncRetryDelay(item.attempts ?? 0),
          });
          break;
        }
      }

      const outcome = classifySyncStatus(response.status);
      if (outcome === "success") {
        await removeFromSyncQueue(item.id);
        succeeded++;
        continue;
      }

      const reason = (await response.text().catch(() => "")).slice(0, 500) || `HTTP ${response.status}`;
      if (outcome === "dead-letter") {
        await moveToDeadLetter(item, reason, response.status);
        deadLettered++;
        continue;
      }

      if (outcome === "session-recovery") {
        await updateSyncQueueItem({ ...item, lastError: reason });
        break;
      }

      if (await deferOrDeadLetter(item, reason, response.status)) deadLettered++;
    } catch (error) {
      const reason = error instanceof DOMException && error.name === "AbortError"
        ? "Tiempo de espera agotado (15 s)"
        : error instanceof Error ? error.message : "Error de red";
      if (await deferOrDeadLetter(item, reason)) deadLettered++;
    }
  }

  const remaining = (await getSyncQueue()).length;
  return { attempted, succeeded, remaining, deadLettered };
}

/** Deduplica sincronización en esta pestaña y, con Web Locks, entre pestañas. */
export function syncOfflineSalesQueue(): Promise<OfflineSyncResult> {
  if (activeSync) return activeSync;
  const run = async () => {
    if (typeof navigator !== "undefined" && "locks" in navigator) {
      return navigator.locks.request("pos-offline-sales-sync", drainQueue);
    }
    return drainQueue();
  };
  activeSync = run().finally(() => { activeSync = null; });
  return activeSync;
}
