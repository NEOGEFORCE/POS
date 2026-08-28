"use client";

import React, { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { API_URL } from "@/lib/constants";
import type { User } from "@/lib/definitions";
import {
  clearSession,
  migrateLegacySession,
  readSession,
  subscribeAuthMessages,
  writeSession,
} from "@/lib/session";

interface AuthContextType {
  user: User | null;
  login: (credentials: { username: string; password?: string }) => Promise<void>;
  logout: () => void;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const session = migrateLegacySession() ?? readSession();
    setUser(session?.user ?? null);
    setLoading(false);

    return subscribeAuthMessages((message) => {
      if (message.type === "logout") {
        setUser(null);
        router.replace("/login");
        return;
      }
      const refreshed = readSession();
      setUser(refreshed?.user ?? null);
    });
  }, [router]);

  const login = async (credentials: { username: string; password?: string }) => {
    const response = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    });

    if (!response.ok) {
      const text = await response.text();
      let errorMsg = "Error de inicio de sesión";
      try {
        const errorData = JSON.parse(text) as { error?: string | { message?: string } };
        errorMsg = typeof errorData.error === "object"
          ? errorData.error?.message || errorMsg
          : errorData.error || errorMsg;
      } catch {
        // Mantener mensaje seguro por defecto.
      }
      throw new Error(errorMsg);
    }

    const data = await response.json() as { token?: string; user?: User };
    if (!data.user || !data.token) throw new Error("Respuesta inválida del servidor");

    writeSession(data.token, data.user, { broadcast: false });
    setUser({ ...data.user, token: data.token });

    const role = (data.user.role ?? data.user.Role ?? "").toLowerCase();
    router.push(["admin", "administrador", "superadmin"].includes(role) ? "/dashboard" : "/sales/new");
  };

  const logout = () => {
    clearSession("manual");
    setUser(null);
    router.replace("/login");
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}
