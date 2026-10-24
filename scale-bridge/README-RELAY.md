# scale-bridge — Modo AGENTE (relay)

> Resumen operativo. Para ingenieros que ya conocen el bridge; no es un
> tutorial de cero. El contrato completo (headers, encapsulado, errores)
> vive en el sprint `relay-bridge-01`.

## Qué cambia respecto al bridge "clásico"

- Antes: cada navegador abría directo `ws://<ip-del-pc-de-caja>:9876` sin
  autenticación. No funciona desde un celular en LTE y es inseguro expuesto.
- Ahora: el bridge se conecta como **cliente saliente** al backend POS y éste
  hace de **relay transparente** entre navegadores autenticados (ticket JWT)
  y el bridge. El protocolo del lado del navegador no cambia: los mismos
  mensajes JSON (`ping`, `command:read/refresh`, `printer.request`,
  `printer.response`, `status`, `weight`).

Si no se definen las tres variables del bloque siguiente, el bridge no abre
conexión saliente y se comporta exactamente como antes (modo local).

## Variables de entorno

Todas opcionales salvo las tres marcadas con **(agente)**.

| Variable            | Default        | Rol |
|---------------------|----------------|-----|
| `SCALE_PORT`        | `COM1`         | Puerto serie preferido para la balanza. |
| `SCALE_BAUD`        | `4800`         | Baudrate serie. |
| `SCALE_WS_PORT`     | `9876`         | Puerto del WS local. |
| `SCALE_WS_HOST`     | `127.0.0.1`    | **Nuevo**. Hostname en el que el WS local escucha. Loopback por defecto porque desde fuera se entra por el servidor. Para abrirlo a toda la LAN: `0.0.0.0`. |
| `POS_SERVER_URL`    | *(sin default)*| **(agente)** `http(s)://host[:puerto]` del backend POS. El bridge lo convierte a `ws(s)://` y pega el path `/api/bridge/agent`. |
| `POS_AGENT_TOKEN`   | *(sin default)*| **(agente)** Token del header `X-Bridge-Token`. Debe coincidir con el valor que el backend tiene registrado para `POS_CAJA_ID` en `POS_AGENT_TOKENS`. **Nunca** se loguea. |
| `POS_CAJA_ID`       | *(sin default)*| **(agente)** Identificador de caja (`CAJA-01`, `CAJA-02`, ...). Viaja en la query `?caja_id=` del handshake. |

### Reglas

- Falta cualquiera de las tres marcadas con **(agente)** → no se abre la
  conexión saliente. No es un error.
- Si el backend rechaza el handshake (token inválido para esa caja → 401),
  el agente deja de reconectarse en bucle apretado hasta el próximo reinicio.
- Reconexión con backoff exponencial (1 s → 30 s) + jitter aleatorio.
- Ping nativo WS cada 25 s como keepalive. Es independiente del ping del
  protocolo del bridge (`{type:'ping'}`), que viaja envuelto en relayId.

## Dónde poner las variables en el PC de caja

El bridge ya tiene uno de estos arrancadores (**no los toca este sprint**;
sólo describe dónde pegar las variables):

### a. Script `.bat` de arranque (ejemplo típico)

```bat
@echo off
set SCALE_WS_HOST=127.0.0.1
set POS_SERVER_URL=http://pos-server.local:8080
set POS_AGENT_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx
set POS_CAJA_ID=CAJA-01
node C:\scale-bridge\index.js
```

Guardar como UTF-8 sin BOM. Las comillas no son necesarias para valores sin
espacios; sí lo son si el token tuviese espacios (no debería).

### b. Servicio Windows con `nssm`

Si el bridge ya corre como servicio con `nssm`, las variables se añaden en
*Properties → Environment* (una por línea, formato `KEY=valor`). No reinicies
el servicio desde esta máquina (política del repo). Pide al administrador
que lo haga en la ventana de mantenimiento acordada.

### c. Variables del sistema (poco recomendado)

Se puede, pero las variables quedan visibles para cualquier otro proceso
del usuario. Preferir siempre que estén acotadas al proceso del bridge.

## Verificación

### 1. Modo local (sin variables de agente)

```bat
node index.js
```

El log debe mostrar:

```
↷ Modo agente desactivado (faltan POS_SERVER_URL / POS_AGENT_TOKEN / POS_CAJA_ID)
✓ Servidor WebSocket escuchando en ws://127.0.0.1:9876
```

Y el WS local solo responde desde `127.0.0.1`. Si quieres restaurar el
comportamiento anterior (LAN):

```bat
set SCALE_WS_HOST=0.0.0.0
node index.js
```

### 2. Modo agente contra el backend

Con las tres variables definidas, el log debe mostrar:

```
↗ Modo agente activo → http://pos-server.local:8080 (caja_id=CAJA-01)
[relay-agent caja=CAJA-01 host=pos-server.local:8080] conectando (modo agente)
[relay-agent caja=CAJA-01 host=pos-server.local:8080] conectado
```

Y desde el navegador autenticado (en otro equipo), el flujo es:

1. `POST /api/bridge/ticket` con body `{"cajaId":"CAJA-01"}` → `{"ticket":"...","expiresInSeconds":30}`.
2. `WebSocket GET /api/bridge/relay?ticket=...` → recibe los mismos mensajes
   `status`/`weight` que recibía al conectar directo al bridge local.
3. `printer.request` envía un comando al bridge y responde `printer.response`
   con el mismo `requestId` original.

### 3. Comprobar en consola del navegador

Con el bridge en modo agente y el frontend configurado para el servidor
en vez de localhost, abrir la pestaña de red (DevTools):

- Un WS `wss://.../api/bridge/relay?ticket=...` abierto.
- Mensajes `{type:'status',connected:true,port:'COM1'}` y `{type:'weight',...}`
  cada ~2 segundos.
- Un `printer.request` desde la UI genera un `printer.response` con el
  mismo `requestId` en < 1 s (local al PC de caja).

### 4. Qué buscar si no funciona

- Log del bridge dice `handshake rechazado (status=401)` → token no coincide
  con el que el backend tiene para esa `POS_CAJA_ID`.
- Log dice `reintentando en Nms` sin un `conectado` posterior → el host del
  servidor no es alcanzable desde el PC de caja (firewall, DNS, Docker).
- El cliente relay recibe `RELAY_AGENT_OFFLINE` → el PC de caja está apagado,
  el bridge no corre o el agente no se conectó aún al servidor.
- El cliente recibe `RELAY_TIMEOUT` → el agente recibió el request pero no
  respondió en 15 s (impresora caída, cola bloqueada).

## Qué NO toca este modo

- No cambia el protocolo del navegador. El frontend sólo cambia la URL del
  WS (de `ws://127.0.0.1:9876` a `wss://.../api/bridge/relay?ticket=...`).
- No cambia el WS local: sigue existiendo. El panel que corre físicamente
  en el PC de caja puede seguir conectando a `ws://127.0.0.1:9876`.
- No cambia el flujo de kickDrawer local. La autorización de "abrir cajón"
  por relay la aplica el backend (sólo admin/administrador/superadmin).
- No añade dependencias nuevas: usa `ws` que ya estaba en el proyecto.

## Comportamiento ante caídas

| Evento                                 | Agente                               | Clientes relay |
|----------------------------------------|--------------------------------------|----------------|
| Backend caído                          | reconexión 1 s → 30 s con jitter     | se desconectan |
| Impresora RAW no responde              | request local falla con `TCP_TIMEOUT`| ven `pos.response.error` con el mismo requestId |
| Puerto COM se cae                      | broadcast `{type:'status',connected:false,port:''}` llega al relay | la UI muestra "balanza desconectada" |
| Bridge reiniciado                      | nuevo handshake, snapshot inicial    | el server marca la caja offline hasta reconectar |

## Troubleshooting

| Síntoma                             | Verificar                                |
|-------------------------------------|------------------------------------------|
| El log muestra el token             | Reportar bug. Nunca debe aparecer el valor. |
| `conectado` → `desconectado` cada 1 s | Backend está respondiendo a WS pero cerrando: revisar `POS_AGENT_TOKENS` en el backend. |
| Celular ve peso 0 pero el PC de caja ve el peso correcto | El cliente relay no recibió el broadcast → revisar que el server esté enrutando `{payload}` a los clientes de esa caja. |
| El cajón no abre desde el celular   | Autorización: sólo admin/administrador/superadmin puede ejecutar `kickDrawer` vía relay. |

Para pruebas unitarias y de integración (sin red externa), ver
`test/relay-agent.test.js` y `test/local-ws-host.test.js`.
