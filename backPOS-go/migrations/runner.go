package migrations

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"

	"gorm.io/gorm"
)

const advisoryLockID int64 = 764527934011

var concurrentIndexPattern = regexp.MustCompile(`(?im)^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+ON\s+`)

type AppliedMigration struct {
	Version     int64     `gorm:"column:version;primaryKey"`
	Name        string    `gorm:"column:name"`
	Checksum    string    `gorm:"column:checksum"`
	AppliedAt   time.Time `gorm:"column:applied_at"`
	ExecutionMS int64     `gorm:"column:execution_ms"`
}

type Status struct {
	Version   int64
	Name      string
	Checksum  string
	Applied   bool
	AppliedAt time.Time
}

func ensureMigrationTable(ctx context.Context, db *gorm.DB) error {
	const query = `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version BIGINT PRIMARY KEY,
			name TEXT NOT NULL,
			checksum TEXT NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			execution_ms BIGINT NOT NULL DEFAULT 0
		)`
	if err := db.WithContext(ctx).Exec(query).Error; err != nil {
		return fmt.Errorf("creando schema_migrations: %w", err)
	}
	return nil
}

func migrationTableExists(ctx context.Context, db *gorm.DB) (bool, error) {
	var exists bool
	if err := db.WithContext(ctx).Raw(`SELECT to_regclass('public.schema_migrations') IS NOT NULL`).Scan(&exists).Error; err != nil {
		return false, fmt.Errorf("comprobando schema_migrations: %w", err)
	}
	return exists, nil
}

func loadApplied(ctx context.Context, db *gorm.DB) ([]AppliedMigration, error) {
	var applied []AppliedMigration
	if err := db.WithContext(ctx).Table("schema_migrations").Order("version ASC").Find(&applied).Error; err != nil {
		return nil, fmt.Errorf("leyendo schema_migrations: %w", err)
	}
	return applied, nil
}

func validateApplied(catalog []Migration, applied []AppliedMigration) error {
	known := make(map[int64]Migration, len(catalog))
	for _, migration := range catalog {
		known[migration.Version] = migration
	}
	for _, record := range applied {
		migration, ok := known[record.Version]
		if !ok {
			return fmt.Errorf("la base tiene la migración desconocida %03d_%s; el binario puede ser anterior al esquema", record.Version, record.Name)
		}
		if record.Name != migration.Name {
			return fmt.Errorf("la migración %03d cambió de nombre: BD=%q binario=%q", record.Version, record.Name, migration.Name)
		}
		if record.Checksum != migration.Checksum {
			return fmt.Errorf("checksum distinto para %03d_%s; una migración aplicada no debe editarse", migration.Version, migration.Name)
		}
	}
	return nil
}

func Statuses(ctx context.Context, db *gorm.DB) ([]Status, error) {
	catalog, err := Catalog()
	if err != nil {
		return nil, err
	}
	exists, err := migrationTableExists(ctx, db)
	if err != nil {
		return nil, err
	}
	var applied []AppliedMigration
	if exists {
		applied, err = loadApplied(ctx, db)
		if err != nil {
			return nil, err
		}
		if err := validateApplied(catalog, applied); err != nil {
			return nil, err
		}
	}

	byVersion := make(map[int64]AppliedMigration, len(applied))
	for _, record := range applied {
		byVersion[record.Version] = record
	}
	statuses := make([]Status, 0, len(catalog))
	for _, migration := range catalog {
		record, ok := byVersion[migration.Version]
		statuses = append(statuses, Status{
			Version:   migration.Version,
			Name:      migration.Name,
			Checksum:  migration.Checksum,
			Applied:   ok,
			AppliedAt: record.AppliedAt,
		})
	}
	return statuses, nil
}

// VerifyCurrent sólo consulta metadatos; nunca crea tablas ni aplica cambios.
func VerifyCurrent(ctx context.Context, db *gorm.DB) error {
	statuses, err := Statuses(ctx, db)
	if err != nil {
		return err
	}
	pending := make([]string, 0)
	for _, status := range statuses {
		if !status.Applied {
			pending = append(pending, fmt.Sprintf("%03d_%s", status.Version, status.Name))
		}
	}
	if len(pending) > 0 {
		return fmt.Errorf("esquema no preparado; migraciones pendientes: %s; ejecute el comando migrate status/up antes de iniciar el API", strings.Join(pending, ", "))
	}
	return nil
}

func recordMigration(ctx context.Context, db *gorm.DB, migration Migration, elapsed time.Duration) error {
	record := AppliedMigration{
		Version:     migration.Version,
		Name:        migration.Name,
		Checksum:    migration.Checksum,
		AppliedAt:   time.Now().UTC(),
		ExecutionMS: elapsed.Milliseconds(),
	}
	if err := db.WithContext(ctx).Table("schema_migrations").Create(&record).Error; err != nil {
		return fmt.Errorf("registrando %03d_%s: %w", migration.Version, migration.Name, err)
	}
	return nil
}

func dropInvalidConcurrentIndex(ctx context.Context, db *gorm.DB, statement string) error {
	matches := concurrentIndexPattern.FindStringSubmatch(statement)
	if matches == nil {
		return nil
	}
	indexName := matches[1]
	var state struct {
		Exists bool `gorm:"column:exists"`
		Valid  bool `gorm:"column:valid"`
	}
	const query = `
		SELECT COUNT(*) > 0 AS exists,
		       COALESCE(BOOL_AND(i.indisvalid), false) AS valid
		FROM pg_index i
		JOIN pg_class c ON c.oid = i.indexrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema() AND c.relname = ?`
	if err := db.WithContext(ctx).Raw(query, indexName).Scan(&state).Error; err != nil {
		return fmt.Errorf("comprobando índice concurrente %s: %w", indexName, err)
	}
	if state.Exists && !state.Valid {
		log.Printf("⚠️ Eliminando índice inválido antes de reintentar: %s", indexName)
		if err := db.WithContext(ctx).Exec(`DROP INDEX CONCURRENTLY IF EXISTS "` + indexName + `"`).Error; err != nil {
			return fmt.Errorf("eliminando índice inválido %s: %w", indexName, err)
		}
	}
	return nil
}

func executeMigration(ctx context.Context, db *gorm.DB, migration Migration) error {
	if migration.Apply != nil {
		return migration.Apply(ctx, db)
	}
	if migration.Transactional {
		if err := db.WithContext(ctx).Exec(migration.Source).Error; err != nil {
			return err
		}
		return nil
	}
	for _, statement := range splitSQLStatements(migration.Source) {
		if err := dropInvalidConcurrentIndex(ctx, db, statement); err != nil {
			return err
		}
		if err := db.WithContext(ctx).Exec(statement).Error; err != nil {
			return err
		}
	}
	return nil
}

// ApplyPending es el único punto que crea el historial y aplica el catálogo.
func ApplyPending(ctx context.Context, db *gorm.DB) error {
	catalog, err := Catalog()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Connection(func(connection *gorm.DB) error {
		if err := connection.Exec("SELECT pg_advisory_lock(?)", advisoryLockID).Error; err != nil {
			return fmt.Errorf("adquiriendo bloqueo de migraciones: %w", err)
		}
		defer func() {
			unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := connection.WithContext(unlockCtx).Exec("SELECT pg_advisory_unlock(?)", advisoryLockID).Error; err != nil {
				log.Printf("⚠️ no se pudo liberar advisory lock de migraciones: %v", err)
			}
		}()

		if err := ensureMigrationTable(ctx, connection); err != nil {
			return err
		}
		applied, err := loadApplied(ctx, connection)
		if err != nil {
			return err
		}
		if err := validateApplied(catalog, applied); err != nil {
			return err
		}
		appliedVersions := make(map[int64]struct{}, len(applied))
		for _, record := range applied {
			appliedVersions[record.Version] = struct{}{}
		}

		for _, migration := range catalog {
			if _, ok := appliedVersions[migration.Version]; ok {
				continue
			}
			started := time.Now()
			log.Printf("🔄 Aplicando %03d_%s (transactional=%t)", migration.Version, migration.Name, migration.Transactional)
			if migration.Transactional {
				err = connection.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
					if err := executeMigration(ctx, tx, migration); err != nil {
						return err
					}
					return recordMigration(ctx, tx, migration, time.Since(started))
				})
			} else {
				err = executeMigration(ctx, connection, migration)
				if err == nil {
					err = recordMigration(ctx, connection, migration, time.Since(started))
				}
			}
			if err != nil {
				return fmt.Errorf("falló %03d_%s: %w", migration.Version, migration.Name, err)
			}
			log.Printf("✅ Aplicada %03d_%s en %s", migration.Version, migration.Name, time.Since(started).Round(time.Millisecond))
		}
		return nil
	})
}

// splitSQLStatements separa scripts no transaccionales respetando strings,
// identificadores, comentarios y bloques dollar-quoted de PostgreSQL.
func splitSQLStatements(source string) []string {
	var statements []string
	start := 0
	inSingle, inDouble, inLineComment, inBlockComment := false, false, false, false
	dollarTag := ""

	for i := 0; i < len(source); i++ {
		if inLineComment {
			if source[i] == '\n' {
				inLineComment = false
			}
			continue
		}
		if inBlockComment {
			if i+1 < len(source) && source[i] == '*' && source[i+1] == '/' {
				inBlockComment = false
				i++
			}
			continue
		}
		if dollarTag != "" {
			if strings.HasPrefix(source[i:], dollarTag) {
				i += len(dollarTag) - 1
				dollarTag = ""
			}
			continue
		}
		if inSingle {
			if source[i] == '\'' {
				if i+1 < len(source) && source[i+1] == '\'' {
					i++
				} else {
					inSingle = false
				}
			}
			continue
		}
		if inDouble {
			if source[i] == '"' {
				if i+1 < len(source) && source[i+1] == '"' {
					i++
				} else {
					inDouble = false
				}
			}
			continue
		}

		if i+1 < len(source) && source[i] == '-' && source[i+1] == '-' {
			inLineComment = true
			i++
			continue
		}
		if i+1 < len(source) && source[i] == '/' && source[i+1] == '*' {
			inBlockComment = true
			i++
			continue
		}
		switch source[i] {
		case '\'':
			inSingle = true
		case '"':
			inDouble = true
		case '$':
			if end := strings.IndexByte(source[i+1:], '$'); end >= 0 {
				tag := source[i : i+end+2]
				valid := true
				for _, ch := range tag[1 : len(tag)-1] {
					if !(ch == '_' || ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9') {
						valid = false
						break
					}
				}
				if valid {
					dollarTag = tag
					i += len(tag) - 1
				}
			}
		case ';':
			statement := strings.TrimSpace(source[start:i])
			if statement != "" && !onlySQLComments(statement) {
				statements = append(statements, statement)
			}
			start = i + 1
		}
	}
	if statement := strings.TrimSpace(source[start:]); statement != "" && !onlySQLComments(statement) {
		statements = append(statements, statement)
	}
	return statements
}

func onlySQLComments(statement string) bool {
	lines := strings.Split(statement, "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(trimmed, "--") {
			return false
		}
	}
	return true
}
