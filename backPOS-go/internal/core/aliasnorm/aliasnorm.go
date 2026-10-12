// Package aliasnorm concentra las utilidades puras compartidas por el
// servicio de productos y el repositorio Postgres para mantener consistente
// el emparejamiento de aliases de proveedor y la búsqueda de productos
// similares durante el OCR de facturas.
//
// El paquete es dependencia pura (sin GORM, sin Gin, sin tiempo): el único
// import no estándar es `golang.org/x/text` vía `internal/core/utils` para
// quitar diacríticos. Esto permite que tanto `internal/core/services` como
// `internal/adapters/repositories` lo importen sin introducir ciclos.
//
// Objetivos cubiertos:
//
//   - [1] CanonicalInvoiceName: normalización canónica del nombre tal como
//     aparece en la factura. Se usa al GUARDAR el alias, al CARGARLO en el
//     mapa de match y al BUSCAR productos similares.
//
//   - [2] ValidateAndCanonicalize: validación compartida de supplierId,
//     invoiceName y productBarcode antes de persistir un alias.
//
//   - [4] DistinctiveInvoiceTokens / ScoreNameSimilarity: tokenización
//     que ignora términos genéricos de empaque (BOLSA, CAJA, PAQUETE,
//     CIERRE, UND, DISPLAY, PROMO, etc.) y conectores cortos. Un
//     candidato que SÓLO comparte un término genérico queda descartado
//     por diseño; esa es la regla que evita que al buscar
//     "MILO ACTIGEN-E BOLSA CIERRE 48X100G CO" aparezca "BOLSA DE ARROZ".
//
// Todo es puro: sin I/O, sin globals mutables, sin tiempo relativo. Los
// tests cubren el contrato sin tocar la BD.
package aliasnorm

import (
	"errors"
	"strings"
	"unicode"

	"backPOS-go/internal/core/utils"
)

// ErrSupplierAliasInvalid se devuelve cuando el payload de un alias no
// cumple las precondiciones mínimas (supplierId > 0, nombre no vacío tras
// canonicalizar, barcode no vacío). Es un sentinel para que el handler lo
// mapee a HTTP 400 sin filtrar detalle técnico.
var ErrSupplierAliasInvalid = errors.New("alias de proveedor inválido")

// genericPackagingTokens enumera términos de empaque, formato y conectores
// que NO deben considerarse distintivos al emparejar nombres de factura
// contra nombres de catálogo. Son palabras que aparecen repetidas entre
// productos distintos y que, si contaran, hundirían la precisión del
// matcher. La lista se mantiene en MAYÚSCULAS y sin acentos porque el
// tokenizador normaliza por CanonicalInvoiceName antes de cotejar.
//
// Si en el futuro un término se vuelve distintivo para un rubro (p.ej.
// "DISPLAY" dentro de "DISPLAY POKER"), la mitigación es definir aliases
// manuales por proveedor; no quitarlo de aquí, porque abriría la puerta a
// matches espurios en catálogos grandes.
var genericPackagingTokens = map[string]struct{}{
	// Empaque / unidad de venta
	"BOLSA":    {},
	"BOLSAS":   {},
	"CAJA":     {},
	"CAJAS":    {},
	"PAQUETE":  {},
	"PAQUETES": {},
	"PAQ":      {},
	"PACK":     {},
	"PACKS":    {},
	"PAC":      {},
	"CIERRE":   {},
	"UND":      {},
	"UNDS":     {},
	"UNID":     {},
	"UNIDAD":   {},
	"UNIDADES": {},
	"DISPLAY":  {},
	"PROMO":    {},
	"DOCENA":   {},
	"DOC":      {},
	"FARDO":    {},
	"FDO":      {},
	"SIXPACK":  {},
	"PACA":     {},
	"PACAS":    {},
	"ESTUCHE":  {},
	"ROLLO":    {},
	"ROLLOS":   {},
	"SURTIDO":  {},
	"SURTIDOS": {},
	"COMBO":    {},
	"OFERTA":   {},
	"NUEVO":    {},
	"PET":      {},
	"TETRA":    {},
	// Conectores en español que logran superar el filtro de longitud >=3
	"CON":  {},
	"SIN":  {},
	"POR":  {},
	"PARA": {},
	"DEL":  {},
	"LAS":  {},
	"LOS":  {},
	// Sufijos corporativos / códigos de país / genéricos cortos del OCR
	"COL":  {},
	"COLO": {},
	"LTDA": {},
	"REF":  {},
	"COD":  {},
}

// IsGenericPackagingToken expone el filtro para pruebas que necesitan
// afirmar explícitamente que un término se trata como genérico. Trabaja
// sobre el token YA canonicalizado (uppercase, sin acentos).
func IsGenericPackagingToken(token string) bool {
	_, ok := genericPackagingTokens[token]
	return ok
}

// CanonicalInvoiceName devuelve una forma canónica estable del nombre tal
// como vendría impreso en una factura. Reglas:
//
//  1. Elimina acentos / diacríticos ("Café" → "CAFE").
//  2. Pasa a MAYÚSCULAS.
//  3. Reemplaza cualquier run de whitespace unicode por un único espacio.
//  4. Colapsa puntuación "ruidosa" repetida (`---`, `...`, `***`) a una
//     sola instancia del carácter, y pela puntuación suelta al inicio y
//     al final del string. Signos útiles para distinguir productos como
//     `-`, `/`, `+`, `%`, `.` y los dígitos NO se quitan: `ACTIGEN-E` y
//     `48X100G` sobreviven intactos.
//  5. Hace Trim final.
//
// Devuelve "" si tras normalizar no queda ningún carácter imprimible. Es
// pura y determinista: dos llamadas con la misma entrada devuelven lo
// mismo byte a byte.
func CanonicalInvoiceName(s string) string {
	if s == "" {
		return ""
	}
	// utils.RemoveAccents ya hace ToUpper + TrimSpace, pero no sabe de
	// repetición de whitespace interno ni de puntuación: eso lo arreglamos
	// aquí para que el canónico quede 100 % estable.
	s = utils.RemoveAccents(s)

	var b strings.Builder
	b.Grow(len(s))
	prevSpace := true  // arranca en "espacio" para pelar los iniciales
	var lastPunct rune // detecta puntuación duplicada consecutiva
	for _, r := range s {
		switch {
		case unicode.IsSpace(r):
			if !prevSpace {
				b.WriteRune(' ')
				prevSpace = true
				lastPunct = 0
			}
		case isNoiseRepeatablePunct(r):
			// Puntuación repetible como `-`, `.`, `*`: la primera pasa,
			// las consecutivas se colapsan. Esto evita que `--` o `...`
			// se vuelvan tokens espurios distintos de `-` y `.`.
			if r != lastPunct {
				b.WriteRune(r)
				lastPunct = r
				prevSpace = false
			}
		default:
			b.WriteRune(r)
			prevSpace = false
			lastPunct = 0
		}
	}
	out := strings.TrimSpace(b.String())
	// Pela puntuación suelta al inicio o final: `-COCA 400` → `COCA 400`.
	out = strings.TrimFunc(out, isTrimablePunct)
	return out
}

// isNoiseRepeatablePunct marca puntuación que suele venir repetida en el
// OCR como separador visual y de la que queremos un solo carácter.
func isNoiseRepeatablePunct(r rune) bool {
	switch r {
	case '-', '.', '*', '_', '=', '~':
		return true
	}
	return false
}

// isTrimablePunct enumera puntuación que carece de valor semántico cuando
// aparece sólo al borde del string, incluidos los signos de interrogación/
// exclamación invertidos del español.
func isTrimablePunct(r rune) bool {
	switch r {
	case '-', '.', '*', '_', '=', '~', ',', ';', ':', '!', '?', '"', '\'',
		'¿', '¡', '«', '»':
		return true
	}
	return false
}

// isTokenSeparator define qué runas rompen un token distintivo. Separamos
// por whitespace y por puntuación "estructural" (`-`, `/`, `+`, `,`, etc.)
// porque facturas distintas escriben los mismos productos con separadores
// distintos ("ACTIGEN-E" vs "ACTIGEN E"). Mantener el guión como separador
// nos permite emparejar "MILO ACTIGEN-E" contra "MILO ACTIGEN 100G" sin
// depender de pg_trgm.
//
// Importante: la X intercalada en medidas como `48X100G` NO es separador
// (es alfanumérica), así que la unidad de medida queda intacta y conserva
// su valor distintivo.
func isTokenSeparator(r rune) bool {
	if r >= '0' && r <= '9' {
		return false
	}
	// Letras unicode (incluye acentuadas, Ñ, etc.) permanecen como parte
	// del token. CanonicalInvoiceName ya quitó diacríticos, pero este
	// predicado se evalúa sobre lo canonicalizado y debe soportar runas
	// no ASCII para ser robusto.
	if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
		return false
	}
	if r > 127 {
		// Más allá del ASCII, confiamos en unicode.IsLetter.
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return false
		}
	}
	// `%` también se trata como separador: carece de valor distintivo por
	// sí solo y aparece sobre todo en impuestos ("19%").
	return true
}

// DistinctiveInvoiceTokens tokeniza el nombre canonicalizado y devuelve
// SÓLO los tokens que aportan señal para emparejar productos:
//
//   - Longitud >= 3 (filtra "DE", "LA", "EL", "CO", "X", "G", etc.).
//   - No está en genericPackagingTokens.
//   - Contiene al menos un carácter alfanumérico.
//
// El tokenizador separa en whitespace y puntuación estructural (`-`, `/`,
// `+`, `,`, `.`, etc.). Esto permite que compuestos como `ACTIGEN-E` se
// partan en `ACTIGEN` + `E` y que `ACTIGEN E` (sin guión) empareje con la
// forma con guión sin depender de pg_trgm. Las letras cortas resultantes
// (`E`) caen por el filtro de longitud.
//
// Las unidades de medida con letras intercaladas sin punctuación como
// `48X100G` o `100G` quedan como un ÚNICO token porque sus caracteres son
// alfanuméricos: conservan su valor distintivo.
//
// Preserva orden de aparición. ScoreNameSimilarity trata los tokens como
// conjunto; esta función tolera duplicados.
func DistinctiveInvoiceTokens(name string) []string {
	canonical := CanonicalInvoiceName(name)
	if canonical == "" {
		return nil
	}
	rawTokens := strings.FieldsFunc(canonical, isTokenSeparator)
	out := make([]string, 0, len(rawTokens))
	for _, tok := range rawTokens {
		if len(tok) < 3 {
			continue
		}
		if _, ban := genericPackagingTokens[tok]; ban {
			continue
		}
		if !hasAlphaNumeric(tok) {
			continue
		}
		out = append(out, tok)
	}
	return out
}

// hasAlphaNumeric reporta si el string contiene al menos un carácter
// alfanumérico. Filtra tokens que quedaron hechos sólo de puntuación tras
// la canonicalización.
func hasAlphaNumeric(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return true
		}
	}
	return false
}

// tokenShape clasifica un token distintivo en una de las tres formas que el
// scorer entiende: alfabético (sólo letras ASCII), medida (dígitos + sufijo
// alfabético de unidad, incluidos los packs tipo `NxM<unit>`) o mixto.
//
// Los campos auxiliares `unitSize` y `rawUpper` evitan recomputar sobre la
// marcha en los bucles de pareo.
type tokenShape struct {
	raw      string
	isAlpha  bool
	isSize   bool
	unitSize string
}

// classifyToken devuelve la forma del token (letras, medida, mixto).
// El token ya viene canonicalizado y pasó por DistinctiveInvoiceTokens.
func classifyToken(tok string) tokenShape {
	shape := tokenShape{raw: tok}
	if tok == "" {
		return shape
	}
	alphaOnly := true
	hasDigit := false
	for _, r := range tok {
		switch {
		case r >= '0' && r <= '9':
			hasDigit = true
			alphaOnly = false
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z':
			// letra ASCII; sigue dentro de alpha only
		default:
			alphaOnly = false
		}
	}
	shape.isAlpha = alphaOnly
	if hasDigit {
		shape.unitSize = extractUnitSize(tok)
		shape.isSize = shape.unitSize != ""
	}
	return shape
}

// extractUnitSize devuelve la "medida unitaria" de un token. Semántica:
//
//   - "25G"       → "25G"
//   - "26X25G"    → "25G"   (pack N × unidad: la unidad es lo comparable)
//   - "48X100G"   → "100G"
//   - "190G"      → "190G"
//   - "500ML"     → "500ML"
//   - "LATA100G"  → "100G"  (prefijo texto + medida: aislamos la medida)
//   - "ACTIGEN"   → ""      (no es medida)
//   - "100"       → ""      (sin unidad: no distingue cantidades)
//
// La función corta por el final: busca el sufijo [LETRAS] y, pegado a él, un
// prefijo de [DÍGITOS]. Esa pareja es la medida unitaria. Si no existe, el
// token no se considera medida.
func extractUnitSize(tok string) string {
	n := len(tok)
	i := n
	for i > 0 && isAsciiLetter(tok[i-1]) {
		i--
	}
	if i == n {
		return ""
	}
	j := i
	for j > 0 && isAsciiDigit(tok[j-1]) {
		j--
	}
	if j == i {
		return ""
	}
	return tok[j:n]
}

func isAsciiLetter(b byte) bool {
	return (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z')
}

func isAsciiDigit(b byte) bool {
	return b >= '0' && b <= '9'
}

// tokenAffinity calcula la afinidad entre dos tokens distintivos en [0, 1].
// Reglas, en orden:
//
//  1. Igualdad exacta ⇒ 1.0. Caso trivial que domina todo.
//  2. Ambos son medidas: coinciden si su medida unitaria es la misma.
//     "26X25G" ↔ "25G" ⇒ 1.0; "190G" ↔ "25G" ⇒ 0.0 y marca `sizeConflict`.
//  3. Ambos son alfabéticos y uno contiene al otro con la mínima longitud
//     exigida: "LACARISTRA" ↔ "RISTRA" ⇒ 0.85. El umbral evita que
//     tokens cortos ("LAS") disparen matches falsos.
//
// Devuelve también un flag `sizeConflict` que el scorer usa para penalizar
// candidatos cuya medida contradice la del query.
func tokenAffinity(a, b tokenShape) (float64, bool) {
	if a.raw == "" || b.raw == "" {
		return 0, false
	}
	if a.raw == b.raw {
		return 1.0, false
	}
	if a.isSize && b.isSize {
		if a.unitSize == b.unitSize {
			return 1.0, false
		}
		return 0, true
	}
	if a.isAlpha && b.isAlpha {
		short, long := a.raw, b.raw
		if len(short) > len(long) {
			short, long = long, short
		}
		// Umbral de longitud: tokens de 5+ letras son suficientemente
		// específicos para que un containment sea señal fuerte. Debajo de 5
		// la cola de falsos positivos es demasiado larga.
		if len(short) >= 5 && len(long) > len(short) && strings.Contains(long, short) {
			return 0.85, false
		}
	}
	return 0, false
}

// ScoreNameSimilarity devuelve una confianza en [0, 1] entre dos listas de
// tokens distintivos aplicando matching uno-a-uno:
//
//   - Cada token del query puede emparejarse con a lo sumo UN token del
//     candidato y viceversa. Esto evita que un `100G` del query infle el
//     score con 3 "100G" repetidos del candidato.
//   - La afinidad por pareja se calcula con tokenAffinity (igualdad exacta,
//     equivalencia de medida en packs, containment alfabético controlado).
//   - El pareo se hace por mayor afinidad primero (greedy ordenado), lo que
//     garantiza determinismo: entradas iguales ⇒ salida igual byte a byte.
//
// Combinación final:
//
//   - raw = Σ afinidad de las parejas elegidas.
//   - coverage = raw / |tokens del query|.
//   - precision = raw / |tokens del candidato|.
//   - F1 = 2*coverage*precision/(coverage+precision).
//
// Castigo por medida incompatible: si en el query queda al menos un token de
// medida SIN pareja y en el candidato también, significa que los dos lados
// hablan de tamaños distintos (190G vs 25G); el F1 se corta a la mitad para
// que un candidato con la medida equivocada no desplace a otro con la medida
// correcta sólo por compartir palabras alfabéticas.
//
// Si no hay NINGÚN overlap útil, devuelve 0 — exactamente la invariante que
// mantiene a "BOLSA DE ARROZ" fuera cuando el query es "MILO ... BOLSA ...".
func ScoreNameSimilarity(queryTokens, candidateTokens []string) float64 {
	if len(queryTokens) == 0 || len(candidateTokens) == 0 {
		return 0
	}
	qu := dedupTokensPreservingOrder(queryTokens)
	cu := dedupTokensPreservingOrder(candidateTokens)
	if len(qu) == 0 || len(cu) == 0 {
		return 0
	}

	qShapes := make([]tokenShape, len(qu))
	for i, t := range qu {
		qShapes[i] = classifyToken(t)
	}
	cShapes := make([]tokenShape, len(cu))
	for i, t := range cu {
		cShapes[i] = classifyToken(t)
	}

	type candidatePair struct {
		qIdx, cIdx int
		score      float64
	}
	pairs := make([]candidatePair, 0, len(qu)*len(cu))
	for i := range qShapes {
		for j := range cShapes {
			s, _ := tokenAffinity(qShapes[i], cShapes[j])
			if s > 0 {
				pairs = append(pairs, candidatePair{qIdx: i, cIdx: j, score: s})
			}
		}
	}
	// Orden determinista: por score desc, luego qIdx asc, luego cIdx asc.
	// Insertion sort explícito: evita arrastrar "sort" y el input real
	// (<=200 candidatos × pocos tokens) hace que O(n²) sea irrelevante.
	for i := 1; i < len(pairs); i++ {
		for j := i; j > 0; j-- {
			a, b := pairs[j-1], pairs[j]
			if a.score > b.score {
				break
			}
			if a.score == b.score {
				if a.qIdx < b.qIdx {
					break
				}
				if a.qIdx == b.qIdx && a.cIdx <= b.cIdx {
					break
				}
			}
			pairs[j-1], pairs[j] = b, a
		}
	}

	usedQ := make([]bool, len(qu))
	usedC := make([]bool, len(cu))
	var raw float64
	for _, p := range pairs {
		if usedQ[p.qIdx] || usedC[p.cIdx] {
			continue
		}
		raw += p.score
		usedQ[p.qIdx] = true
		usedC[p.cIdx] = true
	}
	if raw <= 0 {
		return 0
	}

	qSizeUnmatched := false
	for i, s := range qShapes {
		if s.isSize && !usedQ[i] {
			qSizeUnmatched = true
			break
		}
	}
	cSizeUnmatched := false
	for i, s := range cShapes {
		if s.isSize && !usedC[i] {
			cSizeUnmatched = true
			break
		}
	}
	sizePenalty := qSizeUnmatched && cSizeUnmatched

	coverage := raw / float64(len(qu))
	precision := raw / float64(len(cu))
	// Media armónica (F1) para castigar extremos: un candidato enorme que
	// cubre todos los tokens del query pero tiene decenas más propios no
	// debe superar a un match 1-a-1.
	f1 := 2 * coverage * precision / (coverage + precision)
	if sizePenalty {
		f1 *= 0.5
	}
	return f1
}

// dedupTokensPreservingOrder descarta repeticiones conservando la primera
// aparición. Mantener orden hace el pareo determinista entre llamadas.
func dedupTokensPreservingOrder(tokens []string) []string {
	if len(tokens) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(tokens))
	out := make([]string, 0, len(tokens))
	for _, t := range tokens {
		if t == "" {
			continue
		}
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	return out
}

// SimilarProductCandidate es una tupla cerrada con lo mínimo que el ranker
// necesita del catálogo. Se expone en vez de usar models.Product para que
// las pruebas puedan construir candidatos sin arrastrar GORM.
type SimilarProductCandidate struct {
	Barcode     string
	ProductName string
}

// RankedProduct es el resultado del ranker: una tupla con el barcode, el
// nombre original (sin canonicalizar, para que la UI del reviewer lo
// muestre tal cual aparece en el catálogo) y la confianza calculada en
// [0, 1].
type RankedProduct struct {
	Barcode     string
	ProductName string
	Confidence  float64
}

// RankSimilarProducts recibe un nombre de factura y una lista de
// candidatos ya pre-filtrados por SQL (típicamente productos activos y no
// marcadores históricos que comparten al menos un token distintivo con
// el nombre). Devuelve, de forma determinista:
//
//   - sólo candidatos con al menos un token distintivo compartido
//     (confianza > 0),
//   - ordenados por confianza descendente (y, a igualdad, por nombre
//     ascendente para romper empates estables),
//   - recortados a `limit`.
//
// Si limit <= 0 se devuelven todos los que superen el umbral.
func RankSimilarProducts(invoiceName string, candidates []SimilarProductCandidate, limit int) []RankedProduct {
	queryTokens := DistinctiveInvoiceTokens(invoiceName)
	if len(queryTokens) == 0 {
		return nil
	}

	type scored struct {
		conf float64
		cand SimilarProductCandidate
	}
	scoredAll := make([]scored, 0, len(candidates))
	for _, c := range candidates {
		candTokens := DistinctiveInvoiceTokens(c.ProductName)
		if len(candTokens) == 0 {
			continue
		}
		conf := ScoreNameSimilarity(queryTokens, candTokens)
		if conf <= 0 {
			continue
		}
		scoredAll = append(scoredAll, scored{conf: conf, cand: c})
	}

	// Orden estable: por confianza descendente; empates se rompen por el
	// nombre canonicalizado ascendente. Insertion sort explícito: evita
	// importar "sort" y mantiene semántica estable predecible para los
	// tests. Para los tamaños esperados (<=200 candidatos) es O(n²)
	// irrelevante y queda determinista byte a byte.
	for i := 1; i < len(scoredAll); i++ {
		for j := i; j > 0; j-- {
			a, b := scoredAll[j-1], scoredAll[j]
			if a.conf > b.conf {
				break
			}
			if a.conf == b.conf && CanonicalInvoiceName(a.cand.ProductName) <= CanonicalInvoiceName(b.cand.ProductName) {
				break
			}
			scoredAll[j-1], scoredAll[j] = b, a
		}
	}

	if limit > 0 && len(scoredAll) > limit {
		scoredAll = scoredAll[:limit]
	}
	out := make([]RankedProduct, 0, len(scoredAll))
	for _, s := range scoredAll {
		out = append(out, RankedProduct{
			Barcode:     s.cand.Barcode,
			ProductName: s.cand.ProductName,
			Confidence:  s.conf,
		})
	}
	return out
}

// aliasValidationInput encapsula los tres campos obligatorios del alias
// sin acoplar aliasnorm al modelo persistente (models.SupplierProductAlias
// vive en el paquete de dominio y arrastra tags GORM). El servicio y el
// repo adaptan sus structs a este input al llamar ValidateAndCanonicalize.
type aliasValidationInput struct {
	SupplierID     uint
	InvoiceName    string
	ProductBarcode string
}

// AliasFields representa los campos canonicalizados y validados listos
// para persistir. Los callers escriben estos valores en la fila GORM antes
// de guardarla.
type AliasFields struct {
	SupplierID     uint
	InvoiceName    string
	ProductBarcode string
}

// ValidateAndCanonicalize normaliza y valida los tres campos obligatorios
// de un alias de proveedor:
//
//   - SupplierID > 0 (0 significa "sin proveedor seleccionado" y nunca
//     puede guardarse como alias).
//   - InvoiceName no vacío tras CanonicalInvoiceName.
//   - ProductBarcode no vacío tras TrimSpace (se eleva a MAYÚSCULAS para
//     alinearse con el resto del catálogo).
//
// Devuelve ErrSupplierAliasInvalid envuelto con una pista de qué campo
// falló. En caso de éxito devuelve los campos canonicalizados listos para
// escribir en la fila.
func ValidateAndCanonicalize(supplierID uint, invoiceName, productBarcode string) (AliasFields, error) {
	in := aliasValidationInput{
		SupplierID:     supplierID,
		InvoiceName:    invoiceName,
		ProductBarcode: productBarcode,
	}
	if in.SupplierID == 0 {
		return AliasFields{}, errAliasField("supplierId > 0")
	}
	canonicalName := CanonicalInvoiceName(in.InvoiceName)
	if canonicalName == "" {
		return AliasFields{}, errAliasField("invoiceName requerido")
	}
	barcode := strings.ToUpper(strings.TrimSpace(in.ProductBarcode))
	if barcode == "" {
		return AliasFields{}, errAliasField("productBarcode requerido")
	}
	return AliasFields{
		SupplierID:     in.SupplierID,
		InvoiceName:    canonicalName,
		ProductBarcode: barcode,
	}, nil
}

func errAliasField(reason string) error {
	// errors.Join mantiene el sentinel y agrega contexto sin forzar que
	// los callers inspeccionen el mensaje: errors.Is(err,
	// ErrSupplierAliasInvalid) sigue devolviendo true.
	return errors.Join(ErrSupplierAliasInvalid, errors.New(reason))
}

// AliasUpsertAction es el verbo que el repositorio debe aplicar al
// persistir un alias de proveedor tras consultar las filas existentes.
type AliasUpsertAction int

const (
	// AliasUpsertCreate significa que no existe ninguna fila cuyo
	// invoice_name canonicalizado coincida con el entrante: hay que
	// INSERTAR una fila nueva.
	AliasUpsertCreate AliasUpsertAction = iota
	// AliasUpsertRelink significa que existe una fila con el mismo
	// invoice_name canonicalizado PERO con un barcode distinto: el
	// usuario corrigió el enlace y hay que ACTUALIZAR la fila
	// existente con el nuevo barcode. Se evita "congelar" un enlace
	// erróneo. También se re-escribe el invoice_name con la forma
	// canónica para limpiar filas históricas no normalizadas sin
	// necesidad de migración.
	AliasUpsertRelink
	// AliasUpsertBumpUses significa que existe la fila con el mismo
	// invoice_name canonicalizado Y el mismo barcode: sólo se
	// incrementa el contador de usos (y se re-escribe el invoice_name
	// con la forma canónica, como arriba).
	AliasUpsertBumpUses
)

// AliasRow es la vista mínima de una fila existente de alias que la
// capa de persistencia pasa al decisor puro.
type AliasRow struct {
	ID             uint
	InvoiceName    string
	ProductBarcode string
}

// AliasUpsertDecision es el resultado del decisor: qué fila (si alguna)
// tocar y con qué acción.
type AliasUpsertDecision struct {
	Action   AliasUpsertAction
	TargetID uint
}

// DecideAliasUpsert decide, de forma pura, qué debe hacer el repositorio
// cuando le piden guardar un alias:
//
//   - Si NO existe ninguna fila con el mismo canónico ⇒ Create.
//   - Si existe UNA fila con el mismo canónico y:
//   - mismo barcode (post canonicalización) ⇒ BumpUses sobre esa fila.
//   - barcode distinto ⇒ Relink sobre esa fila (corrige el enlace).
//   - Si hay MÁS de una fila con el mismo canónico (herencia sucia),
//     elige la de mayor ID (la más reciente) para no "congelar" un
//     enlace histórico y aplica la misma lógica de barcode igual/distinto.
//
// Es puro: la entrada es desired + rows; no toca BD. El tie-break por ID
// deja el comportamiento determinista en presencia de duplicados.
//
// Precondición: desired.InvoiceName y desired.ProductBarcode ya vienen
// canonicalizados vía ValidateAndCanonicalize. El decisor comparara los
// invoice_name de las filas aplicando CanonicalInvoiceName para tolerar
// datos antiguos sin canónicos.
func DecideAliasUpsert(desired AliasFields, rows []AliasRow) AliasUpsertDecision {
	var match *AliasRow
	for i := range rows {
		if CanonicalInvoiceName(rows[i].InvoiceName) != desired.InvoiceName {
			continue
		}
		if match == nil || rows[i].ID > match.ID {
			r := rows[i]
			match = &r
		}
	}
	if match == nil {
		return AliasUpsertDecision{Action: AliasUpsertCreate}
	}
	if match.ProductBarcode == desired.ProductBarcode {
		return AliasUpsertDecision{Action: AliasUpsertBumpUses, TargetID: match.ID}
	}
	return AliasUpsertDecision{Action: AliasUpsertRelink, TargetID: match.ID}
}
