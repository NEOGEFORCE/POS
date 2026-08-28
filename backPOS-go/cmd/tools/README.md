# Herramientas legacy (aisladas)

Este directorio conserva utilidades históricas de diagnóstico, reparación y limpieza. **No forman parte del build normal**: todos los `.go` requieren el build tag `tools_legacy`.

No se ofrece un comando soportado para ejecutar el directorio completo. Hay múltiples `main`, consultas específicas para datos antiguos y operaciones destructivas (`DELETE`, `UPDATE`, recreación de base). Los DSN que antes incluían credenciales quedaron neutralizados; varios archivos apuntan deliberadamente a un host no enrutable.

Antes de reutilizar cualquier herramienta:

1. Copiar la lógica necesaria a un comando nuevo y revisable; no ejecutar el archivo histórico directamente.
2. Obtener conexión únicamente desde variables de entorno, sin defaults de host, usuario, contraseña o base.
3. Añadir modo `--dry-run` y exigir `--confirm` para cualquier mutación.
4. Mostrar host y base destino, exigir respaldo restaurable y limitar la operación por IDs/rango explícito.
5. Observar todos los errores y ejecutar la mutación en una transacción cuando corresponda.
6. Validar primero en una base descartable. Nunca usar estas herramientas contra producción.

El tag existe para aislamiento y revisión forense, no como autorización operativa.
