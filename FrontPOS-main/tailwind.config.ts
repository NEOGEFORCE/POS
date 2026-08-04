import type {Config} from 'tailwindcss';
const {heroui} = require("@heroui/react");

export default {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{ts,tsx,mdx}',
    './src/components/**/*.{ts,tsx,mdx}',
    './src/app/**/*.{ts,tsx,mdx}',
    "./node_modules/@heroui/theme/dist/components/*.js",
  ],
  theme: {
    extend: {
      fontFamily: {
        body: ['var(--font-dm-sans)', 'sans-serif'],
        headline: ['var(--font-dm-sans)', 'sans-serif'],
        code: ['monospace'],
        mono: ['var(--font-dm-mono)', 'monospace'],
      },
      colors: {
        page: 'var(--bg-page)',
        card: 'var(--bg-card)',
        elevated: 'var(--bg-elevated)',
        background: 'var(--bg-page)',
        foreground: 'var(--text-primary)',
        input: 'var(--bg-elevated)',
        ring: 'var(--text-primary)',
      },
      borderColor: {
        DEFAULT: 'var(--border)',
        strong: 'var(--border-strong)',
      },
      textColor: {
        primary: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        muted: 'var(--text-muted)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },

      /* =====================================================
         CATÁLOGO DE ANIMACIONES — POS PRO
         #28 fade-in, slide-up
         #29 pulse-glow (logo)
         #30 aurora, gradient-x (hero gradients)
         + shimmer (skeleton), float (blobs), marquee, spotlight, bounce-in
         ===================================================== */
      keyframes: {
        /* Entradas básicas */
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'bounce-in': {
          '0%':   { opacity: '0', transform: 'scale(0.3)' },
          '50%':  { opacity: '1', transform: 'scale(1.05)' },
          '70%':  { transform: 'scale(0.9)' },
          '100%': { transform: 'scale(1)' },
        },

        /* Loops decorativos */
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'pulse-glow': {
          '0%, 100%': {
            boxShadow:
              '0 0 0 0 rgba(16, 185, 129, 0.45), 0 0 0 0 rgba(16, 185, 129, 0.30)',
          },
          '50%': {
            boxShadow:
              '0 0 0 8px rgba(16, 185, 129, 0), 0 0 24px 6px rgba(16, 185, 129, 0.25)',
          },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%':      { transform: 'translateY(-12px)' },
        },
        aurora: {
          '0%':   { backgroundPosition: '0% 50%' },
          '50%':  { backgroundPosition: '100% 50%' },
          '100%': { backgroundPosition: '0% 50%' },
        },
        'gradient-x': {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%':      { backgroundPosition: '100% 50%' },
        },
        marquee: {
          '0%':   { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        spotlight: {
          '0%':   { opacity: '0', transform: 'translate(-72%, -62%) scale(0.5)' },
          '100%': { opacity: '1', transform: 'translate(-50%, -40%) scale(1)' },
        },
      },
      animation: {
        'fade-in':    'fade-in 300ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-up':   'slide-up 350ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'bounce-in':  'bounce-in 600ms cubic-bezier(0.16, 1, 0.3, 1) both',
        shimmer:      'shimmer 2.5s linear infinite',
        'pulse-glow': 'pulse-glow 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        float:        'float 6s ease-in-out infinite',
        aurora:       'aurora 18s ease-in-out infinite',
        'gradient-x': 'gradient-x 6s ease infinite',
        marquee:      'marquee 25s linear infinite',
        spotlight:    'spotlight 2s 0.75s ease forwards',
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'), 
    heroui({
      themes: {
        light: {
          colors: {
            primary: {
              DEFAULT: "#059669",
              foreground: "#ffffff",
            },
            secondary: {
              DEFAULT: "#6b7280",
              foreground: "#ffffff",
            },
            focus: "#059669",
          }
        },
        dark: {
          colors: {
            primary: {
              DEFAULT: "#10b981",
              foreground: "#ffffff",
            },
            secondary: {
              DEFAULT: "#4b5563",
              foreground: "#ffffff",
            },
            focus: "#10b981",
          }
        }
      }
    })
  ],
} satisfies Config;
