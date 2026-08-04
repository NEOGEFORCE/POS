# 🚨 DIRECTIVA NUCLEAR DE ARQUITECTURA VISUAL (POS) 🚨
**ACTUALIZADO: Junio 2026**

## CONTEXTO
Este documento contiene las **reglas inquebrantables de diseño y layout** para el frontend del sistema POS. El propósito de este archivo es **prohibir a cualquier IA (incluyéndome) o desarrollador** modificar la arquitectura de Scroll y Flexbox que fue lograda con sangre, sudor y lágrimas.

**NUNCA se debe alterar la cadena elástica de scroll.** Si se hace, el contenido se cortará en pantallas pequeñas o teléfonos móviles y el scroll dejará de funcionar.

---

## REGLA DE ORO: LA CADENA DE "EFECTO RESORTE" (FLEX-1 MIN-H-0)

Para que las tablas y cuadrículas respeten la barra inferior del navegador y activen su propia barra de scroll (sin desbordarse hacia el infinito), la arquitectura **siempre** debe mantener esta secuencia exacta tipo "Muñeca Rusa":

### 1. Nivel Raíz Global (`src/app/globals.css`)
```css
html, body {
  height: 100vh;
  /* 
   PROHIBIDO TOCAR: El body jamás debe scrollear por sí solo en desktop, 
   las vistas internas manejan su propio scroll elástico.
  */
  overflow: hidden !important; 
}
```

### 2. Nivel Layout Principal (`src/app/(app)/layout.tsx`)
```tsx
// El contenedor máximo DEBE usar min-h-[100dvh] en móviles para evitar que 
// la barra de direcciones de Safari/Chrome tape el final de la pantalla.
<div className="flex min-h-[100dvh] md:h-screen w-screen overflow-x-hidden">
  <Sidebar />
  <SidebarInset className="max-w-[100vw] min-w-0 w-full flex-1 md:h-full flex flex-col relative overflow-hidden">
    <main className="flex-1 min-h-0 md:h-full overflow-y-auto custom-scrollbar flex flex-col relative z-10 p-0 pb-6">
      {children}
    </main>
  </SidebarInset>
</div>
```

### 3. Nivel Página (`page.tsx` de cada módulo)
```tsx
// Ejemplo: products/page.tsx
<div className="flex flex-col flex-1 min-h-0 h-full w-full max-w-[1600px] mx-auto overflow-y-auto md:overflow-hidden relative">
  {/* Header */}
  <div className="shrink-0">...</div>
  
  {/* Envoltura interna que llama a la tabla */}
  <div className="flex flex-col flex-1 min-h-0 overflow-y-auto md:overflow-hidden custom-scrollbar">
    <Tabla />
  </div>
</div>
```

### 4. Nivel Componente Tabla (`*Table.tsx`)
```tsx
// Ejemplo: ProductTable.tsx, CustomerTable.tsx, etc.
<div className="flex-1 min-h-0 h-full w-full bg-white border rounded-2xl overflow-hidden flex flex-col">
  {/* LA ENVOLTURA INVISIBLE VITAL */}
  <div className="flex flex-col flex-1 min-h-0 min-w-0 h-full w-full relative">
    {!isMobile ? (
      {/* EL CONTENEDOR DEL SCROLL DE LA TABLA */}
      {/* PROHIBIDO USAR "overflow-x-auto" SOLO. Siempre usar "overflow-auto overscroll-contain" */}
      <div className="overflow-auto overscroll-contain custom-scrollbar w-full flex-1 min-h-0 h-full">
        <Table>...</Table>
      </div>
    ) : (
      {/* Vista Móvil */}
      <div className="flex-1 min-h-0 h-full w-full flex items-center">...</div>
    )}
  </div>
</div>
```

---

## 🚫 LÍNEAS ROJAS ABSOLUTAS (LO QUE NUNCA DEBES HACER)
1. **NUNCA quitar `min-h-0` de un contenedor `flex-1` interno.** Si se quita, el flexbox asume `min-height: auto` y el contenedor se estirará infinitamente, ocultando la barra de scroll y cortando los datos.
2. **NUNCA usar solo `overflow-x-auto` en el contenedor de las tablas.** Esto desactiva por completo el scroll vertical, generando recortes letales en tablas como Categorías o Auditoría. SIEMPRE usar `overflow-auto`.
3. **NUNCA forzar un `height: 100vh` en el `layout.tsx` para móviles.** Siempre debe ser `min-h-[100dvh]` para lidiar inteligentemente con las barras dinámicas de los navegadores móviles.
4. **NUNCA agregar un `overflow-hidden` rígido sin acompañarlo de un contenedor interno que tenga `overflow-y-auto`** (a menos que el diseño explícitamente demande ocultar el contenido).

> **Aviso para la IA del futuro:** Al leer este archivo, asumes un juramento inquebrantable de respetar esta arquitectura en cualquier adición o modificación visual futura.
