// Package orchestrator añade durabilidad al scheduler de jobs del POS.
//
// El scheduler anterior era robfig/cron puro dentro del proceso del API. Eso
// funciona mientras nada falle, pero en un PC de tienda que se apaga cada noche
// tenía tres agujeros:
//
//  1. Si el equipo estaba apagado a la hora de disparo, el job no ocurría y
//     nadie se enteraba (el respaldo nocturno de 21:20 es el caso grave).
//  2. Un fallo sólo dejaba un log.Printf; no había reintento ni historial.
//  3. Dos instancias de server.exe habrían duplicado todos los jobs.
//
// Este paquete envuelve el scheduler sin cambiar la lógica de negocio de cada
// job: registra cada ejecución en PostgreSQL, reclama la ventana con un INSERT
// idempotente, reintenta con backoff y recupera la última ocurrencia perdida.
package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
	"gorm.io/gorm"
)

const (
	// Ventana máxima hacia atrás que se revisa al arrancar para detectar
	// ocurrencias perdidas. 36h cubre un fin de semana con el PC apagado un
	// día entero sin dispararle una avalancha de jobs viejos al encender.
	catchUpLookback = 36 * time.Hour

	defaultTimeout     = 5 * time.Minute
	defaultMaxAttempts = 1
	maxRetryDelay      = 5 * time.Minute

	statusRunning     = "running"
	statusSuccess     = "success"
	statusFailed      = "failed"
	statusInterrupted = "interrupted"

	triggerSchedule = "schedule"
	triggerCatchUp  = "catch_up"
	triggerManual   = "manual"
)

// ErrJobNotFound se devuelve cuando se pide una acción sobre una clave que no
// está registrada en este proceso.
var ErrJobNotFound = errors.New("job no registrado")

// JobFunc es la unidad de trabajo. Debe respetar la cancelación del contexto:
// el orquestador lo cancela al vencer el timeout de la definición.
type JobFunc func(context.Context) error

// Definition describe el contrato operativo de un job. Se persiste en
// job_definitions para que un operador pueda inspeccionarlo o apagarlo con un
// UPDATE en producción, sin recompilar el binario.
type Definition struct {
	Key         string
	Description string
	// Schedule acepta cron estándar de 5 campos ("20 21 * * *") o "@every 5m".
	Schedule string
	// CatchUp ejecuta la última ocurrencia perdida al arrancar. Sólo tiene
	// sentido en jobs con hora fija; se ignora en jobs de intervalo.
	CatchUp     bool
	Timeout     time.Duration
	MaxAttempts int
}

type job struct {
	def      Definition
	run      JobFunc
	schedule cron.Schedule
}

// Orchestrator programa y audita los jobs registrados.
type Orchestrator struct {
	db        *gorm.DB
	location  *time.Location
	scheduler *cron.Cron

	mu    sync.RWMutex
	jobs  map[string]*job
	order []string

	// now es inyectable para poder testear el cálculo de ventanas.
	now func() time.Time
}

// New construye un orquestador anclado a la zona horaria indicada. Todas las
// expresiones cron se evalúan en esa zona, independientemente de la
// configuración del sistema operativo del PC de la tienda.
func New(db *gorm.DB, location *time.Location) *Orchestrator {
	if location == nil {
		location = time.UTC
	}
	return &Orchestrator{
		db:        db,
		location:  location,
		scheduler: cron.New(cron.WithLocation(location)),
		jobs:      make(map[string]*job),
		now:       func() time.Time { return time.Now().In(location) },
	}
}

// Register valida y registra un job. Debe llamarse antes de Start.
func (o *Orchestrator) Register(def Definition, fn JobFunc) error {
	key := strings.TrimSpace(def.Key)
	if key == "" {
		return errors.New("la definición del job necesita una clave")
	}
	if fn == nil {
		return fmt.Errorf("job %q sin función asociada", key)
	}

	schedule, err := cron.ParseStandard(def.Schedule)
	if err != nil {
		return fmt.Errorf("schedule inválido en job %q: %w", key, err)
	}

	def.Key = key
	if def.Timeout <= 0 {
		def.Timeout = defaultTimeout
	}
	if def.MaxAttempts < 1 {
		def.MaxAttempts = defaultMaxAttempts
	}

	o.mu.Lock()
	defer o.mu.Unlock()
	if _, exists := o.jobs[key]; exists {
		return fmt.Errorf("job duplicado: %q", key)
	}
	o.jobs[key] = &job{def: def, run: fn, schedule: schedule}
	o.order = append(o.order, key)
	return nil
}

// Start sincroniza definiciones, cierra corridas huérfanas, recupera las
// ocurrencias perdidas y arranca el scheduler.
func (o *Orchestrator) Start(ctx context.Context) error {
	if err := o.syncDefinitions(ctx); err != nil {
		return fmt.Errorf("sincronizando definiciones de jobs: %w", err)
	}
	if err := o.reapInterrupted(ctx); err != nil {
		// No es fatal: sólo deja historial impreciso.
		log.Printf("[orchestrator] no se pudieron cerrar corridas huérfanas: %v", err)
	}

	o.mu.RLock()
	registered := make([]*job, 0, len(o.order))
	for _, key := range o.order {
		registered = append(registered, o.jobs[key])
	}
	o.mu.RUnlock()

	for _, j := range registered {
		target := j
		if _, err := o.scheduler.AddFunc(target.def.Schedule, func() {
			now := o.now()
			o.execute(target, windowFor(target.schedule, now), triggerSchedule)
		}); err != nil {
			return fmt.Errorf("programando job %q: %w", target.def.Key, err)
		}
	}

	o.scheduler.Start()
	log.Printf("[orchestrator] %d jobs programados en %s", len(registered), o.location)

	// El catch-up corre en segundo plano y en serie: al encender el PC no
	// conviene disparar cinco jobs pesados a la vez contra PostgreSQL.
	go o.runCatchUp(registered)
	return nil
}

// Stop detiene el scheduler y espera a que terminen los jobs en vuelo.
func (o *Orchestrator) Stop(ctx context.Context) error {
	done := o.scheduler.Stop()
	select {
	case <-done.Done():
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// RunNow dispara un job de inmediato, saltándose el schedule. Queda registrado
// con trigger_source='manual'.
func (o *Orchestrator) RunNow(key string) error {
	o.mu.RLock()
	target, ok := o.jobs[key]
	o.mu.RUnlock()
	if !ok {
		return fmt.Errorf("%w: %s", ErrJobNotFound, key)
	}
	go o.execute(target, o.now().Truncate(time.Second), triggerManual)
	return nil
}

func (o *Orchestrator) runCatchUp(registered []*job) {
	now := o.now()
	for _, j := range registered {
		if !j.def.CatchUp || isInterval(j.schedule) {
			continue
		}
		missed, ok := previousOccurrence(j.schedule, now, catchUpLookback)
		if !ok {
			continue
		}
		// El reclamo por ventana decide si realmente se perdió: si ya existe
		// una corrida para ese scheduled_for, el INSERT no inserta y se salta.
		log.Printf("[orchestrator] revisando ocurrencia %s de %s", missed.Format(time.RFC3339), j.def.Key)
		o.execute(j, missed, triggerCatchUp)
	}
}

// execute reclama la ventana y corre el job con reintentos. Si la ventana ya
// fue reclamada (otra instancia, o un catch-up que no era necesario) retorna
// sin ejecutar nada.
func (o *Orchestrator) execute(j *job, scheduledFor time.Time, trigger string) {
	claimCtx, cancelClaim := context.WithTimeout(context.Background(), 15*time.Second)
	deadline := o.now().Add(j.def.Timeout)
	runID, claimed, err := o.claim(claimCtx, j.def.Key, scheduledFor, trigger, deadline)
	cancelClaim()

	if err != nil {
		log.Printf("[orchestrator] %s: fallo al reclamar la ventana %s: %v", j.def.Key, scheduledFor.Format(time.RFC3339), err)
		return
	}
	if !claimed {
		// Caso normal en catch-up y en jobs deshabilitados. No es un error.
		return
	}

	started := time.Now()
	var lastErr error
	attempts := 0

	for attempt := 1; attempt <= j.def.MaxAttempts; attempt++ {
		attempts = attempt
		runCtx, cancelRun := context.WithTimeout(context.Background(), j.def.Timeout)
		lastErr = j.run(runCtx)
		cancelRun()

		if lastErr == nil {
			break
		}
		log.Printf("[orchestrator] %s: intento %d/%d falló: %v", j.def.Key, attempt, j.def.MaxAttempts, lastErr)
		if attempt < j.def.MaxAttempts {
			time.Sleep(retryDelay(attempt))
		}
	}

	elapsed := time.Since(started)
	finishCtx, cancelFinish := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelFinish()

	if finishErr := o.finish(finishCtx, runID, attempts, elapsed, lastErr); finishErr != nil {
		log.Printf("[orchestrator] %s: no se pudo cerrar la corrida %d: %v", j.def.Key, runID, finishErr)
	}

	if lastErr != nil {
		log.Printf("[orchestrator] %s: agotó %d intento(s) en %v", j.def.Key, attempts, elapsed)
		return
	}
	log.Printf("[orchestrator] %s: completado en %v (%s)", j.def.Key, elapsed, trigger)
}

// claim inserta la corrida sólo si el job está habilitado y la ventana está
// libre. El índice único (job_key, scheduled_for) hace de exclusión mutua entre
// procesos, así que no hacen falta advisory locks (que serían frágiles porque
// GORM usa un pool de conexiones).
func (o *Orchestrator) claim(ctx context.Context, key string, scheduledFor time.Time, trigger string, deadline time.Time) (int64, bool, error) {
	const query = `
INSERT INTO job_runs (job_key, scheduled_for, trigger_source, status, started_at, deadline_at)
SELECT d.key, ?, ?, ?, NOW(), ?
FROM job_definitions d
WHERE d.key = ? AND d.enabled
ON CONFLICT (job_key, scheduled_for) DO NOTHING
RETURNING id`

	var ids []int64
	if err := o.db.WithContext(ctx).
		Raw(query, scheduledFor, trigger, statusRunning, deadline, key).
		Scan(&ids).Error; err != nil {
		return 0, false, err
	}
	if len(ids) == 0 {
		return 0, false, nil
	}
	return ids[0], true, nil
}

func (o *Orchestrator) finish(ctx context.Context, runID int64, attempts int, elapsed time.Duration, runErr error) error {
	status := statusSuccess
	var errText *string
	if runErr != nil {
		status = statusFailed
		message := truncateError(runErr.Error())
		errText = &message
	}

	const query = `
UPDATE job_runs
SET status = ?, attempts = ?, finished_at = NOW(), duration_ms = ?, error = ?
WHERE id = ?`

	return o.db.WithContext(ctx).
		Exec(query, status, attempts, elapsed.Milliseconds(), errText, runID).Error
}

func (o *Orchestrator) syncDefinitions(ctx context.Context) error {
	o.mu.RLock()
	defer o.mu.RUnlock()

	// enabled se omite del UPDATE a propósito: si un operador apagó un job en
	// producción, un despliegue no debe volver a encenderlo por sorpresa.
	const query = `
INSERT INTO job_definitions (key, description, schedule, timezone, catch_up, timeout_seconds, max_attempts)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (key) DO UPDATE SET
    description     = EXCLUDED.description,
    schedule        = EXCLUDED.schedule,
    timezone        = EXCLUDED.timezone,
    catch_up        = EXCLUDED.catch_up,
    timeout_seconds = EXCLUDED.timeout_seconds,
    max_attempts    = EXCLUDED.max_attempts,
    updated_at      = NOW()`

	for _, key := range o.order {
		def := o.jobs[key].def
		if err := o.db.WithContext(ctx).Exec(query,
			def.Key,
			def.Description,
			def.Schedule,
			o.location.String(),
			def.CatchUp,
			int(def.Timeout.Seconds()),
			def.MaxAttempts,
		).Error; err != nil {
			return fmt.Errorf("job %q: %w", def.Key, err)
		}
	}
	return nil
}

// reapInterrupted cierra las corridas que quedaron en 'running' porque el
// proceso murió. Sin esto, el índice único bloquearía para siempre esa ventana.
func (o *Orchestrator) reapInterrupted(ctx context.Context) error {
	const query = `
UPDATE job_runs
SET status = ?,
    finished_at = NOW(),
    error = COALESCE(error, '') || 'el proceso terminó antes de que el job completara'
WHERE status = ? AND deadline_at < NOW()`

	result := o.db.WithContext(ctx).Exec(query, statusInterrupted, statusRunning)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected > 0 {
		log.Printf("[orchestrator] %d corrida(s) marcadas como interrumpidas", result.RowsAffected)
	}
	return nil
}

// RunSummary es la última ejecución conocida de un job.
type RunSummary struct {
	ScheduledFor  time.Time  `json:"scheduledFor"`
	TriggerSource string     `json:"triggerSource"`
	Status        string     `json:"status"`
	Attempts      int        `json:"attempts"`
	StartedAt     time.Time  `json:"startedAt"`
	FinishedAt    *time.Time `json:"finishedAt"`
	DurationMs    *int64     `json:"durationMs"`
	Error         *string    `json:"error"`
}

// JobStatus combina la definición persistida, el próximo disparo calculado y la
// última corrida. Es lo que consume el panel de administración.
type JobStatus struct {
	Key            string      `json:"key"`
	Description    string      `json:"description"`
	Schedule       string      `json:"schedule"`
	Timezone       string      `json:"timezone"`
	Enabled        bool        `json:"enabled"`
	CatchUp        bool        `json:"catchUp"`
	TimeoutSeconds int         `json:"timeoutSeconds"`
	MaxAttempts    int         `json:"maxAttempts"`
	NextRun        *time.Time  `json:"nextRun"`
	LastRun        *RunSummary `json:"lastRun"`
	// Registered indica si este proceso conoce el job. Un job en la tabla pero
	// no registrado significa código viejo que ya no existe en el binario.
	Registered bool `json:"registered"`
}

// Status devuelve el estado de todos los jobs conocidos por la base.
func (o *Orchestrator) Status(ctx context.Context) ([]JobStatus, error) {
	type row struct {
		Key            string
		Description    string
		Schedule       string
		Timezone       string
		Enabled        bool
		CatchUp        bool
		TimeoutSeconds int
		MaxAttempts    int
		ScheduledFor   *time.Time
		TriggerSource  *string
		RunStatus      *string
		Attempts       *int
		StartedAt      *time.Time
		FinishedAt     *time.Time
		DurationMs     *int64
		Error          *string
	}

	const query = `
SELECT d.key, d.description, d.schedule, d.timezone, d.enabled, d.catch_up,
       d.timeout_seconds, d.max_attempts,
       r.scheduled_for, r.trigger_source, r.status AS run_status, r.attempts,
       r.started_at, r.finished_at, r.duration_ms, r.error
FROM job_definitions d
LEFT JOIN LATERAL (
    SELECT * FROM job_runs
    WHERE job_runs.job_key = d.key
    ORDER BY started_at DESC
    LIMIT 1
) r ON TRUE
ORDER BY d.key`

	var rows []row
	if err := o.db.WithContext(ctx).Raw(query).Scan(&rows).Error; err != nil {
		return nil, err
	}

	now := o.now()
	statuses := make([]JobStatus, 0, len(rows))
	for _, r := range rows {
		status := JobStatus{
			Key:            r.Key,
			Description:    r.Description,
			Schedule:       r.Schedule,
			Timezone:       r.Timezone,
			Enabled:        r.Enabled,
			CatchUp:        r.CatchUp,
			TimeoutSeconds: r.TimeoutSeconds,
			MaxAttempts:    r.MaxAttempts,
		}

		o.mu.RLock()
		j, registered := o.jobs[r.Key]
		o.mu.RUnlock()
		status.Registered = registered
		if registered && r.Enabled {
			next := j.schedule.Next(now)
			status.NextRun = &next
		}

		if r.RunStatus != nil && r.ScheduledFor != nil && r.StartedAt != nil {
			summary := &RunSummary{
				ScheduledFor: *r.ScheduledFor,
				Status:       *r.RunStatus,
				StartedAt:    *r.StartedAt,
				FinishedAt:   r.FinishedAt,
				DurationMs:   r.DurationMs,
				Error:        r.Error,
			}
			if r.TriggerSource != nil {
				summary.TriggerSource = *r.TriggerSource
			}
			if r.Attempts != nil {
				summary.Attempts = *r.Attempts
			}
			status.LastRun = summary
		}

		statuses = append(statuses, status)
	}
	return statuses, nil
}

// History devuelve las últimas corridas de un job, más recientes primero.
func (o *Orchestrator) History(ctx context.Context, key string, limit int) ([]RunSummary, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}

	const query = `
SELECT scheduled_for, trigger_source, status, attempts, started_at, finished_at, duration_ms, error
FROM job_runs
WHERE job_key = ?
ORDER BY started_at DESC
LIMIT ?`

	var history []RunSummary
	if err := o.db.WithContext(ctx).Raw(query, key, limit).Scan(&history).Error; err != nil {
		return nil, err
	}
	return history, nil
}

// SetEnabled enciende o apaga un job sin reiniciar el servicio. El cambio se
// respeta en el próximo disparo porque claim consulta job_definitions.enabled.
func (o *Orchestrator) SetEnabled(ctx context.Context, key string, enabled bool) error {
	result := o.db.WithContext(ctx).
		Exec(`UPDATE job_definitions SET enabled = ?, updated_at = NOW() WHERE key = ?`, enabled, key)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return fmt.Errorf("%w: %s", ErrJobNotFound, key)
	}
	return nil
}

// --- Helpers puros (testeables sin base de datos) ---

// windowFor traduce un disparo a la ventana canónica que lo identifica. Dos
// procesos distintos deben calcular la misma ventana para que el índice único
// funcione como exclusión mutua.
func windowFor(schedule cron.Schedule, now time.Time) time.Time {
	if delay, ok := intervalOf(schedule); ok {
		// Truncate opera sobre tiempo absoluto, así que es independiente de la
		// zona horaria de cada proceso.
		return now.UTC().Truncate(delay)
	}
	if prev, ok := previousOccurrence(schedule, now, time.Hour); ok {
		return prev
	}
	return now.Truncate(time.Minute)
}

// previousOccurrence busca la última hora de disparo esperada dentro de
// (now-lookback, now]. Se usa para nombrar ventanas y para el catch-up.
func previousOccurrence(schedule cron.Schedule, now time.Time, lookback time.Duration) (time.Time, bool) {
	if schedule == nil || lookback <= 0 {
		return time.Time{}, false
	}

	cursor := schedule.Next(now.Add(-lookback))
	var last time.Time
	found := false

	// Cota de seguridad: una expresión por segundo dentro de 36h daría muchas
	// iteraciones, así que se limita el recorrido.
	for i := 0; i < 100000; i++ {
		if cursor.IsZero() || cursor.After(now) {
			break
		}
		last = cursor
		found = true
		next := schedule.Next(cursor)
		if !next.After(cursor) {
			break
		}
		cursor = next
	}
	return last, found
}

func intervalOf(schedule cron.Schedule) (time.Duration, bool) {
	if constant, ok := schedule.(cron.ConstantDelaySchedule); ok && constant.Delay > 0 {
		return constant.Delay, true
	}
	return 0, false
}

func isInterval(schedule cron.Schedule) bool {
	_, ok := intervalOf(schedule)
	return ok
}

// retryDelay crece exponencialmente con techo, igual que el RefresherService.
func retryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 20 {
		return maxRetryDelay
	}
	delay := time.Duration(1<<(attempt-1)) * time.Second
	if delay > maxRetryDelay {
		return maxRetryDelay
	}
	return delay
}

// truncateError acota el mensaje guardado para que un error enorme (por
// ejemplo la salida completa de pg_dump) no infle la tabla de historial.
func truncateError(message string) string {
	const limit = 2000
	if len(message) <= limit {
		return message
	}
	return message[:limit] + "… (truncado)"
}
