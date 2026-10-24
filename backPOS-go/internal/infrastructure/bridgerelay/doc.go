// Package bridgerelay implementa el relay WebSocket entre los agentes
// (scale-bridge de los PCs de caja) y los clientes relay (navegadores
// que corren el POS desde otro equipo o celular).
//
// Visión general del contrato:
//
//   - Agente (bridge -> servidor): se conecta como WebSocket SALIENTE a
//     `GET /api/bridge/agent?caja_id=<CAJA>` llevando el token
//     `X-Bridge-Token`. El servidor mantiene UN único agente activo por
//     cajaId: si llega otro con la misma caja, el anterior se cierra.
//
//   - Cliente (navegador -> servidor): primero pide `POST /api/bridge/ticket`
//     (auth JWT normal) y recibe un token opaco de un solo uso con TTL de
//     30 s. Luego abre `GET /api/bridge/relay?ticket=<ticket>` como
//     WebSocket. El ticket preserva la identidad del usuario (DNI, rol)
//     dentro del contexto del WS, dado que el navegador no puede mandar
//     `Authorization` en el handshake.
//
// Transparencia:
//
//	El cliente envía y recibe EXACTAMENTE los mismos mensajes JSON del
//	protocolo local del bridge (`{type:'ping'}`, `{type:'command', ...}`,
//	`{type:'printer.request', ...}` y las respuestas y broadcasts
//	correspondientes). El Hub encapsula/desencapsula los mensajes al cruzar
//	el canal agente<->servidor usando `{"relayId": "...", "payload": ...}`.
//
// Reglas de autorización:
//
//   - Cualquier cliente autenticado puede pedir peso e imprimir.
//   - Abrir cajón físico vía relay (printer.request action=kickDrawer) sólo
//     admin/administrador/superadmin. Los demás reciben
//     `printer.response ok:false errorCode:RELAY_FORBIDDEN`.
//
// Auditoría:
//
//	Cada `printer.request` del cliente se registra en el servicio de
//	auditoría existente (DNI, nombre, caja, acción) SIN guardar el contenido
//	del ticket, de la etiqueta ni de ningún payload sensible.
//
// Errores devueltos al cliente:
//
//   - `RELAY_AGENT_OFFLINE`: no hay agente para esa caja.
//   - `RELAY_FORBIDDEN`: el rol del cliente no permite esa acción.
//   - `RELAY_TIMEOUT`: el agente no respondió en 15 s a un request con id.
package bridgerelay
