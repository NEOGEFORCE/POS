# Lector Balanza Portátil — DEPRECATED

Este directorio ha sido unificado con `../scale-bridge/`.

## Migración

Usa `../scale-bridge/index.js` en su lugar. Es la versión unificada con mejoras:

- Filtrado de peso estable (evita broadcasts innecesarios)
- Mínimo de peso configurable (ignora ruido)
- Logs de debug eliminados en producción
- Compatible con ambas configuraciones (desktop y portátil)

## Configuración

```bash
cd ../scale-bridge
SCALE_PORT=COM3 SCALE_WS_PORT=9876 node index.js
```
