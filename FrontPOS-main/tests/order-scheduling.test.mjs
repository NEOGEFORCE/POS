import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENDA_SOURCE,
  LEAD_TIME_SOURCE,
  LEARN_MIN_SAMPLES,
  addDaysBogotaIso,
  describeAgendaSource,
  describeLeadTimeSource,
  groupSuggestionsBySupplier,
  isSupplierFilterActive,
  resolveExpectedDeliveryDate,
  summarizeGroupSchedule,
  summarizeSupplierAgenda,
} from "../src/lib/order-scheduling.mjs";

const HERMARLY = {
  productId: "leche-1L",
  productName: "LECHE ENTERA 1L",
  primarySupplierId: 10,
  supplierName: "HERMARLY",
  supplierLeadDays: 3,
  nextVisitDate: "2026-01-19",
  nextDeliveryDate: "2026-01-21",
  leadTimeSource: LEAD_TIME_SOURCE.CONFIGURED_DAYS,
};

const RINVAL = {
  productId: "yogur-vaso",
  productName: "YOGUR VASO",
  primarySupplierId: 20,
  supplierName: "RINVAL",
  supplierLeadDays: 2,
  nextVisitDate: "2026-01-18",
  nextDeliveryDate: "2026-01-20",
  leadTimeSource: LEAD_TIME_SOURCE.CONFIGURED_DAYS,
};

const SOFT_FRESH = {
  productId: "helado-1L",
  productName: "HELADO 1L",
  primarySupplierId: 30,
  supplierName: "SOFT & FRESH",
  supplierLeadDays: 7,
  nextVisitDate: null,
  nextDeliveryDate: null,
  leadTimeSource: LEAD_TIME_SOURCE.DEFAULT,
};

test("sin filtro se agrupa por proveedor primario y se ordena alfabeticamente", () => {
  const groups = groupSuggestionsBySupplier([SOFT_FRESH, HERMARLY, RINVAL], "global");
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups.map((group) => group.supplierName),
    ["HERMARLY", "RINVAL", "SOFT & FRESH"],
  );
  assert.equal(groups[0].supplierId, 10);
  assert.equal(groups[0].items.length, 1);
});

test("con filtro activo la pantalla colapsa a UN solo grupo (bug de HERMARLY / RINVAL / SOFT & FRESH)", () => {
  // Escenario del bug: el usuario elige RINVAL pero el backend devolvio filas
  // cuyo primary sigue apuntando a otros proveedores. Aun asi la UI debe
  // pintar UN solo grupo.
  const misAttributed = [
    { ...HERMARLY, supplierName: "RINVAL", primarySupplierId: 20 },
    { ...RINVAL },
    { ...SOFT_FRESH, supplierName: "RINVAL", primarySupplierId: 20 },
  ];
  const groups = groupSuggestionsBySupplier(misAttributed, "20");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].supplierId, 20);
  assert.equal(groups[0].supplierName, "RINVAL");
  assert.equal(groups[0].items.length, 3);
});

test("filtro activo devuelve grupo vacio cuando el backend no devolvio filas", () => {
  const groups = groupSuggestionsBySupplier([], "20");
  assert.deepEqual(groups, []);
});

test("productos sin proveedor primario caen al bucket 'unassigned' cuando no hay filtro", () => {
  const orphan = { ...HERMARLY, primarySupplierId: null, supplierName: "" };
  const groups = groupSuggestionsBySupplier([orphan], "global");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "unassigned");
  assert.equal(groups[0].supplierId, null);
  assert.equal(groups[0].supplierName, "Sin proveedor asignado");
});

test("isSupplierFilterActive reconoce las variantes de la URL", () => {
  assert.equal(isSupplierFilterActive("global"), false);
  assert.equal(isSupplierFilterActive(""), false);
  assert.equal(isSupplierFilterActive("0"), false);
  assert.equal(isSupplierFilterActive(null), false);
  assert.equal(isSupplierFilterActive(undefined), false);
  assert.equal(isSupplierFilterActive("20"), true);
  assert.equal(isSupplierFilterActive(20), true);
  assert.equal(isSupplierFilterActive("  15  "), true);
});

test("cuando el grupo tiene dias configurados se usa el nextDeliveryDate mas cercano", () => {
  const items = [
    { ...HERMARLY, nextDeliveryDate: "2026-01-23" },
    { ...HERMARLY, productId: "yogur", nextDeliveryDate: "2026-01-20" },
    { ...HERMARLY, productId: "queso", nextDeliveryDate: "2026-01-22" },
  ];
  const resolved = resolveExpectedDeliveryDate(items, { today: new Date("2026-01-15T12:00:00Z") });
  assert.equal(resolved.isoDate, "2026-01-20");
  assert.equal(resolved.source, LEAD_TIME_SOURCE.CONFIGURED_DAYS);
  assert.equal(resolved.hasConfiguredDays, true);
  assert.equal(resolved.leadDaysUsed, 0);
});

test("sin dias configurados cae a hoy + lead time efectivo (dando fechas cortas cuando el proveedor las trae)", () => {
  const items = [
    { ...SOFT_FRESH, supplierLeadDays: 3, leadTimeSource: LEAD_TIME_SOURCE.EXPLICIT_LEAD_TIME },
    { ...SOFT_FRESH, productId: "otro", supplierLeadDays: 2, leadTimeSource: LEAD_TIME_SOURCE.EXPLICIT_LEAD_TIME },
  ];
  const resolved = resolveExpectedDeliveryDate(items, { today: new Date("2026-01-15T12:00:00Z") });
  assert.equal(resolved.hasConfiguredDays, false);
  assert.equal(resolved.leadDaysUsed, 3);
  assert.equal(resolved.source, LEAD_TIME_SOURCE.EXPLICIT_LEAD_TIME);
  assert.equal(resolved.isoDate, "2026-01-18");
  assert.equal(resolved.nextDeliveryDate, null);
});

test("sin lead time del grupo se usa el fallback de 7 dias (bug original de fechas larguisimas se controla acotando)", () => {
  const items = [{ ...SOFT_FRESH, supplierLeadDays: 0, leadTimeSource: LEAD_TIME_SOURCE.DEFAULT }];
  const resolved = resolveExpectedDeliveryDate(items, { today: new Date("2026-01-15T12:00:00Z") });
  assert.equal(resolved.leadDaysUsed, 7);
  assert.equal(resolved.isoDate, "2026-01-22");
});

test("addDaysBogotaIso emite YYYY-MM-DD en zona Bogota aunque el reloj este en UTC", () => {
  assert.equal(addDaysBogotaIso(new Date("2026-01-15T12:00:00Z"), 0), "2026-01-15");
  assert.equal(addDaysBogotaIso(new Date("2026-01-15T12:00:00Z"), 5), "2026-01-20");
  // 04:00 UTC del 16 = 23:00 del 15 en Bogota
  assert.equal(addDaysBogotaIso(new Date("2026-01-16T04:00:00Z"), 0), "2026-01-15");
});

test("describeLeadTimeSource distingue calculo confiable de estimacion", () => {
  assert.equal(describeLeadTimeSource(LEAD_TIME_SOURCE.CONFIGURED_DAYS).trusted, true);
  assert.equal(describeLeadTimeSource(LEAD_TIME_SOURCE.LEARNED_DAYS).trusted, true);
  for (const source of [
    LEAD_TIME_SOURCE.EXPLICIT_LEAD_TIME,
    LEAD_TIME_SOURCE.VISIT_FREQUENCY_LEARNED,
    LEAD_TIME_SOURCE.DEFAULT,
    "otro",
    null,
  ]) {
    assert.equal(describeLeadTimeSource(source).trusted, false);
  }
});

test("summarizeGroupSchedule detecta cuando falta configurar dias en el proveedor", () => {
  const configured = summarizeGroupSchedule([HERMARLY, { ...HERMARLY, productId: "queso" }]);
  assert.equal(configured.allConfigured, true);
  assert.equal(configured.missingSchedule, false);
  assert.equal(configured.source, LEAD_TIME_SOURCE.CONFIGURED_DAYS);

  const missing = summarizeGroupSchedule([SOFT_FRESH, { ...SOFT_FRESH, productId: "b" }]);
  assert.equal(missing.allConfigured, false);
  assert.equal(missing.anyConfigured, false);
  assert.equal(missing.missingSchedule, true);
  assert.equal(missing.source, LEAD_TIME_SOURCE.DEFAULT);

  const mixed = summarizeGroupSchedule([HERMARLY, SOFT_FRESH]);
  assert.equal(mixed.allConfigured, false);
  assert.equal(mixed.anyConfigured, true);
  assert.equal(mixed.missingSchedule, false);
});



// --- Aprendizaje: comparacion entre agenda MANUAL y agenda APRENDIDA ---

const MANUAL_ONLY = {
  productId: "aceite",
  productName: "ACEITE 1L",
  primarySupplierId: 40,
  supplierName: "OLEO S.A.",
  supplierLeadDays: 4,
  visitDays: ["Lunes"],
  deliveryDays: ["Miércoles"],
  scheduleHasConfigured: true,
  learnedVisitDays: [],
  learnedDeliveryDays: [],
  learnedLeadTimeDays: null,
  learnedSampleCount: 0,
  learnedAt: null,
  agendaSource: AGENDA_SOURCE.MANUAL,
  leadTimeSource: LEAD_TIME_SOURCE.CONFIGURED_DAYS,
  nextVisitDate: "2026-09-07",
  nextDeliveryDate: "2026-09-09",
};

const MANUAL_AGREES_LEARNED = {
  ...MANUAL_ONLY,
  productId: "arroz",
  productName: "ARROZ 500G",
  learnedVisitDays: ["lunes"],
  learnedDeliveryDays: ["miercoles"],
  learnedLeadTimeDays: 2,
  learnedSampleCount: 8,
  learnedAt: "2026-08-31T09:00:00Z",
};

const MANUAL_CONTRADICTS_LEARNED = {
  ...MANUAL_ONLY,
  productId: "azucar",
  productName: "AZUCAR",
  // Dueno dijo Lunes/Miercoles, el sistema observo Martes/Jueves. Ese es
  // exactamente el caso en que hay que avisarle al dueno.
  learnedVisitDays: ["MARTES"],
  learnedDeliveryDays: ["Jueves"],
  learnedLeadTimeDays: 2,
  learnedSampleCount: 12,
  learnedAt: "2026-08-31T09:00:00Z",
};

const LEARNED_ONLY = {
  productId: "leche-2L",
  productName: "LECHE 2L",
  primarySupplierId: 50,
  supplierName: "LACTEOS DEL VALLE",
  supplierLeadDays: 3,
  visitDays: [],
  deliveryDays: [],
  scheduleHasConfigured: false,
  learnedVisitDays: ["Martes"],
  learnedDeliveryDays: ["Jueves"],
  learnedLeadTimeDays: 2,
  learnedSampleCount: 6,
  learnedAt: "2026-08-30T09:00:00Z",
  agendaSource: AGENDA_SOURCE.LEARNED,
  leadTimeSource: LEAD_TIME_SOURCE.LEARNED_DAYS,
  nextVisitDate: "2026-09-01",
  nextDeliveryDate: "2026-09-03",
};

const WEAK_EVIDENCE = {
  ...LEARNED_ONLY,
  productId: "harina",
  productName: "HARINA",
  learnedVisitDays: ["Martes"],
  learnedDeliveryDays: ["Jueves"],
  learnedSampleCount: 2, // < LEARN_MIN_SAMPLES
  agendaSource: AGENDA_SOURCE.NONE,
  leadTimeSource: LEAD_TIME_SOURCE.DEFAULT,
  nextVisitDate: null,
  nextDeliveryDate: null,
};

test("LEARN_MIN_SAMPLES coincide con el umbral que aplica el backend", () => {
  // El backend usa 4 como minimo para considerar la agenda aprendida
  // confiable. Si esto cambia hay que sincronizar aca a mano; el test
  // documenta la dependencia.
  assert.equal(LEARN_MIN_SAMPLES, 4);
});

test("summarizeSupplierAgenda: solo manual, sin evidencia aprendida", () => {
  const summary = summarizeSupplierAgenda([MANUAL_ONLY, { ...MANUAL_ONLY, productId: "b" }]);
  assert.deepEqual(summary.configured.visitDays, ["lunes"]);
  assert.deepEqual(summary.configured.deliveryDays, ["miercoles"]);
  assert.equal(summary.configured.hasConfigured, true);
  assert.equal(summary.learned.sampleCount, 0);
  assert.equal(summary.learned.hasLearned, false);
  assert.equal(summary.learned.isReliable, false);
  assert.equal(summary.contradiction.hasAny, false);
  assert.equal(summary.agendaSource, AGENDA_SOURCE.MANUAL);
});

test("summarizeSupplierAgenda: manual y aprendida coinciden - sin contradiccion", () => {
  const summary = summarizeSupplierAgenda([MANUAL_AGREES_LEARNED]);
  assert.equal(summary.configured.hasConfigured, true);
  assert.equal(summary.learned.isReliable, true);
  assert.equal(summary.learned.sampleCount, 8);
  assert.equal(summary.contradiction.visit, false);
  assert.equal(summary.contradiction.delivery, false);
  assert.equal(summary.contradiction.hasAny, false);
});

test("summarizeSupplierAgenda: manual contradice aprendida - se marca la contradiccion aunque cambien acentos y mayusculas", () => {
  const summary = summarizeSupplierAgenda([MANUAL_CONTRADICTS_LEARNED]);
  assert.equal(summary.contradiction.visit, true);
  assert.equal(summary.contradiction.delivery, true);
  assert.equal(summary.contradiction.hasAny, true);
  // La agenda efectiva sigue siendo la manual: el backend ya decide que la
  // aprendida no pisa lo configurado.
  assert.equal(summary.agendaSource, AGENDA_SOURCE.MANUAL);
});

test("summarizeSupplierAgenda: solo aprendida - sin agenda manual configurada", () => {
  const summary = summarizeSupplierAgenda([LEARNED_ONLY]);
  assert.equal(summary.configured.hasConfigured, false);
  assert.equal(summary.learned.hasLearned, true);
  assert.equal(summary.learned.isReliable, true);
  assert.equal(summary.learned.sampleCount, 6);
  assert.equal(summary.contradiction.hasAny, false);
  assert.equal(summary.agendaSource, AGENDA_SOURCE.LEARNED);
});

test("summarizeSupplierAgenda: evidencia debil (< 4 pedidos) no se considera confiable ni marca contradiccion", () => {
  // Manual configurado + solo 2 pedidos observados. No debe generar
  // contradiccion aunque los dias observados sean distintos: 2 muestras no
  // son evidencia suficiente.
  const summary = summarizeSupplierAgenda([{
    ...MANUAL_ONLY,
    learnedVisitDays: ["Martes"],
    learnedDeliveryDays: ["Jueves"],
    learnedSampleCount: 2,
  }]);
  assert.equal(summary.learned.hasLearned, true);
  assert.equal(summary.learned.isReliable, false);
  assert.equal(summary.contradiction.hasAny, false);
});

test("summarizeSupplierAgenda: sin agenda ni aprendizaje - fechas quedan como estimacion", () => {
  const summary = summarizeSupplierAgenda([WEAK_EVIDENCE]);
  assert.equal(summary.configured.hasConfigured, false);
  assert.equal(summary.learned.isReliable, false);
  // Con hasLearned true pero sample_count < min y sin agenda manual, el
  // agendaSource del item ya viene como NONE.
  assert.equal(summary.agendaSource, AGENDA_SOURCE.NONE);
});

test("summarizeSupplierAgenda: lista vacia no explota", () => {
  const summary = summarizeSupplierAgenda([]);
  assert.equal(summary.configured.hasConfigured, false);
  assert.equal(summary.learned.sampleCount, 0);
  assert.equal(summary.contradiction.hasAny, false);
  assert.equal(summary.agendaSource, AGENDA_SOURCE.NONE);
});

test("resolveExpectedDeliveryDate: agenda aprendida se usa cuando no hay manual", () => {
  const resolved = resolveExpectedDeliveryDate([LEARNED_ONLY], {
    today: new Date("2026-08-31T12:00:00Z"),
  });
  assert.equal(resolved.hasConfiguredDays, false);
  assert.equal(resolved.hasLearnedDays, true);
  assert.equal(resolved.source, LEAD_TIME_SOURCE.LEARNED_DAYS);
  assert.equal(resolved.nextDeliveryDate, "2026-09-03");
  assert.equal(resolved.isoDate, "2026-09-03");
});

test("resolveExpectedDeliveryDate: manual manda siempre sobre aprendida", () => {
  // Si el mismo grupo trae filas con manual y aprendida, la manual gana
  // porque el dueno configuro dias reales.
  const resolved = resolveExpectedDeliveryDate([LEARNED_ONLY, MANUAL_AGREES_LEARNED], {
    today: new Date("2026-08-31T12:00:00Z"),
  });
  assert.equal(resolved.hasConfiguredDays, true);
  assert.equal(resolved.hasLearnedDays, false);
  assert.equal(resolved.source, LEAD_TIME_SOURCE.CONFIGURED_DAYS);
  assert.equal(resolved.nextDeliveryDate, "2026-09-09");
});

test("describeAgendaSource distingue manual / aprendida / ninguna", () => {
  assert.equal(describeAgendaSource(AGENDA_SOURCE.MANUAL).tone, "manual");
  assert.equal(describeAgendaSource(AGENDA_SOURCE.MANUAL).trusted, true);
  assert.equal(describeAgendaSource(AGENDA_SOURCE.LEARNED).tone, "learned");
  assert.equal(describeAgendaSource(AGENDA_SOURCE.LEARNED).trusted, true);
  assert.equal(describeAgendaSource(AGENDA_SOURCE.NONE).tone, "none");
  assert.equal(describeAgendaSource(AGENDA_SOURCE.NONE).trusted, false);
  assert.equal(describeAgendaSource("cualquier-otro").tone, "none");
});
