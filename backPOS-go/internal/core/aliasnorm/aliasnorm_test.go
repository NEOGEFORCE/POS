package aliasnorm

import (
	"errors"
	"math"
	"testing"
)

// =============================================================
// Guardianes del contrato de aliasnorm.
//
// Lo que estos tests pinean:
//
//   - CanonicalInvoiceName es idempotente y resistente a diacríticos,
//     casing, whitespace repetido y puntuación de ruido.
//   - DistinctiveInvoiceTokens filtra términos genéricos de empaque y
//     conectores cortos, pero deja pasar compuestos útiles como
//     `ACTIGEN-E` o `48X100G`.
//   - ScoreNameSimilarity respeta la invariante "sin overlap de tokens
//     distintivos ⇒ confianza 0" (caso MILO vs. BOLSA DE ARROZ).
//   - RankSimilarProducts es determinista y ordena por confianza + nombre.
//   - ValidateAndCanonicalize devuelve el sentinel ErrSupplierAliasInvalid
//     cuando falta cualquiera de los tres campos obligatorios.
//
// Si estos tests fallan, el matcher OCR hereda regresiones silenciosas:
// matches espurios, aliases congelados a un barcode viejo o 500 cuando el
// handler debería responder 400.
// =============================================================

func almostEqual(t *testing.T, got, want float64, label string) {
	t.Helper()
	if math.Abs(got-want) > 0.0001 {
		t.Errorf("%s: got %.6f, want %.6f", label, got, want)
	}
}

// ---------------- CanonicalInvoiceName ----------------

func TestCanonicalInvoiceName_UpperYSinAcentos(t *testing.T) {
	got := CanonicalInvoiceName("Café  con Leche")
	want := "CAFE CON LECHE"
	if got != want {
		t.Errorf("acentos+casing: got %q want %q", got, want)
	}
}

func TestCanonicalInvoiceName_ColapsaWhitespace(t *testing.T) {
	cases := map[string]string{
		"  COCA   COLA  400ML ":   "COCA COLA 400ML",
		"MILO\tACTIGEN\n100G":     "MILO ACTIGEN 100G",
		"POSTOBÓN  AGUA\u00a0PET": "POSTOBON AGUA PET",
	}
	for in, want := range cases {
		if got := CanonicalInvoiceName(in); got != want {
			t.Errorf("CanonicalInvoiceName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCanonicalInvoiceName_ColapsaPuntuacionRuidosa(t *testing.T) {
	cases := map[string]string{
		"COCA---COLA 400ML":     "COCA-COLA 400ML",
		"COCA...COLA":           "COCA.COLA",
		"***OFERTA ESPECIAL***": "OFERTA ESPECIAL",
		"-COCA 400":             "COCA 400",
		"COCA 400-":             "COCA 400",
		"COCA 400.":             "COCA 400",
		",COCA, COLA,":          "COCA, COLA",
	}
	for in, want := range cases {
		if got := CanonicalInvoiceName(in); got != want {
			t.Errorf("CanonicalInvoiceName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCanonicalInvoiceName_PreservaSignosUtiles(t *testing.T) {
	// Compuestos útiles para distinguir productos deben pasar enteros.
	cases := map[string]string{
		"MILO ACTIGEN-E 48X100G": "MILO ACTIGEN-E 48X100G",
		"AGUA 600ML x24":         "AGUA 600ML X24",
		"IVA 19% + IBUA 18%":     "IVA 19% + IBUA 18%",
		"ARROZ 5/8KG":            "ARROZ 5/8KG",
	}
	for in, want := range cases {
		if got := CanonicalInvoiceName(in); got != want {
			t.Errorf("CanonicalInvoiceName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCanonicalInvoiceName_Idempotente(t *testing.T) {
	in := "   Postobón  AGUA   600ML -- Promo "
	first := CanonicalInvoiceName(in)
	second := CanonicalInvoiceName(first)
	if first != second {
		t.Errorf("idempotencia rota: first=%q second=%q", first, second)
	}
}

func TestCanonicalInvoiceName_VacioODeSoloPuntuacion(t *testing.T) {
	cases := []string{"", "   ", "---", "...", "¿?!"}
	for _, in := range cases {
		if got := CanonicalInvoiceName(in); got != "" {
			t.Errorf("entrada de ruido %q debió colapsar a '', got %q", in, got)
		}
	}
}

// ---------------- DistinctiveInvoiceTokens ----------------

func TestDistinctiveInvoiceTokens_FiltraGenericosYConectoresCortos(t *testing.T) {
	// `MILO ACTIGEN-E BOLSA CIERRE 48X100G CO`
	// Esperado: {MILO, ACTIGEN, 48X100G}.
	//   ACTIGEN-E → se parte en ACTIGEN + E; "E" (len=1) cae por longitud.
	//   BOLSA, CIERRE → genérico.
	//   CO (len=2) → conector corto por longitud.
	got := DistinctiveInvoiceTokens("MILO ACTIGEN-E BOLSA CIERRE 48X100G CO")
	want := []string{"MILO", "ACTIGEN", "48X100G"}
	if !equalStringSlices(got, want) {
		t.Errorf("tokens distintivos del caso Milo: got %v, want %v", got, want)
	}
}

func TestDistinctiveInvoiceTokens_FiltraPaquetePromoDisplayUnd(t *testing.T) {
	// Todo lo que queda es ruido genérico y conectores: no hay tokens
	// distintivos.
	got := DistinctiveInvoiceTokens("PAQUETE DISPLAY PROMO UND BOLSA")
	if len(got) != 0 {
		t.Errorf("todos genéricos: got %v, want vacío", got)
	}
}

func TestDistinctiveInvoiceTokens_IncluyeMedidasComoDistintivas(t *testing.T) {
	// `100G` y `48X100G` son distintivos; no deben filtrarse por ser
	// numéricos ni por tener letras únicas.
	got := DistinctiveInvoiceTokens("MILO 100G")
	wantContains := []string{"MILO", "100G"}
	for _, tok := range wantContains {
		if !containsString(got, tok) {
			t.Errorf("tokens para MILO 100G debieron incluir %q, got %v", tok, got)
		}
	}
}

func TestDistinctiveInvoiceTokens_InsensibleACasing(t *testing.T) {
	a := DistinctiveInvoiceTokens("Milo Actigen-E 100g")
	b := DistinctiveInvoiceTokens("MILO ACTIGEN-E 100G")
	if !equalStringSlices(a, b) {
		t.Errorf("tokens dependen del casing: %v vs %v", a, b)
	}
}

func TestIsGenericPackagingToken(t *testing.T) {
	for _, g := range []string{"BOLSA", "CAJA", "PAQUETE", "CIERRE", "UND", "DISPLAY", "PROMO"} {
		if !IsGenericPackagingToken(g) {
			t.Errorf("%s debe ser genérico", g)
		}
	}
	for _, keep := range []string{"MILO", "ACTIGEN", "48X100G", "ARROZ"} {
		if IsGenericPackagingToken(keep) {
			t.Errorf("%s NO debe ser genérico", keep)
		}
	}
}

// ---------------- ScoreNameSimilarity ----------------

func TestScoreNameSimilarity_SinOverlapDaCero(t *testing.T) {
	q := DistinctiveInvoiceTokens("MILO ACTIGEN-E BOLSA CIERRE 48X100G CO")
	c := DistinctiveInvoiceTokens("BOLSA DE ARROZ 500G")
	// `BOLSA` ya se filtró en ambos lados por ser genérico; `DE` por corto.
	// Query queda con {MILO, ACTIGEN-E, 48X100G}, candidato con {ARROZ, 500G}.
	// Overlap = 0 ⇒ confidence = 0.
	if got := ScoreNameSimilarity(q, c); got != 0 {
		t.Errorf("`BOLSA DE ARROZ` no comparte tokens distintivos con MILO: got %v want 0", got)
	}
}

func TestScoreNameSimilarity_MatchParcial(t *testing.T) {
	// Con la nueva semántica, `48X100G` y `100G` son equivalentes (medida
	// unitaria del pack): el candidato cubre los tres tokens del query y el
	// scorer debe devolver 1.0. La única pérdida posible venía de que las
	// medidas no coincidieran, pero `extractUnitSize` colapsa el pack al
	// mismo "100G" del candidato.
	q := DistinctiveInvoiceTokens("MILO ACTIGEN-E 48X100G CO")
	c := DistinctiveInvoiceTokens("MILO ACTIGEN-E 100G")
	almostEqual(t, ScoreNameSimilarity(q, c), 1.0, "48X100G y 100G matchean por medida unitaria del pack")
}

func TestScoreNameSimilarity_MatchParcialSinSize(t *testing.T) {
	// Candidato que cubre 2 de 3 tokens del query y NO menciona medida:
	// coverage=2/3, precision=2/2=1 ⇒ F1 = 0.8. Documenta el techo del
	// match "muy bueno pero incompleto": no hay size conflict porque el
	// candidato no afirma otra medida, sólo omite la del query.
	q := DistinctiveInvoiceTokens("MILO ACTIGEN-E 100G")
	c := DistinctiveInvoiceTokens("MILO ACTIGEN-E CO")
	almostEqual(t, ScoreNameSimilarity(q, c), 0.8, "match parcial 2 de 3 sin size conflict")
}

func TestScoreNameSimilarity_PenalizaTamanosIncompatibles(t *testing.T) {
	// Caso específico del enunciado: 190G frente a 25G son medidas que se
	// contradicen; el scorer debe aplicar el 0.5× por size conflict para
	// que un candidato con la medida equivocada no gane sólo por compartir
	// nombres alfabéticos.
	q := DistinctiveInvoiceTokens("LA LECHERA LACARISTRA 12(26X25G) CO")
	cBad := DistinctiveInvoiceTokens("LA LECHERA 190G")
	cGood := DistinctiveInvoiceTokens("LA LECHERA RISTRA 25G")
	bad := ScoreNameSimilarity(q, cBad)
	good := ScoreNameSimilarity(q, cGood)
	if !(good > bad) {
		t.Errorf("25G debe superar a 190G frente al query de 26X25G: good=%v bad=%v", good, bad)
	}
	if good < 0.8 {
		t.Errorf("match correcto debe quedar >= 0.8; got %v", good)
	}
}

func TestScoreNameSimilarity_ContainmentAlfabeticoControlado(t *testing.T) {
	// LACARISTRA (10 letras) contiene RISTRA (6 letras) ⇒ afinidad 0.85.
	// LAS (3 letras) nunca debe disparar containment porque no supera el
	// umbral de longitud: ya se filtra como genérico, pero la invariante es
	// que una lectura cruda no provoque match espurio tampoco.
	q := DistinctiveInvoiceTokens("LACARISTRA")
	c := DistinctiveInvoiceTokens("RISTRA")
	s := ScoreNameSimilarity(q, c)
	if s < 0.8 || s > 0.9 {
		t.Errorf("containment debe estar en [0.8, 0.9]: got %v", s)
	}
}

func TestScoreNameSimilarity_MatchExactoVale1(t *testing.T) {
	q := DistinctiveInvoiceTokens("MILO ACTIGEN-E 100G")
	c := DistinctiveInvoiceTokens("MILO ACTIGEN-E 100G")
	almostEqual(t, ScoreNameSimilarity(q, c), 1.0, "match exacto")
}

func TestScoreNameSimilarity_CastigaCandidatosEnormes(t *testing.T) {
	q := DistinctiveInvoiceTokens("MILO 100G")
	cSmall := DistinctiveInvoiceTokens("MILO 100G")
	cLarge := DistinctiveInvoiceTokens("MILO ACTIGEN-E CHOCO POWER 1KG CEREAL ENERGETICO")
	small := ScoreNameSimilarity(q, cSmall)
	large := ScoreNameSimilarity(q, cLarge)
	if !(small > large) {
		t.Errorf("match 1-a-1 debe ganarle a candidato gigante: small=%v large=%v", small, large)
	}
}

// ---------------- RankSimilarProducts ----------------

func TestRankSimilarProducts_CasoMiloExcluyeBolsaDeArroz(t *testing.T) {
	// Caso guardián del enunciado: para
	// `MILO ACTIGEN-E BOLSA CIERRE 48X100G CO`, productos que SÓLO
	// comparten BOLSA no pueden aparecer.
	candidates := []SimilarProductCandidate{
		{Barcode: "7701-ARROZ", ProductName: "BOLSA DE ARROZ 500G"},
		{Barcode: "7701-MILO1", ProductName: "MILO ACTIGEN 100G"},
		{Barcode: "7701-MILO2", ProductName: "MILO 400G"},
		{Barcode: "7701-DISPLAY", ProductName: "DISPLAY BOLSA PROMO"},
	}
	got := RankSimilarProducts("MILO ACTIGEN-E BOLSA CIERRE 48X100G CO", candidates, 5)
	for _, r := range got {
		if r.Barcode == "7701-ARROZ" {
			t.Fatalf("BOLSA DE ARROZ NO puede aparecer para query MILO; got %+v", r)
		}
		if r.Barcode == "7701-DISPLAY" {
			t.Fatalf("DISPLAY BOLSA PROMO NO puede aparecer (sólo genéricos)")
		}
	}
	// MILO ACTIGEN 100G debe venir primero (más tokens distintivos).
	if len(got) == 0 || got[0].Barcode != "7701-MILO1" {
		t.Fatalf("MILO ACTIGEN 100G debe ser el top; got %+v", got)
	}
	// MILO 400G debe estar presente pero más abajo.
	if len(got) < 2 || got[1].Barcode != "7701-MILO2" {
		t.Fatalf("MILO 400G debe ser el segundo; got %+v", got)
	}
}

func TestRankSimilarProducts_ConfidenceDescendente(t *testing.T) {
	candidates := []SimilarProductCandidate{
		{Barcode: "A", ProductName: "COCA COLA 400ML"},
		{Barcode: "B", ProductName: "COCA LIGHT 400ML"},
		{Barcode: "C", ProductName: "COCA COLA LIGHT ZERO 2500ML CON LIMON"},
	}
	got := RankSimilarProducts("COCA COLA 400ML", candidates, 5)
	for i := 1; i < len(got); i++ {
		if got[i-1].Confidence < got[i].Confidence {
			t.Errorf("confianza no decreciente: %+v antes de %+v", got[i-1], got[i])
		}
	}
}

func TestRankSimilarProducts_EmpateRompePorNombre(t *testing.T) {
	// Dos candidatos con la misma confianza: el empate se rompe por
	// nombre canonicalizado ascendente para que el orden sea estable.
	candidates := []SimilarProductCandidate{
		{Barcode: "B", ProductName: "MILO 100G"},
		{Barcode: "A", ProductName: "MILO 100G"},
	}
	got := RankSimilarProducts("MILO 100G", candidates, 5)
	if len(got) != 2 {
		t.Fatalf("se esperaban 2 candidatos empatados, got %d", len(got))
	}
	// Nombre canónico igual: desempata por el primero encontrado estable.
	// Lo importante es que la salida sea determinista (misma entrada ⇒
	// misma salida).
	again := RankSimilarProducts("MILO 100G", candidates, 5)
	for i := range got {
		if got[i].Barcode != again[i].Barcode {
			t.Errorf("resultado NO determinista entre llamadas idénticas: %v vs %v", got, again)
		}
	}
}

func TestRankSimilarProducts_RespetaLimit(t *testing.T) {
	candidates := []SimilarProductCandidate{
		{Barcode: "A", ProductName: "MILO 100G"},
		{Barcode: "B", ProductName: "MILO 200G"},
		{Barcode: "C", ProductName: "MILO 400G"},
		{Barcode: "D", ProductName: "MILO 1KG"},
	}
	got := RankSimilarProducts("MILO 100G", candidates, 2)
	if len(got) != 2 {
		t.Errorf("limit=2 debe recortar a 2, got %d", len(got))
	}
}

func TestRankSimilarProducts_SinQueryDistintivoDevuelveNil(t *testing.T) {
	// Query compuesto únicamente por genéricos.
	candidates := []SimilarProductCandidate{
		{Barcode: "A", ProductName: "MILO 100G"},
	}
	if got := RankSimilarProducts("BOLSA PAQUETE PROMO", candidates, 5); got != nil {
		t.Errorf("sin tokens distintivos del query debe devolver nil, got %v", got)
	}
}

func TestRankSimilarProducts_IgnoraCandidatosSinTokensDistintivos(t *testing.T) {
	candidates := []SimilarProductCandidate{
		{Barcode: "A", ProductName: "BOLSA UND PROMO"},
		{Barcode: "B", ProductName: "MILO 100G"},
	}
	got := RankSimilarProducts("MILO 100G", candidates, 5)
	for _, r := range got {
		if r.Barcode == "A" {
			t.Errorf("candidato sin tokens distintivos no debe entrar; got %+v", r)
		}
	}
}

func TestRankSimilarProducts_LaLecheraRistraTopConAltaConfianza(t *testing.T) {
	// Guardián del caso de inteligencia de aliases: para
	// `LA LECHERA LACARISTRA 12(26X25G) CO`, el matcher debe:
	//   - reconocer `LACARISTRA` ⇔ `RISTRA` por containment alfabético,
	//   - reconocer `26X25G` ⇔ `25G` por medida unitaria del pack,
	//   - penalizar las presentaciones de tamaño incompatible (190G, 320G)
	//     y la mixta (LATA100G) donde la medida interna 100G no empareja.
	candidates := []SimilarProductCandidate{
		{Barcode: "7701-RISTRA", ProductName: "LA LECHERA RISTRA 25G"},
		{Barcode: "7701-190G", ProductName: "LA LECHERA 190G"},
		{Barcode: "7701-320G", ProductName: "LA LECHERA 320G"},
		{Barcode: "7701-LATA100", ProductName: "LA LECHERA LATA100G"},
	}
	got := RankSimilarProducts("LA LECHERA LACARISTRA 12(26X25G) CO", candidates, 5)
	if len(got) == 0 {
		t.Fatalf("se esperaba al menos un ranking; got vacío")
	}
	if got[0].Barcode != "7701-RISTRA" {
		t.Fatalf("LA LECHERA RISTRA 25G debe ser el top; got %+v", got)
	}
	if got[0].Confidence < 0.8 {
		t.Fatalf("confianza del top debe ser >= 0.8; got %v (%v)", got[0].Confidence, got)
	}
	// Los otros candidatos pueden aparecer, pero por debajo del top.
	for _, r := range got[1:] {
		if r.Confidence >= got[0].Confidence {
			t.Errorf("ningún candidato con tamaño incompatible debe empatar al top: %+v", r)
		}
	}
}

func TestRankSimilarProducts_MiloContraBolsaSigueLimpio(t *testing.T) {
	// Pin del contrato original: la mejora de ScoreNameSimilarity no puede
	// reintroducir el falso positivo "BOLSA DE ARROZ" al query MILO.
	candidates := []SimilarProductCandidate{
		{Barcode: "7701-ARROZ", ProductName: "BOLSA DE ARROZ 500G"},
		{Barcode: "7701-MILO1", ProductName: "MILO ACTIGEN 100G"},
		{Barcode: "7701-DISPLAY", ProductName: "DISPLAY BOLSA PROMO"},
	}
	got := RankSimilarProducts("MILO ACTIGEN-E BOLSA CIERRE 48X100G CO", candidates, 5)
	for _, r := range got {
		if r.Barcode == "7701-ARROZ" {
			t.Fatalf("BOLSA DE ARROZ nunca puede aparecer para query MILO; got %+v", r)
		}
		if r.Barcode == "7701-DISPLAY" {
			t.Fatalf("DISPLAY BOLSA PROMO sólo comparte genéricos; got %+v", r)
		}
	}
	if len(got) == 0 || got[0].Barcode != "7701-MILO1" {
		t.Fatalf("MILO ACTIGEN 100G debe ser el top; got %+v", got)
	}
}

// ---------------- extractUnitSize ----------------

func TestExtractUnitSize_PackYSufijos(t *testing.T) {
	cases := map[string]string{
		"25G":       "25G",
		"26X25G":    "25G",
		"48X100G":   "100G",
		"190G":      "190G",
		"500ML":     "500ML",
		"LATA100G":  "100G",
		"ACTIGEN":   "",
		"MILO":      "",
		"100":       "",
		"":          "",
		"1KG":       "1KG",
		"CAJA12X1L": "1L",
	}
	for in, want := range cases {
		if got := extractUnitSize(in); got != want {
			t.Errorf("extractUnitSize(%q) = %q; want %q", in, got, want)
		}
	}
}

// ---------------- ValidateAndCanonicalize ----------------

func TestValidateAndCanonicalize_RechazaSupplierCero(t *testing.T) {
	_, err := ValidateAndCanonicalize(0, "COCA", "7701")
	if !errors.Is(err, ErrSupplierAliasInvalid) {
		t.Errorf("supplierId=0 debe devolver ErrSupplierAliasInvalid, got %v", err)
	}
}

func TestValidateAndCanonicalize_RechazaInvoiceNameVacio(t *testing.T) {
	for _, name := range []string{"", "   ", "---", "¿¿¿"} {
		_, err := ValidateAndCanonicalize(1, name, "7701")
		if !errors.Is(err, ErrSupplierAliasInvalid) {
			t.Errorf("invoiceName %q debe fallar validación, got %v", name, err)
		}
	}
}

func TestValidateAndCanonicalize_RechazaBarcodeVacio(t *testing.T) {
	_, err := ValidateAndCanonicalize(1, "COCA", "   ")
	if !errors.Is(err, ErrSupplierAliasInvalid) {
		t.Errorf("barcode vacío debe fallar validación, got %v", err)
	}
}

func TestValidateAndCanonicalize_CanonicalizaCampos(t *testing.T) {
	fields, err := ValidateAndCanonicalize(5, "  Postobón  Agua  600ml  ", "  abc-123 ")
	if err != nil {
		t.Fatalf("ValidateAndCanonicalize: %v", err)
	}
	if fields.SupplierID != 5 {
		t.Errorf("SupplierID: got %d want 5", fields.SupplierID)
	}
	if fields.InvoiceName != "POSTOBON AGUA 600ML" {
		t.Errorf("InvoiceName canonicalizado: got %q", fields.InvoiceName)
	}
	if fields.ProductBarcode != "ABC-123" {
		t.Errorf("ProductBarcode uppercase+trim: got %q", fields.ProductBarcode)
	}
}

// ---------------- helpers de prueba ----------------

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func containsString(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}
