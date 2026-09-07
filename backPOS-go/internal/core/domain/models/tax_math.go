package models

import "math"

// =============================================================
// Matemática de impuestos de compra: IVA, ICUI e IBUA.
//
// FUENTE ÚNICA. Antes esta cuenta estaba escrita cuatro veces con DOS fórmulas
// distintas:
//
//	aditiva        base * (1 + iva/100 + icui/100 + ibua/100)
//	multiplicativa base * (1+iva/100) * (1+icui/100) * (1+ibua/100)
//
// Con un solo impuesto dan idéntico, así que la diferencia pasó desapercibida.
// Con IVA 19% + IBUA 10% dan 1,290 contra 1,309: casi 1,5% de separación sobre
// el costo de cada bebida. Es el mismo patrón que ya costó caro con las cinco
// fórmulas de ExpectedCash, y por eso vive acá una sola vez.
//
// LA CANÓNICA ES LA ADITIVA. Tres razones concretas, no preferencia estética:
//  1. Es la que muestra la pantalla de recepción al operador
//     (ReceptionRow.calculateGrossCost), o sea la cifra que él aprueba.
//  2. Es la que fija el test de negocio reception_discount_test.go, escrito
//     con los números reales del dueño.
//  3. Es la que ya usaban la recepción y la edición de recepción para armar la
//     cuenta por pagar al proveedor.
//
// El DESCUENTO del proveedor NO entra en esta matemática a propósito: por regla
// de negocio no rebaja el costo registrado, se traslada al PVP subiendo el
// margen. Ver reception_discount_test.go.
// =============================================================

// TaxRates son los porcentajes de impuesto de una línea de compra.
// Se expresan como porcentaje (19 significa 19%), nunca como fracción.
type TaxRates struct {
	IvaPct  float64
	IcuiPct float64
	IbuaPct float64
}

// TotalPct es la suma de los tres porcentajes.
func (t TaxRates) TotalPct() float64 {
	return t.IvaPct + t.IcuiPct + t.IbuaPct
}

// Factor es el multiplicador para pasar de costo neto a costo con impuestos.
// Nunca devuelve menos que 1: un porcentaje negativo sería un dato corrupto y
// no debe convertirse en un descuento silencioso.
func (t TaxRates) Factor() float64 {
	total := t.TotalPct()
	if total <= 0 {
		return 1
	}
	return 1 + total/100
}

// IsZero indica que la línea no tiene impuestos.
func (t TaxRates) IsZero() bool {
	return t.TotalPct() <= 0
}

// GrossFromNet convierte el costo neto (base de factura) al costo con impuestos.
// Es el costo que se registra como PurchasePrice del producto y el que se le
// debe al proveedor.
func GrossFromNet(net float64, t TaxRates) float64 {
	return net * t.Factor()
}

// NetFromGross quita los impuestos de un precio que ya los incluye.
// Es la inversa exacta de GrossFromNet: aplicarlas en cadena devuelve el valor
// original, cosa que la mezcla de fórmula aditiva y multiplicativa no cumplía.
func NetFromGross(gross float64, t TaxRates) float64 {
	f := t.Factor()
	if f == 0 {
		return gross
	}
	return gross / f
}

// TaxAmounts descompone los impuestos de una línea en montos absolutos, cada
// uno calculado sobre la base neta. La suma de los tres más la base es
// exactamente GrossFromNet, sin residuos de redondeo.
func TaxAmounts(net float64, t TaxRates) (iva, icui, ibua float64) {
	return net * t.IvaPct / 100,
		net * t.IcuiPct / 100,
		net * t.IbuaPct / 100
}

// RatesFromAmounts reconstruye los porcentajes a partir de los montos absolutos
// y la base neta.
//
// Existe para las rutas antiguas que sólo reciben montos: products.iva guarda
// un PORCENTAJE, y meterle un monto ahí hacía que la facturación electrónica
// declarara "190%" de IVA cuando el monto era $190.
//
// Con base <= 0 no hay porcentaje deducible y devuelve ceros: preferimos perder
// el dato antes que inventar una tasa.
func RatesFromAmounts(net, ivaAmount, icuiAmount, ibuaAmount float64) TaxRates {
	if net <= 0 {
		return TaxRates{}
	}
	round := func(v float64) float64 { return math.Round(v*10000) / 10000 }
	return TaxRates{
		IvaPct:  round(ivaAmount / net * 100),
		IcuiPct: round(icuiAmount / net * 100),
		IbuaPct: round(ibuaAmount / net * 100),
	}
}
