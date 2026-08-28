package middlewares

import (
	"net"
	"net/url"
)

// IsPrivateOrigin acepta solicitudes sin Origin y orígenes HTTP(S) cuyo host
// sea localhost, loopback o una dirección privada real.
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
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}
