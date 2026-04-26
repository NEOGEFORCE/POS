package services

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// SSEEvent representa un evento que se enviará al cliente
type SSEEvent struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload"`
}

// SSEService gestiona las conexiones SSE y el broadcast de eventos
type SSEService struct {
	clients map[chan SSEEvent]bool
	mu      sync.Mutex
}

func (s *SSEService) StartHeartbeat() {
	ticker := time.NewTicker(15 * time.Second)
	go func() {
		for range ticker.C {
			s.Broadcast("ping", "heartbeat")
		}
	}()
}

func NewSSEService() *SSEService {
	return &SSEService{
		clients: make(map[chan SSEEvent]bool),
	}
}

// Subscribe añade un nuevo cliente al servicio
func (s *SSEService) Subscribe() chan SSEEvent {
	s.mu.Lock()
	defer s.mu.Unlock()

	ch := make(chan SSEEvent, 10) // Buffer para evitar bloqueos
	s.clients[ch] = true
	return ch
}

// Unsubscribe elimina un cliente
func (s *SSEService) Unsubscribe(ch chan SSEEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.clients[ch]; ok {
		delete(s.clients, ch)
		close(ch)
	}
}

// Broadcast envía un evento a todos los clientes conectados
func (s *SSEService) Broadcast(eventType string, payload interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()

	event := SSEEvent{
		Type:    eventType,
		Payload: payload,
	}

	for ch := range s.clients {
		select {
		case ch <- event:
		default:
			// Si el canal está lleno, omitimos para no bloquear el sistema
		}
	}
}

// BroadcastNewSale envía una notificación de nueva venta
func (s *SSEService) BroadcastNewSale(sale interface{}) {
	s.Broadcast("NEW_SALE", sale)
}

// FormatSSE formatea el evento para el protocolo SSE
func FormatSSE(event SSEEvent) (string, error) {
	data, err := json.Marshal(event)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("event: %s\ndata: %s\n\n", event.Type, string(data)), nil
}
