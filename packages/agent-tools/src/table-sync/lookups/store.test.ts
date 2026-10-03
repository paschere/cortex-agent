import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import type { LookupFetcher } from './run';
import {
  createRowLookup,
  resolveCredential,
  unknownTemplateFields,
  updateRowLookup,
} from './store';
import type { RowLookupRow } from './types';

const ORG = 'org-a';
const USER = '11111111-1111-4111-8111-111111111111';

const FIELDS = [
  { key: 'vuelo', label: 'Vuelo', type: 'text', required: false },
  { key: 'fecha', label: 'Fecha', type: 'date', required: false },
  { key: 'estado', label: 'Estado', type: 'text', required: false },
];

function world() {
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
    tracker_rows: [
      {
        id: 'r1',
        organization_id: ORG,
        tracker_id: 't1',
        label: 'AV9',
        values: { vuelo: 'AV9', fecha: new Date().toISOString().slice(0, 10) },
        created_at: 'x',
        updated_at: 'x',
      },
    ],
    row_lookups: [],
    row_lookup_state: [],
    custom_tools: [
      {
        id: 'c1',
        organization_id: ORG,
        slug: 'aerodatabox',
        name: 'AeroDataBox',
        http_method: 'GET',
        url_template: 'https://api.ejemplo.com/flights/{{id}}',
        enabled: true,
        auth_type: 'none',
      },
    ],
  });
  return { fake, db: createOrgScopedClient(fake.client, ORG) };
}

const base = {
  trackerSlug: 'llegadas',
  actorId: USER,
  name: 'Estado del vuelo',
  urlTemplate: 'https://api.ejemplo.com/vuelos/{vuelo}/{fecha:YYYY-MM-DD}',
  mapping: [{ path: 'status', field: 'estado' }],
};

const answering =
  (body: unknown): LookupFetcher =>
  async () => ({ ok: true, data: body });
const failing: LookupFetcher = async () => ({ ok: false, status: 500, message: 'caído' });

describe('crear una consulta', () => {
  it('guarda con topes por defecto y activa si la prueba con una fila funciona', async () => {
    const w = world();
    const out = await createRowLookup(w.db, {
      ...base,
      credential: 'aerodatabox',
      probe: true,
      fetcher: answering({ status: 'active' }),
    });
    expect(out.lookup).toMatchObject({
      enabled: true,
      daily_cap: 1000,
      per_run_cap: 100,
      base_interval_minutes: 30,
      credential_tool_id: 'c1',
      credential_name: 'AeroDataBox',
      calls_today: 1,
    });
    expect(out.preview?.ok).toBe(true);
  });

  it('si la API contesta mal la deja EN PAUSA para no gastar el tope', async () => {
    const w = world();
    const out = await createRowLookup(w.db, {
      ...base,
      credential: 'aerodatabox',
      probe: true,
      fetcher: failing,
    });
    expect(out.lookup.enabled).toBe(false);
    expect(out.preview).toMatchObject({ ok: false, calls: 1 });
  });

  it('agrega como texto las columnas nuevas del mapeo', async () => {
    const w = world();
    const out = await createRowLookup(w.db, {
      ...base,
      mapping: [{ path: 'arrival.estimated', field: 'hora_estimada', label: 'Hora estimada' }],
    });
    expect(out.added).toEqual(['Hora estimada']);
    expect(
      (w.fake.tables.trackers?.[0]?.fields as Array<{ key: string; type: string }>).find(
        (f) => f.key === 'hora_estimada',
      ),
    ).toMatchObject({ type: 'text' });
  });

  it('rechaza lo que no se puede revisar sin llamar a la API', async () => {
    const w = world();
    const bad = (over: Record<string, unknown>) =>
      createRowLookup(w.db, { ...base, ...over } as never);
    await expect(bad({ urlTemplate: 'https://a.co/{nada}' })).rejects.toThrow(/no son columnas/);
    await expect(bad({ urlTemplate: 'http://a.co/{vuelo}' })).rejects.toThrow(/https/);
    await expect(
      bad({ filter: { match: 'all', filters: [{ key: 'zzz', op: 'empty' }] } }),
    ).rejects.toThrow(/filtro usa/);
    await expect(
      bad({
        near: { field: 'zzz', beforeMinutes: 1, afterMinutes: 1, everyMinutes: 5, outside: 'base' },
      }),
    ).rejects.toThrow(/cerca de/);
    await expect(bad({ baseIntervalMinutes: 2 })).rejects.toThrow(/5 a 1440/);
    // La llave no sale de su dominio.
    await expect(
      bad({ credential: 'aerodatabox', urlTemplate: 'https://otro.com/{vuelo}' }),
    ).rejects.toThrow(/sólo se envía a api\.ejemplo\.com/);
    await expect(bad({ credential: 'nada' })).rejects.toBeInstanceOf(Error);
    await expect(bad({ trackerSlug: 'fantasma' })).rejects.toThrow(/No hay una tabla/);
    expect(w.fake.tables.row_lookups).toHaveLength(0);
  });

  it('los campos de la dirección que la tabla no tiene', () => {
    expect(
      unknownTemplateFields('https://a.co/{vuelo}/{hoy}/{ahora}/{peso}', FIELDS as never),
    ).toEqual(['peso']);
  });
});

describe('credenciales', () => {
  it('se eligen por slug o por nombre, sin traer la llave', async () => {
    const w = world();
    expect((await resolveCredential(w.db, 'aerodatabox')).id).toBe('c1');
    expect((await resolveCredential(w.db, 'aero')).id).toBe('c1');
    await expect(resolveCredential(w.db, 'zzz')).rejects.toThrow(/Herramientas propias/);
  });
});

describe('cambiar una consulta', () => {
  async function created() {
    const w = world();
    const { lookup } = await createRowLookup(w.db, { ...base });
    // La base de mentira no pone el id: se lo damos a la fila guardada.
    const stored = w.fake.tables.row_lookups?.[0];
    if (stored) stored.id = 'l1';
    return { w, lookup: { ...lookup, id: 'l1' } as RowLookupRow };
  }

  it('pausar y reanudar; reanudar la deja tocar ya', async () => {
    const { w, lookup } = await created();
    const paused = await updateRowLookup(w.db, lookup, { enabled: false }, USER);
    expect(paused.lookup.enabled).toBe(false);
    const resumed = await updateRowLookup(w.db, paused.lookup, { enabled: true }, USER);
    expect(resumed.lookup.enabled).toBe(true);
  });

  it('cambiar el tope diario valida el rango y deja correr de nuevo', async () => {
    const { w, lookup } = await created();
    await expect(updateRowLookup(w.db, lookup, { dailyCap: 0 }, USER)).rejects.toThrow(
      /1 a 100\.000/,
    );
    const out = await updateRowLookup(w.db, lookup, { dailyCap: 2000 }, USER);
    expect(out.lookup.daily_cap).toBe(2000);
  });

  it('cambiar la dirección o el filtro hace que todas las filas vuelvan a tocar', async () => {
    const { w, lookup } = await created();
    w.fake.tables.row_lookup_state?.push({
      organization_id: ORG,
      lookup_id: 'l1',
      row_id: 'r1',
      next_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await updateRowLookup(w.db, lookup, { baseIntervalMinutes: 10 }, USER);
    expect(w.fake.tables.row_lookup_state).toHaveLength(1);
    await updateRowLookup(
      w.db,
      lookup,
      {
        filter: { match: 'all', filters: [{ key: 'estado', op: 'not_in', value: ['aterrizado'] }] },
      },
      USER,
    );
    expect(w.fake.tables.row_lookup_state).toHaveLength(0);
  });
});
