import { describe, expect, it } from 'vitest';
import { applyEdits, describeEdits, editableFields, sameShape } from './confirmation-edit';

const upsert = {
  tracker: 'clientes',
  rowId: '11111111-1111-4111-8111-111111111111',
  values: { nombre: 'Ana', precio: 8, activo: true },
};

describe('editableFields', () => {
  it('ofrece los valores sencillos y deja fuera la fontanería', () => {
    const fields = editableFields(upsert);
    expect(fields.map((f) => f.path.join('.'))).toEqual([
      'values.nombre',
      'values.precio',
      'values.activo',
    ]);
    expect(fields.map((f) => f.kind)).toEqual(['text', 'number', 'boolean']);
  });
  it('un correo con cuerpo largo usa área de texto', () => {
    const f = editableFields({ to: 'a@b.co', subject: 'Hola', body: 'x'.repeat(10) });
    expect(f.find((x) => x.path[0] === 'body')?.kind).toBe('longtext');
  });
  it('sin campos simples no hay Editar', () => {
    expect(editableFields({ items: [1, 2] })).toEqual([]);
    expect(editableFields('x')).toEqual([]);
  });
});

describe('applyEdits y sameShape', () => {
  it('conserva el tipo de cada hoja y no toca el original', () => {
    const next = applyEdits(upsert, [
      { path: ['values', 'precio'], value: '9,5' },
      { path: ['values', 'nombre'], value: 'Bea' },
      { path: ['values', 'activo'], value: false },
    ]) as typeof upsert;
    expect(next.values).toEqual({ nombre: 'Bea', precio: 9.5, activo: false });
    expect(upsert.values.precio).toBe(8);
    expect(sameShape(upsert, next)).toBe(true);
    expect(describeEdits(upsert, next)).toEqual([
      'Nombre: Ana → Bea',
      'Precio: 8 → 9.5',
      'Activo: true → false',
    ]);
  });
  it('rechaza llaves nuevas, faltantes o tipos distintos', () => {
    expect(sameShape(upsert, { ...upsert, extra: 1 })).toBe(false);
    expect(sameShape(upsert, { tracker: 'x' })).toBe(false);
    expect(sameShape(upsert, { ...upsert, values: { ...upsert.values, precio: 'ocho' } })).toBe(
      false,
    );
    expect(sameShape({ to: ['a'] }, { to: ['a', 'b'] })).toBe(false);
  });
  it('un número no numérico se ignora en vez de convertirse en NaN', () => {
    const next = applyEdits(upsert, [
      { path: ['values', 'precio'], value: 'abc' },
    ]) as typeof upsert;
    expect(next.values.precio).toBe(8);
  });
});
