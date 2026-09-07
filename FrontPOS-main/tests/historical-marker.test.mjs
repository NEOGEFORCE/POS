import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HISTORICAL_MARKER_CODE,
  isHistoricalMarkerError,
  extractHistoricalMarkerMetadata,
  buildMergeRequest,
  stripStaleTimestamp,
  isAdminRole,
} from '../src/lib/historical-marker.mjs';

// ---------------------------------------------------------------------------
// Detección del error HISTORICAL_MARKER_RESERVED
// ---------------------------------------------------------------------------
// La UI reacciona ante un ApiError concreto: 409 + code
// HISTORICAL_MARKER_RESERVED. Cualquier otra combinación cae al toast
// genérico y no abre el diálogo de fusión.

test('constante expuesta con el nombre exacto del contrato', () => {
  assert.equal(HISTORICAL_MARKER_CODE, 'HISTORICAL_MARKER_RESERVED');
});

test('detecta el 409 con code en la raíz de data (contrato preferido)', () => {
  const err = {
    status: 409,
    data: {
      code: 'HISTORICAL_MARKER_RESERVED',
      metadata: { realBarcode: 'AAA', markerBarcode: 'BBB', markerName: '[HISTORICO] X' },
    },
  };
  assert.equal(isHistoricalMarkerError(err), true);
});

test('detecta el 409 aunque el code venga anidado en data.error (backend actual)', () => {
  const err = {
    status: 409,
    data: {
      error: {
        code: 'HISTORICAL_MARKER_RESERVED',
        metadata: { realBarcode: 'AAA', markerBarcode: 'BBB', markerName: '[HISTORICO] X' },
      },
    },
  };
  assert.equal(isHistoricalMarkerError(err), true);
});

test('rechaza status distintos de 409 aunque el code coincida', () => {
  const err = {
    status: 400,
    data: { code: 'HISTORICAL_MARKER_RESERVED' },
  };
  assert.equal(isHistoricalMarkerError(err), false);
});

test('rechaza 409 con code diferente', () => {
  const err = { status: 409, data: { code: 'ERR_DUPLICATE_ENTRY' } };
  assert.equal(isHistoricalMarkerError(err), false);
});

test('rechaza errores sin data o mal formados', () => {
  assert.equal(isHistoricalMarkerError(null), false);
  assert.equal(isHistoricalMarkerError(undefined), false);
  assert.equal(isHistoricalMarkerError('boom'), false);
  assert.equal(isHistoricalMarkerError({ status: 409 }), false);
  assert.equal(isHistoricalMarkerError({ status: 409, data: 'texto' }), false);
});

// ---------------------------------------------------------------------------
// Extracción de metadata
// ---------------------------------------------------------------------------

test('extrae metadata con codigos y nombre, recortando espacios', () => {
  const err = {
    status: 409,
    data: {
      code: 'HISTORICAL_MARKER_RESERVED',
      metadata: {
        realBarcode: '  770ABC  ',
        markerBarcode: 'MARCA1',
        markerName: '  [HISTORICO] PAN VIEJO  ',
      },
    },
  };
  assert.deepEqual(extractHistoricalMarkerMetadata(err), {
    realBarcode: '770ABC',
    markerBarcode: 'MARCA1',
    markerName: '[HISTORICO] PAN VIEJO',
  });
});

test('extrae metadata anidada bajo data.error', () => {
  const err = {
    status: 409,
    data: {
      error: {
        code: 'HISTORICAL_MARKER_RESERVED',
        metadata: {
          realBarcode: 'AAA',
          markerBarcode: 'BBB',
          markerName: '[HISTORICO] AGUA',
        },
      },
    },
  };
  assert.deepEqual(extractHistoricalMarkerMetadata(err), {
    realBarcode: 'AAA',
    markerBarcode: 'BBB',
    markerName: '[HISTORICO] AGUA',
  });
});

test('devuelve null cuando falta realBarcode o markerBarcode', () => {
  const missingReal = {
    status: 409,
    data: {
      code: 'HISTORICAL_MARKER_RESERVED',
      metadata: { realBarcode: '', markerBarcode: 'MARCA', markerName: 'algo' },
    },
  };
  assert.equal(extractHistoricalMarkerMetadata(missingReal), null);

  const missingMarker = {
    status: 409,
    data: {
      code: 'HISTORICAL_MARKER_RESERVED',
      metadata: { realBarcode: 'REAL', markerBarcode: '   ', markerName: 'algo' },
    },
  };
  assert.equal(extractHistoricalMarkerMetadata(missingMarker), null);
});

test('devuelve null cuando no hay metadata usable', () => {
  assert.equal(extractHistoricalMarkerMetadata(null), null);
  assert.equal(extractHistoricalMarkerMetadata({ status: 409 }), null);
  assert.equal(extractHistoricalMarkerMetadata({ status: 409, data: {} }), null);
  assert.equal(
    extractHistoricalMarkerMetadata({ status: 409, data: { metadata: 'string' } }),
    null,
  );
});

test('markerName vacío es tolerado (el diálogo pinta un fallback amigable)', () => {
  const err = {
    status: 409,
    data: {
      code: 'HISTORICAL_MARKER_RESERVED',
      metadata: { realBarcode: 'AAA', markerBarcode: 'BBB' },
    },
  };
  assert.deepEqual(extractHistoricalMarkerMetadata(err), {
    realBarcode: 'AAA',
    markerBarcode: 'BBB',
    markerName: '',
  });
});

// ---------------------------------------------------------------------------
// Construcción del payload de fusión
// ---------------------------------------------------------------------------
// El body del endpoint admin es literalmente { realBarcode, markerBarcode }.
// Cualquier otra clave debe quedar fuera para no confundir al backend.

test('buildMergeRequest emite solo las dos claves esperadas', () => {
  const request = buildMergeRequest({
    realBarcode: 'REAL',
    markerBarcode: 'MARC',
    markerName: '[HISTORICO] X',
  });
  assert.deepEqual(request, { realBarcode: 'REAL', markerBarcode: 'MARC' });
  assert.deepEqual(Object.keys(request), ['realBarcode', 'markerBarcode']);
});

test('buildMergeRequest devuelve null cuando faltan códigos o coinciden', () => {
  assert.equal(buildMergeRequest(null), null);
  assert.equal(buildMergeRequest({ realBarcode: '', markerBarcode: 'X' }), null);
  assert.equal(buildMergeRequest({ realBarcode: 'X', markerBarcode: '' }), null);
  assert.equal(buildMergeRequest({ realBarcode: 'SAME', markerBarcode: 'SAME' }), null);
});

test('buildMergeRequest recorta espacios antes de comparar', () => {
  assert.equal(buildMergeRequest({ realBarcode: '  DUP  ', markerBarcode: 'DUP' }), null);
  assert.deepEqual(
    buildMergeRequest({ realBarcode: '  A  ', markerBarcode: '  B  ' }),
    { realBarcode: 'A', markerBarcode: 'B' },
  );
});

// ---------------------------------------------------------------------------
// stripStaleTimestamp: evita el error de optimistic locking en el reintento
// ---------------------------------------------------------------------------

test('stripStaleTimestamp elimina updatedAt y updated_at', () => {
  const payload = {
    barcode: 'X',
    productName: 'ARROZ',
    updatedAt: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    salePrice: 5000,
  };
  const clean = stripStaleTimestamp(payload);
  assert.equal(clean.updatedAt, undefined);
  assert.equal(clean.updated_at, undefined);
  assert.equal(clean.barcode, 'X');
  assert.equal(clean.productName, 'ARROZ');
  assert.equal(clean.salePrice, 5000);
  // No muta el original.
  assert.equal(payload.updatedAt, '2026-05-01T00:00:00Z');
});

test('stripStaleTimestamp tolera payloads vacíos o no-objeto', () => {
  assert.deepEqual(stripStaleTimestamp({}), {});
  assert.equal(stripStaleTimestamp(null), null);
  assert.equal(stripStaleTimestamp('texto'), 'texto');
});

// ---------------------------------------------------------------------------
// isAdminRole
// ---------------------------------------------------------------------------

test('isAdminRole acepta las variantes de admin usadas en el POS', () => {
  assert.equal(isAdminRole('admin'), true);
  assert.equal(isAdminRole('Admin'), true);
  assert.equal(isAdminRole('ADMIN'), true);
  assert.equal(isAdminRole('  administrador '), true);
  assert.equal(isAdminRole('superadmin'), true);
});

test('isAdminRole rechaza empleados, cajeros o valores vacíos', () => {
  assert.equal(isAdminRole('empleado'), false);
  assert.equal(isAdminRole('employee'), false);
  assert.equal(isAdminRole('cajero'), false);
  assert.equal(isAdminRole(''), false);
  assert.equal(isAdminRole(null), false);
  assert.equal(isAdminRole(undefined), false);
});
