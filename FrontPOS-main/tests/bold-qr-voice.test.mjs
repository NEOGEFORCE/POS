// =============================================================================
// tests/bold-qr-voice.test.mjs
//
// Tests PUROS para `src/lib/bold-qr-voice.mjs`. Cubren:
//
//   - `normalizeVoiceAmount`: entero positivo honesto, nunca inventa.
//   - `buildVoiceAnnouncement`: frase canónica "Transferencia recibida
//     por <monto> pesos" con `<monto>` como entero SIN separadores de
//     miles (pronunciación natural TTS).
//   - `pickSpanishVoice`: prioriza es-CO, cae a cualquier es-, respeta
//     `default: true`, devuelve null si no hay voces hispanas.
//   - `isSpeechSynthesisSupported`: detecta disponibilidad real sin
//     requerir DOM (acepta un `globalRef` para inyectar stubs).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";

import {
    BOLD_QR_VOICE_PREFERRED_LANG,
    BOLD_QR_VOICE_FALLBACK_PREFIX,
    buildVoiceAnnouncement,
    isSpeechSynthesisSupported,
    normalizeVoiceAmount,
    pickSpanishVoice,
} from "../src/lib/bold-qr-voice.mjs";

// ---------------------------------------------------------------------------
// Constantes del contrato de voz
// ---------------------------------------------------------------------------

test("BOLD_QR_VOICE_PREFERRED_LANG canónico = es-CO", () => {
    assert.equal(BOLD_QR_VOICE_PREFERRED_LANG, "es-CO");
    assert.equal(BOLD_QR_VOICE_FALLBACK_PREFIX, "es-");
});

// ---------------------------------------------------------------------------
// normalizeVoiceAmount
// ---------------------------------------------------------------------------

test("normalizeVoiceAmount: enteros positivos pasan tal cual", () => {
    assert.equal(normalizeVoiceAmount(45800), 45800);
    assert.equal(normalizeVoiceAmount(1), 1);
    assert.equal(normalizeVoiceAmount(1234567), 1234567);
});

test("normalizeVoiceAmount: decimales se truncan (COP no tiene centavos)", () => {
    assert.equal(normalizeVoiceAmount(45800.75), 45800);
    assert.equal(normalizeVoiceAmount(100.5), 100);
    assert.equal(normalizeVoiceAmount(1.9), 1);
});

test("normalizeVoiceAmount: strings con separadores de miles parsean a entero", () => {
    assert.equal(normalizeVoiceAmount("$45.800"), 45800);
    assert.equal(normalizeVoiceAmount("45,800"), 45800);
    assert.equal(normalizeVoiceAmount("1.234.567"), 1234567);
    assert.equal(normalizeVoiceAmount("$ 100"), 100);
    assert.equal(normalizeVoiceAmount("45800 COP"), 45800);
});

test("normalizeVoiceAmount: entradas inválidas → null (nunca inventa)", () => {
    assert.equal(normalizeVoiceAmount(0), null);
    assert.equal(normalizeVoiceAmount(-100), null);
    assert.equal(normalizeVoiceAmount(NaN), null);
    assert.equal(normalizeVoiceAmount(Infinity), null);
    assert.equal(normalizeVoiceAmount(null), null);
    assert.equal(normalizeVoiceAmount(undefined), null);
    assert.equal(normalizeVoiceAmount({}), null);
    assert.equal(normalizeVoiceAmount([]), null);
    assert.equal(normalizeVoiceAmount(""), null);
    assert.equal(normalizeVoiceAmount("abc"), null);
    assert.equal(normalizeVoiceAmount("$"), null);
    assert.equal(normalizeVoiceAmount("0"), null);
});

// ---------------------------------------------------------------------------
// buildVoiceAnnouncement
// ---------------------------------------------------------------------------

test("buildVoiceAnnouncement: frase canónica para monto entero", () => {
    // Entero positivo SIN separadores (pronunciación TTS natural).
    assert.equal(
        buildVoiceAnnouncement(45800),
        "Transferencia recibida por 45800 pesos",
    );
    assert.equal(
        buildVoiceAnnouncement(100),
        "Transferencia recibida por 100 pesos",
    );
    assert.equal(
        buildVoiceAnnouncement(1234567),
        "Transferencia recibida por 1234567 pesos",
    );
});

test("buildVoiceAnnouncement: NUNCA incluye separadores de miles en el número hablado", () => {
    // El motor TTS leería "cuarenta y cinco punto ocho cero cero" si
    // enviáramos "45.800". Para forzar pronunciación natural usamos el
    // entero crudo. Esta prueba es el guardián duro de ese contrato.
    const phrase = buildVoiceAnnouncement(45800);
    assert.ok(phrase, "frase no nula");
    assert.ok(!phrase.includes("45.800"), "no debe contener '45.800'");
    assert.ok(!phrase.includes("45,800"), "no debe contener '45,800'");
    assert.match(phrase, /\b45800\b/, "debe pronunciar como entero crudo");
});

test("buildVoiceAnnouncement: entrada inválida → null (fallback a chime)", () => {
    assert.equal(buildVoiceAnnouncement(undefined), null);
    assert.equal(buildVoiceAnnouncement(null), null);
    assert.equal(buildVoiceAnnouncement(0), null);
    assert.equal(buildVoiceAnnouncement(-10), null);
    assert.equal(buildVoiceAnnouncement(NaN), null);
    assert.equal(buildVoiceAnnouncement("abc"), null);
});

test("buildVoiceAnnouncement: overrideText trimado tiene precedencia (contingencia manual)", () => {
    assert.equal(
        buildVoiceAnnouncement(45800, { overrideText: "  Prueba de voz manual  " }),
        "Prueba de voz manual",
    );
    // overrideText vacío/no-string → se ignora y cae al cálculo normal
    assert.equal(
        buildVoiceAnnouncement(45800, { overrideText: "" }),
        "Transferencia recibida por 45800 pesos",
    );
    assert.equal(
        buildVoiceAnnouncement(45800, { overrideText: "   " }),
        "Transferencia recibida por 45800 pesos",
    );
    assert.equal(
        buildVoiceAnnouncement(45800, { overrideText: 42 }),
        "Transferencia recibida por 45800 pesos",
    );
});

test("buildVoiceAnnouncement: decimales se truncan (centavos no se pronuncian)", () => {
    assert.equal(
        buildVoiceAnnouncement(45800.99),
        "Transferencia recibida por 45800 pesos",
    );
});

// ---------------------------------------------------------------------------
// pickSpanishVoice
// ---------------------------------------------------------------------------

test("pickSpanishVoice: prioriza voz lang='es-CO' sobre cualquier otra", () => {
    const voices = [
        { lang: "en-US", name: "English US" },
        { lang: "es-ES", name: "España" },
        { lang: "es-CO", name: "Colombia" },
        { lang: "es-MX", name: "México" },
    ];
    const pick = pickSpanishVoice(voices);
    assert.ok(pick, "debe elegir una voz");
    assert.equal(pick.lang, "es-CO");
    assert.equal(pick.name, "Colombia");
});

test("pickSpanishVoice: sin es-CO cae a cualquier es-* y prefiere default:true", () => {
    const voices = [
        { lang: "es-ES", name: "España", default: false },
        { lang: "es-MX", name: "México", default: true },
        { lang: "es-AR", name: "Argentina", default: false },
    ];
    const pick = pickSpanishVoice(voices);
    assert.ok(pick);
    assert.equal(pick.lang, "es-MX", "debe preferir default:true");
});

test("pickSpanishVoice: tolera variantes es_419, es_CO con guion bajo", () => {
    const voices = [
        { lang: "en-US", name: "English" },
        { lang: "es_419", name: "Latino" },
    ];
    const pick = pickSpanishVoice(voices);
    assert.ok(pick, "variantes con guion bajo deben contar como hispanas");
    assert.equal(pick.lang, "es_419");
});

test("pickSpanishVoice: devuelve null si no hay voces hispanas", () => {
    assert.equal(
        pickSpanishVoice([
            { lang: "en-US" },
            { lang: "fr-FR" },
            { lang: "pt-BR" },
        ]),
        null,
    );
});

test("pickSpanishVoice: array vacío o no-array → null", () => {
    assert.equal(pickSpanishVoice([]), null);
    assert.equal(pickSpanishVoice(null), null);
    assert.equal(pickSpanishVoice(undefined), null);
    assert.equal(pickSpanishVoice("foo"), null);
});

test("pickSpanishVoice: ignora entradas sin lang string", () => {
    const voices = [
        { lang: null },
        { lang: 42 },
        { name: "sin lang" },
        { lang: "es-CO", name: "válido" },
    ];
    const pick = pickSpanishVoice(voices);
    assert.ok(pick);
    assert.equal(pick.name, "válido");
});

// ---------------------------------------------------------------------------
// isSpeechSynthesisSupported
// ---------------------------------------------------------------------------

test("isSpeechSynthesisSupported: false cuando falta API (SSR / Node puro)", () => {
    // Pasar un stub que no tiene speechSynthesis ni Utter.
    assert.equal(isSpeechSynthesisSupported({}), false);
    assert.equal(isSpeechSynthesisSupported(null), false);
    assert.equal(isSpeechSynthesisSupported(undefined), false);
});

test("isSpeechSynthesisSupported: true cuando ambos existen", () => {
    const stub = {
        speechSynthesis: { speak() {} },
        SpeechSynthesisUtterance: function Utter() {},
    };
    assert.equal(isSpeechSynthesisSupported(stub), true);
});

test("isSpeechSynthesisSupported: false si falta uno de los dos", () => {
    assert.equal(
        isSpeechSynthesisSupported({ speechSynthesis: {} }),
        false,
        "falta Utter",
    );
    assert.equal(
        isSpeechSynthesisSupported({ SpeechSynthesisUtterance: function U() {} }),
        false,
        "falta speechSynthesis",
    );
});
