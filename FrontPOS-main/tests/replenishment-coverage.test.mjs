import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LEAD_DAYS,
  FALLBACK_COVERAGE_DAYS,
  describeCoverage,
  replenishmentCoverageDays,
} from "../src/lib/replenishment-coverage.mjs";

// ============================================================================
// COBERTURA SEGÚN AGENDA — reglas que pide el dueño
// ============================================================================
//
// Sprint 2026-10-01: la sugerencia v2 ya consume `scheduling.ReplenishmentCoverageDays`
// del backend. En Go quedan caminos legacy (`inventory_service.go`) que todavía
// usan el fallback 30 y la fórmula `avgDaily*14`. La migración de esos
// caminos la hace el agente de backend; aquí dejamos una fuente puramente
// front que:
//
//   1. Documenta la fórmula esperada (visitas, lead, fallback 14).
//   2. Sirve como defensa cuando el backend viejo no envía `coverageDays`.
//   3. Prueba los casos clave: semanal=8, dos visitas=peor hueco, sin agenda=
//      fallback máximo 14.

test("constante FALLBACK_COVERAGE_DAYS fija el tope en 14", () => {
  assert.equal(FALLBACK_COVERAGE_DAYS, 14,
    "si cambia este número hay que sincronizar con backend.scheduling");
  assert.ok(DEFAULT_LEAD_DAYS >= 1, "el lead por defecto no puede ser 0");
});

test("proveedor semanal (visita única + 1 día de entrega) = 8 días", () => {
  // Caso dominante del POS: la mayoría de proveedores pasan una vez por
  // semana. Con lead=1 ⇒ 7 + 1 = 8.
  const result = replenishmentCoverageDays({
    visitDays: ["Miercoles"],
    deliveryDays: ["Jueves"],
  });
  assert.equal(result.days, 8);
  assert.equal(result.source, "configured");
  assert.equal(result.cycle, 7);
  assert.equal(result.leadDays, 1);
});

test("proveedor semanal con lead más largo cubre el total completo", () => {
  const result = replenishmentCoverageDays({
    visitDays: ["Lunes"],
    deliveryDays: ["Jueves"], // 3 días después
  });
  // 7 ciclo + 3 lead = 10 (dentro del tope aún si el ciclo es 7)
  assert.equal(result.cycle, 7);
  assert.equal(result.leadDays, 3);
  assert.equal(result.days, 10);
});

test("dos visitas por semana ⇒ se cubre el PEOR HUECO entre visitas", () => {
  // Martes y Viernes: Mar→Vie son 3 días, Vie→Mar son 4 días. El peor es 4.
  const result = replenishmentCoverageDays({
    visitDays: ["Martes", "Viernes"],
    deliveryDays: ["Miercoles", "Sabado"],
  });
  assert.equal(result.cycle, 4,
    "el ciclo debe ser el peor hueco entre visitas (Vie→Mar = 4)");
  assert.equal(result.leadDays, 1, "miércoles cae un día después del martes");
  assert.equal(result.days, 5);
});

test("sin agenda configurada cae al fallback de 14 días (no al legacy 30)", () => {
  const result = replenishmentCoverageDays({});
  assert.equal(result.days, FALLBACK_COVERAGE_DAYS);
  assert.equal(result.days, 14,
    "el fallback debe ser EXACTAMENTE 14; el legacy 30 duplicaba inventario");
  assert.equal(result.source, "fallback");
  assert.equal(result.cycle, 0);
});

test("fallback respeta un lead explícito aunque no haya visitas", () => {
  const result = replenishmentCoverageDays({ leadDays: 3 });
  assert.equal(result.leadDays, 3);
  // El resultado se mantiene en el fallback: sin agenda, el tope manda.
  assert.equal(result.source, "fallback");
  assert.equal(result.days, FALLBACK_COVERAGE_DAYS);
});

test("acepta variantes de nombres (acentos, mayúsculas, duplicados)", () => {
  const result = replenishmentCoverageDays({
    visitDays: ["LUNES", "lunes", "Lúnes"],
    deliveryDays: ["Miércoles"],
  });
  assert.equal(result.visitDays.length, 1, "los duplicados se descartan");
  assert.equal(result.cycle, 7);
  assert.equal(result.leadDays, 2, "lunes→miércoles = 2 días");
  assert.equal(result.days, 9);
});

test("tolera schedules basura sin romper", () => {
  assert.doesNotThrow(() => replenishmentCoverageDays());
  assert.doesNotThrow(() => replenishmentCoverageDays(null));
  assert.doesNotThrow(() => replenishmentCoverageDays({ visitDays: ["lunes_falso", null, 42] }));
  const result = replenishmentCoverageDays({ visitDays: ["lunes_falso", null, 42] });
  assert.equal(result.source, "fallback");
  assert.equal(result.days, FALLBACK_COVERAGE_DAYS);
});

test("una visita con MULTIPLES entregas elige la más próxima para el lead", () => {
  const result = replenishmentCoverageDays({
    visitDays: ["Lunes"],
    deliveryDays: ["Viernes", "Martes"], // Martes es lead=1
  });
  assert.equal(result.leadDays, 1);
  assert.equal(result.days, 8);
});

test("describeCoverage usa textos sólo cuando hay datos reales", () => {
  const weekly = replenishmentCoverageDays({ visitDays: ["Lunes"], deliveryDays: ["Martes"] });
  assert.match(describeCoverage(weekly), /Visita semanal/);
  const two = replenishmentCoverageDays({ visitDays: ["Martes", "Viernes"], deliveryDays: ["Miercoles"] });
  assert.match(describeCoverage(two), /Dos visitas/);
  const none = replenishmentCoverageDays({});
  assert.match(describeCoverage(none), /Sin agenda/);
});
