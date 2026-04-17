"use client"

import { useEffect } from "react"

import {
  Sidebar,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  LayoutDashboard,
  Users,
  UserCircle,
  Shapes,
  FileText,
  Package,
  CreditCard,
  ShoppingCart,
  History,
  ArrowUpCircle,
  Zap,
  LogOut,
  Truck,
  Tag,
  BarChart3,
  ShieldCheck
} from "lucide-react"
import { useAuth } from "@/lib/auth"
import Link from "next/link"
import { usePathname } from "next/navigation"

const menuItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, adminOnly: true },
  { href: "/reports", label: "Reportes", icon: BarChart3, adminOnly: true },
  { href: "/sales/new", label: "Venta", icon: ShoppingCart },
  { href: "/sales", label: "Historial", icon: History },
  { href: "/sales/returns", label: "Devoluciones", icon: CreditCard },
  { href: "/dashboard/closure", label: "Cierre", icon: FileText, adminOnly: true },
  { href: "/products", label: "Productos", icon: Package },
  { href: "/suppliers", label: "Proveedores", icon: Truck },
  { href: "/inventory/receive", label: "Recepción", icon: ArrowUpCircle },
  { href: "/categories", label: "Categorías", icon: Shapes },
  { href: "/customers", label: "Clientes", icon: UserCircle },
  { href: "/expenses", label: "Gastos", icon: FileText },
  { href: "/labels", label: "Etiquetas", icon: Tag }, // <-- NUEVA LÍNEA AGREGADA
  { href: "/users", label: "Personal", icon: Users, adminOnly: true },
  { href: "/audit", label: "Auditoría", icon: ShieldCheck, adminOnly: true },
]

export function AppSidebar() {
  const { user, logout } = useAuth()
  const pathname = usePathname()
  const { setOpenMobile, setOpen } = useSidebar()

  const role = user?.role?.toLowerCase() || user?.Role?.toLowerCase() || "";
  const isAdmin = role === "admin" || role === "administrador" || role === "superadmin" || role === "auditor";

  return (
    <Sidebar className="border-r border-gray-200 dark:border-white/5 bg-white dark:bg-zinc-950 backdrop-blur-3xl shadow-2xl overflow-hidden transition-colors duration-500">
      <SidebarHeader className="py-4 px-6 border-b border-gray-100 dark:border-white/5">
        <div className="flex items-center gap-3 group">
          <div className="bg-emerald-500 h-10 w-10 rounded-2xl flex items-center justify-center shadow-[0_0_20px_rgba(16,185,129,0.3)] transition-all duration-700 group-hover:rotate-[180deg] group-hover:scale-105">
            <Zap className="h-5 w-5 text-white dark:text-black" />
          </div>
          <div className="flex flex-col">
            <h1 className="text-lg font-black text-gray-900 dark:text-white tracking-tighter leading-none italic uppercase">SISTEMA POS</h1>
            <span className="text-[7px] font-black text-emerald-600 dark:text-emerald-500 tracking-[0.4em] mt-1 uppercase opacity-80">v1.0.0</span>
          </div>
        </div>
      </SidebarHeader>

      <div className="flex-1 px-3 py-4 overflow-y-auto custom-scrollbar">
        <div className="px-1">
          <p className="text-[8px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-[0.3em] mb-3 px-2">Menú Principal</p>
          <SidebarMenu className="space-y-0.5">
            {menuItems.map(
              (item) => {
                const isActive = item.href === "/dashboard" 
                  ? pathname === "/dashboard" 
                  : pathname.startsWith(item.href);

                return (!item.adminOnly || isAdmin) && (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.label}
                      onClick={() => {
                        setOpenMobile(false);
                        setOpen(false);
                      }}
                      className={`h-10 rounded-xl px-4 transition-all duration-300 relative group/btn ${isActive
                          ? 'bg-emerald-500 text-white dark:bg-emerald-500/10 dark:text-emerald-500 dark:border-l-4 dark:border-emerald-500 shadow-lg scale-[1.01]'
                          : 'text-gray-500 dark:text-zinc-500 hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-white'
                        }`}
                    >
                      <Link href={item.href} className="flex items-center gap-3">
                        <item.icon className={`h-4 w-4 flex-shrink-0 transition-transform duration-300 group-hover/btn:scale-110 ${isActive ? 'text-white dark:text-emerald-500' : 'text-gray-400 dark:text-zinc-600 group-hover/btn:text-emerald-600 dark:group-hover/btn:text-emerald-500'}`} />
                        <span className="text-[10px] font-black uppercase tracking-widest truncate">{item.label}</span>
                        {isActive && (
                          <div className="absolute right-2 h-1.5 w-1.5 rounded-full bg-white/40 dark:bg-emerald-500 animate-pulse" />
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              }
            )}
          </SidebarMenu>
        </div>
      </div>

      <SidebarFooter className="p-3 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-black/40">
        <div className="flex flex-col gap-2">
          <SidebarMenuItem className="list-none">
            <SidebarMenuButton
              onClick={() => {
                setOpenMobile(false);
                setOpen(false);
                logout();
              }}
              className="h-10 rounded-xl bg-gray-100 dark:bg-zinc-900 border border-gray-200 dark:border-white/5 text-gray-500 dark:text-zinc-400 hover:bg-rose-500 hover:text-white hover:border-rose-500 transition-all duration-300 font-black px-4 active:scale-95 group/exit"
            >
              <LogOut className="h-4 w-4 flex-shrink-0" />
              <span className="text-[9px] uppercase font-black tracking-widest ml-3">Salir</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}