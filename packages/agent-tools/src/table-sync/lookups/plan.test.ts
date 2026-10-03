import { describe, expect, it } from 'vitest';
import type { TrackerField } from '../../trackers/schema';
import {
  type PlanRowInput,
  type PlanSpec,
  type PlanState,
  cadenceFor,
  mapResponse,
  nextAtAfter,
  nextResetMs,
  planLookup,
} from './plan';
import { MINUTE, bogotaDay } from './time';

// 2026-10-03 10:00 en Bogotá.
const NOW = Date.parse('2026-10-03T15:00:00Z');

const FIELDS: TrackerField[] = [
  { key: 'vuelo', label: 'Vuelo', type: 'text', required: false },
  { key: 'fecha', label: 'Fecha', type: 'date', required: false },
  { key: 'estado', label: 'Estado', type: 'text', required: false },
  { key: 'hora_estimada', label: 'Hora estimada', type: 'text', required: false },
  { key: 'peso', label: 'Peso', type: 'number', required: false },
  {
    key: 'fase',
    label: 'Fase',
    type: 'select',
    required: false,
    options: ['programado', 'en vuelo'],
  },
];

const spec = (over: Partial<PlanSpec> = {}): PlanSpec => ({
  url_template: 'https://api.ejemplo.com/vuelos/{vuelo}/{fecha:YYYY-MM-DD}',
  filter: {
    match: 'all',
    filters: [
      { key: 'fecha', op: 'eq', value: 'hoy' },
      { key: 'estado', op: 'not_in', value: ['aterrizado', 'cancelado'] },
    ],
  },
  base_interval_minutes: 30,
  near: null,
  daily_cap: 1000,
  per_run_cap: 100,
  calls_today: 0,
  calls_day: null,
  ...over,
});

const row = (id: string, values: Record<string, string | number>): PlanRowInput => ({ id, values });
const none = new Map<string, PlanState>();

describe('qué filas se consultan', () => {
  it('las de hoy que no han terminado; las terminadas no se vuelven a consultar', () => {
    const plan = planLookup(
      spec(),
      FIELDS,
      [
        row('a', { vuelo: 'AV9', fecha: '2026-10-03' }),
        row('b', { vuelo: 'LA40', fecha: '2026-10-03', estado: 'aterrizado' }),
        row('c', { vuelo: 'CM1', fecha: '2026-10-03', estado: 'cancelado' }),
        row('d', { vuelo: 'AV1', fecha: '2026-10-02' }),
      ],
      none,
      NOW,
    );
    expect(plan.calls.map((c) => c.rowId)).toEqual(['a']);
    expect(plan.calls[0]?.url).toBe('https://api.ejemplo.com/vuelos/AV9/2026-10-03');
    expect(plan.skipped.filter).toBe(3);
  });

  it('una fila sin algún campo de la dirección se salta y no gasta consulta', () => {
    const plan = planLookup(
      spec(),
      FIELDS,
      [row('a', { fecha: '2026-10-03' }), row('b', { vuelo: 'AV9', fecha: '2026-10-03' })],
      none,
      NOW,
    );
    expect(plan.calls.map((c) => c.rowId)).toEqual(['b']);
    expect(plan.skipped.missing).toBe(1);
    expect(plan.missing).toEqual([{ rowId: 'a', fields: ['vuelo'] }]);
  });

  it('respeta cuándo toca de nuevo cada fila', () => {
    const rows = [
      row('a', { vuelo: 'AV9', fecha: '2026-10-03' }),
      row('b', { vuelo: 'LA40', fecha: '2026-10-03' }),
    ];
    const soon = new Date(NOW + 10 * MINUTE).toISOString();
    const past = new Date(NOW - MINUTE).toISOString();
    const plan = planLookup(
      spec(),
      FIELDS,
      rows,
      new Map([
        ['a', { next_at: soon, fail_count: 0 }],
        ['b', { next_at: past, fail_count: 0 }],
      ]),
      NOW,
    );
    expect(plan.calls.map((c) => c.rowId)).toEqual(['b']);
    expect(plan.skipped.notDue).toBe(1);
    expect(plan.nextDueMs).toBe(NOW + 10 * MINUTE);
  });
});

describe('intervalo adaptativo «cerca de»', () => {
  const near = {
    field: 'hora_estimada',
    beforeMinutes: 120,
    afterMinutes: 60,
    everyMinutes: 5,
    outside: 'base' as const,
  };

  it('dentro de la ventana cada 5 min; fuera, al intervalo base', () => {
    const s = spec({ near });
    // Llega a las 11:00 (en 1 h): dentro. A las 20:00: fuera.
    expect(cadenceFor(s, { hora_estimada: '2026-10-03 11:00' }, NOW)).toMatchObject({
      eligible: true,
      intervalMinutes: 5,
      inWindow: true,
    });
    const out = cadenceFor(s, { hora_estimada: '2026-10-03 20:00' }, NOW);
    expect(out).toMatchObject({ eligible: true, intervalMinutes: 30, inWindow: false });
    // La ventana abre 2 h antes de las 20:00.
    expect(out.opensAt).toBe(Date.parse('2026-10-04T01:00:00Z') - 120 * MINUTE + 0);
  });

  it('la ventana también cubre un rato DESPUÉS de la hora, y luego se cierra', () => {
    const s = spec({ near });
    expect(cadenceFor(s, { hora_estimada: '2026-10-03 09:30' }, NOW).inWindow).toBe(true);
    expect(cadenceFor(s, { hora_estimada: '2026-10-03 08:30' }, NOW).inWindow).toBe(false);
  });

  it('con outside=skip las filas fuera de la ventana no se consultan', () => {
    const s = spec({ near: { ...near, outside: 'skip' } });
    const plan = planLookup(
      s,
      FIELDS,
      [
        row('a', { vuelo: 'AV9', fecha: '2026-10-03', hora_estimada: '2026-10-03 11:00' }),
        row('b', { vuelo: 'LA40', fecha: '2026-10-03', hora_estimada: '2026-10-03 20:00' }),
        row('c', { vuelo: 'CM1', fecha: '2026-10-03' }),
      ],
      none,
      NOW,
    );
    expect(plan.calls.map((c) => c.rowId)).toEqual(['a']);
    expect(plan.skipped.window).toBe(2);
    // La ventana de «b» abre a las 18:00 de Bogotá.
    expect(plan.nextDueMs).toBe(Date.parse('2026-10-03T23:00:00Z'));
  });

  it('las filas dentro de la ventana pasan primero cuando el tope aprieta', () => {
    const s = spec({ near, per_run_cap: 1 });
    const plan = planLookup(
      s,
      FIELDS,
      [
        row('lejos', { vuelo: 'LA40', fecha: '2026-10-03', hora_estimada: '2026-10-03 20:00' }),
        row('cerca', { vuelo: 'AV9', fecha: '2026-10-03', hora_estimada: '2026-10-03 11:00' }),
      ],
      none,
      NOW,
    );
    expect(plan.calls.map((c) => c.rowId)).toEqual(['cerca']);
    expect(plan.deferred).toBe(1);
    expect(plan.capped).toBe('run');
  });

  it('tras consultar: al abrirse la ventana antes del siguiente intervalo, toca cuando abre', () => {
    const s = spec({ near, base_interval_minutes: 60 });
    // Llega a las 12:30; la ventana abre a las 10:30 (en 30 min), antes de los 60 del intervalo.
    expect(nextAtAfter(s, { hora_estimada: '2026-10-03 12:30' }, NOW, 0)).toBe(NOW + 30 * MINUTE);
    // Dentro de la ventana: cada 5 min.
    expect(nextAtAfter(s, { hora_estimada: '2026-10-03 11:00' }, NOW, 0)).toBe(NOW + 5 * MINUTE);
    // Sin hora: intervalo base.
    expect(nextAtAfter(s, {}, NOW, 0)).toBe(NOW + 60 * MINUTE);
  });

  it('los fallos seguidos espacian el reintento (×2 por fallo, hasta ×8 y 2 h)', () => {
    const s = spec({ base_interval_minutes: 10 });
    expect(nextAtAfter(s, {}, NOW, 1)).toBe(NOW + 20 * MINUTE);
    expect(nextAtAfter(s, {}, NOW, 2)).toBe(NOW + 40 * MINUTE);
    expect(nextAtAfter(s, {}, NOW, 9)).toBe(NOW + 80 * MINUTE);
    expect(nextAtAfter(spec({ base_interval_minutes: 60 }), {}, NOW, 5)).toBe(NOW + 120 * MINUTE);
  });
});

describe('topes de consultas', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => row(`r${i}`, { vuelo: `AV${i}`, fecha: '2026-10-03' }));

  it('tope por corrida', () => {
    const plan = planLookup(spec({ per_run_cap: 3 }), FIELDS, many(10), none, NOW);
    expect(plan.calls).toHaveLength(3);
    expect(plan.deferred).toBe(7);
    expect(plan.capped).toBe('run');
  });

  it('tope diario: sólo lo que queda del día', () => {
    const plan = planLookup(
      spec({ daily_cap: 10, calls_today: 8, calls_day: '2026-10-03' }),
      FIELDS,
      many(5),
      none,
      NOW,
    );
    expect(plan.callsToday).toBe(8);
    expect(plan.calls).toHaveLength(2);
    expect(plan.capped).toBe('daily');
  });

  it('con el tope del día gastado no se consulta nada', () => {
    const plan = planLookup(
      spec({ daily_cap: 10, calls_today: 10, calls_day: '2026-10-03' }),
      FIELDS,
      many(5),
      none,
      NOW,
    );
    expect(plan.calls).toHaveLength(0);
    expect(plan.capped).toBe('daily');
  });

  it('sin filas pendientes no hay «tope alcanzado» aunque el día esté gastado', () => {
    const plan = planLookup(
      spec({ daily_cap: 10, calls_today: 10, calls_day: '2026-10-03' }),
      FIELDS,
      [],
      none,
      NOW,
    );
    expect(plan.capped).toBeNull();
  });

  it('el contador se reinicia a medianoche de Bogotá, no de UTC', () => {
    const s = spec({ daily_cap: 10, calls_today: 10, calls_day: '2026-10-03' });
    // 23:59:59 del 3 en Bogotá = 04:59:59Z del 4: sigue siendo el día 3, tope gastado.
    const before = Date.parse('2026-10-04T04:59:59Z');
    expect(bogotaDay(before)).toBe('2026-10-03');
    expect(planLookup(s, FIELDS, many(2), none, before).calls).toHaveLength(0);
    // 00:00:01 del 4 en Bogotá: contador en cero.
    const after = Date.parse('2026-10-04T05:00:01Z');
    expect(bogotaDay(after)).toBe('2026-10-04');
    const plan = planLookup(
      s,
      FIELDS,
      many(2).map((r) => ({ ...r, values: { ...r.values, fecha: '2026-10-04' } })),
      none,
      after,
    );
    expect(plan.callsToday).toBe(0);
    expect(plan.calls).toHaveLength(2);
  });

  it('el próximo reinicio es la medianoche de Bogotá', () => {
    expect(nextResetMs(NOW)).toBe(Date.parse('2026-10-04T05:00:00Z'));
    expect(nextResetMs(Date.parse('2026-10-04T04:59:00Z'))).toBe(
      Date.parse('2026-10-04T05:00:00Z'),
    );
  });
});

describe('de la respuesta a las columnas', () => {
  const body = {
    status: 'Active',
    arrival: { estimated: '2026-10-03T16:45:00Z', terminal: 'T1', gate: null },
    flights: [{ code: 'AV9' }, { code: 'AV10' }],
    weight: '12,5',
    nested: { deep: { value: true } },
  };

  it('toma los caminos con puntos y los pasa a la forma de cada columna', () => {
    const mapped = mapResponse(
      body,
      [
        { path: 'status', field: 'estado', translate: { active: 'en vuelo' } },
        { path: 'arrival.estimated', field: 'hora_estimada' },
        { path: 'flights[1].code', field: 'vuelo' },
        { path: '$.weight', field: 'peso' },
      ],
      FIELDS,
    );
    expect(mapped.values).toEqual({
      estado: 'en vuelo',
      // 16:45Z = 11:45 en Bogotá.
      hora_estimada: '2026-10-03 11:45',
      vuelo: 'AV10',
      peso: 12.5,
    });
    expect(mapped.absent).toEqual([]);
  });

  it('lo que la respuesta no trae (o trae nulo) queda como ausente y no se escribe', () => {
    const mapped = mapResponse(
      body,
      [
        { path: 'arrival.gate', field: 'estado' },
        { path: 'nope.x', field: 'vuelo' },
        { path: 'arrival.terminal', field: 'vuelo' },
      ],
      FIELDS,
    );
    expect(mapped.values).toEqual({ vuelo: 'T1' });
    expect(mapped.absent).toEqual(['arrival.gate', 'nope.x']);
  });

  it('un valor nuevo en un campo de opciones se reporta para ampliar las opciones', () => {
    const mapped = mapResponse({ s: 'aterrizado' }, [{ path: 's', field: 'fase' }], FIELDS);
    expect(mapped.values).toEqual({ fase: 'aterrizado' });
    expect(mapped.newOptions).toEqual({ fase: ['aterrizado'] });
    expect(
      mapResponse({ s: 'en vuelo' }, [{ path: 's', field: 'fase' }], FIELDS).newOptions,
    ).toEqual({});
  });

  it('no sigue caminos peligrosos ni índices fuera de rango', () => {
    expect(mapResponse(body, [{ path: 'flights.9.code', field: 'vuelo' }], FIELDS).values).toEqual(
      {},
    );
    expect(mapResponse({}, [{ path: 'constructor.name', field: 'vuelo' }], FIELDS).values).toEqual(
      {},
    );
  });

  it('un objeto no es un valor de celda', () => {
    expect(mapResponse(body, [{ path: 'arrival', field: 'estado' }], FIELDS).values).toEqual({});
  });
});
