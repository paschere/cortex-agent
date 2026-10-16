import { describe, expect, it } from 'vitest';
import {
  autofillReady,
  mergeSuggestions,
  sanitizeSuggestion,
  triggerSignature,
} from './autofill-shape';

const fields = [
  { key: 'vuelo', label: 'Vuelo', type: 'text' },
  { key: 'aerolinea', label: 'Aerolínea', type: 'text' },
  { key: 'origen', label: 'Origen', type: 'select', options: ['Bogotá', 'Miami', 'Madrid'] },
  { key: 'fecha', label: 'Fecha', type: 'date' },
  { key: 'hora', label: 'Hora', type: 'time' },
  { key: 'pasajeros', label: 'Pasajeros', type: 'number' },
  { key: 'total', label: 'Total', type: 'money', formula: '1' },
];
const cfg = { fills: ['aerolinea', 'origen', 'fecha', 'hora', 'pasajeros', 'total'] };

describe('mergeSuggestions: nunca pisa lo escrito', () => {
  const sug = {
    aerolinea: { value: 'Avianca', source: 'https://avianca.com' },
    origen: 'miami',
    fecha: '2026-10-17',
    hora: '14:05:00',
    pasajeros: '180',
    total: '9',
  };
  it('llena los campos vacíos con fuente', () => {
    const r = mergeSuggestions(fields, cfg, { vuelo: 'AV204' }, sug);
    expect(r.applied).toEqual({
      aerolinea: 'Avianca',
      origen: 'Miami',
      fecha: '2026-10-17',
      hora: '14:05',
      pasajeros: '180',
    });
    expect(r.sources.aerolinea).toBe('https://avianca.com');
    expect(r.skipped).toContainEqual({ key: 'total', reason: 'no_aplica' });
  });
  it('lo que la persona ya escribió se queda', () => {
    const r = mergeSuggestions(
      fields,
      cfg,
      { vuelo: 'AV204', aerolinea: 'Mi aerolínea', hora: '09:00' },
      sug,
    );
    expect(r.applied.aerolinea).toBeUndefined();
    expect(r.applied.hora).toBeUndefined();
    expect(r.applied.fecha).toBe('2026-10-17');
    expect(r.skipped).toContainEqual({ key: 'aerolinea', reason: 'escrito' });
  });
  it('lo que Cortex sugirió antes y no se tocó sí se actualiza', () => {
    const r = mergeSuggestions(fields, cfg, { aerolinea: 'Viejo', fecha: '2026-10-10' }, sug, {
      aerolinea: 'Viejo',
    });
    expect(r.applied.aerolinea).toBe('Avianca');
    expect(r.applied.fecha).toBeUndefined(); // lo puso la persona
  });
  it('un 0 escrito cuenta como escrito', () => {
    const r = mergeSuggestions(fields, cfg, { pasajeros: '0' }, sug);
    expect(r.applied.pasajeros).toBeUndefined();
  });
  it('valores inválidos o vacíos se descartan', () => {
    const r = mergeSuggestions(
      fields,
      cfg,
      {},
      { origen: 'Cali', fecha: 'mañana', hora: '25:99', pasajeros: 'muchos', aerolinea: '  ' },
    );
    expect(r.applied).toEqual({});
    expect(r.skipped.map((s) => s.reason)).toContain('invalido');
    expect(r.skipped).toContainEqual({ key: 'aerolinea', reason: 'vacio' });
  });
  it('sólo toca los campos de fills', () => {
    const r = mergeSuggestions(
      fields,
      { fills: ['aerolinea'] },
      {},
      { aerolinea: 'A', fecha: '2026-01-01' },
    );
    expect(Object.keys(r.applied)).toEqual(['aerolinea']);
  });
});

describe('disparadores y huella', () => {
  it('está listo sólo cuando todos los disparadores tienen algo', () => {
    const c = { from: ['vuelo', 'fecha'] };
    expect(autofillReady(c, { vuelo: 'AV204' })).toBe(false);
    expect(autofillReady(c, { vuelo: 'AV204', fecha: '  ' })).toBe(false);
    expect(autofillReady(c, { vuelo: 'AV204', fecha: '2026-10-17' })).toBe(true);
  });
  it('la huella ignora mayúsculas, tildes y espacios repetidos', () => {
    const c = { from: ['vuelo'] };
    expect(triggerSignature(c, { vuelo: 'AV  204' })).toBe(
      triggerSignature(c, { vuelo: 'av 204 ' }),
    );
    expect(triggerSignature(c, { vuelo: 'AV205' })).not.toBe(
      triggerSignature(c, { vuelo: 'AV204' }),
    );
  });
  it('sanitizeSuggestion: sí/no, fechas con hora', () => {
    expect(sanitizeSuggestion({ key: 'a', label: 'a', type: 'checkbox' }, 'Sí')).toBe('1');
    expect(sanitizeSuggestion({ key: 'a', label: 'a', type: 'date' }, '2026-10-17T14:00')).toBe(
      '2026-10-17',
    );
    expect(sanitizeSuggestion({ key: 'a', label: 'a', type: 'money' }, '1.250.000')).toBe(
      '1250000',
    );
    expect(sanitizeSuggestion({ key: 'a', label: 'a', type: 'file' }, 'x')).toBeNull();
  });
});
