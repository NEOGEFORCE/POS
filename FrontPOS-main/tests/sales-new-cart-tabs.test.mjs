import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_VISIBLE_CART_TABS, countCartUnits, splitCartTabs } from "../src/lib/cart-tabs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, "..", "src", "app", "(app)", "sales", "new", "page.tsx");

test("splitCartTabs: con 3 o menos no hay lista", () => {
    assert.equal(MAX_VISIBLE_CART_TABS, 3);
    assert.deepEqual(splitCartTabs(["Factura 1", "Factura 2"], "Factura 1"), {
        visible: ["Factura 1", "Factura 2"], overflow: [],
    });
    assert.deepEqual(splitCartTabs(["Factura 1", "Factura 2", "Factura 3"], "Factura 3").overflow, []);
});

test("splitCartTabs: más de 3 muestra 3 y agrupa el resto", () => {
    const keys = ["Factura 1", "Factura 2", "Factura 3", "Factura 4", "Factura 5"];
    assert.deepEqual(splitCartTabs(keys, "Factura 1"), {
        visible: ["Factura 1", "Factura 2", "Factura 3"],
        overflow: ["Factura 4", "Factura 5"],
    });
});

test("splitCartTabs: la factura activa siempre queda visible", () => {
    const keys = ["Factura 1", "Factura 2", "Factura 3", "Factura 4", "Factura 5"];
    const { visible, overflow } = splitCartTabs(keys, "Factura 5");
    assert.deepEqual(visible, ["Factura 1", "Factura 2", "Factura 5"]);
    assert.deepEqual(overflow, ["Factura 3", "Factura 4"]);
    assert.equal(visible.length + overflow.length, keys.length);
});

test("countCartUnits: suma unidades y cuenta peso como 1 por línea", () => {
    assert.equal(countCartUnits([
        { cartQuantity: 4 },
        { cartQuantity: 1 },
        { cartQuantity: 1 },
    ]), 6);
    assert.equal(countCartUnits([
        { cartQuantity: 2 },
        { cartQuantity: 0.532, isWeighted: true },
    ]), 3);
    assert.equal(countCartUnits([]), 0);
    assert.equal(countCartUnits(null), 0);
    assert.equal(countCartUnits([null, { cartQuantity: "abc" }, { cartQuantity: -2 }]), 0);
});

test("sales/new usa máximo 3 pestañas, lista +N shadcn y contador junto a ARTÍCULO", async () => {
    const src = await readFile(pagePath, "utf8");
    assert.match(src, /splitCartTabs\(cartKeys, activeCartKey\)\.visible\.map/);
    assert.match(src, /from '@\/components\/ui\/dropdown-menu'/);
    assert.match(src, /aria-label=\{`Ver \$\{overflow\.length\} facturas más`\}/);
    assert.match(src, /onSelect=\{\(\) => handleCartSwitch\(key\)\}/);
    assert.match(src, /ARTÍCULO[\s\S]{0,300}countCartUnits\(currentCart\)/);
});
