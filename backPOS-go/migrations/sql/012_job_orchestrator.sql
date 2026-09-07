-- Sprint 8: orquestador durable de jobs.
--
-- El scheduler anterior vivía sólo en memoria (robfig/cron dentro del proceso
-- del API): si el PC estaba apagado a la hora de disparo el job simplemente no
-- ocurría, un fallo sólo dejaba un log, y dos instancias de server.exe podían
-- duplicar el respaldo nocturno. Estas dos tablas dan durabilidad, historial,
-- reintentos e idempotencia por ventana programada.

CREATE TABLE IF NOT EXISTS job_definitions (
    key             TEXT PRIMARY KEY,
    description     TEXT        NOT NULL DEFAULT '',
    schedule        TEXT        NOT NULL,
    timezone        TEXT        NOT NULL DEFAULT 'America/Bogota',
    enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
    catch_up        BOOLEAN     NOT NULL DEFAULT FALSE,
    timeout_seconds INTEGER     NOT NULL DEFAULT 300 CHECK (timeout_seconds > 0),
    max_attempts    INTEGER     NOT NULL DEFAULT 1   CHECK (max_attempts >= 1),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN job_definitions.catch_up IS
    'Si es TRUE, al arrancar se ejecuta la última ocurrencia perdida (PC apagado).';
COMMENT ON COLUMN job_definitions.enabled IS
    'Permite apagar un job en producción con un UPDATE, sin recompilar.';

CREATE TABLE IF NOT EXISTS job_runs (
    id             BIGSERIAL PRIMARY KEY,
    job_key        TEXT        NOT NULL REFERENCES job_definitions(key) ON DELETE CASCADE,
    scheduled_for  TIMESTAMPTZ NOT NULL,
    trigger_source TEXT        NOT NULL DEFAULT 'schedule'
                   CHECK (trigger_source IN ('schedule', 'catch_up', 'manual')),
    status         TEXT        NOT NULL
                   CHECK (status IN ('running', 'success', 'failed', 'interrupted')),
    attempts       INTEGER     NOT NULL DEFAULT 0,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deadline_at    TIMESTAMPTZ NOT NULL,
    finished_at    TIMESTAMPTZ,
    duration_ms    BIGINT,
    error          TEXT
);

-- Idempotencia y exclusión mutua sin advisory locks: el reclamo de una ventana
-- es un INSERT ... ON CONFLICT DO NOTHING. Si no inserta fila, otro proceso (u
-- otra pasada del scheduler) ya es dueño de esa ventana y esta pasada se salta.
-- Se prefiere esto a pg_advisory_lock porque GORM usa un pool y el lock de
-- sesión podría tomarse en una conexión y liberarse en otra.
CREATE UNIQUE INDEX IF NOT EXISTS ux_job_runs_key_window
    ON job_runs (job_key, scheduled_for);

CREATE INDEX IF NOT EXISTS ix_job_runs_key_started
    ON job_runs (job_key, started_at DESC);

-- Índice parcial para el reaper de arranque, que busca corridas que quedaron
-- 'running' porque el proceso murió a mitad de camino.
CREATE INDEX IF NOT EXISTS ix_job_runs_running
    ON job_runs (deadline_at)
    WHERE status = 'running';
