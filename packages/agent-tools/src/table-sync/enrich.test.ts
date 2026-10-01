import { describe, expect, it } from 'vitest';
import { applyUpdateOnly, matchPart } from './enrich';

describe('cruzar vuelos con guías', () => {
  it('un vuelo se escribe de muchas formas y sigue siendo el mismo', () => {
    expect(matchPart('av 009', 'text')).toBe('AV9');
    expect(matchPart('AV-9', 'text')).toBe('AV9');
    expect(matchPart('045-12345678', 'text')).toBe('04512345678');
    expect(matchPart('25/09/2026', 'date')).toBe('2026-09-25');
    expect(matchPart('2026-09-25T15:05:00Z', 'date')).toBe('2026-09-25');
  });

  it('actualiza todas las guías del vuelo, sólo las columnas pedidas, sin agregar filas', async () => {
    const tracker = {
      id: 't1',
      slug: 'guias',
      name: 'Guías',
      description: '',
      fields: [
        { key: 'guia', label: 'Guía', type: 'text', required: true },
        { key: 'vuelo', label: 'Vuelo', type: 'text', required: false },
        { key: 'fecha_vuelo', label: 'Fecha', type: 'date', required: false },
        { key: 'estado_vuelo', label: 'Estado del vuelo', type: 'text', required: false },
      ],
    };
    const rows = [
      { id: 'r1', values: { guia: '045-1', vuelo: 'AV 009', fecha_vuelo: '2026-09-25' } },
      {
        id: 'r2',
        values: { guia: '045-2', vuelo: 'AV9', fecha_vuelo: '2026-09-25', estado_vuelo: 'active' },
      },
      { id: 'r3', values: { guia: '045-3', vuelo: 'LA40', fecha_vuelo: '2026-09-25' } },
    ];
    const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
    let inserted = 0;
    const db = {
      from(table: string) {
        const q: Record<string, unknown> = {};
        let pendingUpdate: Record<string, unknown> | null = null;
        const chain = {
          select: () => chain,
          eq: (col: string, val: string) => {
            if (pendingUpdate && col === 'id')
              updates.push({ id: val, values: pendingUpdate.values as Record<string, unknown> });
            return chain;
          },
          order: () => chain,
          limit: () => Promise.resolve({ data: table === 'tracker_rows' ? rows : [], error: null }),
          maybeSingle: () =>
            Promise.resolve({ data: table === 'trackers' ? tracker : null, error: null }),
          update: (v: Record<string, unknown>) => {
            pendingUpdate = v;
            return {
              eq: (c: string, val: string) => {
                updates.push({ id: val, values: v.values as Record<string, unknown> });
                return { eq: () => Promise.resolve({ error: null }) };
              },
            };
          },
          insert: () => {
            inserted += 1;
            return Promise.resolve({ error: null });
          },
        };
        void q;
        return chain;
      },
    } as never;
    const sheet = {
      name: 'API',
      rows: [
        ['flight.iata', 'flight_date', 'flight_status'],
        ['AV9', '2026-09-25', 'landed'],
        ['IB6584', '2026-09-25', 'active'],
      ],
    };
    const outcome = await applyUpdateOnly(
      db,
      {
        tracker_id: 't1',
        created_by: 'u',
        key_fields: ['vuelo', 'fecha_vuelo'],
        mapping: {
          vuelo: 'flight.iata',
          fecha_vuelo: 'flight_date',
          estado_vuelo: 'flight_status',
        },
      },
      sheet,
    );
    expect(outcome.updated).toBe(2);
    expect(updates.map((u) => u.id).sort()).toEqual(['r1', 'r2']);
    expect(updates.every((u) => u.values.estado_vuelo === 'landed')).toBe(true);
    // El vuelo que no trae carga de nadie no entra a la tabla.
    expect(inserted).toBe(0);
  });
});
