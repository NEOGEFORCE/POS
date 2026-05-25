export const API_URL = (process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined') 
  ? process.env.NEXT_PUBLIC_API_URL 
  : '/api';
