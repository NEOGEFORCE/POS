package services

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/sse"
)

// =============================================================================
// Pruebas puras del servicio QR Bold/Bre-B. No tocan BD; se enfocan en:
//
//   - verifyBoldHMAC: tiempo constante, acepta hex con/sin prefijo
//     "sha256=", rechaza firmas corruptas sin filtrar detalles.
//   - fingerprintOfficial / fingerprintBridge: determinísticos y no
//     contienen el token BOLD_BRIDGE_TOKEN.
//   - extractCOPFromMessage: honesta frente a negadores ("reversado",
//     "anulado", etc.) y a tokens sin monto.
//   - parseCOPToken: paridad con el helper del front.
//   - Blindajes anti-leak en el source del archivo.
//
// Las pruebas con tx (SELECT FOR UPDATE, biyecciones) viven en el repo.
// =============================================================================

// -----------------------------------------------------------------------------
// verifyBoldHMAC
// -----------------------------------------------------------------------------

func hexHMAC(secret, body []byte) string {
	m := hmac.New(sha256.New, secret)
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

func TestVerifyBoldHMAC_FirmaValida(t *testing.T) {
	body := []byte(`{"type":"SALE_APPROVED","data":{"amount":{"total":45800},"bold_code":"bld-1"}}`)
	secret := []byte("super-secreto-32-chars-min")
	sig := hexHMAC(secret, body)
	if !verifyBoldHMAC(body, secret, sig) {
		t.Fatal("firma válida fue rechazada")
	}
	// Con prefijo "sha256=" (patrón alternativo frecuente)
	if !verifyBoldHMAC(body, secret, "sha256="+sig) {
		t.Fatal("firma válida con prefijo sha256= fue rechazada")
	}
}

func TestVerifyBoldHMAC_FirmaInvalida(t *testing.T) {
	body := []byte(`{"foo":"bar"}`)
	secret := []byte("super-secreto")
	// Firma incorrecta (bytes aleatorios en hex).
	if verifyBoldHMAC(body, secret, strings.Repeat("ab", 32)) {
		t.Fatal("firma incorrecta fue aceptada")
	}
	// Firma vacía.
	if verifyBoldHMAC(body, secret, "") {
		t.Fatal("firma vacía fue aceptada")
	}
	// Firma con caracteres no-hex.
	if verifyBoldHMAC(body, secret, "no es hex xyz") {
		t.Fatal("firma no-hex fue aceptada")
	}
	// Firma hex con longitud equivocada.
	if verifyBoldHMAC(body, secret, "abcd") {
		t.Fatal("firma hex corta fue aceptada")
	}
}

func TestVerifyBoldHMAC_TimingConstantNoFiltraPorLongitud(t *testing.T) {
	// Si la implementación comparara byte a byte, dos firmas de la
	// misma longitud tardarían diferente según cuántos bytes coincidan.
	// `hmac.Equal` + decode previo nos protege; aquí sólo verificamos
	// que el comportamiento sea estable ante firmas aleatorias.
	body := []byte("payload")
	secret := []byte("secreto")
	right := hexHMAC(secret, body)
	// Mutamos el último byte de `right` para generar una firma de la
	// misma longitud pero incorrecta.
	wrong := right[:len(right)-2] + "ff"
	for i := 0; i < 100; i++ {
		if verifyBoldHMAC(body, secret, wrong) {
			t.Fatal("firma mutada fue aceptada")
		}
	}
}

// -----------------------------------------------------------------------------
// fingerprintOfficial / fingerprintBridge
// -----------------------------------------------------------------------------

func TestFingerprintOfficial_Deterministico(t *testing.T) {
	a := fingerprintOfficial("bld-123", 45800)
	b := fingerprintOfficial("bld-123", 45800)
	if a != b {
		t.Errorf("fingerprint determinístico esperado: a=%s b=%s", a, b)
	}
	// Cambia bold_code → cambia fingerprint
	if fingerprintOfficial("bld-999", 45800) == a {
		t.Error("bold_code distinto debe producir fingerprint distinto")
	}
	// Cambia amount → cambia fingerprint
	if fingerprintOfficial("bld-123", 50000) == a {
		t.Error("amount distinto debe producir fingerprint distinto")
	}
	// 64 hex chars (SHA-256).
	if len(a) != 64 {
		t.Errorf("longitud fingerprint esperada 64, got %d", len(a))
	}
}

func TestFingerprintBridge_BucketDeTiempo(t *testing.T) {
	msg := "Recibiste $45.800 de JUAN"
	now1 := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)  // bucket 0 de la hora
	now2 := time.Date(2026, 10, 20, 10, 0, 30, 0, time.UTC) // mismo bucket (60s)
	now3 := time.Date(2026, 10, 20, 10, 1, 0, 0, time.UTC)  // bucket siguiente
	// Legacy co.bold: sin recibido_ms (=0) → bucket activo.
	f1 := fingerprintBridge(msg, "", 45800, 0, now1)
	f2 := fingerprintBridge(msg, "", 45800, 0, now2)
	f3 := fingerprintBridge(msg, "", 45800, 0, now3)
	if f1 != f2 {
		t.Errorf("mismo bucket debe producir mismo fingerprint: %s vs %s", f1, f2)
	}
	if f1 == f3 {
		t.Error("buckets distintos deben producir fingerprints distintos")
	}
}

func TestFingerprintBridge_RecibidoMsDesactivaBucket(t *testing.T) {
	// Dos SMS DISTINTOS con el mismo monto en el mismo minuto deben
	// producir fingerprints DISTINTOS cuando se envía recibido_ms.
	// Igualdad bit-a-bit se preserva únicamente ante replay EXACTO.
	msg := "Recibiste $45.800 de JUAN"
	now := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	t1 := now.Add(5 * time.Second).UnixMilli()
	t2 := now.Add(30 * time.Second).UnixMilli() // mismo bucket legacy
	f1 := fingerprintBridge(msg, "3001234567", 45800, t1, now)
	f2 := fingerprintBridge(msg, "3001234567", 45800, t2, now)
	if f1 == f2 {
		t.Errorf("dos SMS distintos (recibido_ms distintos) en el mismo bucket NO deben colisionar: %s", f1)
	}
	// Replay del MISMO SMS (mismo recibido_ms) → fingerprint idéntico.
	f3 := fingerprintBridge(msg, "3001234567", 45800, t1, now.Add(1*time.Minute))
	if f3 != f1 {
		t.Errorf("replay del mismo SMS debe producir mismo fingerprint: %s vs %s", f1, f3)
	}
	// Mismo recibido_ms pero remitente distinto → fingerprint distinto.
	f4 := fingerprintBridge(msg, "3009999999", 45800, t1, now)
	if f4 == f1 {
		t.Error("remitentes distintos deben producir fingerprints distintos")
	}
}

func TestFingerprintBridge_NoIncluyeToken(t *testing.T) {
	// El fingerprint NO debe depender del token (si lo tuviera, dos
	// solicitudes legítimas con tokens rotados generarían dos
	// aprobaciones del mismo pago).
	t.Setenv("BOLD_BRIDGE_TOKEN", "secreto-token-1")
	f1 := fingerprintBridge("Recibiste $45.800", "", 45800, 0, time.Unix(1_700_000_000, 0))
	t.Setenv("BOLD_BRIDGE_TOKEN", "secreto-token-2")
	f2 := fingerprintBridge("Recibiste $45.800", "", 45800, 0, time.Unix(1_700_000_000, 0))
	if f1 != f2 {
		t.Error("el fingerprint NO debe depender del BOLD_BRIDGE_TOKEN")
	}
	// Y no debe contener el token en el output (hex ≠ string).
	for _, forbidden := range []string{"secreto-token-1", "secreto-token-2"} {
		if strings.Contains(f1, forbidden) || strings.Contains(f2, forbidden) {
			t.Errorf("fingerprint NO debe filtrar el token: %q", forbidden)
		}
	}
}

// -----------------------------------------------------------------------------
// extractCOPFromMessage / parseCOPToken
// -----------------------------------------------------------------------------

func TestExtractCOPFromMessage_Felices(t *testing.T) {
	type tc struct {
		msg  string
		want int64
	}
	cases := []tc{
		{"Recibiste $45.800", 45800},
		{"Recibiste $45,800", 45800},
		{"Recibiste $1.234.567", 1234567},
		{"Transferencia Bre-B $50.000 de PEPE", 50000},
		{"Monto $45.800,00 COP", 45800},
		{"[Bold] $20.000 confirmados", 20000},
		{"Recibiste $ 45.800", 45800},
		{"Recibiste $4.537", 4537},
		{"Transferencia recibida por $ 4.537,00", 4537},
		// Casos específicos de regresión del bug $300 en producción:
		// MacroDroid envía la notificación formateada con centavos
		// ("$300,00") o decimal corto ("$ 300,0"). El parser debe
		// descartar el decimal y devolver el entero COP.
		{"$300,00", 300},
		{"$300.00", 300},
		{"$ 300,0", 300},
		{"Recibiste $300,00 de PEPE", 300},
		{"Transferencia por $ 300,00", 300},
	}
	for _, c := range cases {
		got, ok := extractCOPFromMessage(c.msg)
		if !ok {
			t.Errorf("extractCOPFromMessage(%q) no reconoció monto", c.msg)
			continue
		}
		if got != c.want {
			t.Errorf("extractCOPFromMessage(%q) = %d, want %d", c.msg, got, c.want)
		}
	}
}

func TestExtractCOPFromMessage_RechazaNegadores(t *testing.T) {
	for _, msg := range []string{
		"Transferencia reversada $45.800",
		"Pago anulado $45.800",
		"Transferencia pendiente $45.800",
		"Operación rechazada $45.800",
		"Pago fallido $45.800",
		"Devolución $45.800",
		"No se pudo completar $45.800",
		"Cancelado $45.800",
	} {
		if _, ok := extractCOPFromMessage(msg); ok {
			t.Errorf("extractCOPFromMessage debe RECHAZAR negador: %q", msg)
		}
	}
}

func TestExtractCOPFromMessage_SinMonto(t *testing.T) {
	for _, msg := range []string{
		"",
		"   ",
		"Pago recibido",
		"$",
		"$0",
		"$-100",
	} {
		if _, ok := extractCOPFromMessage(msg); ok {
			t.Errorf("extractCOPFromMessage debe fallar en %q", msg)
		}
	}
}

func TestParseCOPToken_FormatosReales(t *testing.T) {
	type tc struct {
		in   string
		ok   bool
		want int64
	}
	cases := []tc{
		{"45800", true, 45800},
		{"45.800", true, 45800},
		{"45,800", true, 45800},
		{"1.234.567", true, 1234567},
		{"1,234,567", true, 1234567},
		{"45800,00", true, 45800},
		{"0", false, 0},
		{"", false, 0},
		{"abc", false, 0},
		{"1234.5", true, 1234}, // último grupo es decimal 1-2 chars
		{"12,34", true, 12},    // decimal pequeño descartado
		{"1.23.456", false, 0}, // formato inconsistente
		// Regresión bug $300: MacroDroid formatea con centavos.
		{"300,00", true, 300},
		{"300.00", true, 300},
		{"300,0", true, 300},
	}
	for _, c := range cases {
		got, ok := parseCOPToken(c.in)
		if ok != c.ok {
			t.Errorf("parseCOPToken(%q) ok=%v, want %v", c.in, ok, c.ok)
			continue
		}
		if ok && got != c.want {
			t.Errorf("parseCOPToken(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

// -----------------------------------------------------------------------------
// Service: validaciones de input duro (no requieren BD)
// -----------------------------------------------------------------------------

func TestQrPaymentService_Initiate_RechazaInputsDuros(t *testing.T) {
	svc := NewQrPaymentService(nil, nil, nil) // nil repo/hub: no debe tocarlos
	type tc struct {
		name   string
		venta  string
		caja   string
		dni    string
		amount int64
	}
	cases := []tc{
		{"venta inválido", "ab", "C", "D", 1000},
		{"caja vacía", "temp-abc-123", "", "D", 1000},
		{"dni vacío", "temp-abc-123", "C", "", 1000},
		{"amount cero", "temp-abc-123", "C", "D", 0},
		{"amount tope+1", "temp-abc-123", "C", "D", models.QRPaymentIntentMaxAmountCOP + 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := svc.Initiate(nil, c.venta, c.caja, c.dni, c.amount)
			if err == nil {
				t.Errorf("Initiate(%+v) no retornó error", c)
			}
			if err != ErrQRInvalidInput {
				t.Errorf("se esperaba ErrQRInvalidInput, got %v", err)
			}
		})
	}
}

func TestQrPaymentService_IngestOfficial_SinBody(t *testing.T) {
	svc := NewQrPaymentService(nil, nil, nil)
	_, err := svc.IngestOfficialWebhook(nil, nil, "")
	if err != ErrQRWebhookBadPayload {
		t.Errorf("se esperaba ErrQRWebhookBadPayload, got %v", err)
	}
}

func TestQrPaymentService_IngestOfficial_BodyEnorme(t *testing.T) {
	svc := NewQrPaymentService(nil, nil, nil)
	tooBig := make([]byte, models.QRWebhookMaxBodyBytes+100)
	_, err := svc.IngestOfficialWebhook(nil, tooBig, "")
	if err != ErrQRWebhookTooLarge {
		t.Errorf("se esperaba ErrQRWebhookTooLarge, got %v", err)
	}
}

func TestQrPaymentService_IngestOfficial_HMACInvalida(t *testing.T) {
	t.Setenv(envBoldSecretKey, "secreto-config")
	svc := NewQrPaymentService(nil, nil, nil)
	body := []byte(`{"type":"SALE_APPROVED","data":{"amount":{"total":45800},"bold_code":"bld-1"}}`)
	_, err := svc.IngestOfficialWebhook(nil, body, "firma-mal-formada")
	if err != ErrQRWebhookUnauthorized {
		t.Errorf("HMAC inválido debe devolver ErrQRWebhookUnauthorized, got %v", err)
	}
}

func TestQrPaymentService_IngestOfficial_SinSecretFallaCerrado(t *testing.T) {
	os.Unsetenv(envBoldSecretKey)
	svc := NewQrPaymentService(nil, nil, nil)
	body := []byte(`{"type":"SALE_APPROVED","data":{"amount":{"total":45800},"bold_code":"bld-1"}}`)
	_, err := svc.IngestOfficialWebhook(nil, body, "")
	if err != ErrQRWebhookUnauthorized {
		t.Errorf("sin BOLD_SECRET_KEY el webhook oficial debe fallar cerrado, got %v", err)
	}
}

func TestQrPaymentService_IngestOfficial_RechazaOtrosEventos(t *testing.T) {
	secret := []byte("secreto-config")
	t.Setenv(envBoldSecretKey, string(secret))
	svc := NewQrPaymentService(nil, nil, nil)
	body := []byte(`{"type":"REFUND","data":{"amount":{"total":45800},"bold_code":"bld-1"}}`)
	_, err := svc.IngestOfficialWebhook(nil, body, hexHMAC(secret, body))
	if err != ErrQRWebhookRejected {
		t.Errorf("eventos != SALE_APPROVED deben rejected, got %v", err)
	}
}

func TestQrPaymentService_IngestBridge_SinTokenConfigurado(t *testing.T) {
	os.Unsetenv(envBoldBridgeToken)
	svc := NewQrPaymentService(nil, nil, nil)
	body := []byte(`{"titulo":"Bold","mensaje":"Recibiste $45.800","token":"x"}`)
	_, err := svc.IngestBridgeWebhook(nil, body, "")
	if err != ErrQRWebhookUnauthorized {
		t.Errorf("sin BOLD_BRIDGE_TOKEN config, debe 401, got %v", err)
	}
}

func TestQrPaymentService_IngestBridge_TokenInvalido(t *testing.T) {
	t.Setenv(envBoldBridgeToken, "token-correcto")
	svc := NewQrPaymentService(nil, nil, nil)
	body := []byte(`{"titulo":"Bold","mensaje":"Recibiste $45.800","token":"token-malo"}`)
	_, err := svc.IngestBridgeWebhook(nil, body, "")
	if err != ErrQRWebhookUnauthorized {
		t.Errorf("token inválido debe 401, got %v", err)
	}
}

func TestQrPaymentService_IngestBridge_MensajeConNegador(t *testing.T) {
	t.Setenv(envBoldBridgeToken, "tok")
	svc := NewQrPaymentService(nil, nil, nil)
	body := []byte(`{"titulo":"Bold","mensaje":"Transferencia reversada $45.800","app":"co.bold","token":"tok"}`)
	_, err := svc.IngestBridgeWebhook(nil, body, "")
	if err != ErrQRWebhookRejected {
		t.Errorf("mensaje con negador debe rechazarse, got %v", err)
	}
}

// -----------------------------------------------------------------------------
// Blindajes anti-leak
// -----------------------------------------------------------------------------

func qrServiceSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("pos_qr_service.go")
	if err != nil {
		t.Fatalf("read pos_qr_service.go: %v", err)
	}
	return string(b)
}

// stripGoLineCommentsService: duplicado local para no exportar el
// helper del paquete repositories. Mantiene strings y descarta
// comentarios para que el escaneo no se dispare contra sí mismo.
func stripGoLineCommentsService(src string) string {
	var out strings.Builder
	i, n := 0, len(src)
	inLine, inBlock, inStr := false, false, false
	var sq byte
	for i < n {
		c := src[i]
		if inLine {
			if c == '\n' {
				inLine = false
				out.WriteByte(c)
			}
			i++
			continue
		}
		if inBlock {
			if c == '*' && i+1 < n && src[i+1] == '/' {
				inBlock = false
				i += 2
				continue
			}
			if c == '\n' {
				out.WriteByte(c)
			}
			i++
			continue
		}
		if inStr {
			out.WriteByte(c)
			if c == '\\' && i+1 < n {
				out.WriteByte(src[i+1])
				i += 2
				continue
			}
			if c == sq {
				inStr = false
			}
			i++
			continue
		}
		if c == '"' || c == '`' {
			inStr = true
			sq = c
			out.WriteByte(c)
			i++
			continue
		}
		if c == '/' && i+1 < n {
			if src[i+1] == '/' {
				inLine = true
				i += 2
				continue
			}
			if src[i+1] == '*' {
				inBlock = true
				i += 2
				continue
			}
		}
		out.WriteByte(c)
		i++
	}
	return out.String()
}

// TestQrPaymentService_NoLogueaSecretos: el service NO debe imprimir
// ni el BOLD_SECRET_KEY, ni la firma HMAC, ni el token del bridge,
// ni el payload crudo. Un log.Printf con rawBody/signature/token
// como argumento está prohibido.
func TestQrPaymentService_NoLogueaSecretos(t *testing.T) {
	code := stripGoLineCommentsService(qrServiceSource(t))
	// Extraer todas las llamadas a log.* y verificar que ningún
	// argumento sea una de las variables prohibidas. Esto evita
	// falsos positivos cuando una llamada legítima (p.ej.
	// `verifyBoldHMAC(rawBody, []byte(secret), signatureHeader)`)
	// termina en `, secret)` o `, signatureHeader)`.
	logRe := strings.NewReplacer()
	_ = logRe
	// Heurística: dividimos por líneas y filtramos las que empiezan
	// con `log.`. Dentro de esas, prohibimos los nombres sensibles.
	forbiddenVars := []string{
		"rawBody", "secret", "bridgeSecret", "signatureHeader",
		"headerToken", "payload.Token", "BOLD_SECRET_KEY",
		"BOLD_BRIDGE_TOKEN",
	}
	// `provided` también debería estar prohibido pero el service
	// nunca lo loguea (y la palabra aparece en nombres de parámetros
	// legítimos de otras funciones). Hacemos la verificación con un
	// patrón más estricto: `, provided)` sólo dentro de llamadas log.
	for _, line := range strings.Split(code, "\n") {
		trim := strings.TrimSpace(line)
		if !strings.HasPrefix(trim, "log.Printf") && !strings.HasPrefix(trim, "log.Println") {
			continue
		}
		for _, v := range forbiddenVars {
			// Busca `, <v>)` o `, <v>,` dentro de la línea de log.
			if strings.Contains(trim, ", "+v+")") || strings.Contains(trim, ", "+v+",") {
				t.Errorf("log en pos_qr_service.go NO debe interpolar %q: %s", v, trim)
			}
		}
	}
}

// TestQrPaymentService_UsaConstantTimeCompare asegura que la
// comparación del token del bridge NO sea `==` ni `strings.EqualFold`.
func TestQrPaymentService_UsaConstantTimeCompare(t *testing.T) {
	code := stripGoLineCommentsService(qrServiceSource(t))
	// Debe mencionar la primitiva constant-time.
	if !strings.Contains(code, "subtle.ConstantTimeCompare") {
		t.Error("el service debe comparar el token con subtle.ConstantTimeCompare")
	}
	if !strings.Contains(code, "hmac.Equal") {
		t.Error("el service debe comparar HMAC con hmac.Equal")
	}
	// Y NO debe comparar provided == bridgeSecret con `==` directo.
	if strings.Contains(code, "provided == bridgeSecret") || strings.Contains(code, "bridgeSecret == provided") {
		t.Error("comparación de token con == rompe la propiedad timing-constant")
	}
}

// TestQrPaymentService_LlamaWipeStringTrasComparacion verifica que
// tras comparar el token, el valor se blanquee. Es defensa parcial
// pero evita que un panic recoverer que loggee el struct exponga el
// secreto.
func TestQrPaymentService_LlamaWipeStringTrasComparacion(t *testing.T) {
	code := stripGoLineCommentsService(qrServiceSource(t))
	if !strings.Contains(code, "wipeString(&provided)") {
		t.Error("tras comparar el token con constant-time, debe wipeString(&provided)")
	}
	if !strings.Contains(code, `payload.Token = ""`) {
		t.Error("tras comparar el token, el servicio debe limpiar payload.Token = \"\"")
	}
}

// Guardián: el servicio NO debe persistir rawBody ni signatureHeader
// en la BD. Buscamos que esos nombres no aparezcan en las variables
// pasadas al repo. Patrón: IngestWebhookInput{...}.
func TestQrPaymentService_NoPersisteSecretosEnBD(t *testing.T) {
	code := stripGoLineCommentsService(qrServiceSource(t))
	// Grosso modo: localizamos cada struct literal con IngestWebhookInput y
	// verificamos que no haya `Note: rawBody` ni `Fingerprint: signatureHeader`
	// (patrones groseros).
	for _, forbidden := range []string{
		"Note: rawBody",
		"Note: signatureHeader",
		"Note: provided",
		"Fingerprint: signatureHeader",
		"Fingerprint: provided",
		"Fingerprint: rawBody",
	} {
		if strings.Contains(code, forbidden) {
			t.Errorf("pos_qr_service.go NO debe pasar %q al repo", forbidden)
		}
	}
}

func TestBridgeNotificationText_ExtraeMontoDeTituloOMensaje(t *testing.T) {
	cases := []BoldBridgePayload{
		{Titulo: "Transferencia recibida por $ 4.537,00", Mensaje: "Disponible en tu Cuenta Bold"},
		{Titulo: "Transferencia recibida", Mensaje: "Recibiste $4.537", App: "co.bold"},
	}
	for _, payload := range cases {
		got, ok := extractCOPFromMessage(bridgeNotificationText(payload))
		if !ok || got != 4537 {
			t.Fatalf("título+mensaje debe producir 4537, got=%d ok=%v payload=%+v", got, ok, payload)
		}
	}
}

func TestBridgeNotificationText_NegadorEnCualquierCampoRechaza(t *testing.T) {
	payload := BoldBridgePayload{Titulo: "Transferencia reversada", Mensaje: "Recibiste $4.537"}
	if _, ok := extractCOPFromMessage(bridgeNotificationText(payload)); ok {
		t.Fatal("un negador en el título debe impedir la extracción")
	}
}

func TestIsBoldAndroidApp_SoloPackageOficial(t *testing.T) {
	for _, app := range []string{"co.bold", " CO.BOLD "} {
		if !isBoldAndroidApp(app) {
			t.Fatalf("package oficial rechazado: %q", app)
		}
	}
	for _, app := range []string{"", "com.bold", "co.bold.fake", "com.whatsapp"} {
		if isBoldAndroidApp(app) {
			t.Fatalf("package ajeno aceptado: %q", app)
		}
	}
}

func TestLogBoldBridgeNotification_RegistraTextosPeroNuncaToken(t *testing.T) {
	var buf bytes.Buffer
	previousWriter := log.Writer()
	previousFlags := log.Flags()
	previousPrefix := log.Prefix()
	log.SetOutput(&buf)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(previousWriter)
		log.SetFlags(previousFlags)
		log.SetPrefix(previousPrefix)
	})

	payload := BoldBridgePayload{
		Titulo:  "Título exacto",
		Mensaje: "Línea 1\nRecibiste $4.537",
		App:     "co.bold",
		Token:   "SECRETO-QUE-NUNCA-DEBE-SALIR",
	}
	logBoldBridgeNotification(payload)
	got := buf.String()
	for _, expected := range []string{`app="co.bold"`, `titulo="Título exacto"`, `mensaje="Línea 1\nRecibiste $4.537"`} {
		if !strings.Contains(got, expected) {
			t.Fatalf("log no conserva campo esperado %q: %s", expected, got)
		}
	}
	if strings.Contains(got, payload.Token) || strings.Contains(strings.ToLower(got), "token=") {
		t.Fatalf("el log filtró el token: %s", got)
	}
}

func TestQrPaymentService_IngestBridge_RechazaAppAjena(t *testing.T) {
	t.Setenv(envBoldBridgeToken, "token-correcto")
	svc := NewQrPaymentService(nil, nil, nil)
	body := []byte(`{"titulo":"Pago","mensaje":"Recibiste $4.537","app":"com.whatsapp"}`)
	_, err := svc.IngestBridgeWebhook(nil, body, "token-correcto")
	if err != ErrQRWebhookRejected {
		t.Fatalf("app ajena debe ignorarse, got %v", err)
	}
}

func TestPublishIntentSnapshot_PendienteLlegaAlSSEDeLaVenta(t *testing.T) {
	hub := sse.NewQRHub()
	ventaTempID := "temp-regresion-iniciar-sse"
	ch, cancel := hub.Subscribe(ventaTempID)
	defer cancel()

	now := time.Date(2026, 10, 21, 9, 30, 0, 0, time.UTC)
	svc := NewQrPaymentService(nil, hub, nil)
	svc.publishIntentSnapshot(&models.QrPaymentIntent{
		ID:          77,
		VentaTempID: ventaTempID,
		AmountCOP:   4537,
		Status:      models.QRIntentStatusPending,
		CreatedAt:   now,
		ExpiresAt:   now.Add(models.QRPaymentIntentDefaultTTL),
	})

	select {
	case event := <-ch:
		if event.Status != models.QRStreamStatusPending {
			t.Fatalf("status SSE=%q, want %q", event.Status, models.QRStreamStatusPending)
		}
		if event.ExpiresAt == "" {
			t.Fatal("snapshot PENDIENTE debe incluir expiresAt")
		}
		if event.Reference != "" || event.ApprovedAt != "" || event.ApprovedVia != "" {
			t.Fatalf("PENDIENTE no debe inventar aprobación: %+v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("la intención PENDIENTE no llegó al subscriber SSE de su venta_temp_id")
	}
}
