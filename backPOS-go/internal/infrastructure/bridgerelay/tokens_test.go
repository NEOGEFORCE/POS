package bridgerelay

import "testing"

func TestParseTokens(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want map[string]string
	}{
		{name: "vacío devuelve nil", raw: "", want: nil},
		{name: "sólo espacios devuelve nil", raw: "   ", want: nil},
		{
			name: "par simple",
			raw:  "CAJA-01:tok1",
			want: map[string]string{"CAJA-01": "tok1"},
		},
		{
			name: "espacios alrededor",
			raw:  "  CAJA-01 : tok1 , CAJA-02 : tok2 ",
			want: map[string]string{"CAJA-01": "tok1", "CAJA-02": "tok2"},
		},
		{
			name: "ignora entradas malformadas",
			raw:  "CAJA-01:tok1,sin-colon,otra:,:huerfano,CAJA-02:tok2",
			want: map[string]string{"CAJA-01": "tok1", "CAJA-02": "tok2"},
		},
		{
			name: "duplicado conserva primero",
			raw:  "CAJA-01:tok1,CAJA-01:tok2",
			want: map[string]string{"CAJA-01": "tok1"},
		},
		{
			name: "token con dos puntos interpreta prefijo como caja",
			raw:  "CAJA-01:tok:con:dospuntos",
			want: map[string]string{"CAJA-01": "tok:con:dospuntos"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseTokens(tc.raw)
			if tc.want == nil {
				if got != nil {
					t.Fatalf("want nil, got %v", got)
				}
				return
			}
			if len(got) != len(tc.want) {
				t.Fatalf("want len=%d, got len=%d (%v)", len(tc.want), len(got), got)
			}
			for k, v := range tc.want {
				if got[k] != v {
					t.Fatalf("want %q=%q, got %q", k, v, got[k])
				}
			}
		})
	}
}

func TestTokenMap_Verify(t *testing.T) {
	tm := ParseTokens("CAJA-01:tokA,CAJA-02:tokB")
	if !tm.Verify("CAJA-01", "tokA") {
		t.Fatal("verify exacto debería pasar")
	}
	if tm.Verify("CAJA-01", "tokB") {
		t.Fatal("verify con token cruzado no debe pasar")
	}
	if tm.Verify("CAJA-XX", "tokA") {
		t.Fatal("verify con caja desconocida no debe pasar")
	}
	if tm.Verify("CAJA-01", "") {
		t.Fatal("verify con token vacío no debe pasar")
	}

	var nilMap TokenMap
	if nilMap.Verify("CAJA-01", "x") {
		t.Fatal("verify sobre mapa nil debe devolver falso")
	}
}

func TestTokenMap_Cajas(t *testing.T) {
	tm := ParseTokens("CAJA-01:x,CAJA-02:y")
	cajas := tm.Cajas()
	if len(cajas) != 2 {
		t.Fatalf("want 2 cajas, got %v", cajas)
	}
	// La función no promete orden, sólo que las dos aparezcan.
	seen := map[string]bool{}
	for _, c := range cajas {
		seen[c] = true
	}
	if !seen["CAJA-01"] || !seen["CAJA-02"] {
		t.Fatalf("faltan cajas en %v", cajas)
	}

	var nilMap TokenMap
	if nilMap.Cajas() != nil {
		t.Fatal("Cajas sobre nil debe devolver nil")
	}
}
