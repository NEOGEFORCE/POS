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
//   SIN_MINIMO cuando minStock <= 0 (cualquiera sea el stock, incluso 0)
// Los cortes son < (no <=): 0.25 exacto es amarillo, 0.75 exacto es verde.
//
// REGLA DURA (2026-10-08): si minStock <= 0, SIEMPRE SIN_MINIMO. Jamás
// rojo/crítico ni siquiera con stock 0 o negativo. Un producto sin mínimo
// configurado no debe generar falsas alertas (puede ser una decisión
// explícita del dueño: descontinuado, estacional, de consignación).

test('agotado con minimo configurado sigue siendo rojo', () => {
  assert.equal(getStockHealth(0, 10).level, STOCK_HEALTH.CRITICAL);
  assert.equal(getStockHealth(-3, 10).level, STOCK_HEALTH.CRITICAL);
});

test('minStock=0 con stock=0 es SIN_MINIMO (jamas rojo/critico)', () => {
  const health = getStockHealth(0, 0);
  assert.equal(health.level, STOCK_HEALTH.UNSET);
  assert.equal(health.label, 'Sin mínimo definido');
  assert.equal(health.ratio, null);
});

test('minStock=0 con stock positivo tambien es SIN_MINIMO', () => {
  assert.equal(getStockHealth(5, 0).level, STOCK_HEALTH.UNSET);
  assert.equal(getStockHealth(500, 0).level, STOCK_HEALTH.UNSET);
});

test('minStock=0 con stock negativo (dato bruto) sigue siendo SIN_MINIMO, nunca rojo', () => {
  // Un stock negativo puede ser dato bruto arrastrado por una venta en
  // negativo; igual, sin minimo configurado no hay regla contra la cual
  // juzgarlo. La UI nunca puede pintarlo rojo.
  assert.equal(getStockHealth(-7, 0).level, STOCK_HEALTH.UNSET);
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
  // Incluso agotado con minStock=0 es SIN_MINIMO (no CRITICAL). Un producto
  // sin minimo no debe aparecer como critico aunque llegue a 0.
  assert.equal(getStockHealth(0, 0).level, STOCK_HEALTH.UNSET);
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
