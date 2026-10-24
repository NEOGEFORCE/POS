package bridgerelay

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Códigos de error que el relay devuelve al cliente dentro de un
// `printer.response ok:false`. Reflejan las categorías pedidas por el
// contrato.
const (
	ErrCodeAgentOffline = "RELAY_AGENT_OFFLINE"
	ErrCodeForbidden    = "RELAY_FORBIDDEN"
	ErrCodeTimeout      = "RELAY_TIMEOUT"
)

// Parámetros de la ventana de I/O WebSocket. Son constantes y están
// pensados para el ancho de banda y el patrón de uso del POS:
// mensajes cortos (peso, status) + ráfagas grandes (etiquetas con
// imagen).
const (
	// MaxMessageBytes es el tamaño máximo aceptado en un mensaje JSON. Las
	// etiquetas con imagen pueden rondar los 500 KiB; dejamos 1 MiB de
	// holgura para que una compresión mediocre no haga reventar la cola.
	MaxMessageBytes int64 = 1 << 20 // 1 MiB

	// agentSendBuffer y clientSendBuffer son los buffers de los canales
	// de salida. Un cliente lento con buffer lleno se desconecta — nunca
	// bloquea al Hub ni a otros clientes.
	agentSendBuffer  = 128
	clientSendBuffer = 64

	// Timeouts estándar WS. writeWait aplica a cada escritura; pongWait
	// es cuánto se espera por un pong tras ping. Los agentes son más
	// pacientes que los clientes porque recorren LAN del comercio.
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10

	// requestTimeout es cuánto esperamos al agente antes de responder
	// `RELAY_TIMEOUT` al cliente para un request con id.
	requestTimeout = 15 * time.Second
)

// WSConn es la mínima superficie de `*websocket.Conn` que necesita el
// Hub. Extraerla como interfaz permite testear el fan-out, el reemplazo
// de agente y el cliente lento sin abrir sockets reales. En producción
// se usa un envoltorio sobre `*websocket.Conn` definido en el handler
// (ver `wsAdapter` en `bridge_relay_handler.go`).
type WSConn interface {
	// WriteJSON escribe un objeto JSON. Debe aplicar writeWait por su
	// cuenta (el adapter real lo hace via SetWriteDeadline).
	WriteJSON(v interface{}) error
	// ReadJSON lee un objeto JSON. Debe aplicar los límites de tamaño y
	// de tiempo pactados; el adapter real los configura al construir el
	// websocket.
	ReadJSON(v interface{}) error
	// Close cierra el canal. Debe ser idempotente — el Hub puede
	// cerrarlo más de una vez durante shutdown y durante reemplazo.
	Close() error
	// RemoteAddr se usa sólo para log de rechazos ("agente desde
	// 192.168.X cerrado por token"). No es sensible.
	RemoteAddr() string
}

// AuditEvent describe algo que un cliente relay hizo a través del
// bridge. El Hub lo construye y se lo entrega al `AuditSink` del
// servicio de auditoría existente. Nunca contiene el contenido del
// ticket, la etiqueta ni el payload del `printer.request`.
type AuditEvent struct {
	DNI        string
	Name       string
	CajaID     string
	Action     string // "PRINT", "PRINT_TEST", "KICK_DRAWER", "LIST_PRINTERS"
	Module     string // "PRINTING_RELAY" o "CASH_DRAWER_RELAY"
	Human      string
	Device     string
	IP         string
	IsCritical bool
}

// AuditSink es el punto de inyección del servicio de auditoría. El
// handler se encarga de puentearlo contra `services.AuditService.Log`.
type AuditSink func(ev AuditEvent)

// ===========================================================================
// Hub
// ===========================================================================

// Hub coordina agentes y clientes. Internamente:
//
//   - UN agente por cajaId (si llega otro con la misma caja, cierra el
//     anterior).
//   - Varios clientes por cajaId.
//   - Enrutamiento por `relayId` para respuestas dirigidas.
//   - Fan-out para broadcasts del agente (status/weight) hacia todos los
//     clientes de esa caja.
//
// El Hub no bloquea: todas las escrituras hacia una conexión ocurren a
// través de un buffered channel propio de esa conexión. Si el buffer se
// llena, la conexión se cierra (write-slow drop).
type Hub struct {
	mu      sync.RWMutex
	agents  map[string]*Agent             // cajaId -> agent
	clients map[string]map[string]*Client // cajaId -> clientID -> client

	audit AuditSink
	tick  *TicketStore

	// closeCh se cierra cuando `Hub.Shutdown` corre; sirve de señal
	// global para que los loops de I/O terminen limpios.
	closeCh chan struct{}
	closed  atomic.Bool
}

// NewHub crea un Hub con una fuente de identidad para los tickets. El
// `audit` puede ser nil (los eventos se descartan silenciosamente); en
// producción se cablea contra `services.AuditService.Log`.
func NewHub(audit AuditSink) *Hub {
	return &Hub{
		agents:  make(map[string]*Agent),
		clients: make(map[string]map[string]*Client),
		audit:   audit,
		tick:    NewTicketStore(nil),
		closeCh: make(chan struct{}),
	}
}

// Tickets expone el store de tickets para que el handler pueda emitir
// y consumir. Se mantiene como campo separado para que las pruebas del
// Hub puedan tocarlo sin inicializar el handler HTTP completo.
func (h *Hub) Tickets() *TicketStore { return h.tick }

// Shutdown cierra todas las conexiones conocidas y marca el Hub como
// detenido. Idempotente: la segunda llamada es un no-op.
func (h *Hub) Shutdown(ctx context.Context) error {
	if h.closed.Swap(true) {
		return nil
	}
	close(h.closeCh)

	h.mu.Lock()
	agents := h.agents
	clients := h.clients
	h.agents = make(map[string]*Agent)
	h.clients = make(map[string]map[string]*Client)
	h.mu.Unlock()

	for _, a := range agents {
		a.closeAll()
	}
	for _, byCaja := range clients {
		for _, c := range byCaja {
			c.closeAll()
		}
	}
	return nil
}

// ===========================================================================
// Agent
// ===========================================================================

// Agent es un bridge local conectado al servidor como agente saliente.
type Agent struct {
	hub         *Hub
	cajaID      string
	conn        WSConn
	send        chan []byte
	done        chan struct{}
	closeOnce   sync.Once
	connectedAt time.Time
	lastSeenNs  atomic.Int64
}

// AgentSnapshot resume el estado observable de un agente para
// `/api/bridge/agents`. Las marcas de tiempo se devuelven en UTC/RFC3339
// en el handler.
type AgentSnapshot struct {
	CajaID      string
	Connected   bool
	ConnectedAt time.Time
	LastSeenAt  time.Time
}

// Agents devuelve el snapshot del estado para todas las cajas con
// agente conectado AHORA. Las cajas sin agente activo no aparecen —
// el handler puede enriquecer con las cajas definidas en
// `POS_AGENT_TOKENS` para mostrarlas como `connected:false`.
func (h *Hub) Agents() []AgentSnapshot {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]AgentSnapshot, 0, len(h.agents))
	for _, a := range h.agents {
		out = append(out, a.snapshot())
	}
	return out
}

// AgentFor devuelve el agente actualmente conectado para `cajaID`, o
// nil si no hay. Pensado sólo para pruebas: la ruta normal pasa por el
// Hub.
func (h *Hub) AgentFor(cajaID string) *Agent {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.agents[cajaID]
}

func (a *Agent) snapshot() AgentSnapshot {
	last := time.Unix(0, a.lastSeenNs.Load())
	return AgentSnapshot{
		CajaID:      a.cajaID,
		Connected:   true,
		ConnectedAt: a.connectedAt,
		LastSeenAt:  last,
	}
}

// closeAll corta la conexión y libera recursos. Idempotente.
func (a *Agent) closeAll() {
	a.closeOnce.Do(func() {
		close(a.done)
		_ = a.conn.Close()
	})
}

// touch actualiza la marca `lastSeenAt` cuando llega un mensaje del
// agente. Se guarda como atómico porque múltiples lectores (snapshot,
// broadcasts) pueden observarlo sin bloqueo.
func (a *Agent) touch() { a.lastSeenNs.Store(time.Now().UnixNano()) }

// RegisterAgent registra un agente nuevo para `cajaID`. Si ya había
// uno, lo cierra antes de reemplazarlo. Devuelve el agente creado para
// que el llamador arranque sus loops.
func (h *Hub) RegisterAgent(cajaID string, conn WSConn) *Agent {
	if h.closed.Load() {
		_ = conn.Close()
		return nil
	}

	a := &Agent{
		hub:         h,
		cajaID:      cajaID,
		conn:        conn,
		send:        make(chan []byte, agentSendBuffer),
		done:        make(chan struct{}),
		connectedAt: time.Now(),
	}
	a.lastSeenNs.Store(a.connectedAt.UnixNano())

	h.mu.Lock()
	prev := h.agents[cajaID]
	h.agents[cajaID] = a
	h.mu.Unlock()

	if prev != nil {
		// Un segundo agente para la misma caja desplaza al anterior.
		// Cerramos al anterior fuera del lock para evitar bloqueos
		// cruzados con sus propios loops.
		log.Printf("[bridgerelay] agente reemplazado para caja=%s", cajaID)
		prev.closeAll()
	}

	return a
}

// unregisterAgent remueve al agente si todavía es el activo. Luego
// anuncia a los clientes que el bridge se desconectó. Se llama al
// cerrar la conexión del agente.
func (h *Hub) unregisterAgent(a *Agent) {
	h.mu.Lock()
	if current, ok := h.agents[a.cajaID]; ok && current == a {
		delete(h.agents, a.cajaID)
	}
	// Snapshot de los clientes afectados dentro del lock para evitar
	// que otra operación los mute mientras les enviamos el status.
	clients := make([]*Client, 0)
	if byCaja, ok := h.clients[a.cajaID]; ok {
		for _, c := range byCaja {
			clients = append(clients, c)
		}
	}
	h.mu.Unlock()

	statusDown := map[string]interface{}{
		"type":      "status",
		"connected": false,
		"port":      "",
	}
	payload, err := json.Marshal(statusDown)
	if err != nil {
		return
	}
	for _, c := range clients {
		c.sendRaw(payload)
	}
}

// Writer loop del agente: toma del canal `send` y escribe al socket.
// Alterna con pings periódicos para mantener la conexión viva. Sale
// cuando `done` cierra o cuando falla una escritura (en cuyo caso se
// autodestruye).
func (a *Agent) writeLoop() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case msg, ok := <-a.send:
			if !ok {
				return
			}
			if err := a.conn.WriteJSON(json.RawMessage(msg)); err != nil {
				a.closeAll()
				return
			}
		case <-ticker.C:
			// WriteJSON envía marco de texto; el ping lo envía el adapter
			// subyacente — ver `wsAdapter.WritePing`. Si el adapter no
			// implementa ping, lo omitimos. Lo lee por reflección mínima.
			if p, ok := a.conn.(interface{ WritePing() error }); ok {
				if err := p.WritePing(); err != nil {
					a.closeAll()
					return
				}
			}
		case <-a.done:
			return
		case <-a.hub.closeCh:
			a.closeAll()
			return
		}
	}
}

// Reader loop del agente: parsea cada mensaje JSON y lo rutea.
//
//   - Si el mensaje tiene campo `relayId` → respuesta dirigida al cliente
//     con esa `clientID`. El payload es lo que va en `payload`.
//   - Si no tiene `relayId` → broadcast a todos los clientes de la caja.
//
// Cuando el read falla, se cierra la conexión y se desregistra el agente.
func (a *Agent) readLoop() {
	defer func() {
		a.closeAll()
		a.hub.unregisterAgent(a)
	}()

	for {
		var env agentEnvelope
		if err := a.conn.ReadJSON(&env); err != nil {
			return
		}
		a.touch()

		if env.RelayID == "" {
			a.hub.broadcastToClients(a.cajaID, env.Payload)
			continue
		}
		a.hub.routeResponse(a.cajaID, env.RelayID, env.Payload)
	}
}

// agentEnvelope es el formato con el que viajan los mensajes
// agente<->servidor: siempre llevan `payload` crudo; `relayId` es
// opcional y cuando viene identifica al cliente destino.
type agentEnvelope struct {
	RelayID string          `json:"relayId,omitempty"`
	Payload json.RawMessage `json:"payload"`
}

// Run arranca los dos loops de I/O del agente. Debe llamarse en una
// goroutine propia; retorna cuando el agente se cierra.
func (a *Agent) Run() {
	go a.writeLoop()
	a.readLoop()
}

// sendEnvelope empuja un mensaje envuelto hacia el agente. Devuelve
// `false` si el buffer estaba lleno (el Hub lo trata como señal de que
// el agente está lento y lo cierra).
func (a *Agent) sendEnvelope(relayID string, payload json.RawMessage) bool {
	env := agentEnvelope{RelayID: relayID, Payload: payload}
	buf, err := json.Marshal(env)
	if err != nil {
		return false
	}
	select {
	case a.send <- buf:
		return true
	default:
		return false
	}
}

// ===========================================================================
// Client
// ===========================================================================

// Client es un navegador (u otro consumidor) conectado al servidor a
// través de `/api/bridge/relay`.
type Client struct {
	hub       *Hub
	id        string
	cajaID    string
	ident     TicketIdentity
	remoteIP  string
	device    string
	conn      WSConn
	send      chan []byte
	done      chan struct{}
	closeOnce sync.Once

	// pending guarda los requestIds enviados al agente para los que
	// esperamos respuesta. El valor es un *time.Timer que, si vence,
	// manda `RELAY_TIMEOUT` al cliente. El mapa está acotado por el
	// propio comportamiento del cliente (nunca debería tener más de un
	// request por acción) pero cerramos todos los timers al cerrar.
	pendingMu sync.Mutex
	pending   map[string]*time.Timer
}

// RegisterClient agrega un cliente al Hub para la caja indicada. El
// `clientID` se genera aleatorio: identifica al cliente en los envelopes
// agente<->servidor.
func (h *Hub) RegisterClient(ident TicketIdentity, conn WSConn, remoteIP, device string) *Client {
	if h.closed.Load() {
		_ = conn.Close()
		return nil
	}

	buf := make([]byte, 12)
	_, _ = rand.Read(buf)
	c := &Client{
		hub:      h,
		id:       "cl-" + hex.EncodeToString(buf),
		cajaID:   ident.CajaID,
		ident:    ident,
		remoteIP: remoteIP,
		device:   device,
		conn:     conn,
		send:     make(chan []byte, clientSendBuffer),
		done:     make(chan struct{}),
		pending:  make(map[string]*time.Timer),
	}

	h.mu.Lock()
	byCaja, ok := h.clients[c.cajaID]
	if !ok {
		byCaja = make(map[string]*Client)
		h.clients[c.cajaID] = byCaja
	}
	byCaja[c.id] = c
	hasAgent := h.agents[c.cajaID] != nil
	h.mu.Unlock()

	// Snapshot inicial: si no hay agente, el cliente ve estado offline.
	// Si hay, el agente ya mandó su propio snapshot al conectarse y el
	// Hub se lo irá reenviando conforme lleguen broadcasts; no fabricamos
	// uno falso que el agente debería desmentir en milisegundos.
	if !hasAgent {
		statusDown, _ := json.Marshal(map[string]interface{}{
			"type":      "status",
			"connected": false,
			"port":      "",
		})
		c.sendRaw(statusDown)
	}

	return c
}

func (h *Hub) unregisterClient(c *Client) {
	h.mu.Lock()
	if byCaja, ok := h.clients[c.cajaID]; ok {
		if cur, ok2 := byCaja[c.id]; ok2 && cur == c {
			delete(byCaja, c.id)
		}
		if len(byCaja) == 0 {
			delete(h.clients, c.cajaID)
		}
	}
	h.mu.Unlock()
}

func (c *Client) closeAll() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.conn.Close()
		c.pendingMu.Lock()
		for id, t := range c.pending {
			t.Stop()
			delete(c.pending, id)
		}
		c.pendingMu.Unlock()
	})
}

// sendRaw empuja un mensaje JSON crudo (ya codificado) al cliente. Si
// el buffer está lleno, cerramos al cliente — un consumidor lento no
// puede frenar al Hub ni a otros clientes.
func (c *Client) sendRaw(data []byte) {
	select {
	case c.send <- data:
	case <-c.done:
	default:
		// Buffer lleno → cliente lento; lo expulsamos.
		c.closeAll()
	}
}

// Writer loop del cliente.
func (c *Client) writeLoop() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				return
			}
			if err := c.conn.WriteJSON(json.RawMessage(msg)); err != nil {
				c.closeAll()
				return
			}
		case <-ticker.C:
			if p, ok := c.conn.(interface{ WritePing() error }); ok {
				if err := p.WritePing(); err != nil {
					c.closeAll()
					return
				}
			}
		case <-c.done:
			return
		case <-c.hub.closeCh:
			c.closeAll()
			return
		}
	}
}

// Reader loop del cliente. Cada mensaje JSON se parsea, se audita y se
// reenvía al agente.
func (c *Client) readLoop() {
	defer func() {
		c.closeAll()
		c.hub.unregisterClient(c)
	}()

	for {
		var payload json.RawMessage
		if err := c.conn.ReadJSON(&payload); err != nil {
			return
		}
		if len(payload) == 0 {
			continue
		}
		c.handleFromClient(payload)
	}
}

// Run arranca los dos loops de I/O del cliente.
func (c *Client) Run() {
	go c.writeLoop()
	c.readLoop()
}

// handleFromClient inspecciona el mensaje enviado por el cliente,
// decide si debe auditarse o rechazarse, y, si está autorizado, lo
// empuja hacia el agente de la caja.
func (c *Client) handleFromClient(payload json.RawMessage) {
	// Peek del shape mínimo para decidir enrutamiento.
	peek := struct {
		Type      string          `json:"type"`
		Action    string          `json:"action"`
		RequestID string          `json:"requestId"`
		Payload   json.RawMessage `json:"payload"`
	}{}
	// Si el JSON no es un objeto reconocible, lo reenviamos tal cual
	// — el protocolo del bridge ignora mensajes desconocidos. No
	// gastamos un error por eso.
	_ = json.Unmarshal(payload, &peek)

	// Reglas sobre `printer.request`:
	//   - kickDrawer: sólo admin/administrador/superadmin.
	//   - Toda acción se audita (sin contenido).
	if peek.Type == "printer.request" {
		action := strings.TrimSpace(peek.Action)
		if !c.enforcePrinterPolicy(action, peek.RequestID) {
			return
		}
		c.auditPrinterAction(action)
	}

	// Reenvío al agente. Si no hay agente, respondemos
	// `RELAY_AGENT_OFFLINE` para el requestId correspondiente.
	agent := c.hub.AgentFor(c.cajaID)
	if agent == nil {
		if peek.Type == "printer.request" {
			c.sendPrinterError(peek.RequestID, ErrCodeAgentOffline, "No hay agente conectado para esta caja")
		}
		return
	}

	if !agent.sendEnvelope(c.id, payload) {
		// El agente va lento; lo cerramos y respondemos offline.
		agent.closeAll()
		if peek.Type == "printer.request" {
			c.sendPrinterError(peek.RequestID, ErrCodeAgentOffline, "El agente se desconectó por lentitud")
		}
		return
	}

	// Timer de timeout para `printer.request` con `requestId`.
	if peek.Type == "printer.request" && peek.RequestID != "" {
		c.armTimeout(peek.RequestID)
	}
}

// enforcePrinterPolicy valida la autorización sobre un printer.request
// y, cuando corresponde, responde directamente al cliente. Devuelve
// `true` si el mensaje puede continuar hacia el agente.
func (c *Client) enforcePrinterPolicy(action, requestID string) bool {
	if action == "kickDrawer" && !c.ident.IsAdmin {
		c.auditForbiddenKickDrawer()
		c.sendPrinterError(requestID, ErrCodeForbidden,
			"Abrir cajón vía relay requiere permiso de administrador")
		return false
	}
	return true
}

// armTimeout programa un `RELAY_TIMEOUT` si el agente no responde al
// `requestID` dentro de `requestTimeout`. Si ya había un timer para ese
// id (reintento del mismo request), lo reinicia.
func (c *Client) armTimeout(requestID string) {
	c.pendingMu.Lock()
	defer c.pendingMu.Unlock()

	if existing, ok := c.pending[requestID]; ok {
		existing.Stop()
	}
	c.pending[requestID] = time.AfterFunc(requestTimeout, func() {
		c.pendingMu.Lock()
		if _, ok := c.pending[requestID]; !ok {
			c.pendingMu.Unlock()
			return
		}
		delete(c.pending, requestID)
		c.pendingMu.Unlock()
		c.sendPrinterError(requestID, ErrCodeTimeout,
			"El agente del bridge no respondió en 15 s")
	})
}

// cancelPending detiene y remueve el timer de un requestId, si existe.
// Se llama cuando el agente respondió a ese id.
func (c *Client) cancelPending(requestID string) {
	c.pendingMu.Lock()
	defer c.pendingMu.Unlock()
	if t, ok := c.pending[requestID]; ok {
		t.Stop()
		delete(c.pending, requestID)
	}
}

// sendPrinterError responde al cliente con un `printer.response ok:false`
// usando el mismo requestId del request. Si no había requestId se emite
// un `pos.response.error` sin asociación: cualquier consumidor que
// quede escuchando lo verá como fallo transversal.
func (c *Client) sendPrinterError(requestID, code, message string) {
	if requestID == "" {
		m, _ := json.Marshal(map[string]interface{}{
			"type":      "pos.response.error",
			"errorCode": code,
			"error":     message,
			"ok":        false,
		})
		c.sendRaw(m)
		return
	}
	m, _ := json.Marshal(map[string]interface{}{
		"type":      "printer.response",
		"requestId": requestID,
		"ok":        false,
		"error":     message,
		"errorCode": code,
	})
	c.sendRaw(m)
}

// auditPrinterAction audita un `printer.request` del cliente. No
// guarda el contenido del ticket ni del payload — sólo la acción,
// la caja y la identidad.
func (c *Client) auditPrinterAction(action string) {
	if c.hub.audit == nil {
		return
	}
	module := "PRINTING_RELAY"
	humanAction := "Impresión vía relay"
	eventAction := "PRINT"
	isCritical := false

	switch action {
	case "kickDrawer":
		module = "CASH_DRAWER_RELAY"
		humanAction = "Apertura de cajón vía relay"
		eventAction = "KICK_DRAWER"
		isCritical = true
	case "printTestPage":
		humanAction = "Impresión de página de prueba vía relay"
		eventAction = "PRINT_TEST"
	case "listPrinters":
		humanAction = "Enumeración de impresoras vía relay"
		eventAction = "LIST_PRINTERS"
	case "print", "":
		// print es la acción por defecto; sin cambios.
	default:
		humanAction = "Acción desconocida vía relay"
		eventAction = strings.ToUpper(action)
	}

	c.hub.audit(AuditEvent{
		DNI:        c.ident.DNI,
		Name:       c.ident.Name,
		CajaID:     c.cajaID,
		Action:     eventAction,
		Module:     module,
		Human:      humanAction + " (caja " + c.cajaID + ")",
		IP:         c.remoteIP,
		Device:     c.device,
		IsCritical: isCritical,
	})
}

// auditForbiddenKickDrawer registra un intento rechazado de abrir el
// cajón por un rol insuficiente. Útil para auditoría de accesos.
func (c *Client) auditForbiddenKickDrawer() {
	if c.hub.audit == nil {
		return
	}
	c.hub.audit(AuditEvent{
		DNI:        c.ident.DNI,
		Name:       c.ident.Name,
		CajaID:     c.cajaID,
		Action:     "KICK_DRAWER_FORBIDDEN",
		Module:     "CASH_DRAWER_RELAY",
		Human:      "Intento de abrir cajón vía relay sin permisos (caja " + c.cajaID + ")",
		IP:         c.remoteIP,
		Device:     c.device,
		IsCritical: true,
	})
}

// ===========================================================================
// Fan-out: broadcasts y respuestas dirigidas
// ===========================================================================

// broadcastToClients envía un payload crudo a TODOS los clientes de la
// caja indicada. Se usa para `status` y `weight` que el agente emite
// sin `relayId`.
func (h *Hub) broadcastToClients(cajaID string, payload json.RawMessage) {
	if len(payload) == 0 {
		return
	}
	h.mu.RLock()
	byCaja := h.clients[cajaID]
	targets := make([]*Client, 0, len(byCaja))
	for _, c := range byCaja {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	data := make([]byte, len(payload))
	copy(data, payload)
	for _, c := range targets {
		c.sendRaw(data)
	}
}

// routeResponse enruta una respuesta del agente al cliente concreto. Si
// el payload es un `printer.response` con `requestId`, cancelamos el
// timeout pendiente para ese id. Si el cliente ya no existe (p. ej.
// cerró la pestaña), descartamos.
func (h *Hub) routeResponse(cajaID, clientID string, payload json.RawMessage) {
	h.mu.RLock()
	var client *Client
	if byCaja, ok := h.clients[cajaID]; ok {
		client = byCaja[clientID]
	}
	h.mu.RUnlock()
	if client == nil {
		return
	}

	// Peek del requestId para cancelar timeout.
	peek := struct {
		Type      string `json:"type"`
		RequestID string `json:"requestId"`
	}{}
	_ = json.Unmarshal(payload, &peek)
	if peek.RequestID != "" {
		client.cancelPending(peek.RequestID)
	}

	data := make([]byte, len(payload))
	copy(data, payload)
	client.sendRaw(data)
}

// ===========================================================================
// Errores exportados
// ===========================================================================

var (
	// ErrShutdown se devuelve si se intenta registrar algo en un Hub
	// ya cerrado.
	ErrShutdown = errors.New("hub detenido")
)
