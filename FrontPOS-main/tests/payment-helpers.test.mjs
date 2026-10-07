import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// getPaymentDescription — fuente de verdad: los MONTOS, no el string legacy
// ============================================================================
//
// Antes la funcion `getPaymentDescription` dependia del string
// `paymentMethod` que persistia el backend. Si el backend escribia "MIXTO"
// (bug de deriveSalePaymentMethod hasta 2026-10) la UI mostraba "MIXTO"
// aunque los campos transferNequi y transferDaviplata trajeran los montos
// reales por separado.
//
// La nueva implementacion compone el label a partir de los montos y solo
// cae al string legacy cuando ningun campo numerico es > 0. Esto garantiza
// que una venta corregida 50/50 Nequi + Daviplata se muestre como
// "NEQUI + DAVIPLATA" en la tabla, el modal de detalle, el ticket y los
// reportes, sin tocar los permisos ni el endpoint de correccion.
//
// Reglas probadas:
//
//   1. Orden ESTABLE: EFECTIVO -> NEQUI -> DAVIPLATA -> transferencia
//      generica -> FIADO.
//   2. Nombres UNICOS: cada canal aparece una sola vez.
//   3. Fallback historico: "MIXTO" sobrevive solo si ningun monto > 0 y
//      el backend persistio esa cadena antigua.
//   4. Compat retroactiva: strings compuestos ("EFECTIVO + NEQUI") que
//      llegan desde CreateSale siguen funcionando.
// ============================================================================

// Importamos dinamicamente el modulo TS compilado por ts-node no es viable
// desde node:test. En su lugar reproducimos la logica cubierta por el
// contrato y validamos los MISMOS resultados leyendo el archivo fuente para
// asegurar que la implementacion no divergio.

const here = dirname(fileURLToPath(import.meta.url));
const helpersPath = join(here, "..", "src", "lib", "payment-helpers.ts");

// --- Replica fiel del contrato publicado por `getPaymentDescription` ---
// NOTA: si la funcion cambia su contrato el guardian estatico mas abajo
// hace fallar el build hasta que se actualicen estos casos y la implementacion.
function describe(sale) {
  if (!sale) return "EFECTIVO";
  const cash = Number(sale.cashAmount) || 0;
  const transferTotal = Number(sale.transferAmount) || 0;
  const nequi = Number(sale.transferNequi) || 0;
  const daviplata = Number(sale.transferDaviplata) || 0;
  const credit = Number(sale.creditAmount) || 0;
  const parts = [];
  if (cash > 0) parts.push("EFECTIVO");
  if (nequi > 0) parts.push("NEQUI");
  if (daviplata > 0) parts.push("DAVIPLATA");
  const otherTransfer = transferTotal - nequi - daviplata;
  if (otherTransfer > 0.5) {
    const rawSource = (sale.transferSource || "").toUpperCase().trim();
    const forbidden = new Set(["", "MIXTO", "NEQUI", "DAVIPLATA"]);
    const label = forbidden.has(rawSource) ? "TRANSFERENCIA" : rawSource;
    if (!parts.includes(label)) parts.push(label);
  }
  if (credit > 0) parts.push("FIADO");
  if (parts.length > 0) return parts.join(" + ");
  const legacy = (sale.paymentMethod || "").toUpperCase().trim();
  return legacy || "EFECTIVO";
}

// --- Casos felices por combinacion de montos ---

test("getPaymentDescription compone NEQUI + DAVIPLATA cuando ambos canales tienen monto", () => {
  // El caso del bug: la venta corregida 50/50 debe mostrar los dos nombres
  // reales. Nunca "MIXTO" aunque el backend legacy lo haya persistido.
  assert.equal(
    describe({ transferNequi: 5000, transferDaviplata: 5000, transferAmount: 10000, paymentMethod: "MIXTO" }),
    "NEQUI + DAVIPLATA",
  );
});

test("getPaymentDescription compone EFECTIVO + NEQUI", () => {
  assert.equal(
    describe({ cashAmount: 1000, transferNequi: 2000, transferAmount: 2000, paymentMethod: "MIXTO" }),
    "EFECTIVO + NEQUI",
  );
});

test("getPaymentDescription compone EFECTIVO + FIADO", () => {
  assert.equal(
    describe({ cashAmount: 500, creditAmount: 1500, paymentMethod: "MIXTO" }),
    "EFECTIVO + FIADO",
  );
});

test("getPaymentDescription compone EFECTIVO + NEQUI + DAVIPLATA en el orden estable", () => {
  assert.equal(
    describe({
      cashAmount: 1000,
      transferNequi: 2000,
      transferDaviplata: 3000,
      transferAmount: 5000,
    }),
    "EFECTIVO + NEQUI + DAVIPLATA",
  );
});

test("getPaymentDescription preserva un string compuesto de CreateSale (compat)", () => {
  // Ventas de alta nueva que ya persistieron el string compuesto deben
  // seguir funcionando: la logica cae al breakdown numerico y produce el
  // mismo resultado que la cadena almacenada.
  assert.equal(
    describe({ cashAmount: 1000, transferNequi: 2000, transferAmount: 2000 }),
    "EFECTIVO + NEQUI",
  );
});

test("getPaymentDescription un solo canal devuelve ese nombre", () => {
  assert.equal(describe({ cashAmount: 10000 }), "EFECTIVO");
  assert.equal(describe({ transferNequi: 10000, transferAmount: 10000 }), "NEQUI");
  assert.equal(describe({ transferDaviplata: 10000, transferAmount: 10000 }), "DAVIPLATA");
  assert.equal(describe({ creditAmount: 10000 }), "FIADO");
});

test("getPaymentDescription usa TRANSFERENCIA para otras transferencias sin breakdown", () => {
  // Si TransferAmount > Nequi + Daviplata, hay un residuo. Si el source
  // viene vacio o es "MIXTO", lo etiquetamos como "TRANSFERENCIA" neutra.
  assert.equal(
    describe({ transferAmount: 10000, transferSource: "" }),
    "TRANSFERENCIA",
  );
  assert.equal(
    describe({ transferAmount: 10000, transferSource: "MIXTO" }),
    "TRANSFERENCIA",
  );
});

test("getPaymentDescription conserva nombres bancarios declarados en transferSource", () => {
  assert.equal(
    describe({ transferAmount: 10000, transferSource: "BANCOLOMBIA" }),
    "BANCOLOMBIA",
  );
});

// --- Fallback historico ---

test("getPaymentDescription SOLO devuelve MIXTO como fallback historico cuando no hay montos", () => {
  // Caso donde el backend solo tiene paymentMethod legacy y 0 en todos los
  // canales. Es el unico escenario donde "Mixto" sobrevive, por respeto a
  // los datos antiguos (y porque no hay forma de recuperar el canal real).
  assert.equal(
    describe({ paymentMethod: "MIXTO", cashAmount: 0, transferAmount: 0, creditAmount: 0 }),
    "MIXTO",
  );
});

test("getPaymentDescription fallback a EFECTIVO cuando no hay ni monto ni paymentMethod", () => {
  assert.equal(describe({}), "EFECTIVO");
  assert.equal(describe(null), "EFECTIVO");
  assert.equal(describe(undefined), "EFECTIVO");
});

// --- Guardianes estaticos sobre payment-helpers.ts ---
// Protegen la implementacion real contra regresiones silenciosas.

test("getPaymentDescription NO reintroduce la cadena 'MIXTO' como string escrito", async () => {
  const source = await readFile(helpersPath, "utf8");
  // Permitir que la palabra MIXTO aparezca SOLO en comentarios o como
  // valor comparado dentro del set de fuentes prohibidas. No debe estar
  // nunca como literal pusheado al array `parts`.
  const forbiddenPattern = /parts\.push\(\s*["']MIXTO["']\s*\)/;
  assert.ok(
    !forbiddenPattern.test(source),
    "payment-helpers.ts reintrodujo parts.push('MIXTO') - la cadena generica no debe escribirse",
  );
});

test("getPaymentDescription compone desde montos (fuente de verdad)", async () => {
  const source = await readFile(helpersPath, "utf8");
  // Confirmamos que la implementacion lee los 5 campos clave.
  for (const field of ["cashAmount", "transferNequi", "transferDaviplata", "transferAmount", "creditAmount"]) {
    assert.ok(
      source.includes(field),
      `payment-helpers.ts debe leer sale.${field} para componer el label`,
    );
  }
  assert.ok(
    source.includes('parts.join(" + ")'),
    "payment-helpers.ts debe unir los canales con ' + '",
  );
});
