import type { GridColumn } from '@/components/datagrid/types';
import type { RowLookupRow } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { describeCadence, describeFilter, lookupCardFrom } from './lookups';

const COLUMNS: GridColumn[] = [
  { key: 'fecha', label: 'Fecha', type: 'date' },
  {
    key: 'estado',
    label: 'Estado',
    type: 'select',
    options: [{ value: 'aterrizado' }, { value: 'cancelado' }],
  },
  { key: 'hora_estimada', label: 'Hora estimada', type: 'text' },
];

// 2026-10-03 10:00 en Bogotá.
const NOW = Date.parse('2026-10-03T15:00:00Z');

const ROW: RowLookupRow = {
  id: 'l1',
  tracker_id: 't1',
  name: 'Estado del vuelo',
  url_template: 'https://api.ejemplo.com/vuelos/{vuelo}',
  credential_tool_id: null,
  credential_name: 'AeroDataBox',
  mapping: [{ path: 'status', field: 'estado' }],
  filter: {
    match: 'all',
    filters: [
      { key: 'fecha', op: 'eq', value: 'hoy' },
      { key: 'estado', op: 'not_in', value: ['aterrizado', 'cancelado'] },
    ],
  },
  base_interval_minutes: 30,
  near: {
    field: 'hora_estimada',
    beforeMinutes: 120,
    afterMinutes: 60,
    everyMinutes: 5,
    outside: 'base',
  },
  daily_cap: 1000,
  per_run_cap: 100,
  enabled: true,
  created_by: 'u',
  next_run_at: '2026-10-03T15:05:00Z',
  last_run_at: '2026-10-03T15:00:00Z',
  last_status: 'ok',
  last_error: null,
  last_calls: 4,
  last_updated: 1,
  calls_today: 120,
  calls_day: '2026-10-03',
};

describe('las consultas automáticas en pantalla', () => {
  it('cuenta lo gastado hoy contra el tope', () => {
    const card = lookupCardFrom(ROW, COLUMNS, NOW);
    expect(card).toMatchObject({
      state: 'ok',
      callsToday: 120,
      dailyCap: 1000,
      credential: 'AeroDataBox',
    });
    expect(card.writes).toBe('status → Estado');
  });

  it('el contador es de HOY (Bogotá): el de ayer no cuenta', () => {
    expect(lookupCardFrom({ ...ROW, calls_day: '2026-10-02' }, COLUMNS, NOW).callsToday).toBe(0);
    // 22:00 del 3 en Bogotá ya es el día 4 en UTC: sigue siendo el día 3.
    expect(lookupCardFrom(ROW, COLUMNS, Date.parse('2026-10-04T03:00:00Z')).callsToday).toBe(120);
  });

  it('estados: pausa, error, tope alcanzado', () => {
    expect(lookupCardFrom({ ...ROW, enabled: false }, COLUMNS, NOW)).toMatchObject({
      state: 'paused',
      nextRunAt: null,
    });
    expect(
      lookupCardFrom(
        { ...ROW, last_status: 'error', last_error: 'La API rechazó la credencial' },
        COLUMNS,
        NOW,
      ),
    ).toMatchObject({ state: 'error', lastError: 'La API rechazó la credencial' });
    expect(lookupCardFrom({ ...ROW, calls_today: 1000 }, COLUMNS, NOW).state).toBe('capped');
  });

  it('describe el filtro y la cadencia con los nombres de las columnas', () => {
    expect(describeFilter(ROW.filter, COLUMNS)).toBe(
      'Fecha es el día hoy · y Estado no es ninguno de aterrizado, cancelado',
    );
    expect(describeFilter({ match: 'all', filters: [] }, COLUMNS)).toBe('Todas las filas');
    expect(describeCadence(ROW, COLUMNS)).toBe(
      'cada 5 min desde 120 min antes hasta 60 min después de «Hora estimada»; fuera, cada 30 min',
    );
    expect(describeCadence({ ...ROW, near: null }, COLUMNS)).toBe('cada 30 min');
  });
});
