export const getApiUrl = (): string => {
  if (process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined') {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  if (typeof window !== 'undefined' && window.location) {
    if (window.location.port === '9002') {
      return `http://${window.location.hostname}:3000/api`;
    }
  }
  return '/api';
};

export const API_URL = getApiUrl();
