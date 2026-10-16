import { describe, expect, it } from 'vitest';
import {
  applyComputed,
  changedComputedKeys,
  computedProblems,
  fillLookups,
  formulaOrder,
  resolveFieldRef,
} from './computed';
import { trackerFieldsSchema } from './schema';
import { shapeValues, shapeValuesDetailed } from './store';

const CLOCK = { today: '2026-10-16', now: '10:00' };
const REL = (id: string, label = 'X') => JSON.stringify({ id, label });
const ID1 = '11111111-1111-4111-8111-111111111111';

const base = [
  { key: 'kilos', label: 'Kilos', type: 'number', required: true },
  { key: 'tarifa', label: 'Tarifa', type: 'money', required: true },
  { key: 'total', label: 'Total', type: 'money', formula: '[Kilos] × [Tarifa]' },
];

describe('applyComputed', () => {
  it('calcula, descarta lo escrito a mano y redondea el dinero', () => {
    const r = applyComputed(base, { kilos: 3, tarifa: 1234.567, total: 999 }, CLOCK);
    expect(r.values.total).toBe(3703.7);
  });
  it('sin un dato queda vacío (y sin error)', () => {
    const r = applyComputed(base, { kilos: 3 }, CLOCK);
    expect(r.values.total).toBeUndefined();
    expect(r.errors).toEqual({});
  });
  it('encadena fórmulas en orden de dependencia, aunque estén al revés', () => {
    const fields = [
      { key: 'iva', label: 'IVA', type: 'money', formula: '[Subtotal] * 19%' },
      { key: 'subtotal', label: 'Subtotal', type: 'money', formula: '[Kilos] × [Tarifa]' },
      ...base.slice(0, 2),
    ];
    expect(formulaOrder(fields).map((f) => f.key)).toEqual(['subtotal', 'iva']);
    const r = applyComputed(fields, { kilos: 10, tarifa: 1000 }, CLOCK);
    expect(r.values.subtotal).toBe(10000);
    expect(r.values.iva).toBe(1900);
  });
  it('tipos de resultado: porcentaje, fecha, texto, sí/no, hora', () => {
    const fields = [
      { key: 'a', label: 'A', type: 'number' },
      { key: 'b', label: 'B', type: 'number' },
      { key: 'ini', label: 'Inicio', type: 'date' },
      { key: 'avance', label: 'Avance', type: 'number', percent: true, formula: '[A] / [B]' },
      { key: 'vence', label: 'Vence', type: 'date', formula: '[Inicio] + 30' },
      { key: 'dias', label: 'Días', type: 'number', formula: 'dias_entre([Inicio]; hoy())' },
      {
        key: 'estado',
        label: 'Estado',
        type: 'text',
        formula: 'si([A] > [B]; "Excede"; "En rango")',
      },
      { key: 'ok', label: 'Ok', type: 'checkbox', formula: '[A] <= [B]' },
      { key: 'hora', label: 'Hora', type: 'time', formula: 'ahora()' },
    ];
    const r = applyComputed(fields, { a: 3, b: 4, ini: '2026-10-01' }, CLOCK);
    expect(r.values.avance).toBe(0.75);
    expect(r.values.vence).toBe('2026-10-31');
    expect(r.values.dias).toBe(15);
    expect(r.values.estado).toBe('En rango');
    expect(r.values.ok).toBe(1);
    expect(r.values.hora).toBe('10:00');
  });
  it('división por cero → vacío con aviso por campo', () => {
    const fields = [
      { key: 'a', label: 'A', type: 'number' },
      { key: 'b', label: 'B', type: 'number' },
      { key: 'r', label: 'R', type: 'number', formula: '[A] / [B]' },
    ];
    const r = applyComputed(fields, { a: 1, b: 0 }, CLOCK);
    expect(r.values.r).toBeUndefined();
    expect(r.warnings.r).toEqual(['No se puede dividir entre cero.']);
  });
  it('un resultado del tipo equivocado es un error del campo, no un valor', () => {
    const fields = [
      { key: 'a', label: 'A', type: 'text' },
      { key: 'f', label: 'F', type: 'date', formula: '[A] & "x"' },
    ];
    const r = applyComputed(fields, { a: 'hola' }, CLOCK);
    expect(r.values.f).toBeUndefined();
    expect(r.errors.f).toMatch(/tiene que dar una fecha/);
  });
  it('un checkbox en cuentas vale 1/0 y relaciones se leen por su etiqueta', () => {
    const fields = [
      { key: 'urgente', label: 'Urgente', type: 'checkbox' },
      { key: 'cli', label: 'Cliente', type: 'relation', tracker: 'clientes' },
      { key: 'recargo', label: 'Recargo', type: 'number', formula: '[Urgente] * 10' },
      { key: 'nombre', label: 'Nombre', type: 'text', formula: 'mayusculas([Cliente])' },
    ];
    const r = applyComputed(fields, { urgente: 1, cli: REL(ID1, 'Acme') }, CLOCK);
    expect(r.values.recargo).toBe(10);
    expect(r.values.nombre).toBe('ACME');
  });
  it('el nombre visible no distingue tildes ni mayúsculas', () => {
    expect(resolveFieldRef(base, 'kilos')?.key).toBe('kilos');
    expect(resolveFieldRef([{ key: 'm', label: 'Nómina', type: 'money' }], 'nomina')?.key).toBe(
      'm',
    );
  });
});

describe('computedProblems (al guardar el esquema)', () => {
  const msgs = (fields: unknown[]) => computedProblems(fields as never).map((p) => p.message);
  it('esquema válido: sin problemas', () => expect(msgs(base)).toEqual([]));
  it('fórmula mal escrita', () => {
    expect(msgs([...base.slice(0, 2), { ...base[2], formula: '[Kilos] ×' }])[0]).toMatch(
      /Fórmula de «Total»/,
    );
  });
  it('campo inexistente, con los campos disponibles', () => {
    const m = msgs([...base.slice(0, 2), { ...base[2], formula: '[Peso] × [Tarifa]' }]);
    expect(m[0]).toMatch(/no existe el campo «Peso»/);
    expect(m[0]).toMatch(/\[Kilos\]/);
  });
  it('se refiere a sí misma', () => {
    expect(msgs([{ key: 'a', label: 'A', type: 'number', formula: '[A] + 1' }])[0]).toMatch(
      /a sí misma/,
    );
  });
  it('ciclo entre dos fórmulas', () => {
    const m = msgs([
      { key: 'a', label: 'A', type: 'number', formula: '[B] + 1' },
      { key: 'b', label: 'B', type: 'number', formula: '[A] + 1' },
    ]);
    expect(m.some((x) => /ciclo/.test(x))).toBe(true);
  });
  it('ciclo largo de tres', () => {
    const m = msgs([
      { key: 'a', label: 'A', type: 'number', formula: '[B]' },
      { key: 'b', label: 'B', type: 'number', formula: '[C]' },
      { key: 'c', label: 'C', type: 'number', formula: '[A]' },
    ]);
    expect(m.filter((x) => /ciclo/.test(x)).length).toBeGreaterThan(0);
  });
  it('sin ciclo si sólo se encadenan', () => {
    expect(
      msgs([
        { key: 'a', label: 'A', type: 'number', formula: '1' },
        { key: 'b', label: 'B', type: 'number', formula: '[A] + 1' },
        { key: 'c', label: 'C', type: 'number', formula: '[B] + [A]' },
      ]),
    ).toEqual([]);
  });
  it('tipo que no puede ser calculado', () => {
    expect(msgs([{ key: 'a', label: 'A', type: 'file', formula: '1' }])[0]).toMatch(
      /sólo puede dar/,
    );
  });
  it('lookup: la relación tiene que existir y ser relación', () => {
    expect(
      msgs([
        { key: 'nit', label: 'NIT', type: 'text', lookup: { via: 'cliente', field: 'nit' } },
      ])[0],
    ).toMatch(/campo de relación/);
    expect(
      msgs([
        { key: 'cliente', label: 'Cliente', type: 'text' },
        { key: 'nit', label: 'NIT', type: 'text', lookup: { via: 'cliente', field: 'nit' } },
      ])[0],
    ).toMatch(/campo de relación/);
  });
  it('autofill: destinos que existen y no calculados', () => {
    const fields = [
      {
        key: 'vuelo',
        label: 'Vuelo',
        type: 'text',
        autofill: { instruction: 'Busca el vuelo', from: ['vuelo'], fills: ['aerolinea', 'nada'] },
      },
      { key: 'aerolinea', label: 'Aerolínea', type: 'text' },
    ];
    expect(msgs(fields).some((m) => /«nada»/.test(m))).toBe(true);
    const calc = [
      { ...fields[0], autofill: { instruction: 'Busca el vuelo', from: ['vuelo'], fills: ['t'] } },
      { key: 't', label: 'T', type: 'number', formula: '1' },
    ];
    expect(msgs(calc)[0]).toMatch(/ya se calcula solo/);
  });
});

describe('esquema (trackerFieldsSchema)', () => {
  const parse = (fields: unknown[]) => trackerFieldsSchema.safeParse(fields);
  it('esquemas viejos (sin nada nuevo) siguen siendo válidos', () => {
    expect(parse([{ key: 'a', label: 'A', type: 'text' }]).success).toBe(true);
  });
  it('acepta fórmula y la deja lista (sin required ni default)', () => {
    const r = parse([
      { key: 'k', label: 'K', type: 'number' },
      { key: 'd', label: 'D', type: 'number', formula: '= [K] * 2', required: true, default: 3 },
    ]);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data[1]?.formula).toBe('[K] * 2');
      expect(r.data[1]?.required).toBe(false);
      expect(r.data[1]?.default).toBeUndefined();
    }
  });
  it('alias: tipo «porcentaje» y «formula» con resultType', () => {
    const r = parse([
      { key: 'k', label: 'K', type: 'number' },
      { key: 'p', label: 'P', type: 'porcentaje' },
      { key: 'f', label: 'F', type: 'formula', resultType: 'money', formula: '[K] * 2' },
    ]);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data[1]).toMatchObject({ type: 'number', percent: true });
      expect(r.data[2]?.type).toBe('money');
    }
  });
  it('rechaza ciclos y campos inexistentes con mensajes legibles', () => {
    const r = parse([
      { key: 'a', label: 'A', type: 'number', formula: '[B]' },
      { key: 'b', label: 'B', type: 'number', formula: '[A]' },
    ]);
    expect(r.success).toBe(false);
    const r2 = parse([{ key: 'a', label: 'A', type: 'number', formula: '[Z] + 1' }]);
    expect(r2.success).toBe(false);
    if (!r2.success) expect(r2.error.issues[0]?.message).toMatch(/no existe el campo «Z»/);
  });
  it('percent sólo en number', () => {
    expect(parse([{ key: 'a', label: 'A', type: 'text', percent: true }]).success).toBe(true); // se poda
  });
});

describe('shapeValues con fórmulas', () => {
  const fields = trackerFieldsSchema.parse([
    { key: 'kilos', label: 'Kilos', type: 'number', required: true },
    { key: 'tarifa', label: 'Tarifa', type: 'money', required: true },
    { key: 'total', label: 'Total', type: 'money', formula: '[Kilos] × [Tarifa]' },
    { key: 'nota', label: 'Nota', type: 'text', showIf: { field: 'kilos', equals: '99' } },
    {
      key: 'extra',
      label: 'Extra',
      type: 'number',
      formula: '[Kilos] + 1',
      showIf: { field: 'kilos', equals: '99' },
    },
  ]);
  it('calcula al guardar e ignora lo que venga en el campo calculado', () => {
    const v = shapeValues(fields, { kilos: 4, tarifa: 2500, total: 1 });
    expect(v.total).toBe(10000);
    expect(v.extra).toBeUndefined(); // oculto por showIf
  });
  it('un campo calculado oculto por showIf no se guarda', () => {
    const v = shapeValues(fields, { kilos: 99, tarifa: 1 });
    expect(v.extra).toBe(100);
  });
  it('los obligatorios siguen siéndolo; el calculado nunca lo es', () => {
    expect(() => shapeValues(fields, { tarifa: 5 })).toThrow(/Kilos/);
  });
  it('reglas del campo calculado (min) se juzgan sobre el resultado', () => {
    const f = trackerFieldsSchema.parse([
      { key: 'a', label: 'A', type: 'number' },
      {
        key: 'r',
        label: 'R',
        type: 'number',
        formula: '[A] - 10',
        min: 0,
        message: 'No puede ser negativo',
      },
    ]);
    const { violations } = shapeValuesDetailed(f, { a: 5 }, { lenient: true });
    expect(violations.map((v) => v.key)).toContain('r');
  });
});

describe('lookups', () => {
  const fields = [
    { key: 'cliente', label: 'Cliente', type: 'relation', tracker: 'clientes' },
    { key: 'nit', label: 'NIT', type: 'text', lookup: { via: 'cliente', field: 'nit' } },
    {
      key: 'tarifa',
      label: 'Tarifa',
      type: 'money',
      lookup: { via: 'cliente', field: 'tarifa', editable: true },
    },
  ];
  const related = { cliente: { nit: '900123456-7', tarifa: 2500 } };
  it('trae los valores al elegir la relación', () => {
    const v = fillLookups(fields, { cliente: REL(ID1) }, related);
    expect(v.nit).toBe('900123456-7');
    expect(v.tarifa).toBe(2500);
  });
  it('el no editable siempre manda; el editable respeta lo que la persona dejó', () => {
    const v = fillLookups(fields, { cliente: REL(ID1), nit: 'otro', tarifa: 3000 }, related);
    expect(v.nit).toBe('900123456-7');
    expect(v.tarifa).toBe(3000);
  });
  it('si la relación cambió, el editable se refresca', () => {
    const v = fillLookups(fields, { cliente: REL(ID1), tarifa: 3000 }, related, {
      changedVia: new Set(['cliente']),
    });
    expect(v.tarifa).toBe(2500);
  });
  it('sin relación: el fijo se vacía, el editable queda', () => {
    const v = fillLookups(fields, { nit: 'x', tarifa: 3000 }, related);
    expect(v.nit).toBeUndefined();
    expect(v.tarifa).toBe(3000);
  });
  it('si no se pudo leer la fila relacionada, se deja lo que hay', () => {
    const v = fillLookups(fields, { cliente: REL(ID1), nit: 'viejo' }, { cliente: undefined });
    expect(v.nit).toBe('viejo');
  });
  it('un dato vacío en la otra tabla vacía el fijo', () => {
    const v = fillLookups(fields, { cliente: REL(ID1), nit: 'viejo' }, { cliente: { nit: '' } });
    expect(v.nit).toBeUndefined();
  });
});

describe('changedComputedKeys', () => {
  it('detecta fórmulas nuevas o cambiadas, y no las iguales', () => {
    const before = base;
    expect(changedComputedKeys(before, base)).toEqual([]);
    expect(
      changedComputedKeys(before, [
        ...base.slice(0, 2),
        { ...base[2], formula: '[Kilos]' } as never,
      ]),
    ).toEqual(['total']);
    expect(changedComputedKeys(base.slice(0, 2), base)).toEqual(['total']);
  });
});
