import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FINGERPRINT_TTL_MS,
  type LiveTable,
  changedTables,
  clearFingerprintMemo,
  fingerprintOf,
  memoFingerprint,
  parseLiveTables,
  readFingerprint,
} from './live';

/** Una base de mentira: registra los filtros y devuelve la cuenta y la fila más reciente. */
function fakeDb(result: { count: number; updated_at?: string }) {
  const calls: Array<{ filters: Array<[string, unknown]>; select: unknown[] }> = [];
  const db = {
    from: (table: string) => {
      expect(table).toBe('tracker_rows');
      const rec = { filters: [] as Array<[string, unknown]>, select: [] as unknown[] };
      calls.push(rec);
      const q: Record<string, unknown> = {
        select: (...a: unknown[]) => {
          rec.select = a;
          return q;
        },
        eq: (k: string, v: unknown) => {
          rec.filters.push([k, v]);
          return q;
        },
        order: () => q,
        limit: async () => ({
          data: result.updated_at ? [{ updated_at: result.updated_at }] : [],
          count: result.count,
          error: null,
        }),
      };
      return q;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const table = (over: Partial<LiveTable> = {}): LiveTable => ({
  slug: 'vuelos',
  trackerId: 't1',
  scope: { kind: 'all' },
  ...over,
});

beforeEach(() => clearFingerprintMemo());

describe('huella', () => {
  it('une cuenta y última modificación', () => {
    expect(fingerprintOf(3, '2026-01-01')).toBe('3|2026-01-01');
    expect(fingerprintOf(0, null)).toBe('0|');
  });

  it('avisa solo de lo que cambió; la primera toma solo fija la base', () => {
    const base = new Map([
      ['a', '1|x'],
      ['b', '2|y'],
    ]);
    expect(changedTables(new Map(), base)).toEqual([]);
    expect(
      changedTables(
        base,
        new Map([
          ['a', '1|x'],
          ['b', '3|z'],
        ]),
      ),
    ).toEqual(['b']);
    // Un borrado cambia la cuenta aunque la fecha más reciente sea la misma.
    expect(changedTables(new Map([['a', '5|x']]), new Map([['a', '4|x']]))).toEqual(['a']);
    expect(changedTables(base, base)).toEqual([]);
  });

  it('limpia el parámetro tables: sin vacíos, sin repetidos, con tope', () => {
    expect(parseLiveTables(' a, b,,a ,c')).toEqual(['a', 'b', 'c']);
    expect(parseLiveTables(null)).toEqual([]);
    expect(parseLiveTables(Array.from({ length: 40 }, (_, i) => `t${i}`).join(',')).length).toBe(
      12,
    );
    expect(parseLiveTables('x'.repeat(81))).toEqual([]);
  });
});

describe('readFingerprint', () => {
  it('cuenta y fecha en una sola consulta', async () => {
    const { db, calls } = fakeDb({ count: 7, updated_at: '2026-02-02T00:00:00Z' });
    expect(await readFingerprint(db, table())).toBe('7|2026-02-02T00:00:00Z');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.filters).toEqual([['tracker_id', 't1']]);
    expect(calls[0]?.select[1]).toEqual({ count: 'exact' });
  });

  it('aplica el alcance de quien mira: lo que no ve no mueve su huella', async () => {
    const own = fakeDb({ count: 1, updated_at: 'u' });
    await readFingerprint(own.db, table({ scope: { kind: 'own', userId: 'u1' } }));
    expect(own.calls[0]?.filters).toContainEqual(['created_by', 'u1']);
    const ext = fakeDb({ count: 1, updated_at: 'u' });
    await readFingerprint(ext.db, table({ scope: { kind: 'own', userId: 'x1', external: true } }));
    expect(ext.calls[0]?.filters).toContainEqual(['created_by_app_user', 'x1']);
    const eq = fakeDb({ count: 1, updated_at: 'u' });
    await readFingerprint(
      eq.db,
      table({ scope: { kind: 'equals', field: 'cliente', value: 'Acme' } }),
    );
    expect(eq.calls[0]?.filters).toContainEqual(['values->>cliente', 'Acme']);
  });

  it('un alcance «igual a» sin valor no consulta nada', async () => {
    const { db, calls } = fakeDb({ count: 9 });
    const fp = await readFingerprint(
      db,
      table({ scope: { kind: 'equals', field: 'cliente', value: null } }),
    );
    expect(fp).toBe('0|');
    expect(calls).toHaveLength(0);
  });

  it('comparte la consulta entre conexiones dentro del TTL', async () => {
    const { db, calls } = fakeDb({ count: 1, updated_at: 'u' });
    const now = 1_000_000;
    await readFingerprint(db, table(), now);
    await readFingerprint(db, table(), now + FINGERPRINT_TTL_MS - 1);
    expect(calls).toHaveLength(1);
    await readFingerprint(db, table(), now + FINGERPRINT_TTL_MS + 1);
    expect(calls).toHaveLength(2);
  });
});

describe('memoFingerprint', () => {
  it('un fallo no se queda guardado', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce('ok');
    await expect(memoFingerprint('k', 0, fn)).rejects.toThrow('x');
    await new Promise((r) => setTimeout(r, 0));
    await expect(memoFingerprint('k', 1, fn)).resolves.toBe('ok');
  });
});
