# Enrutamiento de modelos Anthropic

Este documento describe cómo el backend decide qué modelo de Anthropic usar
para cada petición y cómo ajustar la configuración sin recompilar.

**No contiene credenciales.** La `ANTHROPIC_API_KEY` vive sólo en `.env`
y no se documenta aquí ni en ningún otro archivo versionado.

## Por qué existe este enrutamiento

Anthropic cobra por token de entrada + salida. El delta de precio entre
tiers es de ~20x. En vez de usar un solo modelo caro para todo, cada
petición se clasifica y se enruta al modelo más barato que la resuelve
bien. Es la palanca de ahorro más grande de todo el sistema de IA.

Toda la lógica vive en un solo archivo: `internal/core/services/ai_models.go`.

## Clases de petición

| Clase | Cuándo aplica | Modelo por defecto | `max_tokens` |
|---|---|---|---|
| `ClassSimpleChat` | Chat trivial, confirmaciones, FAQ, comandos | Haiku (`fastTierModel`) | 1024 |
| `ClassComplexReport` | Reportes, análisis, desgloses, PDFs | Sonnet (`balancedTierModel`) | 2048 |
| `ClassVision` | Cualquier petición con imagen (OCR de factura, foto) | Haiku (`fastTierModel`) | 4096 |

Opus (`powerfulTierModel`) **no se enruta automáticamente**. Queda
disponible como override manual explícito a través de la variable
`POS_AI_MODEL_POWERFUL` cuando un operador quiera forzarlo para un caso
excepcional.

## Clasificación

`ClassifyRequest(text, hasImage)` decide la clase:

1. `hasImage == true` → `ClassVision` **siempre**. Un caption como
   "hazme un reporte de esta factura" **no cambia la clase**: la imagen
   es la señal fuerte y el modelo de visión es el único que puede
   leerla.
2. Texto que contiene algún token de la lista `complexReportTokens`
   (tokenización por letra Unicode/dígito, acepta tildes) o alguna
   frase de `complexReportPhrases` → `ClassComplexReport`.
3. Cualquier otra cosa → `ClassSimpleChat`.

### Tokens que escalan a `ClassComplexReport`

Reportes / síntesis:
`reporte`, `informe`, `desglose`, `desglosa`, `desglosar`,
`resumen`, `resumir`, `analisis`, `análisis`, `analizar`, `analiza`,
`balance`, `balances`

Finanzas:
`utilidad`, `rentabilidad`, `ganancias`, `perdidas`, `pérdidas`

Entregables:
`pdf`, `exportar`, `gráfica`, `grafica`

Verbos imperativos:
`detalla`, `detallame`, `detállame`, `detallar`, `detallado`, `detallada`

### Frases que escalan

`listado completo`, `detalle completo`, `detalle total`,
`todo el detalle`, `todos los detalles`, `informe completo`,
`reporte completo`.

### Tokens explícitamente excluidos

`todos`, `toda`, `todo`: estos aparecen en frases triviales como
"¿tienes todos los pedidos de hoy?" o "muéstrame todos los proveedores".
Escalarlos arrastraba chat trivial a Sonnet (10x más caro) sin razón.
La regresión está blindada en `TestClassifyRequest` con casos
específicos; no reintroducir sin revisar la discusión original.

## Overrides por variable de entorno

Todas las variables son opcionales. Si no están seteadas (o están en
blanco) aplican los defaults compilados.

### Por tier

| Variable | Default compilado | Rol |
|---|---|---|
| `POS_AI_MODEL_FAST` | `claude-haiku-5-5` | Chat trivial y vision |
| `POS_AI_MODEL_BALANCED` | `claude-sonnet-5-5` | Reportes y análisis |
| `POS_AI_MODEL_POWERFUL` | `claude-opus-5-5` | Reservado para override manual |

### Por uso

| Variable | Precedencia sobre | Rol |
|---|---|---|
| `POS_AI_MODEL_CHAT` | `POS_AI_MODEL_FAST` | Chat trivial del bot |
| `POS_AI_MODEL_REASONING` | `POS_AI_MODEL_BALANCED` | Reportes del bot |
| `POS_AI_MODEL_VISION` | `POS_AI_MODEL_FAST` | OCR de facturas |

La variable de uso tiene precedencia sobre la variable de tier dentro
de su `RequestClass`. Esto permite mover un único uso a otro tier sin
arrastrar los demás. Ejemplos:

- Enviar sólo el chat a Opus (sin tocar vision ni reportes):

  `POS_AI_MODEL_CHAT=claude-opus-5-5`

- Subir todo el tier rápido a Sonnet (chat + vision quedan en Sonnet):

  `POS_AI_MODEL_FAST=claude-sonnet-5-5`

- Dejar vision en Sonnet pero mantener chat en Haiku:

  `POS_AI_MODEL_VISION=claude-sonnet-5-5`

## Verificar los IDs vigentes

Los defaults compilados son los **alias oficiales vigentes** de la generación
5.5. Así usamos la mejor versión costo/calidad de cada familia sin quedar
anclados a un snapshot antiguo. Si una cuenta necesita reproducibilidad
absoluta, puede fijar un snapshot específico mediante variable de entorno sin
cambiar el código.

Antes de actualizar los defaults, validar siempre la lista oficial:

> https://docs.anthropic.com/en/docs/about-claude/models

## Presupuesto de tokens (`MaxTokensFor`)

| Clase | `max_tokens` | Razón |
|---|---|---|
| `ClassSimpleChat` | 1024 | Confirmaciones y respuestas cortas; media pantalla alcanza |
| `ClassComplexReport` | 2048 | Reportes del bot; Sonnet sintetiza bien a esta altura |
| `ClassVision` | 4096 | Facturas con 60+ líneas, impuestos y descuentos |

**No bajar `ClassVision` de 4096 sin medir con una factura larga real.**
Un truncamiento del JSON a mitad de línea rompe el OCR y es muy difícil
de reproducir con facturas chicas de test.

## Dónde se consume

| Caller | Qué hace |
|---|---|
| `ai_bot_service.buildRequest` | Clasifica el último texto del usuario del historial (saltando tool_results) + flag `isImage`, llama a `SelectModel` y `MaxTokensFor`. |
| `product_service.callClaudeVision` | Fija `ClassVision` directamente (la ruta `POST /api/inventory/scan-invoice` siempre maneja imagen). |

Si aparece un nuevo caller, debe pasar por `ClassifyRequest` o declarar
su clase explícitamente. Nunca duplicar la decisión de modelo en los
callers; el único lugar es `ai_models.go`.

## Pruebas

El archivo `internal/core/services/ai_models_test.go` cubre:

- `ClassifyRequest` con decenas de frases reales del dominio del POS,
  incluyendo los casos límite "todos los X" (NO escala), imagen con
  caption "reporte" (conserva Vision), "detalla" verbo, frases
  multi-token, mayúsculas y puntuación.
- `SelectModel` con defaults compilados, overrides por tier, overrides
  por uso, precedencia uso > tier, env vacío/espacios tratado como no
  seteado, clase desconocida con fallback.
- `MaxTokensFor` por clase.
- Helpers legacy (`FastTier`, `BalancedTier`, `PowerfulTier`,
  `VisionModel`, `ChatModel`, `ReasoningModel`, `FastModel`) respetando
  env.
- Garantía: Opus **no** se enruta automáticamente desde ninguna
  `RequestClass`.

Correr sólo los tests de este paquete:

```powershell
go test ./internal/core/services/... -run 'TestClassifyRequest|TestSelectModel|TestMaxTokensFor|TestLegacyHelpers|TestPowerfulTier|TestDefaultsCompilados'
```

## No hacer

- No duplicar la decisión de modelo en servicios/handlers nuevos; usar
  siempre `ClassifyRequest` + `SelectModel`.
- No reintroducir heurísticas por substring sin frontera de palabra
  (p.ej. `strings.Contains(msg, "todos")`); provoca falsos positivos
  caros.
- No hardcodear `max_tokens` fuera de `MaxTokensFor`.
- No leer ni copiar `.env`. La `ANTHROPIC_API_KEY` sólo se lee a través
  de `os.Getenv` en los puntos de llamada a Anthropic.
