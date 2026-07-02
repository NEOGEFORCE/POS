"use client"

import { useEffect } from "react"
import { motion } from "framer-motion"

import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
  useSidebar,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  LayoutDashboard,
  PieChart,
  Store,
  Clock,
  RotateCcw,
  LockKeyhole,
  Warehouse,
  Barcode,
  Truck,
  Blocks,
  HeartHandshake,
  Receipt,
  Printer,
  IdCard,
  Fingerprint,
  Zap,
  LogOut,
  UserPlus, UserCircle, Shapes, FileText, Package, CreditCard, ShoppingCart, History, ArrowUpCircle, Tag, BarChart3, ShieldCheck, Box
} from "lucide-react"
import { useAuth } from "@/lib/auth"
import Link from "next/link"
import { usePathname } from "next/navigation"

const menuItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, adminOnly: true },
  { href: "/reports", label: "Reportes", icon: PieChart, adminOnly: true },
  { href: "/sales/new", label: "Venta", icon: Store },
  { href: "/sales", label: "Historial", icon: Clock },
  { href: "/sales/returns", label: "Devoluciones", icon: RotateCcw },
  { href: "/dashboard/closure", label: "Cierre", icon: LockKeyhole, adminOnly: false },
  { href: "/inventory", label: "Inventario", icon: Warehouse },
  { href: "/products", label: "Productos", icon: Barcode },
  { href: "/suppliers", label: "Proveedores", icon: Truck },
  { href: "/categories", label: "Categorias", icon: Blocks },
  { href: "/customers", label: "Clientes", icon: HeartHandshake },
  { href: "/expenses", label: "Gastos", icon: Receipt },
  { href: "/labels", label: "Etiquetas", icon: Printer },
  { href: "/users", label: "Personal", icon: IdCard, adminOnly: true },
  { href: "/audit", label: "Auditoria", icon: Fingerprint, adminOnly: true },
]

export function AppSidebar() {
  const { user, logout } = useAuth()
  const pathname = usePathname()
  const { setOpenMobile, setOpen, state, isMobile } = useSidebar()
  const collapsed = state === "collapsed" && !isMobile

  const role = user?.role?.toLowerCase() || user?.Role?.toLowerCase() || "";
  const isAdmin = role === "admin" || role === "administrador" || role === "superadmin" || role === "auditor";

  return (
    <Sidebar collapsible="icon" className={`border-r border-gray-200 dark:border-white/5 bg-white dark:bg-zinc-950 shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all duration-300 ease-out overflow-hidden`}>
      <SidebarHeader className={`py-4 ${collapsed ? 'px-0 justify-center' : 'px-4'} border-b border-gray-100 dark:border-white/5 shrink-0 transition-all duration-150`}>
        <div className={`flex items-center justify-between w-full`}>
          <div className={`flex items-center gap-2 group ${collapsed ? 'hidden' : 'flex'}`}>
            <div className="bg-[var(--accent-soft)] h-8 w-8 rounded-2xl flex items-center justify-center shadow-[0_0_20px_var(--accent-soft)] transition-all duration-700 group-hover:rotate-[180deg] group-hover:scale-105 shrink-0">
              <Zap className="h-4 w-4 text-[var(--accent)]" />
            </div>
            <div className={`flex flex-col min-w-0 transition-all duration-150`}>
              <h1 className="text-base font-medium text-[var(--text-primary)] tracking-tighter leading-none uppercase truncate">POS PRO</h1>
            </div>
          </div>
          <SidebarTrigger className={`h-8 w-8 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] transition-all shrink-0 ${collapsed ? 'mx-auto' : ''}`} />
        </div>
      </SidebarHeader>

      <SidebarContent className="px-3 py-4 flex-1 overflow-y-auto custom-scrollbar overflow-x-hidden">
        <div className="px-1">
          <p className={`text-[8px] font-medium text-gray-400 dark:text-zinc-600 uppercase tracking-[0.3em] mb-2 px-2 transition-all ${collapsed ? 'opacity-0 h-0 overflow-hidden' : 'opacity-100'}`}>Menu Principal</p>
          <SidebarMenu className="space-y-0.5">
            {menuItems.map(
              (item) => {
                const isActive = item.href === "/dashboard" 
                  ? pathname === "/dashboard" 
                  : pathname.startsWith(item.href);

                return (!item.adminOnly || isAdmin) && (
                  <SidebarMenuItem key={item.href} className="w-full flex">
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={collapsed ? item.label : undefined}
                      onClick={() => {
                        setOpenMobile(false);
                        setOpen(false);
                      }}
                      className={`flex items-center py-1.5 cursor-pointer transition-all duration-150 relative group/btn h-8 w-full text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] ${isActive ? 'bg-[var(--accent-soft)] text-[var(--accent)] rounded-lg' : 'border-transparent rounded-lg'} ${collapsed ? 'justify-center px-0 mx-0' : 'gap-3 px-3 mx-0 sm:mx-1'}`}
                    >
                      <Link href={item.href} className={`flex items-center w-full ${collapsed ? 'justify-center' : 'gap-3'}`} title={collapsed ? item.label : undefined}>
                        {/* Magic indicator: layoutId compartido entre todos los items.
                            Cuando cambia la ruta activa, el indicador se desliza con spring. */}
                        {isActive && (
                          <motion.span
                            layoutId="sidebar-active-indicator"
                            transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                            className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--accent)] shadow-[0_0_10px_var(--accent)]"
                          />
                        )}
                        <item.icon className={`h-[16px] w-[16px] flex-shrink-0 transition-transform duration-300 group-hover/btn:scale-110 ${isActive ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)] group-hover/btn:text-[var(--text-primary)]'}`} />
                        <span className={`text-[13px] font-medium whitespace-nowrap transition-all duration-150 ${collapsed ? 'opacity-0 w-0 overflow-hidden' : 'opacity-100'}`}>
                          {item.label}
                        </span>
                        {isActive && !collapsed && (
                          <div className="absolute right-2 h-1.5 w-1.5 rounded-2xl bg-[var(--accent)] animate-pulse shadow-[0_0_8px_var(--accent)]" />
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              }
            )}
          </SidebarMenu>
        </div>
      </SidebarContent>

      <SidebarFooter className={`p-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-gray-100 dark:border-white/5 bg-white dark:bg-zinc-950 shrink-0 transition-all duration-150`}>
        <div className="flex flex-col gap-2">
          <SidebarMenuItem className="list-none w-full">
            <SidebarMenuButton
              onClick={() => {
                setOpenMobile(false);
                logout();
              }}
              tooltip={collapsed ? "Salir" : undefined}
              className={`flex items-center py-1.5 rounded-lg cursor-pointer transition-all duration-150 relative group/exit h-8 w-full text-gray-500 dark:text-zinc-500 hover:text-white hover:bg-rose-500 border border-transparent hover:border-rose-500 active:scale-95 ${collapsed ? 'justify-center px-0 mx-0' : 'gap-3 px-3 mx-0 sm:mx-1'}`}
              title={collapsed ? "Salir" : undefined}
            >
              <div className={`flex items-center w-full ${collapsed ? 'justify-center' : 'gap-3'}`}>
                <LogOut className="h-[16px] w-[16px] flex-shrink-0" />
                <span className={`text-[13px] font-medium whitespace-nowrap transition-all duration-150 ${collapsed ? 'opacity-0 w-0 overflow-hidden' : 'opacity-100'}`}>
                  Salir
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}