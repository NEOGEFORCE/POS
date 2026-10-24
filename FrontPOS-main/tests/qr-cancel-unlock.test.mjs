import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const qrPath = new URL("../src/components/shared/ModalPagoBoldQR.tsx", import.meta.url);
const paymentPath = new URL("../src/components/shared/UniversalPaymentModal.tsx", import.meta.url);

const read = (path) => readFile(path, "utf8");

function functionBlock(src, name, nextMarker) {
  const start = src.indexOf(name);
  assert.ok(start >= 0, `no se encontró ${name}`);
  const end = src.indexOf(nextMarker, start);
  assert.ok(end > start, `no se pudo acotar ${name}`);
  return src.slice(start, end);
}

test("el QR usa una vista directa sin Dialog, Portal ni overlay absoluto", async () => {
  const src = await read(qrPath);
  assert.match(src, /data-testid="bold-qr-payment-view"/);
  assert.match(src, /<section/);
  assert.doesNotMatch(src, /<Dialog|DialogContent|DialogPortal|@\/components\/ui\/dialog/);
  assert.doesNotMatch(src, /absolute\s+inset-0|bold-qr-internal-overlay|aria-modal/);
  assert.doesNotMatch(src, /onMouseDown=|addEventListener\(["']keydown["']/);
  assert.doesNotMatch(src, /document\.body\.style\.pointerEvents|document\.body\.removeAttribute\(["']style/);
});

test("ModalContent alterna directamente entre vista QR y vista de pago", async () => {
  const src = await read(paymentPath);
  assert.match(src, /\{\(\) => isBoldQrOpen \? \(\s*<ModalPagoBoldQR/);
  assert.match(src, /\) : \(\s*<div className="flex flex-col md:flex-row/);
  assert.equal((src.match(/<ModalPagoBoldQR/g) || []).length, 1,
    "debe existir una sola instancia QR, nunca una capa duplicada");
});

test("el modal HeroUI padre controla toda la vista sin un portal QR", async () => {
  const src = await read(paymentPath);
  const modal = src.slice(src.indexOf("<Modal\n"), src.indexOf("<ModalContent>"));
  assert.match(modal, /isDismissable=\{false\}/);
  assert.match(modal, /isKeyboardDismissDisabled=\{isBoldQrOpen\}/);
});

test("Cancelar y cambiar libera la UI antes de esperar la red", async () => {
  const src = await read(qrPath);
  const block = functionBlock(src, "const handleCancel = useCallback", "if (!isOpen) return null;");
  assert.doesNotMatch(block, /useCallback\(async|await\s+apiFetch/);
  const cancelCallback = block.indexOf("onCancel?.()")
  const close = block.indexOf("onOpenChange(false)")
  const request = block.indexOf('apiFetch("/pos/pagos-qr/cancelar"')
  assert.ok(cancelCallback >= 0 && close > cancelCallback && request > close,
    "onCancel y cierre deben ocurrir antes del POST best-effort");
  assert.match(block, /\.catch\(\(\) => undefined\)/);
});

test("cancelar QR nunca dispara onApproved ni onPay", async () => {
  const src = await read(qrPath);
  const block = functionBlock(src, "const handleCancel = useCallback", "if (!isOpen) return null;");
  assert.doesNotMatch(block, /onApproved|onPay/);
});


test("el teclado global del padre queda inactivo mientras el QR está abierto", async () => {
  const src = await read(paymentPath);
  const start = src.indexOf("const handleKeyDown = (e: KeyboardEvent)");
  const end = src.indexOf("window.addEventListener('keydown'", start);
  assert.ok(start >= 0 && end > start, "no se encontró el listener global");
  const listener = src.slice(start, end);
  assert.match(listener, /if \(isBoldQrOpen\) return;/,
    "Enter y Escape no deben alcanzar el modal padre mientras QR está abierto");
  assert.match(src, /\[isOpen, showSuccessScreen, isBoldQrOpen\]/);
});
