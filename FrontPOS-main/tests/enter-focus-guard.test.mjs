import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    ENTER_ACTIVATABLE_SELECTOR,
    installEnterFocusGuard,
    shouldSuppressEnter,
} from "../src/lib/enter-focus-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const layoutPath = join(here, "..", "src", "app", "(app)", "layout.tsx");

// Elemento falso: `kind` decide si coincide con el selector de controles.
function fakeEl({ activatable = true, optOut = false } = {}) {
    return {
        blurred: false,
        matches: (sel) => sel === ENTER_ACTIVATABLE_SELECTOR && activatable,
        closest: (sel) => (sel === "[data-enter-activates]" && optOut ? {} : null),
        blur() { this.blurred = true; },
    };
}

function fakeWindow(activeElement) {
    const listeners = {};
    return {
        document: { activeElement },
        addEventListener: (type, fn) => { listeners[type] = fn; },
        removeEventListener: (type) => { delete listeners[type]; },
        fire(type, event = {}) {
            const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
            listeners[type]?.(ev);
            return ev;
        },
        listeners,
    };
}

test("shouldSuppressEnter: Enter sobre botón pulsado con mouse se suprime", () => {
    assert.equal(shouldSuppressEnter({ key: "Enter", lastModality: "pointer", element: fakeEl() }), true);
});

test("shouldSuppressEnter: navegando con teclado Enter funciona normal", () => {
    assert.equal(shouldSuppressEnter({ key: "Enter", lastModality: "keyboard", element: fakeEl() }), false);
    assert.equal(shouldSuppressEnter({ key: "Enter", lastModality: null, element: fakeEl() }), false);
});

test("shouldSuppressEnter: no toca inputs, otras teclas ni controles con data-enter-activates", () => {
    assert.equal(shouldSuppressEnter({ key: "Enter", lastModality: "pointer", element: fakeEl({ activatable: false }) }), false);
    assert.equal(shouldSuppressEnter({ key: "a", lastModality: "pointer", element: fakeEl() }), false);
    assert.equal(shouldSuppressEnter({ key: "Enter", lastModality: "pointer", element: fakeEl({ optOut: true }) }), false);
    assert.equal(shouldSuppressEnter({ key: "Enter", lastModality: "pointer", element: null }), false);
});

test("installEnterFocusGuard: tras un clic, Enter quita el foco y cancela el clic nativo sin detener la propagación", () => {
    const el = fakeEl();
    const win = fakeWindow(el);
    installEnterFocusGuard(win);
    win.fire("pointerdown");
    let stopped = false;
    const ev = win.fire("keydown", { key: "Enter", stopPropagation: () => { stopped = true; } });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(el.blurred, true);
    assert.equal(stopped, false, "los atajos de Enter de cada pantalla deben seguir recibiendo el evento");
});

test("installEnterFocusGuard: Tab devuelve el comportamiento normal de Enter", () => {
    const el = fakeEl();
    const win = fakeWindow(el);
    installEnterFocusGuard(win);
    win.fire("pointerdown");
    win.fire("keydown", { key: "Tab" });
    const ev = win.fire("keydown", { key: "Enter" });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(el.blurred, false);
});

test("installEnterFocusGuard: la limpieza quita los listeners", () => {
    const win = fakeWindow(fakeEl());
    const cleanup = installEnterFocusGuard(win);
    assert.ok(win.listeners.keydown && win.listeners.pointerdown);
    cleanup();
    assert.equal(win.listeners.keydown, undefined);
    assert.equal(win.listeners.pointerdown, undefined);
});

test("El layout de (app) monta EnterFocusGuard en todas las pantallas", async () => {
    const src = await readFile(layoutPath, "utf8");
    assert.match(src, /import EnterFocusGuard from '@\/components\/shared\/EnterFocusGuard'/);
    assert.match(src, /<EnterFocusGuard \/>/);
});
