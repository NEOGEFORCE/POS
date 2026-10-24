package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/infrastructure/bridgerelay"

	"github.com/gorilla/websocket"
)

// =============================================================================
// B4 — Política de Origin del relay
//
// El celular que entra por `http://192.168.1.6:3000` o un cliente Tailscale
// que entra por `http://desktop-vk2u90s.tail6c4b2d.ts.net:3000` no estaban
// listados en `allowedOrigins`. La política same-host permite que ambos
// casos funcionen sin precargar hostnames: si `Origin.Host == r.Host`, se
// acepta.
// =============================================================================

func TestOriginHostMatchesRequest_LANyTailscale(t *testing.T) {
	cases := []struct {
		name        string
		origin      string
		requestHost string
		want        bool
	}{
		{"LAN exacto", "http://192.168.1.6:3000", "192.168.1.6:3000", true},
		{"Tailscale FQDN", "http://desktop-vk2u90s.tail6c4b2d.ts.net:3000",
			"desktop-vk2u90s.tail6c4b2d.ts.net:3000", true},
		{"Tailscale IP", "http://100.94.235.56:3000", "100.94.235.56:3000", true},
		{"case insensitive", "http://DESKTOP-VK2U90S.tail.ts.net:3000",
			"desktop-vk2u90s.tail.ts.net:3000", true},
		{"origin con path", "http://192.168.1.6:3000/", "192.168.1.6:3000", true},
		{"puerto distinto", "http://192.168.1.6:9999", "192.168.1.6:3000", false},
		{"host distinto", "http://evil.example", "192.168.1.6:3000", false},
		{"origin vacío", "", "192.168.1.6:3000", false},
		{"host vacío", "http://192.168.1.6:3000", "", false},
		{"scheme invalido", "ftp://192.168.1.6:3000", "192.168.1.6:3000", false},
		{"malformed", "://bad", "192.168.1.6:3000", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := originHostMatchesRequest(c.origin, c.requestHost)
			if got != c.want {
				t.Fatalf("origin=%q host=%q got=%v want=%v", c.origin, c.requestHost, got, c.want)
			}
		})
	}
}

func TestResolveOrigin_PrecedenciaDeReglas(t *testing.T) {
	// Política base rechaza todo salvo "http://ok.example".
	h := &BridgeRelayHandler{originAllowed: func(o string) bool {
		return o == "http://ok.example"
	}}

	cases := []struct {
		name    string
		origin  string
		host    string
		allowed bool
	}{
		{"same-origin (sin header)", "", "192.168.1.6:3000", true},
		{"same-host", "http://192.168.1.6:3000", "192.168.1.6:3000", true},
		{"cors ok", "http://ok.example", "192.168.1.6:3000", true},
		{"rechazado", "http://evil.example", "192.168.1.6:3000", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			allowed, _ := h.resolveOrigin(c.origin, c.host)
			if allowed != c.allowed {
				t.Fatalf("origin=%q host=%q allowed=%v want=%v", c.origin, c.host, allowed, c.allowed)
			}
		})
	}
}

// Integración: el relay WS acepta a un cliente que viene con Origin apuntando
// al mismo host que el server test (simula el celular en LAN).
func TestRelay_SameHostOriginEsAceptado(t *testing.T) {
	hub := bridgerelay.NewHub(nil)
	// Política ESTRICTA que rechaza todo, para forzar que la aceptación
	// venga sólo por la regla same-host.
	h := NewBridgeRelayHandler(hub, bridgerelay.ParseTokens("CAJA-01:good"), nil,
		func(string) bool { return false })
	defer hub.Shutdown(nil)
	srv := httptest.NewServer(buildRouter(h, map[string]string{
		"userDni":  "1",
		"userName": "A",
		"role":     "admin",
	}))
	defer srv.Close()

	// Agente conectado (same-host, Origin vacío por default del dialer).
	ahdr := http.Header{}
	ahdr.Set("X-Bridge-Token", "good")
	ag, _, err := websocket.DefaultDialer.Dial(
		toWS(srv, "/api/bridge/agent")+"?caja_id=CAJA-01", ahdr)
	if err != nil {
		t.Fatalf("agent dial: %v", err)
	}
	defer ag.Close()
	deadline := time.Now().Add(2 * time.Second)
	for hub.AgentFor("CAJA-01") == nil {
		if time.Now().After(deadline) {
			t.Fatal("agente no registrado")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Emitir ticket.
	resp, _ := http.Post(srv.URL+"/api/bridge/ticket", "application/json",
		strings.NewReader(`{"cajaId":"CAJA-01"}`))
	var tr ticketResponse
	_ = json.NewDecoder(resp.Body).Decode(&tr)
	resp.Body.Close()

	// Dial con Origin que apunta al mismo host del server test (same-host).
	hostURL, _ := url.Parse(srv.URL)
	hdr := http.Header{}
	hdr.Set("Origin", "http://"+hostURL.Host)
	cli, _, err := websocket.DefaultDialer.Dial(
		toWS(srv, "/api/bridge/relay")+"?ticket="+tr.Ticket, hdr)
	if err != nil {
		t.Fatalf("se esperaba aceptación same-host, dial falló: %v", err)
	}
	defer cli.Close()
}
