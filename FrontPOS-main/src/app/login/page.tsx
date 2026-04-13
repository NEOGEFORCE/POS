"use client";

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useToast } from "@/hooks/use-toast";
import { LogIn, Eye, EyeOff, Mail } from 'lucide-react';
// Importamos los componentes premium de HeroUI
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Input,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter
} from "@heroui/react";
import { ThemeToggle } from "@/components/theme-toggle";

export default function LoginPage() {
  const { login, user } = useAuth();
  const { toast } = useToast();
  const router = useRouter();

  // Estados de UI y Autenticación
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [forgotEmail, setForgotEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isForgotLoading, setIsForgotLoading] = useState(false);
  const [isForgotOpen, setIsForgotOpen] = useState(false);
  const [isVisible, setIsVisible] = useState(false); // Para mostrar/ocultar contraseña

  const toggleVisibility = () => setIsVisible(!isVisible);

  // Redirigir si ya está autenticado
  useEffect(() => {
    if (user) {
      const role = (user.role || user.Role || "").toLowerCase();
      if (role === 'admin' || role === 'administrador') {
        router.replace('/dashboard');
      } else {
        router.replace('/sales/new');
      }
    }
  }, [user, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      await login({ username, password });
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error de autenticación",
        description: error.message || "Usuario o contraseña incorrectos.",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsForgotLoading(true);

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail }),
      });

      const data = await response.json();
      toast({
        title: "Petición enviada",
        description: data.message || "Si el correo existe, recibirás instrucciones.",
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
    // Contenedor principal Responsive (Mobile-First) con transición de colores
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-[#09090b] p-4 relative overflow-hidden transition-colors duration-500">
      
      {/* Selector de Tema en la esquina superior derecha */}
      <div className="absolute top-4 right-4 z-50">
        <ThemeToggle />
      </div>

      {/* Background Glow (Brillo dinámico detrás de la tarjeta) */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] sm:w-[500px] h-[300px] sm:h-[500px] bg-emerald-500/10 dark:bg-emerald-500/15 blur-[100px] sm:blur-[120px] rounded-full pointer-events-none" />

      {/* HeroUI Card */}
      <Card
        className="w-full max-w-sm border border-gray-200 dark:border-white/5 rounded-[2rem] sm:rounded-[2.5rem] bg-white/80 dark:bg-zinc-950/60 backdrop-blur-3xl shadow-xl dark:shadow-2xl relative z-10 p-2 sm:p-4 transition-colors"
        shadow="lg"
      >
        <CardHeader className="flex-col items-center pt-8 pb-0">
          <div className="mb-6 flex h-16 w-16 sm:h-20 sm:w-20 items-center justify-center rounded-[1.5rem] sm:rounded-[2rem] bg-gray-100 dark:bg-black text-emerald-600 dark:text-emerald-500 shadow-xl shadow-emerald-500/10 dark:shadow-2xl dark:shadow-emerald-500/20 transition-all duration-500 hover:scale-110 active:scale-95 group border border-gray-200 dark:border-white/5">
            <LogIn className="h-8 w-8 sm:h-10 sm:w-10 transition-transform group-hover:rotate-12" />
          </div>
          <h1 className="text-3xl sm:text-4xl font-black tracking-tighter text-gray-900 dark:text-white uppercase">
            SISTEMA POS
          </h1>
          <p className="text-[9px] sm:text-[10px] font-black uppercase text-gray-500 dark:text-zinc-500 tracking-[0.2em] sm:tracking-[0.3em] mt-2 sm:mt-3 text-center">
            v1.0.0 Edition
          </p>
        </CardHeader>

        <form onSubmit={handleSubmit}>
          <CardBody className="space-y-5 px-4 sm:px-6 py-6 sm:py-8 overflow-hidden">
            <div className="space-y-1">
              <div className="px-1 mb-2">
                <label className="text-[10px] font-black uppercase text-gray-500 dark:text-zinc-500 tracking-wider">
                  Usuario
                </label>
              </div>
              <Input
                id="username"
                name="pos-user"
                autoComplete="off"
                type="text"
                isRequired
                value={username}
                onValueChange={setUsername}
                isDisabled={isLoading}
                variant="flat"
                radius="lg"
                classNames={{
                  input: "font-bold text-gray-900 dark:text-white bg-transparent",
                  inputWrapper: "h-14 bg-transparent border border-gray-200 dark:border-white/10 transition-all shadow-none",
                }}
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between px-1 mb-2">
                <label className="text-[10px] font-black uppercase text-gray-500 dark:text-zinc-500 tracking-wider">
                  Contraseña
                </label>
                <button
                  type="button"
                  onClick={() => setIsForgotOpen(true)}
                  className="text-[9px] font-black text-gray-400 dark:text-zinc-400 uppercase hover:text-emerald-600 dark:hover:text-emerald-500 transition-colors tracking-wider outline-none"
                >
                  ¿Recuperar Acceso?
                </button>
              </div>

              {/* HeroUI Input para Contraseña con botón de visibilidad */}
              <Input
                id="password"
                name="pos-password"
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
                      <EyeOff className="text-xl text-gray-400 dark:text-zinc-500 pointer-events-none transition-colors hover:text-gray-600 dark:hover:text-zinc-300" />
                    ) : (
                      <Eye className="text-xl text-gray-400 dark:text-zinc-500 pointer-events-none transition-colors hover:text-gray-600 dark:hover:text-zinc-300" />
                    )}
                  </button>
                }
                classNames={{
                  input: "font-bold text-gray-900 dark:text-white bg-transparent",
                  inputWrapper: "h-14 bg-transparent border border-gray-200 dark:border-white/10 transition-all shadow-none",
                }}
              />
            </div>
          </CardBody>

          <CardFooter className="px-4 sm:px-6 pb-6 sm:pb-8 pt-0">
            {/* HeroUI Button: Maneja automáticamente el spinner con isLoading */}
            <Button
              type="submit"
              color="primary"
              size="lg"
              radius="lg"
              isLoading={isLoading}
              endContent={!isLoading && <LogIn className="h-5 w-5" />}
              className="w-full h-14 sm:h-16 text-base sm:text-lg font-black bg-emerald-500 hover:bg-emerald-600 text-white dark:text-black shadow-[0_0_30px_-8px_rgba(16,185,129,0.4)] transition-all active:scale-95"
            >
              INICIAR SESIÓN
            </Button>
          </CardFooter>
        </form>
      </Card>

      {/* Modal de Recuperación de HeroUI */}
      <Modal
        isOpen={isForgotOpen}
        onOpenChange={setIsForgotOpen}
        placement="center"
        backdrop="blur"
        classNames={{
          base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-2xl rounded-[2rem]",
          header: "border-b border-gray-100 dark:border-white/5",
          footer: "border-t border-gray-100 dark:border-white/5 bg-gray-50 dark:bg-transparent",
        }}
      >
        <ModalContent>
          {(onClose) => (
            <form onSubmit={handleForgotPassword}>
              <ModalHeader className="flex flex-col gap-1 pt-6 px-6">
                <h2 className="font-black text-xl sm:text-2xl uppercase text-gray-900 dark:text-white">Recuperar Acceso</h2>
                <p className="text-xs font-bold text-gray-500 dark:text-zinc-500 uppercase normal-case">
                  Ingresa tu correo para recibir instrucciones.
                </p>
              </ModalHeader>
              <ModalBody className="py-6 px-6">
                <Input
                  autoFocus
                  id="forgot-email"
                  type="email"
                  label="Correo Electrónico"
                  labelPlacement="outside"
                  isRequired
                  value={forgotEmail}
                  onValueChange={setForgotEmail}
                  isDisabled={isForgotLoading}
                  variant="flat"
                  startContent={<Mail className="text-gray-400 dark:text-zinc-500 w-4 h-4 mr-2" />}
                  classNames={{
                    label: "text-[10px] font-black uppercase text-gray-500 dark:text-zinc-500 tracking-wider mb-2",
                    input: "font-bold text-gray-900 dark:text-white bg-transparent",
                    inputWrapper: "h-14 bg-transparent border border-gray-200 dark:border-white/10 transition-colors shadow-none",
                  }}
                />
              </ModalBody>
              <ModalFooter className="px-6 pb-6">
                <Button color="danger" variant="light" onPress={onClose} className="font-bold uppercase tracking-wider text-xs">
                  Cancelar
                </Button>
                <Button color="primary" type="submit" isLoading={isForgotLoading} className="font-bold uppercase tracking-wider text-xs bg-emerald-500 hover:bg-emerald-600 text-white dark:text-black shadow-md shadow-emerald-500/20">
                  Enviar Llave
                </Button>
              </ModalFooter>
            </form>
          )}
        </ModalContent>
      </Modal>

      <div className="fixed bottom-4 sm:bottom-8 text-[8px] sm:text-[9px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-[0.3em] sm:tracking-[0.4em] z-20 text-center w-full px-4 transition-colors">
        SISTEMA POS — v1.0.0
      </div>
    </div>
  );
}