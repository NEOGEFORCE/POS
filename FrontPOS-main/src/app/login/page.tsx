"use client";
// Cache buster for Turbopack HMR

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Mail, Zap } from 'lucide-react';
// Importamos los componentes premium de HeroUI
import {
  Button,
  Input,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter
} from "@heroui/react";
import { ThemeToggle } from "@/components/theme-toggle";
import { AnimatePresence, motion } from "framer-motion";
import { useReducedMotionSafe } from "@/components/ui/motion";

export default function LoginPage() {
  const { login, user } = useAuth();
  const { toast } = useToast();
  const router = useRouter();

  // Estados de UI y Autenticacion
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [forgotEmail, setForgotEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isForgotLoading, setIsForgotLoading] = useState(false);
  const [isForgotOpen, setIsForgotOpen] = useState(false);
  const [isVisible, setIsVisible] = useState(false); // Para mostrar/ocultar contrasena

  // Cortinas estilo yann.uiux: al login exitoso ambos paneles salen
  // en direcciones opuestas y luego navegamos al dashboard.
  const reducedMotion = useReducedMotionSafe();
  const [closing, setClosing] = useState(false);
  const [redirectTo, setRedirectTo] = useState<string | null>(null);

  const toggleVisibility = () => setIsVisible(!isVisible);

  // Redirigir si ya esta autenticado o si necesita setup
  useEffect(() => {
    const checkSetupAndAuth = async () => {
      try {
        const response = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/auth/check-setup`);
        const { needsSetup } = await response.json();

        if (needsSetup) {
          router.replace('/setup');
          return;
        }

        if (user) {
          const role = (user.role || user.Role || "").toLowerCase();
          const target = (role === 'admin' || role === 'administrador' || role === 'superadmin')
            ? '/dashboard'
            : '/sales/new';

          // Cortinas: dispara la salida de ambos paneles y navega cuando termine.
          // En reduced-motion el redirect es instantaneo.
          if (reducedMotion) {
            router.replace(target);
          } else {
            setRedirectTo(target);
            setClosing(true);
          }
        }
      } catch (error) {
        console.error("Error Checking Setup:", error);
      }
    };
    checkSetupAndAuth();
  }, [user, router, reducedMotion]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      await login({ username, password });
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error de autenticacion",
        description: error.message || "Usuario o contrasena incorrectos.",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsForgotLoading(true);

    try {
      const response = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail }),
      });

      const data = await response.json();
      toast({
        title: "Peticion enviada",
        description: data.message || "Si el correo corresponde a una cuenta administrativa, recibiras instrucciones.",
      });
      setIsForgotOpen(false);
      setForgotEmail('');
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "No se pudo procesar la solicitud.",
      });
    } finally {
      setIsForgotLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-[var(--bg-app)] relative overflow-hidden transition-colors duration-500">
      {/* Selector de Tema en la esquina superior derecha */}
      <div className="absolute top-4 right-4 z-50">
        <ThemeToggle />
      </div>

      <AnimatePresence
        onExitComplete={() => {
          if (redirectTo) {
            router.replace(redirectTo);
          }
        }}
      >
        {!closing && (
          <>
            {/* PANEL IZQUIERDO (Hero/Marketing) — sale hacia la izquierda */}
            <motion.div
              key="login-splash"
              initial={{ x: 0 }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 90, damping: 22 }}
              className="hidden lg:flex w-[55%] flex-col justify-between p-12 relative overflow-hidden bg-[var(--bg-sidebar)] border-r border-[var(--border)]"
            >
        {/* Glow dinamico de fondo (Esmeralda) */}
        <div className="absolute top-1/4 -left-1/4 w-[800px] h-[800px] bg-[var(--accent)] opacity-[0.03] dark:opacity-[0.05] blur-[120px] rounded-full pointer-events-none" />
        
        <div className="relative z-10">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--accent-soft)] shadow-[0_0_30px_var(--accent-soft)] transition-transform hover:scale-105 border border-[var(--accent-border)]">
            <Zap className="h-8 w-8 text-[var(--accent)]" />
          </div>
          <h1 className="mt-12 text-5xl font-medium tracking-tighter text-[var(--text-primary)] uppercase">
            Store<br/>Overview
          </h1>
          <p className="mt-6 max-w-sm text-sm text-[var(--text-secondary)] leading-relaxed">
            Sistema inteligente de punto de venta y gestion de inventario. Todo en una unica plataforma de alto rendimiento.
          </p>
        </div>

        <div className="relative z-10 flex items-center gap-4">
          <div className="flex -space-x-3">
            {[1,2,3].map(i => (
              <div key={i} className="h-10 w-10 rounded-full border-2 border-[var(--bg-sidebar)] bg-[var(--bg-elevated)]" />
            ))}
          </div>
          <div className="text-xs font-medium text-[var(--text-secondary)]">
            <span className="text-[var(--text-primary)] block">Trusted by</span>
            +2,000 Retailers
          </div>
        </div>
      </motion.div>

      {/* PANEL DERECHO (Formulario de Login) — sale hacia la derecha */}
            <motion.div
              key="login-form"
              initial={{ x: 0 }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 90, damping: 22 }}
              className="w-full lg:w-[45%] flex flex-col justify-center px-8 sm:px-16 lg:px-24 bg-[var(--bg-app)] relative"
            >
        <div className="w-full max-w-sm mx-auto">
          {/* Cabecera Movil (Solo visible en moviles) */}
          <div className="lg:hidden mb-12 flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--accent-soft)] shadow-[0_0_30px_var(--accent-soft)] mb-6 border border-[var(--accent-border)]">
              <Zap className="h-8 w-8 text-[var(--accent)]" />
            </div>
            <h1 className="text-3xl font-medium tracking-tighter text-[var(--text-primary)] uppercase">POS PRO</h1>
            <p className="mt-2 text-xs font-medium uppercase text-[var(--text-muted)] tracking-widest">
              v1.0.0 Edition
            </p>
          </div>

          <div className="mb-10 lg:text-left text-center">
            <h2 className="text-2xl font-medium text-[var(--text-primary)] uppercase tracking-tight">Bienvenido</h2>
            <p className="text-sm text-[var(--text-secondary)] mt-2">Ingresa tus credenciales para continuar.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-1.5">
              <label htmlFor="username" className="text-[10px] font-bold uppercase text-[var(--text-muted)] tracking-wider block ml-1">
                Usuario
              </label>
              <Input
                id="username"
                autoComplete="off"
                type="text"
                isRequired
                value={username}
                onValueChange={setUsername}
                isDisabled={isLoading}
                variant="flat"
                radius="lg"
                classNames={{
                  input: "font-medium text-[var(--text-primary)] bg-transparent uppercase",
                  inputWrapper: "h-14 bg-[var(--bg-elevated)] hover:bg-[var(--bg-card-hover)] focus-within:bg-[var(--bg-card-hover)] border border-[var(--border)] transition-all shadow-none",
                }}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between ml-1">
                <label htmlFor="password" className="text-[10px] font-bold uppercase text-[var(--text-muted)] tracking-wider">
                  Contrasena
                </label>
                <button
                  type="button"
                  onClick={() => setIsForgotOpen(true)}
                  className="text-[10px] font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors tracking-wider outline-none uppercase"
                >
                  ¿Recuperar?
                </button>
              </div>
              <Input
                id="password"
                autoComplete="new-password"
                type={isVisible ? "text" : "password"}
                isRequired
                value={password}
                onValueChange={setPassword}
                isDisabled={isLoading}
                variant="flat"
                radius="lg"
                endContent={
                  <button className="focus:outline-none" type="button" onClick={toggleVisibility}>
                    {isVisible ? (
                      <EyeOff className="text-xl text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]" />
                    ) : (
                      <Eye className="text-xl text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]" />
                    )}
                  </button>
                }
                classNames={{
                  input: "font-medium text-[var(--text-primary)] bg-transparent",
                  inputWrapper: "h-14 bg-[var(--bg-elevated)] hover:bg-[var(--bg-card-hover)] focus-within:bg-[var(--bg-card-hover)] border border-[var(--border)] transition-all shadow-none",
                }}
              />
            </div>

            <Button
              type="submit"
              color="primary"
              size="lg"
              radius="lg"
              isLoading={isLoading}
              className="w-full h-14 mt-4 font-medium tracking-wide shadow-[0_0_20px_var(--accent-soft)] transition-all active:scale-[0.98]"
            >
              INICIAR SESION
            </Button>
          </form>
        </div>
      </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Modal de Recuperacion */}
      <Modal
        isOpen={isForgotOpen}
        onOpenChange={setIsForgotOpen}
        placement="center"
        backdrop="blur"
        classNames={{
          base: "bg-[var(--bg-card)] border border-[var(--border)] shadow-2xl rounded-3xl",
          header: "border-b border-[var(--border)]",
          footer: "border-t border-[var(--border)]",
        }}
      >
        <ModalContent>
          {(onClose) => (
            <form onSubmit={handleForgotPassword}>
              <ModalHeader className="flex flex-col gap-1 pt-6 px-6">
                <h2 className="font-medium text-xl uppercase text-[var(--text-primary)]">Recuperar Acceso</h2>
                <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mt-1">
                  Solo cuentas administrativas
                </p>
              </ModalHeader>
              <ModalBody className="py-6 px-6">
                <div className="space-y-1.5">
                  <label htmlFor="forgot-email" className="text-[10px] font-bold uppercase text-[var(--text-muted)] tracking-wider block ml-1">
                    Correo Electronico
                  </label>
                  <Input
                    autoFocus
                    id="forgot-email"
                    type="email"
                    isRequired
                    value={forgotEmail}
                    onValueChange={setForgotEmail}
                    isDisabled={isForgotLoading}
                    variant="flat"
                    radius="lg"
                    startContent={<Mail className="text-[var(--text-muted)] w-4 h-4 mr-2" />}
                    classNames={{
                      input: "font-medium text-[var(--text-primary)] bg-transparent uppercase",
                      inputWrapper: "h-14 bg-[var(--bg-elevated)] focus-within:bg-[var(--bg-card-hover)] border border-[var(--border)] transition-all shadow-none",
                    }}
                  />
                </div>
              </ModalBody>
              <ModalFooter className="px-6 pb-6">
                <Button variant="light" onPress={onClose} className="font-medium uppercase tracking-wider text-xs text-[var(--text-secondary)]">
                  Cancelar
                </Button>
                <Button color="primary" type="submit" isLoading={isForgotLoading} className="font-medium uppercase tracking-wider text-xs shadow-md">
                  Enviar Llave
                </Button>
              </ModalFooter>
            </form>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}
