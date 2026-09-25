import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { normalizeApiFeed, registerFeedSourceCapture } from './api-source';

describe('API sources for Feed', () => {
  it('normalizes arrays of objects with stable first-seen columns and nested JSON as text', () => {
    const result = normalizeApiFeed([
      { id: '001', customer: { name: 'Ana' } },
      { customer: { name: 'Beto' }, amount: 20 },
    ]);
    expect(result.tables).toEqual([
      {
        name: 'API',
        rows: [
          ['id', 'customer', 'amount'],
          ['001', '{"name":"Ana"}', null],
          [null, '{"name":"Beto"}', 20],
        ],
      },
    ]);
  });

  it('keeps non-tabular responses as bounded text', () => {
    expect(normalizeApiFeed({ status: 'ok' })).toMatchObject({
      text: '{\n  "status": "ok"\n}',
      truncated: false,
    });
  });

  it('reports missing columns in later records and shortened cells', () => {
    expect(
      normalizeApiFeed([
        { id: 1 },
        Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`column${i}`, i])),
      ]).truncated,
    ).toBe(true);
    expect(normalizeApiFeed([{ description: 'a'.repeat(4001) }]).truncated).toBe(true);
  });

  it('caps rows and reports truncation', () => {
    const result = normalizeApiFeed(Array.from({ length: 1001 }, (_, id) => ({ id })));
    expect(result.tables?.[0]?.rows).toHaveLength(1001); // header + 1000 records
    expect(result.truncated).toBe(true);
  });
});

describe('Feed source persistence failures', () => {
  it('does not report a saved connection when the pointer update fails', async () => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: { id: 'source' }, error: null }),
      update: () => ({ eq: async () => ({ error: { message: 'write failed' } }) }),
    };
    const db = { from: () => query } as unknown as SupabaseClient;
    await expect(
      registerFeedSourceCapture({
        db,
        actorId: 'actor',
        kind: 'file',
        name: 'data.csv',
        config: { filename: 'data.csv' },
        attachmentId: 'capture',
      }),
    ).rejects.toThrow('actualizar la conexión');
  });
});

describe('respuestas de API de vuelos como tabla', () => {
  it('encuentra la lista dentro de data (AviationStack, Flightradar24)', () => {
    const out = normalizeApiFeed({
      pagination: { total: 2 },
      data: [
        {
          flight: { iata: 'AV9' },
          arrival: { iata: 'BOG', actual: null },
          flight_status: 'active',
        },
        {
          flight: { iata: 'LA40' },
          arrival: { iata: 'BOG', actual: '2026-09-25T10:00' },
          flight_status: 'landed',
        },
      ],
    });
    expect(out.tables?.[0]?.rows[0]).toEqual([
      'flight.iata',
      'arrival.iata',
      'arrival.actual',
      'flight_status',
    ]);
    expect(out.tables?.[0]?.rows[2]).toEqual(['LA40', 'BOG', '2026-09-25T10:00', 'landed']);
  });

  it('usa nombres de columna para listas sin nombres (OpenSky)', () => {
    const out = normalizeApiFeed(
      { time: 1, states: [['abc123', 'AVA9   ', 'Colombia']] },
      { recordsPath: 'states', columns: ['icao24', 'callsign', 'pais'] },
    );
    expect(out.tables?.[0]?.rows).toEqual([
      ['icao24', 'callsign', 'pais'],
      ['abc123', 'AVA9   ', 'Colombia'],
    ]);
  });

  it('no adivina entre dos listas del mismo tamaño', () => {
    const out = normalizeApiFeed({ a: [{ x: 1 }], b: [{ y: 2 }] });
    expect(out.tables).toBeUndefined();
  });
});
