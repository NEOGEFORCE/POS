import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_STALE_AFTER_MS,
  RECONNECT_MIN_INTERVAL_MS,
  isCatalogStale,
  shouldSyncCatalog,
  syncFloorForReason,
} from '../src/lib/catalog-sync-policy.mjs';

test('sin sincronizacion previa siempre corresponde sincronizar', () => {
  assert.equal(shouldSyncCatalog({ lastSyncAt: null, now: 1_000_000 }), true);
  assert.equal(shouldSyncCatalog({ lastSyncAt: undefined, now: 1_000_000 }), true);
  assert.equal(shouldSyncCatalog({ lastSyncAt: 0, now: 1_000_000 }), true);
});

test('respetamos el piso minimo entre sincronizaciones', () => {
  const now = 10 * 60 * 1000; // 10 min
  // Sincronizado hace 30s: no toca todavia.
  assert.equal(shouldSyncCatalog({ lastSyncAt: now - 30_000, now }), false);
  // Sincronizado hace exactamente el piso: si toca.
  assert.equal(shouldSyncCatalog({ lastSyncAt: now - DEFAULT_MIN_INTERVAL_MS, now }), true);
  // Piso configurable
  assert.equal(shouldSyncCatalog({ lastSyncAt: now - 5_000, now, minIntervalMs: 10_000 }), false);
  assert.equal(shouldSyncCatalog({ lastSyncAt: now - 20_000, now, minIntervalMs: 10_000 }), true);
});

test('valores invalidos no rompen la decision', () => {
  // now invalido: no podemos decidir, no sincronizamos.
  assert.equal(shouldSyncCatalog({ lastSyncAt: 1_000, now: Number.NaN }), false);
  // lastSyncAt invalido cuenta como sin sincronizacion previa.
  // @ts-expect-error probando entrada sucia
  assert.equal(shouldSyncCatalog({ lastSyncAt: 'ayer', now: 1_000 }), true);
});

test('reloj hacia atras: sincronizamos y dejamos que la marca se actualice', () => {
  // now menor que lastSyncAt puede pasar por cambios de hora u ordenamiento entre pestañas.
  assert.equal(shouldSyncCatalog({ lastSyncAt: 5_000, now: 1_000 }), true);
});

test('isCatalogStale marca vencido segun umbral', () => {
  const now = 60 * 60 * 1000;
  assert.equal(isCatalogStale({ lastSyncAt: null, now }), true);
  assert.equal(isCatalogStale({ lastSyncAt: now - 10_000, now }), false);
  assert.equal(isCatalogStale({ lastSyncAt: now - DEFAULT_STALE_AFTER_MS, now }), true);
  assert.equal(isCatalogStale({ lastSyncAt: now - 10_000, now, staleAfterMs: 5_000 }), true);
});

test('al reconectar el piso es mucho mas corto que el periodico', () => {
  assert.equal(syncFloorForReason('reconnect'), RECONNECT_MIN_INTERVAL_MS);
  assert.equal(syncFloorForReason('mount'), DEFAULT_MIN_INTERVAL_MS);
  assert.equal(syncFloorForReason('interval'), DEFAULT_MIN_INTERVAL_MS);
  assert.ok(
    syncFloorForReason('reconnect') < syncFloorForReason('interval'),
    'el piso de reconexion debe ser menor que el periodico',
  );
});

test('tras una caida de red el catalogo se refresca sin esperar el piso normal', () => {
  // Se sincronizo hace 2 min y volvio la red: con el piso periodico de 10 min
  // el cajero seguiria vendiendo offline contra precios viejos.
  const now = 30 * 60 * 1000;
  const lastSyncAt = now - 2 * 60 * 1000;

  assert.equal(
    shouldSyncCatalog({ lastSyncAt, now, minIntervalMs: syncFloorForReason('interval') }),
    false,
    'el disparo periodico no deberia correr todavia',
  );
  assert.equal(
    shouldSyncCatalog({ lastSyncAt, now, minIntervalMs: syncFloorForReason('reconnect') }),
    true,
    'la reconexion si deberia refrescar',
  );
});

test('una red intermitente no dispara una descarga por cada parpadeo', () => {
  // Dos eventos 'online' separados por 5 segundos: el segundo se descarta.
  const now = 30 * 60 * 1000;
  const lastSyncAt = now - 5_000;
  assert.equal(
    shouldSyncCatalog({ lastSyncAt, now, minIntervalMs: syncFloorForReason('reconnect') }),
    false,
  );
});
