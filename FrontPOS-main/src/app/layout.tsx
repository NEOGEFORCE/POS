import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/lib/auth';
import { Toaster } from '@/components/ui/toaster';
import { Lato, Raleway } from 'next/font/google';

// IMPORTANTE: Importamos el archivo puente que acabamos de crear
import { Providers } from './providers';
import './globals.css';

const lato = Lato({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-lato',
});

const raleway = Raleway({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-raleway',
});

export const metadata: Metadata = {
  title: 'POS-PRO',
  description: 'Sistema de Punto de Venta Premium',
};

// MEJORA UX: Desactivamos el auto-zoom en móviles al hacer focus en inputs
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className={`${lato.variable} ${raleway.variable}`} suppressHydrationWarning>
      <body className="font-body antialiased min-h-screen bg-gray-50 dark:bg-[#09090b] transition-colors duration-300">

        {/* Envolvemos toda la app en nuestro Provider de Cliente */}
        <Providers>
          <AuthProvider>
            {children}
            <Toaster />
          </AuthProvider>
        </Providers>

      </body>
    </html>
  );
}