import { describe, expect, it } from 'vitest';
import { bogotaDateTime, fieldsFromSheet, planSync } from './sync';

const sheet = {
  name: 'API',
  rows: [
    ['flight.iata', 'flight_date', 'arrival.scheduled', 'flight_status', 'arrival.delay'],
    ['AV9', '2026-09-25', '2026-09-25T15:05:00+00:00', 'landed', 12],
    ['LA40', '2026-09-25', '2026-09-25T16:30:00+00:00', 'active', null],
    ['AV9', '2026-09-26', '2026-09-26T15:05:00+00:00', 'scheduled', null],
    [null, '2026-09-25', '2026-09-25T17:00:00+00:00', 'active', null],
    ['AV15', '2026-09-25', '2026-09-25T18:00:00+00:00', 'landed', 3],
  ],
};

describe('una fuente que llena una tabla', () => {
  it('una hora con zona es texto en hora de Bogotá, no una fecha sin hora', () => {
    const { fields, mapping } = fieldsFromSheet(sheet);
    const scheduled = fields.find((f) => mapping[f.key] === 'arrival.scheduled');
    expect(scheduled?.type).toBe('text');
    expect(bogotaDateTime('2026-09-25T15:05:00+00:00')).toBe('2026-09-25 10:05');
  });

  it('identifica filas por sus claves y salta las que no tienen clave', () => {
    const { fields, mapping } = fieldsFromSheet(sheet);
    const flight = fields.find((f) => mapping[f.key] === 'flight.iata')?.key ?? '';
    const day = fields.find((f) => mapping[f.key] === 'flight_date')?.key ?? '';
    const plan = planSync(sheet, fields, mapping, [flight, day]);
    expect(plan.rows.map((r) => r.key)).toEqual([
      'AV9 | 2026-09-25',
      'LA40 | 2026-09-25',
      'AV9 | 2026-09-26',
      'AV15 | 2026-09-25',
    ]);
    expect(plan.skipped).toBe(1);
    expect(plan.missingHeaders).toEqual([]);
  });

  it('un estado nuevo amplía las opciones en vez de rechazar la fila', () => {
    const { fields, mapping } = fieldsFromSheet(sheet);
    const status = fields.find((f) => mapping[f.key] === 'flight_status');
    const flight = fields.find((f) => mapping[f.key] === 'flight.iata')?.key ?? '';
    const withStatus = fields.map((f) =>
      f.key === status?.key ? { ...f, type: 'select' as const, options: ['landed'] } : f,
    );
    const plan = planSync(sheet, withStatus, mapping, [flight]);
    expect(plan.newOptions[status?.key ?? '']?.sort()).toEqual(['active', 'scheduled']);
  });

  it('avisa si la fuente dejó de traer una columna', () => {
    const { fields, mapping } = fieldsFromSheet(sheet);
    const plan = planSync(sheet, fields, { ...mapping, extra: 'columna_que_no_existe' }, [
      fields[0]?.key ?? '',
    ]);
    expect(plan.missingHeaders).toEqual(['columna_que_no_existe']);
  });
});
