"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Cookies from "js-cookie";
import { ShieldAlert, LogIn, LogOut, Loader2, Lock, User } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { API_URL } from "@/lib/constants";
import {
  onSessionRecoveryChange,
  resolveSessionRecovery,
  rejectSessionRecovery,
} from "@/lib/session-recovery";
import { Modal, ModalContent, ModalBody, Button, Input } from "@heroui/react";

/**
 * Modal global de re-autenticación.
 * 
 * Se muestra cuando cualquier llamada API detecta un 401 (sesión expirada).
 * El usuario puede ingresar sus credenciales sin salir de la página,
 * y al autenticarse, la operación que falló se reintenta automáticamente.
 */
export default function ReLoginModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const { user, logout } = useAuth();
  const router = useRouter();

  // Pre-llenar el usuario si lo conocemos
  useEffect(() => {
    if (user?.name) {
      setUsername(user.name);
    } else if (user?.dni) {
      setUsername(user.dni);
    }
  }, [user]);

  // Escuchar cuando se necesita re-autenticación
  useEffect(() => {
    const unsubscribe = onSessionRecoveryChange((active) => {
      setIsOpen(active);
      if (active) {
        setError("");
        setPassword("");
        setIsLoading(false);
      }
    });
    return unsubscribe;
  }, []);

  const handleReLogin = useCallback(async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!username.trim()) {
      setError("Ingresa tu usuario");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });

      if (!response.ok) {
        const text = await response.text();
        let errorMsg = "Credenciales incorrectas";
        
        if (response.status >= 500) {
          errorMsg = "Error en el servidor. El backend parece estar caído o reiniciándose.";
        } else if (response.status === 404) {
          errorMsg = "No se pudo contactar el servidor (404).";
        }
        
        try {
          const errorData = JSON.parse(text);
          if (errorData.error && typeof errorData.error === "object") {
            errorMsg = errorData.error.message || errorMsg;
          } else if (typeof errorData.error === "string") {
            errorMsg = errorData.error;
          }
        } catch {}
        
        setError(errorMsg);
        setIsLoading(false);
        return;
      }

      const data = await response.json();
      const { token, user: userData } = data;

      if (userData && token) {
        // Guardar nuevo token en cookies
        Cookies.set("org-pos-user", JSON.stringify(userData), {
          expires: 0.5,
          secure: true,
          sameSite: "strict",
        });
        Cookies.set("org-pos-token", token, {
          expires: 0.5,
          secure: true,
          sameSite: "strict",
        });

        // Resolver todas las operaciones pendientes con el nuevo token
        resolveSessionRecovery(token);
        setPassword("");
        setError("");
      } else {
        setError("Respuesta del servidor inválida");
      }
    } catch (err) {
      setError("No se pudo conectar al servidor");
    } finally {
      setIsLoading(false);
    }
  }, [username, password]);

  const handleCancel = useCallback(() => {
    rejectSessionRecovery();
    logout();
  }, [logout]);

  return (
    <Modal
      isOpen={isOpen}
      hideCloseButton
      isKeyboardDismissDisabled
      isDismissable={false}
      backdrop="blur"
      placement="center"
      className="bg-zinc-900 border border-zinc-700/50 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95"
      style={{ zIndex: 999999 }}
    >
      <ModalContent>
        {() => (
          <form onSubmit={handleReLogin} className="flex flex-col w-full">
            {/* Barra superior de alerta */}
            <div className="bg-gradient-to-r from-amber-500/20 to-orange-500/20 border-b border-amber-500/30 px-5 py-3 flex items-center gap-3">
              <div className="bg-amber-500/20 p-2 rounded-lg">
                <ShieldAlert size={20} className="text-amber-400" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wider">
                  Sesión Expirada
                </h3>
                <p className="text-[11px] text-amber-300/70">
                  Tu trabajo está seguro. Ingresa tus credenciales para continuar.
                </p>
              </div>
            </div>

            {/* Contenido */}
            <ModalBody className="p-5 space-y-4">
              {/* Mensaje de tranquilidad */}
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3">
                <p className="text-[11px] text-emerald-300/90 leading-relaxed">
                  <strong className="text-emerald-400">No pierdas tu progreso.</strong>{" "}
                  Al ingresar tus credenciales, la operación que estabas haciendo se
                  completará automáticamente.
                </p>
              </div>

              {/* Campo Usuario */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                  Usuario
                </label>
                <div className="relative">
                  <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 z-10" />
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full bg-zinc-800/80 border border-zinc-700/50 rounded-xl pl-10 pr-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 transition-all"
                    placeholder="Tu nombre de usuario"
                    autoComplete="username"
                    autoFocus
                  />
                </div>
              </div>

              {/* Campo Contraseña */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                  Contraseña
                </label>
                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 z-10" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleReLogin();
                      e.stopPropagation();
                    }}
                    className="w-full bg-zinc-800/80 border border-zinc-700/50 rounded-xl pl-10 pr-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 transition-all"
                    placeholder="Tu contraseña"
                    autoComplete="current-password"
                  />
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-2.5">
                  <p className="text-[11px] font-semibold text-red-400 text-center">
                    {error}
                  </p>
                </div>
              )}

              {/* Botones */}
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={isLoading}
                  className="flex-1 flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/50 text-zinc-400 hover:text-zinc-200 rounded-xl py-2.5 text-xs font-semibold uppercase tracking-wider transition-all disabled:opacity-50"
                >
                  <LogOut size={14} />
                  Cerrar Sesión
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-black rounded-xl py-2.5 text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50 shadow-lg shadow-amber-500/20"
                >
                  {isLoading ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <LogIn size={14} />
                  )}
                  {isLoading ? "Verificando..." : "Continuar"}
                </button>
              </div>
            </ModalBody>
          </form>
        )}
      </ModalContent>
    </Modal>
  );
}
