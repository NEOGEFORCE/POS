import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, "..", "src", "app", "(app)", "sales", "new", "hooks", "useNewSale.ts");
const worker = join(here, "..", "src", "workers", "saleWorker.ts");
const searchModal = join(here, "..", "src", "app", "(app)", "sales", "new", "components", "ProductSearchModal.tsx");
const salesRoot = join(here, "..", "src", "app", "(app)", "sales");

// =============================================================================
// Guardianes estáticos del fallback de resolución de label_codes en caja.
//
// Problema resuelto: el `code` persistente que `LabelPrintSheet` imprime
// en la etiqueta física vive solo en `label_codes` (migración 016).
// Antes del fix, ninguna ruta de entrada de código en /sales/new lo
// consultaba y el escaneo terminaba en "PRODUCTO NO EXISTE".
//
// Estas invariantes bloquean regresiones del fix:
//
//   1. `handleCodeSubmit` llama a `/labels/codes/resolve` como fallback
//      DESPUÉS del lookup local (products.barcode / alternateCodes).
//   2. El fetch usa match EXACTO por query param (?code=...), no `?q=`.
//   3. El fallback aparece DENTRO de la rama `else` del `products.find`
//      fallido — nunca antes del lookup local.
//   4. Hay un `useRef<Set<string>>` que absorbe duplicados (Enter doble,
//      scanner que repite el evento) por clave `label:...`.
//   5. En modo offline (`navigator.onLine === false`) el fallback NO se
//      activa; se preserva la UX previa.
//   6. Ni el worker ni el modal de búsqueda consultan `/labels/codes`:
//      el único punto de resolución remota en caja es
//      `handleCodeSubmit` del hook.
//   7. Ningún archivo bajo `src/app/(app)/sales/**` referencia
//      `/inventory/package-barcode` ni `package_barcode_aliases`: el
//      alias de paquete es exclusivo de recepción.
// =============================================================================

async function leer(path) { return readFile(path, "utf8"); }

// Recorre recursivamente un directorio y devuelve todos los archivos.
async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await walk(full)));
        } else if (entry.isFile()) {
            files.push(full);
        }
    }
    return files;
}

// Delimita el cuerpo de `handleCodeSubmit` para que los asserts se
// apliquen solo al callback relevante y no a cualquier otro fragmento
// del hook.
function extraerHandleCodeSubmit(src) {
    const re = /const\s+handleCodeSubmit\s*=\s*useCallback\s*\(\s*async\s*\(code:\s*string\)\s*=>\s*\{[\s\S]*?\},\s*\[[^\]]*\]\s*\)\s*;/m;
    const match = re.exec(src);
    if (!match) return "";
    return match[0];
}

test("handleCodeSubmit: llama a /labels/codes/resolve como fallback", async () => {
    const src = await leer(hook);
    assert.ok(
        src.includes("/labels/codes/resolve"),
        "useNewSale debe consultar /labels/codes/resolve como fallback cuando el producto no está en el catálogo local; sin esto, los códigos impresos por LabelPrintSheet caen a 'producto no existe'.",
    );
    const body = extraerHandleCodeSubmit(src);
    assert.ok(body.length > 0, "No se pudo delimitar el cuerpo de handleCodeSubmit (¿se cambió a sincrónico?).");
    assert.ok(
        body.includes("/labels/codes/resolve"),
        "El fetch a /labels/codes/resolve debe estar DENTRO de handleCodeSubmit (no en otro callback).",
    );
});

test("handleCodeSubmit: usa match exacto por query param code=...", async () => {
    const src = await leer(hook);
    const body = extraerHandleCodeSubmit(src);
    assert.ok(
        /\/labels\/codes\/resolve\?code=\$\{encodeURIComponent\(/.test(body),
        "La URL debe pasar el código como ?code=${encodeURIComponent(normalized)}; nunca como ?q=... ni concatenación cruda (abriría ambigüedad y SSRF-like).",
    );
});

test("handleCodeSubmit: el fallback aparece DESPUÉS del lookup local (rama !p)", async () => {
    const src = await leer(hook);
    const body = extraerHandleCodeSubmit(src);
    const idxFind = body.indexOf("products.find(x =>");
    const idxFetch = body.indexOf("/labels/codes/resolve");
    assert.ok(idxFind > 0, "Debe seguir existiendo el products.find local.");
    assert.ok(idxFetch > 0, "Debe existir el fetch al resolver.");
    assert.ok(
        idxFetch > idxFind,
        "El fetch al resolver debe aparecer DESPUÉS del lookup local products.find: solo caemos a /labels/codes/resolve si el lookup local falla.",
    );
    // Y el fetch debe estar en la rama 'else' del lookup local — buscamos
    // la secuencia textual que ya está en el hook.
    assert.ok(
        /if\s*\(p\)\s*\{[\s\S]*?\}\s*else\s*\{[\s\S]*?\/labels\/codes\/resolve/.test(body),
        "El fetch a /labels/codes/resolve debe estar DENTRO del bloque `else` del lookup local (nunca antes).",
    );
});

test("handleCodeSubmit: dedupe por useRef<Set<string>> con clave label:...", async () => {
    const src = await leer(hook);
    // El ref está declarado al nivel del hook, no dentro del callback.
    assert.ok(
        /inflightResolveRef\s*=\s*useRef<Set<string>>/.test(src),
        "useNewSale debe declarar `inflightResolveRef = useRef<Set<string>>(new Set())` para absorber duplicados.",
    );
    const body = extraerHandleCodeSubmit(src);
    assert.ok(
        /`label:\$\{normalized\}`|'label:'\s*\+\s*normalized|"label:"\s*\+\s*normalized/.test(body),
        "La clave de dedupe debe usar el prefijo `label:` + el código normalizado para que no colisione con otros flujos.",
    );
    assert.ok(
        /inflightResolveRef\.current\.has\(/.test(body),
        "El fallback debe consultar inflightResolveRef.current.has(key) antes del fetch.",
    );
    assert.ok(
        /inflightResolveRef\.current\.add\(/.test(body),
        "El fallback debe registrar la clave con inflightResolveRef.current.add(key) antes del fetch.",
    );
    assert.ok(
        /inflightResolveRef\.current\.delete\(/.test(body),
        "El fallback debe liberar la clave con inflightResolveRef.current.delete(key) tras una ventana corta.",
    );
});

test("handleCodeSubmit: respeta modo offline (navigator.onLine)", async () => {
    const src = await leer(hook);
    const body = extraerHandleCodeSubmit(src);
    assert.ok(
        /navigator\.onLine/.test(body),
        "El fallback debe comprobar navigator.onLine; sin ello, un POS offline haría llamadas inútiles al backend caído.",
    );
});

test("handleCodeSubmit: condiciona por match === 'label_code' exacto", async () => {
    const src = await leer(hook);
    const body = extraerHandleCodeSubmit(src);
    assert.ok(
        /match\s*===\s*['"]label_code['"]/.test(body),
        "El fallback debe condicionar por `match === 'label_code'`: cualquier otra forma deja pasar valores desconocidos.",
    );
});

test("handleCodeSubmit: agrega exactamente qty unidades (1 por default)", async () => {
    const src = await leer(hook);
    const body = extraerHandleCodeSubmit(src);
    // Después del match, debe haber un bucle que llame addToCart(local) qty veces.
    assert.ok(
        /for\s*\(let\s+i\s*=\s*0;\s*i\s*<\s*qty;\s*i\+\+\)\s*addToCart\(local\)/.test(body),
        "Al resolver un label_code, el fallback debe llamar addToCart(local) exactamente `qty` veces (default 1); nunca sumar en bloque.",
    );
});

test("handleCodeSubmit: prefiere producto del productMap sobre el payload del backend", async () => {
    const src = await leer(hook);
    const body = extraerHandleCodeSubmit(src);
    // El resolver backend devuelve un brief; el frontend prefiere el
    // producto cargado localmente porque trae relaciones completas
    // (categoría, flags). Fallback al brief sólo si el catálogo no lo tiene.
    assert.ok(
        /productMap\.get\(resolvedBarcode\)/.test(body) || /productMap\.get\(.*barcode/.test(body),
        "El fallback debe consultar productMap.get(barcode) primero y usar el brief del backend sólo como fallback.",
    );
});

test("handleCodeSubmit: usa apiFetch (no fetch directo), con timeout", async () => {
    const src = await leer(hook);
    const body = extraerHandleCodeSubmit(src);
    assert.ok(
        /apiFetch</.test(body),
        "El fallback debe usar apiFetch<T>(url, opts) para heredar el Bearer token y manejo de errores global.",
    );
    assert.ok(
        /timeoutMs:\s*\d+/.test(body),
        "El fallback debe definir timeoutMs para no colgar la caja si el backend está lento.",
    );
});

test("handleCodeSubmit: tras catch del fetch, cae al toast 'PRODUCTO NO EXISTE'", async () => {
    const src = await leer(hook);
    const body = extraerHandleCodeSubmit(src);
    // El try alrededor del fetch debe tener un catch que no bloquee la UX.
    // El toast destructive debe seguir existiendo DESPUÉS del bloque fallback.
    const idxCatch = body.indexOf("} catch");
    const idxToast = body.indexOf("PRODUCTO NO EXISTE");
    assert.ok(idxCatch > 0, "Debe existir un catch alrededor del fetch del resolver.");
    assert.ok(idxToast > 0, "Debe conservarse el toast 'PRODUCTO NO EXISTE'.");
    assert.ok(
        idxCatch < idxToast,
        "El catch del fetch debe aparecer ANTES del toast; si el fetch falla, caemos a 'producto no existe' sin bloquear la caja.",
    );
});

// Elimina comentarios (// hasta fin de línea y /* ... */ multilínea) para
// que los asserts busquen literales en CÓDIGO EJECUTABLE y no en
// documentación. Evita falsos positivos cuando un comentario cita la
// invariante prohibida como ejemplo negativo.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
}

test("saleWorker: NO consulta /labels/codes (es un worker, no habla HTTP)", async () => {
    const src = await leer(worker);
    assert.ok(
        !src.includes("/labels/codes"),
        "El saleWorker filtra localmente; NO debe llamar al backend. Si en el futuro se le añade red, hay que repensar la arquitectura offline.",
    );
    // Y no debe hacer fetch de ningún tipo.
    assert.ok(
        !/\bfetch\s*\(/.test(src),
        "El saleWorker NO debe hacer fetch(); si se requiere red, debe salir del worker.",
    );
});

test("ProductSearchModal: NO consulta /labels/codes", async () => {
    const src = await leer(searchModal);
    assert.ok(
        !src.includes("/labels/codes"),
        "ProductSearchModal filtra contra el array local `products` recibido como prop; NO debe hacer round-trips para resolver.",
    );
});

test("sales/**: NUNCA ejecuta referencias a /inventory/package-barcode ni package_barcode_aliases", async () => {
    // Invariante crítica: el alias de paquete es EXCLUSIVO de recepción.
    // Si algún archivo bajo /sales lo referencia DESDE CÓDIGO EJECUTABLE,
    // caja podría resolver un package_code como si fuera un código unitario
    // y rompería la semántica. Los comentarios que CITAN la invariante
    // como ejemplo negativo están permitidos (se eliminan antes de grep).
    const files = await walk(salesRoot);
    const violations = [];
    for (const file of files) {
        if (!/\.(ts|tsx|mjs|js)$/.test(file)) continue;
        const raw = await readFile(file, "utf8");
        const src = stripComments(raw);
        if (/\/inventory\/package-barcode/.test(src) || /package_barcode_aliases/.test(src)) {
            violations.push(file);
        }
    }
    assert.deepEqual(
        violations,
        [],
        `Los siguientes archivos de /sales referencian el alias de paquete DESDE CÓDIGO EJECUTABLE (los comentarios están excluidos):\n${violations.join("\n")}`,
    );
});

test("useNewSale.ts: NO ejecuta fetch a /inventory/package-barcode/resolve", async () => {
    const raw = await leer(hook);
    const src = stripComments(raw);
    assert.ok(
        !src.includes("/inventory/package-barcode"),
        "useNewSale.ts NO debe hacer fetch a /inventory/package-barcode/resolve DESDE CÓDIGO EJECUTABLE: ese endpoint es del flujo de recepción y pertenece a package_barcode_aliases, no a label_codes.",
    );
});

test("tests contractuales de reimpresión siguen vivos (sanity)", async () => {
    // La invariante "reimpresión conserva mismo código" la cubre
    // label-reprint-contract.test.mjs. Aquí sólo validamos que ese
    // archivo exista para que el reviewer sepa dónde buscarla.
    const reprintTest = join(here, "label-reprint-contract.test.mjs");
    const info = await stat(reprintTest);
    assert.ok(info.isFile(), "label-reprint-contract.test.mjs debe existir: cubre el invariante idempotente de EnsureCodeForProduct.");
});
