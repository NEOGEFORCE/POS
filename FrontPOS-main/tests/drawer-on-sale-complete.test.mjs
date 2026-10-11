import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const paymentModal = join(here, "..", "src", "components", "shared", "UniversalPaymentModal.tsx");
const saleDetailModal = join(here, "..", "src", "app", "(app)", "sales", "components", "SaleDetailModal.tsx");
const salesPage = join(here, "..", "src", "app", "(app)", "sales", "page.tsx");
const workspace = join(here, "..", "src", "app", "(app)", "labels", "components", "LabelsWorkspace.tsx");

async function read(path) {
  return await readFile(path, "utf8");
}

function extractSaleCompletionEffect(source) {
  const marker = "Auto-impresión persistente y cajón al completar venta";
  const start = source.indexOf(marker);
  assert.ok(start > 0, `No se encontró el marcador '${marker}'.`);
  const effectStart = source.indexOf("useEffect(", start);
  assert.ok(effectStart > start, "No se encontró el useEffect del orquestador postventa.");
  let depth = 0;
  let i = effectStart;
  for (; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  while (i < source.length && source[i] !== ";") i++;
  return source.slice(effectStart, i + 1);
}

test("UniversalPaymentModal: usa una sola guardia postventa single-fire", async () => {
  const src = await read(paymentModal);
  assert.match(src, /const\s+didSaleCompletionEffectsRef\s*=\s*useRef\s*\(\s*false\s*\)/);
  assert.doesNotMatch(src, /didDrawerKickRef|didAutoPrintRef/,
    "No deben sobrevivir dos effects/guards independientes que puedan competir.");
  const effect = extractSaleCompletionEffect(src);
  assert.match(effect, /didSaleCompletionEffectsRef\.current\s*=\s*true/);
  const deps = effect.match(/\},\s*\[([^\]]*)\]\s*\)/)?.[1] ?? "";
  assert.match(deps, /showSuccessScreen/);
  assert.doesNotMatch(deps, /autoPrint|buildTicketData|dispatchAutoPrint|dispatchDrawerKickOnSale/);
});

test("UniversalPaymentModal: orquestador lee storage y excluye MANUAL", async () => {
  const effect = extractSaleCompletionEffect(await read(paymentModal));
  assert.match(effect, /readAutoPrint\(\)/,
    "El toggle es preferencia; el efecto lee storage una vez al abrir éxito.");
  assert.match(effect, /loadPrintingConfig\(\)/);
  assert.match(effect, /cfg\.drawer\.enabled/);
  assert.match(effect, /cfg\.drawer\.openDrawerOnSale/);
  assert.match(effect, /cfg\.drawer\.event\s*!==\s*DRAWER_EVENTS\.MANUAL/,
    "MANUAL debe impedir cualquier kick automático.");
});

test("UniversalPaymentModal: BEFORE/AFTER ordenan un único kick alrededor del auto-print", async () => {
  const effect = extractSaleCompletionEffect(await read(paymentModal));
  const before = effect.indexOf("cfg.drawer.event === DRAWER_EVENTS.BEFORE_PRINT");
  const beforeKick = effect.indexOf("await dispatchDrawerKickOnSale(cfg)", before);
  const print = effect.indexOf("await dispatchAutoPrint()", beforeKick);
  const after = effect.indexOf("cfg.drawer.event === DRAWER_EVENTS.AFTER_PRINT", print);
  const afterKick = effect.indexOf("await dispatchDrawerKickOnSale(cfg)", after);
  assert.ok(before >= 0 && beforeKick > before && print > beforeKick && after > print && afterKick > after,
    "Orden requerido: BEFORE kick → print → AFTER kick; sólo una rama de evento puede ejecutarse.");
});

test("UniversalPaymentModal: dispatchAutoPrint jamás embebe openDrawerOnSale=true", async () => {
  const src = await read(paymentModal);
  const start = src.indexOf("const dispatchAutoPrint");
  const endMarker = "}, [buildTicketData, toast]);";
  const end = src.indexOf(endMarker, start) + endMarker.length;
  const scope = src.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(scope, /openDrawerOnSale\s*:\s*true/,
    "El recibo y el kick separado no pueden incluir ambos el pulso.");
  assert.match(scope, /printThermalTicketDirect\(buildTicketData\(\)\)/);
});

test("UniversalPaymentModal: kick separado es audit-first y lleva el contexto completo", async () => {
  const src = await read(paymentModal);
  const start = src.indexOf("const dispatchDrawerKickOnSale");
  const end = src.indexOf("Auto-impresión persistente y cajón", start);
  const scope = src.slice(start, end);
  const audit = scope.indexOf('"/cash-drawer/open"');
  const kick = scope.indexOf("kickDrawer({");
  assert.ok(audit >= 0 && kick > audit, "La auditoría debe suceder antes del pulso físico.");
  assert.match(scope, /override:\s*false/);
  assert.match(scope, /command:\s*cfg\.drawer\.command/);
  assert.match(scope, /event:\s*cfg\.drawer\.event/);
  assert.match(scope, /connection:\s*cfg\.connection/);
  assert.match(scope, /drawer:\s*cfg\.drawer/);
  assert.match(scope, /openDrawerOnSale:\s*true/);
});

test("UniversalPaymentModal: toggle sólo persiste; no imprime ni kickea", async () => {
  const src = await read(paymentModal);
  const idx = src.indexOf('aria-label="Impresión automática del ticket"');
  assert.ok(idx > 0);
  const scope = src.slice(idx - 300, idx + 500);
  assert.match(scope, /setAutoPrint\(val\)[\s\S]*persistAutoPrint\(val\)/);
  const handler = scope.match(/onValueChange=\{[\s\S]*?\}\s*\}/)?.[0] ?? "";
  assert.doesNotMatch(handler, /dispatchAutoPrint|dispatchDrawerKickOnSale|printThermalTicket/);
});

test("Reimpresión desde historial no llama kickDrawer", async () => {
  assert.doesNotMatch(await read(saleDetailModal), /kickDrawer\s*\(/);
  assert.doesNotMatch(await read(salesPage), /kickDrawer\s*\(/);
});

test("LabelsWorkspace envía openDrawerOnSale:false (etiquetas no abren cajón)", async () => {
  const src = await read(workspace);
  const start = src.indexOf("const handlePrint = useCallback");
  const end = src.indexOf("const handlePrintShelfSheet", start);
  assert.match(src.slice(start, end), /openDrawerOnSale:\s*false/);
});
