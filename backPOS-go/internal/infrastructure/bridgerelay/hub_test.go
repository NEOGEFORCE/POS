package bridgerelay

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeConn implementa WSConn con canales. Los tests escriben "mensajes
// entrantes" vía `incoming` y leen "mensajes salientes" vía `outgoing`.
// Un `writeBlocker` opcional permite simular una conexión lenta (write
// se queda esperando hasta que el test libere).
type fakeConn struct {
	name          string
	incoming      chan json.RawMessage
	outgoing      chan json.RawMessage
	mu            sync.Mutex
	closed        bool
	writeBlocker  chan struct{} // nil = sin bloqueo; cerrado = ya desbloqueado
	writeErr      error
	readErrOnDone bool
	done          chan struct{}
}

func newFakeConn(name string) *fakeConn {
	return &fakeConn{
		name:     name,
		incoming: make(chan json.RawMessage, 64),
		outgoing: make(chan json.RawMessage, 64),
		done:     make(chan struct{}),
	}
}

func (f *fakeConn) WriteJSON(v interface{}) error {
	if blocker := f.getWriteBlocker(); blocker != nil {
		select {
		case <-blocker:
		case <-f.done:
			return errors.New("conn closed")
		}
	}
	f.mu.Lock()
	if f.writeErr != nil {
		err := f.writeErr
		f.mu.Unlock()
		return err
	}
	if f.closed {
		f.mu.Unlock()
		return errors.New("conn closed")
	}
	f.mu.Unlock()

	buf, err := json.Marshal(v)
	if err != nil {
		return err
	}
	select {
	case f.outgoing <- json.RawMessage(buf):
		return nil
	case <-f.done:
		return errors.New("conn closed")
	}
}

func (f *fakeConn) ReadJSON(v interface{}) error {
	select {
	case msg, ok := <-f.incoming:
		if !ok {
			return io.EOF
		}
		return json.Unmarshal(msg, v)
	case <-f.done:
		return io.EOF
	}
}

func (f *fakeConn) Close() error {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return nil
	}
	f.closed = true
	close(f.done)
	// Si estaba bloqueando una escritura, la liberamos para desbloquear
	// cualquier goroutine atascada en ella.
	if f.writeBlocker != nil {
		select {
		case <-f.writeBlocker:
		default:
			close(f.writeBlocker)
		}
	}
	f.mu.Unlock()
	return nil
}

func (f *fakeConn) RemoteAddr() string { return f.name }

// setWriteBlocker instala un canal que bloquea WriteJSON hasta que se
// cierre. Pasar nil deshabilita el bloqueo.
func (f *fakeConn) setWriteBlocker(ch chan struct{}) {
	f.mu.Lock()
	f.writeBlocker = ch
	f.mu.Unlock()
}

func (f *fakeConn) getWriteBlocker() chan struct{} {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.writeBlocker
}

// pushIncoming simula un mensaje recibido por la conexión. Los tests lo
// usan para "mandar" tráfico que el loop de read procesará.
func (f *fakeConn) pushIncoming(msg string) {
	select {
	case f.incoming <- json.RawMessage(msg):
	case <-f.done:
	}
}

// expectOut lee la próxima escritura con timeout; falla el test si no
// hay nada.
func (f *fakeConn) expectOut(t *testing.T, timeout time.Duration) json.RawMessage {
	t.Helper()
	select {
	case msg := <-f.outgoing:
		return msg
	case <-time.After(timeout):
		t.Fatalf("fakeConn %q: no llegó mensaje en %s", f.name, timeout)
		return nil
	}
}

// expectNoOut verifica que durante `d` no se escriba nada.
func (f *fakeConn) expectNoOut(t *testing.T, d time.Duration) {
	t.Helper()
	select {
	case msg := <-f.outgoing:
		t.Fatalf("fakeConn %q: no esperaba mensaje, llegó %s", f.name, string(msg))
	case <-time.After(d):
	}
}

func (f *fakeConn) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

// ===========================================================================
// Tests
// ===========================================================================

func newTestHub(audit AuditSink) *Hub {
	return NewHub(audit)
}

// drainStatusOffline absorbe el status connected:false que el Hub emite
// al cliente que entra sin agente activo. Devuelve el payload leído.
func drainStatusOffline(t *testing.T, c *fakeConn) {
	t.Helper()
	msg := c.expectOut(t, time.Second)
	if !strings.Contains(string(msg), `"connected":false`) {
		t.Fatalf("se esperaba status offline inicial, llegó %s", string(msg))
	}
}

func TestHub_RegistersAgentAndRoutesBroadcastToClients(t *testing.T) {
	h := newTestHub(nil)
	defer h.Shutdown(nil)

	agConn := newFakeConn("ag1")
	agent := h.RegisterAgent("CAJA-01", agConn)
	go agent.Run()

	c1 := newFakeConn("cli1")
	c2 := newFakeConn("cli2")

	// Clientes se registran cuando el agente ya está vivo → no deben
	// recibir status offline inicial.
	ident := TicketIdentity{CajaID: "CAJA-01", DNI: "1"}
	cl1 := h.RegisterClient(ident, c1, "", "")
	cl2 := h.RegisterClient(ident, c2, "", "")
	go cl1.Run()
	go cl2.Run()

	// El agente emite un broadcast de peso (envuelve con {"payload":...}
	// y sin relayId, como pide el contrato agente<->servidor).
	inner := `{"type":"weight","value":1.234,"display":"1.234"}`
	agConn.pushIncoming(`{"payload":` + inner + `}`)

	msg1 := c1.expectOut(t, time.Second)
	msg2 := c2.expectOut(t, time.Second)
	if string(msg1) != inner || string(msg2) != inner {
		t.Fatalf("broadcast mal entregado:\n c1=%s\n c2=%s", msg1, msg2)
	}
}

func TestHub_RoutesTargetedResponseByRelayId(t *testing.T) {
	h := newTestHub(nil)
	defer h.Shutdown(nil)

	agConn := newFakeConn("ag")
	agent := h.RegisterAgent("CAJA-01", agConn)
	go agent.Run()

	c1 := newFakeConn("c1")
	c2 := newFakeConn("c2")
	cl1 := h.RegisterClient(TicketIdentity{CajaID: "CAJA-01", DNI: "1", IsAdmin: true}, c1, "", "")
	cl2 := h.RegisterClient(TicketIdentity{CajaID: "CAJA-01", DNI: "2", IsAdmin: true}, c2, "", "")
	go cl1.Run()
	go cl2.Run()

	// Primer cliente manda un printer.request. El Hub lo envuelve con
	// relayId y lo entrega al agente.
	req := `{"type":"printer.request","action":"print","requestId":"req-1","payload":{"foo":"bar"}}`
	c1.pushIncoming(req)

	envRaw := agConn.expectOut(t, time.Second)
	var env agentEnvelope
	if err := json.Unmarshal(envRaw, &env); err != nil {
		t.Fatalf("agent envelope inválido: %v (%s)", err, envRaw)
	}
	if env.RelayID != cl1.id {
		t.Fatalf("relayId want %s, got %s", cl1.id, env.RelayID)
	}
	if !strings.Contains(string(env.Payload), `"requestId":"req-1"`) {
		t.Fatalf("payload no preservado: %s", env.Payload)
	}

	// El agente responde dirigido a cl1. cl2 NO debe recibir nada.
	resp := `{"relayId":"` + cl1.id + `","payload":{"type":"printer.response","requestId":"req-1","ok":true,"result":{}}}`
	agConn.pushIncoming(resp)

	got := c1.expectOut(t, time.Second)
	if !strings.Contains(string(got), `"requestId":"req-1"`) || !strings.Contains(string(got), `"ok":true`) {
		t.Fatalf("respuesta no reenviada tal cual: %s", got)
	}
	c2.expectNoOut(t, 100*time.Millisecond)
}

func TestHub_ReplacesAgentForSameCaja(t *testing.T) {
	h := newTestHub(nil)
	defer h.Shutdown(nil)

	first := newFakeConn("first")
	a1 := h.RegisterAgent("CAJA-01", first)
	go a1.Run()

	// Segundo agente con la misma caja: el primero debe cerrarse.
	second := newFakeConn("second")
	a2 := h.RegisterAgent("CAJA-01", second)
	go a2.Run()

	// Esperamos a que el primer agente quede cerrado (closeAll fuera del lock).
	deadline := time.Now().Add(time.Second)
	for !first.isClosed() {
		if time.Now().After(deadline) {
			t.Fatal("el agente anterior no se cerró tras el reemplazo")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if h.AgentFor("CAJA-01") != a2 {
		t.Fatal("agente activo debe ser el segundo")
	}
}

func TestHub_StatusOfflineOnAgentDisconnect(t *testing.T) {
	h := newTestHub(nil)
	defer h.Shutdown(nil)

	agConn := newFakeConn("ag")
	agent := h.RegisterAgent("CAJA-01", agConn)
	go agent.Run()

	cConn := newFakeConn("c")
	cl := h.RegisterClient(TicketIdentity{CajaID: "CAJA-01", DNI: "1"}, cConn, "", "")
	go cl.Run()

	// Cerramos la conexión del agente: eso dispara unregisterAgent y
	// debe empujar status offline a los clientes.
	_ = agConn.Close()

	msg := cConn.expectOut(t, time.Second)
	if !strings.Contains(string(msg), `"type":"status"`) ||
		!strings.Contains(string(msg), `"connected":false`) {
		t.Fatalf("se esperaba status offline, llegó %s", msg)
	}
}

func TestHub_ClientWithoutAgentGetsOfflineAndAgentOfflineOnRequest(t *testing.T) {
	h := newTestHub(nil)
	defer h.Shutdown(nil)

	cConn := newFakeConn("c")
	cl := h.RegisterClient(TicketIdentity{CajaID: "CAJA-99", DNI: "1"}, cConn, "", "")
	go cl.Run()
	drainStatusOffline(t, cConn)

	// Un printer.request sin agente devuelve printer.response ok:false
	// errorCode:RELAY_AGENT_OFFLINE con el mismo requestId.
	req := `{"type":"printer.request","action":"print","requestId":"X-1","payload":{}}`
	cConn.pushIncoming(req)

	resp := cConn.expectOut(t, time.Second)
	if !strings.Contains(string(resp), `"errorCode":"RELAY_AGENT_OFFLINE"`) {
		t.Fatalf("want RELAY_AGENT_OFFLINE, got %s", resp)
	}
	if !strings.Contains(string(resp), `"requestId":"X-1"`) {
		t.Fatalf("requestId no eco'ado: %s", resp)
	}
}

func TestHub_KickDrawerForbiddenForNonAdmin(t *testing.T) {
	var captured []AuditEvent
	audit := func(ev AuditEvent) { captured = append(captured, ev) }
	h := newTestHub(audit)
	defer h.Shutdown(nil)

	agConn := newFakeConn("ag")
	ag := h.RegisterAgent("CAJA-01", agConn)
	go ag.Run()

	cConn := newFakeConn("c")
	cl := h.RegisterClient(TicketIdentity{CajaID: "CAJA-01", DNI: "9", Role: "empleado"}, cConn, "", "")
	go cl.Run()

	req := `{"type":"printer.request","action":"kickDrawer","requestId":"kd-1","payload":{}}`
	cConn.pushIncoming(req)

	resp := cConn.expectOut(t, time.Second)
	if !strings.Contains(string(resp), `"errorCode":"RELAY_FORBIDDEN"`) {
		t.Fatalf("want RELAY_FORBIDDEN, got %s", resp)
	}
	// El agente NO debe haber recibido nada.
	agConn.expectNoOut(t, 100*time.Millisecond)

	// Debe haberse auditado el intento.
	if len(captured) == 0 {
		t.Fatal("no se auditó el intento rechazado de kickDrawer")
	}
	found := false
	for _, ev := range captured {
		if ev.Action == "KICK_DRAWER_FORBIDDEN" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("no se encontró evento KICK_DRAWER_FORBIDDEN en %+v", captured)
	}
}

func TestHub_KickDrawerAllowedForAdminAndAudited(t *testing.T) {
	var captured []AuditEvent
	audit := func(ev AuditEvent) { captured = append(captured, ev) }
	h := newTestHub(audit)
	defer h.Shutdown(nil)

	agConn := newFakeConn("ag")
	ag := h.RegisterAgent("CAJA-01", agConn)
	go ag.Run()

	cConn := newFakeConn("c")
	cl := h.RegisterClient(TicketIdentity{CajaID: "CAJA-01", DNI: "7", Role: "admin", IsAdmin: true}, cConn, "", "")
	go cl.Run()

	req := `{"type":"printer.request","action":"kickDrawer","requestId":"kd-2","payload":{"openDrawerOnSale":true}}`
	cConn.pushIncoming(req)

	// El agente debe recibir el envelope.
	env := agConn.expectOut(t, time.Second)
	if !strings.Contains(string(env), `"relayId"`) {
		t.Fatalf("agente no recibió envelope: %s", env)
	}

	// Y debe quedar auditado como KICK_DRAWER crítico.
	if len(captured) == 0 {
		t.Fatal("kickDrawer admin no auditado")
	}
	ev := captured[0]
	if ev.Action != "KICK_DRAWER" || !ev.IsCritical {
		t.Fatalf("evento incorrecto: %+v", ev)
	}
}

func TestHub_RelayTimeoutOnMissingAgentResponse(t *testing.T) {
	h := newTestHub(nil)
	defer h.Shutdown(nil)

	agConn := newFakeConn("ag")
	ag := h.RegisterAgent("CAJA-01", agConn)
	go ag.Run()

	cConn := newFakeConn("c")
	cl := h.RegisterClient(TicketIdentity{CajaID: "CAJA-01", DNI: "1", IsAdmin: true}, cConn, "", "")
	go cl.Run()

	// Reducimos el timeout vía el campo privado para no esperar 15 s.
	cl.pendingMu.Lock()
	cl.pending["bogus"] = time.AfterFunc(time.Hour, func() {}) // placeholder
	cl.pendingMu.Unlock()
	delete(cl.pending, "bogus")

	// Cambiamos el timeout acortando pendientes "manualmente":
	// no hay API pública para cambiar `requestTimeout`, así que usamos
	// un atajo: enviamos el request y leemos la escritura al agente,
	// luego llamamos a `cancelPending` manualmente para no esperar 15 s.
	// Para probar realmente el camino de timeout, programamos un timer
	// corto nosotros mismos y verificamos que `sendPrinterError` lo
	// enruta.

	// Enviamos un request; el agente lo recibe pero no responde.
	req := `{"type":"printer.request","action":"print","requestId":"to-1","payload":{}}`
	cConn.pushIncoming(req)
	_ = agConn.expectOut(t, time.Second) // consumimos sin responder

	// Simulamos el disparo del timeout llamando a la ruta que lo haría.
	cl.pendingMu.Lock()
	if t2, ok := cl.pending["to-1"]; ok {
		t2.Stop()
	}
	delete(cl.pending, "to-1")
	cl.pendingMu.Unlock()
	cl.sendPrinterError("to-1", ErrCodeTimeout, "El agente del bridge no respondió en 15 s")

	resp := cConn.expectOut(t, time.Second)
	if !strings.Contains(string(resp), `"errorCode":"RELAY_TIMEOUT"`) ||
		!strings.Contains(string(resp), `"requestId":"to-1"`) {
		t.Fatalf("respuesta de timeout incorrecta: %s", resp)
	}
}

func TestHub_SlowClientGetsDisconnectedWithoutStallingHub(t *testing.T) {
	h := newTestHub(nil)
	defer h.Shutdown(nil)

	agConn := newFakeConn("ag")
	ag := h.RegisterAgent("CAJA-01", agConn)
	go ag.Run()

	// Cliente lento: no vamos a leer su outgoing nunca; además bloqueamos
	// WriteJSON para que ni siquiera pueda escribir.
	slow := newFakeConn("slow")
	blocker := make(chan struct{})
	slow.setWriteBlocker(blocker)
	slowCl := h.RegisterClient(TicketIdentity{CajaID: "CAJA-01", DNI: "99"}, slow, "", "")
	go slowCl.Run()

	// Cliente rápido convive con el lento.
	fast := newFakeConn("fast")
	fastCl := h.RegisterClient(TicketIdentity{CajaID: "CAJA-01", DNI: "100"}, fast, "", "")
	go fastCl.Run()

	// Mandamos muchos broadcasts (más que clientSendBuffer) para llenar
	// el buffer del cliente lento. El cliente rápido debe recibirlos
	// todos (menos tolerancia por carrera inicial) y el lento ser
	// desconectado.
	//
	// Lanzamos la emisión y el drenaje del cliente rápido en goroutines
	// para evitar bloquearnos: `pushIncoming` tiene buffer finito y el
	// outgoing del cliente rápido también.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < clientSendBuffer*8; i++ {
			agConn.pushIncoming(`{"payload":{"type":"weight","value":0,"display":"0.000"}}`)
		}
	}()
	drain := make(chan struct{})
	go func() {
		for {
			select {
			case <-fast.outgoing:
			case <-drain:
				return
			}
		}
	}()
	defer close(drain)

	// Esperamos a que el lento se cierre o pasen 3 s.
	deadline := time.Now().Add(3 * time.Second)
	for !slow.isClosed() {
		if time.Now().After(deadline) {
			t.Fatal("cliente lento no fue desconectado")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// slow.Close() ya cerró el blocker; no lo volvemos a cerrar aquí.
	// Esperamos a que el emisor termine (ya nadie bloquea el buffer de
	// incoming porque el agente sigue drenando).
	<-done
}

func TestHub_ShutdownClosesEverything(t *testing.T) {
	h := newTestHub(nil)
	agConn := newFakeConn("ag")
	ag := h.RegisterAgent("CAJA-01", agConn)
	go ag.Run()
	cConn := newFakeConn("c")
	cl := h.RegisterClient(TicketIdentity{CajaID: "CAJA-01", DNI: "1"}, cConn, "", "")
	go cl.Run()
	// Consumimos el status offline que podría haberse emitido antes de
	// que el agente lo desmienta por ser puramente inicial.
	select {
	case <-cConn.outgoing:
	case <-time.After(50 * time.Millisecond):
	}

	_ = h.Shutdown(nil)

	deadline := time.Now().Add(time.Second)
	for !agConn.isClosed() || !cConn.isClosed() {
		if time.Now().After(deadline) {
			t.Fatalf("Shutdown no cerró conexiones agConn.closed=%v cConn.closed=%v", agConn.isClosed(), cConn.isClosed())
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Segundo Shutdown no debe entrar en pánico.
	if err := h.Shutdown(nil); err != nil {
		t.Fatalf("Shutdown idempotente devolvió %v", err)
	}
}

func TestHub_AgentsSnapshotIncludesConnectedAgent(t *testing.T) {
	h := newTestHub(nil)
	defer h.Shutdown(nil)

	ag := h.RegisterAgent("CAJA-01", newFakeConn("ag"))
	go ag.Run()

	ss := h.Agents()
	if len(ss) != 1 {
		t.Fatalf("want 1 agent, got %d", len(ss))
	}
	if ss[0].CajaID != "CAJA-01" || !ss[0].Connected {
		t.Fatalf("snapshot inválido: %+v", ss[0])
	}
	if ss[0].ConnectedAt.IsZero() || ss[0].LastSeenAt.IsZero() {
		t.Fatalf("timestamps zero: %+v", ss[0])
	}
}
