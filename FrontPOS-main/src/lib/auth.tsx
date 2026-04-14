"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Cookies from 'js-cookie';

type User = {
  dni: string;
  name: string;
  email: string;
  role: 'admin' | 'employee' | 'administrador' | 'empleado';
  Role?: string; // Compatibilidad con datos antiguos
  Name?: string;
  Email?: string;
};

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
    try {
      // 1. Limpieza de claves obsoletas/sensibles en localStorage
      const legacyToken = localStorage.getItem('org-pos-token');
      const legacyUser = localStorage.getItem('org-pos-user');

      // Si existen en localStorage, moverlos a Cookies (solo la primera vez) y eliminar
      if (legacyToken && !Cookies.get('org-pos-token')) {
        Cookies.set('org-pos-token', legacyToken, { expires: 1, secure: true, sameSite: 'strict' });
      }
      if (legacyUser && !Cookies.get('org-pos-user')) {
        Cookies.set('org-pos-user', legacyUser, { expires: 1, secure: true, sameSite: 'strict' });
      }

      // Purga definitiva de localStorage para estas claves
      localStorage.removeItem('org-pos-token');
      localStorage.removeItem('org-pos-user');
      localStorage.removeItem('accessToken');
      localStorage.removeItem('last-sale');

      // 2. Recuperar sesión desde cookies
      const storedUser = Cookies.get('org-pos-user');
      const token = Cookies.get('org-pos-token');
      
      if (storedUser && token) {
        setUser(JSON.parse(storedUser));
      }
    } catch (error) {
      console.error("Failed to recover session from cookies", error);
      Cookies.remove('org-pos-token');
      Cookies.remove('org-pos-user');
    } finally {
      setLoading(false);
    }
  }, []);

  const login = async (credentials: { username: string, password?: string }) => {
    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(credentials),
    });

    if (!response.ok) {
        const text = await response.text();
        let errorMsg = 'Login failed';
        try {
            const errorData = JSON.parse(text);
            errorMsg = errorData.error || errorMsg;
        } catch (e) {}
        throw new Error(errorMsg);
    }

    const data = await response.json();
    const { token, user: userData } = data;
    
    if (userData && token) {
      // Guardar en Cookies (Seguro y Volátil) en lugar de localStorage
      Cookies.set('org-pos-user', JSON.stringify(userData), { expires: 1, secure: true, sameSite: 'strict' });
      Cookies.set('org-pos-token', token, { expires: 1, secure: true, sameSite: 'strict' });
      
      setUser(userData);
      
      const role = userData.role?.toLowerCase() || userData.Role?.toLowerCase() || "";
      if (role === "admin" || role === "administrador") {
        router.push('/dashboard');
      } else {
        router.push('/sales/new');
      }
    } else {
        throw new Error('Invalid response from server');
    }
  };

  const logout = () => {
    Cookies.remove('org-pos-user');
    Cookies.remove('org-pos-token');
    setUser(null);
    router.push('/login');
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
