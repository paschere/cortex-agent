import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import {
  type LookupFetcher,
  type LookupHttpResult,
  describeCredentialProblem,
  previewLookup,
  runRowLookup,
} from './run';
import { MINUTE } from './time';
import { LOOKUP_COLUMNS, type RowLookupRow } from './types';

// 2026-10-03 10:00 en Bogotá.
const NOW = Date.parse('2026-10-03T15:00:00Z');
const ORG = 'org-a';
const USER = '11111111-1111-4111-8111-111111111111';

const FIELDS = [
  { key: 'guia', label: 'Guía', type: 'text', required: false },
  { key: 'vuelo', label: 'Vuelo', type: 'text', required: false },
  { key: 'fecha', label: 'Fecha', type: 'date', required: false },
  { key: 'estado', label: 'Estado', type: 'text', required: false },
  { key: 'hora_estimada', label: 'Hora estimada', type: 'text', required: false },
  { key: 'notas', label: 'Notas', type: 'text', required: false },
];

function lookup(over: Partial<RowLookupRow> = {}): RowLookupRow {
  return {
    id: 'l1',
    tracker_id: 't1',
    name: 'Estado del vuelo',
    url_template: 'https://api.ejemplo.com/vuelos/{vuelo}/{fecha:YYYY-MM-DD}',
    credential_tool_id: null,
    credential_name: null,
    mapping: [
      { path: 'status', field: 'estado', translate: { landed: 'aterrizado', active: 'en vuelo' } },
      { path: 'arrival.estimated', field: 'hora_estimada' },
    ],
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
    enabled: true,
    created_by: USER,
    next_run_at: new Date(NOW).toISOString(),
    last_run_at: null,
    last_status: null,
    last_error: null,
    last_calls: 0,
    last_updated: 0,
    calls_today: 0,
    calls_day: null,
    ...over,
  };
}

function world(
  opts: { lookup?: Partial<RowLookupRow>; rows?: Array<Record<string, unknown>> } = {},
) {
  const l = lookup(opts.lookup);
  const fake = createFakeSupabase({
    trackers: [
      {
        id: 't1',
        organization_id: ORG,
        slug: 'llegadas',
        name: 'Llegadas',
        description: '',
        fields: FIELDS,
        created_by: USER,
        created_at: 'x',
        updated_at: 'x',
      },
    ],
    tracker_rows: (
      opts.rows ?? [
        { id: 'r1', values: { guia: 'G1', vuelo: 'AV9', fecha: '2026-10-03', notas: 'urgente' } },
        {
          id: 'r2',
          values: { guia: 'G2', vuelo: 'LA40', fecha: '2026-10-03', estado: 'aterrizado' },
        },
        { id: 'r3', values: { guia: 'G3', vuelo: 'CM1', fecha: '2026-10-02' } },
        { id: 'r4', values: { guia: 'G4', fecha: '2026-10-03' } },
      ]
    ).map((r) => ({
      organization_id: ORG,
      tracker_id: 't1',
      label: String((r.values as Record<string, unknown>).guia),
      created_at: 'x',
      updated_at: 'x',
      ...r,
    })),
    row_lookups: [{ ...l, organization_id: ORG }],
    row_lookup_state: [],
    audit_events: [],
    custom_tools: [],
  });
  return { fake, db: createOrgScopedClient(fake.client, ORG), lookup: l };
}

function fetcher(answer: (url: string) => LookupHttpResult) {
  const urls: string[] = [];
  const fn: LookupFetcher = async (url) => {
    urls.push(url);
    return answer(url);
  };
  return { fn, urls };
}

const ok = (body: unknown): LookupHttpResult => ({ ok: true, data: body });
const clock = { now: () => NOW };

describe('una vuelta de la consulta por fila', () => {
  it('consulta sólo las filas que tocan y escribe sólo las columnas del mapeo', async () => {
    const w = world();
    const f = fetcher(() =>
      ok({ status: 'active', arrival: { estimated: '2026-10-03T16:45:00Z' } }),
    );
    const out = await runRowLookup(w.db, w.lookup, { ...clock, fetcher: f.fn });

    // r2 ya aterrizó (regla de parada), r3 es de ayer, r4 no tiene vuelo.
    expect(f.urls).toEqual(['https://api.ejemplo.com/vuelos/AV9/2026-10-03']);
    expect(out).toMatchObject({ status: 'ok', calls: 1, updated: 1, errors: 0 });

    const r1 = w.fake.tables.tracker_rows?.find((r) => r.id === 'r1');
    expect(r1?.values).toEqual({
      guia: 'G1',
      vuelo: 'AV9',
      fecha: '2026-10-03',
      // El campo del equipo no se toca.
      notas: 'urgente',
      estado: 'en vuelo',
      hora_estimada: '2026-10-03 11:45',
    });
    // Las demás filas, intactas.
    expect(w.fake.tables.tracker_rows?.find((r) => r.id === 'r2')?.values).toEqual({
      guia: 'G2',
      vuelo: 'LA40',
      fecha: '2026-10-03',
      estado: 'aterrizado',
    });
  });

  it('deja auditoría del cambio, con qué cambió de qué a qué, y la lee el historial de la fila', async () => {
    const w = world();
    const f = fetcher(() => ok({ status: 'active' }));
    await runRowLookup(w.db, w.lookup, { ...clock, fetcher: f.fn });
    const audit = w.fake.tables.audit_events ?? [];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tool_id: 'trackers.row_lookup',
      status: 'ok',
      surface: 'schedule',
      user_id: USER,
    });
    expect(audit[0]?.metadata).toMatchObject({
      lookup: 'Estado del vuelo',
      rowIds: ['r1'],
      changes: { estado: { from: null, to: 'en vuelo' } },
    });
  });

  it('agenda la siguiente consulta de cada fila, cuenta las del día y no repite antes de tiempo', async () => {
    const w = world();
    const f = fetcher(() => ok({ status: 'active' }));
    await runRowLookup(w.db, w.lookup, { ...clock, fetcher: f.fn });

    const state = w.fake.tables.row_lookup_state ?? [];
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({ row_id: 'r1', last_status: 'ok', fail_count: 0 });
    expect(Date.parse(String(state[0]?.next_at))).toBe(NOW + 30 * MINUTE);

    const stored = w.fake.tables.row_lookups?.[0];
    expect(stored).toMatchObject({
      calls_today: 1,
      calls_day: '2026-10-03',
      last_status: 'ok',
      last_calls: 1,
      last_updated: 1,
    });
    // Corre de nuevo entre 5 y 15 minutos.
    const next = Date.parse(String(stored?.next_run_at));
    expect(next).toBeGreaterThanOrEqual(NOW + 5 * MINUTE);
    expect(next).toBeLessThanOrEqual(NOW + 15 * MINUTE);

    // Otra vuelta enseguida: ninguna fila toca, ninguna llamada.
    const again = await runRowLookup(w.db, { ...w.lookup, ...(stored as object) } as RowLookupRow, {
      ...clock,
      fetcher: f.fn,
    });
    expect(again.calls).toBe(0);
    expect(f.urls).toHaveLength(1);
  });

  it('tope diario: se detiene, avisa una vez (llave por día) y se retoma a medianoche de Bogotá', async () => {
    const w = world({
      lookup: { daily_cap: 1 },
      rows: [
        { id: 'r1', values: { guia: 'G1', vuelo: 'AV9', fecha: '2026-10-03' } },
        { id: 'r2', values: { guia: 'G2', vuelo: 'LA40', fecha: '2026-10-03' } },
      ],
    });
    const f = fetcher(() => ok({ status: 'active' }));
    const out = await runRowLookup(w.db, w.lookup, { ...clock, fetcher: f.fn });
    expect(f.urls).toHaveLength(1);
    expect(out.status).toBe('capped');
    expect(out.capped).toBe('daily');
    expect(out.notices).toEqual([
      expect.objectContaining({ dedupeKey: 'row_lookup_cap:l1:2026-10-03' }),
    ]);
    const stored = w.fake.tables.row_lookups?.[0];
    expect(stored?.calls_today).toBe(1);
    expect(Date.parse(String(stored?.next_run_at))).toBe(Date.parse('2026-10-04T05:00:00Z'));
  });

  it('tope por corrida: las demás quedan para la siguiente vuelta, sin aviso', async () => {
    const w = world({
      lookup: { per_run_cap: 1 },
      rows: [
        { id: 'r1', values: { guia: 'G1', vuelo: 'AV9', fecha: '2026-10-03' } },
        { id: 'r2', values: { guia: 'G2', vuelo: 'LA40', fecha: '2026-10-03' } },
      ],
    });
    const f = fetcher(() => ok({ status: 'active' }));
    const out = await runRowLookup(w.db, w.lookup, { ...clock, fetcher: f.fn });
    expect(f.urls).toHaveLength(1);
    expect(out.capped).toBe('run');
    expect(out.notices).toEqual([]);
    const next = Date.parse(String(w.fake.tables.row_lookups?.[0]?.next_run_at));
    expect(next).toBe(NOW + 5 * MINUTE);
  });

  it('al cambiar el día el contador vuelve a cero', async () => {
    const w = world({ lookup: { daily_cap: 5, calls_today: 5, calls_day: '2026-10-02' } });
    const f = fetcher(() => ok({ status: 'active' }));
    const out = await runRowLookup(w.db, w.lookup, { ...clock, fetcher: f.fn });
    expect(out.calls).toBe(1);
    expect(w.fake.tables.row_lookups?.[0]).toMatchObject({
      calls_today: 1,
      calls_day: '2026-10-03',
    });
  });

  it('un 429 detiene la vuelta y la pospone al menos 15 minutos', async () => {
    const w = world({
      rows: [
        { id: 'r1', values: { guia: 'G1', vuelo: 'AV9', fecha: '2026-10-03' } },
        { id: 'r2', values: { guia: 'G2', vuelo: 'LA40', fecha: '2026-10-03' } },
        { id: 'r3', values: { guia: 'G3', vuelo: 'CM1', fecha: '2026-10-03' } },
      ],
    });
    const f = fetcher(() => ({
      ok: false,
      status: 429,
      message: 'rate limited',
      retryAfterMs: 60_000,
    }));
    const out = await runRowLookup(w.db, w.lookup, { ...clock, fetcher: f.fn, concurrency: 1 });
    expect(f.urls).toHaveLength(1);
    expect(out.status).toBe('error');
    expect(out.message).toMatch(/429/);
    const next = Date.parse(String(w.fake.tables.row_lookups?.[0]?.next_run_at));
    expect(next).toBe(NOW + 15 * MINUTE);
    // Esa fila queda con un fallo y se espacia.
    expect(w.fake.tables.row_lookup_state?.[0]).toMatchObject({
      last_status: 'error',
      fail_count: 1,
    });
  });

  it('un 401 detiene la vuelta, avisa y espera una hora', async () => {
    const w = world();
    const f = fetcher(() => ({ ok: false, status: 401, message: 'bad key' }));
    const out = await runRowLookup(w.db, w.lookup, { ...clock, fetcher: f.fn });
    expect(out.status).toBe('error');
    expect(out.notices).toHaveLength(1);
    expect(out.notices[0]?.body).not.toMatch(/bad key/);
    expect(Date.parse(String(w.fake.tables.row_lookups?.[0]?.next_run_at))).toBe(NOW + 60 * MINUTE);
  });

  it('un 404 es «todavía no hay dato»: no cambia la fila, se espacia y no es una falla de la consulta', async () => {
    const w = world();
    const f = fetcher(() => ({ ok: false, status: 404, message: 'not found' }));
    const out = await runRowLookup(w.db, w.lookup, { ...clock, fetcher: f.fn });
    expect(out.status).toBe('ok');
    expect(out.updated).toBe(0);
    expect(w.fake.tables.row_lookup_state?.[0]).toMatchObject({
      last_status: 'no_data',
      fail_count: 1,
    });
    expect(w.fake.tables.audit_events ?? []).toHaveLength(0);
  });

  it('una respuesta sin los datos del mapeo no escribe nada', async () => {
    const w = world();
    const f = fetcher(() => ok({ otra: 'cosa' }));
    const out = await runRowLookup(w.db, w.lookup, { ...clock, fetcher: f.fn });
    expect(out.updated).toBe(0);
    expect(w.fake.tables.row_lookup_state?.[0]).toMatchObject({ last_status: 'no_data' });
  });

  it('si el vuelo ya aterrizó la respuesta lo escribe y la fila deja de consultarse', async () => {
    const w = world();
    const f = fetcher(() => ok({ status: 'landed' }));
    await runRowLookup(w.db, w.lookup, { ...clock, fetcher: f.fn });
    expect(w.fake.tables.tracker_rows?.find((r) => r.id === 'r1')?.values).toMatchObject({
      estado: 'aterrizado',
    });
    // Mucho después, ya toca por tiempo: el filtro la deja fuera.
    const later = NOW + 3 * 60 * MINUTE;
    const again = await runRowLookup(w.db, w.lookup, { now: () => later, fetcher: f.fn });
    expect(again.calls).toBe(0);
    expect(f.urls).toHaveLength(1);
  });

  it('respeta lo que alguien editó mientras la API respondía (relee la fila antes de escribir)', async () => {
    const w = world();
    const f = fetcher(() => {
      // Mientras «llama a la API», alguien del equipo cambia las notas.
      const row = w.fake.tables.tracker_rows?.find((r) => r.id === 'r1');
      if (row) row.values = { ...(row.values as object), notas: 'cambiada por María' };
      return ok({ status: 'active' });
    });
    await runRowLookup(w.db, w.lookup, { ...clock, fetcher: f.fn });
    expect(w.fake.tables.tracker_rows?.find((r) => r.id === 'r1')?.values).toMatchObject({
      notas: 'cambiada por María',
      estado: 'en vuelo',
    });
  });

  it('una credencial de otro servidor no se usa: la llave no sale de su dominio', async () => {
    expect(
      describeCredentialProblem(
        {
          name: 'Otra API',
          http_method: 'GET',
          enabled: true,
          url_template: 'https://otra.com/x/{{id}}',
        },
        'https://api.ejemplo.com/vuelos/{vuelo}',
      ),
    ).toMatch(/sólo se envía a otra\.com/);
    expect(
      describeCredentialProblem(
        {
          name: 'AeroDataBox',
          http_method: 'GET',
          enabled: true,
          url_template: 'https://API.ejemplo.com/flights/{{id}}',
        },
        'https://api.ejemplo.com/vuelos/{vuelo}',
      ),
    ).toBeNull();
    expect(
      describeCredentialProblem(
        {
          name: 'Escribe',
          http_method: 'POST',
          enabled: true,
          url_template: 'https://api.ejemplo.com/x',
        },
        'https://api.ejemplo.com/vuelos/{vuelo}',
      ),
    ).toMatch(/lectura/);

    const w = world({ lookup: { credential_tool_id: 'c1' } });
    w.fake.tables.custom_tools?.push({
      id: 'c1',
      organization_id: ORG,
      slug: 'otra',
      name: 'Otra API',
      http_method: 'GET',
      url_template: 'https://otra.com/x',
      enabled: true,
      auth_type: 'none',
    });
    const f = fetcher(() => ok({ status: 'active' }));
    const out = await runRowLookup(w.db, w.lookup, { ...clock, fetcher: f.fn });
    expect(f.urls).toHaveLength(0);
    expect(out.status).toBe('error');
    expect(out.message).toMatch(/sólo se envía/);
  });

  it('si la credencial se borró, avisa en vez de seguir llamando sin llave', async () => {
    const w = world({ lookup: { credential_tool_id: null, credential_name: 'AeroDataBox' } });
    const f = fetcher(() => ok({ status: 'active' }));
    const out = await runRowLookup(w.db, w.lookup, { ...clock, fetcher: f.fn });
    expect(f.urls).toHaveLength(0);
    expect(out.message).toMatch(/AeroDataBox.*ya no existe/);
  });

  it('el tiempo máximo de la vuelta corta las llamadas que faltan', async () => {
    const w = world({
      rows: Array.from({ length: 6 }, (_, i) => ({
        id: `r${i}`,
        values: { guia: `G${i}`, vuelo: `AV${i}`, fecha: '2026-10-03' },
      })),
    });
    let t = NOW;
    const f = fetcher(() => {
      t += 20_000;
      return ok({ status: 'active' });
    });
    const out = await runRowLookup(w.db, w.lookup, {
      now: () => t,
      fetcher: f.fn,
      concurrency: 1,
      deadlineMs: 50_000,
    });
    // 3 llamadas caben antes de los 50 s; el resto queda para la próxima vuelta.
    expect(out.calls).toBe(3);
  });
});

describe('probar con una fila, sin escribir', () => {
  it('muestra lo que cambiaría y no toca la tabla', async () => {
    const w = world();
    const tracker = w.fake.tables.trackers?.[0] as never;
    const f = fetcher(() =>
      ok({ status: 'landed', arrival: { estimated: '2026-10-03T16:45:00Z' } }),
    );
    const preview = await previewLookup(w.db, {
      tracker: { ...(tracker as object), fields: FIELDS } as never,
      spec: {
        url_template: w.lookup.url_template,
        filter: w.lookup.filter,
        mapping: w.lookup.mapping,
        credential_tool_id: null,
      },
      now: NOW,
      fetcher: f.fn,
    });
    expect(preview).toMatchObject({ ok: true, rowId: 'r1', calls: 1 });
    expect(preview.url).toBe('https://api.ejemplo.com/vuelos/AV9/2026-10-03');
    expect(preview.fields).toEqual([
      { field: 'estado', label: 'Estado', current: null, next: 'aterrizado' },
      { field: 'hora_estimada', label: 'Hora estimada', current: null, next: '2026-10-03 11:45' },
    ]);
    expect(w.fake.tables.tracker_rows?.find((r) => r.id === 'r1')?.values).not.toHaveProperty(
      'estado',
    );
    expect(w.fake.tables.audit_events ?? []).toHaveLength(0);
  });

  it('si ninguna fila cumple el filtro lo dice y no llama a la API', async () => {
    const w = world({
      rows: [{ id: 'r1', values: { guia: 'G1', vuelo: 'AV9', fecha: '2026-09-01' } }],
    });
    const f = fetcher(() => ok({}));
    const preview = await previewLookup(w.db, {
      tracker: { ...(w.fake.tables.trackers?.[0] as object), fields: FIELDS } as never,
      spec: {
        url_template: w.lookup.url_template,
        filter: w.lookup.filter,
        mapping: w.lookup.mapping,
        credential_tool_id: null,
      },
      now: NOW,
      fetcher: f.fn,
    });
    expect(preview.ok).toBe(false);
    expect(preview.calls).toBe(0);
    expect(f.urls).toHaveLength(0);
  });
});

it('las columnas que se leen incluyen las de la migración', () => {
  for (const c of ['credential_name', 'calls_today', 'calls_day', 'per_run_cap', 'daily_cap'])
    expect(LOOKUP_COLUMNS).toContain(c);
});
