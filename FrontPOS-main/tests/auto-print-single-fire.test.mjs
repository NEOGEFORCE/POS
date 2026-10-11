import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const paymentModalPath = join(here, "..", "src", "components", "shared", "UniversalPaymentModal.tsx");

// =============================================================================
// R1 — El toggle `autoPrint` nunca puede re-disparar la impresión.
//
// Antes el useEffect de auto-impresión dependía de `[showSuccessScreen,
// autoPrint, buildTicketData]`, así que al activar el switch durante la
// pantalla de éxito el efecto volvía a correr e imprimía de nuevo. El
// requerimiento del sprint exige:
//
//   1. Toda impresión automática se dispara UNA SOLA VEZ después de que
//      la venta se confirmó exitosamente.
//   2. El toggle de auto-print SÓLO persiste la preferencia; jamás debe
//      disparar impresión en onChange.
//
// Estos tests son estáticos (lectura de código): validan la forma del
// efecto. Verifican que:
//   - el array de dependencias NO contiene `autoPrint`.
//   - el array de dependencias NO contiene `buildTicketData`.
//   - existe un `useRef` de guardia (patrón canónico `didSaleCompletionEffectsRef`).
//   - el handler del Switch NO llama a `printThermalTicket` ni derivados.
// =============================================================================

async function read(path) {
  return readFile(path, "utf8");
}

/**
 * Extrae el bloque del useEffect de auto-impresión. Lo detectamos buscando
 * el comentario de encabezado que inauguramos en el fix. Si cambia el
 * comentario, este helper falla con mensaje claro.
 */
function extractAutoPrintEffect(source) {
  const marker = "Auto-impresión persistente";
  const start = source.indexOf(marker);
  assert.ok(start > 0, `No se encontró el marcador '${marker}' en UniversalPaymentModal. ` +
    `El fix de single-fire perdió su documentación o alguien renombró la sección.`);
  // Buscar el useEffect siguiente
  const effectStart = source.indexOf("useEffect(", start);
  assert.ok(effectStart > start, "No se encontró useEffect( tras el marcador de auto-impresión.");
  // Balancear paréntesis para obtener el useEffect completo
  let depth = 0;
  let i = effectStart;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  // Avanzar hasta el `;` final
  while (i < source.length && source[i] !== ";") i++;
  return source.slice(effectStart, i + 1);
}

test("UniversalPaymentModal: el useEffect de auto-impresión NO depende de autoPrint", async () => {
  const source = await read(paymentModalPath);
  const effect = extractAutoPrintEffect(source);
  // El array de dependencias es lo que viene después del último `}, [`.
  const depsMatch = effect.match(/\},\s*\[([^\]]*)\]\s*\)/);
  assert.ok(depsMatch, "No se pudo localizar el array de dependencias del useEffect de auto-impresión.");
  const deps = depsMatch[1];
  assert.ok(!/\bautoPrint\b/.test(deps),
    `El array de dependencias NO puede incluir 'autoPrint'. Si lo hace, cambiar el toggle re-dispara la impresión.\n` +
    `Deps actuales: [${deps.trim()}]`);
  assert.ok(!/\bbuildTicketData\b/.test(deps),
    `El array de dependencias NO puede incluir 'buildTicketData'. Su identidad cambia en cada render ` +
    `del padre y re-dispararía la impresión en cada re-render.\n` +
    `Deps actuales: [${deps.trim()}]`);
  assert.match(deps, /\bshowSuccessScreen\b/,
    `El efecto DEBE depender de 'showSuccessScreen' para reiniciar la guardia al cerrar la pantalla.`);
});

test("UniversalPaymentModal: el useEffect de auto-impresión usa un useRef como guardia single-fire", async () => {
  const source = await read(paymentModalPath);
  const effect = extractAutoPrintEffect(source);
  // Debe existir la lectura de un ref `.current` para marcar que ya se disparó.
  assert.match(effect, /\.current/,
    "El useEffect de auto-impresión debe usar un ref para evitar doble disparo.");
  assert.match(effect, /didSaleCompletionEffectsRef/,
    "Convención del fix: la guardia se llama `didSaleCompletionEffectsRef`. Si cambia el nombre, actualizar este test ES una decisión documentable.");
});

test("UniversalPaymentModal: la impresión automática se gatilla desde el storage, no desde el state autoPrint", async () => {
  const source = await read(paymentModalPath);
  const effect = extractAutoPrintEffect(source);
  // Debe LEER directamente de readAutoPrint() dentro del efecto, no de la
  // variable de estado `autoPrint`. Así cambiar el state (via Switch) no
  // dispara una re-ejecución del efecto porque autoPrint no está en deps.
  assert.match(effect, /readAutoPrint\(\)/,
    "El efecto debe leer readAutoPrint() directamente, no basarse en el state local.");
});

test("UniversalPaymentModal: el onValueChange del Switch SOLO persiste la preferencia, no dispara impresión", async () => {
  const source = await read(paymentModalPath);
  // Buscar el Switch de autoPrint por su aria-label canónico
  const idx = source.indexOf('aria-label="Impresión automática del ticket"');
  assert.ok(idx > 0, "No se encontró el Switch de impresión automática (aria-label canónico).");
  // Expandir el bloque hasta cerrar la etiqueta del Switch (balanceando llaves)
  // El Switch empieza unas líneas antes del aria-label; nos basta con mirar
  // una ventana generosa alrededor para los asserts siguientes.
  const windowStart = Math.max(0, idx - 500);
  const windowEnd = Math.min(source.length, idx + 500);
  const scope = source.slice(windowStart, windowEnd);

  assert.match(scope, /onValueChange=\{\s*\(?val\)?\s*=>\s*\{[^}]*setAutoPrint\(val\)[^}]*persistAutoPrint\(val\)[^}]*\}/,
    "El onValueChange DEBE sólo setear state y persistir — nada más. Nunca disparar impresión.");

  // Ningún llamador de impresión en el ámbito del onValueChange.
  const handlerMatch = scope.match(/onValueChange=\{\s*\(?val\)?\s*=>\s*\{[\s\S]*?\}\s*\}/);
  assert.ok(handlerMatch, "No se pudo capturar el cuerpo del onValueChange del Switch de autoPrint.");
  const handlerBody = handlerMatch[0];
  assert.ok(!/printThermalTicket\(/.test(handlerBody),
    "El handler del toggle NO puede llamar a printThermalTicket. Esa es la raíz del bug.");
  assert.ok(!/printThermalTicketDirect\(/.test(handlerBody),
    "El handler del toggle NO puede llamar a printThermalTicketDirect.");
  assert.ok(!/dispatchAutoPrint\(/.test(handlerBody),
    "El handler del toggle NO puede llamar al dispatcher de auto-impresión.");
});
