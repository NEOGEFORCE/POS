// =============================================================================
// src/lib/bold-qr-voice.mjs
//
// Helpers PUROS para el anuncio por voz (Web Speech API) del cobro QR
// Bold/Bre-B al confirmarse una transferencia (APROBADO con saleId).
//
// Reglas duras:
//   * Toda la lógica es determinista — no toca DOM, no abre red, no lee
//     storage. Las ramas imperativas (speechSynthesis.speak, mute global)
//     viven en `sales/new/page.tsx`.
//   * NUNCA se inventa un monto: si la entrada no es un entero positivo
//     finito, los helpers devuelven `null` (consumidor decide si cae a
//     chime o descarta el anuncio).
//   * El monto se pronuncia como ENTERO sin separadores de miles, para
//     que el motor TTS lo lea con cadencia natural ("cuarenta y cinco
//     mil ochocientos" en vez de "cuatro cinco punto ocho cero cero").
//   * La frase canónica contractual es:
//        "Transferencia recibida por <monto> pesos"
//     con `<monto>` como entero positivo. No hay fallback silencioso ni
//     texto alternativo cuando el monto es inválido: en ese caso se
//     devuelve `null` y la UI debe no invocar `speechSynthesis.speak`.
//
// Tests PUROS cubren esta superficie en `tests/bold-qr-voice.test.mjs`.
// =============================================================================

/**
 * Prefijo canónico del preferido de idioma del motor TTS. El cliente real
 * es Colombia, pero toleramos cualquier variante hispana ("es-", "es-CO",
 * "es-ES", "es-MX",...) porque los navegadores de las cajeras pueden
 * ofrecer sólo "es-ES" o "es-419". Documentado en el prompt del sprint.
 */
export const BOLD_QR_VOICE_PREFERRED_LANG = "es-CO";
export const BOLD_QR_VOICE_FALLBACK_PREFIX = "es-";

/**
 * Normaliza un monto COP al entero positivo que esperamos como entrada
 * de voz. Reglas:
 *   - `number` entero positivo finito → entero (Math.floor).
 *   - `number` con decimales → se trunca con Math.floor (los COP no
 *     tienen centavos operativos en Bold).
 *   - `string` con dígitos opcionales separadores `.` o `,` → parsea
 *     ignorando todo lo no-dígito.
 *   - Cualquier otra entrada o resultado <= 0 → `null`.
 *
 * @param {unknown} amount
 * @returns {number | null}
 */
export function normalizeVoiceAmount(amount) {
    if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) {
        return Math.floor(amount);
    }
    if (typeof amount === "string") {
        const digitsOnly = amount.replace(/[^\d]/g, "");
        if (!digitsOnly) return null;
        const parsed = parseInt(digitsOnly, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) return null;
        return parsed;
    }
    return null;
}

/**
 * Construye la frase que debe decir `speechSynthesis` al confirmarse un
 * pago QR Bold. Devuelve `null` si el monto es inválido — el llamador
 * debe entonces no invocar al motor de voz y limitarse al chime.
 *
 * Reglas:
 *   - La frase canónica es "Transferencia recibida por <monto> pesos".
 *   - `<monto>` se emite como entero sin separadores de miles. Esto es
 *     intencional: muchos motores TTS leen "45.800" como "cuatro cinco
 *     punto ocho cero cero". Como entero el motor lo pronuncia como
 *     "cuarenta y cinco mil ochocientos".
 *   - Se puede pasar `overrideText` (string no vacío trimado) para
 *     casos de contingencia (p.ej. prueba manual de la voz). Si no es
 *     string válido, se ignora.
 *
 * @param {unknown} amount - monto COP (number o string parseable)
 * @param {{ overrideText?: unknown }} [opts]
 * @returns {string | null}
 */
export function buildVoiceAnnouncement(amount, opts) {
    const override =
        opts && typeof opts.overrideText === "string" ? opts.overrideText.trim() : "";
    if (override) return override;
    const normalized = normalizeVoiceAmount(amount);
    if (normalized === null) return null;
    return `Transferencia recibida por ${normalized} pesos`;
}

/**
 * Selecciona la mejor voz disponible para el anuncio. Entrada: la lista
 * `voices` que entrega `speechSynthesis.getVoices()`. Reglas:
 *   - Preferir una voz con `lang === "es-CO"`.
 *   - Si no hay, cualquier voz que comience con "es-" / "es_" / "es".
 *   - Si hay varias, preferir la marcada `default: true` del navegador.
 *   - Devolver `null` si no hay voces hispanas (el llamador decide si
 *     igual pide `speak` con `lang="es-CO"` — algunos navegadores
 *     cargan la voz tras un pequeño delay).
 *
 * @param {ReadonlyArray<{ lang?: unknown; default?: unknown; name?: unknown }>} voices
 * @returns {{ lang?: unknown; default?: unknown; name?: unknown } | null}
 */
export function pickSpanishVoice(voices) {
    if (!Array.isArray(voices) || voices.length === 0) return null;
    const normalized = voices
        .filter((v) => v && typeof v === "object" && typeof v.lang === "string")
        .map((v) => ({ voice: v, lang: v.lang.trim() }));
    if (normalized.length === 0) return null;
    // 1) exacto "es-CO"
    const coExact = normalized.find((e) => e.lang === BOLD_QR_VOICE_PREFERRED_LANG);
    if (coExact) return coExact.voice;
    // 2) cualquier es- (es-ES, es-MX, es-419, es_CO,...)
    const spanish = normalized.filter((e) => /^es[-_]/i.test(e.lang) || /^es$/i.test(e.lang));
    if (spanish.length === 0) return null;
    // 3) preferir default:true
    const def = spanish.find((e) => e.voice.default === true);
    if (def) return def.voice;
    return spanish[0].voice;
}

/**
 * Decide si el entorno soporta Web Speech API para hablar. Devuelve
 * `true` solo cuando `window.speechSynthesis` y `window.SpeechSynthesisUtterance`
 * están disponibles. Útil en el componente para caer a sólo-chime
 * cuando el navegador es viejo o el usuario está en SSR.
 *
 * @param {object} [globalRef]
 * @returns {boolean}
 */
export function isSpeechSynthesisSupported(globalRef) {
    const g = globalRef || (typeof globalThis !== "undefined" ? globalThis : undefined);
    if (!g || typeof g !== "object") return false;
    const synth = /** @type {any} */ (g).speechSynthesis;
    const Utter = /** @type {any} */ (g).SpeechSynthesisUtterance;
    return (
        synth !== undefined &&
        synth !== null &&
        typeof Utter === "function"
    );
}
