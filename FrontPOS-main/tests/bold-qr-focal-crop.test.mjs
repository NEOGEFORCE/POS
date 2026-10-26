import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const modalPath = join(root, "src", "components", "shared", "ModalPagoBoldQR.tsx");
const helperPath = join(root, "src", "lib", "bold-qr-helpers.mjs");
const assetPath = join(root, "public", "qr-daviplata.png");

const source = (path) => readFile(path, "utf8");

test("el helper apunta al asset QR-only nativo de 561 px", async () => {
  const helper = await source(helperPath);
  assert.match(helper, /BOLD_QR_IMAGE_PATH\s*=\s*["']\/qr-daviplata\.png["']/);
  assert.match(helper, /BOLD_QR_ASSET_SIDE_PX\s*=\s*561/);
  assert.match(helper, /BOLD_QR_PREFERRED_SIDE_PX\s*=\s*320/);
  assert.doesNotMatch(helper, /BOLD_QR_FOCAL_POINT/);
});

test("el PNG del QR Daviplata es cuadrado", { skip: !existsSync(assetPath) && "falta public/qr-daviplata.png (se carga desde el PDF)" }, async () => {
  const png = await readFile(assetPath);
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20));
  assert.ok(png.readUInt32BE(16) >= 260);
});

test("el modal renderiza el recorte sin cover ni punto focal", async () => {
  const modal = await source(modalPath);
  assert.match(modal, /src=\{BOLD_QR_IMAGE_PATH\}/);
  assert.match(modal, /width=\{BOLD_QR_ASSET_SIDE_PX\}/);
  assert.match(modal, /height=\{BOLD_QR_ASSET_SIDE_PX\}/);
  assert.match(modal, /object-contain/);
  assert.doesNotMatch(modal, /objectPosition|BOLD_QR_FOCAL_POINT|objectFit:\s*["']cover/);
});

test("el QR conserva caja cuadrada accesible y tamaño de escaneo", async () => {
  const modal = await source(modalPath);
  assert.match(modal, /aspectRatio:\s*["']1 \/ 1["']/);
  assert.match(modal, /minWidth:\s*`min\(\$\{BOLD_QR_CSS_MIN\}, 100%\)`/);
  assert.match(modal, /role=["']img["']/);
  assert.match(modal, /aria-label=\{`Código QR Daviplata para pagar/);
});

test("el modal es compacto y limita su scroll a la envolvente padre", async () => {
  const modal = await source(modalPath);
  assert.match(modal, /max-w-\[520px\]/);
  assert.match(modal, /max-h-full/);
  assert.match(modal, /overflow-y-auto/);
  assert.match(modal, /overscroll-contain/);
  assert.match(modal, /p-4 md:p-5[^\n]*shadow-/);
  assert.doesNotMatch(modal, /max-h-\[calc\(100dvh-1rem\)\]/);
  assert.doesNotMatch(modal, /max-w-xl[^\n]*p-6 md:p-8/);
});

test("las acciones son anchas, simétricas y no vuelven al footer apretado", async () => {
  const modal = await source(modalPath);
  // Dos columnas en el cobro normal; una sola en el QR reabierto desde la bandeja.
  assert.match(modal, /grid grid-cols-1 \$\{reopened \? "" : "sm:grid-cols-2"\} gap-2 w-full/);
  assert.match(modal, /Cancelar y cambiar/);
  assert.match(modal, /h-12 w-full rounded-xl border-2/);
  assert.match(modal, /h-12 w-full rounded-xl bg-emerald-600/);
  assert.doesNotMatch(modal, /min-w-\[160px\]/);
});

test("el fallback honesto referencia el nuevo asset", async () => {
  const modal = await source(modalPath);
  assert.match(modal, /QR_IMAGE_MISSING/);
  assert.match(modal, /\/qr-bold-breb-code\.png/);
  assert.match(modal, /onError=\{\(\) => setQrImageMissing\(true\)\}/);
});
