import { describe, expect, it } from 'vitest';
import {
  type TrackerField,
  boundShortcuts,
  changeFieldType,
  cleanField,
  dependentsOf,
  duplicateProblem,
  missingFlagOption,
  moveField,
  newField,
  previewMessages,
  probePattern,
  removeField,
  shortcutActive,
  showIfTargets,
  showIfWouldCycle,
  typeChangeIsSafe,
  validateDraft,
  withFlagOption,
} from './schema-editor';

const f = (over: Partial<TrackerField> & { key: string }): TrackerField => ({
  label: over.key,
  type: 'text',
  required: false,
  ...over,
});

describe('validateDraft', () => {
  it('acepta un esquema sencillo', () => {
    const v = validateDraft([f({ key: 'nombre', label: 'Nombre' })]);
    expect(v.ok).toBe(true);
  });

  it('pide al menos un campo', () => {
    expect(validateDraft([]).general[0]).toMatch(/al menos un campo/);
  });

  it('pone el error al lado del campo que lo tiene, en español', () => {
    const v = validateDraft([
      f({ key: 'a', label: 'A' }),
      f({ key: 'estado', label: 'Estado', type: 'select', options: [] }),
      f({ key: 'edad', label: 'Edad', type: 'number', min: 10, max: 1 }),
    ]);
    expect(v.ok).toBe(false);
    expect(v.byField.a).toBeUndefined();
    expect(v.byField.estado?.[0]).toMatch(/al menos una/);
    expect(v.byField.edad?.[0]).toMatch(/«min» no puede ser mayor/);
  });

  it('rechaza un patrón peligroso', () => {
    const v = validateDraft([f({ key: 'x', pattern: '(a+)+' })]);
    expect(v.byField.x?.[0]).toMatch(/peligroso/);
  });

  it('rechaza un nombre de campo vacío y dos con el mismo nombre', () => {
    const v = validateDraft([
      f({ key: 'a', label: ' ' }),
      f({ key: 'b', label: 'Dup' }),
      f({ key: 'c', label: 'dup' }),
    ]);
    expect(v.byField.a?.[0]).toMatch(/nombre/);
    expect(v.byField.b?.[0]).toMatch(/dos campos/);
  });

  it('rechaza un showIf que apunta a un campo que no existe', () => {
    const v = validateDraft([f({ key: 'a', showIf: { field: 'fantasma', equals: 'x' } })]);
    expect(v.ok).toBe(false);
  });

  it('ignora los vacíos que deja el formulario (mensaje vacío, listas vacías)', () => {
    const v = validateDraft([f({ key: 'a', message: '', help: '  ', unique: false })]);
    expect(v.ok).toBe(true);
  });
});

describe('showIf: ciclos', () => {
  const fields = [
    f({ key: 'a' }),
    f({ key: 'b', showIf: { field: 'a', notEmpty: true } }),
    f({ key: 'c', showIf: { field: 'b', notEmpty: true } }),
    f({ key: 'd' }),
  ];
  it('detecta ciclos directos e indirectos', () => {
    expect(showIfWouldCycle(fields, 'a', 'a')).toBe(true);
    expect(showIfWouldCycle(fields, 'a', 'b')).toBe(true); // b ya depende de a
    expect(showIfWouldCycle(fields, 'a', 'c')).toBe(true); // c → b → a
    expect(showIfWouldCycle(fields, 'a', 'd')).toBe(false);
    expect(showIfWouldCycle(fields, 'd', 'c')).toBe(false);
  });
  it('lista los candidatos con el motivo de los que no se pueden', () => {
    const t = showIfTargets(fields, 'a');
    expect(t.map((x) => x.key)).toEqual(['b', 'c', 'd']);
    expect(t.find((x) => x.key === 'b')?.disabled).toMatch(/círculo/);
    expect(t.find((x) => x.key === 'd')?.disabled).toBeUndefined();
  });
  it('quitar un padre libera a los que dependían de él', () => {
    expect(dependentsOf(fields, 'a').map((x) => x.key)).toEqual(['b']);
    const r = removeField(fields, 'a');
    expect(r.fields.find((x) => x.key === 'b')?.showIf).toBeUndefined();
    expect(r.clearedShowIf).toEqual(['b']);
    expect(validateDraft(r.fields).ok).toBe(true);
  });
});

describe('lista de campos', () => {
  it('un campo nuevo no repite clave', () => {
    const a = newField([], 'Fecha de entrega', 'date');
    const b = newField([a], 'Fecha de entrega', 'date');
    expect(a.key).toBe('fecha_de_entrega');
    expect(b.key).toBe('fecha_de_entrega_2');
  });
  it('un select nuevo trae una opción para ser válido', () => {
    const s = newField([], 'Estado', 'select');
    expect(s.options?.length).toBeGreaterThan(0);
    expect(validateDraft([s]).ok).toBe(true);
  });
  it('reordena sin mutar', () => {
    const l = [f({ key: 'a' }), f({ key: 'b' }), f({ key: 'c' })];
    expect(moveField(l, 0, 2).map((x) => x.key)).toEqual(['b', 'c', 'a']);
    expect(l.map((x) => x.key)).toEqual(['a', 'b', 'c']);
    expect(moveField(l, 0, 9)).toBe(l);
  });
  it('cambiar el tipo descarta lo que ya no aplica', () => {
    const t = changeFieldType(
      f({
        key: 'x',
        type: 'text',
        format: 'email',
        maxLength: 10,
        pattern: 'a',
        scan: true,
        default: 'hola',
      }),
      'number',
    );
    expect(t.format).toBeUndefined();
    expect(t.maxLength).toBeUndefined();
    expect(t.pattern).toBeUndefined();
    expect(t.scan).toBeUndefined();
    expect(t.default).toBeUndefined();
    expect(validateDraft([t]).ok).toBe(true);
  });
  it('de fecha a número no arrastra un «today»', () => {
    const t = changeFieldType(
      f({ key: 'x', type: 'date', min: 'today', default: 'today' }),
      'number',
    );
    expect(t.min).toBeUndefined();
    expect(t.default).toBeUndefined();
  });
  it('qué cambios de tipo son seguros con datos', () => {
    expect(typeChangeIsSafe('text', 'longtext')).toBe(true);
    expect(typeChangeIsSafe('number', 'money')).toBe(true);
    expect(typeChangeIsSafe('text', 'number')).toBe(false);
    expect(typeChangeIsSafe('select', 'text')).toBe(true);
  });
  it('cleanField quita lo vacío', () => {
    const c = cleanField(f({ key: 'x', help: '', options: [], unique: false, label: ' Hola ' }));
    expect(c).toEqual({ key: 'x', label: 'Hola', type: 'text', required: false });
  });
});

describe('patrón con prueba en vivo', () => {
  it('pasa, no pasa, vacío e inválido', () => {
    expect(probePattern('^[A-Z]{3}\\d{3}$', 'ABC123').state).toBe('pass');
    expect(probePattern('^[A-Z]{3}\\d{3}$', 'abc').state).toBe('fail');
    expect(probePattern('', 'x').state).toBe('empty');
    expect(probePattern('^a', '').state).toBe('empty');
    expect(probePattern('(', 'x').state).toBe('invalid');
    expect(probePattern('(a+)+', 'aaa').state).toBe('invalid');
  });
});

describe('atajos y vista previa', () => {
  it('«no puede ser futura» pone max today y la vista previa lo aplica', () => {
    const date = f({ key: 'fecha', label: 'Fecha', type: 'date' });
    const s = boundShortcuts('date').find((x) => x.id === 'not-future');
    expect(s).toBeDefined();
    const applied = { ...date, ...s?.patch };
    expect(shortcutActive(applied, s as NonNullable<typeof s>)).toBe(true);
    expect(previewMessages(applied, '2999-01-01')[0]).toMatch(/futura/);
    expect(previewMessages(applied, '2000-01-01')).toEqual([]);
  });
  it('el formato y el mensaje propio se ven en la vista previa', () => {
    const t = f({
      key: 'mail',
      label: 'Correo',
      format: 'email',
      message: 'Escribe un correo real.',
    });
    expect(previewMessages(t, 'no-es-correo')).toEqual(['Escribe un correo real.']);
    expect(previewMessages(t, 'ana@empresa.com')).toEqual([]);
  });
  it('obligatorio sin valor', () => {
    expect(previewMessages(f({ key: 'a', label: 'A', required: true }), '')[0]).toMatch(/Falta/);
  });
});

describe('regla de duplicados', () => {
  const fields = [
    f({ key: 'guia', label: 'Guía' }),
    f({ key: 'fecha', label: 'Fecha', type: 'date' }),
    f({ key: 'estado', label: 'Estado', type: 'select', options: ['Ok'] }),
  ];
  it('pide lo que falta', () => {
    expect(duplicateProblem({ key: '', flagField: '', flagValue: '' }, fields)).toMatch(
      /no debe repetirse/,
    );
    expect(duplicateProblem({ key: 'guia', flagField: '', flagValue: 'Dup' }, fields)).toMatch(
      /dónde|en qué campo/,
    );
    expect(duplicateProblem({ key: 'guia', flagField: 'guia', flagValue: 'Dup' }, fields)).toMatch(
      /distinto/,
    );
    expect(duplicateProblem({ key: 'guia', flagField: 'fecha', flagValue: 'Dup' }, fields)).toMatch(
      /opciones o de texto/,
    );
  });
  it('ofrece crear la opción que falta en el select', () => {
    const rule = { key: 'guia', distinctBy: 'fecha', flagField: 'estado', flagValue: 'Duplicada' };
    expect(duplicateProblem(rule, fields)).toMatch(/no tiene la opción/);
    expect(missingFlagOption(rule, fields)).toBe('estado');
    const fixed = withFlagOption(fields, rule);
    expect(duplicateProblem(rule, fixed)).toBeNull();
    expect(missingFlagOption(rule, fixed)).toBeNull();
  });
});

describe('límites de fecha en palabras', () => {
  it('ida y vuelta', async () => {
    const { readDateBound, writeDateBound, intervalProblem } = await import('./schema-editor');
    for (const b of ['today', 'today-30', 'today+7', '2026-01-31']) {
      const r = readDateBound(b);
      expect(writeDateBound(r.mode, r.n, r.date)).toBe(b);
    }
    expect(readDateBound(undefined).mode).toBe('none');
    expect(writeDateBound('none', 1, '')).toBeUndefined();
    expect(intervalProblem(4)).toMatch(/Entre/);
    expect(intervalProblem(15)).toBeNull();
    expect(intervalProblem(1.5)).toMatch(/entero/);
  });
});
