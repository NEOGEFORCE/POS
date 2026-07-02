import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/lib/auth';
import { Toaster } from 'sonner';
import { DM_Sans, DM_Mono } from 'next/font/google';

// IMPORTANTE: Importamos el archivo puente que acabamos de crear
import { Providers } from './providers';
import './globals.css';
import SWRegister from './sw-register';
import { GlobalSyncProvider } from "@/components/shared/GlobalSyncProvider";
import { NetworkMonitor } from "@/components/shared/NetworkMonitor";
import PWAInstallPrompt from "@/components/shared/PWAInstallPrompt";
import ReLoginModal from "@/components/ReLoginModal";

const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-dm-sans',
});

const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  variable: '--font-dm-mono',
});

export const metadata: Metadata = {
  title: 'POS Pro',
  description: 'Sistema de Punto de Venta Premium',
  manifest: '/manifest.json',
  applicationName: 'POS PRO',
  other: {
    'google': 'notranslate',
    'mobile-web-app-capable': 'yes'
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'POS Pro',
  },
};

// MEJORA UX: Desactivamos el auto-zoom en moviles al hacer focus en inputs
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#09090b', // Cambiado a oscuro para coincidir con la cabecera
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className={`${dmSans.variable} ${dmMono.variable}`} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body suppressHydrationWarning className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col antialiased overflow-x-hidden">

        {/* Envolvemos toda la app en nuestro Provider de Cliente */}
        <Providers>
          <SWRegister />
          <AuthProvider>
            <GlobalSyncProvider />
            <NetworkMonitor />
            <ReLoginModal />
            {children}
            <PWAInstallPrompt />
            <Toaster position="top-left" richColors expand={false} theme="system" closeButton />
          </AuthProvider>
        </Providers>

      </body>
    </html>
  );
}
