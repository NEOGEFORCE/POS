package services

import (
	"math"
	"strings"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================
// Contrato del lector de facturas:
//
//   - normalizeExtractedItem es el único punto donde el OCR entra al
//     sistema. Toda invariante que el resto del backend asuma viene
//     de aquí.
//
//   - splitBonusItems convierte el patrón A ("Pague X, lleve Y" en una
//     sola línea con bonus_quantity) en dos ítems independientes.
//
//   - buildInvoicePrompt inyecta pistas fiscales condicionales y pide
//     el shape completo (barcode, lineType, bonus_quantity, DTO %/$,
//     impuestos por línea).
//
// Si estos tests fallan, el frontend hereda errores silenciosos:
// descuentos que no se propagan, dobles cobros, mezclas BONUS/REGULAR
// mal partidas o pérdida de devoluciones.
// =============================================================

func almostEqualDTO(t *testing.T, got, want float64, label string) {
	t.Helper()
	if math.Abs(got-want) > 0.01 {
		t.Errorf("%s: got %.4f, want %.4f", label, got, want)
	}
}

// -------------------- normalizeExtractedItem --------------------

func TestNormalizeExtractedItem_PrecedenciaPorcentaje(t *testing.T) {
	// Vienen ambos y el porcentaje domina. El monto se descarta.
	e := models.ExtractedItem{
		Name:               "COCA-COLA 400ML",
		Quantity:           10,
		UnitPrice:          1500,
		TotalPrice:         15000,
		DiscountPercentage: 12,
		DiscountValue:      1800, // consistente con el 12%
	}
	normalizeExtractedItem(&e)
	almostEqualDTO(t, e.DiscountPercentage, 12, "DTO% debe ganar al monto")
	if e.DiscountValue != 0 {
		t.Errorf("DiscountValue debe quedar en 0 por invariante, got %.2f", e.DiscountValue)
	}
}

func TestNormalizeExtractedItem_PrecedenciaPorcentajeInconsistente(t *testing.T) {
	// Si vienen inconsistentes (OCR mal interpretado), el porcentaje sigue
	// ganando y queda un WARN en el log. Nunca intentamos "reconciliar".
	e := models.ExtractedItem{
		Name:               "PRODUCTO X",
		Quantity:           5,
		UnitPrice:          1000,
		TotalPrice:         5000,
		DiscountPercentage: 10,  // dice 10%
		DiscountValue:      250, // pero el monto implicaría 5%
	}
	normalizeExtractedItem(&e)
	almostEqualDTO(t, e.DiscountPercentage, 10, "porcentaje sigue dominando aun con inconsistencia")
}

func TestNormalizeExtractedItem_ConversionMontoAPorcentaje(t *testing.T) {
	// Sólo viene monto. Se convierte a porcentaje con base unitPrice*qty.
	// 150 / (1500 * 1) * 100 = 10%
	e := models.ExtractedItem{
		Name:          "ALPIN LT",
		Quantity:      1,
		UnitPrice:     1500,
		TotalPrice:    1500,
		DiscountValue: 150,
	}
	normalizeExtractedItem(&e)
	almostEqualDTO(t, e.DiscountPercentage, 10, "monto 150 sobre 1500 → 10%")
	if e.DiscountValue != 0 {
		t.Error("DiscountValue debe quedar en 0 tras normalizar")
	}
}

func TestNormalizeExtractedItem_ConversionMontoTotalPorLineaCorrecta(t *testing.T) {
	// Caso que valida la semántica "TOTAL por línea" vs "por unidad".
	// 24 unidades a 2000 cada una = 48000 de base. DTO total = 4800.
	// 4800/48000 = 10%.
	e := models.ExtractedItem{
		Name:          "AGUA 600ML x24",
		Quantity:      24,
		UnitPrice:     2000,
		TotalPrice:    48000,
		DiscountValue: 4800,
	}
	normalizeExtractedItem(&e)
	almostEqualDTO(t, e.DiscountPercentage, 10, "DTO total 4800 sobre 48000 → 10%")
}

func TestNormalizeExtractedItem_GuardianDivisionPorCero(t *testing.T) {
	casos := []struct {
		nombre string
		item   models.ExtractedItem
	}{
		{"unitPrice 0", models.ExtractedItem{Quantity: 5, UnitPrice: 0, TotalPrice: 0, DiscountValue: 100}},
		{"quantity 0 pero positivo", models.ExtractedItem{Quantity: 0, UnitPrice: 1000, DiscountValue: 100}},
		{"ambos 0", models.ExtractedItem{Quantity: 0, UnitPrice: 0, DiscountValue: 100}},
	}
	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			normalizeExtractedItem(&c.item)
			if c.item.DiscountPercentage != 0 {
				t.Errorf("DTO con base cero debe quedar en 0, got %.4f", c.item.DiscountPercentage)
			}
			if math.IsNaN(c.item.DiscountPercentage) || math.IsInf(c.item.DiscountPercentage, 0) {
				t.Errorf("DTO no debe quedar NaN/Inf, got %v", c.item.DiscountPercentage)
			}
		})
	}
}

func TestNormalizeExtractedItem_ClampNegativoYMayor100(t *testing.T) {
	casos := []struct {
		nombre string
		dto    float64
		want   float64
	}{
		{"DTO -5 → 0 (recargo encubierto)", -5, 0},
		{"DTO 120 → 100 (satura)", 120, 100},
		{"DTO 100 → 100 (borde)", 100, 100},
		{"DTO 0 → 0", 0, 0},
		{"DTO NaN → 0", math.NaN(), 0},
		{"DTO +Inf → 0", math.Inf(1), 0},
		{"DTO -Inf → 0", math.Inf(-1), 0},
	}
	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			e := models.ExtractedItem{
				Name:               "X",
				Quantity:           1,
				UnitPrice:          1000,
				TotalPrice:         1000,
				DiscountPercentage: c.dto,
			}
			normalizeExtractedItem(&e)
			almostEqualDTO(t, e.DiscountPercentage, c.want, c.nombre)
		})
	}
}

func TestNormalizeExtractedItem_BONUS_FuerzaDTOCero(t *testing.T) {
	e := models.ExtractedItem{
		Name:               "SORPRESA REGALO",
		Quantity:           2,
		UnitPrice:          0,
		TotalPrice:         0,
		LineType:           "BONUS",
		DiscountPercentage: 15, // vino con DTO, debe anularse
	}
	normalizeExtractedItem(&e)
	if e.DiscountPercentage != 0 {
		t.Errorf("BONUS debe forzar DTO=0, got %.4f", e.DiscountPercentage)
	}
	if e.LineType != models.LineTypeBonus {
		t.Errorf("LineType debe ser BONUS, got %q", e.LineType)
	}
}

func TestNormalizeExtractedItem_RETURN_PreservaDTO(t *testing.T) {
	// Una devolución refleja los términos de la línea original. El DTO% se
	// conserva por auditoría.
	e := models.ExtractedItem{
		Name:               "COCA-COLA 400ML",
		Quantity:           3, // positiva, ya normalizada
		UnitPrice:          1500,
		TotalPrice:         4500,
		LineType:           "RETURN",
		DiscountPercentage: 12,
	}
	normalizeExtractedItem(&e)
	almostEqualDTO(t, e.DiscountPercentage, 12, "RETURN preserva DTO")
	if e.LineType != models.LineTypeReturn {
		t.Errorf("LineType debe ser RETURN, got %q", e.LineType)
	}
	if e.Quantity != 3 {
		t.Errorf("Quantity de RETURN debe permanecer positiva, got %.2f", e.Quantity)
	}
}

func TestNormalizeExtractedItem_SignoNegativoConvierteARETURN(t *testing.T) {
	// Un extraído con quantity < 0 (nota crédito dentro de la factura) se
	// convierte a |q| + LineType = RETURN. No se descarta.
	e := models.ExtractedItem{
		Name:       "COCA-COLA 400ML",
		Quantity:   -2,
		UnitPrice:  1500,
		TotalPrice: 3000,
	}
	normalizeExtractedItem(&e)
	if e.Quantity != 2 {
		t.Errorf("Quantity debe volverse positiva (2), got %.2f", e.Quantity)
	}
	if e.LineType != models.LineTypeReturn {
		t.Errorf("LineType debe ser RETURN cuando qty entró negativa, got %q", e.LineType)
	}
}

func TestNormalizeExtractedItem_ReturnExplicitoConSignoPositivo(t *testing.T) {
	// RETURN explícito con qty positiva no debe perder la etiqueta.
	e := models.ExtractedItem{
		Name:       "LECHE",
		Quantity:   1,
		UnitPrice:  3500,
		TotalPrice: 3500,
		LineType:   "return", // minúsculas por ruido del OCR
	}
	normalizeExtractedItem(&e)
	if e.LineType != models.LineTypeReturn {
		t.Errorf("LineType return debe normalizarse a RETURN, got %q", e.LineType)
	}
}

func TestNormalizeExtractedItem_LineTypeDesconocidoCaeAREGULAR(t *testing.T) {
	e := models.ExtractedItem{
		Name:       "X",
		Quantity:   1,
		UnitPrice:  1000,
		TotalPrice: 1000,
		LineType:   "LO_QUE_SEA",
	}
	normalizeExtractedItem(&e)
	if e.LineType != models.LineTypeRegular {
		t.Errorf("LineType inválido debe caer a REGULAR, got %q", e.LineType)
	}
}

func TestNormalizeExtractedItem_LineTypeVacioEsRegular(t *testing.T) {
	e := models.ExtractedItem{Name: "X", Quantity: 1, UnitPrice: 1000, TotalPrice: 1000}
	normalizeExtractedItem(&e)
	if e.LineType != models.LineTypeRegular {
		t.Errorf("LineType vacío debe defaultear a REGULAR, got %q", e.LineType)
	}
}

func TestNormalizeExtractedItem_ImpuestosClampDefensivo(t *testing.T) {
	e := models.ExtractedItem{
		Name:           "X",
		Quantity:       1,
		UnitPrice:      1000,
		TotalPrice:     1000,
		IvaPercentage:  19,
		IbuaPercentage: -1,          // ruido negativo
		IcuiPercentage: math.NaN(),  // ruido no finito
	}
	normalizeExtractedItem(&e)
	almostEqualDTO(t, e.IvaPercentage, 19, "IVA 19% se conserva")
	if e.IbuaPercentage != 0 {
		t.Errorf("IBUA negativo debe neutralizarse a 0, got %.4f", e.IbuaPercentage)
	}
	if e.IcuiPercentage != 0 || math.IsNaN(e.IcuiPercentage) {
		t.Errorf("ICUI NaN debe neutralizarse a 0, got %v", e.IcuiPercentage)
	}
}

func TestNormalizeExtractedItem_UnitPriceDerivadoDeTotalPriceCuandoFalta(t *testing.T) {
	// Si Claude emitió sólo totalPrice y la cantidad > 0, el unitPrice se
	// deriva. Esto es útil para facturas con una sola columna de precio.
	e := models.ExtractedItem{
		Name:       "GALLETAS",
		Quantity:   6,
		UnitPrice:  0,
		TotalPrice: 9000,
	}
	normalizeExtractedItem(&e)
	almostEqualDTO(t, e.UnitPrice, 1500, "unitPrice = totalPrice/quantity")
}

// -------------------- splitBonusItems --------------------

func TestSplitBonusItems_ParteEnDosLineas(t *testing.T) {
	// Patrón A: una línea con bonus_quantity=1 dentro de qty=4
	// → REGULAR qty=3 unitPrice=1500 + BONUS qty=1 unitPrice=0.
	in := []models.ExtractedItem{
		{
			Name:          "COCA 400ML",
			Quantity:      4,
			BonusQuantity: 1,
			UnitPrice:     1500,
			TotalPrice:    6000,
			LineType:      models.LineTypeRegular,
		},
	}
	out := splitBonusItems(in)
	if len(out) != 2 {
		t.Fatalf("esperaba 2 items (REGULAR + BONUS), got %d", len(out))
	}

	regular := out[0]
	if regular.LineType != models.LineTypeRegular || regular.Quantity != 3 || regular.UnitPrice != 1500 {
		t.Errorf("REGULAR mal partido: %+v", regular)
	}
	if regular.BonusQuantity != 0 {
		t.Errorf("REGULAR hijo no debe arrastrar bonus_quantity, got %.2f", regular.BonusQuantity)
	}
	almostEqualDTO(t, regular.TotalPrice, 4500, "TotalPrice regular hijo = unitPrice*qty")

	bonus := out[1]
	if bonus.LineType != models.LineTypeBonus || bonus.Quantity != 1 || bonus.UnitPrice != 0 {
		t.Errorf("BONUS mal creado: %+v", bonus)
	}
	if bonus.DiscountPercentage != 0 {
		t.Errorf("BONUS debe tener DTO=0, got %.4f", bonus.DiscountPercentage)
	}
}

func TestSplitBonusItems_SinBonusQuantity_EsNoop(t *testing.T) {
	in := []models.ExtractedItem{
		{Name: "X", Quantity: 5, UnitPrice: 100, TotalPrice: 500, LineType: models.LineTypeRegular},
		{Name: "Y", Quantity: 2, UnitPrice: 200, TotalPrice: 400, LineType: models.LineTypeRegular},
	}
	out := splitBonusItems(in)
	if len(out) != 2 {
		t.Fatalf("no debe partir nada, got %d items", len(out))
	}
	for i := range in {
		if out[i].Name != in[i].Name || out[i].Quantity != in[i].Quantity {
			t.Errorf("item %d alterado: in=%+v out=%+v", i, in[i], out[i])
		}
	}
}

func TestSplitBonusItems_PatronBYaSeparado_EsNoop(t *testing.T) {
	// El proveedor emitió BONUS como línea separada. Es patrón B:
	// splitBonusItems lo deja pasar tal cual.
	in := []models.ExtractedItem{
		{Name: "COCA", Quantity: 3, UnitPrice: 1500, TotalPrice: 4500, LineType: models.LineTypeRegular},
		{Name: "COCA", Quantity: 1, UnitPrice: 0, TotalPrice: 0, LineType: models.LineTypeBonus},
	}
	out := splitBonusItems(in)
	if len(out) != 2 {
		t.Fatalf("patrón B debe pasar sin cambios, got %d", len(out))
	}
	if out[1].LineType != models.LineTypeBonus {
		t.Errorf("segunda línea debe seguir siendo BONUS, got %q", out[1].LineType)
	}
}

func TestSplitBonusItems_BonusMayorIgualQuantidad_TodoBonus(t *testing.T) {
	// Caso borde: bonus_quantity >= quantity (regalo total). Devuelve sólo
	// un BONUS, sin REGULAR.
	in := []models.ExtractedItem{
		{
			Name:          "DESPLEGABLE PROMO",
			Quantity:      2,
			BonusQuantity: 2,
			UnitPrice:     0,
			TotalPrice:    0,
			LineType:      models.LineTypeRegular,
		},
	}
	out := splitBonusItems(in)
	if len(out) != 1 {
		t.Fatalf("bonus_quantity>=qty debe dejar un solo BONUS, got %d", len(out))
	}
	if out[0].LineType != models.LineTypeBonus || out[0].Quantity != 2 {
		t.Errorf("todo-bonus mal partido: %+v", out[0])
	}
}

func TestSplitBonusItems_BonusEnLineaRETURN_EsNoop(t *testing.T) {
	// bonus_quantity sobre una RETURN no tiene sentido comercial; el helper
	// lo pasa tal cual (el reviewer humano decide).
	in := []models.ExtractedItem{
		{
			Name:          "COCA DEVOLUCIÓN",
			Quantity:      1,
			BonusQuantity: 1,
			UnitPrice:     1500,
			TotalPrice:    1500,
			LineType:      models.LineTypeReturn,
		},
	}
	out := splitBonusItems(in)
	if len(out) != 1 {
		t.Fatalf("no debe partir una RETURN, got %d", len(out))
	}
	if out[0].LineType != models.LineTypeReturn {
		t.Errorf("RETURN debe quedar intacto, got %q", out[0].LineType)
	}
}

// -------------------- buildInvoicePrompt --------------------

func TestBuildInvoicePrompt_PideCampoDescuentoDeLineaExplicito(t *testing.T) {
	prompt := buildInvoicePrompt("Postobón S.A.", nil, nil)

	// Shape pedido: discount_percentage y discount_value documentados.
	required := []string{
		"discount_percentage",
		"discount_value",
		"TOTAL del descuento de la LÍNEA",
		"escuentos de LÍNEA",
		"GLOBALES",
		"PRE-DESCUENTO y PRE-IMPUESTOS",
		"lineType",
		"bonus_quantity",
		"barcode",
	}
	for _, token := range required {
		if !strings.Contains(prompt, token) {
			t.Errorf("prompt debe mencionar %q, no lo hace. Prompt:\n%s", token, prompt)
		}
	}
}

func TestBuildInvoicePrompt_IncluyeExpectedTaxes_IVA(t *testing.T) {
	prompt := buildInvoicePrompt("Proveedor", nil, &models.ExpectedTaxes{IVA: true})
	if !strings.Contains(prompt, "PISTAS FISCALES") {
		t.Error("prompt con IVA esperado debe incluir sección PISTAS FISCALES")
	}
	if !strings.Contains(prompt, "iva_percentage") {
		t.Error("prompt debe pedir iva_percentage")
	}
	if !strings.Contains(prompt, "5 o 19") && !strings.Contains(prompt, "5") {
		t.Error("prompt con IVA esperado debe mencionar los porcentajes típicos")
	}
}

func TestBuildInvoicePrompt_IncluyeExpectedTaxes_IBUA(t *testing.T) {
	prompt := buildInvoicePrompt("Proveedor", nil, &models.ExpectedTaxes{IBUA: true})
	if !strings.Contains(prompt, "IBUA") {
		t.Error("prompt debe mencionar IBUA")
	}
	// Debe mencionar algún tramo típico (8, 16, 18, 20).
	found := false
	for _, p := range []string{"8", "16", "18", "20"} {
		if strings.Contains(prompt, p) {
			found = true
			break
		}
	}
	if !found {
		t.Error("prompt con IBUA esperado debe mencionar los tramos típicos")
	}
}

func TestBuildInvoicePrompt_SinExpectedTaxes_NoFuerzaSeccion(t *testing.T) {
	prompt := buildInvoicePrompt("Proveedor", nil, nil)
	if strings.Contains(prompt, "PISTAS FISCALES DEL USUARIO") {
		t.Error("sin expectedTaxes no debe aparecer la sección obligatoria de pistas")
	}
	// Pero sí debe existir una sección genérica de impuestos.
	if !strings.Contains(prompt, "IMPUESTOS") {
		t.Error("prompt debe mencionar impuestos aunque no haya pistas")
	}
}

func TestBuildInvoicePrompt_IncluyeNotasDelProveedor(t *testing.T) {
	params := &models.SupplierInvoiceParams{Notes: "La columna IVA viene a la derecha de 'VLR TOTAL'"}
	prompt := buildInvoicePrompt("Proveedor", params, nil)
	if !strings.Contains(prompt, "La columna IVA viene a la derecha") {
		t.Error("prompt debe incluir las notas específicas del proveedor")
	}
	if !strings.Contains(prompt, "INSTRUCCIÓN ESPECIAL DEL PROVEEDOR") {
		t.Error("prompt debe tener la sección INSTRUCCIÓN ESPECIAL DEL PROVEEDOR")
	}
}

func TestBuildInvoicePrompt_InstruyeBonificacionesPatronAyB(t *testing.T) {
	prompt := buildInvoicePrompt("Proveedor", nil, nil)
	// Debe explicar ambos patrones. Es el talón del contrato con Claude.
	for _, k := range []string{"Patrón A", "Patrón B", "Pague X, lleve Y", "bonus_quantity"} {
		if !strings.Contains(prompt, k) {
			t.Errorf("prompt debe explicar %q", k)
		}
	}
	if !strings.Contains(prompt, "Nunca emitas discount_percentage > 0 en una línea BONUS") {
		t.Error("prompt debe prohibir explícitamente DTO en BONUS")
	}
}

func TestBuildInvoicePrompt_InstruyeDevoluciones(t *testing.T) {
	prompt := buildInvoicePrompt("Proveedor", nil, nil)
	for _, k := range []string{"RETURN", "DEVOLUCIONES", "quantity POSITIVA"} {
		if !strings.Contains(prompt, k) {
			t.Errorf("prompt debe explicar devoluciones mencionando %q", k)
		}
	}
}

// -------------------- NormalizeMimeType / StripBase64Prefix --------------------

func TestNormalizeMimeType_AceptaFormatosClaude(t *testing.T) {
	casos := map[string]string{
		"image/jpeg":        "image/jpeg",
		"image/JPG":         "image/jpeg",
		"image/jpg":         "image/jpeg",
		"image/png":         "image/png",
		"image/webp":        "image/webp",
		"image/gif":         "image/gif",
		"":                  "image/jpeg", // default conservador
		" image/jpeg ":      "image/jpeg",
		"image/bmp":         "", // no soportado por Claude
		"application/pdf":   "", // facturas en PDF no van por este endpoint
		"text/html":         "",
	}
	for in, want := range casos {
		got := NormalizeMimeType(in)
		if got != want {
			t.Errorf("NormalizeMimeType(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStripBase64Prefix_LimpiaDataURI(t *testing.T) {
	raw := "data:image/jpeg;base64,/9j/4AAQSkZJRgABA"
	got := StripBase64Prefix(raw)
	want := "/9j/4AAQSkZJRgABA"
	if got != want {
		t.Errorf("StripBase64Prefix dejó la cabecera: got %q want %q", got, want)
	}

	// Sin prefijo: pasa tal cual.
	plain := "/9j/4AAQSkZJRgABA"
	if StripBase64Prefix(plain) != plain {
		t.Error("StripBase64Prefix mutó una cadena sin prefijo")
	}

	// Cadena con coma pero sin "base64" en el header no debe cortarse.
	weird := "abc,def"
	if StripBase64Prefix(weird) != weird {
		t.Errorf("StripBase64Prefix no debe cortar en comas que no son data URI, got %q", StripBase64Prefix(weird))
	}
}
