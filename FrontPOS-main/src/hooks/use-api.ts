import useSWR, { SWRConfiguration } from 'swr';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

const fetcher = async (url: string) => {
  const token = localStorage.getItem('org-pos-token');
  const res = await fetch(`${API_URL}${url}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const error = new Error('Error al cargar datos');
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
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      dedupingInterval: 30000,
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
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      dedupingInterval: 30000,
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
