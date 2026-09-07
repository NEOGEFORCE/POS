// Package scheduling contiene funciones puras de negocio que resuelven la
// agenda de pedidos de cada proveedor a partir de los DIAS DE LA SEMANA que
// el dueno del negocio configuro (VisitDays y DeliveryDays).
//
// Vive en su propio paquete para que pueda ser consumido tanto por los
// servicios como por los adapters de persistencia sin crear un ciclo de
// importacion: el servicio nocturno de restock ya importa el repositorio, asi
// que el repositorio no puede importar al servicio, pero si puede importar
// esta capa pura.
//
// Es un paquete SIN dependencias externas (solo `time` y `strings`): todo lo
// que expone es determinista y testeable con tabla de casos.
package scheduling

import (
	"strings"
	"time"
)

// ============================================================================
// AGENDA DE PEDIDOS DEL PROVEEDOR
// ============================================================================
//
// El dueno configura para cada proveedor los dias en que:
//   - visita al negocio para tomar el pedido (VisitDays)
//   - hace la entrega de la mercancia (DeliveryDays)
//
// A partir de esos dos datos y la fecha de hoy se calcula:
//   - La proxima fecha de visita (cuando se puede pasar el pedido).
//   - La proxima fecha de entrega (cuando la mercancia llega).
//   - Los dias de lead time (diferencia entre esas dos fechas).
//   - Los dias que faltan hasta la proxima visita.
//
// Antes esto salia de "visit_frequency_days", una columna que el sistema
// APRENDE y sobreescribe automaticamente segun la separacion observada entre
// recepciones (postgres_product_inventory.go y postgres_product_repository.go
// hacen Update("visit_frequency_days", days)). Ese aprendizaje se inflaba
// cuando habia semanas sin recepciones y las fechas propuestas quedaban
// demasiado lejos.
// ============================================================================

// weekdayByName mapea la forma normalizada (minusculas, sin tildes, sin
// espacios) al time.Weekday correspondiente. La normalizacion es tolerante
// porque el dato lo escribe una persona: "MIÉRCOLES", "miercoles", " Miércoles"
// deben resolverse todos al mismo dia.
var weekdayByName = map[string]time.Weekday{
	"domingo":   time.Sunday,
	"lunes":     time.Monday,
	"martes":    time.Tuesday,
	"miercoles": time.Wednesday,
	"jueves":    time.Thursday,
	"viernes":   time.Friday,
	"sabado":    time.Saturday,
}

// WeekdayLabels es la convencion CANONICA de nombres de dia en el sistema
// (con tildes, capitalizados). Coincide con el mapa definido en
// internal/adapters/jobs/cron_jobs.go, que es el que el resto del proyecto
// usa cuando notifica al operador por Telegram. Se expone aca para que otros
// paquetes puedan reutilizarla sin duplicar.
var WeekdayLabels = map[time.Weekday]string{
	time.Sunday:    "Domingo",
	time.Monday:    "Lunes",
	time.Tuesday:   "Martes",
	time.Wednesday: "Miércoles",
	time.Thursday:  "Jueves",
	time.Friday:    "Viernes",
	time.Saturday:  "Sábado",
}

// NormalizeWeekdayName aplica la normalizacion tolerante: minusculas, quita
// tildes (agudas, diereses) y espacios. Un valor no reconocido queda como
// una cadena arbitraria; el llamador decide si lo descarta.
func NormalizeWeekdayName(value string) string {
	replacer := strings.NewReplacer(
		"á", "a", "é", "e", "í", "i", "ó", "o", "ú", "u", "ü", "u",
		"Á", "a", "É", "e", "Í", "i", "Ó", "o", "Ú", "u", "Ü", "u",
	)
	return strings.TrimSpace(strings.ToLower(replacer.Replace(value)))
}

// ParseWeekdayName resuelve un nombre a su time.Weekday si es valido. Devuelve
// (weekday, true) si se reconoce.
func ParseWeekdayName(value string) (time.Weekday, bool) {
	weekday, ok := weekdayByName[NormalizeWeekdayName(value)]
	return weekday, ok
}

// SupplierSchedule es la salida de PlanSupplierOrderSchedule.
//
// Cuando HasSchedule es false los demas campos NO son significativos: el
// consumidor debe caer al lead_time_days explicito, luego al aprendizaje de
// visit_frequency_days y por ultimo al fallback de 7 dias.
type SupplierSchedule struct {
	HasSchedule        bool
	NextVisitDate      time.Time
	NextDeliveryDate   time.Time
	LeadTimeDays       int
	DaysUntilNextVisit int
}

// LeadTimeSource etiqueta de donde salio el lead time que se expone al
// frontend. Es util para que la UI pueda decir "segun los dias configurados"
// o advertir "este proveedor no tiene dias configurados".
//
// Precedencia efectiva (ver ResolveSupplierLeadTime):
//  1. configured_days           -> el dueno configuro dias a mano.
//  2. learned_days              -> el sistema observo lead time confiable.
//  3. explicit_lead_time        -> columna lead_time_days > 0.
//  4. visit_frequency_learned   -> visit_frequency_days (aprendido, sospechoso).
//  5. default                   -> ultimo recurso, 7 dias.
const (
	LeadTimeSourceConfiguredDays = "configured_days"
	LeadTimeSourceLearned        = "learned_days"
	LeadTimeSourceExplicit       = "explicit_lead_time"
	LeadTimeSourceVisitFrequency = "visit_frequency_learned"
	LeadTimeSourceDefault        = "default"
)

// parseWeekdaySet resuelve una lista de nombres a un set de time.Weekday.
// Acepta valores en minusculas/mayusculas, con o sin tildes. Los valores
// invalidos se ignoran silenciosamente. Tambien acepta CSV embebido para
// tolerar el campo legacy VisitDay que a veces trae "Lunes, Miercoles".
func parseWeekdaySet(days []string) map[time.Weekday]struct{} {
	set := make(map[time.Weekday]struct{}, len(days))
	for _, raw := range days {
		for _, part := range strings.Split(raw, ",") {
			trimmed := strings.TrimSpace(part)
			if trimmed == "" {
				continue
			}
			weekday, ok := weekdayByName[NormalizeWeekdayName(trimmed)]
			if !ok {
				continue
			}
			set[weekday] = struct{}{}
		}
	}
	return set
}

// PlanSupplierOrderSchedule calcula la agenda de pedidos del proveedor a
// partir de los dias configurados. Es una funcion pura: no consulta base de
// datos, no lee relojes globales, no depende del entorno.
//
// Contrato:
//   - visitDays y deliveryDays son los nombres de dia guardados en el modelo
//     Supplier (columnas visit_days / delivery_days sobre JSONB, o los
//     campos legacy visitDay / deliveryDay en CSV). Se normalizan con
//     tolerancia (mayusculas / tildes / CSV) usando la convencion canonica
//     del sistema.
//   - reference es la fecha de hoy. Se preserva su Location. En produccion
//     los llamadores le pasan `time.Now().In(America/Bogota)` para respetar
//     la zona horaria del resto del proyecto.
//   - Si falta al menos un dia valido en visita o en entrega, devuelve
//     HasSchedule=false; los demas campos quedan en su zero-value.
//   - Si hoy cae en un dia de visita, se toma HOY como la proxima visita
//     (DaysUntilNextVisit = 0). Esto es deliberado: el problema original era
//     que las fechas propuestas quedaban demasiado lejos. Si el operador ya
//     se perdio la visita de hoy, la mercancia igualmente aparecera en el
//     proximo dia de entrega valido (>= hoy).
//   - NextDeliveryDate es el primer dia de entrega >= NextVisitDate. Cuando
//     visita y entrega caen el mismo dia, LeadTimeDays = 0.
func PlanSupplierOrderSchedule(visitDays, deliveryDays []string, reference time.Time) SupplierSchedule {
	visitSet := parseWeekdaySet(visitDays)
	deliverySet := parseWeekdaySet(deliveryDays)

	if len(visitSet) == 0 || len(deliverySet) == 0 {
		return SupplierSchedule{}
	}

	startOfDay := time.Date(
		reference.Year(), reference.Month(), reference.Day(),
		0, 0, 0, 0, reference.Location(),
	)

	nextVisit, foundVisit := findNextWeekday(startOfDay, visitSet)
	if !foundVisit {
		return SupplierSchedule{}
	}
	nextDelivery, foundDelivery := findNextWeekday(nextVisit, deliverySet)
	if !foundDelivery {
		return SupplierSchedule{}
	}

	return SupplierSchedule{
		HasSchedule:        true,
		NextVisitDate:      nextVisit,
		NextDeliveryDate:   nextDelivery,
		LeadTimeDays:       daysBetween(nextVisit, nextDelivery),
		DaysUntilNextVisit: daysBetween(startOfDay, nextVisit),
	}
}

// findNextWeekday devuelve el primer dia (from o posterior) cuya weekday
// pertenezca al set. Busca en una ventana de 7 dias, que es suficiente porque
// el ciclo semanal se cierra.
func findNextWeekday(from time.Time, set map[time.Weekday]struct{}) (time.Time, bool) {
	for offset := 0; offset < 7; offset++ {
		candidate := from.AddDate(0, 0, offset)
		if _, ok := set[candidate.Weekday()]; ok {
			return candidate, true
		}
	}
	return time.Time{}, false
}

// daysBetween cuenta cuantos dias calendario hay entre dos fechas. Como
// startOfDay siempre esta truncado a las 00:00 en la misma Location, el
// resultado es exacto para America/Bogota (sin DST). Se redondea para
// tolerar zonas con DST si algun consumidor le pasa otra Location.
func daysBetween(from, to time.Time) int {
	hours := to.Sub(from).Hours()
	if hours < 0 {
		hours = -hours
	}
	return int(hours/24 + 0.5)
}

// ResolveSupplierLeadTime aplica el orden de precedencia acordado con el
// dueno para exponer el lead time al frontend:
//
//  1. Los dias de visita y entrega configurados por el dueno, si alcanzan
//     para calcularlo (SupplierSchedule.HasSchedule). SIEMPRE gana.
//  2. learned_lead_time_days si el batch nocturno aprendio con muestras
//     suficientes (el caller pasa nil cuando no hay confianza).
//  3. lead_time_days si esta puesto explicitamente (no NULL, no 0).
//  4. visit_frequency_days (aprendido por el sistema, sospechoso).
//  5. 7 dias como ultimo recurso.
//
// Devuelve el numero de dias y una etiqueta de origen (LeadTimeSource*) para
// que el frontend sepa si es un dato confiable o si debe advertir que faltan
// datos del proveedor.
//
// CONVENCION IMPORTANTE: learnedLeadTimeDays debe venir en nil cuando el
// caller detecte que no hay muestras suficientes (learned_sample_count == 0
// o LearnedSchedule.HasLearned == false). Esta funcion NO valida la
// confiabilidad, solo aplica precedencia. La verificacion se hace afuera para
// que este paquete pueda seguir siendo puro y determinista.
func ResolveSupplierLeadTime(
	schedule SupplierSchedule,
	learnedLeadTimeDays *int,
	explicitLeadTimeDays *int,
	visitFrequencyDays int,
) (int, string) {
	if schedule.HasSchedule {
		return schedule.LeadTimeDays, LeadTimeSourceConfiguredDays
	}
	if learnedLeadTimeDays != nil && *learnedLeadTimeDays > 0 {
		return *learnedLeadTimeDays, LeadTimeSourceLearned
	}
	if explicitLeadTimeDays != nil && *explicitLeadTimeDays > 0 {
		return *explicitLeadTimeDays, LeadTimeSourceExplicit
	}
	if visitFrequencyDays > 0 {
		return visitFrequencyDays, LeadTimeSourceVisitFrequency
	}
	return 7, LeadTimeSourceDefault
}
