# Paquete de base de datos para produccion

Contiene dos archivos:

- `migrate.exe`: runner de migraciones autocontenido. No requiere Go instalado.
- `aplicar_cambios_bd.ps1`: respalda la base y aplica todas las migraciones pendientes.

## Uso

### Opcion A: solo consultar que falta (no cambia nada, POS puede estar encendido)

```powershell
.\aplicar_cambios_bd.ps1 -StatusOnly
```

### Opcion B: solo respaldo (se puede con el POS encendido)

```powershell
.\aplicar_cambios_bd.ps1 -BackupOnly
```

Crea y verifica el respaldo. No aplica ninguna migracion.

### Opcion C: respaldo + migraciones (requiere POS detenido)

1. Detener el POS:

```powershell
C:\Users\surti\Desktop\POS\nssm.exe stop POS_Server
```

2. Abrir PowerShell **como administrador** en la carpeta de este paquete y ejecutar:

```powershell
.\aplicar_cambios_bd.ps1 -ConfirmApply
```

3. NO iniciar el servicio todavia. Avisar para continuar con el despliegue.

## Proteccion de datos historicos

Las migraciones esperadas (**010** y **011**) son aditivas: crean tablas nuevas de
Smart Restock, una columna nueva en proveedores e indices. **No modifican cierres,
ventas, egresos ni montos registrados.**

Las migraciones antiguas 001 a 009 si contienen normalizaciones de datos historicos
(por ejemplo `cashier_closures.coins500`). Deberian estar aplicadas hace mucho.
Si el script detecta que alguna de esas esta pendiente, **se detiene** despues del
respaldo y no aplica nada, salvo que se agregue `-AllowLegacyMigrations`.

## Que hace

1. Lee la conexion desde el `.env` de produccion. No pide contraseñas.
2. Genera un respaldo `custom` de PostgreSQL y lo verifica con `pg_restore --list`.
3. Calcula SHA-256 y escribe `manifest.json`.
4. Ejecuta `status`, aplica las pendientes con `up --confirm` y vuelve a verificar.
5. Guarda `migracion.log` en la carpeta del respaldo.

Si algo falla, se detiene y conserva el respaldo. Nunca restaura solo.

## Importante

Despues de aplicar la migracion 011, el `server.exe` anterior ya no arranca.
El despliegue del binario nuevo debe hacerse en la misma ventana.

Los respaldos quedan en `C:\Users\surti\Desktop\Respaldo_BD` y se conservan los ultimos 14.
