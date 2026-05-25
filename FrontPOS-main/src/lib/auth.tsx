"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Cookies from 'js-cookie';

import { User } from './definitions';

interface AuthContextType {
  user: User | null;
  login: (credentials: { username: string, password?: string }) => Promise<void>;
  logout: () => void;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Claves sensibles identificadas para purga
const SENSITIVE_KEYS = ['accessToken', 'last-sale', 'org-pos-token', 'org-pos-user'];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const recoverSession = async () => {
      try {
        // 1. Migración de localStorage a Cookies (Transición segura)
        const legacyToken = localStorage.getItem('org-pos-token');
        const legacyUser = localStorage.getItem('org-pos-user');

        let currentToken = Cookies.get('org-pos-token');
        let currentUserStr = Cookies.get('org-pos-user');

        if (legacyToken && !currentToken) {
          Cookies.set('org-pos-token', legacyToken, { expires: 7, secure: true, sameSite: 'strict' });
          currentToken = legacyToken;
        }
        if (legacyUser && !currentUserStr) {
          Cookies.set('org-pos-user', legacyUser, { expires: 7, secure: true, sameSite: 'strict' });
          currentUserStr = legacyUser;
        }

        // Limpieza de localStorage (Post-migración)
        if (legacyToken || legacyUser) {
          localStorage.removeItem('org-pos-token');
          localStorage.removeItem('org-pos-user');
          localStorage.removeItem('accessToken');
          localStorage.removeItem('last-sale');
        }

        // 2. Sincronización de Estado
        if (currentToken && currentUserStr) {
          try {
            const userData = JSON.parse(currentUserStr);
            setUser({ ...userData, token: currentToken });
          } catch (e) {
            console.error("Malformed user data in cookies", e);
          }
        }
      } catch (error) {
        console.error("Critical Auth recovery failure", error);
      } finally {
        // Aseguramos un pequeño respiro para que el estado de React se asiente
        setLoading(false);
      }
    };

    recoverSession();
  }, []);

  const login = async (credentials: { username: string, password?: string }) => {
    const response = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/auth/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(credentials),
    });

    if (!response.ok) {
        const text = await response.text();
        let errorMsg = 'Error de inicio de sesión';
        try {
            const errorData = JSON.parse(text);
            if (errorData.error && typeof errorData.error === 'object') {
              errorMsg = errorData.error.message || errorMsg;
            } else {
              errorMsg = errorData.error || errorMsg;
            }
        } catch (e) {}
        throw new Error(errorMsg);
    }

    const data = await response.json();
    const { token, user: userData } = data;
    
    if (userData && token) {
      // Guardar en Cookies (Seguro y Volátil) en lugar de localStorage
      Cookies.set('org-pos-user', JSON.stringify(userData), { expires: 0.5, secure: true, sameSite: 'strict' });
      Cookies.set('org-pos-token', token, { expires: 0.5, secure: true, sameSite: 'strict' });
      
      setUser({ ...userData, token });
      
      const role = userData.role?.toLowerCase() || userData.Role?.toLowerCase() || "";
      if (role === "admin" || role === "administrador" || role === "superadmin") {
        router.push('/dashboard');
      } else {
        router.push('/sales/new');
      }
    } else {
        throw new Error('Invalid response from server');
    }
  };

  const logout = () => {
    // Limpieza profunda de sesión
    Cookies.remove('org-pos-user');
    Cookies.remove('org-pos-token');
    
    if (typeof window !== 'undefined') {
      localStorage.clear();
      sessionStorage.clear();
    }

    setUser(null);
    router.replace('/login');
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

