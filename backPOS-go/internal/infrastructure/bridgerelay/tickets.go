package bridgerelay

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

// TicketTTL es la vigencia de un ticket emitido por `/api/bridge/ticket`.
// 30 s es suficiente para que el navegador reciba el token y abra el
// WebSocket; vencido el ticket, se exige pedir uno nuevo.
const TicketTTL = 30 * time.Second

// TicketIdentity transporta la identidad del usuario autenticado desde
// el handler `/api/bridge/ticket` hasta la validación del WebSocket. El
// WebSocket inicial no puede llevar `Authorization`, así que el ticket
// preserva estos datos durante el handshake.
type TicketIdentity struct {
	CajaID  string
	DNI     string
	Name    string
	Role    string
	IsAdmin bool
}

// Errores devueltos por `TicketStore`.
var (
	ErrTicketNotFound = errors.New("ticket no encontrado")
	ErrTicketExpired  = errors.New("ticket expirado")
	ErrTicketReused   = errors.New("ticket ya fue consumido")
)

type ticketEntry struct {
	TicketIdentity
	expiresAt time.Time
	consumed  bool
}

// TicketStore guarda tickets de un solo uso con TTL. Es seguro para uso
// concurrente. Vive en memoria del proceso API: si el servidor se
// reinicia, los tickets emitidos antes dejan de ser válidos (comportamiento
// aceptable para un token con vigencia de 30 s).
type TicketStore struct {
	mu  sync.Mutex
	m   map[string]*ticketEntry
	now func() time.Time
}

// NewTicketStore construye un store listo para usar. `now` es
// inyectable para pruebas determinísticas; pasar nil para usar
// `time.Now`.
func NewTicketStore(now func() time.Time) *TicketStore {
	if now == nil {
		now = time.Now
	}
	return &TicketStore{
		m:   make(map[string]*ticketEntry),
		now: now,
	}
}

// Issue genera un ticket aleatorio para la identidad dada, lo persiste
// con TTL por `TicketTTL` y devuelve el token.
//
// Antes de insertar barre entradas expiradas para que el mapa no crezca
// sin cota en operación normal (cada emisión viene de una petición
// autenticada, así que el ritmo lo marca el usuario del POS).
func (s *TicketStore) Issue(ident TicketIdentity) (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)

	s.mu.Lock()
	defer s.mu.Unlock()

	s.purgeLocked()

	s.m[token] = &ticketEntry{
		TicketIdentity: ident,
		expiresAt:      s.now().Add(TicketTTL),
	}
	return token, nil
}

// Consume valida y marca como usado un ticket. Devuelve la identidad
// asociada si el ticket era válido. Un ticket consumido no puede volver
// a usarse ni aunque esté dentro del TTL: la segunda llamada devuelve
// `ErrTicketReused`.
func (s *TicketStore) Consume(token string) (TicketIdentity, error) {
	if token == "" {
		return TicketIdentity{}, ErrTicketNotFound
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.m[token]
	if !ok {
		return TicketIdentity{}, ErrTicketNotFound
	}
	// Si ya fue consumido lo dejamos en el mapa durante el TTL para que
	// un segundo intento devuelva `ErrTicketReused` en lugar del genérico
	// `ErrTicketNotFound`. Eso facilita detectar reutilizaciones honestas
	// (dos pestañas) de las intencionales.
	if entry.consumed {
		return TicketIdentity{}, ErrTicketReused
	}
	if s.now().After(entry.expiresAt) {
		delete(s.m, token)
		return TicketIdentity{}, ErrTicketExpired
	}
	entry.consumed = true
	return entry.TicketIdentity, nil
}

// purgeLocked elimina entradas expiradas. Debe llamarse con `s.mu`
// tomado.
func (s *TicketStore) purgeLocked() {
	now := s.now()
	for k, v := range s.m {
		// Un ticket consumido se puede soltar en cuanto expiró; sobrevive
		// durante el TTL sólo para que `Consume` pueda distinguir "ya
		// usado" de "nunca existió" dentro de la ventana.
		if now.After(v.expiresAt) {
			delete(s.m, k)
		}
	}
}

// Len devuelve el número de tickets activos (consumidos o no, mientras
// no hayan sido podados). Útil únicamente para pruebas.
func (s *TicketStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}
