"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="h-8 w-24 bg-default-100 dark:bg-zinc-800 rounded-2xl border border-divider dark:border-white/5 animate-pulse" />
    );
  }

  return (
    <div className="flex bg-default-100/50 dark:bg-zinc-800/80 p-1 rounded-2xl border border-divider dark:border-white/5 scale-90 sm:scale-100">
      <button
        onClick={() => {
          setTheme("light")
          document.documentElement.setAttribute('data-theme', 'light')
          localStorage.setItem('theme', 'light')
        }}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-2xl text-[9px] font-medium uppercase tracking-widest transition-all ${theme === "light"
            ? "bg-white text-black shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
            : "text-default-500 dark:text-zinc-400 hover:text-foreground dark:hover:bg-zinc-700/50"
          }`}
      >
        <Sun className="h-3 w-3" />
        <span className="hidden sm:inline">CLARO</span>
      </button>
      <button
        onClick={() => {
          setTheme("dark")
          document.documentElement.removeAttribute('data-theme')
          localStorage.setItem('theme', 'dark')
        }}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-2xl text-[9px] font-medium uppercase tracking-widest transition-all ${theme === "dark"
            ? "bg-zinc-700 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
            : "text-default-500 hover:text-foreground hover:bg-default-200"
          }`}
      >
        <Moon className="h-3 w-3" />
        <span className="hidden sm:inline">OSCURO</span>
      </button>
    </div>
  );
}