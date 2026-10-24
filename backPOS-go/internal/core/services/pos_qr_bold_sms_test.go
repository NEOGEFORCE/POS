package services

import "testing"

// SMS real de Bold (remitente 890412) para pagos recibidos por el QR.
const boldQRSMS = "BoldCF: Recibiste una transferencia QR Bold por valor de $300,00 en tu cuenta Bold terminada en *3097. 22/10/2026 02:40PM."

func TestBoldQRSMS_RealTextIsRecognizedAndParsed(t *testing.T) {
	if !isBoldQRTransferSMS(boldQRSMS) {
		t.Fatal("el SMS real de transferencia QR Bold debe reconocerse")
	}
	amount, ok := extractCOPFromMessage(boldQRSMS)
	if !ok || amount != 300 {
		t.Fatalf("monto = %d ok=%v, want 300", amount, ok)
	}
	multiline := "BoldCF: Recibiste una\ntransferencia QR Bold por valor\nde $200,00 en tu cuenta Bold terminada en *3097."
	if !isBoldQRTransferSMS(multiline) {
		t.Fatal("saltos de línea no deben impedir el reconocimiento")
	}
	if a, ok := extractCOPFromMessage(multiline); !ok || a != 200 {
		t.Fatalf("monto multilinea = %d ok=%v, want 200", a, ok)
	}
}

func TestBoldQRSMS_OtherSMSFromSenderAreIgnored(t *testing.T) {
	for _, msg := range []string{
		"BoldCF: Tu codigo de verificacion es 123456",
		"BoldCF: Realizaste un retiro por valor de $50.000,00",
		"BoldCF: Recibiste un pago con datafono por $10.000,00",
		"Recibiste $300 en Nequi",
	} {
		if isBoldQRTransferSMS(msg) {
			t.Errorf("no debe aceptarse como transferencia QR Bold: %q", msg)
		}
	}
}
