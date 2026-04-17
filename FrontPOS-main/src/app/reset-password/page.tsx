"use client";

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useToast } from "@/hooks/use-toast";
import { KeyRound, ShieldCheck, ArrowLeft, CheckCircle2 } from 'lucide-react';
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Input
} from "@heroui/react";
import { ThemeToggle } from "@/components/theme-toggle";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!token) {
      toast({
        variant: "destructive",
        title: "Token Faltante",
        description: "El enlace de recuperación no es válido.",
      });
      router.replace('/login');
    }
  }, [token, router, toast]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Las contraseñas no coinciden.",
      });
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "Error al restablecer la contraseña");

      setIsSuccess(true);
      toast({
        title: "¡Éxito!",
        description: "Tu contraseña ha sido actualizada.",
      });
      
      setTimeout(() => {
        router.push('/login');
      }, 3000);
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (isSuccess) {
    return (
      <Card className="w-full max-w-md border-none rounded-[2.5rem] bg-white/80 dark:bg-zinc-950/60 backdrop-blur-3xl shadow-2xl p-8 text-center">
        <div className="flex justify-center mb-6">
          <div className="h-20 w-20 rounded-full bg-emerald-500/10 flex items-center justify-center text-emerald-500">
            <CheckCircle2 size={48} />
          </div>
        </div>
        <h1 className="text-3xl font-black uppercase tracking-tighter text-gray-900 dark:text-white mb-4">¡Contraseña Lista!</h1>
        <p className="text-gray-500 dark:text-zinc-500 font-medium mb-8">Tu acceso ha sido restaurado. Serás redirigido al login en unos segundos...</p>
        <Button 
          color="primary" 
          className="w-full h-14 font-black uppercase tracking-widest bg-emerald-500"
          onPress={() => router.push('/login')}
        >
          Ir al Login Ahora
        </Button>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md border border-gray-200 dark:border-white/5 rounded-[2.5rem] bg-white/90 dark:bg-zinc-950/70 backdrop-blur-3xl shadow-2xl p-2 sm:p-6 transition-all duration-500">
      <CardHeader className="flex-col items-center pb-0 pt-8">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-[2rem] bg-gray-100 dark:bg-black text-emerald-500 border border-gray-200 dark:border-white/5 shadow-xl">
          <KeyRound size={40} />
        </div>
        <h1 className="text-3xl font-black tracking-tighter text-gray-900 dark:text-white uppercase text-center">
          Nueva Contraseña
        </h1>
        <p className="text-[10px] font-black uppercase text-gray-400 dark:text-zinc-500 tracking-[0.3em] mt-3">
          Establece una clave segura
        </p>
      </CardHeader>

      <form onSubmit={handleSubmit}>
        <CardBody className="space-y-6 py-8">
          <Input
            type={isVisible ? "text" : "password"}
            label="NUEVA CONTRASEÑA"
            labelPlacement="outside"
            placeholder="••••••••"
            isRequired
            value={password}
            onValueChange={setPassword}
            isDisabled={isLoading}
            classNames={{
              label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 mb-2 ml-1",
              inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-emerald-500 transition-all",
              input: "font-black text-lg italic text-gray-900 dark:text-white"
            }}
          />
          <Input
            type={isVisible ? "text" : "password"}
            label="CONFIRMAR CONTRASEÑA"
            labelPlacement="outside"
            placeholder="••••••••"
            isRequired
            value={confirmPassword}
            onValueChange={setConfirmPassword}
            isDisabled={isLoading}
            classNames={{
              label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 mb-2 ml-1",
              inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-emerald-500 transition-all",
              input: "font-black text-lg italic text-gray-900 dark:text-white"
            }}
          />
          
          <div className="flex items-center gap-2 px-1">
            <button 
              type="button" 
              onClick={() => setIsVisible(!isVisible)}
              className="text-[10px] font-black uppercase text-emerald-500 hover:text-emerald-600 transition-colors"
            >
              {isVisible ? "Ocultar" : "Mostrar"} Claves
            </button>
          </div>
        </CardBody>

        <CardFooter className="pb-8 pt-0">
          <Button
            type="submit"
            color="primary"
            isLoading={isLoading}
            className="w-full h-16 text-lg font-black bg-emerald-500 text-white dark:text-black rounded-2xl shadow-lg shadow-emerald-500/20"
          >
            ACTUALIZAR ACCESO
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-[#09090b] p-4 relative overflow-hidden transition-colors duration-500">
      {/* Background Decor */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-emerald-500/10 blur-[120px] rounded-full pointer-events-none" />
      
      <div className="absolute top-4 right-4 animate-in fade-in slide-in-from-top-4 duration-1000">
        <ThemeToggle />
      </div>

      <Suspense fallback={<div>Cargando...</div>}>
         <ResetPasswordForm />
      </Suspense>

      <div className="fixed bottom-8 text-[9px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-[0.4em]">
        Seguridad POS Surtifamiliar
      </div>
    </div>
  );
}
