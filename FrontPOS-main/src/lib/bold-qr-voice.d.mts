// Declaraciones TS para `src/lib/bold-qr-voice.mjs`.
// El módulo real es puro JS para que corra en `node --test` sin bundler.

export const BOLD_QR_VOICE_PREFERRED_LANG: string;
export const BOLD_QR_VOICE_FALLBACK_PREFIX: string;

/**
 * Normaliza un monto COP al entero positivo que esperamos como entrada
 * de voz. Devuelve `null` si la entrada no es un número positivo finito
 * o si no se puede parsear como entero COP.
 */
export function normalizeVoiceAmount(amount: unknown): number | null;

/**
 * Construye la frase canónica que debe decir `speechSynthesis` al
 * confirmarse un pago QR Bold:
 *
 *    "Transferencia recibida por <monto> pesos"
 *
 * El `<monto>` se emite como entero sin separadores de miles para que el
 * motor TTS lo pronuncie de forma natural. Devuelve `null` si el monto
 * es inválido — el llamador debe limitarse al chime en ese caso.
 */
export function buildVoiceAnnouncement(
    amount: unknown,
    opts?: { overrideText?: unknown },
): string | null;

/**
 * Selecciona la mejor voz disponible dado el array que entrega
 * `speechSynthesis.getVoices()`.
 */
export function pickSpanishVoice<T extends { lang?: unknown; default?: unknown; name?: unknown }>(
    voices: ReadonlyArray<T>,
): T | null;

/**
 * Decide si el entorno soporta Web Speech API (speechSynthesis +
 * SpeechSynthesisUtterance).
 */
export function isSpeechSynthesisSupported(globalRef?: object): boolean;
