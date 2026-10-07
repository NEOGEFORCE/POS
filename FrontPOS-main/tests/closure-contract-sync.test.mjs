import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ============================================================================
// Guardianes de SINCRONIZACION DE CONTRATO entre /dashboard/closure/page.tsx
// y los handlers endurecidos del backend (dashboard_handler.go + auth_handler.go).
//
// Historia: durante la auditoria P0/P1 el agente frontend introdujo tres
// desalineaciones que el agente backend no vio porque sus tests estaticos
// miraban SOLO el .go. Este archivo cruza los dos lados.
//
//   1. El POST /cashier-closure/close debia enviar `authorizationToken`
//      (nombre canonico leido por SaveClosure, json tag en el struct
//      del handler). El frontend enviaba `authorizedByToken` y el
//      backend ignoraba el token: para faltante firmado por admin
//      llegaba 403.
//
//   2. El PUT /cashier-history/:id debia enviar solo claves de la
//      allowlist estricta del handler UpdateClosure. El frontend
//      enviaba `expected_cash`, `difference`, `total_nequi_real`,
//      `total_daviplata_real` -- claves fuera de allowlist que
//      disparan 400 "Campo no editable: X" y rompen el PUT completo.
//
//   3. El POST /telegram-report-partial debia enviar `note` (singular,
//      tag canonico del handler SendPartialReport). El frontend enviaba
//      `notes` y la nota del cajero se perdia silenciosamente en el PDF
//      y en Telegram.
//
// Si alguna de las tres asserts falla, el PR del frontend volvio a
// desincronizarse del backend y debe arreglarse antes de mergear.
// ============================================================================

const page = readFileSync(
  new URL("../src/app/(app)/dashboard/closure/page.tsx", import.meta.url),
  "utf8",
);

test("POST close: envia authorizationToken (nombre canonico del handler Go)", () => {
  // SaveClosure en dashboard_handler.go lee:
  //   AuthorizationToken string `json:"authorizationToken,omitempty"`
  // El nombre canonico y unico que el backend reconoce es
  // `authorizationToken`. Si el frontend envia solo `authorizedByToken`
  // la autorizacion server-side jamas se verifica.
  assert.match(
    page,
    /createPayload\.authorizationToken\s*=\s*adminAuthToken/,
    "falta createPayload.authorizationToken = adminAuthToken (contrato canonico del backend)",
  );
});

test("POST close: envia clientTxId (nombre canonico de la migracion 018)", () => {
  // El backend lee tanto el camel `clientTxId` (via json tag del struct
  // envolvente y del modelo). El snake alias es opcional/defensivo.
  assert.match(
    page,
    /createPayload\.clientTxId\s*=\s*clientClosureId/,
    "falta createPayload.clientTxId = clientClosureId (contrato idempotente del backend)",
  );
});

test("PUT edit: payload solo contiene claves de la allowlist del backend", () => {
  // Allowlist en dashboard_handler.go#updateClosureAllowedKeys:
  //   start_date, end_date, date, physical_cash, coins100/200/500/1000,
  //   cash_bills, cash_breakdown, authorized_by, total_expenses,
  //   total_returns, expenses_detail, forgotten_expenses.
  // Enviar cualquier otra clave hace que el handler responda 400
  // "Campo no editable: X" y el PUT falle entero.
  //
  // Delimitamos SOLO el objeto literal `const updatePayload: any = {...};`
  // y sus asignaciones posteriores `updatePayload.X = ...` hasta el
  // `await apiFetch(` del PUT. Nada que viva fuera de esa region cuenta
  // como payload del PUT.
  const literalMatch = page.match(
    /const\s+updatePayload:\s*any\s*=\s*\{([\s\S]*?)\};/,
  );
  assert.ok(literalMatch, "no se pudo delimitar el literal updatePayload");
  const literalBlock = literalMatch[1];

  const afterLiteralIdx = (literalMatch.index ?? 0) + literalMatch[0].length;
  const beforePutIdx = page.indexOf(
    "await apiFetch(`/dashboard/cashier-history/${editId}`",
    afterLiteralIdx,
  );
  assert.ok(beforePutIdx > afterLiteralIdx, "no se encontro el apiFetch PUT despues del literal");
  const assignmentsBlock = page.slice(afterLiteralIdx, beforePutIdx);

  const forbidden = [
    "expected_cash",
    "difference",
    "total_nequi_real",
    "total_daviplata_real",
  ];
  for (const key of forbidden) {
    // El literal no debe inicializar la clave prohibida.
    assert.doesNotMatch(
      literalBlock,
      new RegExp(`\\b${key}:\\s*[^,}\\s]`),
      `el literal updatePayload no debe incluir ${key} (fuera de allowlist en backend)`,
    );
    // Ni las asignaciones posteriores deben agregarla.
    assert.doesNotMatch(
      assignmentsBlock,
      new RegExp(`updatePayload\\.${key}\\s*=`),
      `updatePayload no debe asignar ${key} despues del literal (fuera de allowlist)`,
    );
  }
});

test("POST partial: envia note singular (tag canonico de SendPartialReport)", () => {
  // SendPartialReport en dashboard_handler.go define:
  //   type partialBody struct { ... Note string `json:"note"` }
  // Si el frontend envia solo `notes` (plural), la nota del cajero se
  // pierde silenciosamente en Telegram y en el PDF del reporte parcial.
  const partialRegion = page.match(
    /const\s+handleSendPartial\s*=\s*async[\s\S]*?setIsSendingPartial\(false\);\s*\}\s*\}\s*;/,
  );
  assert.ok(partialRegion, "no se pudo delimitar handleSendPartial");
  assert.match(
    partialRegion[0],
    /\bnote:\s*closingNote/,
    "handleSendPartial debe enviar `note:` (singular, canonico del backend)",
  );
});

test("POST close: payload no envia `id` ni `ID` en modo CREATE", () => {
  // El handler SaveClosure rechaza explicitamente id != 0 con 400
  // "No se admite id en la creacion de un cierre". Confirma que la
  // limpieza esta en el camino que arma `baseClosureData`.
  const createRegion = page.match(
    /if\s*\(!isEditMode\)\s*\{\s*delete\s+baseClosureData\.id;\s*delete\s+baseClosureData\.ID;/,
  );
  assert.ok(
    createRegion,
    "falta la limpieza de id/ID antes del POST de create (el backend lo rechaza con 400)",
  );
});
