package scheduling

// ============================================================================
// APRENDIZAJE PASIVO DE LA AGENDA DEL PROVEEDOR
// ============================================================================
//
// Este archivo implementa la etapa de "aprendizaje" del Sprint 9: mirando el
// historico reciente, deducir en que dias de la semana suele venir el
// preventista a tomar el pedido y en que dias suele llegar la mercancia.
//
// REGLA DE ORO
// ----------------------------------------------------------------------------
// Este paquete es PURO. No consulta la base de datos, no lee relojes globales,
// no depende del entorno. El caller (RestockNightlyService) es quien carga las
// observaciones y persiste el resultado en las columnas learned_* que agrego
// la migracion 014.
//
// La agenda aprendida convive con la que el dueno escribio a mano
// (visit_days / delivery_days). El sistema JAMAS sobreescribe las columnas
// manuales; solo llena las columnas learned_*. Esa restriccion viene explicita
// del dueno y ya lo quemamos una vez sobreescribiendo visit_frequency_days.
//
// ORIGEN DE LOS DATOS — CORRECCION DE AGOSTO 2026
// ----------------------------------------------------------------------------
// El dueno corrigio la fuente del dia de entrega:
//
//   "no te puedes guiar con la recepcion, te tienes que guiar con el egreso,
//    porque yo no siempre hago la recepcion el mismo dia, pueden pasar dias
//    hasta que haga la recepcion y actualice el dato, cuando si o si se
//    tiene que hacer el egreso el mismo dia que llego"
//
// Antes se aprendia de pares (confirmed_at, received_at) de confirmed_orders
// y se sacaba lead time por mediana. Los dos problemas:
//
//   1) received_at NO es confiable. El operador puede registrar la recepcion
//      dias despues; ese dato refleja "cuando toco confirmar la recepcion en
//      el sistema", no "cuando llego la mercancia".
//   2) El unico evento que si ocurre el mismo dia que llega la mercancia es
//      el EGRESO al proveedor (expenses.date con category='Proveedores' y
//      supplier_id NOT NULL). Ver postgres_product_inventory.go, donde el
//      flujo de recepcion crea el egreso con Date=time.Now() y esa fecha
//      es el ancla real.
//
// Por eso este archivo consume ahora DOS series independientes:
//
//   - Visits:     confirmed_orders.confirmed_at (el dueno no objeto esta
//                 fuente; el confirmed_at es el momento en que se cerro el
//                 pedido con el preventista).
//   - Deliveries: expenses.date filtrando category='Proveedores',
//                 supplier_id NOT NULL, deleted_at IS NULL.
//
// LEAD TIME
// ----------------------------------------------------------------------------
// La mediana emparejada (received_at - confirmed_at) queda ELIMINADA. No se
// intenta emparejar cada egreso con su pedido: expenses.reference_id apunta a
// la RECEPCION (RECP-...), no al confirmed_order que la origino, asi que el
// emparejamiento es fragil y contaminaria el resultado.
//
// En vez de eso: se aprenden los dos CONJUNTOS de dias por separado y el lead
// time se deriva con PlanSupplierOrderSchedule, la funcion pura que ya calcula
// la distancia calendario de la proxima visita a la proxima entrega dentro de
// la semana. Es determinista y consistente con el lead time que ya se muestra
// al frontend cuando el dueno configura la agenda a mano.
//
// UMBRALES — POR QUE SIGUEN IGUAL
// ----------------------------------------------------------------------------
// Los umbrales (ventana 90 dias, minimo 4 muestras por set, dia habitual con
// >=25% y >=2 conteos absolutos) NO cambian con la nueva fuente. Un
// supermercado de barrio recibe entre 1 y 4 pedidos por proveedor al mes;
// cada uno produce un egreso registrado y (cuando hay preventista) un
// confirmed_order. La densidad de muestras es comparable — de hecho puede
// ser MAYOR en egresos, porque hay proveedores que pagan al contado sin
// pasar por preventista y esos casos si generan egreso pero no confirmado.
// El umbral de 4 sigue siendo prudente para descartar coincidencias.
//
// La constante LearnMaxLeadTimeDays queda ELIMINADA porque ya no se calculan
// lead times por observacion.
//
// PROVEEDOR CON EGRESOS PERO SIN PEDIDOS CONFIRMADOS
// ----------------------------------------------------------------------------
// Este es el caso "pago al contado directo al preventista, sin capturar la
// visita en el sistema". Decision: SI aprende — con solo DeliveryDays y sin
// VisitDays. HasLearned=true. LeadTimeDays=0 porque no se puede derivar sin
// dias de visita. Es informacion parcial pero util: la UI puede mostrar "el
// sistema ve que la mercancia te llega los martes" aunque no sepa que dia
// viene el preventista. Es preferible a botar la observacion.
//
// Simetricamente: proveedor con confirmed_orders pero sin egresos (caso raro,
// implicaria que el operador nunca registra el pago) tambien aprende, solo
// VisitDays. Igual criterio.

import (
	"time"
)

// Umbrales de aprendizaje. Se exponen como constantes para que sean visibles
// desde los tests y desde comentarios en otros paquetes.
const (
	// LearnLookbackDays es la ventana de historia que se mira hacia atras.
	// 90 dias son ~3-12 muestras por proveedor: suficientes para ver un
	// patron sin arrastrar historia rancia. Mirar dos anos hacia atras seria
	// peor que no aprender, porque los proveedores cambian de ruta cada
	// tanto: "los martes" de hace un ano puede ya no ser cierto.
	LearnLookbackDays = 90

	// LearnMinSamples es el minimo de observaciones validas (post-filtro)
	// que debe alcanzar CADA set independientemente para que el sistema
	// deduzca dias habituales de ese set. Con 4 muestras concentradas hay
	// senal; con menos, es coincidencia.
	LearnMinSamples = 4

	// LearnHabitualRatio es la proporcion minima del total (dentro de un
	// set) que un dia debe alcanzar para considerarse habitual.
	LearnHabitualRatio = 0.25

	// LearnMinDayCount es el conteo absoluto minimo por dia para
	// considerarlo habitual. Se combina con LearnHabitualRatio: un dia
	// habitual necesita ambas condiciones simultaneas para no dejar entrar
	// excepciones. Ejemplo: proveedor viene 9 veces en martes y 1 vez en
	// jueves. El jueves solo tiene 1 conteo, no aparece como habitual.
	LearnMinDayCount = 2
)

// SupplierVisitObservation es un evento "el preventista cerro un pedido con
// este proveedor". Fuente: confirmed_orders.confirmed_at.
type SupplierVisitObservation struct {
	ConfirmedAt time.Time
}

// SupplierDeliveryObservation es un evento "el dueno registro un egreso a
// este proveedor". Fuente: expenses.date, filtrando category='Proveedores',
// supplier_id NOT NULL y deleted_at IS NULL.
//
// La regla del dueno (agosto 2026) es que el egreso se hace SI O SI el mismo
// dia que llega la mercancia; por eso PaidAt se toma como sinonimo de "dia
// en que llego el pedido".
type SupplierDeliveryObservation struct {
	PaidAt time.Time
}

// LearnedSchedule es la salida de LearnSupplierSchedule.
//
// HasLearned = false significa "no hay evidencia suficiente en NINGUN set".
// En ese caso los demas campos NO son significativos y no deben persistirse
// como si fueran datos reales; el caller debe dejar las columnas learned_*
// en NULL y sample_count = 0.
//
// Cuando HasLearned = true, cada set puede estar vacio si el set
// correspondiente no tuvo evidencia suficiente. Es decir:
//
//   - Puede haber VisitDays sin DeliveryDays (o al reves) si el proveedor
//     tiene solo un flujo capturado. Ver comentario "PROVEEDOR CON EGRESOS
//     PERO SIN PEDIDOS CONFIRMADOS" arriba.
//   - LeadTimeDays solo se computa cuando AMBAS listas tienen contenido; en
//     otro caso queda en 0.
//   - SampleCount refleja la evidencia del set que respalda el aprendizaje:
//     si solo hay entregas, es el conteo de entregas validas; si solo hay
//     visitas, el de visitas; si hay ambos, el minimo de los dos (el
//     "eslabon debil" que decide la confianza).
//
// Los nombres son canonicos ("Lunes", "Martes", ..., "Miércoles", "Sábado")
// en orden natural de la semana (Lunes -> Domingo).
type LearnedSchedule struct {
	HasLearned   bool
	VisitDays    []string
	DeliveryDays []string
	LeadTimeDays int
	SampleCount  int
}

// LearnSupplierSchedule deduce la agenda observada del proveedor a partir de
// dos series independientes.
//
// Contrato:
//   - visits: observaciones de confirmed_orders (dia en que vino el
//     preventista y se cerro el pedido).
//   - deliveries: observaciones de expenses category='Proveedores' (dia en
//     que llego la mercancia, por la regla del dueno). Los egresos con
//     supplier_id nulo, borrados logicamente o fuera de la ventana los
//     descarta el REPO en la SQL; aqui adicionalmente se descartan fuera de
//     ventana por si el caller no filtro.
//   - reference: "ahora" en la zona horaria del negocio. En produccion se
//     pasa time.Now().In(America/Bogota); en tests se pasa una fecha fija.
//   - Ventana: reference - LearnLookbackDays. Cualquier observacion anterior
//     se descarta.
//   - Cada set se evalua por separado:
//     (a) Si el set tiene menos de LearnMinSamples observaciones validas
//     dentro de la ventana, ese set queda vacio.
//     (b) Un dia es habitual si simultaneamente:
//     count >= LearnMinDayCount
//     count/total >= LearnHabitualRatio
//   - HasLearned = true si al menos uno de los dos sets produjo dias
//     habituales.
//   - LeadTimeDays: se deriva con PlanSupplierOrderSchedule aplicado a las
//     dos listas aprendidas y la fecha reference. Si alguna lista queda
//     vacia, LeadTimeDays = 0. Ver justificacion "LEAD TIME" arriba.
func LearnSupplierSchedule(
	visits []SupplierVisitObservation,
	deliveries []SupplierDeliveryObservation,
	reference time.Time,
) LearnedSchedule {
	windowStart := reference.AddDate(0, 0, -LearnLookbackDays)

	visitDays, visitValid := countWeekdaysInWindow(
		visits, windowStart, func(o SupplierVisitObservation) time.Time { return o.ConfirmedAt },
	)
	deliveryDays, deliveryValid := countWeekdaysInWindow(
		deliveries, windowStart, func(o SupplierDeliveryObservation) time.Time { return o.PaidAt },
	)

	// Cada set puede aprender o no de forma independiente.
	var visitLearned, deliveryLearned []string
	if visitValid >= LearnMinSamples {
		visitLearned = habitualWeekdays(visitDays, visitValid)
	}
	if deliveryValid >= LearnMinSamples {
		deliveryLearned = habitualWeekdays(deliveryDays, deliveryValid)
	}

	if len(visitLearned) == 0 && len(deliveryLearned) == 0 {
		// Ninguno de los dos sets produjo evidencia utilizable. No inventar.
		return LearnedSchedule{}
	}

	// Lead time derivado de la agenda aprendida. PlanSupplierOrderSchedule ya
	// tolera nombres canonicos y devuelve HasSchedule=false si falta uno de
	// los dos sets; en ese caso dejamos LeadTimeDays=0.
	leadTime := 0
	if len(visitLearned) > 0 && len(deliveryLearned) > 0 {
		sched := PlanSupplierOrderSchedule(visitLearned, deliveryLearned, reference)
		if sched.HasSchedule {
			leadTime = sched.LeadTimeDays
		}
	}

	// SampleCount: el eslabon debil. Si solo hay un set, cuenta ese set. Si
	// hay ambos, el minimo de los dos — es el "N pedidos que respaldan" que
	// ve el operador y quiere ser conservador.
	sampleCount := 0
	switch {
	case len(visitLearned) > 0 && len(deliveryLearned) > 0:
		if visitValid < deliveryValid {
			sampleCount = visitValid
		} else {
			sampleCount = deliveryValid
		}
	case len(deliveryLearned) > 0:
		sampleCount = deliveryValid
	case len(visitLearned) > 0:
		sampleCount = visitValid
	}

	return LearnedSchedule{
		HasLearned:   true,
		VisitDays:    visitLearned,
		DeliveryDays: deliveryLearned,
		LeadTimeDays: leadTime,
		SampleCount:  sampleCount,
	}
}

// countWeekdaysInWindow itera una serie y produce el histograma de weekdays
// filtrando por la ventana de historia. Es generica sobre el tipo de
// observacion para que la logica de conteo sea unica y este cubierta por
// tests desde ambos frentes.
func countWeekdaysInWindow[T any](
	observations []T,
	windowStart time.Time,
	extract func(T) time.Time,
) (map[time.Weekday]int, int) {
	counts := make(map[time.Weekday]int, 7)
	valid := 0
	for _, obs := range observations {
		at := extract(obs)
		if at.IsZero() {
			continue
		}
		if at.Before(windowStart) {
			continue
		}
		counts[at.Weekday()]++
		valid++
	}
	return counts, valid
}

// habitualWeekdays selecciona los dias de la semana que superan
// simultaneamente la proporcion (LearnHabitualRatio) y el conteo minimo
// (LearnMinDayCount). Devuelve los labels canonicos en orden natural
// (Lunes -> Domingo).
func habitualWeekdays(counts map[time.Weekday]int, total int) []string {
	if total == 0 {
		return nil
	}
	// Iterar en orden natural comenzando por lunes para que el resultado sea
	// determinista y facil de leer. El domingo va al final porque en la
	// semana comercial local funciona asi.
	order := []time.Weekday{
		time.Monday, time.Tuesday, time.Wednesday, time.Thursday,
		time.Friday, time.Saturday, time.Sunday,
	}
	out := make([]string, 0, 7)
	for _, weekday := range order {
		count := counts[weekday]
		if count < LearnMinDayCount {
			continue
		}
		if float64(count)/float64(total) < LearnHabitualRatio {
			continue
		}
		out = append(out, WeekdayLabels[weekday])
	}
	return out
}
