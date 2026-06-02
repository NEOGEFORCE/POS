"use client";

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Button, 
  Card, 
  CardHeader, 
  CardBody, 
  CardFooter, 
  Input, 
  Spinner 
} from "@heroui/react";
import { ThemeToggle } from "@/components/theme-toggle";
import { useToast } from "@/hooks/use-toast";
import { UserPlus, ShieldCheck, Mail, Lock, User, IdCard } from 'lucide-react';

export default function SetupPage() {
  const router = useRouter();
  const { toast } = useToast();
  
  const [formData, setFormData] = useState({
    dni: '',
    name: '',
    email: '',
    password: '',
    confirmPassword: ''
  });
  
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(true);

  useEffect(() => {
    // Verificar si realmente se necesita setup
    const checkSetup = async () => {
      try {
        const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/auth/check-setup`);
        const data = await res.json();
        // Si no necesita setup o hay exito pero dice falso, ir a login
        if (!data.needsSetup) {
          router.replace('/login');
        }
      } catch (error) {
        console.error("Error verificando setup:", error);
        // Error de conexion o servidor: mejor ir a login que arriesgar el superadmin
        router.replace('/login');
      } finally {
        setVerifying(false);
      }
    };
    checkSetup();
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (formData.password !== formData.confirmPassword) {
      toast({
        variant: "destructive",
        title: "Error de validacion",
        description: "Las contraseñas no coinciden.",
      });
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dni: formData.dni,
          name: formData.name,
          email: formData.email,
          password: formData.password
        }),
      });

      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Error en la configuracion");

      toast({
        title: "¡Configuracion Exitosa!",
        description: "Superadministrador creado. Redirigiendo al login...",
      });

      setTimeout(() => {
        router.push('/login');
      }, 2000);

    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    } finally {
      setLoading(false);
    }
  };

  if (verifying) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-[#09090b]">
        <Spinner color="success" size="lg" label="Inicializando sistema..." />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-[#09090b] p-4 relative overflow-hidden transition-colors duration-500">
      
      <div className="absolute top-4 right-4 z-50">
        <ThemeToggle />
      </div>

      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] sm:w-[600px] h-[400px] sm:h-[600px] bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 dark:bg-white/5 blur-[100px] rounded-2xl pointer-events-none" />

      <Card className="w-full max-w-lg border border-gray-200 dark:border-white/5 rounded-[2.5rem] card-base border-none dark:bg-zinc-950/60 shadow-[0_8px_30px_rgb(0,0,0,0.12)] relative z-10 p-4 sm:p-8">
        <CardHeader className="flex-col items-center pb-0">
          <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-[1.5rem] bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 dark:bg-white/5 text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 border border-emerald-200 dark:border-emerald-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-emerald-500/10">
            <ShieldCheck className="h-8 w-8" />
          </div>
          <h1 className="text-3xl font-medium tracking-tighter text-zinc-900 dark:text-zinc-50 uppercase text-center">
            Configuracion Inicial
          </h1>
          <p className="text-[10px] font-medium uppercase text-gray-500 dark:text-zinc-500 tracking-[0.2em] mt-3">
            Crear cuenta de Superadministrador
          </p>
        </CardHeader>

        <form onSubmit={handleSubmit}>
          <CardBody className="space-y-6 py-8">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Identificacion (DNI)"
                placeholder="Ej. 12345678"
                labelPlacement="outside"
                isRequired
                value={formData.dni}
                onValueChange={(v) => setFormData({...formData, dni: v})}
                variant="flat"
                radius="lg"
                startContent={<IdCard className="text-gray-400 w-4 h-4 mr-1" />}
                classNames={{
                  label: "text-[10px] font-medium uppercase text-gray-500 dark:text-zinc-500 tracking-wider mb-2",
                  inputWrapper: "h-12 bg-transparent border border-gray-200 dark:border-white/10",
                }}
              />
              <Input
                label="Nombre Completo"
                placeholder="Ej. Juan Perez"
                labelPlacement="outside"
                isRequired
                value={formData.name}
                onValueChange={(v) => setFormData({...formData, name: v})}
                variant="flat"
                radius="lg"
                startContent={<User className="text-gray-400 w-4 h-4 mr-1" />}
                classNames={{
                  label: "text-[10px] font-medium uppercase text-gray-500 dark:text-zinc-500 tracking-wider mb-2",
                  inputWrapper: "h-12 bg-transparent border border-gray-200 dark:border-white/10",
                }}
              />
            </div>

            <Input
              label="Correo Electronico"
              placeholder="superadmin@empresa.com"
              type="email"
              labelPlacement="outside"
              isRequired
              value={formData.email}
              onValueChange={(v) => setFormData({...formData, email: v})}
              variant="flat"
              radius="lg"
              startContent={<Mail className="text-gray-400 w-4 h-4 mr-1" />}
              classNames={{
                label: "text-[10px] font-medium uppercase text-gray-500 dark:text-zinc-500 tracking-wider mb-2",
                inputWrapper: "h-12 bg-transparent border border-gray-200 dark:border-white/10",
              }}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Contraseña"
                type="password"
                labelPlacement="outside"
                isRequired
                value={formData.password}
                onValueChange={(v) => setFormData({...formData, password: v})}
                variant="flat"
                radius="lg"
                startContent={<Lock className="text-gray-400 w-4 h-4 mr-1" />}
                classNames={{
                  label: "text-[10px] font-medium uppercase text-gray-500 dark:text-zinc-500 tracking-wider mb-2",
                  inputWrapper: "h-12 bg-transparent border border-gray-200 dark:border-white/10",
                }}
              />
              <Input
                label="Confirmar Contraseña"
                type="password"
                labelPlacement="outside"
                isRequired
                value={formData.confirmPassword}
                onValueChange={(v) => setFormData({...formData, confirmPassword: v})}
                variant="flat"
                radius="lg"
                startContent={<Lock className="text-gray-400 w-4 h-4 mr-1" />}
                classNames={{
                  label: "text-[10px] font-medium uppercase text-gray-500 dark:text-zinc-500 tracking-wider mb-2",
                  inputWrapper: "h-12 bg-transparent border border-gray-200 dark:border-white/10",
                }}
              />
            </div>

            <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-500/5 border border-amber-100 dark:border-amber-500/10">
              <p className="text-[9px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wider leading-relaxed">
                IMPORTANTE: Esta cuenta tendra acceso total al sistema. La contraseña debe tener al menos 6 caracteres. Asegurate de usar un correo real para la recuperacion.
              </p>
            </div>
          </CardBody>

          <CardFooter className="pb-8 pt-0">
            <Button
              type="submit"
              color="success"
              size="lg"
              radius="lg"
              isLoading={loading}
              className="w-full h-14 text-sm font-medium bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white dark:text-black shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all uppercase"
            >
              Finalizar Configuracion e Instalar
            </Button>
          </CardFooter>
        </form>
      </Card>

      <div className="fixed bottom-8 text-[9px] font-medium text-gray-400 dark:text-zinc-600 uppercase tracking-[0.4em] z-20 text-center w-full">
        SISTEMA DE SEGURIDAD â€” FIRST RUN
      </div>
    </div>
  );
}



