package bridgerelay

import (
	"crypto/subtle"
	"strings"
)

// TokenMap mapea cajaId → token esperado del agente. Toda la comparación
// es sensible a mayúsculas (los cajaId y tokens se mantienen exactamente
// como aparecen en POS_AGENT_TOKENS); se asume que la configuración ya
// los normaliza. Un cajaId con cadena vacía o un token con cadena vacía
// nunca llega al mapa — ParseTokens los descarta.
type TokenMap map[string]string

// ParseTokens convierte el valor de la variable `POS_AGENT_TOKENS` en un
// mapa cajaId→token. Formato esperado:
//
//	"CAJA-01:tokenA,CAJA-02:tokenB"
//
// Se aceptan espacios alrededor de las comas, los pares y el separador
// `:`. Entradas malformadas, duplicadas (misma caja definida dos veces)
// o con token vacío se descartan silenciosamente para no fallar el
// arranque — la ausencia del agente se traduce luego en 503 cuando el
// endpoint reciba una solicitud real.
//
// Devuelve `nil` si la variable está vacía. Esa nil-ness es significativa:
// el handler `/api/bridge/agent` responde 503 cuando el mapa es nil (ver
// `BridgeRelayHandler.AgentWS`).
func ParseTokens(raw string) TokenMap {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}

	m := make(TokenMap)
	seen := make(map[string]struct{})
	for _, part := range strings.Split(trimmed, ",") {
		pair := strings.TrimSpace(part)
		if pair == "" {
			continue
		}
		idx := strings.Index(pair, ":")
		if idx <= 0 || idx == len(pair)-1 {
			continue
		}
		caja := strings.TrimSpace(pair[:idx])
		token := strings.TrimSpace(pair[idx+1:])
		if caja == "" || token == "" {
			continue
		}
		if _, dup := seen[caja]; dup {
			// Si la configuración define la misma caja dos veces, la primera
			// gana y la segunda se descarta. No se loguean los tokens.
			continue
		}
		seen[caja] = struct{}{}
		m[caja] = token
	}

	if len(m) == 0 {
		return nil
	}
	return m
}

// Verify compara el token suministrado por el agente contra el esperado
// para `cajaId` en tiempo constante. Devuelve false si:
//
//   - el mapa es nil (configuración ausente, pero esa decisión la toma el
//     handler, no esta función);
//   - el cajaId no está en el mapa;
//   - los tokens difieren.
//
// La comparación constante protege contra inferencias de temporización
// (un atacante no puede medir cuántos bytes coinciden). Nunca loguea el
// token.
func (m TokenMap) Verify(cajaId, token string) bool {
	if m == nil {
		return false
	}
	expected, ok := m[cajaId]
	if !ok {
		// Igual hacemos una comparación en tiempo constante contra una
		// cadena vacía del mismo tamaño para no revelar por timing si el
		// cajaId existía o no.
		dummy := strings.Repeat("x", len(token))
		subtle.ConstantTimeCompare([]byte(dummy), []byte(token))
		return false
	}
	if len(expected) != len(token) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(token)) == 1
}

// Cajas devuelve los cajaId configurados, ordenados por el orden
// arbitrario del mapa. Útil para pruebas y para `/api/bridge/agents`.
func (m TokenMap) Cajas() []string {
	if m == nil {
		return nil
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
