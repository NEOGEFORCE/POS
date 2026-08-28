import useSWR, { type SWRConfiguration } from "swr";

import { extractApiError } from "@/lib/api-error";
import { API_URL } from "@/lib/constants";
import { requestSessionRecovery } from "@/lib/session-recovery";
import { getSessionToken } from "@/lib/session";

type HttpError = Error & { status: number };

function statusError(message: string, status: number): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}

const fetcher = async (url: string): Promise<any> => {
  const execute = async (token: string | null, allowRecovery: boolean): Promise<any> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${API_URL}${url}`, { headers, cache: "no-store" });

    if (response.status === 401) {
      if (!allowRecovery || typeof window === "undefined") {
        throw statusError("Sesión expirada", 401);
      }
      try {
        const renewedToken = await requestSessionRecovery();
        return execute(renewedToken, false);
      } catch {
        throw statusError("Sesión cerrada por el usuario", 401);
      }
    }

    if (!response.ok) {
      throw statusError(await extractApiError(response, "Error al cargar datos"), response.status);
    }
    return response.json();
  };

  return execute(getSessionToken(), true);
};

export function useApi<T = unknown>(endpoint: string | null, options?: SWRConfiguration) {
  const { data, error, isLoading, isValidating, mutate } = useSWR<T>(endpoint, fetcher, {
    revalidateOnFocus: true,
    revalidateOnMount: true,
    revalidateOnReconnect: true,
    keepPreviousData: true,
    // En celular, cada vez que se vuelve a la app se revalidaba TODO (catálogo
    // completo incluido). Se limita a una vez por minuto y se deduplican las
    // peticiones repetidas; los cambios reales llegan por SSE.
    focusThrottleInterval: 60000,
    dedupingInterval: 5000,
    ...options,
  });
  return { data, error, isLoading, isValidating, mutate };
}

export function useApiWithPagination<T = unknown>(
  endpoint: string | null,
  page = 1,
  pageSize = 50,
  options?: SWRConfiguration,
) {
  const separator = endpoint?.includes("?") ? "&" : "?";
  const key = endpoint ? `${endpoint}${separator}page=${page}&pageSize=${pageSize}` : null;
  const { data, error, isLoading, isValidating, mutate } = useSWR<T>(key, fetcher, {
    revalidateOnFocus: true,
    revalidateOnMount: true,
    revalidateOnReconnect: true,
    keepPreviousData: true,
    focusThrottleInterval: 60000,
    dedupingInterval: 5000,
    ...options,
  });
  return { data, error, isLoading, isValidating, mutate };
}

export { fetcher };
