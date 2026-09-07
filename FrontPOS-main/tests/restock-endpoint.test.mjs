import assert from "node:assert/strict";
import test from "node:test";

import { buildRestockSuggestionsEndpoint } from "../src/lib/restock-endpoint.mjs";

// ----------------------------------------------------------------------------
// contrato server-side: la URL codifica supplier / search / include_all
// ----------------------------------------------------------------------------

test("sin parametros devuelve la ruta desnuda (compatibilidad con backend viejo)", () => {
  assert.equal(buildRestockSuggestionsEndpoint(), "/restock/suggestions-v2");
  assert.equal(buildRestockSuggestionsEndpoint({}), "/restock/suggestions-v2");
});

test("proveedor global no agrega supplier_id a la query", () => {
  assert.equal(
    buildRestockSuggestionsEndpoint({ supplierId: "global" }),
    "/restock/suggestions-v2",
  );
  assert.equal(
    buildRestockSuggestionsEndpoint({ supplierId: "0" }),
    "/restock/suggestions-v2",
  );
  assert.equal(
    buildRestockSuggestionsEndpoint({ supplierId: null }),
    "/restock/suggestions-v2",
  );
});

test("proveedor concreto se codifica en supplier_id", () => {
  assert.equal(
    buildRestockSuggestionsEndpoint({ supplierId: 20 }),
    "/restock/suggestions-v2?supplier_id=20",
  );
  assert.equal(
    buildRestockSuggestionsEndpoint({ supplierId: "  15  " }),
    "/restock/suggestions-v2?supplier_id=15",
  );
});

test("busqueda escrita se envia como search y activa include_all=false explicito", () => {
  const url = buildRestockSuggestionsEndpoint({ supplierId: 20, search: "leche" });
  assert.equal(url, "/restock/suggestions-v2?supplier_id=20&search=leche&include_all=false");
});

test("busqueda con espacios y acentos se codifica con URLSearchParams", () => {
  const url = buildRestockSuggestionsEndpoint({ search: "leche ño" });
  // URLSearchParams codifica espacio como + y ño como %C3%B1o.
  assert.ok(url.startsWith("/restock/suggestions-v2?search=leche"));
  assert.ok(url.includes("include_all=false"));
  assert.ok(url.includes("%C3%B1"));
});

test("busqueda vacia o solo espacios se omite (no rompe el default del back)", () => {
  assert.equal(
    buildRestockSuggestionsEndpoint({ supplierId: 20, search: "" }),
    "/restock/suggestions-v2?supplier_id=20",
  );
  assert.equal(
    buildRestockSuggestionsEndpoint({ supplierId: 20, search: "   " }),
    "/restock/suggestions-v2?supplier_id=20",
  );
});

test("include_all=true agrega el flag para que el backend traiga todo el catalogo", () => {
  assert.equal(
    buildRestockSuggestionsEndpoint({ supplierId: 20, includeAll: true }),
    "/restock/suggestions-v2?supplier_id=20&include_all=true",
  );
  assert.equal(
    buildRestockSuggestionsEndpoint({ supplierId: 20, includeAll: true, search: "arroz" }),
    "/restock/suggestions-v2?supplier_id=20&search=arroz&include_all=true",
  );
});

test("include_all=false sin busqueda omite el flag para conservar la URL legacy", () => {
  // Si no hay ni busqueda ni proveedor concreto, la URL sigue siendo la vieja
  // para que un back que no conoce el parametro siga respondiendo como antes.
  assert.equal(
    buildRestockSuggestionsEndpoint({ includeAll: false }),
    "/restock/suggestions-v2",
  );
});



test("modo huérfanos fuerza unassigned_only e include_all sin supplier_id", () => {
  const url = buildRestockSuggestionsEndpoint({
    supplierId: "unassigned",
    unassignedOnly: true,
    includeAll: false,
  });
  assert.equal(
    url,
    "/restock/suggestions-v2?unassigned_only=true&include_all=true",
  );
  assert.ok(!url.includes("supplier_id=unassigned"));
});

test("búsqueda de huérfanos sigue siendo server-side y jamás serializa unassigned como id", () => {
  const url = buildRestockSuggestionsEndpoint({ supplierId: "unassigned", search: "arroz integral" });
  assert.equal(
    url,
    "/restock/suggestions-v2?unassigned_only=true&search=arroz+integral&include_all=true",
  );
  assert.ok(!url.includes("supplier_id="));
});
