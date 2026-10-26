package middlewares

import (
	"net"
	"net/url"
)

// IsPrivateOrigin acepta solicitudes sin Origin y orígenes HTTP(S) cuyo host
// sea localhost, loopback, una dirección privada real o una dirección de
// Tailscale (rango CGNAT 100.64.0.0/10), que sólo es alcanzable por
// dispositivos de la misma red Tailscale.
func IsPrivateOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	hostname := parsed.Hostname()
	if hostname == "localhost" {
		return true
	}
	ip := net.ParseIP(hostname)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate() || tailscaleCGNAT.Contains(ip))
}

// tailscaleCGNAT es el rango que Tailscale asigna a los equipos de la red.
var tailscaleCGNAT = func() *net.IPNet {
	_, n, _ := net.ParseCIDR("100.64.0.0/10")
	return n
}()
