// Package dbbackup provee utilidades compartidas para los jobs de respaldo de BD.
//
// El caso de uso primario es localizar el ejecutable `pg_dump` en sistemas
// Windows con instalaciones heterogéneas: una máquina puede tener PostgreSQL
// en `C:\Program Files\PostgreSQL\18\` mientras otra lo tiene en
// `S:\Program Files\PostgreSQL\17\`. Sin un mecanismo de fallback, el .env
// tendría que ajustarse por máquina.
package dbbackup

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ResolvePgDumpPath busca el ejecutable pg_dump en este orden:
//
//  1. La variable de entorno PG_DUMP_PATH (si está definida y el archivo existe).
//  2. Rutas conocidas de instalación de PostgreSQL en Windows: probando las
//     unidades C, S, D, E y versiones de PostgreSQL desde la más reciente
//     hacia atrás (18 → 12).
//  3. El PATH del sistema vía exec.LookPath("pg_dump").
//
// Retorna (resolvedPath, attemptedPaths, nil) si lo encuentra, o
// ("", attemptedPaths, err) si fracasa. El slice attemptedPaths sirve para
// generar mensajes de error descriptivos que muestren al operador qué
// ubicaciones se inspeccionaron.
func ResolvePgDumpPath() (string, []string, error) {
	var attempted []string

	// 1. PG_DUMP_PATH del .env tiene prioridad: si el usuario lo configuró
	// explícitamente y el archivo existe, lo respetamos.
	envRaw := strings.TrimSpace(strings.Trim(os.Getenv("PG_DUMP_PATH"), "\""))
	if envRaw != "" && envRaw != "." {
		cleaned := filepath.Clean(envRaw)
		attempted = append(attempted, cleaned+" (PG_DUMP_PATH)")
		if info, err := os.Stat(cleaned); err == nil && !info.IsDir() {
			return cleaned, attempted, nil
		}
	}

	// 2. Rutas conocidas de instalación de PostgreSQL en Windows.
	// Iteramos por unidad y versión en orden descendente para preferir la
	// instalación más reciente.
	drives := []string{"C", "S", "D", "E"}
	versions := []string{"18", "17", "16", "15", "14", "13", "12"}
	for _, drive := range drives {
		for _, ver := range versions {
			candidate := filepath.Join(
				drive+":\\",
				"Program Files",
				"PostgreSQL",
				ver,
				"bin",
				"pg_dump.exe",
			)
			attempted = append(attempted, candidate)
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate, attempted, nil
			}
		}
	}

	// 3. PATH del sistema (incluye instalaciones que añaden pg_dump al PATH).
	if pathBin, err := exec.LookPath("pg_dump"); err == nil && pathBin != "" {
		attempted = append(attempted, pathBin+" ($PATH)")
		return pathBin, attempted, nil
	}
	attempted = append(attempted, "$PATH (no encontrado)")

	return "", attempted, fmt.Errorf(
		"pg_dump no encontrado: revisadas %d rutas conocidas y el PATH del sistema",
		len(attempted)-1,
	)
}

// FormatAttemptedPaths retorna las rutas inspeccionadas como string
// multi-línea con bullets, listo para pegarse en mensajes de Telegram o logs.
// Solo incluye la primera ruta de cada unidad para no abrumar al lector
// (con todas las versiones quedaría una lista larguísima).
func FormatAttemptedPaths(attempted []string) string {
	if len(attempted) == 0 {
		return "(ninguna)"
	}
	var sb strings.Builder
	// Mostramos únicamente las rutas representativas: la del .env (si existe)
	// + la "raíz" de cada unidad probada + el PATH. Saltamos las versiones
	// intermedias porque siempre son la misma raíz con distinto número.
	seenDrive := map[string]bool{}
	for _, p := range attempted {
		// PG_DUMP_PATH y PATH siempre se muestran.
		if strings.HasSuffix(p, "(PG_DUMP_PATH)") || strings.Contains(p, "$PATH") {
			sb.WriteString("• ")
			sb.WriteString(p)
			sb.WriteString("\n")
			continue
		}
		// Por cada unidad solo mostramos la primera versión probada.
		if len(p) >= 2 && p[1] == ':' {
			drive := p[:2]
			if seenDrive[drive] {
				continue
			}
			seenDrive[drive] = true
			// Reemplazamos la versión con "*" para indicar que se probaron varias.
			parts := strings.Split(p, "\\")
			if len(parts) >= 5 {
				parts[len(parts)-3] = "{18..12}"
				p = strings.Join(parts, "\\")
			}
			sb.WriteString("• ")
			sb.WriteString(p)
			sb.WriteString("\n")
		}
	}
	return sb.String()
}
