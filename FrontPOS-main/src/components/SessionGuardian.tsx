"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useToast } from "@/hooks/use-toast";
import { isSessionRecoveryActive } from "@/lib/session-recovery";
import { clearSession, getSessionToken, subscribeAuthMessages } from "@/lib/session";

export default function SessionGuardian() {
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const [lastActivity, setLastActivity] = useState(Date.now());

  useEffect(() => subscribeAuthMessages((message) => {
    if (message.type === "session-updated") {
      setLastActivity(Date.now());
      return;
    }
    if (isSessionRecoveryActive()) return;
    toast({
      title: "SESIÓN FINALIZADA",
      description: message.reason === "timeout"
        ? "La sesión terminó por inactividad."
        : "La sesión se cerró en esta u otra ventana.",
      variant: "destructive",
    });
    router.replace(message.reason === "timeout" ? "/login?reason=timeout" : "/login");
  }), [router, toast]);

  useEffect(() => {
    const updateOnlineStatus = () => {
      if (!navigator.onLine) {
        toast({
          title: "MODO OFFLINE ACTIVADO",
          description: "Se perdió la conexión. Las ventas se guardarán localmente.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "CONEXIÓN RESTAURADA",
          description: "El sistema vuelve a estar en línea.",
          variant: "default",
        });
      }
    };
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, [toast]);

  useEffect(() => {
    const checkSession = window.setInterval(() => {
      if (isSessionRecoveryActive()) return;
      if (!getSessionToken() && !pathname.includes("/login")) {
        clearSession("missing", { broadcast: false });
        router.replace("/login");
        return;
      }
      if (Date.now() - lastActivity > 3_600_000 && !pathname.includes("/login")) {
        clearSession("timeout");
      }
    }, 60_000);
    return () => window.clearInterval(checkSession);
  }, [lastActivity, pathname, router]);

  useEffect(() => {
    const activityEvents = ["mousedown", "keydown", "touchstart", "scroll"] as const;
    const updateActivity = () => setLastActivity(Date.now());
    activityEvents.forEach((event) => window.addEventListener(event, updateActivity));
    return () => activityEvents.forEach((event) => window.removeEventListener(event, updateActivity));
  }, []);

  return null;
}
