import { describe, expect, it } from 'vitest';
import { describeItem, humanizeKey, labelFor, renderValue } from './confirmation-values';

describe('renderValue', () => {
  it('texto corto tal cual; vacío como raya', () => {
    expect(renderValue('hola')).toEqual({ kind: 'text', text: 'hola' });
    expect(renderValue('')).toEqual({ kind: 'text', text: '—' });
    expect(renderValue(true)).toEqual({ kind: 'text', text: 'Sí' });
  });
  it('texto largo se recorta y guarda el completo', () => {
    const long = 'a'.repeat(500);
    const r = renderValue(long);
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.text.length).toBeLessThanOrEqual(160);
      expect(r.full).toBe(long);
    }
  });
  it('arreglo de objetos: una línea por elemento y el total', () => {
    const r = renderValue([
      { key: 'nit', label: 'NIT', type: 'text', required: true },
      { key: 'saldo', label: 'Saldo', type: 'money' },
    ]);
    expect(r).toEqual({
      kind: 'list',
      items: ['NIT · Texto · obligatorio', 'Saldo · Dinero'],
      total: 2,
    });
  });
  it('arreglo de primitivos: separados por coma', () => {
    expect(renderValue(['a', 'b'])).toEqual({ kind: 'text', text: 'a, b' });
    expect(renderValue([])).toEqual({ kind: 'text', text: 'Ninguno' });
  });
  it('objeto anidado: líneas «Etiqueta: valor»', () => {
    const r = renderValue({ name: 'Juan', roles: [{ name: 'Jefe' }], activo: true });
    expect(r.kind).toBe('lines');
    if (r.kind === 'lines') expect(r.items).toEqual(['Nombre: Juan', 'Roles: Jefe', 'Activo: Sí']);
  });
  it('nunca produce «[object Object]»', () => {
    const samples = [[{ a: { b: [{ c: 1 }] } }], { x: { y: { z: {} } } }, [[1, [2]], { q: null }]];
    for (const v of samples) expect(JSON.stringify(renderValue(v))).not.toContain('object Object');
  });
});

describe('etiquetas en español', () => {
  it('traduce las llaves conocidas', () => {
    expect(labelFor('slug')).toBe('Identificador');
    expect(labelFor('name')).toBe('Nombre');
    expect(labelFor('description')).toBe('Descripción');
    expect(labelFor('fields')).toBe('Campos');
    expect(labelFor('options')).toBe('Opciones');
    expect(labelFor('tracker')).toBe('Tabla');
    expect(labelFor('screens')).toBe('Pantallas');
    expect(labelFor('roles')).toBe('Roles');
  });
  it('el humanizador cubre llaves compuestas', () => {
    expect(humanizeKey('due_date')).toBe('Fecha de vencimiento');
    expect(labelFor('start_date')).toBe('Fecha de inicio');
    expect(labelFor('customerEmail')).toBe('Correo de cliente');
    expect(labelFor('created_by')).toBe('Creado por');
  });
  it('describeItem usa el nombre y el tipo', () => {
    expect(describeItem({ key: 'k', label: 'Placa', type: 'text' })).toBe('Placa · Texto');
    expect(describeItem('suelto')).toBe('suelto');
  });
});
