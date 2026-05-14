package refresher

import (
	"log"
	"sync"
	"time"

	"gorm.io/gorm"
)

// RefresherService gestiona el refresco de vistas materializadas de forma asíncrona
// y evita la saturación de la base de datos mediante debouncing y control de concurrencia.
type RefresherService struct {
	db          *gorm.DB
	queue       chan string
	isBusy      map[string]bool
	mu          sync.Mutex
	lastRefresh map[string]time.Time
}

var (
	instance *RefresherService
	once     sync.Once
)

// GetRefresherService devuelve la instancia única del servicio (Singleton)
func GetRefresherService(db *gorm.DB) *RefresherService {
	once.Do(func() {
		instance = &RefresherService{
			db:          db,
			queue:       make(chan string, 100),
			isBusy:      make(map[string]bool),
			lastRefresh: make(map[string]time.Time),
		}
		go instance.worker()
	})
	return instance
}

// GetRefresher devuelve la instancia ya inicializada
func GetRefresher() *RefresherService {
	return instance
}

// RequestRefresh solicita el refresco de una vista materializada
func (s *RefresherService) RequestRefresh(viewName string) {
	select {
	case s.queue <- viewName:
		// Solicitud encolada
	default:
		// Cola llena, ignoramos (ya hay demasiadas pendientes)
		log.Printf("⚠️ [RefresherService] Cola llena, ignorando refresco de %s", viewName)
	}
}

func (s *RefresherService) worker() {
	log.Println("🚀 [RefresherService] Worker iniciado")
	for viewName := range s.queue {
		s.mu.Lock()
		// Evitar refrescos si ya está ocupado o si se refrescó hace menos de 10 segundos (Debounce optimizado para HFT)
		if s.isBusy[viewName] || time.Since(s.lastRefresh[viewName]) < 10*time.Second {
			s.mu.Unlock()
			continue
		}
		s.isBusy[viewName] = true
		s.mu.Unlock()

		// Realizar el refresco
		s.processRefresh(viewName)

		s.mu.Lock()
		s.isBusy[viewName] = false
		s.lastRefresh[viewName] = time.Now()
		s.mu.Unlock()
	}
}

func (s *RefresherService) processRefresh(viewName string) {
	start := time.Now()
	log.Printf("🔄 [RefresherService] Iniciando refresco de %s...", viewName)
	
	// Intentar refresco concurrente primero (no bloquea lecturas en Postgres)
	// IMPORTANTE: Requiere un índice único en la vista materializada
	err := s.db.Exec("REFRESH MATERIALIZED VIEW CONCURRENTLY " + viewName).Error
	if err != nil {
		log.Printf("⚠️ [RefresherService] Error en refresco concurrente de %s: %v. Intentando normal (BLOQUEANTE)...", viewName, err)
		// Si falla el concurrente, intentamos el normal como último recurso (ESTO PUEDE CONGELAR LECTURAS)
		if err := s.db.Exec("REFRESH MATERIALIZED VIEW " + viewName).Error; err != nil {
			log.Printf("❌ [RefresherService] Error crítico en refresco de %s: %v", viewName, err)
		}
	}
	
	duration := time.Since(start)
	if duration > 2*time.Second {
		log.Printf("⚠️ [RefresherService] ALERTA: Refresco de %s tardó demasiado (%v). Considere optimizar la consulta.", viewName, duration)
	} else {
		log.Printf("✅ [RefresherService] %s refrescada en %v", viewName, duration)
	}
}
