"use client"

import { useState, useEffect } from "react"
import { usePathname } from "next/navigation"
import { useAuth } from "@/lib/auth"
import {
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Avatar
} from "@heroui/react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { LogOut } from "lucide-react"
import { ThemeToggle } from "@/components/theme-toggle"
import { BackButton } from "@/components/back-button"

export function AppHeader() {
  const { user, logout } = useAuth()
  const [now, setNow] = useState(new Date())

  const userInitial = user?.email?.charAt(0).toUpperCase() || user?.name?.charAt(0).toUpperCase() || "U"

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const timeStr = now.toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).toUpperCase()

  const dateStr = now.toLocaleDateString('es-CO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).toUpperCase()

  const roleLabel = user?.role?.toUpperCase() === "ADMIN" ||
    user?.role?.toUpperCase() === "ADMINISTRADOR" ||
    user?.Role?.toUpperCase() === "ADMINISTRADOR"
    ? "AUDITOR" : "OP SECTOR"

  const pathname = usePathname()

  return (
    <header className="sticky top-0 z-50 flex h-12 items-center justify-between border-b border-divider dark:border-white/10 bg-white/80 dark:bg-zinc-900/90 backdrop-blur-lg px-3 shadow-sm transition-colors">

      <div className="flex items-center gap-2 md:gap-3">
        <SidebarTrigger className="h-7 w-7 rounded-lg bg-default-100 dark:bg-zinc-800 border border-divider dark:border-white/5 shadow-sm text-foreground transition-all hover:bg-emerald-500 hover:border-emerald-500 hover:text-white active:scale-90 shrink-0" />
        {pathname !== "/dashboard" && pathname !== "/" && (
          <BackButton size="sm" showText={false} className="h-7 w-7" />
        )}
        <div className="flex flex-col">
          {/* Branding removed: already present in sidebar */}
        </div>
      </div>

      <div className="flex-1 hidden md:flex flex-col items-center justify-center overflow-hidden px-2">
        <div className="flex items-center gap-3 bg-default-100/50 dark:bg-zinc-800/80 px-4 py-1 rounded-xl border border-divider dark:border-white/5 backdrop-blur-md">
          <div className="flex flex-col items-center leading-none">
            <span className="text-[7px] font-black text-emerald-500 uppercase tracking-[0.3em] mb-0.5 opacity-80">Hora</span>
            <span className="text-sm font-black text-foreground tabular-nums tracking-tighter">{timeStr}</span>
          </div>
          <div className="w-px h-5 bg-divider dark:bg-white/10" />
          <div className="flex flex-col items-start leading-none pr-1">
            <span className="text-[8px] font-black text-default-500 dark:text-zinc-400 uppercase tracking-[0.3em] mb-0.5">Calendario</span>
            <span className="text-[10px] font-black text-default-700 dark:text-zinc-200 tracking-tighter truncate max-w-[150px]">{dateStr}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4 md:gap-6">

        <ThemeToggle />

        <div className="hidden lg:flex flex-col items-end">
          <p className="text-[12px] font-black text-foreground uppercase tracking-tighter leading-none mb-1">
            {user?.name || 'Operador'}
          </p>
          <div className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
            <p className="text-[8px] font-black text-emerald-500 uppercase tracking-widest">
              {roleLabel}
            </p>
          </div>
        </div>

        <Dropdown placement="bottom-end" backdrop="blur">
          <DropdownTrigger>
            <Avatar
              isBordered
              as="button"
              className="transition-transform hover:scale-105"
              color="success"
              name={userInitial}
              size="sm"
            />
          </DropdownTrigger>
          <DropdownMenu aria-label="Acciones de usuario" variant="flat" className="dark:bg-zinc-900 rounded-2xl">
            <DropdownItem key="profile" className="h-14 gap-2 opacity-100">
              <p className="text-[9px] font-black text-default-500 dark:text-zinc-400 uppercase tracking-widest leading-none">Usuario Activo</p>
              <p className="text-[12px] font-black text-foreground uppercase truncate tracking-tighter italic">{user?.email}</p>
            </DropdownItem>
            <DropdownItem
              key="logout"
              color="danger"
              onClick={logout}
              startContent={<LogOut className="h-4 w-4" />}
              className="text-[10px] font-black uppercase tracking-widest mt-2 dark:hover:bg-rose-500/10"
            >
              Cerrar Sesión
            </DropdownItem>
          </DropdownMenu>
        </Dropdown>
      </div>
    </header>
  )
}