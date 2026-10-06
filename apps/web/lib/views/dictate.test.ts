import { describe, expect, it, vi } from 'vitest';

vi.mock('@cortex/agent-tools', () => ({}));

const { parseSpokenNumber, shapeDictated } = await import('./dictate');

const fields = [
  { key: 'codigo', label: 'Código', type: 'text' },
  { key: 'fecha', label: 'Fecha', type: 'date' },
  { key: 'hora', label: 'Hora', type: 'time' },
  { key: 'cantidad', label: 'Cantidad', type: 'number' },
  { key: 'valor', label: 'Valor', type: 'money' },
  { key: 'revisado', label: 'Revisado', type: 'checkbox' },
  { key: 'estado', label: 'Estado', type: 'select', options: ['Recibido', 'Duplicado'] },
];

describe('lo dictado, al formato de cada campo', () => {
  it('deja pasar lo que encaja y normaliza', () => {
    expect(
      shapeDictated(fields, {
        codigo: ' 729-12345675 ',
        fecha: '2026-10-05',
        hora: '9:05',
        cantidad: '4',
        valor: '1.200.000',
        revisado: 'sí',
        estado: 'recibido',
      }),
    ).toEqual({
      codigo: '729-12345675',
      fecha: '2026-10-05',
      hora: '09:05',
      cantidad: '4',
      valor: '1200000',
      revisado: 'true',
      estado: 'Recibido',
    });
  });

  it('descarta lo que no encaja en vez de adivinar', () => {
    expect(
      shapeDictated(fields, {
        fecha: 'mañana',
        hora: '25:00',
        cantidad: 'muchas',
        revisado: 'quizá',
        estado: 'Perdido',
        otro: 'x',
      }),
    ).toEqual({});
  });
});

describe('números dichos como se escriben aquí', () => {
  it('punto de miles, coma decimal y las formas simples', () => {
    expect(parseSpokenNumber('1.200.000')).toBe(1200000);
    expect(parseSpokenNumber('$ 32.000.000')).toBe(32000000);
    expect(parseSpokenNumber('3,5')).toBe(3.5);
    expect(parseSpokenNumber('3.5')).toBe(3.5);
    expect(parseSpokenNumber('1,200,000')).toBe(1200000);
    expect(parseSpokenNumber('40')).toBe(40);
    expect(parseSpokenNumber('cuarenta')).toBeNull();
  });
});
