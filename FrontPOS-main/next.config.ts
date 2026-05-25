import type { NextConfig } from 'next';
import withPWAInit from "@ducanh2912/next-pwa";

const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
  skipWaiting: true,
  workboxOptions: {
    disableDevLogs: true,
  }
});

const nextConfig: NextConfig = {
  /* config options here */
  
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  output: 'export',
  images: {
    unoptimized: true,
  },
  experimental: {
    optimizePackageImports: [
      '@heroui/react',
      'framer-motion',
      'recharts',
      'date-fns'
    ],
  },
  onDemandEntries: {
    maxInactiveAge: 15 * 60 * 1000,
    pagesBufferLength: 20,
  },
  transpilePackages: ['@ericblade/quagga2'],
  // Nota: rewrites() puede causar conflictos con 'output: export'. Si hay errores, revísalo.
  // Pero se mantiene como estaba originalmente.
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3000/api/:path*',
      },
    ];
  },
};

export default withPWA(nextConfig);
