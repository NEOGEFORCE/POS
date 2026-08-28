package refresher

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"gorm.io/gorm"
)

const (
	refreshTimeout     = 2 * time.Minute
	maxRefreshAttempts = 3
)

var allowedMaterializedViews = map[string]struct{}{
	"mv_dashboard_stats_monthly": {},
}

// RefresherService serializa y agrupa refrescos para no saturar PostgreSQL.
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

func GetRefresher() *RefresherService { return instance }

func (s *RefresherService) RequestRefresh(viewName string) {
	if _, ok := allowedMaterializedViews[viewName]; !ok {
		log.Printf("[RefresherService] vista rechazada: %q", viewName)
		return
	}
	select {
	case s.queue <- viewName:
	default:
		// La cola contiene eventos de invalidación, no datos. Descartar cuando
		// está llena es seguro porque un refresh pendiente cubre los anteriores.
		log.Printf("[RefresherService] cola llena; %s ya tiene refrescos pendientes", viewName)
	}
}

func (s *RefresherService) worker() {
	log.Println("[RefresherService] worker iniciado")
	for viewName := range s.queue {
		s.mu.Lock()
		if s.isBusy[viewName] || time.Since(s.lastRefresh[viewName]) < 10*time.Second {
			s.mu.Unlock()
			continue
		}
		s.isBusy[viewName] = true
		s.mu.Unlock()

		err := s.processRefresh(viewName)

		s.mu.Lock()
		s.isBusy[viewName] = false
		if err == nil {
			s.lastRefresh[viewName] = time.Now()
		}
		s.mu.Unlock()
	}
}

func concurrentRefreshStatement(viewName string) (string, error) {
	if _, ok := allowedMaterializedViews[viewName]; !ok {
		return "", fmt.Errorf("vista materializada no permitida: %q", viewName)
	}
	return "REFRESH MATERIALIZED VIEW CONCURRENTLY " + viewName, nil
}

func refreshRetryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	return time.Duration(1<<(attempt-1)) * time.Second
}

func (s *RefresherService) processRefresh(viewName string) error {
	statement, err := concurrentRefreshStatement(viewName)
	if err != nil {
		return err
	}

	started := time.Now()
	var lastErr error
	for attempt := 1; attempt <= maxRefreshAttempts; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), refreshTimeout)
		lastErr = s.db.WithContext(ctx).Exec(statement).Error
		cancel()
		if lastErr == nil {
			duration := time.Since(started)
			log.Printf("[RefresherService] %s refrescada concurrentemente en %v", viewName, duration)
			return nil
		}

		log.Printf("[RefresherService] intento %d/%d para %s fallo: %v", attempt, maxRefreshAttempts, viewName, lastErr)
		if attempt < maxRefreshAttempts {
			time.Sleep(refreshRetryDelay(attempt))
		}
	}

	// Nunca usar REFRESH sin CONCURRENTLY: bloquearía todas las lecturas de la MV.
	return fmt.Errorf("refresco concurrente de %s agotó reintentos: %w", viewName, lastErr)
}
