// Normalizacion y parseo de dias de la semana para la agenda del proveedor.
//
// Vive fuera de React para poder probarse con `node --test` sin montar la UI
// y tambien para que el formulario y la tabla usen exactamente la misma
// logica: dos normalizaciones separadas fue lo que dejo salir a produccion el
// desajuste "Miercoles/Miércoles" en el guardado.
//
// Contrato:
//   - El nombre canonico es SIN TILDE ("Miercoles", "Sabado"). Asi es como se
//     guarda en la base y como lo consume el backend (que ademas es tolerante
//     a tildes en las comparaciones, ver supplier repository).
//   - Al mostrar al usuario se usan las formas con tilde ("Miércoles",
//     "Sábado") para no violentar la ortografia. Las conversiones estan en
//     `toDisplayDays` y `WEEKDAY_DISPLAY`.
//   - `parseSupplierDays` acepta tanto el arreglo nuevo (JSONB) como el CSV
//     legacy (columna visitDay/deliveryDay) y siempre devuelve una lista
//     canonica en orden natural de la semana, sin duplicados.

/** Nombres canonicos de los dias, en orden natural de la semana. Sin tilde. */
export const WEEKDAYS_CANONICAL = Object.freeze([
  'Lunes',
  'Martes',
  'Miercoles',
  'Jueves',
  'Viernes',
  'Sabado',
  'Domingo',
]);

/** Mapa canonico -> forma visual con tildes para pintar al usuario. */
export const WEEKDAY_DISPLAY = Object.freeze({
  Lunes: 'Lunes',
  Martes: 'Martes',
  Miercoles: 'Miércoles',
  Jueves: 'Jueves',
  Viernes: 'Viernes',
  Sabado: 'Sábado',
  Domingo: 'Domingo',
});

/** Iniciales de dos letras para chips y botones compactos. */
export const WEEKDAY_SHORT = Object.freeze({
  Lunes: 'LU',
  Martes: 'MA',
  Miercoles: 'MI',
  Jueves: 'JU',
  Viernes: 'VI',
  Sabado: 'SA',
  Domingo: 'DO',
});

const CANONICAL_INDEX = new Map(WEEKDAYS_CANONICAL.map((day, index) => [day, index]));

// Aliases posibles despues de quitar tildes y bajar a minusculas. Se mantiene
// como objeto plano en vez de generarse desde WEEKDAYS_CANONICAL para no
// esconder la lista de sinonimos aceptados a un lector rapido del archivo.
const ALIAS_TO_CANONICAL = Object.freeze({
  lunes: 'Lunes',
  martes: 'Martes',
  miercoles: 'Miercoles',
  jueves: 'Jueves',
  viernes: 'Viernes',
  sabado: 'Sabado',
  domingo: 'Domingo',
});

/**
 * Devuelve el nombre canonico (sin tilde) de un dia dado, o cadena vacia si
 * el valor no representa un dia de la semana. Tolera tildes, mayusculas y
 * espacios sobrantes. Cualquier basura devuelve ''.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeDayName(raw) {
  if (typeof raw !== 'string') return '';
  const clean = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
  if (!clean) return '';
  return ALIAS_TO_CANONICAL[clean] || '';
}

/**
 * Devuelve true cuando el valor normaliza a un dia canonico conocido.
 * Alias defensivo de `normalizeDayName(...) !== ''` para lecturas mas claras.
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isValidDayName(raw) {
  return normalizeDayName(raw) !== '';
}

/**
 * Parsea la agenda de un proveedor y devuelve una lista canonica, sin
 * duplicados, en orden natural de la semana.
 *
 * Acepta cualquiera de estas formas:
 *   - Objeto `{ days, csv }`  → prefiere `days`, cae a `csv` si `days` queda vacio.
 *   - Arreglo                 → equivalente a `{ days: arr }`.
 *   - String                  → equivalente a `{ csv: str }`.
 *   - null / undefined        → `[]`.
 *
 * Tolera items legacy dentro del arreglo que a su vez traigan CSV (por
 * migraciones antiguas que guardaron "Lunes, Miercoles" como un solo elemento).
 *
 * @param {{ days?: unknown, csv?: unknown } | Array<unknown> | string | null | undefined} input
 * @returns {string[]}
 */
export function parseSupplierDays(input) {
  let days;
  let csv;
  if (Array.isArray(input)) {
    days = input;
  } else if (typeof input === 'string') {
    csv = input;
  } else if (input && typeof input === 'object') {
    days = input.days;
    csv = input.csv;
  }
  const fromArray = collectDays(days);
  if (fromArray.length > 0) return fromArray;
  return collectDays(splitCsv(csv));
}

/**
 * Ordena la lista canonica en orden natural de la semana y elimina duplicados
 * y basura. Util cuando la lista se construyo interactivamente en la UI
 * (toggles) y se quiere dejar prolija antes de guardar o pintar.
 *
 * @param {unknown} days
 * @returns {string[]}
 */
export function sanitizeDayList(days) {
  return collectDays(days);
}

/**
 * Convierte una lista canonica a la forma visual con tildes para pintarla al
 * usuario. Items no reconocidos se descartan silenciosamente.
 * @param {string[]} days
 * @returns {string[]}
 */
export function toDisplayDays(days) {
  if (!Array.isArray(days)) return [];
  return days
    .map((day) => WEEKDAY_DISPLAY[day])
    .filter((value) => typeof value === 'string' && value.length > 0);
}

/**
 * Devuelve las iniciales de dos letras (LU, MA, MI...) listas para pintar en
 * chips y botones. Items no reconocidos se descartan.
 * @param {string[]} days
 * @returns {string[]}
 */
export function toShortDays(days) {
  if (!Array.isArray(days)) return [];
  return days
    .map((day) => WEEKDAY_SHORT[day])
    .filter((value) => typeof value === 'string' && value.length > 0);
}

/**
 * Formatea una lista canonica como cadena CSV lista para persistir en el
 * campo legacy `visitDay` / `deliveryDay`. Los dias se guardan SIN TILDE, en
 * consistencia con el arreglo canonico: el backend es tolerante a tildes en
 * lectura, mezclar formatos en escritura contamina la base sin motivo.
 * @param {string[]} days
 * @returns {string}
 */
export function toStorageCsv(days) {
  if (!Array.isArray(days)) return '';
  const filtered = days.filter((day) => CANONICAL_INDEX.has(day));
  return filtered.join(', ');
}

/**
 * Formatea una lista canonica como cadena legible con tildes, separada por
 * comas. Se usa para mostrarle al dueno lo que va a quedar guardado sin
 * violentar la ortografia. NO usar para escribir a la base.
 * @param {string[]} days
 * @returns {string}
 */
export function toDisplayLabel(days) {
  return toDisplayDays(days).join(', ');
}

/**
 * Compara dos listas canonicas como conjuntos (orden y duplicados
 * irrelevantes). Devuelve true cuando representan el mismo grupo de dias.
 * @param {string[]} left
 * @param {string[]} right
 * @returns {boolean}
 */
export function isSameDaySet(left, right) {
  const a = sanitizeDayList(left);
  const b = sanitizeDayList(right);
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  for (const day of b) if (!seen.has(day)) return false;
  return true;
}

// ---------- helpers internos ----------

function collectDays(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const collected = [];
  for (const item of list) {
    // Un item legacy puede traer "Lunes, Miercoles" dentro de un solo elemento
    // del arreglo (migraciones viejas). Explotamos por coma antes de normalizar.
    if (typeof item !== 'string') continue;
    const pieces = item.includes(',') ? item.split(',') : [item];
    for (const piece of pieces) {
      const canonical = normalizeDayName(piece);
      if (!canonical) continue;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      collected.push(canonical);
    }
  }
  return sortByWeek(collected);
}

function splitCsv(value) {
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed.split(',');
}

function sortByWeek(days) {
  return days.slice().sort((left, right) => {
    const leftIndex = CANONICAL_INDEX.get(left);
    const rightIndex = CANONICAL_INDEX.get(right);
    // Los indices siempre existen porque `collectDays` filtra con
    // `normalizeDayName` antes de agregar; si por alguna razon faltara,
    // caemos a orden alfabetico como salvavidas defensivo.
    if (leftIndex === undefined || rightIndex === undefined) {
      return String(left).localeCompare(String(right), 'es');
    }
    return leftIndex - rightIndex;
  });
}
