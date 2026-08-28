package middlewares

import "testing"

func TestIsPrivateOrigin(t *testing.T) {
	tests := []struct {
		name   string
		origin string
		want   bool
	}{
		{name: "same origin without header", origin: "", want: true},
		{name: "localhost", origin: "http://localhost:9002", want: true},
		{name: "ipv4 loopback", origin: "http://127.0.0.1:3000", want: true},
		{name: "ipv6 loopback", origin: "http://[::1]:3000", want: true},
		{name: "private 10", origin: "https://10.20.30.40:9002", want: true},
		{name: "private 172 lower", origin: "http://172.16.0.2", want: true},
		{name: "private 172 upper", origin: "http://172.31.255.254", want: true},
		{name: "private 192", origin: "http://192.168.1.21:3000", want: true},
		{name: "public 172 below range", origin: "http://172.15.1.2", want: false},
		{name: "public 172 above range", origin: "http://172.32.1.2", want: false},
		{name: "public address", origin: "https://8.8.8.8", want: false},
		{name: "localhost suffix attack", origin: "https://localhost.attacker.example", want: false},
		{name: "userinfo attack", origin: "http://localhost@attacker.example", want: false},
		{name: "unsupported scheme", origin: "ftp://192.168.1.6", want: false},
		{name: "origin with path", origin: "http://192.168.1.6/admin", want: false},
		{name: "malformed", origin: "://bad", want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := IsPrivateOrigin(test.origin); got != test.want {
				t.Fatalf("IsPrivateOrigin(%q) = %v, want %v", test.origin, got, test.want)
			}
		})
	}
}
