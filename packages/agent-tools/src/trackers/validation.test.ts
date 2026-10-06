import { describe, expect, it } from 'vitest';
import { checkFormat, compilePattern, isSafePattern, isValidAwb, isValidNit } from './formats';
import {
  coerceValue,
  displayTrackerValue,
  mapsUrl,
  parseLocation,
  trackerFieldSchema,
  trackerFieldsSchema,
} from './schema';
import type { TrackerField } from './schema';
import { shapeValuesDetailed } from './store';
import {
  defaultValues,
  resolveBound,
  validateRowValues,
  visibleKeys,
  withDefaults,
} from './validation';

const f = (
  over: Partial<TrackerField> & { key: string; type: TrackerField['type'] },
): TrackerField => ({ label: over.key, required: false, ...over }) as TrackerField;

const CTX = { today: '2026-10-05', now: '14:30' };
const msgs = (fields: TrackerField[], values: Record<string, unknown>, o = {}) =>
  validateRowValues(fields, values, { ...CTX, ...o }).map((v) => `${v.key}: ${v.message}`);

describe('formatos colombianos', () => {
  it('NIT: valida el dígito de verificación', () => {
    expect(isValidNit('860002964-4')).toBe(true);
    expect(isValidNit('890.903.938-8')).toBe(true);
    expect(isValidNit('8909039388')).toBe(true);
    expect(isValidNit('900123456-8')).toBe(true);
    expect(isValidNit('900123456-7')).toBe(false);
    expect(isValidNit('900123456')).toBe(false); // sin DV el último dígito hace de DV y no cuadra
    expect(isValidNit('abc')).toBe(false);
    expect(isValidNit('1-2-3')).toBe(false);
  });

  it('placa: carro, moto y remolque; no cualquier cosa', () => {
    expect(checkFormat('plate', 'abc123')).toBe(true);
    expect(checkFormat('plate', 'ABC-123')).toBe(true);
    expect(checkFormat('plate', 'ABC12D')).toBe(true);
    expect(checkFormat('plate', 'R12345')).toBe(true);
    expect(checkFormat('plate', 'AB1234')).toBe(false);
    expect(checkFormat('plate', 'ABCD12')).toBe(false);
  });

  it('guía aérea: 3 + 8 dígitos con control mod 7', () => {
    expect(isValidAwb('176-12345675')).toBe(true);
    expect(isValidAwb('17612345675')).toBe(true);
    expect(isValidAwb('176 12345675')).toBe(true);
    expect(isValidAwb('176-12345676')).toBe(false);
    expect(isValidAwb('176-1234567')).toBe(false);
    expect(isValidAwb('17A-12345675')).toBe(false);
  });

  it('email, teléfono y dígitos', () => {
    expect(checkFormat('email', 'a@b.co')).toBe(true);
    expect(checkFormat('email', 'a@b')).toBe(false);
    expect(checkFormat('email', 'a b@c.co')).toBe(false);
    expect(checkFormat('phone', '+57 300 123 4567')).toBe(true);
    expect(checkFormat('phone', '12')).toBe(false);
    expect(checkFormat('phone', '300-abc-4567')).toBe(false);
    expect(checkFormat('digits', '0123')).toBe(true);
    expect(checkFormat('digits', '12a')).toBe(false);
  });
});

describe('regex propio y ReDoS', () => {
  it('compila uno sano y lo prueba', () => {
    const re = compilePattern('^[A-Z]{2}-\\d{4}$');
    expect(re?.test('AB-1234')).toBe(true);
    expect(re?.test('ab-1234')).toBe(false);
  });

  it('rechaza cuantificadores anidados, referencias hacia atrás y los muy largos', () => {
    for (const bad of [
      '(a+)+$',
      '(a*)*',
      '(\\d{2,})+',
      '^(\\w+\\s?)*$',
      '((a+))+',
      '(a)\\1',
      'x'.repeat(201),
    ]) {
      expect(isSafePattern(bad), bad).toBe(false);
      expect(compilePattern(bad), bad).toBeNull();
    }
    expect(compilePattern('([')).toBeNull(); // mal escrito: null, no lanza
  });

  it('acepta alternancias y grupos sin repetición', () => {
    expect(isSafePattern('^(CC|CE|TI)-\\d+$')).toBe(true);
    expect(isSafePattern('^(\\d{3})-(\\d{8})$')).toBe(true);
  });

  it('el esquema del campo no deja pasar un patrón peligroso', () => {
    const ok = trackerFieldSchema.safeParse({
      key: 'a',
      label: 'A',
      type: 'text',
      pattern: '^\\d+$',
    });
    const bad = trackerFieldSchema.safeParse({
      key: 'a',
      label: 'A',
      type: 'text',
      pattern: '(a+)+$',
    });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });
});

describe('validateRowValues', () => {
  it('rangos de número y dinero', () => {
    const fields = [
      f({ key: 'n', type: 'number', min: 1, max: 10 }),
      f({ key: 'm', type: 'money', min: 0 }),
    ];
    expect(msgs(fields, { n: 5, m: 100 })).toEqual([]);
    expect(msgs(fields, { n: 0 })[0]).toContain('menor que 1');
    expect(msgs(fields, { n: 11 })[0]).toContain('mayor que 10');
    expect(msgs(fields, { m: -5 })[0]).toContain('menor que');
  });

  it('fecha y hora con límites relativos', () => {
    const fields = [
      f({ key: 'd', type: 'date', max: 'today' }),
      f({ key: 'p', type: 'date', min: 'today' }),
      f({ key: 'h', type: 'time', max: 'now' }),
    ];
    expect(msgs(fields, { d: '2026-10-05' })).toEqual([]);
    expect(msgs(fields, { d: '2026-10-06' })[0]).toContain('fecha futura');
    expect(msgs(fields, { p: '2026-10-04' })[0]).toContain('fecha pasada');
    expect(msgs(fields, { h: '14:31' })[0]).toContain('hora futura');
    expect(msgs(fields, { h: '14:30' })).toEqual([]);
    expect(resolveBound('date', 'today-30', CTX)).toBe('2026-09-05');
    expect(resolveBound('date', 'today+7', CTX)).toBe('2026-10-12');
    expect(resolveBound('time', 'now', CTX)).toBe('14:30');
  });

  it('largos, formato, patrón y mensaje propio', () => {
    const fields = [
      f({ key: 't', type: 'text', minLength: 3, maxLength: 5 }),
      f({ key: 'nit', type: 'text', format: 'nit' }),
      f({
        key: 'cod',
        type: 'text',
        pattern: '^[A-Z]{2}\\d{3}$',
        message: 'Usa dos letras y tres números.',
      }),
    ];
    expect(msgs(fields, { t: 'ab' })[0]).toContain('al menos 3');
    expect(msgs(fields, { t: 'abcdef' })[0]).toContain('hasta 5');
    expect(msgs(fields, { nit: '900123456-7' })[0]).toContain('NIT');
    expect(msgs(fields, { nit: '900123456-8' })).toEqual([]);
    expect(msgs(fields, { cod: 'zz' })).toEqual(['cod: Usa dos letras y tres números.']);
    expect(msgs(fields, { cod: 'AB123' })).toEqual([]);
  });

  it('obligatorio vacío y tipo mal formado', () => {
    const fields = [f({ key: 'a', type: 'text', required: true }), f({ key: 'd', type: 'date' })];
    expect(msgs(fields, {})).toEqual(['a: Falta «a».']);
    expect(msgs(fields, { a: 'x', d: 'mañana' })[0]).toContain('fecha');
  });

  it('unique compara normalizado y se salta la fila que se edita', () => {
    const fields = [f({ key: 'g', type: 'text', unique: true })];
    const existing = [
      { id: '1', values: { g: '176-12345675' } },
      { id: '2', values: { g: 'otra' } },
    ];
    expect(msgs(fields, { g: '176 12345675' }, { existing })[0]).toContain('Ya hay un registro');
    expect(msgs(fields, { g: 'OTRA' }, { existing })[0]).toContain('Ya hay un registro');
    expect(msgs(fields, { g: '176-12345675' }, { existing, selfId: '1' })).toEqual([]);
    expect(msgs(fields, { g: 'nueva' }, { existing })).toEqual([]);
    expect(msgs(fields, { g: 'nueva' })).toEqual([]); // sin filas, no se puede saber
  });
});

describe('showIf', () => {
  const fields = [
    f({ key: 'resultado', type: 'select', options: ['Conforme', 'Con novedad'] }),
    f({
      key: 'descripcion',
      type: 'longtext',
      required: true,
      showIf: { field: 'resultado', equals: 'Con novedad' },
    }),
    f({
      key: 'detalle',
      type: 'text',
      required: true,
      showIf: { field: 'descripcion', notEmpty: true },
    }),
  ];

  it('oculta y no exige lo que no aplica', () => {
    expect([...visibleKeys(fields, { resultado: 'Conforme' })]).toEqual(['resultado']);
    expect(msgs(fields, { resultado: 'Conforme' })).toEqual([]);
  });

  it('exige lo que aplica, y la cadena entera tiene que cumplirse', () => {
    expect(msgs(fields, { resultado: 'Con novedad' })).toEqual([
      'descripcion: Falta «descripcion».',
    ]);
    expect(msgs(fields, { resultado: 'Con novedad', descripcion: 'roto' })).toEqual([
      'detalle: Falta «detalle».',
    ]);
    // el padre oculto oculta al hijo aunque traiga valor
    expect([...visibleKeys(fields, { resultado: 'Conforme', descripcion: 'x' })]).toEqual([
      'resultado',
    ]);
  });

  it('equals acepta lista y no distingue tildes ni mayúsculas', () => {
    const g = [
      f({ key: 'a', type: 'select', options: ['Sí', 'No'] }),
      f({ key: 'b', type: 'text', showIf: { field: 'a', equals: ['si', 'TAL VEZ'] } }),
    ];
    expect(visibleKeys(g, { a: 'Sí' }).has('b')).toBe(true);
    expect(visibleKeys(g, { a: 'No' }).has('b')).toBe(false);
  });

  it('con una casilla', () => {
    const g = [
      f({ key: 'c', type: 'checkbox' }),
      f({ key: 'x', type: 'text', showIf: { field: 'c', equals: 'sí' } }),
      f({ key: 'y', type: 'text', showIf: { field: 'c', notEmpty: true } }),
    ];
    expect(visibleKeys(g, { c: 1 })).toEqual(new Set(['c', 'x', 'y']));
    expect(visibleKeys(g, { c: 0 })).toEqual(new Set(['c']));
  });

  it('el servidor descarta lo oculto al guardar y no lo exige', () => {
    const out = shapeValuesDetailed(fields, {
      resultado: 'Conforme',
      descripcion: 'no debería guardarse',
    });
    expect(out.values).toEqual({ resultado: 'Conforme' });
    expect(() => shapeValuesDetailed(fields, { resultado: 'Con novedad' })).toThrow(/descripcion/);
  });

  it('el esquema rechaza un showIf a un campo que no existe, a sí mismo o en ciclo', () => {
    const base = (extra: Record<string, unknown>[]) =>
      trackerFieldsSchema.safeParse(
        extra.map((e, i) => ({ key: `k${i}`, label: `K${i}`, type: 'text', ...e })),
      ).success;
    expect(base([{}, { showIf: { field: 'k0', notEmpty: true } }])).toBe(true);
    expect(base([{ showIf: { field: 'nada', notEmpty: true } }])).toBe(false);
    expect(base([{ showIf: { field: 'k0', notEmpty: true } }])).toBe(false);
    expect(
      base([
        { showIf: { field: 'k1', notEmpty: true } },
        { showIf: { field: 'k0', notEmpty: true } },
      ]),
    ).toBe(false);
  });
});

describe('valores por defecto', () => {
  const fields = [
    f({ key: 'd', type: 'date', default: 'today' }),
    f({ key: 'h', type: 'time', default: 'now' }),
    f({ key: 'quien', type: 'text', default: 'viewer' }),
    f({ key: 'estado', type: 'select', options: ['Nuevo'], default: 'Nuevo' }),
    f({ key: 'ok', type: 'checkbox', default: 'sí' }),
    f({ key: 'cant', type: 'number', default: 3 }),
  ];

  it('resuelve today, now, viewer, casilla y fijos', () => {
    expect(defaultValues(fields, { ...CTX, viewer: 'Ana Pérez' })).toEqual({
      d: '2026-10-05',
      h: '14:30',
      quien: 'Ana Pérez',
      estado: 'Nuevo',
      ok: 1,
      cant: 3,
    });
  });

  it('en un enlace público «viewer» queda vacío', () => {
    expect(defaultValues(fields, CTX).quien).toBeUndefined();
  });

  it('no pisa lo que ya viene y se aplica al guardar una fila nueva', () => {
    expect(withDefaults(fields, { d: '2026-01-01' }, CTX).d).toBe('2026-01-01');
    const out = shapeValuesDetailed(fields, {}, { applyDefaults: true, viewer: 'Ana' });
    expect(out.values.quien).toBe('Ana');
    expect(out.values.estado).toBe('Nuevo');
    expect(typeof out.values.d).toBe('string');
  });
});

describe('tipos nuevos', () => {
  it('location: normaliza a 6 decimales y rechaza lo fuera de rango', () => {
    const loc = f({ key: 'u', type: 'location' });
    expect(coerceValue(loc, '4.7109, -74.0721')).toEqual({
      ok: true,
      value: '4.710900,-74.072100',
    });
    expect(coerceValue(loc, { lat: 4.5, lng: -74 })).toEqual({
      ok: true,
      value: '4.500000,-74.000000',
    });
    expect(coerceValue(loc, '91,0').ok).toBe(false);
    expect(coerceValue(loc, 'aquí').ok).toBe(false);
    expect(parseLocation('0,181')).toBeNull();
    expect(mapsUrl('4.7109,-74.0721')).toBe('https://www.google.com/maps?q=4.710900,-74.072100');
  });

  it('file: guarda JSON, respeta multiple, accept y el máximo de 5', () => {
    const one = { url: 'https://x.co/a.jpg', name: 'a.jpg', mime: 'image/jpeg', size: 10 };
    const single = f({ key: 'fo', type: 'file', accept: 'image' });
    const multi = f({ key: 'fo', type: 'file', multiple: true });
    expect(coerceValue(single, one)).toEqual({ ok: true, value: JSON.stringify(one) });
    expect(coerceValue(single, JSON.stringify(one)).ok).toBe(true);
    expect(coerceValue(single, { ...one, mime: 'application/pdf' }).ok).toBe(false);
    expect(coerceValue(single, [one, one]).ok).toBe(false);
    expect(coerceValue(multi, [one, one]).ok).toBe(true);
    expect(coerceValue(multi, Array(6).fill(one)).ok).toBe(false);
    expect(coerceValue(single, { ...one, url: 'javascript:alert(1)' }).ok).toBe(false);
    expect(coerceValue(single, 'no es json').ok).toBe(false);
    expect(displayTrackerValue(single, JSON.stringify(one))).toBe('a.jpg');
  });

  it('relation: id suelto o {id,label}; la etiqueta se muestra', () => {
    const rel = f({ key: 'r', type: 'relation', tracker: 'sedes' });
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(coerceValue(rel, id)).toEqual({ ok: true, value: JSON.stringify({ id, label: '' }) });
    expect(coerceValue(rel, { id, label: 'Bogotá' }).ok).toBe(true);
    expect(coerceValue(rel, 'no-es-uuid').ok).toBe(false);
    expect(displayTrackerValue(rel, JSON.stringify({ id, label: 'Bogotá' }))).toBe('Bogotá');
  });

  it('el esquema pide tracker en relation y no deja opciones donde no aplican', () => {
    const ok = (x: object) => trackerFieldSchema.safeParse({ key: 'a', label: 'A', ...x }).success;
    expect(ok({ type: 'relation' })).toBe(false);
    expect(ok({ type: 'relation', tracker: 'sedes' })).toBe(true);
    expect(ok({ type: 'text', tracker: 'sedes' })).toBe(false);
    expect(ok({ type: 'text', scan: true })).toBe(true);
    expect(ok({ type: 'number', scan: true })).toBe(false);
    expect(ok({ type: 'file', accept: 'image', multiple: true })).toBe(true);
    expect(ok({ type: 'number', format: 'email' })).toBe(false);
    expect(ok({ type: 'number', min: 5, max: 1 })).toBe(false);
    expect(ok({ type: 'date', max: 'today' })).toBe(true);
    expect(ok({ type: 'date', max: 'mañana' })).toBe(false);
  });

  it('un campo viejo (sin ninguna opción nueva) sigue siendo válido', () => {
    expect(
      trackerFieldsSchema.safeParse([
        { key: 'placa', label: 'Placa', type: 'text', required: true },
        { key: 'estado', label: 'Estado', type: 'select', options: ['a'] },
      ]).success,
    ).toBe(true);
  });
});
