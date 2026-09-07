import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEEKDAYS_CANONICAL,
  WEEKDAY_DISPLAY,
  WEEKDAY_SHORT,
  isSameDaySet,
  isValidDayName,
  normalizeDayName,
  parseSupplierDays,
  sanitizeDayList,
  toDisplayDays,
  toDisplayLabel,
  toShortDays,
  toStorageCsv,
} from '../src/lib/supplier-days.mjs';

test('normalizeDayName acepta la forma con tilde y sin tilde y devuelve el canonico sin tilde', () => {
  assert.equal(normalizeDayName('Miércoles'), 'Miercoles');
  assert.equal(normalizeDayName('Miercoles'), 'Miercoles');
  assert.equal(normalizeDayName('Sábado'), 'Sabado');
  assert.equal(normalizeDayName('Sabado'), 'Sabado');
});

test('normalizeDayName tolera mayusculas, minusculas, mixtas y espacios sobrantes', () => {
  assert.equal(normalizeDayName('LUNES'), 'Lunes');
  assert.equal(normalizeDayName('  martes  '), 'Martes');
  assert.equal(normalizeDayName('DoMiNgO'), 'Domingo');
  assert.equal(normalizeDayName(' Jueves\t'), 'Jueves');
});

test('normalizeDayName devuelve cadena vacia para valores basura', () => {
  assert.equal(normalizeDayName(''), '');
  assert.equal(normalizeDayName('   '), '');
  assert.equal(normalizeDayName('Xunes'), '');
  assert.equal(normalizeDayName('lundes'), '');
  assert.equal(normalizeDayName(null), '');
  assert.equal(normalizeDayName(undefined), '');
  assert.equal(normalizeDayName(42), '');
  assert.equal(normalizeDayName({})[0], undefined); // objetos no coinciden
});

test('isValidDayName es un alias defensivo consistente con normalizeDayName', () => {
  assert.equal(isValidDayName('Miércoles'), true);
  assert.equal(isValidDayName('miercoles'), true);
  assert.equal(isValidDayName('sabadote'), false);
  assert.equal(isValidDayName(''), false);
  assert.equal(isValidDayName(null), false);
});

test('parseSupplierDays acepta arreglo canonico y lo devuelve en orden natural', () => {
  const parsed = parseSupplierDays({ days: ['Miercoles', 'Lunes', 'Viernes'] });
  assert.deepEqual(parsed, ['Lunes', 'Miercoles', 'Viernes']);
});

test('parseSupplierDays deduplica y descarta basura sin explotar', () => {
  const parsed = parseSupplierDays({
    days: ['Lunes', 'lunes', 'LUNES', 'Xunes', '', 'Miércoles', 'Miercoles'],
  });
  assert.deepEqual(parsed, ['Lunes', 'Miercoles']);
});

test('parseSupplierDays tolera items legacy con CSV embebido dentro del arreglo', () => {
  const parsed = parseSupplierDays({ days: ['Miercoles, Sabado', 'Lunes'] });
  assert.deepEqual(parsed, ['Lunes', 'Miercoles', 'Sabado']);
});

test('parseSupplierDays cae al CSV legacy cuando el arreglo esta vacio o no viene', () => {
  assert.deepEqual(
    parseSupplierDays({ days: [], csv: 'Miércoles, Sábado' }),
    ['Miercoles', 'Sabado'],
  );
  assert.deepEqual(
    parseSupplierDays({ csv: 'lunes,Jueves ,   VIERNES' }),
    ['Lunes', 'Jueves', 'Viernes'],
  );
});

test('parseSupplierDays prefiere el arreglo cuando trae al menos un dia valido', () => {
  // Aunque el CSV tenga mas dias, si el arreglo trae algo valido gana el arreglo.
  const parsed = parseSupplierDays({
    days: ['Lunes'],
    csv: 'Martes, Miercoles, Jueves',
  });
  assert.deepEqual(parsed, ['Lunes']);
});

test('parseSupplierDays cae al CSV si el arreglo solo trae basura', () => {
  const parsed = parseSupplierDays({
    days: ['Xunes', '', null, 42],
    csv: 'Lunes, Sabado',
  });
  assert.deepEqual(parsed, ['Lunes', 'Sabado']);
});

test('parseSupplierDays devuelve [] con entradas nulas, vacias o basura total', () => {
  assert.deepEqual(parseSupplierDays(null), []);
  assert.deepEqual(parseSupplierDays(undefined), []);
  assert.deepEqual(parseSupplierDays({}), []);
  assert.deepEqual(parseSupplierDays({ days: [] }), []);
  assert.deepEqual(parseSupplierDays({ days: [], csv: '' }), []);
  assert.deepEqual(parseSupplierDays({ days: ['Xunes', 42], csv: 'basura' }), []);
});

test('parseSupplierDays acepta directamente un arreglo o un string', () => {
  assert.deepEqual(parseSupplierDays(['Sábado', 'Lunes']), ['Lunes', 'Sabado']);
  assert.deepEqual(parseSupplierDays('Miércoles, Sábado'), ['Miercoles', 'Sabado']);
});

test('sanitizeDayList ordena, deduplica y limpia entradas de toggle interactivo', () => {
  const raw = ['Miercoles', 'Lunes', 'Miércoles', 'basura', ''];
  assert.deepEqual(sanitizeDayList(raw), ['Lunes', 'Miercoles']);
});

test('toDisplayDays convierte al formato con tildes para el usuario', () => {
  assert.deepEqual(
    toDisplayDays(['Lunes', 'Miercoles', 'Sabado']),
    ['Lunes', 'Miércoles', 'Sábado'],
  );
});

test('toShortDays devuelve las iniciales listas para chips', () => {
  assert.deepEqual(
    toShortDays(['Lunes', 'Miercoles', 'Sabado', 'Domingo']),
    ['LU', 'MI', 'SA', 'DO'],
  );
});

test('toStorageCsv conserva el formato sin tilde que ya usa la base', () => {
  // El backend acepta tildes en lectura pero mezclar formatos en escritura
  // ensuciaria la columna; guardamos siempre canonico sin tilde.
  assert.equal(toStorageCsv(['Miercoles', 'Sabado']), 'Miercoles, Sabado');
  assert.equal(toStorageCsv([]), '');
  assert.equal(toStorageCsv(['basura']), '');
});

test('toDisplayLabel arma la cadena visible con tildes y comas', () => {
  assert.equal(
    toDisplayLabel(['Lunes', 'Miercoles', 'Sabado']),
    'Lunes, Miércoles, Sábado',
  );
  assert.equal(toDisplayLabel([]), '');
});

test('isSameDaySet compara como conjuntos, ignorando orden y duplicados', () => {
  assert.equal(isSameDaySet(['Lunes', 'Miercoles'], ['Miercoles', 'Lunes']), true);
  assert.equal(isSameDaySet(['Lunes'], ['Lunes', 'Lunes']), true);
  assert.equal(isSameDaySet(['Lunes', 'Martes'], ['Miercoles', 'Lunes']), false);
  assert.equal(isSameDaySet([], []), true);
  assert.equal(isSameDaySet(['Miércoles'], ['Miercoles']), true);
});

test('constantes canonicas exponen los siete dias sin tildes en orden natural', () => {
  assert.deepEqual([...WEEKDAYS_CANONICAL], [
    'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado', 'Domingo',
  ]);
  assert.equal(WEEKDAY_DISPLAY.Miercoles, 'Miércoles');
  assert.equal(WEEKDAY_DISPLAY.Sabado, 'Sábado');
  assert.equal(WEEKDAY_SHORT.Miercoles, 'MI');
  assert.equal(WEEKDAY_SHORT.Sabado, 'SA');
});
