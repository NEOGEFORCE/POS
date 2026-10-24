// =============================================================================
// enter-focus-guard.mjs
// =============================================================================
//
// Problema: el navegador deja el foco en el último botón que se pulsó con el
// mouse (o lo devuelve al botón que abrió un modal cuando éste se cierra). Si
// luego el usuario presiona Enter —por ejemplo para cobrar o para escanear—,
// el navegador "vuelve a hacer clic" en ese botón y se abre otra vez lo último
// que se seleccionó.
//
// Regla: si la última interacción fue con mouse/touch y el foco está en un
// control que se activa con Enter (botón, enlace, pestaña, ítem de menú...),
// Enter NO lo activa: se le quita el foco y se cancela la acción nativa. El
// evento sigue propagándose, así que los atajos de Enter de cada pantalla
// (cobrar, buscar, confirmar) siguen funcionando.
//
// Quien navega con teclado (Tab, flechas) conserva el comportamiento normal:
// en ese caso Enter sí activa el control enfocado, por accesibilidad.
//
// Excepción explícita: un control (o un contenedor) con el atributo
// `data-enter-activates` mantiene el comportamiento nativo.

/** Controles que el navegador o las librerías activan con Enter. */
export const ENTER_ACTIVATABLE_SELECTOR = [
    "button",
    "a[href]",
    "summary",
    'input[type="button"]',
    'input[type="submit"]',
    'input[type="reset"]',
    'input[type="checkbox"]',
    'input[type="radio"]',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[role="radio"]',
].join(",");

/** Teclas que indican que el usuario está navegando con teclado. */
export const KEYBOARD_NAVIGATION_KEYS = new Set([
    "Tab",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
]);

/**
 * Decide si un Enter debe suprimirse.
 * @param {{ key: string, lastModality: "pointer" | "keyboard" | null, element: any }} input
 * @returns {boolean}
 */
export function shouldSuppressEnter({ key, lastModality, element }) {
    if (key !== "Enter") return false;
    if (lastModality !== "pointer") return false;
    if (!element || typeof element.matches !== "function") return false;
    if (!element.matches(ENTER_ACTIVATABLE_SELECTOR)) return false;
    if (typeof element.closest === "function" && element.closest("[data-enter-activates]")) {
        return false;
    }
    return true;
}

/**
 * Instala el guardián sobre `win` (window). Devuelve la función de limpieza.
 * @param {Window} win
 * @returns {() => void}
 */
export function installEnterFocusGuard(win) {
    if (!win || typeof win.addEventListener !== "function") return () => {};
    /** @type {"pointer" | "keyboard" | null} */
    let lastModality = null;

    const onPointerDown = () => {
        lastModality = "pointer";
    };

    const onKeyDown = (event) => {
        if (KEYBOARD_NAVIGATION_KEYS.has(event.key)) {
            lastModality = "keyboard";
            return;
        }
        const element = win.document ? win.document.activeElement : null;
        if (!shouldSuppressEnter({ key: event.key, lastModality, element })) return;
        // Cancela el "clic" nativo de Enter sobre el botón y suelta el foco.
        // No se detiene la propagación: los atajos de Enter de la pantalla
        // deben seguir recibiendo el evento.
        event.preventDefault();
        if (typeof element.blur === "function") element.blur();
    };

    // Fase de captura para actuar antes que React y las librerías de UI.
    win.addEventListener("pointerdown", onPointerDown, true);
    win.addEventListener("keydown", onKeyDown, true);
    return () => {
        win.removeEventListener("pointerdown", onPointerDown, true);
        win.removeEventListener("keydown", onKeyDown, true);
    };
}
