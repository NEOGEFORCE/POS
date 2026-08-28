package services

import (
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// PROXIMA VISITA DEL PROVEEDOR
// ============================================================================
//
// El aviso de "proximo pedido" se calculaba restando los dias transcurridos
// desde la ultima recepcion de UN producto a la frecuencia de visita. Eso daba
// cifras sin sentido cuando el producto llevaba semanas sin recibirse.
//
// Aqui se usa el dato real: los dias de visita del proveedor, que el sistema
// aprende automaticamente al registrar pedidos. Si no hay ninguno, se informa
// que no esta registrado en vez de inventar un numero.
// ============================================================================

var visitWeekdayByName = map[string]time.Weekday{
	"domingo":   time.Sunday,
	"lunes":     time.Monday,
	"martes":    time.Tuesday,
	"miercoles": time.Wednesday,
	"jueves":    time.Thursday,
	"viernes":   time.Friday,
	"sabado":    time.Saturday,
}

var visitWeekdayLabels = map[time.Weekday]string{
	time.Sunday:    "Domingo",
	time.Monday:    "Lunes",
	time.Tuesday:   "Martes",
	time.Wednesday: "Miércoles",
	time.Thursday:  "Jueves",
	time.Friday:    "Viernes",
	time.Saturday:  "Sábado",
}

func normalizeWeekdayName(value string) string {
	replacer := strings.NewReplacer(
		"á", "a", "é", "e", "í", "i", "ó", "o", "ú", "u", "ü", "u",
		"Á", "a", "É", "e", "Í", "i", "Ó", "o", "Ú", "u", "Ü", "u",
	)
	return strings.TrimSpace(strings.ToLower(replacer.Replace(value)))
}

// supplierVisitWeekdays reune los dias de visita configurados o aprendidos.
func supplierVisitWeekdays(supplier models.Supplier) []time.Weekday {
	appendNonEmpty := func(target []string, values ...string) []string {
		for _, value := range values {
			if strings.TrimSpace(value) != "" {
				target = append(target, value)
			}
		}
		return target
	}

	raw := make([]string, 0, len(supplier.VisitDays)+len(supplier.DeliveryDays)+1)
	raw = appendNonEmpty(raw, supplier.VisitDays...)
	if len(raw) == 0 {
		// Compatibilidad con el campo antiguo, que podia venir como CSV.
		raw = appendNonEmpty(raw, strings.Split(supplier.VisitDay, ",")...)
	}
	if len(raw) == 0 {
		raw = appendNonEmpty(raw, supplier.DeliveryDays...)
	}

	seen := make(map[time.Weekday]struct{}, len(raw))
	days := make([]time.Weekday, 0, len(raw))
	for _, item := range raw {
		weekday, ok := visitWeekdayByName[normalizeWeekdayName(item)]
		if !ok {
			continue
		}
		if _, exists := seen[weekday]; exists {
			continue
		}
		seen[weekday] = struct{}{}
		days = append(days, weekday)
	}
	return days
}

// NextSupplierVisit indica cuando vuelve el proveedor. Devuelve el nombre del
// dia, cuantos dias faltan y si el dato existe.
func NextSupplierVisit(supplier models.Supplier, reference time.Time) (string, int, bool) {
	days := supplierVisitWeekdays(supplier)
	if len(days) == 0 {
		return "", 0, false
	}

	today := reference.Weekday()
	best := 8
	var bestWeekday time.Weekday
	for _, weekday := range days {
		offset := (int(weekday) - int(today) + 7) % 7
		if offset == 0 {
			offset = 7 // ya paso hoy: la proxima es la semana siguiente
		}
		if offset < best {
			best = offset
			bestWeekday = weekday
		}
	}
	if best > 7 {
		return "", 0, false
	}
	return visitWeekdayLabels[bestWeekday], best, true
}

// describeNextSupplierVisit genera el texto listo para la alerta.
func describeNextSupplierVisit(supplier models.Supplier) string {
	label, days, ok := NextSupplierVisit(supplier, time.Now().In(bogotaLocation))
	if !ok {
		return "⏳ *Próxima visita:* sin día registrado para este proveedor"
	}
	if days == 1 {
		return "⏳ *Próxima visita:* " + label + " (mañana)"
	}
	return "⏳ *Próxima visita:* " + label + " (en " + itoa(days) + " días)"
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}
