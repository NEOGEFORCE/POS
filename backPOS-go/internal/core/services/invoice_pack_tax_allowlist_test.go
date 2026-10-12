package services

import (
	"math"
	"strings"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================================
// Contrato de la allowlist estricta de expectedTaxes y la propagación de los
// campos packHintUnits/requiresPackConfirmation a matched y unmatched.
//
// Reglas que estos tests blindan:
//
//   1. applyExpectedTaxesAllowlist anula a 0 los porcentajes de impuesto que
//      NO estén marcados como true en expectedTaxes. Si expected es nil, los
//      tres quedan en 0.
//
//   2. zeroCatalogRatesForDeselected hace lo mismo con las tasas efectivas
//      que vienen del catálogo del producto, para que una opción no
//      seleccionada no reaparezca por fallback.
//
//   3. calculateItemDetails respeta la allowlist tanto para la ruta OCR
//      (ya anulada antes de llegar) como para el fallback de catálogo.
//      Matriz: todas las combinaciones (none, iva, ibua, icui, iva+ibua, etc.).
//
//   4. El prompt refleja la allowlist: menciona SÓLO los impuestos
//      seleccionados y prohíbe explícitamente los no seleccionados; si
//      ninguno está seleccionado, NO instruye a buscar columnas fiscales.
//
//   5. La propagación de PackHintUnits/RequiresPackConfirmation funciona
//      tanto en matched (ScannedItem) como en unmatched (UnmatchedItem).
// =============================================================================

// -------------------- applyExpectedTaxesAllowlist --------------------

func TestApplyExpectedTaxesAllowlist_MatrizCompleta(t *testing.T) {
	t.Parallel()
	// Datos base: Claude devolvió los 3 impuestos. Verificamos que cada
	// combinación de allowlist deje PASAR sólo los seleccionados.
	type want struct {
		iva, ibua, icui float64
	}
	cases := []struct {
		name     string
		expected *models.ExpectedTaxes
		want     want
	}{
		{"nil anula los tres", nil, want{0, 0, 0}},
		{"todos false anula los tres", &models.ExpectedTaxes{}, want{0, 0, 0}},
		{"solo IVA", &models.ExpectedTaxes{IVA: true}, want{19, 0, 0}},
		{"solo IBUA", &models.ExpectedTaxes{IBUA: true}, want{0, 18, 0}},
		{"solo ICUI", &models.ExpectedTaxes{ICUI: true}, want{0, 0, 5}},
		{"IVA + IBUA", &models.ExpectedTaxes{IVA: true, IBUA: true}, want{19, 18, 0}},
		{"IVA + ICUI", &models.ExpectedTaxes{IVA: true, ICUI: true}, want{19, 0, 5}},
		{"IBUA + ICUI", &models.ExpectedTaxes{IBUA: true, ICUI: true}, want{0, 18, 5}},
		{"los tres", &models.ExpectedTaxes{IVA: true, IBUA: true, ICUI: true}, want{19, 18, 5}},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			e := models.ExtractedItem{
				Name:           "X",
				Quantity:       1,
				IvaPercentage:  19,
				IbuaPercentage: 18,
				IcuiPercentage: 5,
			}
			applyExpectedTaxesAllowlist(&e, c.expected)
			if e.IvaPercentage != c.want.iva || e.IbuaPercentage != c.want.ibua || e.IcuiPercentage != c.want.icui {
				t.Fatalf("got iva=%.2f ibua=%.2f icui=%.2f, want %+v",
					e.IvaPercentage, e.IbuaPercentage, e.IcuiPercentage, c.want)
			}
		})
	}
}

func TestApplyExpectedTaxesAllowlist_NilItemNoRompe(t *testing.T) {
	t.Parallel()
	// Guard defensiva: no debe panic con nil.
	applyExpectedTaxesAllowlist(nil, &models.ExpectedTaxes{IVA: true})
}

// -------------------- zeroCatalogRatesForDeselected --------------------

func TestZeroCatalogRatesForDeselected_RespetaAllowlist(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		expected *models.ExpectedTaxes
		wantIva  float64
		wantIbua float64
		wantIcui float64
	}{
		{"nil anula los tres", nil, 0, 0, 0},
		{"todos true preserva", &models.ExpectedTaxes{IVA: true, IBUA: true, ICUI: true}, 19, 20, 5},
		{"solo IVA preserva IVA", &models.ExpectedTaxes{IVA: true}, 19, 0, 0},
		{"IBUA deseleccionado se anula", &models.ExpectedTaxes{IVA: true, ICUI: true}, 19, 0, 5},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			r := models.TaxRates{IvaPct: 19, IbuaPct: 20, IcuiPct: 5}
			zeroCatalogRatesForDeselected(&r, c.expected)
			if r.IvaPct != c.wantIva || r.IbuaPct != c.wantIbua || r.IcuiPct != c.wantIcui {
				t.Fatalf("got %+v, want iva=%.0f ibua=%.0f icui=%.0f",
					r, c.wantIva, c.wantIbua, c.wantIcui)
			}
		})
	}
}

// -------------------- calculateItemDetails matriz fiscal --------------------

// baseProduct es el catálogo típico: trae IVA 19, IBUA 20 e ICUI 5 pre-cargados.
// Las pruebas de abajo le piden a `calculateItemDetails` que RESPETE la
// allowlist aun cuando el catálogo tenga los impuestos cargados.
func baseProduct() *models.Product {
	return &models.Product{
		Barcode:          "7701234567890",
		ProductName:      "COCA 400ML",
		SalePrice:        2500,
		PurchasePrice:    2000,
		Quantity:         10,
		Iva:              19,
		Ibua:             20,
		Icui:             5,
		MarginPercentage: 25,
	}
}

// baseExtracted representa una línea OCR sin impuestos extraídos (el caso
// típico cuando el usuario NO marcó ninguna casilla fiscal).
func baseExtracted() models.ExtractedItem {
	return models.ExtractedItem{
		Name:       "COCA 400ML",
		Quantity:   10,
		UnitPrice:  2000,
		TotalPrice: 20000,
		LineType:   models.LineTypeRegular,
	}
}

func TestCalculateItemDetails_FiscalMatrixAllowlist(t *testing.T) {
	t.Parallel()
	type effective struct {
		iva, ibua, icui float64
	}
	cases := []struct {
		name     string
		expected *models.ExpectedTaxes
		want     effective
	}{
		// Allowlist vacío/nulo → catálogo no debe reaparecer por fallback.
		{"nil → todos 0", nil, effective{0, 0, 0}},
		{"ninguno true → todos 0", &models.ExpectedTaxes{}, effective{0, 0, 0}},

		// Un solo impuesto: sólo ese sobrevive del catálogo.
		{"solo IVA → 19/0/0", &models.ExpectedTaxes{IVA: true}, effective{19, 0, 0}},
		{"solo IBUA → 0/20/0", &models.ExpectedTaxes{IBUA: true}, effective{0, 20, 0}},
		{"solo ICUI → 0/0/5", &models.ExpectedTaxes{ICUI: true}, effective{0, 0, 5}},

		// Combinaciones.
		{"IVA+IBUA → 19/20/0", &models.ExpectedTaxes{IVA: true, IBUA: true}, effective{19, 20, 0}},
		{"IVA+ICUI → 19/0/5", &models.ExpectedTaxes{IVA: true, ICUI: true}, effective{19, 0, 5}},
		{"IBUA+ICUI → 0/20/5", &models.ExpectedTaxes{IBUA: true, ICUI: true}, effective{0, 20, 5}},

		// Todos.
		{"los tres → 19/20/5", &models.ExpectedTaxes{IVA: true, IBUA: true, ICUI: true}, effective{19, 20, 5}},
	}
	svc := &ProductService{}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			got := svc.calculateItemDetails(baseProduct(), baseExtracted(), nil, c.expected, "alias", 1.0)
			if got.IVA != c.want.iva || got.IBUA != c.want.ibua || got.ICUI != c.want.icui {
				t.Fatalf("tasas efectivas got iva=%.2f ibua=%.2f icui=%.2f, want %+v",
					got.IVA, got.IBUA, got.ICUI, c.want)
			}
		})
	}
}

func TestCalculateItemDetails_AllowlistAnulaOCRYCatalogo(t *testing.T) {
	t.Parallel()
	// Escenario: Claude emitió IVA aunque la UI NO lo marcó, Y el catálogo
	// tiene IVA cargado. Ambas fuentes deben anularse si expectedTaxes.IVA
	// está apagado. (La anulación del OCR ocurre en applyExpectedTaxesAllowlist
	// antes; aquí re-verificamos el camino del catálogo.)
	extracted := baseExtracted()
	// Simulamos el estado POST-allowlist: Claude emitió 19 pero ya fue anulado.
	extracted.IvaPercentage = 0

	svc := &ProductService{}
	got := svc.calculateItemDetails(baseProduct(), extracted, nil,
		&models.ExpectedTaxes{IBUA: true}, "alias", 1.0)

	if got.IVA != 0 {
		t.Fatalf("IVA deseleccionado debe anularse (catálogo no reaparece): got %.2f", got.IVA)
	}
	if got.IBUA != 20 {
		t.Fatalf("IBUA seleccionado debe venir del catálogo: got %.2f want 20", got.IBUA)
	}
	if got.ICUI != 0 {
		t.Fatalf("ICUI deseleccionado debe anularse: got %.2f", got.ICUI)
	}
}

func TestCalculateItemDetails_OCRGanaCatalogoCuandoSeleccionado(t *testing.T) {
	t.Parallel()
	// Si el OCR extrajo un porcentaje y el usuario marcó esa casilla,
	// la factura es la verdad fiscal del momento y sobreescribe al
	// catálogo.
	extracted := baseExtracted()
	extracted.IvaPercentage = 5 // Claude leyó 5% (en vez del 19 del catálogo)

	svc := &ProductService{}
	got := svc.calculateItemDetails(baseProduct(), extracted, nil,
		&models.ExpectedTaxes{IVA: true}, "alias", 1.0)

	if got.IVA != 5 {
		t.Fatalf("OCR seleccionado debe ganar al catálogo: got %.2f want 5", got.IVA)
	}
}

func TestCalculateItemDetails_CostoRealReflejaAllowlist(t *testing.T) {
	t.Parallel()
	// El costo real (GrossFromNet) depende de las tasas efectivas. Si la
	// allowlist anuló IBUA, el costo real NO debe incluir el 20% de IBUA.
	extracted := baseExtracted()

	svc := &ProductService{}
	// Caso A: todos los impuestos permitidos (base = 2000, +19 +20 +5 = +44% → 2880).
	a := svc.calculateItemDetails(baseProduct(), extracted, nil,
		&models.ExpectedTaxes{IVA: true, IBUA: true, ICUI: true}, "alias", 1.0)
	if math.Abs(a.CostoReal-2880) > 0.01 {
		t.Errorf("costo real con todos los impuestos: got %.2f want 2880", a.CostoReal)
	}

	// Caso B: ningún impuesto permitido → costo real == base.
	b := svc.calculateItemDetails(baseProduct(), extracted, nil, nil, "alias", 1.0)
	if math.Abs(b.CostoReal-2000) > 0.01 {
		t.Errorf("costo real sin impuestos: got %.2f want 2000", b.CostoReal)
	}

	// Caso C: sólo IVA → 2000 * 1.19 = 2380.
	c := svc.calculateItemDetails(baseProduct(), extracted, nil,
		&models.ExpectedTaxes{IVA: true}, "alias", 1.0)
	if math.Abs(c.CostoReal-2380) > 0.01 {
		t.Errorf("costo real solo IVA: got %.2f want 2380", c.CostoReal)
	}
}

// -------------------- buildInvoicePrompt + allowlist --------------------

func TestBuildInvoicePrompt_AllowlistMencionaSoloSeleccionados(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name          string
		expected      *models.ExpectedTaxes
		mustContain   []string // substrings que SÍ deben aparecer
		mustNotAppear []string // substrings que NO deben aparecer (impuestos deseleccionados)
	}{
		{
			name:        "nil → NO buscar columnas fiscales",
			expected:    nil,
			mustContain: []string{"IMPUESTOS", "NO busques columnas fiscales"},
			mustNotAppear: []string{
				"PISTAS FISCALES",
				"columna \"IVA %\"",
				"columna \"IBUA\"",
				"columna \"ICUI\"",
			},
		},
		{
			name:        "todos false → NO buscar columnas fiscales",
			expected:    &models.ExpectedTaxes{},
			mustContain: []string{"IMPUESTOS", "NO busques columnas fiscales"},
			mustNotAppear: []string{
				"PISTAS FISCALES",
				"columna \"IVA %\"",
				"columna \"IBUA\"",
				"columna \"ICUI\"",
			},
		},
		{
			name:        "solo IVA",
			expected:    &models.ExpectedTaxes{IVA: true},
			mustContain: []string{"PISTAS FISCALES", "columna \"IVA %\"", "ibua_percentage", "icui_percentage"},
			// Las instrucciones de buscar IBUA/ICUI NO deben aparecer.
			mustNotAppear: []string{
				"columna \"IBUA\"",
				"columna \"ICUI\"",
			},
		},
		{
			name:        "solo IBUA",
			expected:    &models.ExpectedTaxes{IBUA: true},
			mustContain: []string{"PISTAS FISCALES", "columna \"IBUA\"", "iva_percentage", "icui_percentage"},
			mustNotAppear: []string{
				"columna \"IVA %\"",
				"columna \"ICUI\"",
			},
		},
		{
			name:        "solo ICUI",
			expected:    &models.ExpectedTaxes{ICUI: true},
			mustContain: []string{"PISTAS FISCALES", "columna \"ICUI\"", "iva_percentage", "ibua_percentage"},
			mustNotAppear: []string{
				"columna \"IVA %\"",
				"columna \"IBUA\"",
			},
		},
		{
			name:        "IVA + IBUA",
			expected:    &models.ExpectedTaxes{IVA: true, IBUA: true},
			mustContain: []string{"PISTAS FISCALES", "columna \"IVA %\"", "columna \"IBUA\"", "icui_percentage"},
			mustNotAppear: []string{
				"columna \"ICUI\"",
			},
		},
		{
			name:        "los tres",
			expected:    &models.ExpectedTaxes{IVA: true, IBUA: true, ICUI: true},
			mustContain: []string{"PISTAS FISCALES", "columna \"IVA %\"", "columna \"IBUA\"", "columna \"ICUI\""},
			// No hay no-seleccionados, no debería emitir la línea de prohibición.
			mustNotAppear: []string{"NO busques ni emitas"},
		},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			prompt := buildInvoicePrompt("Proveedor", nil, c.expected)
			for _, must := range c.mustContain {
				if !strings.Contains(prompt, must) {
					t.Errorf("prompt debería contener %q.\nPrompt:\n%s", must, prompt)
				}
			}
			for _, forbidden := range c.mustNotAppear {
				if strings.Contains(prompt, forbidden) {
					t.Errorf("prompt NO debería contener %q (es un impuesto deseleccionado).\nPrompt:\n%s", forbidden, prompt)
				}
			}
		})
	}
}

func TestBuildInvoicePrompt_InstruyeOmitirDeseleccionados(t *testing.T) {
	t.Parallel()
	// Si al menos uno está seleccionado, el prompt debe enumerar
	// explícitamente los impuestos NO seleccionados para que Claude los
	// omita del JSON.
	prompt := buildInvoicePrompt("Proveedor", nil, &models.ExpectedTaxes{IVA: true})
	for _, token := range []string{"NO busques", "ibua_percentage", "icui_percentage"} {
		if !strings.Contains(prompt, token) {
			t.Errorf("prompt debe prohibir explícitamente los deseleccionados mencionando %q", token)
		}
	}
}

func TestBuildInvoicePrompt_SinSelecciones_NoInstruyeBuscarColumnas(t *testing.T) {
	t.Parallel()
	// Verifica el contrato: si ninguna casilla está marcada, el prompt NO
	// debe pedir al modelo buscar columnas fiscales "por si aparecen".
	for _, expected := range []*models.ExpectedTaxes{nil, {}, {IVA: false, IBUA: false, ICUI: false}} {
		prompt := buildInvoicePrompt("Proveedor", nil, expected)
		for _, forbidden := range []string{
			"Sólo emite iva_percentage/ibua_percentage/icui_percentage si aparecen",
			"PISTAS FISCALES DEL USUARIO",
		} {
			if strings.Contains(prompt, forbidden) {
				t.Fatalf("sin selecciones el prompt NO debe decir %q", forbidden)
			}
		}
		// Y sí debe decir "NO busques columnas fiscales".
		if !strings.Contains(prompt, "NO busques columnas fiscales") {
			t.Fatal("sin selecciones el prompt debe prohibir buscar columnas fiscales")
		}
	}
}

// -------------------- Propagación pack hints en matched y unmatched --------------------

// Para evitar montar un mock del ProductRepository completo (interfaz de 50+
// métodos), aquí verificamos la propagación simulando los dos branches de
// ScanInvoice que agregan ítems al result: el matched (vía
// calculateItemDetails + asignación de PackHint) y el unmatched (construcción
// directa + asignación de PackHint). La lógica es simple assignment, pero el
// contrato exige que ambos propaguen los campos cuando el detector dispara.

func TestPropagacionPackHint_Matched_RespectaDetector(t *testing.T) {
	t.Parallel()
	svc := &ProductService{}
	cases := []struct {
		invoiceName string
		wantHint    int
		wantRequire bool
	}{
		{"CAP*20", 20, true},
		{"DP*18 9GR", 18, true},
		{"CAP*24UN", 24, true},
		{"COCA 400ML", 0, false}, // sin multiplicador
	}
	for _, c := range cases {
		c := c
		t.Run(c.invoiceName, func(t *testing.T) {
			t.Parallel()
			extracted := models.ExtractedItem{
				Name:       c.invoiceName,
				Quantity:   1,
				UnitPrice:  1000,
				TotalPrice: 1000,
				LineType:   models.LineTypeRegular,
			}
			item := svc.calculateItemDetails(baseProduct(), extracted, nil, nil, "alias", 1.0)
			// Replicamos exactamente la asignación de ScanInvoice:
			if hint := DetectPackMultiplier(extracted.Name); hint > 0 {
				item.PackHintUnits = hint
				item.RequiresPackConfirmation = true
			}
			if item.PackHintUnits != c.wantHint {
				t.Fatalf("PackHintUnits = %d, want %d", item.PackHintUnits, c.wantHint)
			}
			if item.RequiresPackConfirmation != c.wantRequire {
				t.Fatalf("RequiresPackConfirmation = %v, want %v",
					item.RequiresPackConfirmation, c.wantRequire)
			}
			// Garantía adicional: no se mutaron cantidades ni precios.
			if item.Quantity != extracted.Quantity {
				t.Errorf("Quantity NO debe mutar: got %.2f, want %.2f", item.Quantity, extracted.Quantity)
			}
			if item.CostUnit != math.Round(extracted.UnitPrice*100)/100 {
				t.Errorf("CostUnit NO debe mutar: got %.2f, want %.2f",
					item.CostUnit, math.Round(extracted.UnitPrice*100)/100)
			}
		})
	}
}

func TestPropagacionPackHint_Unmatched_RespectaDetector(t *testing.T) {
	t.Parallel()
	cases := []struct {
		invoiceName string
		wantHint    int
		wantRequire bool
	}{
		{"CAP*20", 20, true},
		{"DP*18 9GR", 18, true},
		{"CAP*24UN", 24, true},
		{"PRODUCTO SIN PACK", 0, false},
	}
	for _, c := range cases {
		c := c
		t.Run(c.invoiceName, func(t *testing.T) {
			t.Parallel()
			extracted := models.ExtractedItem{
				Name:       c.invoiceName,
				Quantity:   1,
				UnitPrice:  1500,
				TotalPrice: 1500,
			}
			// Replicamos la construcción de ScanInvoice para el branch unmatched.
			u := models.UnmatchedItem{
				InvoiceName:        extracted.Name,
				Quantity:           extracted.Quantity,
				LineType:           extracted.LineType,
				BonusQuantity:      extracted.BonusQuantity,
				DiscountPercentage: extracted.DiscountPercentage,
				UnitPrice:          extracted.UnitPrice,
				IvaPercentage:      extracted.IvaPercentage,
				IbuaPercentage:     extracted.IbuaPercentage,
				IcuiPercentage:     extracted.IcuiPercentage,
			}
			if hint := DetectPackMultiplier(extracted.Name); hint > 0 {
				u.PackHintUnits = hint
				u.RequiresPackConfirmation = true
			}
			if u.PackHintUnits != c.wantHint {
				t.Fatalf("PackHintUnits = %d, want %d", u.PackHintUnits, c.wantHint)
			}
			if u.RequiresPackConfirmation != c.wantRequire {
				t.Fatalf("RequiresPackConfirmation = %v, want %v",
					u.RequiresPackConfirmation, c.wantRequire)
			}
			// El Quantity del unmatched no debe mutar por el pack hint.
			if u.Quantity != extracted.Quantity {
				t.Errorf("Quantity NO debe mutar en unmatched: got %.2f, want %.2f",
					u.Quantity, extracted.Quantity)
			}
			if u.UnitPrice != extracted.UnitPrice {
				t.Errorf("UnitPrice NO debe mutar en unmatched: got %.2f, want %.2f",
					u.UnitPrice, extracted.UnitPrice)
			}
		})
	}
}

// -------------------- Contrato de "no mutación" --------------------

func TestCalculateItemDetails_NoMutaCantidadNiTotales(t *testing.T) {
	t.Parallel()
	// Garantía dura: la detección de pack hint ocurre afuera, pero este test
	// previene que algún refactor futuro meta la conversión en
	// calculateItemDetails. Cantidad = 1, pero el nombre dice *24: el ScannedItem
	// debe seguir con Quantity=1.
	svc := &ProductService{}
	extracted := models.ExtractedItem{
		Name:       "CAP*24UN",
		Quantity:   1, // una línea de la factura con pack x24
		UnitPrice:  48000,
		TotalPrice: 48000,
		LineType:   models.LineTypeRegular,
	}
	item := svc.calculateItemDetails(baseProduct(), extracted, nil, nil, "alias", 1.0)
	if item.Quantity != 1 {
		t.Fatalf("backend NO debe convertir Quantity por pack hint: got %.2f want 1", item.Quantity)
	}
	if math.Abs(item.CostUnit-48000) > 0.01 {
		t.Fatalf("backend NO debe dividir CostUnit por pack hint: got %.2f want 48000", item.CostUnit)
	}
}
