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
            focus: "#059669",
          }
        },
        dark: {
          colors: {
            primary: {
              DEFAULT: "#10b981",
              foreground: "#ffffff",
            },
            focus: "#10b981",
          }
        }
      }
    })
  ],
} satisfies Config;
