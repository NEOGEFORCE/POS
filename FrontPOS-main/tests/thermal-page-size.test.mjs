import test from "node:test";
import assert from "node:assert/strict";

import {
  CSS_PX_PER_INCH,
  MAX_THERMAL_PAGE_HEIGHT_MM,
  MIN_THERMAL_PAGE_HEIGHT_MM,
  MM_PER_INCH,
  buildThermalPageRule,
  cssPixelsToMm,
  resolveThermalPageHeightMm,
  resolveThermalWidthMm,
} from "../src/lib/thermal-page-size.mjs";

test("resolveThermalWidthMm respeta presets 58mm y 80mm", () => {
  assert.equal(resolveThermalWidthMm("58mm"), 58);
  assert.equal(resolveThermalWidthMm("80mm"), 80);
});

test("resolveThermalWidthMm prioriza el ancho CUSTOM exacto", () => {
  assert.equal(resolveThermalWidthMm("58mm", 76.5), 76.5);
  assert.equal(resolveThermalWidthMm("80mm", 62.25), 62.25);
  assert.equal(resolveThermalWidthMm("80mm", 0), 80);
  assert.equal(resolveThermalWidthMm("58mm", Number.NaN), 58);
});

test("cssPixelsToMm usa la conversión CSS estándar 96 px por pulgada", () => {
  assert.equal(CSS_PX_PER_INCH, 96);
  assert.equal(MM_PER_INCH, 25.4);
  assert.ok(Math.abs(cssPixelsToMm(96) - 25.4) < 1e-9);
  assert.ok(Math.abs(cssPixelsToMm(192) - 50.8) < 1e-9);
  assert.equal(cssPixelsToMm(0), 0);
});

test("resolveThermalPageHeightMm suma cola de seguridad y redondea hacia arriba", () => {
  // 480 CSS px = 127 mm; +2 mm = 129 mm exactos.
  assert.equal(resolveThermalPageHeightMm(480), 129);
  // Nunca devuelve menos que el mínimo físico aunque el ticket sea diminuto.
  assert.equal(resolveThermalPageHeightMm(1), MIN_THERMAL_PAGE_HEIGHT_MM);
  // Un ticket patológico no puede crear una página infinita.
  assert.equal(resolveThermalPageHeightMm(1_000_000), MAX_THERMAL_PAGE_HEIGHT_MM);
});

test("buildThermalPageRule emite dos dimensiones físicas y margin 0", () => {
  assert.equal(
    buildThermalPageRule(80, 129),
    "@page { size: 80mm 129mm; margin: 0; }",
  );
  assert.equal(
    buildThermalPageRule(58, 74.26),
    "@page { size: 58mm 74.3mm; margin: 0; }",
  );
});

test("buildThermalPageRule nunca emite el inválido `size: ancho auto`", () => {
  for (const width of [58, 76.5, 80]) {
    const rule = buildThermalPageRule(width, 100);
    assert.doesNotMatch(rule, /\bauto\b/i);
    assert.match(rule, new RegExp(`size: ${width}mm 100mm`));
  }
});
