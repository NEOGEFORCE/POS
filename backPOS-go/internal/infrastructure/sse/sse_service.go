package sse

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

var (
	instance *SSEService
	once     sync.Once
)

// GetSSEService devuelve la instancia única del servicio (Singleton)
func GetSSEService() *SSEService {
	once.Do(func() {
		instance = &SSEService{
			clients: make(map[chan SSEEvent]bool),
		}
		instance.startHeartbeat()
	})
	return instance
}

func (s *SSEService) startHeartbeat() {
	ticker := time.NewTicker(15 * time.Second)
	go func() {
		for range ticker.C {
			s.Broadcast("ping", "heartbeat")
		}
	}()
}

// Subscribe añade un nuevo cliente al servicio
func (s *SSEService) Subscribe() chan SSEEvent {
	s.mu.Lock()
	defer s.mu.Unlock()

	ch := make(chan SSEEvent, 100) // Aumentamos buffer para estabilidad
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

// --- HELPER BROADCASTS PARA SINCRONIZACIÓN TOTAL ---

func (s *SSEService) BroadcastNewSale(sale interface{}) {
	s.Broadcast("NEW_SALE", sale)
	s.BroadcastDashboardUpdate()
}

func (s *SSEService) BroadcastDashboardUpdate() {
	s.Broadcast("DASHBOARD_UPDATE", map[string]string{"refresh": "true"})
}

func (s *SSEService) BroadcastProductUpdate(payload interface{}) {
	s.Broadcast("PRODUCT_UPDATE", payload)
}

func (s *SSEService) BroadcastInventoryUpdate(payload interface{}) {
	s.Broadcast("INVENTORY_UPDATE", payload)
}

func (s *SSEService) BroadcastExpenseUpdate(payload interface{}) {
	s.Broadcast("EXPENSE_UPDATE", payload)
	s.BroadcastDashboardUpdate()
}

func (s *SSEService) BroadcastCustomerUpdate(payload interface{}) {
	s.Broadcast("CUSTOMER_UPDATE", payload)
}

func (s *SSEService) BroadcastCategoryUpdate(payload interface{}) {
	s.Broadcast("CATEGORY_UPDATE", payload)
}

func (s *SSEService) BroadcastSupplierUpdate(payload interface{}) {
	s.Broadcast("SUPPLIER_UPDATE", payload)
}

func (s *SSEService) BroadcastAuditUpdate() {
	s.Broadcast("AUDIT_UPDATE", nil)
}

// FormatSSE formatea el evento para el protocolo SSE
func FormatSSE(event SSEEvent) (string, error) {
	data, err := json.Marshal(event)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("event: %s\ndata: %s\n\n", event.Type, string(data)), nil
}
