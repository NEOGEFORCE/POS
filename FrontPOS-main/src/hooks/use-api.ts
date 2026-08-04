import useSWR, { SWRConfiguration } from 'swr';
import Cookies from 'js-cookie';
import { extractApiError } from '@/lib/api-error';
import { requestSessionRecovery } from '@/lib/session-recovery';

import { API_URL } from '@/lib/constants';

const fetcher = async (url: string): Promise<any> => {
  const token = Cookies.get('org-pos-token') || (typeof window !== 'undefined' ? localStorage.getItem('org-pos-token') : null);
  const res = await fetch(`${API_URL}${url}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });

  if (res.status === 401) {
    if (typeof window !== 'undefined') {
      Cookies.remove('org-pos-token');
      Cookies.remove('org-pos-user');
      window.location.href = '/login?expired=true';
    }
    const error = new Error('Sesión expirada');
    (error as any).status = 401;
    throw error;
  }

  if (!res.ok) {
    const errorMsg = await extractApiError(res, 'Error al cargar datos');
    const error = new Error(errorMsg);
    (error as any).status = res.status;
    throw error;
  }

  return res.json();
};


export function useApi<T = any>(
  endpoint: string | null,
  options?: SWRConfiguration
) {
  const { data, error, isLoading, isValidating, mutate } = useSWR<T>(
    endpoint,
    fetcher,
    {
      revalidateOnFocus: true,
      revalidateOnMount: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
      ...options,
    }
  );

  return {
    data,
    error,
    isLoading,
    isValidating,
    mutate,
  };
}

export function useApiWithPagination<T = any>(
  endpoint: string | null,
  page: number = 1,
  pageSize: number = 50,
  options?: SWRConfiguration
) {
  const key = endpoint
    ? `${endpoint}?page=${page}&pageSize=${pageSize}`
    : null;

  const { data, error, isLoading, isValidating, mutate } = useSWR<T>(
    key,
    fetcher,
    {
      revalidateOnFocus: true,
      revalidateOnMount: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
      ...options,
    }
  );

  return {
    data,
    error,
    isLoading,
    isValidating,
    mutate,
  };
}

export { fetcher };
