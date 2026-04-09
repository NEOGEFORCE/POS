
"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useRouter } from 'next/navigation';

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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    try {
      const storedUser = localStorage.getItem('org-pos-user');
      const token = localStorage.getItem('org-pos-token');
      if (storedUser && token) {
        setUser(JSON.parse(storedUser));
      } else {
        // If no user but there's a token, something is wrong, clear it.
        if(token) localStorage.removeItem('org-pos-token');
      }
    } catch (error) {
      console.error("Failed to parse user from localStorage", error);
      localStorage.removeItem('org-pos-user');
      localStorage.removeItem('org-pos-token');
    } finally {
      setLoading(false);
    }
  }, []);

  const login = async (credentials: { username: string, password?: string }) => {
    console.log("Intentando login con:", credentials);
    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(credentials),
    });

    console.log("Respuesta del servidor (Status):", response.status);

    if (!response.ok) {
        const text = await response.text();
        console.error("Cuerpo del error (Raw):", text);
        let errorMsg = 'Login failed';
        try {
            const errorData = JSON.parse(text);
            errorMsg = errorData.error || errorMsg;
        } catch (e) {}
        throw new Error(errorMsg);
    }

    const data = await response.json();
    console.log("Login exitoso, datos recibidos:", data);
    
    const { token, user: userData } = data;
    
    if (userData && token) {
      localStorage.setItem('org-pos-user', JSON.stringify(userData));
      localStorage.setItem('org-pos-token', token);
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
    localStorage.removeItem('org-pos-user');
    localStorage.removeItem('org-pos-token');
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
