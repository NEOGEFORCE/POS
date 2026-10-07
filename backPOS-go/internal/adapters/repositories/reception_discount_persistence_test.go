package repositories

import (
	"math"
	"regexp"
	"strings"
	"testing"
)

// =============================================================
// GuardiÃ¡n de persistencia de products.discount desde BulkReceive.
//
// El DTO% venÃ­a persistiendo sÃ³lo en stock_movements.discount_pct (foto
// histÃ³rica por lÃ­nea, migraciÃ³n 015). La columna products.discount, que
// la UI y el modal maestro consultan para mostrar el Ãºltimo DTO pactado,
// quedaba intacta en cada recepciÃ³n: el operador podÃ­a cambiar el valor
// desde la pantalla de recepciÃ³n sin que se reflejara despuÃ©s en el
// catÃ¡logo. Esta tanda de guardiÃ¡n fija que:
//
//  1. BulkReceive asigne product.Discount desde entry.DiscountPct dentro
//     del mismo bloque donde se persisten IVA/ICUI/IBUA y antes del
//     tx.Save del producto (misma transacciÃ³n de recepciÃ³n).
//  2. La asignaciÃ³n pase por sanitizeDiscountPct para que un valor NaN,
//     Â±Inf o negativo no rompa la transacciÃ³n ni se cuele a la BD.
//  3. El DTO NO se le reste al costo contable: GrossFromNet, el WAC y
//     la creaciÃ³n del egreso siguen trabajando sobre entry.NewPurchasePrice
//     sin tocar entry.DiscountPct ni product.Discount.
//
// Son tests de guardiÃ¡n sobre el cÃ³digo fuente: no necesitan BD. Si
// alguien reintroduce una resta de DTO al costo o quita la escritura,
// este archivo lo detecta antes del merge.
// =============================================================

func TestBulkReceivePersistProductDiscountFromEntryDiscountPct(t *testing.T) {
	src := leerArchivo(t, "postgres_product_inventory.go")
	cuerpo := cuerpoDeFuncion(t, src, "func (r *PostgresProductRepository) BulkReceive(")

	if !strings.Contains(cuerpo, "product.Discount = sanitizeDiscountPct(entry.DiscountPct)") {
		t.Error("BulkReceive debe persistir product.Discount = sanitizeDiscountPct(entry.DiscountPct) " +
			"dentro de la misma transacciÃ³n. SÃ­ntoma del regress: cambiar el DTO en recepciÃ³n no se refleja en el catÃ¡logo.")
	}

	// La asignaciÃ³n debe ocurrir DENTRO del bloque que condiciona por
	// entry.NewPurchasePrice > 0, igual que product.Iva/Icui/Ibua: en
	// BONUS (NewPurchasePrice == 0) no se sobreescribe el DTO vigente
	// con un cero reciÃ©n inventado.
	ivaIdx := strings.Index(cuerpo, "product.Iva = entry.IvaPct")
	discIdx := strings.Index(cuerpo, "product.Discount = sanitizeDiscountPct(entry.DiscountPct)")
	saveIdx := strings.Index(cuerpo, "tx.Save(&product)")
	if ivaIdx < 0 || discIdx < 0 || saveIdx < 0 {
		t.Fatalf("faltan anclas en BulkReceive: ivaIdx=%d discIdx=%d saveIdx=%d", ivaIdx, discIdx, saveIdx)
	}
	if discIdx < ivaIdx {
		t.Error("product.Discount debe asignarse DESPUÃ‰S de product.Iva/Icui/Ibua para quedar en el mismo bloque de NewPurchasePrice>0")
	}
	if discIdx > saveIdx {
		t.Error("product.Discount debe quedar antes del tx.Save(&product) para persistirse en la misma transacciÃ³n")
	}
}

func TestBulkReceiveNoAplicaDescuentoAlCosto(t *testing.T) {
	src := leerArchivo(t, "postgres_product_inventory.go")
	cuerpo := cuerpoDeFuncion(t, src, "func (r *PostgresProductRepository) BulkReceive(")

	// Patrones prohibidos: cualquier resta del DTO al costo bruto, al WAC
	// ponderado o a la base enviada al proveedor rompe la regla fiscal.
	for _, patron := range []*regexp.Regexp{
		regexp.MustCompile(`entry\.NewPurchasePrice\s*\*\s*\(\s*1\s*-\s*entry\.DiscountPct`),
		regexp.MustCompile(`totalEntryCost\s*\*\s*\(\s*1\s*-\s*entry\.DiscountPct`),
		regexp.MustCompile(`entry\.NewPurchasePrice\s*-\s*entry\.DiscountPct`),
		regexp.MustCompile(`product\.PurchasePrice\s*\*=\s*\(\s*1\s*-\s*entry\.DiscountPct`),
	} {
		if patron.MatchString(cuerpo) {
			t.Errorf("BulkReceive volviÃ³ a aplicar el DTO al costo (patrÃ³n %q). El descuento NO rebaja GrossFromNet ni el WAC: se traslada al PVP.", patron.String())
		}
	}

	// GrossFromNet recibe (NewPurchasePrice, TaxRates); nunca DiscountPct.
	// La firma correcta de la llamada que hoy produce la lÃ­nea de costo
	// y la lÃ­nea del total del egreso.
	if strings.Contains(cuerpo, "DiscountPct: entry.DiscountPct") {
		// Falso positivo potencial: StockMovement sÃ­ guarda DiscountPct en
		// su propio struct. Pero jamÃ¡s dentro de una TaxRates.
		if regexp.MustCompile(`TaxRates\{[^}]*DiscountPct`).MatchString(cuerpo) {
			t.Error("TaxRates no debe cargar DiscountPct; los impuestos son aditivos y el descuento vive aparte")
		}
	}
}

func TestSanitizeDiscountPctEstaCubiertaPorElCallsiteDeBulkReceive(t *testing.T) {
	// El helper vive en el mismo paquete; forzamos el cableado explÃ­cito
	// para que un refactor que lo renombre no deje al producto con
	// cualquier valor crudo.
	src := leerArchivo(t, "postgres_product_inventory.go")
	if !strings.Contains(src, "func sanitizeDiscountPct(v float64) float64") {
		t.Fatal("falta el helper sanitizeDiscountPct en postgres_product_inventory.go")
	}
	if strings.Contains(src, "product.Discount = entry.DiscountPct") {
		t.Error("asigna el DTO sin sanitizar; NaN/Inf/negativos pueden abortar la transacciÃ³n o guardarse como ruido")
	}
}

// =============================================================
// Pruebas del helper: dato corrupto no debe tumbar la recepciÃ³n ni
// quedar en BD.
// =============================================================

func TestSanitizeDiscountPct_LimpiaDatosCorruptos(t *testing.T) {
	casos := []struct {
		nombre string
		in     float64
		want   float64
	}{
		{"DTO cero", 0, 0},
		{"DTO 12% exacto", 12, 12},
		{"DTO 20% exacto", 20, 20},
		{"DTO alto todavÃ­a vÃ¡lido (50%)", 50, 50},
		{"DTO con muchos decimales redondea a 2", 12.345, 12.35},
		{"DTO con 3 decimales por redondeo bancario", 7.126, 7.13},
		{"NaN se neutraliza", math.NaN(), 0},
		{"+Inf se neutraliza", math.Inf(1), 0},
		{"-Inf se neutraliza", math.Inf(-1), 0},
		{"negativo (recargo encubierto) se neutraliza", -5, 0},
		{"muy negativo se neutraliza", -1234.56, 0},
	}
	for _, c := range casos {
		got := sanitizeDiscountPct(c.in)
		if math.IsNaN(got) || math.IsInf(got, 0) {
			t.Errorf("%s: sanitize dejÃ³ un valor no finito (%v)", c.nombre, got)
			continue
		}
		if math.Abs(got-c.want) > 0.001 {
			t.Errorf("%s: sanitizeDiscountPct(%v) = %v, want %v", c.nombre, c.in, got, c.want)
		}
	}
}

// =============================================================
// MatemÃ¡tica de combinaciones de porcentajes.
//
// Confirma que el costo contable (GrossFromNet aditivo) no depende del
// DTO, y que el PVP sugerido sÃ­ lo recibe como mÃ¡rgen extra. Son los
// mismos nÃºmeros del fix de /inventory/receive: base 1000 â†’ gross 1370
// con IVA 19 + ICUI 8 + IBUA 10, independiente del DTO.
// =============================================================

func TestMatematicaDeCombinacionesDePorcentajes(t *testing.T) {
	casos := []struct {
		nombre    string
		base      float64
		ivaPct    float64
		icuiPct   float64
		ibuaPct   float64
		dtoPct    float64
		ganPct    float64
		wantGross float64
		wantPVP   float64
	}{
		{
			nombre:    "solo GAN",
			base:      1000,
			ganPct:    20,
			wantGross: 1000,
			wantPVP:   1200,
		},
		{
			nombre:    "IVA 19 + GAN 20",
			base:      1000,
			ivaPct:    19,
			ganPct:    20,
			wantGross: 1190,
			wantPVP:   1428, // 1190 * 1.20
		},
		{
			nombre:    "IVA 19 + ICUI 8 + IBUA 10 + DTO 12 + GAN 20",
			base:      1000,
			ivaPct:    19,
			icuiPct:   8,
			ibuaPct:   10,
			dtoPct:    12,
			ganPct:    20,
			wantGross: 1370,        // base aditiva: no la toca el DTO
			wantPVP:   1370 * 1.32, // gross * (1 + (gan + dto)/100) = 1808.4
		},
		{
			nombre:    "DTO sin GAN â†’ el PVP sube igual",
			base:      1000,
			ivaPct:    19,
			dtoPct:    12,
			wantGross: 1190,
			wantPVP:   1190 * 1.12,
		},
		{
			nombre:    "DTO del dueÃ±o 12% sobre costo sin impuestos",
			base:      1331,
			ganPct:    20,
			dtoPct:    12,
			wantGross: 1331,
			wantPVP:   1331 * 1.32, // 1756.92
		},
	}

	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			gross := costoEntrada(c.base,
				c.base*c.ivaPct/100,
				c.base*c.icuiPct/100,
				c.base*c.ibuaPct/100,
			)
			if math.Abs(gross-c.wantGross) > 0.5 {
				t.Errorf("gross = %.4f, want %.4f (el DTO no debe entrar en esta cuenta)", gross, c.wantGross)
			}

			// Guardia explÃ­cita: si alguien introdujera el DTO en la base
			// con la fÃ³rmula clÃ¡sica (gross * (1 - dto/100)), el nÃºmero
			// caerÃ­a bajo el esperado. Lo validamos aquÃ­.
			grossConDTOErroneo := gross * (1 - c.dtoPct/100)
			if c.dtoPct > 0 && math.Abs(gross-grossConDTOErroneo) < 0.5 {
				t.Errorf("el gross estÃ¡ bajando por el DTO (%.4f), reintrodujeron la rebaja al costo", gross)
			}

			pvp := pvpSugerido(gross, c.ganPct, c.dtoPct)
			if math.Abs(pvp-c.wantPVP) > 0.5 {
				t.Errorf("PVP = %.4f, want %.4f", pvp, c.wantPVP)
			}
		})
	}
}

func TestBONUS_NoTocaCostoNiDescuento(t *testing.T) {
	// En BONUS entry.NewPurchasePrice == 0: el bloque que escribe
	// product.Iva/Icui/Ibua/Discount estÃ¡ dentro de ese if, asÃ­ que un
	// regalo del proveedor NO sobrescribe el DTO vigente con 0.
	src := leerArchivo(t, "postgres_product_inventory.go")
	cuerpo := cuerpoDeFuncion(t, src, "func (r *PostgresProductRepository) BulkReceive(")

	ifPrice := "if entry.NewPurchasePrice > 0 {"
	ifIdx := strings.Index(cuerpo, ifPrice)
	if ifIdx < 0 {
		t.Fatal("no se encontrÃ³ el bloque principal `if entry.NewPurchasePrice > 0`")
	}
	// Buscamos el cierre del bloque: scaneamos balanceando llaves desde ifIdx.
	start := ifIdx + len(ifPrice)
	depth := 1
	end := -1
	for i := start; i < len(cuerpo); i++ {
		switch cuerpo[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				end = i
			}
		}
		if end != -1 {
			break
		}
	}
	if end < 0 {
		t.Fatal("no se encontrÃ³ el cierre del bloque `if entry.NewPurchasePrice > 0`")
	}
	bloque := cuerpo[ifIdx:end]
	if !strings.Contains(bloque, "product.Discount = sanitizeDiscountPct(entry.DiscountPct)") {
		t.Error("product.Discount debe asignarse dentro del bloque entry.NewPurchasePrice>0; " +
			"BONUS (precio 0) NO debe sobreescribir el DTO vigente con cero")
	}
}

func TestRETURN_UsaMismoBloqueDeImpuestosYDescuento(t *testing.T) {
	// En RETURN (addedQuantity<0, newPurchasePrice>0) la lÃ­nea entra al
	// mismo if, asÃ­ que se refresca IVA/ICUI/IBUA/Discount con lo que
	// venga de la devoluciÃ³n. Es intencional: la devoluciÃ³n se registra
	// con los mismos porcentajes que la lÃ­nea original. Confirmamos que
	// no hay un segundo bloque "de regreso" que subvierta la semÃ¡ntica.
	src := leerArchivo(t, "postgres_product_inventory.go")
	cuerpo := cuerpoDeFuncion(t, src, "func (r *PostgresProductRepository) BulkReceive(")

	if strings.Count(cuerpo, "product.Discount =") != 1 {
		t.Errorf("product.Discount debe asignarse exactamente una vez en BulkReceive, hay %d",
			strings.Count(cuerpo, "product.Discount ="))
	}
	// Guardia: si alguien aÃ±ade una rama RETURN especÃ­fica que ponga
	// product.Discount a algo distinto, es un cambio de semÃ¡ntica.
	if regexp.MustCompile(`LineType.*RETURN[\s\S]{0,200}product\.Discount`).MatchString(cuerpo) {
		t.Error("no introduzcas una ruta de RETURN que mute product.Discount; la lÃ­nea ya se maneja en el if principal")
	}
}

// =============================================================
// Guardián: líneas BONUS NO deben persistir DTO en stock_movements.discount_pct.
//
// La columna 015 guarda la foto histórica del DTO por línea. Un BONUS es un
// regalo del proveedor y por invariante del contrato OCR
// (normalizeExtractedItem) nunca lleva DTO. Si por una regresión de UI una
// línea BONUS llegara al backend con DiscountPct > 0, el kárdex quedaría con
// una foto errónea para auditoría.
//
// Este test fija que BulkReceive filtre LineType == "BONUS" antes de armar
// el StockMovement con la copia local lineDiscountPct.
// =============================================================

func TestBulkReceiveSaneaDTOEnBONUSDelKardex(t *testing.T) {
	src := leerArchivo(t, "postgres_product_inventory.go")
	cuerpo := cuerpoDeFuncion(t, src, "func (r *PostgresProductRepository) BulkReceive(")

	// Debe existir el bloque que convierte DTO a 0 en BONUS antes de
	// construir el movement.
	patron := regexp.MustCompile(`strings\.EqualFold\(\s*entry\.LineType\s*,\s*"BONUS"\s*\)[\s\S]{0,120}lineDiscountPct\s*=\s*0`)
	if !patron.MatchString(cuerpo) {
		t.Error("BulkReceive debe forzar lineDiscountPct=0 cuando entry.LineType=='BONUS' antes de armar el StockMovement; " +
			"evita foto errónea en stock_movements.discount_pct para líneas de regalo")
	}

	// La asignación de lineDiscountPct a 0 debe ocurrir ANTES de construir
	// el movement (ancla sintáctica: la línea `movement := models.StockMovement{`).
	saneamientoIdx := patron.FindStringIndex(cuerpo)
	movementIdx := strings.Index(cuerpo, "movement := models.StockMovement{")
	if saneamientoIdx == nil || movementIdx < 0 {
		t.Fatalf("no se encontraron las anclas: saneamiento=%v movementIdx=%d", saneamientoIdx, movementIdx)
	}
	if saneamientoIdx[0] >= movementIdx {
		t.Error("el saneamiento de BONUS debe ejecutarse ANTES de construir el movement, no después")
	}
}
