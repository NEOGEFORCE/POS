# POS_MEMORY

## Último Sprint (Reparación UI Global + Lógica Transaccional Avanzada)
- **Reparación Visual Global (Modo Oscuro)**: Se inyectó CSS global (`globals.css`) para forzar que todos los campos de entrada (`input`, `textarea`, `select`) en modo oscuro tengan un fondo `#121214` (Gris ultra oscuro) y bordes visibles con transparencias. Esto asegura legibilidad y contraste en todo el sistema.
- **Limpieza de Reportes**: Se reparó el componente `ClosuresHistory.tsx` para corregir colores blanco sobre blanco, asegurando que los logos, fondos y textos en modo claro y oscuro sean siempre legibles (usando `dark:invert` en logos oscuros).
- **UX de Ventas (Orden y Foco Avanzado)**: En `useNewSale.ts`, se modificó la lógica para que el último producto escaneado SIEMPRE se añada al final de la lista. Además, se forzó el `auto-focus` (`input.focus()` + `input.select()`) mediante un timeout seguro de React en el input de cantidad del ítem recién insertado en `page.tsx`.
- **Lógica Multipago en Caja Restringida**: Se eliminó el "Auto-completado" engañoso de `UniversalPaymentModal.tsx`. Ahora el usuario está obligado a digitar y añadir los montos parciales usando los botones, y el botón de "Procesar/Confirmar" permanecerá completamente bloqueado si la suma matemática de los pagos en Efectivo + Nequi + Daviplata + Fiado NO cubre exactamente el monto total o restante.
- **Arquitectura de Envío Go (Multipago)**: Se verificó que la aplicación Front envíe el desglose explícito de cada método (`cashAmount`, `transferNequi`, `transferDaviplata`, `creditAmount`) y que el servicio de backend en Go (`sale_service.go`) registre este desglose exacto en las columnas correspondientes de la base de datos sin pérdida de datos.

## Sprint Anterior (Inteligencia Transaccional y Flexibilidad)
- **Integración final: Respaldo DB blindado y Rediseño Visual SaaS Premium (0% verde neón, 100% corporativo)**
- **Corrección de pg_dump, limpieza visual completada y Script de compilación (build_prod.bat) creado para paso a producción.**
- **Arquitectura PWA y Contingencia Extrema implementada (Caché de catálogo, ventas offline en celular y auto-sincronización tras apagón de servidor)**: Se integró `next-pwa` para el manifest y service worker. Se creó `offlineStore.ts` usando IndexedDB (`idb`) con almacenes `catalog_cache` y `pending_sales`.
- Refactorización UI Global (Dark/Light mode, diseño de tarjetas): Se estandarizó el sistema de temas CSS con variables `zinc-950` (bg) / `zinc-900` (cards) para oscuro y `gray-50` (bg) / `white` (cards) para claro. Border radius global elevado a `0.75rem` (2xl). Eliminado `backdrop-blur` de todos los componentes excepto `ScannerOverlay`. Transiciones globales `transition-all duration-300 ease-in-out` aplicadas a body e interactivos.
- Sistema de Notificaciones Enriquecido (Lectura real de errores 400/422 y alertas SSE): Creado `error-utils.ts` con `extractErrorMessage()` y `extractFetchError()` que parsean errores estándar, mapas 422 Factus/DIAN, y dan fallbacks por código HTTP. `GlobalSyncProvider` ahora muestra toasts informativos no intrusivos cuando llegan eventos SSE (`INVENTORY_UPDATE`, `NEW_SALE`, etc.) con debounce de 5s para evitar spam.

## Módulos Implementados (MEGA-SPRINT anterior)
- **Módulo de Mermas y Averías (Shrinkage)**:
  - Backend: Modelo `Shrinkage` creado e integrado en las migraciones. Endpoint `POST /api/inventory/shrinkage` en `product_handler.go` añadido con registro de pérdida operativa.
  - Frontend: Vista en `/inventory/shrinkage` con Next.js y Shadcn UI, integración con `ScannerOverlay` para escaneo de productos y tabla de historial diario de mermas.
- **Mapeo Estricto Factus (DIAN)**:
  - Backend: Implementado `factus_service.go` (`PrepareBillPayload`) con las reglas de negocio DIAN (payment_form, payment_methods, tributos, customer y unit measures). Añadido el campo `dian_ready` al modelo `Sale`.

## Archivos Clave Modificados (Sprint UI)
- `globals.css`: Variables CSS dark/light refactorizadas, backdrop-blur eliminado de input wrappers
- `tailwind.config.ts`: `--radius: 0.75rem`
- `card.tsx`: `rounded-2xl`, `transition-all duration-300`
- `dialog.tsx`: `rounded-2xl`
- `toast.tsx`: Fondos sólidos opacos, `rounded-2xl`
- `app-header.tsx`: Fondo sólido en barra de info
- `app-sidebar.tsx`: Fondo sólido, sin backdrop-blur
- `ConfirmDialog.tsx`: Fondos sólidos en header/footer
- `GlobalSyncProvider.tsx`: Toasts SSE con debounce
- `error-utils.ts`: Utilidad centralizada de extracción de errores
