# Pipelines de agentes del POS

Este workspace define agentes especializados en `.kiro/agents/`. Cuando una tarea
abarque varios módulos, reparte el trabajo en un pipeline en vez de hacerlo todo
en una sola sesión.

## Equipo

| Agente | Rol | Escribe en |
|---|---|---|
| `pos-researcher` | Investiga en modo lectura | nada |
| `pos-go-backend` | Implementa y prueba el backend | `backPOS-go/**` |
| `pos-next-frontend` | Implementa y prueba la UI (usa MCP shadcn) | `FrontPOS-main/**` |
| `pos-db-migrations` | Escribe migraciones SQL, no las aplica | `backPOS-go/migrations/**` |
| `pos-reviewer` | Corre build y tests, dictamina | nada |
| `pos-orchestrator` | Descompone y reparte | coordina |

Cambia al orquestador con `/agent pos-orchestrator`.

## Reglas de armado

1. **Paralelizar por módulo.** Backend y frontend son independientes: van en
   paralelo y cada agente es dueño de su implementación *y* de sus tests. El
   antipatrón es un solo implementador secuencial seguido de un tester.
2. **Migraciones primero.** Si el cambio toca el esquema, `pos-db-migrations` no
   depende de nadie y el backend depende de él.
3. **Revisión obligatoria.** Toda etapa de implementación desemboca en
   `pos-reviewer`, con `loop_to` de vuelta a la implementación, trigger
   `NEEDS_CHANGES` y `max_iterations: 3`.
4. **Investigar cuando el alcance sea difuso.** `pos-researcher` al frente y las
   demás etapas dependiendo de él.
5. **No orquestar lo trivial.** Un cambio de un archivo se hace directo.

## Pipeline estándar: feature full-stack

```
pos-db-migrations ──┐
                    ├─→ pos-go-backend ──┐
pos-researcher ─────┘                    ├─→ pos-reviewer ──(NEEDS_CHANGES)──┐
                     pos-next-frontend ──┘                                   │
                              ▲──────────────────────────────────────────────┘
```

## Pipeline de auditoría (solo lectura)

Dos `pos-researcher` en paralelo (uno por proyecto) que confluyen en un
`pos-reviewer` que consolida. Útil para "revisa la seguridad de los endpoints" o
"dónde está la lógica de cuadre de caja".

## Límites que ningún agente cruza sin pedirlo el usuario

- Aplicar migraciones (`go run ./cmd/migrate up`). Solo `migrate status`.
- Desplegar: `desplegar_a_produccion.*`, `robocopy` hacia la ruta UNC, `nssm`.
- Leer o copiar cualquier `.env`.
- Escribir en `\\DESKTOP-VK2U90S\...` o tocar el servicio `POS_Server`.

Estos límites están codificados en `deniedCommands` de cada agente, no solo en
el prompt.

## Memoria

Al abrir una tarea larga, consulta el MCP `memory` para recuperar contexto; al
cerrarla, guarda lo aprendido con `add_observations` sobre la entidad del
proyecto. Nunca guardes secretos ni contenido de `.env`.
