# Catálogo de animaciones — POS Pro

Documento de referencia con **todas** las animaciones del frontend POS,
sus nombres, ubicaciones, parámetros y cómo reutilizarlas.

> Stack de animación
> - **framer-motion 12** — orquestación principal (`variants`, `spring`, `AnimatePresence`, `layout`, `useSpring`, `useTransform`, `useMotionValue`).
> - **tailwindcss-animate** — clases utilitarias `animate-in`, `fade-in-0`, `zoom-in-95`, `slide-in-from-*`, `data-state` para Radix.
> - **CSS keyframes** custom en `tailwind.config.ts` + transiciones globales en `src/app/globals.css`.
> - **SVG `motion.path` + `pathLength`** para charts.
> - **Next.js 15 App Router** — page transitions con `usePathname()` como key.

> Color brand del POS: **verde esmeralda** (`#10b981`). Todas las animaciones que
> en HRCO Frontend usaban violeta aquí están adaptadas a `var(--accent)`.

---

## Tabla resumen

| #  | Nombre                          | Tipo                | Archivo                                                | Función |
|----|---------------------------------|---------------------|--------------------------------------------------------|---------|
| 1  | `MotionPage`                    | page transition     | `src/components/ui/motion.tsx`                         | Fade+slide en cada cambio de ruta (App Router) |
| 2  | `Stagger` / `StaggerItem`       | list reveal         | `src/components/ui/motion.tsx`                         | Children en cascada |
| 3  | `AnimatedCounter`               | count-up            | `src/components/ui/motion.tsx`                         | Spring tween de 0→valor |
| 4  | `RollingDigits`                 | scramble slot       | `src/components/charts/RollingDigits.tsx`              | Cada dígito rueda 0-9 |
| 5  | `MiniBarChart`                  | bar grow            | `src/components/charts/index.tsx`                      | Bars suben con stagger |
| 6  | `MiniCandleChart`               | candle fade-up      | `src/components/charts/index.tsx`                      | Velas aparecen secuencialmente |
| 7  | `ArcGauge`                      | semicircle fill     | `src/components/charts/index.tsx`                      | strokeDashoffset 0→pct |
| 8  | `SparkLine`                     | path drawing        | `src/components/charts/index.tsx`                      | Curva con pathLength + área fade |
| 9  | `SalesAnalyticsChart`           | path + auto-tour    | `src/components/charts/SalesAnalyticsChart.tsx`        | Curva + tooltip que recorre solo |
| 10 | `TopProductsHeatmap`            | value-sorted reveal | `src/components/charts/TopProductsHeatmap.tsx`         | Celdas saturadas primero |
| 11 | `BudgetBar`                     | width 0→%           | `src/components/charts/BudgetBar.tsx`                  | Barra horizontal animada |
| 12 | `KpiCard` hover-lift            | hover spring        | `src/components/ui/kpi-card.tsx`                       | y: -2 con spring al hover |
| 13 | `Card.interactive` spotlight    | cursor follow       | `src/components/ui/card.tsx` + `globals.css`           | Spotlight sigue al cursor |
| 14 | `Dialog`                        | scale+slide         | `src/components/ui/dialog.tsx`                         | data-state animations |
| 15 | `AlertDialog`                   | center pop          | `src/components/ui/alert-dialog.tsx`                   | zoom-in + fade |
| 16 | `DropdownMenu`                  | side-aware          | `src/components/ui/dropdown-menu.tsx`                  | slide-in-from-top/bottom/etc |
| 17 | `Tooltip`                       | delayed fade-zoom   | `src/components/ui/tooltip.tsx`                        | Aparece a 150ms |
| 18 | `Sheet` (drawer)                | slide from side     | `src/components/ui/sheet.tsx`                          | Mobile sidebar |
| 19 | `AnimatedSidebar` collapse      | width spring        | `src/components/animated/AnimatedSidebar.tsx`          | 256 ↔ 68 |
| 20 | `AnimatedSidebar` activeIndicator| layoutId shared    | `src/components/animated/AnimatedSidebar.tsx`          | Magic move entre items |
| 21 | `AnimatedSidebar` items stagger | container variant   | `src/components/animated/AnimatedSidebar.tsx`          | Items entran en cascada |
| 22 | `ThemeToggle` segmented (legacy)| transitions Tailwind| `src/components/theme-toggle.tsx`                      | Estilo segmented control existente |
| 23 | `ThemeTogglePill` iOS           | layout spring       | `src/components/theme-toggle-pill.tsx`                 | Bola se desliza entre extremos |
| 24 | `NotificationDot` ping          | CSS animate-ping    | `src/components/ui/notification-dot.tsx`               | Pulso en badge / Bell |
| 25 | `AuthShell` curtains            | exit slide opposite | `src/components/layout/AuthShell.tsx`                  | Cortinas se abren al login |
| 26 | `MotionTableRow` stagger        | fade-up con delay   | `src/components/ui/animated-table.tsx`                 | Filas entran progresivas |
| 27 | `ConfirmDialog` icon spring     | initial rotate      | `src/components/ConfirmDialog.tsx`                     | Triángulo de alerta entra rebotando |
| 28 | Badge dot ping                  | CSS animate-ping    | `src/components/ui/notification-dot.tsx`               | Punto pulsante reutilizable |
| 29 | `animate-pulse-glow`            | CSS keyframes       | `tailwind.config.ts`                                   | Halo en logo brand |
| 30 | `animate-aurora`, `animate-gradient-x` | CSS keyframes | `tailwind.config.ts` + `.bg-aurora`/`.text-gradient-animated` | Gradients móviles |
| 31 | Theme cross-fade                | CSS transition      | `src/app/globals.css`                                  | Cambio dark/light suave |
| 32 | Reduced motion                  | `useReducedMotionSafe` | `src/components/ui/motion.tsx` + CSS                | Respeta accesibilidad |

---

## 1. Page transitions — `<MotionPage />`

**Qué hace.** Envuelve cada página y aplica fade-up al cambiar de ruta con
`AnimatePresence mode="wait"`. En App Router usa `usePathname()` como key.

**Archivo.** `src/components/ui/motion.tsx`

```tsx
// src/app/(app)/layout.tsx
import { MotionPage } from "@/components/ui/motion";

<main className="flex-1 relative ...">
  <MotionPage className="px-4 py-8">
    {children}
  </MotionPage>
</main>
```

**Variants.**
```ts
fadeUpVariants = {
  hidden: { opacity: 0, y: 12 },
  show:   { opacity: 1, y: 0,  transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
  exit:   { opacity: 0, y: -8, transition: { duration: 0.18, ease: 'easeIn' } },
};
```

> **Nota App Router.** Si decides usarlo, ten en cuenta que el `(app)/layout.tsx`
> ya tiene `loading` state. `MotionPage` es seguro para añadirlo, simplemente
> envuelve `{children}`.

---

## 2. Stagger lists — `<Stagger />` + `<StaggerItem />`

```tsx
import { Stagger, StaggerItem } from "@/components/ui/motion";

<Stagger
  className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4"
  staggerChildren={0.08}
  delayChildren={0.1}
>
  <StaggerItem><KpiCard>...</KpiCard></StaggerItem>
  <StaggerItem><KpiCard>...</KpiCard></StaggerItem>
  <StaggerItem><KpiCard>...</KpiCard></StaggerItem>
</Stagger>
```

---

## 3. Count-up animado — `<AnimatedCounter />`

```tsx
import { AnimatedCounter } from "@/components/ui/motion";
import { formatCOP } from "@/lib/utils";

<AnimatedCounter value={48295} format={formatCOP} />
<AnimatedCounter value={1284} />
<AnimatedCounter value={65} format={(n) => `${n.toFixed(0)}%`} />
```

---

## 4. Scramble slot-machine — `<RollingDigits />`

Cada dígito rueda 3 vueltas + el target hasta detenerse. Usado para los KPIs
grandes del Dashboard.

```tsx
import { RollingDigits } from "@/components/charts/RollingDigits";

<RollingDigits
  value={48295}
  format={formatCOP}        // "$48.295"
  duration={1.8}            // segundos del rolling
  loops={3}                 // vueltas antes de aterrizar
/>
```

---

## 5. Mini bar chart — `<MiniBarChart />`

```tsx
<MiniBarChart
  data={[42, 55, 38, 60, 48, 70, 52, 80, 58, 90, 75, 95]}
  width={130}
  height={48}
  activeIndex={9}            // por defecto: penúltimo
  className="h-12 w-32"
/>
```

---

## 6. Mini candlestick — `<MiniCandleChart />`

```tsx
<MiniCandleChart
  data={[{ o: 35, h: 55, l: 30, c: 50 }, ...]}
  width={130}
  height={48}
/>
```

---

## 7. Arc gauge semicircular — `<ArcGauge />`

```tsx
<ArcGauge value={65} size={130} thickness={14} showLabel suffix="%" />
```

---

## 8. Sparkline — `<SparkLine />`

```tsx
<SparkLine
  data={[1820, 2950, 2410, 3320, 2890, 3760]}
  width={120}
  height={40}
  color="var(--accent)"     // verde esmeralda por defecto
/>
```

---

## 9. Sales Analytics chart — `<SalesAnalyticsChart />`

Line chart con path drawing, área gradient, **tooltip auto-tour** que recorre
los puntos cada `tourInterval` segundos, y hover override con spring fluido.

```tsx
import { SalesAnalyticsChart } from "@/components/charts/SalesAnalyticsChart";
import { formatCOP } from "@/lib/utils";

<SalesAnalyticsChart
  title="Ventas diarias"
  scopeLabel="Ventas"
  rangeLabel="10–16 abr 2026"
  autoTour
  tourInterval={2.4}
  format={formatCOP}
  data={[
    { label: '10 abr', value: 1820, amount: 2120 },
    { label: '11 abr', value: 2950, amount: 3210 },
    // ...
  ]}
/>
```

---

## 10. Top Products heatmap — `<TopProductsHeatmap />`

Stagger por VALOR: las celdas saturadas aparecen primero.

```tsx
<TopProductsHeatmap
  title="Actividad por categoría"
  scopeLabel="Esta semana"
  rows={['Bebidas', 'Mercado', 'Aseo', 'Lácteos']}
  cols={['Lun','Mar','Mié','Jue','Vie','Sáb','Dom']}
  matrix={[
    [0.9, 0.7, 0.85, 0.6, 0.95, 0.3, 0.1],
    // ...
  ]}
/>
```

---

## 11. Budget bars — `<BudgetBar />`

```tsx
<BudgetBar label="Nómina" current={4_200_000} max={6_000_000} index={0} format={formatCOP} />
<BudgetBar label="Inventario" current={1_800_000} max={3_000_000} index={1} format={formatCOP} />
```

---

## 12. Hover lift en KPI cards — `<KpiCard />`

```tsx
import { KpiCard } from "@/components/ui/kpi-card";

<KpiCard interactive className="p-6">
  <p className="text-xs uppercase tracking-widest text-[var(--text-muted)]">Ingresos</p>
  <RollingDigits value={48295} format={formatCOP} className="text-3xl font-medium" />
</KpiCard>
```

`interactive` activa también el spotlight (#13).

---

## 13. Spotlight cursor en `<Card interactive />`

```tsx
import { Card, CardContent } from "@/components/ui/card";

<Card interactive>
  <CardContent>
    {/* Aquí el spotlight verde sigue al cursor */}
  </CardContent>
</Card>
```

CSS en `src/app/globals.css` → `.card-spotlight::after`.

---

## 14-18. Componentes Radix con `data-state` animations

**Ya están listos en el repo**: `dialog`, `alert-dialog`, `dropdown-menu`,
`menubar`, `popover`, `select`, `sheet`, `tooltip`, `toast` y `accordion`
usan clases de `tailwindcss-animate` (`animate-in`, `fade-in-0`, `zoom-in-95`,
`slide-in-from-*`, `data-state=open|closed`).

No requieren cambios. Solo úsalos:

```tsx
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";

<Dialog>
  <DialogTrigger asChild><Button>Abrir</Button></DialogTrigger>
  <DialogContent>Contenido animado</DialogContent>
</Dialog>
```

---

## 19-21. AnimatedSidebar (opcional)

`<AnimatedSidebar />` es una **alternativa** plug-and-play al `AppSidebar`
existente. NO sustituye al actual; es para dashboards o sub-apps donde
quieras la magia de `layoutId`.

```tsx
import { AnimatedSidebar } from "@/components/animated/AnimatedSidebar";
import { LayoutDashboard, ShoppingCart, Package } from "lucide-react";

<AnimatedSidebar
  items={[
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/sales/new", label: "Venta",     icon: ShoppingCart },
    { href: "/inventory", label: "Inventario", icon: Package },
  ]}
/>
```

- **#19 Collapse spring**: width 68 ↔ 256 con `SPRING_SOFT`.
- **#20 Active indicator**: `layoutId="animated-sidebar-active"` se desliza entre items.
- **#21 Items stagger**: `staggerChildren: 0.05, delayChildren: 0.1`.

---

## 23. Theme toggle pill iOS — `<ThemeTogglePill />`

```tsx
import { ThemeTogglePill } from "@/components/theme-toggle-pill";

<header>
  <ThemeTogglePill />
</header>
```

Coexiste con el `<ThemeToggle />` segmented que ya tienes en el header. Usa
el que prefieras según contexto.

---

## 24/28. Notification dot — `<NotificationDot />`

```tsx
import { Bell } from "lucide-react";
import { NotificationDot } from "@/components/ui/notification-dot";

<button className="relative">
  <Bell className="h-5 w-5" />
  <span className="absolute -top-1 -right-1">
    <NotificationDot tone="accent" ping />
  </span>
</button>
```

---

## 25. AuthShell curtains

```tsx
"use client";
import { useRouter } from "next/navigation";
import { AuthShell, useAuthShell } from "@/components/layout/AuthShell";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const shell = useAuthShell();
  const router = useRouter();
  const { login } = useAuth();

  const onSubmit = async (values) => {
    await login(values);
    shell.close();                // ← dispara cortinas
  };

  return (
    <AuthShell
      splash={<MarketingPanel />}
      closing={shell.closing}
      onClosed={() => router.replace("/dashboard")}
    >
      <LoginForm onSubmit={onSubmit} />
    </AuthShell>
  );
}
```

> En el repo, `src/app/login/page.tsx` actualmente NO usa `AuthShell`. Si
> quieres que el login arranque con cortinas, refactorízalo siguiendo el ejemplo
> anterior. La integración es opcional.

---

## 26. Table row stagger — `<MotionTableRow />`

```tsx
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { MotionTableRow } from "@/components/ui/animated-table";

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Producto</TableHead>
      <TableHead>Stock</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    {items.map((row, i) => (
      <MotionTableRow key={row.id} index={i}>
        <TableCell>{row.name}</TableCell>
        <TableCell>{row.stock}</TableCell>
      </MotionTableRow>
    ))}
  </TableBody>
</Table>
```

---

## 27. ConfirmDialog icon spring

`src/components/ConfirmDialog.tsx` ya recibió la modificación: el icono entra
con `rotate -8°→0°` + `scale 0.8→1` con spring bouncy
(`stiffness:400, damping:14`). No necesitas hacer nada — abrir el modal lo activa.

---

## 28-30. Animaciones CSS globales (Tailwind keyframes)

Disponibles como clases utility:

| Clase                    | Uso                                  |
|--------------------------|--------------------------------------|
| `animate-fade-in`        | Toasts, dropdowns                    |
| `animate-slide-up`       | Modal entry legacy                   |
| `animate-shimmer`        | `.skeleton`                          |
| `animate-pulse-glow`     | Logo brand dot                       |
| `animate-float`          | Blobs decorativos                    |
| `animate-aurora`         | Heros con glow móvil                 |
| `animate-gradient-x`     | `.text-gradient-animated`, hero card |
| `animate-marquee`        | Tickers de logos (futuro)            |
| `animate-spotlight`      | Hero spots (futuro)                  |
| `animate-bounce-in`      | Badges importantes                   |

```tsx
<span className="inline-block h-3 w-3 rounded-full bg-[var(--accent)] animate-pulse-glow" />

<h1 className="text-gradient-animated text-5xl font-medium tracking-tighter">
  POS PRO
</h1>

<div className="bg-aurora rounded-3xl p-12">...</div>
```

---

## 31. Theme cross-fade global

`src/app/globals.css` ya añade:

```css
body {
  transition:
    background-color 280ms cubic-bezier(0.16, 1, 0.3, 1),
    color           280ms cubic-bezier(0.16, 1, 0.3, 1);
}
*, *::before, *::after {
  transition-property: background-color, border-color, color, fill, stroke, box-shadow;
  transition-duration: 240ms;
  transition-timing-function: cubic-bezier(0.16, 1, 0.3, 1);
}
[data-state] {
  transition-property: opacity, transform;  /* respeta data-state propios */
}
```

Cuando el usuario togglea tema (vía `next-themes`) el árbol DOM hace cross-fade
suave automáticamente.

---

## 32. Reduced motion

**Capa 1: CSS global** (`src/app/globals.css`)

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

**Capa 2: Hook React** (`src/components/ui/motion.tsx`)

```tsx
import { useReducedMotionSafe } from "@/components/ui/motion";

function MyComponent() {
  const reduced = useReducedMotionSafe();
  if (reduced) return <Static />;
  return <motion.div ... />;
}
```

Todos los componentes del catálogo respetan ya esta preferencia (charts,
RollingDigits, AuthShell, AnimatedSidebar, ThemeTogglePill, KpiCard, etc.).

---

## Convenciones — easing y duraciones

| Easing            | Bezier / Type                                    | Cuándo usar                                             |
|-------------------|--------------------------------------------------|---------------------------------------------------------|
| **"Quint out"**   | `[0.16, 1, 0.3, 1]`                              | Default. Entradas, fades, count-ups.                    |
| **"Spring soft"** | `{ type:'spring', stiffness:320, damping:32 }`   | Sidebar collapse, layoutId moves.                       |
| **"Spring firm"** | `{ type:'spring', stiffness:500, damping:32 }`   | ThemeToggle pill (movimiento corto y firme).            |
| **"Spring bouncy"**| `{ type:'spring', stiffness:400, damping:14 }`  | Iconos importantes (alert, success).                    |

Duraciones estándar:

- **Micro** 150–200ms — tooltip, hover, focus.
- **Pequeña** 250–350ms — entries, exits, dropdowns.
- **Media** 400–600ms — page transitions, fade-ups.
- **Larga** 1.0–1.6s — count-ups, path drawings, gauges.
- **Loop infinito** 2–18s — pulse-glow, float, gradient-x, aurora.

Disponibles ya en `src/components/ui/motion.tsx` como constantes:
`QUINT_OUT`, `SPRING_SOFT`, `SPRING_FIRM`, `SPRING_BOUNCY`.

---

## Stagger delays recomendados

| Tipo de lista       | `staggerChildren` | `delayChildren` |
|---------------------|-------------------|-----------------|
| Sidebar items       | 0.05              | 0.10            |
| KPI cards (3-4)     | 0.08              | 0.10            |
| Heatmap cells       | 0.02 (por valor)  | 0.00            |
| Table rows          | 0.025 (cap 0.4s)  | 0.00            |
| Lista vertical      | 0.08              | 0.50            |
| MiniBarChart bars   | 0.04              | 0.00            |

---

## Cómo añadir una animación nueva

1. **Si es framer-motion**: usa `motion.div` con variants. Si entra en cascada,
   define la variant aparte y pásala con `<StaggerItem variants={...}>`.
2. **Si es CSS pura** (loop, hover): añade el keyframe en `tailwind.config.ts`
   → mapea a `animation: { 'mi-anim': 'miKeyframe 2s linear infinite' }`
   → úsala como `animate-mi-anim`.
3. **Si es Radix** (Dialog/Sheet/Dropdown): usa `data-[state=*]` con clases de
   `tailwindcss-animate` (`animate-in`, `fade-in-0`, `zoom-in-95`, `slide-in-from-*`).
4. **Siempre** comprueba `useReducedMotionSafe()` para entradas largas o repetitivas.
5. **Easing por defecto**: `[0.16, 1, 0.3, 1]` salvo que necesites spring (movimientos
   físicos) o bouncy (acentos importantes).
6. **`'use client'`** obligatorio en cualquier archivo que importe `framer-motion`.
7. Para color brand usa `var(--accent)`, no hardcodees `#10b981`.

---

## Consideraciones específicas del POS

- **`output: 'export'`** en `next.config.ts`: el sitio se genera estático. Las
  animaciones funcionan igual porque framer-motion corre del lado cliente.
  `MotionPage` usa `usePathname()` que es seguro en static export.
- **HeroUI + shadcn coexisten**: el `<Modal>` de HeroUI (usado en
  `ConfirmDialog`, `UniversalPaymentModal`, login forgot password) tiene sus
  propias animaciones internas. No hace falta envolverlo en framer-motion.
- **`ThemeProvider` ya está montado** en `src/app/providers.tsx` con
  `attribute="class"`. `ThemeTogglePill` usa `useTheme()` directamente — no
  requiere setup adicional.
- **CSS variables del POS**: las animaciones que coloran pulsos, gradients y
  glows usan `var(--accent)` (verde esmeralda) y `var(--accent-soft)`,
  definidas en `globals.css` con valores diferentes para dark/light.

---

## Referencias

- [framer-motion docs](https://motion.dev/)
- [tailwindcss-animate](https://github.com/jamiebuilds/tailwindcss-animate)
- [Radix UI primitives](https://www.radix-ui.com/primitives)
- [next-themes](https://github.com/pacocoursey/next-themes)
