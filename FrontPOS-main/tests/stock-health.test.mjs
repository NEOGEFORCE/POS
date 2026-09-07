import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STOCK_HEALTH,
  STOCK_HEALTH_THRESHOLDS,
  getCoverageDays,
  getStockHealth,
} from '../src/lib/stock-health.mjs';

// Regla del dueño: ratio = stock / minStock.
//   ROJO      ratio  < 0.25 (o stock <= 0)
//   AMARILLO  0.25 <= ratio < 0.75
//   VERDE     ratio >= 0.75
//   SIN_MINIMO cuando minStock <= 0 y stock > 0
// Los cortes son < (no <=): 0.25 exacto es amarillo, 0.75 exacto es verde.

test('agotado siempre es rojo, con o sin minimo configurado', () => {
  assert.equal(getStockHealth(0, 10).level, STOCK_HEALTH.CRITICAL);
  assert.equal(getStockHealth(0, 0).level, STOCK_HEALTH.CRITICAL);
  assert.equal(getStockHealth(-3, 10).level, STOCK_HEALTH.CRITICAL);
});

test('rojo por debajo del 25% del minimo (ratio 0.24 con minimo 100)', () => {
  const health = getStockHealth(24, 100);
  assert.equal(health.level, STOCK_HEALTH.CRITICAL);
  assert.equal(health.ratio, 0.24);
});

test('ratio 0.25 exacto ya es amarillo (borde inclusivo del lado de la advertencia)', () => {
  const health = getStockHealth(25, 100);
  assert.equal(health.level, STOCK_HEALTH.WARNING);
  assert.equal(health.ratio, 0.25);
});

test('ratio 0.74 sigue siendo amarillo (por debajo del corte de verde)', () => {
  const health = getStockHealth(74, 100);
  assert.equal(health.level, STOCK_HEALTH.WARNING);
  assert.equal(health.ratio, 0.74);
});

test('ratio 0.75 exacto es verde (borde inclusivo del lado del optimo)', () => {
  const health = getStockHealth(75, 100);
  assert.equal(health.level, STOCK_HEALTH.OPTIMAL);
  assert.equal(health.ratio, 0.75);
});

test('por encima del minimo sigue siendo verde', () => {
  assert.equal(getStockHealth(100, 100).level, STOCK_HEALTH.OPTIMAL);
  assert.equal(getStockHealth(180, 100).level, STOCK_HEALTH.OPTIMAL);
});

test('el rango 75-100% (que antes era BAJO) ahora es verde', () => {
  // Antes 90/100 caia en BAJO. Con la regla nueva es OPTIMO.
  assert.equal(getStockHealth(90, 100).level, STOCK_HEALTH.OPTIMAL);
});

test('sin minimo configurado no se juzga contra el minimo', () => {
  assert.equal(getStockHealth(18, 0).level, STOCK_HEALTH.UNSET);
  assert.equal(getStockHealth(1, 0).level, STOCK_HEALTH.UNSET);
  // Pero agotado sigue siendo rojo aunque no haya minimo.
  assert.equal(getStockHealth(0, 0).level, STOCK_HEALTH.CRITICAL);
});

test('umbrales exportados matchean los cortes del negocio', () => {
  assert.equal(STOCK_HEALTH_THRESHOLDS.CRITICAL_MAX, 0.25);
  assert.equal(STOCK_HEALTH_THRESHOLDS.WARNING_MAX, 0.75);
});

test('cobertura en dias segun la demanda real', () => {
  assert.equal(getCoverageDays(18, 0.23), 78);
  assert.equal(getCoverageDays(18, 0), null);
  assert.equal(getCoverageDays(0, 1.5), 0);
});
