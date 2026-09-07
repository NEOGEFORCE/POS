import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HISTORICAL_MARKER_CODE,
    isHistoricalMarkerError,
    extractHistoricalMarkerMetadata,
    buildMergeRequest,
} from '../src/lib/historical-marker.mjs';

// ApiError es una clase que sólo expone `status` y `data`. Los helpers puros
// que probamos aquí no dependen del prototipo, así que basta con un objeto
// plano con esas mismas propiedades para reproducir el error real que apiFetch
// lanza al frontend (ver src/lib/api-error.ts). Importar la clase directamente
// obligaría a un loader TS en `node --test`, lo cual rompería la ejecución
// del resto de la suite.
function makeApiError(status, data) {
    return { name: 'ApiError', status, data, message: data?.message ?? 'ApiError' };
}

// ---------------------------------------------------------------------------
// Contrato JSON end-to-end Go ↔ Next.
// ---------------------------------------------------------------------------
// El backend (backPOS-go/internal/adapters/handlers/product_handler.go, en la
// rama del error tipado HistoricalMarkerReservedError) emite EXACTAMENTE este
// envelope al frontend cuando el operador intenta reasignar un código de
// barras retenido por un marcador '[HISTORICO]':
//
//   {
//     "success": false,
//     "message": "...",
//     "error": {
//       "code": "HISTORICAL_MARKER_RESERVED",
//       "message": "...",
//       "metadata": { "realBarcode", "markerBarcode", "markerName" }
//     }
//   }
//
// El backend fija este contrato con
// TestHistoricalMarkerReservedJSONContract (ver
// product_handler_errors_contract_test.go). Este test es su espejo en el
// frontend: consume la misma fixture y verifica que los helpers puros que
// alimentan al AlertDialog (`isHistoricalMarkerError`,
// `extractHistoricalMarkerMetadata`, `buildMergeRequest`) la procesan
// correctamente. Si alguien cambia una punta del contrato sin actualizar la
// otra, uno de los dos tests falla.

const BACKEND_RESPONSE_BODY = {
    success: false,
    message: 'Código de barras reservado por un marcador histórico',
    error: {
        code: 'HISTORICAL_MARKER_RESERVED',
        message: 'Código de barras reservado por un marcador histórico',
        metadata: {
            // El producto real (que se estaba editando) tiene el código
            // BARCODE_REAL_ACTUAL. El operador intentó renombrarlo a
            // BARCODE_DESEADO, que está retenido por el marcador '[HISTORICO]'.
            // Los dos códigos SON DISTINTOS por definición del conflicto: si
            // fueran iguales no habría choque y el update pasaría.
            realBarcode: '7700000000001',
            markerBarcode: '7701234567890',
            markerName: '[HISTORICO] COCA COLA 350ML',
        },
    },
};

test('el envelope crudo (tal como lo emite Go c.JSON) alimenta el helper de detección', () => {
    // Simulamos el ApiError que arma apiFetch al recibir un 409:
    //   const errorData = await clonedRes.json().catch(() => null);
    //   throw new ApiError(errorMsg, res.status, errorData);
    const err = makeApiError(409, BACKEND_RESPONSE_BODY);

    assert.equal(isHistoricalMarkerError(err), true, 'el frontend debe detectar el 409 con code HISTORICAL_MARKER_RESERVED');
    assert.equal(err.status, 409);
    assert.equal(err.data.error.code, HISTORICAL_MARKER_CODE);
});

test('el envelope crudo produce metadata con las tres claves esperadas', () => {
    const err = makeApiError(409, BACKEND_RESPONSE_BODY);

    const metadata = extractHistoricalMarkerMetadata(err);
    assert.deepEqual(metadata, {
        realBarcode: '7700000000001',
        markerBarcode: '7701234567890',
        markerName: '[HISTORICO] COCA COLA 350ML',
    });

    // Y la metadata alimenta el body del endpoint admin de fusión con
    // exactamente { realBarcode, markerBarcode } — sin markerName ni sobras,
    // y con dos códigos distintos como exige el repositorio Postgres
    // (MergeHistoricalMarker rechaza real == marker).
    const mergeReq = buildMergeRequest(metadata);
    assert.deepEqual(mergeReq, {
        realBarcode: '7700000000001',
        markerBarcode: '7701234567890',
    });
});

test('un envelope sin metadata (contrato incompleto) devuelve null en la extracción', () => {
    // Este caso protege contra una regresión donde el backend olvida
    // adjuntar metadata (o donde el shape cambia). El frontend NO debe
    // abrir el AlertDialog con datos vacíos; en su lugar caerá al toast
    // genérico definido en products/page.tsx.
    const err = makeApiError(409, {
        success: false,
        message: 'Código de barras reservado por un marcador histórico',
        error: {
            code: 'HISTORICAL_MARKER_RESERVED',
            message: 'Código de barras reservado por un marcador histórico',
        },
    });

    assert.equal(isHistoricalMarkerError(err), true, 'la detección sigue viva aunque falte metadata');
    assert.equal(extractHistoricalMarkerMetadata(err), null, 'sin metadata usable, extract debe devolver null');
});

test('un envelope 500 (no 409) no dispara el flujo de fusión aunque contenga el code', () => {
    // Defensa en profundidad: si por error el backend emitiera el code con
    // otro status (por ejemplo 500 tras un rewrite), no queremos abrir el
    // AlertDialog. La UI de fusión sólo se ofrece cuando el backend es
    // explícito sobre el conflicto (409).
    const err = makeApiError(500, {
        success: false,
        message: 'boom',
        error: {
            code: 'HISTORICAL_MARKER_RESERVED',
            message: 'boom',
            metadata: {
                realBarcode: 'A',
                markerBarcode: 'B',
                markerName: '[HISTORICO] X',
            },
        },
    });

    assert.equal(isHistoricalMarkerError(err), false);
});
