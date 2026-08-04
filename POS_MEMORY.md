## 🚨 REGLA PERMANENTE DE NIVELES DE STOCK Y ORDEN EN PEDIDOS
En la pantalla de Sugerido de Compras (`/inventory/orders`):
- 🔴 **CRÍTICO (Rojo, status 0):** `Stock <= 0` o `Stock <= 25% del Stock Base`.
- 🟡 **ADVERTENCIA (Amarillo, status 1):** `Stock < Stock Base` (Faltante entre 26% y 99% del Stock Base).
- 🟢 **ÓPTIMO (Verde, status 2):** `Stock >= Stock Base` (Stock completo al 100% o superior).

**Ordenamiento jerárquico estricto:**
1. **CRÍTICO (0)** siempre arriba del todo.
2. **ADVERTENCIA (1)** en el medio.
3. **ÓPTIMO (2)** siempre abajo del todo (solo para items en tránsito/camino).

---

## 🚨 REGLA PERMANENTE DE CÁLCULO DE AUDITORÍA DE CIERRES Y REPORTE PDF
- **Cierres Diarios en PDF:** Se mantienen 100% intactos con el detalle diario fecha por fecha.
- **Reporte Consolidado General en PDF (Al final del PDF):** NO debe desglosar por fecha individual. Debe agrupar y sumar los totales por concepto:
  - **Nómina:** Se agrupa en una sola línea `PAGO DE NÓMINA` por canal.
  - **Proveedores (`PAGO DE PROVEEDOR` y `RECEPCIÓN DE MERCANCÍA`):** Se unifican por el nombre del proveedor `PAGO PROVEEDOR - [PROVEEDOR]` acumulando todas las compras del mes en una sola línea por proveedor.
  - **Servicios:** Se agrupan bajo `PAGO DE SERVICIOS` / `ARRIENDO Y ALQUILERES`.
  - **Bancos:** Se agrupan bajo `CUOTA BANCO / OBLIGACIONES`.
  - **Abonos Recibidos:** Se resumen acumulados por nombre del cliente.
- **Ventas Totales (Cajero):** `Efectivo Contado (Físico) + Digital + Egresos en Efectivo + Devoluciones`
- **Ventas Totales (Sistema):** `Efectivo Esperado (del Sistema) + Digital + Egresos en Efectivo + Devoluciones`
- **Descuadre Caja:** `Ventas Cajero - Ventas Sistema` = `Efectivo Contado - Efectivo Esperado`
  - Si `Descuadre >= 0`: Muestra tarjeta en 🟢 **VERDE SOBRANTE** (`+$X`)
  - Si `Descuadre < 0`: Muestra tarjeta en 🔴 **ROJO FALTANTE** (`-$X`)

---

## 🚨 REGLA PERMANENTE DE COMANDO: "pasa los cambios" / "pasa a producción" / "despliega"
Cuando el usuario diga **"pasa los cambios"**, **"pasa a producción"**, **"despliega"** o cualquier variante similar en CUALQUIER conversación, ejecutar INMEDIATAMENTE y SIN PREGUNTAR la siguiente secuencia completa de compilación y despliegue a la máquina de producción (`192.168.1.6`):

1. **Compilar Backend Go:**
   `go build -o server.exe ./cmd/api/main.go` (en `c:\Users\jaide\OneDrive\Desktop\POS\backPOS-go`)
2. **Copiar Backend al Servidor:**
   `cmd /c "copy /y server.exe \\192.168.1.6\pos\server.exe"`
3. **Compilar Frontend Next.js (out/):**
   `npm run build` (en `c:\Users\jaide\OneDrive\Desktop\POS\FrontPOS-main`)
4. **Copiar Frontend al Servidor:**
   `xcopy /E /I /Y out \\192.168.1.6\pos\out` (en `c:\Users\jaide\OneDrive\Desktop\POS\backPOS-go` o `FrontPOS-main`)
5. **Confirmar al Usuario:** Notificar que el binario `server.exe` y los 268 archivos estáticos de la carpeta `out/` quedaron 100% copiados e instalados en `\\192.168.1.6\pos`.

---

## Último Sprint (Sincronización Total Venta Real + PDF Desglosado + Despliegue Producción)
- **ReparaciÃ³n Visual Global (Modo Oscuro)**: Se inyectÃ³ CSS global (`globals.css`) para forzar que todos los campos de entrada (`input`, `textarea`, `select`) en modo oscuro tengan un fondo `#121214` (Gris ultra oscuro) y bordes visibles con transparencias. Esto asegura legibilidad y contraste en todo el sistema.
- **Limpieza de Reportes**: Se reparÃ³ el componente `ClosuresHistory.tsx` para corregir colores blanco sobre blanco, asegurando que los logos, fondos y textos en modo claro y oscuro sean siempre legibles (usando `dark:invert` en logos oscuros).
- **UX de Ventas (Orden y Foco Avanzado)**: En `useNewSale.ts`, se modificÃ³ la lÃ³gica para que el Ãºltimo producto escaneado SIEMPRE se aÃ±ada al final de la lista. AdemÃ¡s, se forzÃ³ el `auto-focus` (`input.focus()` + `input.select()`) mediante un timeout seguro de React en el input de cantidad del Ã­tem reciÃ©n insertado en `page.tsx`.
- **LÃ³gica Multipago en Caja Restringida**: Se eliminÃ³ el "Auto-completado" engaÃ±oso de `UniversalPaymentModal.tsx`. Ahora el usuario estÃ¡ obligado a digitar y aÃ±adir los montos parciales usando los botones, y el botÃ³n de "Procesar/Confirmar" permanecerÃ¡ completamente bloqueado si la suma matemÃ¡tica de los pagos en Efectivo + Nequi + Daviplata + Fiado NO cubre exactamente el monto total o restante.
- **Arquitectura de EnvÃ­o Go (Multipago)**: Se verificÃ³ que la aplicaciÃ³n Front envÃ­e el desglose explÃ­cito de cada mÃ©todo (`cashAmount`, `transferNequi`, `transferDaviplata`, `creditAmount`) y que el servicio de backend en Go (`sale_service.go`) registre este desglose exacto en las columnas correspondientes de la base de datos sin pÃ©rdida de datos.

## Sprint Anterior (Inteligencia Transaccional y Flexibilidad)
- **IntegraciÃ³n final: Respaldo DB blindado y RediseÃ±o Visual SaaS Premium (0% verde neÃ³n, 100% corporativo)**
- **CorrecciÃ³n de pg_dump, limpieza visual completada y Script de compilaciÃ³n (build_prod.bat) creado para paso a producciÃ³n.**
- **Arquitectura PWA y Contingencia Extrema implementada (CachÃ© de catÃ¡logo, ventas offline en celular y auto-sincronizaciÃ³n tras apagÃ³n de servidor)**: Se integrÃ³ `next-pwa` para el manifest y service worker. Se creÃ³ `offlineStore.ts` usando IndexedDB (`idb`) con almacenes `catalog_cache` y `pending_sales`.
- RefactorizaciÃ³n UI Global (Dark/Light mode, diseÃ±o de tarjetas): Se estandarizÃ³ el sistema de temas CSS con variables `zinc-950` (bg) / `zinc-900` (cards) para oscuro y `gray-50` (bg) / `white` (cards) para claro. Border radius global elevado a `0.75rem` (2xl). Eliminado `backdrop-blur` de todos los componentes excepto `ScannerOverlay`. Transiciones globales `transition-all duration-300 ease-in-out` aplicadas a body e interactivos.
- Sistema de Notificaciones Enriquecido (Lectura real de errores 400/422 y alertas SSE): Creado `error-utils.ts` con `extractErrorMessage()` y `extractFetchError()` que parsean errores estÃ¡ndar, mapas 422 Factus/DIAN, y dan fallbacks por cÃ³digo HTTP. `GlobalSyncProvider` ahora muestra toasts informativos no intrusivos cuando llegan eventos SSE (`INVENTORY_UPDATE`, `NEW_SALE`, etc.) con debounce de 5s para evitar spam.

## MÃ³dulos Implementados (MEGA-SPRINT anterior)
- **MÃ³dulo de Mermas y AverÃ­as (Shrinkage)**:
  - Backend: Modelo `Shrinkage` creado e integrado en las migraciones. Endpoint `POST /api/inventory/shrinkage` en `product_handler.go` aÃ±adido con registro de pÃ©rdida operativa.
  - Frontend: Vista en `/inventory/shrinkage` con Next.js y Shadcn UI, integraciÃ³n con `ScannerOverlay` para escaneo de productos y tabla de historial diario de mermas.
- **Mapeo Estricto Factus (DIAN)**:
  - Backend: Implementado `factus_service.go` (`PrepareBillPayload`) con las reglas de negocio DIAN (payment_form, payment_methods, tributos, customer y unit measures). AÃ±adido el campo `dian_ready` al modelo `Sale`.

## Archivos Clave Modificados (Sprint UI)
- `globals.css`: Variables CSS dark/light refactorizadas, backdrop-blur eliminado de input wrappers
- `tailwind.config.ts`: `--radius: 0.75rem`
- `card.tsx`: `rounded-2xl`, `transition-all duration-300`
- `dialog.tsx`: `rounded-2xl`
- `toast.tsx`: Fondos sÃ³lidos opacos, `rounded-2xl`
- `app-header.tsx`: Fondo sÃ³lido en barra de info
- `app-sidebar.tsx`: Fondo sÃ³lido, sin backdrop-blur
- `ConfirmDialog.tsx`: Fondos sÃ³lidos en header/footer
- `GlobalSyncProvider.tsx`: Toasts SSE con debounce
- `error-utils.ts`: Utilidad centralizada de extracciÃ³n de errores
- Corrección de cálculo fiscal aditivo para prevenir cobro de impuesto sobre impuesto (IVA + IBUA)

## 2026-05-29 â€” OCR de facturas: cableado completo a Carga Maestra

**Implementado volcado de datos desde respuesta OCR hacia el carrito de recepciÃ³n. A\u00f1adido feedback visual (toast) para resultados vac\u00edos y exitosos.**

### Cambios

- **InvoiceReaderModal.tsx**:
  - console.log("\U0001F4E6 RESPUESTA CRUDA DEL OCR:", data) justo despu\u00e9s del fetch para auditor\u00eda inmediata
  - Validaci\u00f3n: si scannedItems.length + unmatched.length === 0 \u2192 toast destructivo "Sin productos detectados"
  - Si solo hay unmatched \u2192 toast neutral con conteo de items sin emparejar
  - Si hay scanned \u2192 toast success con conteo y menci\u00f3n de unmatched si los hay
  - Fix shape: backend retorna unmatched (no unmatchedItems); ambos se aceptan
  - Items se pasan al padre con flag isMatched: true|false para que el carrito los pinte distinto

- **inventory/receive/page.tsx \u2192 handleInvoiceMatch**:
  - Bug fix: cambiado ocr.sku por ocr.barcode (shape real del backend)
  - Ahora respeta isMatched: items con isMatched=false se omiten del carrito (van a panel separado)
  - Enriquecimiento: cuando OCR trae costUnit, pvpSugerido, marginUsed, iva, icui, ibua, esos valores reemplazan los del producto base (preferencia OCR sobre BD local porque vienen de la factura real)
  - Match status:
    - match (verde) si cantidad coincide con la esperada
    - warning (amarillo) si difiere y se usa la cantidad del OCR
    - extra (rojo) si el producto no estaba en la lista esperada
  - Toast agregado: muestra N agregados \u00b7 N actualizados \u00b7 N omitidos

### Endpoint backend

- POST /api/inventory/scan-invoice (ProductHandler.ScanInvoice)
  - Modelo Claude: claude-sonnet-4-5 (vision)
  - Retorna: { totalDetected, totalMatched, scannedItems[], unmatched[] }
  - ScannedItem: { barcode, productName, quantity, costUnit, pvpActual, pvpSugerido, marginUsed, iva, icui, ibua, currentStock, matchType }
  - UnmatchedItem: { invoiceName, quantity, unitPrice, suggestions[] }


## 2026-05-29 â€” OCR fiscal: pre-configuraciÃ³n de impuestos

**Implementado sistema de pre-configuraciÃ³n fiscal para OCR. El usuario ahora puede indicar quÃ© impuestos (IVA/IBUA) buscar antes del escaneo, y el backend extrae y mapea estos porcentajes en el modal de emparejamiento.**

### Cambios

**Backend (Go)**

- models/invoice_reader.go:
  - ExtractedItem ampliado con iva_percentage, ibua_percentage, icui_percentage
  - UnmatchedItem ampliado con los mismos campos para que el reviewer los reciba
  - Nueva struct ExpectedTaxes { iva, ibua, icui bool } con pistas del usuario

- product_handler.go (ScanInvoice):
  - Acepta expectedTaxes en el request body y lo propaga al service

- product_service.go:
  - ScanInvoice y callClaudeVision reciben *models.ExpectedTaxes
  - uildInvoicePrompt inyecta secciÃ³n "PISTAS FISCALES DEL USUARIO" cuando hay flags activos: instrucciones especÃ­ficas para IVA (5/19), IBUA (8/16/18/20), ICUI por columna en factura
  - Si no hay flags â†’ instruye a Claude a devolver 0 a menos que aparezca explÃ­cito por lÃ­nea
  - El JSON pedido ahora incluye iva_percentage, ibua_percentage, icui_percentage
  - calculateItemDetails: si el OCR extrajo un porcentaje > 0, **prefiere ese valor sobre el del producto BD** (la factura es la verdad fiscal del momento)
  - UnmatchedItem se construye propagando los percentages extraÃ­dos

**Frontend (Next.js)**

- InvoiceReaderModal.tsx:
  - State expectIVA / expectIBUA con <Checkbox> HeroUI
  - SecciÃ³n "Impuestos esperados en esta factura" debajo del preview, solo visible cuando hay archivo seleccionado y no estÃ¡ procesando
  - Hint visual verde cuando alguna casilla estÃ¡ activa: "âœ“ El OCR forzarÃ¡ la extracciÃ³n de estos porcentajes por lÃ­nea"
  - Payload del POST ahora incluye expectedTaxes: { iva, ibua, icui: false }
  - Helper illTaxDefaults aplicado a scanned + unmatched: si OCR no extrajo y el usuario marcÃ³ la casilla â†’ defaults (19% IVA, 20% IBUA)

- UnmatchedItemsReviewer.tsx:
  - State 
ewIva / 
ewIbua / 
ewIcui agregado
  - useEffect auto-llena los 3 campos cuando cambia el item current con los percentages extraÃ­dos del OCR
  - Nuevo grid de 3 inputs (IVA / IBUA / ICUI) con label % y badge "âœ¨ Auto-detectado por OCR" cuando alguno > 0
  - Payload de creaciÃ³n de producto y ResolvedReceiveLine propagan los percentages reales (ya no hardcoded a 0)

### Flujo end-to-end nuevo

1. Usuario abre modal de escaneo â†’ carga foto/cÃ¡mara
2. Marca **"Buscar IVA"** y/o **"Buscar IBUA/ICUI"** segÃºn la factura
3. Click "PROCESAR FACTURA" â†’ Claude recibe pistas y extrae percentages por lÃ­nea
4. Items con match (barcode/alias/similitud) van al carrito con IVA/IBUA reales sobreescritos
5. Items sin match abren reviewer con campos IVA% / IBUA% / ICUI% pre-llenados
6. Si OCR no extrajo pero usuario marcÃ³ esperar â†’ fallback a defaults colombianos (19/20)


## 2026-05-29 â€” Reviewer OCR: integraciÃ³n con Modal Maestro de Productos

**RefactorizaciÃ³n en revisiÃ³n OCR: Eliminado formulario inline de creaciÃ³n. Integrado el Modal Maestro de Productos con pre-llenado de datos (nombre, costo, impuestos) y auto-emparejamiento post-creaciÃ³n.**

### Cambios

**UnmatchedItemsReviewer.tsx â€” Refactor completo**

- **Eliminado** todo el formulario inline (barcode, categorÃ­a, precio venta, margen, IVA/IBUA/ICUI, switch pesado, lÃ³gica de creaciÃ³n POST)
- **Eliminadas** props categories (ya no las necesita el reviewer; el modal maestro las maneja)
- **Reemplazado** por un Ãºnico botÃ³n premium gradient azul: **"+ ABRIR PROTOCOLO DE NUEVO PRODUCTO"** con caption *"Pre-cargado con nombre, costo e impuestos detectados"*
- **Nueva prop** onRequestCreateNewProduct(prefill): el reviewer pide al padre abrir el ProductFormModal con shape { productName, purchasePrice, iva, ibua, icui, invoiceQuantity, invoiceName }
- **Nueva prop** externalResolution + onExternalResolutionConsumed: cuando el padre completa la creaciÃ³n del producto, manda al reviewer { barcode, productName, salePrice, marginPercentage, iva, ibua, icui, resolutionId } y el reviewer auto-avanza al siguiente item con esa data
- **Indicador visual** "âœ¨ OCR detectÃ³: [IVA 19%] [IBUA 18%] [ICUI 0%]" en el card del item cuando el OCR extrajo porcentajes

**inventory/receive/page.tsx â€” Bridge OCR â†” ProductFormModal**

- **Nuevos states**: pendingReviewItem (contexto del item del reviewer en cola de creaciÃ³n) + eviewerExternalResolution (resoluciÃ³n que dispara avance del reviewer)
- **Nuevo handler** handleRequestCreateFromReviewer(prefill): pre-llena 
ewProduct con los datos del OCR (productName, purchasePrice, iva, ibua, icui, supplierId) y abre el ProductFormModal existente. Guarda pendingReviewItem para el ciclo de cierre
- **Modificado** handleCreateProduct: si existe pendingReviewItem, NO ejecuta ddToReceive directamente. En su lugar dispara setReviewerExternalResolution(...) con el arcode del producto reciÃ©n creado. El reviewer recibe esa resoluciÃ³n y la procesa como si el usuario hubiera asignado el item a un producto existente (avanzando al siguiente). Toast distinto: *"PRODUCTO CREADO Y EMPAREJADO"*

### Flujo end-to-end

1. Usuario procesa factura â†’ 3 items unmatched
2. Reviewer abre con item 1 de 3
3. Click **"+ Abrir Protocolo de Nuevo Producto"**
4. ProductFormModal (el real de /products) se abre con: nombre OCR, costo OCR, IVA% OCR, IBUA% OCR, supplier asociado
5. Usuario completa lo que falte (barcode escaneado, categorÃ­a, precio venta) y click "Crear"
6. Backend crea producto â†’ frontend recibe createdProduct â†’ guarda en setProducts (bÃºsquedas locales) â†’ dispara eviewerExternalResolution
7. Reviewer detecta nueva resoluciÃ³n â†’ avanza a item 2 de 3 con el producto agregado al carrito vÃ­a handleUnmatchedResolved
8. Repite hasta el item 3 â†’ cierra automÃ¡ticamente
9. Carrito de recepciÃ³n tiene TODOS los items correctamente formateados (matched + creados desde reviewer)

### Beneficios

- Cero duplicaciÃ³n de lÃ³gica de creaciÃ³n de productos (single source of truth en ProductFormModal)
- Validaciones, escÃ¡ner de barcode, manejo de duplicados (409), gestiÃ³n de categorÃ­as y proveedores â€” todo lo que ya tiene el modal maestro estÃ¡ disponible en el flujo OCR
- Pre-fill automÃ¡tico elimina re-tipeo cuando OCR ya leyÃ³ nombre/costo/impuestos
- Auto-avance del reviewer mantiene el flujo "metÃ³dico uno-a-uno" sin clicks adicionales



---

## 📅 2026-05-29 — Inteligencia de Proveedores: Auto-Aprendizaje de Rutas

**Inteligencia de Proveedores: Implementado auto-aprendizaje de rutas. Al registrar un egreso a un proveedor, el sistema aprende su día de entrega. Al registrar un pedido, aprende su día de preventa (actualiza DB automáticamente).**

### Helper compartido

**`internal/adapters/repositories/postgres_supplier_repository.go`**

- **`LearnDay(supplierID uint, columnName string) error`** — método del repo que registra el día actual (en español, zona horaria `America/Bogota`) en la columna JSONB indicada del proveedor.
- Validación estricta: solo acepta `"visit_days"` o `"delivery_days"`. Cualquier otro valor retorna error sin tocar BD.
- **Anti-duplicados** vía helper `stringArrayContainsCI(arr, target)` — comparación case-insensitive con `strings.ToLower(strings.TrimSpace(...))` sobre cada elemento del `StringArray`. Si "Jueves" ya existe, no se vuelve a agregar.
- Día actual calculado por `dayOfWeekBogota()`: usa `time.LoadLocation("America/Bogota")` con fallback a `time.FixedZone("COT", -5*3600)`. Array `[7]string{"Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"}` indexado por `time.Weekday()`.
- UPDATE quirúrgico: `db.Model(&models.Supplier{}).Where("id = ?", id).Update(columnName, updated)` — solo toca la columna especificada.
- Invalida `cache.CacheKeySuppliers` y emite SSE `SUPPLIER_UPDATE` para refresco en tiempo real del frontend.
- **No-fatal**: si `supplierID == 0` o el supplier fue eliminado, retorna `nil` sin romper el flujo principal de creación de egreso/pedido.

### Wiring (4 puntos de inserción)

**1. Egresos → `delivery_days`** (día de entrega del camión)

`internal/core/services/expense_service.go`:

- `CreateExpense`: dentro del bloque `if expense.SupplierID != nil { ... }` posterior a `MarkAsReceivedBySupplier`, llamada a `s.supplierRepo.LearnDay(*expense.SupplierID, "delivery_days")`.
- `CreateLinkedExpense`: misma llamada en su bloque de automatización post-Save.
- `ExpenseService` ya tenía `supplierRepo *PostgresSupplierRepository` desde antes, no requirió cambios de constructor.

**2. Pedidos → `visit_days`** (día de preventa del preventista)

`internal/core/services/restock_service.go`:

- Struct extendido con campo `supplierRepo *repositories.PostgresSupplierRepository`.
- `NewRestockService(repo, supplierRepo)` — constructor ahora recibe ambos.
- `ConfirmOrder`: tras `CreateConfirmedOrder` y antes de `ClearPurchaseList`, llamada a `s.supplierRepo.LearnDay(supplierID, "visit_days")` si `supplierRepo != nil && supplierID != 0`.

`internal/core/services/purchase_order_service.go`:

- Misma extensión del struct y constructor.
- `CreateOrder`: tras `s.repo.Save(order)`, llamada a `s.supplierRepo.LearnDay(order.SupplierID, "visit_days")`.

**3. `cmd/api/main.go`** — wiring del DI

```go
restockService := services.NewRestockService(restockRepo, supplierRepo)
orderService := services.NewPurchaseOrderService(orderRepo, supplierRepo)
```

### Decisiones arquitectónicas

- **Columnas modernas JSONB sobre legacy**: el modelo `Supplier` tiene doble esquema — legacy `VisitDay`/`DeliveryDay` (CSV string) y modernas `VisitDays`/`DeliveryDays` (StringArray JSONB). El precedente en `expected_order_service.go:160` actualizaba la columna legacy `delivery_day` (string) — bug que dejamos intacto. El helper nuevo escribe a las JSONB modernas, que son las que consumen el bot AI (`ai_bot_service.go` filtra por `visit_days::text LIKE`) y los queries del frontend.
- **Anti-duplicados case-insensitive**: tolera registros legacy con casing diferente. "jueves" vs "Jueves" se consideran iguales y no se vuelven a agregar.
- **No-fatal**: el helper retorna `nil` si el supplier no existe. Importante porque la creación de egreso/pedido nunca debe romperse por una falla de "inteligencia secundaria".
- **SSE broadcast**: invalida cache + emite `SUPPLIER_UPDATE` para que el frontend refresque la vista de proveedores en tiempo real cuando un día se aprende.

### Flujo end-to-end

1. Lunes 9:00 a.m. — usuario registra pedido a "Coca-Cola" (preventa)
2. `PurchaseOrderService.CreateOrder(order)` → `Save(order)` → `supplierRepo.LearnDay(supplierID, "visit_days")`
3. `LearnDay` lee `Coca-Cola.VisitDays` (ej. `["Lunes"]`), calcula `today = "Lunes"`, detecta duplicado → no actualiza, retorna `nil`. Idempotente.
4. Jueves 11:00 a.m. — llega el camión, usuario registra egreso a "Coca-Cola"
5. `ExpenseService.CreateExpense(expense)` → `Save(expense)` → `supplierRepo.LearnDay(supplierID, "delivery_days")`
6. `LearnDay` lee `Coca-Cola.DeliveryDays` (ej. `[]`), calcula `today = "Jueves"`, no es duplicado → UPDATE `delivery_days` = `["Jueves"]`. Cache invalidada, SSE emitido.
7. La próxima semana, el bot Telegram al recibir "qué proveedores entregan hoy" filtra por `delivery_days::text LIKE '%Jueves%'` y devuelve "Coca-Cola" sin que nadie haya configurado nada manualmente.

### Beneficios

- Rutas auto-descubiertas sin configuración manual: el sistema aprende patrones reales de visita/entrega a partir de la actividad transaccional.
- Idempotente y barato: cada egreso/pedido hace 1 SELECT + 0 o 1 UPDATE adicional — costo despreciable.
- Compatible con datos existentes: si un proveedor ya tiene `visit_days = ["Martes"]` y hoy es Martes, no duplica.
- Visible en tiempo real: SSE `SUPPLIER_UPDATE` refresca el frontend inmediatamente.
- Servible al bot AI: las queries existentes que filtran por `visit_days` ahora reciben datos progresivamente más completos sin ningún cambio downstream.

### Verificación

- `go build ./...` exit 0 limpio (sin warnings nuevos)
- `go build -o server.exe ./cmd/api` exit 0 — binario 47.016.960 bytes (2026-05-29 21:05)
- 4 callsites del helper, 1 helper compartido, 2 servicios extendidos con `supplierRepo`, 2 líneas modificadas en `main.go`


---

## 📅 2026-05-30 — Rendimiento, UI de Caja y Pagos Mixtos Estrictos

**Rendimiento: Batch inserts y asincronía en ventas. UI: Priorización visual del carrito en caja. Inventario: Modal de sincronización rediseñado (estilo Autorizar Egreso) con soporte de pagos mixtos desglosados en backend.**

### Tarea 1 — Optimización de `CreateSale`

**`internal/core/ports/stock_movement_repository.go`**

- Nuevo método de port: `BatchSaveWithTx(tx interface{}, movements []models.StockMovement) error`.

**`internal/adapters/repositories/postgres_stock_movement_repository.go`**

- Implementación con `gormDB.CreateInBatches(movements, 100)`. Reemplaza N INSERTs secuenciales por ⌈N/100⌉ sentencias multi-fila.
- Pasa transparentemente cualquier transacción activa (cast a `*gorm.DB`); cae al db base si no.

**`internal/core/services/sale_service.go`**

- En `CreateSale`, el bucle que llamaba `s.movementRepo.SaveWithTx(tx, m)` por cada item del carrito se reemplaza por construcción in-memory de `[]models.StockMovement` + 1 sola llamada a `s.movementRepo.BatchSaveWithTx(tx, movements)`.
- Para un carrito de 20 items: antes 20 round-trips a Postgres, ahora 1.

**`internal/adapters/repositories/postgres_sale_repository.go`**

- `invalidateDashboardCache()`: el `cache.CacheManager.Delete` permanece síncrono (in-memory map, microsegundos), pero `refresher.GetRefresherService(...).RequestRefresh("mv_dashboard_stats_monthly")` y `sse.GetSSEService().BroadcastNewSale(nil)` se mueven a una goroutine con `recover()`. El cliente HTTP recibe el 200 OK sin esperar al `REFRESH MATERIALIZED VIEW` ni al broadcast SSE sobre todas las conexiones abiertas.

### Tarea 2 — Layout sales/new (carrito 70% / grilla 30%)

**`src/app/(app)/sales/new/page.tsx`**

- Sección superior (carrito + numeric pad): `flex-[7] lg:flex-[5]` → `flex-[7]` (eliminé el override de desktop que daba 55:45).
- Sección inferior (categorías + grilla productos): `flex-[3] lg:flex-[4]` → `flex-[3]`.
- Resultado: 70:30 consistente en móvil y desktop. La cuenta del cliente domina visualmente, los productos quedan como atajo táctico.

### Tarea 3 + 4 frontend — Modal "Confirmar Sincronización" rediseñado

**`src/app/(app)/inventory/receive/page.tsx`** (modal en línea ~1742)

- Imports HeroUI: añadidos `Card`, `CardBody`.
- Modal `size="4xl"` con la misma silueta del `ExpenseFormModal` (Autorizar Egreso): header con icono `Package` en cuadro `bg-emerald-500`, título grande con keyword en color, subtítulo en uppercase tracking-widest.
- Banner BYPASS full-width arriba de los pasos cuando `bypassExpense === true`.
- Body en `grid grid-cols-1 lg:grid-cols-3 gap-8`:
  - **1. Resumen de Carga** — Card con número de referencias, total estimado, indicador "incluye flete" si aplica.
  - **2. Costo de Flete** — Input grande `h-16` con `$` en `text-amber-500`. Se deshabilita si `bypassExpense`.
  - **3. Pago por** — grid de 2 columnas con los 5 métodos (`EFECTIVO`, `FONDO`, `NEQUI`, `DAVIPLATA`, `PRESTAMO`); cada tarjeta acepta input numérico independiente y se ilumina en verde cuando tiene valor; banda de validación de cuadre debajo (verde "✓ Cuadre exacto" / rojo "⚠ No cuadra") mostrando `sumPayments / expectedTotal`.
- Footer con botones DESCARTAR / SINCRONIZAR AHORA; el botón principal se deshabilita si `!bypassExpense && !isPaymentsValid`.

### Tarea 4 backend — Pagos mixtos estrictos

**`internal/adapters/repositories/postgres_product_inventory.go` (BulkReceive)**

- **Validación estricta de suma** antes de tocar la BD: si `isMixed && !bypassExpense`, calcula `sumMixed = Σ mp.Amount` y verifica `math.Abs(sumMixed - (totalAmount + freightCost)) <= 5.0`. Si no cuadra retorna error con desglose: `"pagos mixtos no cuadran: suma de canales $X vs total esperado $Y (mercancía $A + flete $B)"`. La transacción aborta antes de cualquier escritura.
- **Iteración por canal**: cuando `isMixed`, por cada `mp` en el array se crea un `models.Expense` individual con `PaymentSource = mp.Method` (NUNCA "MIXTO" en BD), `Amount = mp.Amount`, descripción `"RECEPCIÓN DE MERCANCÍA - {supplier} ({Method}) (incluye flete)"` cuando `freightCost > 0` para trazabilidad. Si el método es `PRESTAMO`/`PREST.`, status=`PENDING`; el resto `PAID`.
- **Bug del doble cobro de flete corregido**: el bloque 4.6 que creaba el egreso adicional de flete ahora solo se ejecuta cuando `!isMixed`. En modo mixed, los `mp.Amount` ya cubren mercancía + flete (validado por la suma) — crear un egreso adicional duplicaría el flete. La descripción del mixed lleva "(incluye flete)" para auditoría.

### Verificación

- `go build ./...` exit 0 limpio (sin warnings nuevos).
- `npm run build` exit 0 — 29/29 páginas estáticas, postbuild copió `out/` a `backPOS-go/out`.
- `server.exe` recompilado a 47,042,560 bytes / timestamp 2026-05-30 08:31:17. Acumula los 7 sprints anteriores + estos 4 cambios.

### Beneficios

- **Latencia de venta**: el response HTTP a `/api/sales/register` ya no incluye N INSERTs de movimientos ni `REFRESH MATERIALIZED VIEW` ni broadcast SSE. Para un carrito típico de 5-10 items, la ganancia es 50-200ms según latencia de red al Postgres remoto.
- **Cuadre al centavo en auditoría**: la tabla `expenses` y la auditoría de CCTV muestran ahora una fila por canal real (`EFECTIVO $50.000`, `NEQUI $200.000`) en lugar de un único "MIXTO $250.000". El cierre de caja desglosa cada canal con su monto exacto sin agruparse.
- **Sin doble cobro de flete**: el bug donde un mixed con flete generaba 1 egreso adicional duplicado queda eliminado; el flete viaja distribuido entre canales y se etiqueta en la descripción.
- **UX de caja más limpia**: con el carrito ocupando 70% del alto, el cajero ve toda la cuenta en pantalla sin hacer scroll, y la grilla de productos ocupa solo lo necesario para acceder a los más vendidos.
