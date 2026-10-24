// Handlers HTTP del relay WebSocket entre agentes (scale-bridge en
// cada PC de caja) y clientes (navegadores u otros consumidores). Las
// rutas montadas son:
//
//   - GET  /api/bridge/agent?caja_id=<CAJA>  (auth: X-Bridge-Token)
//   - POST /api/bridge/ticket                (auth: JWT normal)
//   - GET  /api/bridge/relay?ticket=<token>  (auth: ticket de un solo uso)
//   - GET  /api/bridge/agents                (auth: JWT normal)
//
// La lógica de enrutamiento/fan-out/auditoría vive en el paquete
// `internal/infrastructure/bridgerelay`. Este archivo es un adaptador
// delgado entre Gin y ese Hub.
package handlers

import (
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"backPOS-go/internal/adapters/middlewares"
	"backPOS-go/internal/core/services"
	"backPOS-go/internal/infrastructure/bridgerelay"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// BridgeRelayHandler agrupa las rutas del relay. Guarda el Hub, el
// mapa de tokens configurados y la referencia al servicio de
// auditoría. La validación de orígenes WS se delega a la misma
// política CORS que ya usa el server (originAllowed).
type BridgeRelayHandler struct {
	hub            *bridgerelay.Hub
	tokens         bridgerelay.TokenMap
	audit          *services.AuditService
	originAllowed  func(origin string) bool
	noConfigLogged atomic.Bool
}

// NewBridgeRelayHandler construye el handler. `tokens` puede ser nil
// (el handler responderá 503 en `/agent` y auditará el aviso una vez).
// `originAllowed` se usa para validar el `Origin` del handshake del
// cliente — misma política CORS que ya aplica el servidor.
func NewBridgeRelayHandler(
	hub *bridgerelay.Hub,
	tokens bridgerelay.TokenMap,
	audit *services.AuditService,
	originAllowed func(origin string) bool,
) *BridgeRelayHandler {
	if originAllowed == nil {
		// Default seguro: sólo orígenes privados/locales. Mantiene
		// coherencia con el middleware CORS cuando el llamador no
		// pasa su propia política.
		originAllowed = middlewares.IsPrivateOrigin
	}
	return &BridgeRelayHandler{
		hub:           hub,
		tokens:        tokens,
		audit:         audit,
		originAllowed: originAllowed,
	}
}

// ===========================================================================
// Upgraders
// ===========================================================================

// agentUpgrader es menos estricto con Origin porque el agente es un
// proceso Node en LAN controlada; muchas veces no manda header Origin.
// La autenticación real la hace `X-Bridge-Token`.
var agentUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		// El agente puede no mandar Origin (cliente nativo Node); si lo
		// manda, exigimos que sea privado/local.
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin == "" {
			return true
		}
		return middlewares.IsPrivateOrigin(origin)
	},
}

// buildClientUpgrader arma el Upgrader del cliente relay con la
// política de origen inyectada en el handler. Debe estar en una
// función porque el closure captura `h`.
func (h *BridgeRelayHandler) buildClientUpgrader() *websocket.Upgrader {
	return &websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin: func(r *http.Request) bool {
			origin := strings.TrimSpace(r.Header.Get("Origin"))
			if origin == "" {
				// Sin Origin: aceptamos sólo si el ticket es válido;
				// esta función no puede re-verificar el ticket aquí,
				// pero la ruta pide el ticket antes del Upgrade.
				return true
			}
			return h.originAllowed(origin)
		},
	}
}

// ===========================================================================
// Agent handshake
// ===========================================================================

// AgentWS implementa `GET /api/bridge/agent`. Autentica el agente con
// `X-Bridge-Token` contra `POS_AGENT_TOKENS`, verifica que el token
// corresponde a la caja declarada y hace el Upgrade a WebSocket.
func (h *BridgeRelayHandler) AgentWS(c *gin.Context) {
	// Sin configuración → 503. Loguear una vez para no spamear.
	if h.tokens == nil {
		if h.noConfigLogged.CompareAndSwap(false, true) {
			log.Printf("[bridgerelay] /api/bridge/agent llamado sin POS_AGENT_TOKENS configurado; respondiendo 503")
		}
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
			"error": gin.H{
				"code":    "RELAY_NOT_CONFIGURED",
				"message": "El relay de bridges no está configurado en este servidor",
			},
		})
		return
	}

	cajaID := strings.TrimSpace(c.Query("caja_id"))
	if cajaID == "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"code":    "RELAY_BAD_REQUEST",
				"message": "Falta el parámetro caja_id",
			},
		})
		return
	}

	token := strings.TrimSpace(c.GetHeader("X-Bridge-Token"))
	if token == "" || !h.tokens.Verify(cajaID, token) {
		// Nunca registramos el token recibido; el log sólo refleja el
		// cajaId para forense básica.
		log.Printf("[bridgerelay] /agent rechazado caja=%q desde %s (token inválido)", cajaID, c.ClientIP())
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
			"error": gin.H{
				"code":    "RELAY_UNAUTHORIZED",
				"message": "Token de bridge inválido",
			},
		})
		return
	}

	conn, err := agentUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		// El upgrade escribe su propio error; sólo logueamos.
		log.Printf("[bridgerelay] upgrade /agent caja=%s falló: %v", cajaID, err)
		return
	}

	adapter := newWSAdapter(conn, bridgerelay.MaxMessageBytes)
	agent := h.hub.RegisterAgent(cajaID, adapter)
	if agent == nil {
		// Hub en shutdown: adapter ya fue cerrado.
		return
	}
	log.Printf("[bridgerelay] agente conectado caja=%s desde %s", cajaID, c.ClientIP())
	// Run bloquea hasta que la conexión caiga. Como estamos dentro del
	// handler Gin, consumimos la goroutine actual: nada escribe al
	// ResponseWriter después del Upgrade.
	agent.Run()
}

// ===========================================================================
// Ticket emission
// ===========================================================================

type ticketRequest struct {
	CajaID string `json:"cajaId"`
}

type ticketResponse struct {
	Ticket           string `json:"ticket"`
	ExpiresInSeconds int    `json:"expiresInSeconds"`
}

// IssueTicket implementa `POST /api/bridge/ticket`. Pide la caja
// deseada y devuelve un token opaco de un solo uso. Usa el middleware
// JWT ya montado en el grupo `protected`; el DNI/rol vienen del
// contexto.
func (h *BridgeRelayHandler) IssueTicket(c *gin.Context) {
	var req ticketRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"code":    "RELAY_BAD_REQUEST",
				"message": "Payload inválido",
			},
		})
		return
	}
	cajaID := strings.TrimSpace(req.CajaID)
	if cajaID == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"code":    "RELAY_BAD_REQUEST",
				"message": "Falta cajaId",
			},
		})
		return
	}

	ident := bridgerelay.TicketIdentity{
		CajaID:  cajaID,
		DNI:     actorDNI(c),
		Name:    actorName(c),
		Role:    strings.TrimSpace(contextRole(c)),
		IsAdmin: actorIsAdmin(c),
	}
	if ident.DNI == "" {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": gin.H{
				"code":    "RELAY_UNAUTHORIZED",
				"message": "Sesión requerida",
			},
		})
		return
	}

	token, err := h.hub.Tickets().Issue(ident)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{
				"code":    "RELAY_INTERNAL",
				"message": "No se pudo emitir el ticket",
			},
		})
		return
	}
	c.JSON(http.StatusOK, ticketResponse{
		Ticket:           token,
		ExpiresInSeconds: int(bridgerelay.TicketTTL / time.Second),
	})
}

// ===========================================================================
// Client WebSocket (relay)
// ===========================================================================

// RelayWS implementa `GET /api/bridge/relay?ticket=<token>`. Consume el
// ticket, valida el Origin del WebSocket y hace Upgrade. A partir de
// ahí, el cliente envía/recibe el mismo protocolo del bridge local.
func (h *BridgeRelayHandler) RelayWS(c *gin.Context) {
	// Validación de Origin antes del Upgrade: nunca aceptar un origen
	// no permitido, incluso con ticket válido. El Upgrader también lo
	// valida pero devuelve 403 opaco; aquí damos un error JSON claro.
	origin := strings.TrimSpace(c.Request.Header.Get("Origin"))
	if origin != "" && !h.originAllowed(origin) {
		log.Printf("[bridgerelay] /relay rechazado por origin %q desde %s", origin, c.ClientIP())
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
			"error": gin.H{
				"code":    "RELAY_ORIGIN_FORBIDDEN",
				"message": "Origen no permitido",
			},
		})
		return
	}

	token := strings.TrimSpace(c.Query("ticket"))
	if token == "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"code":    "RELAY_BAD_REQUEST",
				"message": "Falta ticket",
			},
		})
		return
	}

	ident, err := h.hub.Tickets().Consume(token)
	if err != nil {
		code := "RELAY_TICKET_INVALID"
		status := http.StatusUnauthorized
		switch {
		case errors.Is(err, bridgerelay.ErrTicketExpired):
			code = "RELAY_TICKET_EXPIRED"
		case errors.Is(err, bridgerelay.ErrTicketReused):
			code = "RELAY_TICKET_REUSED"
		}
		c.AbortWithStatusJSON(status, gin.H{
			"error": gin.H{
				"code":    code,
				"message": "Ticket inválido o ya consumido",
			},
		})
		return
	}

	upgrader := h.buildClientUpgrader()
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("[bridgerelay] upgrade /relay caja=%s falló: %v", ident.CajaID, err)
		return
	}
	adapter := newWSAdapter(conn, bridgerelay.MaxMessageBytes)
	cli := h.hub.RegisterClient(ident, adapter, c.ClientIP(), truncate(c.Request.UserAgent(), 160))
	if cli == nil {
		return
	}
	cli.Run()
}

// ===========================================================================
// Agents list
// ===========================================================================

type agentInfo struct {
	CajaID      string `json:"cajaId"`
	Connected   bool   `json:"connected"`
	ConnectedAt string `json:"connectedAt,omitempty"`
	LastSeenAt  string `json:"lastSeenAt,omitempty"`
}

// ListAgents implementa `GET /api/bridge/agents`. Combina la lista de
// cajas configuradas (POS_AGENT_TOKENS) con el estado real conocido
// por el Hub: una caja configurada que no esté conectada aparece como
// `connected:false`.
func (h *BridgeRelayHandler) ListAgents(c *gin.Context) {
	snapshots := h.hub.Agents()
	byCaja := make(map[string]bridgerelay.AgentSnapshot, len(snapshots))
	for _, s := range snapshots {
		byCaja[s.CajaID] = s
	}

	out := make([]agentInfo, 0)
	// Primero las configuradas (si las hay).
	seen := map[string]bool{}
	for _, caja := range h.tokens.Cajas() {
		seen[caja] = true
		info := agentInfo{CajaID: caja, Connected: false}
		if s, ok := byCaja[caja]; ok {
			info.Connected = true
			info.ConnectedAt = s.ConnectedAt.UTC().Format(time.RFC3339)
			info.LastSeenAt = s.LastSeenAt.UTC().Format(time.RFC3339)
		}
		out = append(out, info)
	}
	// Luego cualquier agente conectado cuya caja NO esté en la
	// configuración (no debería pasar porque el token lo exige, pero lo
	// dejamos para completitud).
	for _, s := range snapshots {
		if seen[s.CajaID] {
			continue
		}
		out = append(out, agentInfo{
			CajaID:      s.CajaID,
			Connected:   true,
			ConnectedAt: s.ConnectedAt.UTC().Format(time.RFC3339),
			LastSeenAt:  s.LastSeenAt.UTC().Format(time.RFC3339),
		})
	}

	c.JSON(http.StatusOK, gin.H{"agents": out})
}

// ===========================================================================
// WebSocket adapter — envoltorio sobre *websocket.Conn
// ===========================================================================

// wsAdapter envuelve `*websocket.Conn` para cumplir `bridgerelay.WSConn`.
// Centraliza:
//
//   - El límite de tamaño del mensaje (SetReadLimit).
//   - Los write deadlines por operación.
//   - Un lock para WriteJSON/WritePing (gorilla no es write-safe entre
//     goroutines distintas).
//   - Un idle-timeout de lectura refrescado por pong.
type wsAdapter struct {
	conn   *websocket.Conn
	mu     sync.Mutex
	closed atomic.Bool
}

func newWSAdapter(conn *websocket.Conn, maxBytes int64) *wsAdapter {
	conn.SetReadLimit(maxBytes)
	// Pong refresca el deadline de lectura; sin ello, los agentes de
	// LAN quedarían vivos para siempre si la red se cae silenciosamente.
	_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	})
	return &wsAdapter{conn: conn}
}

func (a *wsAdapter) WriteJSON(v interface{}) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed.Load() {
		return errors.New("conn closed")
	}
	_ = a.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return a.conn.WriteJSON(v)
}

func (a *wsAdapter) ReadJSON(v interface{}) error {
	// gorilla permite exactamente UN lector concurrente; el Hub llama
	// a este método desde una única goroutine (readLoop), así que no
	// hace falta un lock aquí. Si cambiara, hay que serializar.
	return a.conn.ReadJSON(v)
}

// WritePing envía un marco PING. El Hub lo invoca mediante type
// assertion, lo que mantiene el contrato `WSConn` libre de
// detalles ping/pong.
func (a *wsAdapter) WritePing() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed.Load() {
		return errors.New("conn closed")
	}
	_ = a.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return a.conn.WriteMessage(websocket.PingMessage, nil)
}

func (a *wsAdapter) Close() error {
	if a.closed.Swap(true) {
		return nil
	}
	// Cierre limpio: intentamos enviar un close frame; si falla,
	// seguimos con el close duro.
	a.mu.Lock()
	_ = a.conn.SetWriteDeadline(time.Now().Add(time.Second))
	_ = a.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	a.mu.Unlock()
	return a.conn.Close()
}

func (a *wsAdapter) RemoteAddr() string {
	return a.conn.RemoteAddr().String()
}

// ===========================================================================
// Helpers locales
// ===========================================================================

// contextRole devuelve el string del campo `role` del contexto. Se
// mantiene por simetría con `actorDNI`/`actorName` existentes.
func contextRole(c *gin.Context) string {
	v, ok := c.Get("role")
	if !ok {
		return ""
	}
	s, _ := v.(string)
	return s
}

// truncate recorta cualquier string al máximo de bytes dado para
// evitar que un User-Agent de pesadilla llene columnas de auditoría.
func truncate(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	return s[:max]
}

// MakeAuditSink devuelve una función `bridgerelay.AuditSink` que
// enruta cada evento al `services.AuditService` existente. Se expone
// para que `cmd/api/main.go` la cablee al construir el Hub.
func MakeAuditSink(audit *services.AuditService) bridgerelay.AuditSink {
	if audit == nil {
		return nil
	}
	return func(ev bridgerelay.AuditEvent) {
		audit.Log(
			ev.DNI, ev.Name,
			ev.Action, ev.Module,
			ev.CajaID, // details: usamos la caja para búsquedas rápidas
			ev.Human,  // humanReadable
			"",        // changes (vacío: no almacenamos el contenido del ticket)
			ev.IP, ev.Device,
			ev.IsCritical,
		)
	}
}

// Guard para que `url.URL` no quede sin usar en algunas builds; el
// paquete lo necesita el día que agreguemos más validadores.
var _ = url.URL{}
