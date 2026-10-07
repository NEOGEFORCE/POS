"use client";

import React, { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { API_URL } from "@/lib/constants";
import type { User } from "@/lib/definitions";
import { resolvePostLoginTarget } from "@/lib/reauth-redirect.mjs";
import { clearClosureStorage } from "@/lib/closures-helpers.mjs";
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
        // Al cerrar sesion, borramos tambien el conteo del cierre en curso.
        // Si no, el proximo usuario de este PC vería billetes/monedas y notas
        // del cajero anterior en su propia pantalla de cierre.
        clearClosureStorage();
        setUser(null);
        router.replace("/login");
        return;
      }
      const refreshed = readSession();
      // Cambio de usuario entre pestanas: tambien hay que limpiar.
      const prevDni = typeof window !== "undefined" ? localStorage.getItem("pos_last_user_dni") : null;
      const nextDni = refreshed?.user?.dni ?? null;
      if (prevDni && nextDni && prevDni !== nextDni) {
        clearClosureStorage();
      }
      if (nextDni && typeof window !== "undefined") {
        try {
          localStorage.setItem("pos_last_user_dni", String(nextDni));
        } catch {
          // ignorar: localStorage puede estar bloqueado en modo privado.
        }
      }
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

    // Preservar ruta de retorno si el guardián nos trajo con ?next=...
    // resolvePostLoginTarget valida contra open-redirect y cae al destino
    // por rol si next no es seguro.
    const role = (data.user.role ?? data.user.Role ?? "").toLowerCase();
    const nextParam = typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("next")
      : null;
    const target = resolvePostLoginTarget(role, nextParam);
    router.push(target);
  };

  const logout = () => {
    // Antes de limpiar la sesion, borramos los datos del cierre en curso.
    // No queremos que un cajero vea el conteo en billetes/monedas del cajero
    // anterior en el mismo PC. clearSession dispara el message "logout" en
    // otras pestanas, pero localStorage es local por pestana, asi que lo
    // limpiamos aqui tambien.
    clearClosureStorage();
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
