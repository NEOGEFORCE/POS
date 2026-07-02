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
import { LogOut } from "lucide-react"
import { ThemeToggle } from "@/components/theme-toggle"
import { BackButton } from "@/components/back-button"
import { NotificationDot } from "@/components/ui/notification-dot"
import { SidebarTrigger } from "@/components/ui/sidebar"

export function AppHeader() {
  const { user, logout } = useAuth()
  const [now, setNow] = useState(new Date())

  const userInitial = user?.email?.charAt(0).toUpperCase() || user?.name?.charAt(0).toUpperCase() || "U"

  const [isOnline, setIsOnline] = useState(true)
  
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    setIsOnline(navigator.onLine)
    const h1 = () => setIsOnline(true)
    const h2 = () => setIsOnline(false)
    window.addEventListener('online', h1)
    window.addEventListener('offline', h2)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', h1)
      window.removeEventListener('offline', h2)
    }
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
    <header className="sticky top-0 z-[100] flex h-14 items-center justify-between border-b border-[var(--border)] bg-[var(--bg-app)] px-4 shadow-sm transition-colors">
      <div className="flex items-center gap-3">
        <SidebarTrigger className="md:hidden" />
        {pathname !== "/dashboard" && pathname !== "/" && (
          <BackButton size="sm" showText={false} className="h-8 w-8" />
        )}
      </div>

      <div className="flex-1 flex flex-col justify-center items-center px-4 overflow-hidden">
        <span className="text-[9px] md:text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-widest leading-none text-center truncate w-full">
          {dateStr}
        </span>
        <span className="text-[10px] md:text-xs font-medium text-[var(--text-primary)] uppercase tracking-tight text-center truncate w-full">
          {timeStr}
        </span>
      </div>

      <div className="flex items-center gap-3">
        {/* Indicador de conexion: NotificationDot pulsante (verde online / amarillo offline) */}
        <div className="hidden sm:flex items-center gap-2 mr-2">
           <NotificationDot tone={isOnline ? 'accent' : 'warning'} ping />
        </div>

        <ThemeToggle />

        <div className="hidden lg:flex flex-col items-end mr-2">
          <p className="text-[11px] font-medium text-[var(--text-primary)] uppercase tracking-tight leading-none mb-1">
            {user?.name || 'Operador'}
          </p>
          <div className="px-2 py-0.5 rounded-full bg-[var(--accent-soft)] border border-[var(--accent-border)]">
            <p className="text-[9px] font-bold text-[var(--accent)] uppercase tracking-wider">
              {roleLabel}
            </p>
          </div>
        </div>

        <Dropdown placement="bottom-end" backdrop="blur">
          <DropdownTrigger>
            <Avatar
              isBordered
              as="button"
              className="transition-transform hover:scale-105 border-[var(--accent)]"
              color="primary"
              name={userInitial}
              size="sm"
            />
          </DropdownTrigger>
          <DropdownMenu aria-label="Acciones de usuario" variant="flat" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl">
            <DropdownItem key="profile" className="h-14 gap-2 opacity-100 data-[hover=true]:bg-[var(--bg-card-hover)]">
              <p className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest leading-none">Usuario Activo</p>
              <p className="text-xs font-medium text-[var(--text-primary)] uppercase truncate">{user?.email}</p>
            </DropdownItem>
            <DropdownItem
              key="logout"
              color="danger"
              onClick={logout}
              startContent={<LogOut className="h-4 w-4" />}
              className="text-[10px] font-bold uppercase tracking-widest mt-2 text-[var(--danger)] data-[hover=true]:bg-[var(--danger)]/10"
            >
              Cerrar Sesion
            </DropdownItem>
          </DropdownMenu>
        </Dropdown>
      </div>
    </header>
  )
}