import { createOrgScopedClient } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  type Tables,
  createFakeSupabase,
} from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { activeSnoozeKeys, snoozeUntil, withoutSnoozed } from './snooze';
import { loadSnoozedKeys, snoozeItem, unsnoozeItem } from './snooze-store';

const ANA = '11111111-1111-4111-8111-111111111111';
const BETO = '22222222-2222-4222-8222-222222222222';

describe('cuándo vuelve lo pospuesto', () => {
  it('«Mañana» es mañana a las 7:00 de Bogotá', () => {
    // lunes 12 oct 2026, 10:00 Bogotá
    expect(snoozeUntil('tomorrow', new Date('2026-10-12T15:00:00Z')).toISOString()).toBe(
      '2026-10-13T12:00:00.000Z',
    );
    // lunes 21:00 Bogotá (ya martes en UTC) sigue siendo lunes allá: vuelve el martes a las 7.
    expect(snoozeUntil('tomorrow', new Date('2026-10-13T02:00:00Z')).toISOString()).toBe(
      '2026-10-13T12:00:00.000Z',
    );
  });

  it('«La otra semana» es el próximo lunes a las 7:00', () => {
    // lunes → el lunes siguiente
    expect(snoozeUntil('next_week', new Date('2026-10-12T15:00:00Z')).toISOString()).toBe(
      '2026-10-19T12:00:00.000Z',
    );
    // miércoles 14 → lunes 19
    expect(snoozeUntil('next_week', new Date('2026-10-14T15:00:00Z')).toISOString()).toBe(
      '2026-10-19T12:00:00.000Z',
    );
    // domingo 18 → lunes 19
    expect(snoozeUntil('next_week', new Date('2026-10-18T15:00:00Z')).toISOString()).toBe(
      '2026-10-19T12:00:00.000Z',
    );
  });
});

describe('visibilidad', () => {
  const now = new Date('2026-10-12T15:00:00Z');
  const rows = [
    { item_key: 'a', until_at: '2026-10-13T12:00:00Z' },
    { item_key: 'b', until_at: '2026-10-12T14:59:59Z' }, // ya venció: reaparece
    { item_key: 'c', until_at: '2026-10-12T15:00:00Z' }, // justo ahora: reaparece
  ];

  it('esconde lo que sigue pospuesto y deja volver lo vencido', () => {
    expect([...activeSnoozeKeys(rows, now)]).toEqual(['a']);
    expect([...activeSnoozeKeys(rows, new Date('2026-10-13T12:00:00Z'))]).toEqual([]);
  });

  it('quita de la lista lo pospuesto y cuenta cuántas escondió', () => {
    const list = [{ id: 'a' }, { id: 'x' }, { id: 'y' }];
    const { shown, hiddenCount } = withoutSnoozed(list, (i) => i.id, new Set(['a', 'y']));
    expect(shown).toEqual([{ id: 'x' }]);
    expect(hiddenCount).toBe(2);
  });
});

describe('guardado en el servidor', () => {
  function world() {
    const tables: Tables = { hoy_snoozes: [] };
    const fake = createFakeSupabase(tables);
    const inner = fake.client as unknown as { from: (n: string) => Record<string, unknown> };
    const withIds = {
      from(table: string) {
        const b = inner.from(table);
        const original = b.upsert as (...a: unknown[]) => unknown;
        b.upsert = (rows: unknown, ...rest: unknown[]) => {
          for (const r of (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[])
            r.id ??= `s-${r.item_key}`;
          return original.call(b, rows, ...rest);
        };
        return b;
      },
    } as unknown as SupabaseClient;
    return { tables, db: createOrgScopedClient(withIds, 'org-acme') };
  }

  it('pospone, esconde hasta la hora, reaparece y se puede deshacer; cada quien lo suyo', async () => {
    const { db, tables } = world();
    const now = new Date('2026-10-12T15:00:00Z');
    const until = await snoozeItem(
      db,
      { userId: ANA, itemKey: 'approvals-7', title: 'Aprobar X', choice: 'tomorrow' },
      now,
    );
    expect(until.toISOString()).toBe('2026-10-13T12:00:00.000Z');
    expect(tables.hoy_snoozes?.[0]).toMatchObject({
      organization_id: 'org-acme',
      user_id: ANA,
      item_key: 'approvals-7',
    });

    expect([...(await loadSnoozedKeys(db, ANA, now))]).toEqual(['approvals-7']);
    expect([...(await loadSnoozedKeys(db, BETO, now))]).toEqual([]);
    // Pasada la hora, vuelve sola.
    expect([...(await loadSnoozedKeys(db, ANA, new Date('2026-10-13T12:00:01Z')))]).toEqual([]);

    // Posponer otra vez la misma cosa mueve la hora, no duplica la fila.
    await snoozeItem(db, { userId: ANA, itemKey: 'approvals-7', choice: 'next_week' }, now);
    expect(tables.hoy_snoozes).toHaveLength(1);
    expect(new Date(String(tables.hoy_snoozes?.[0]?.until_at)).toISOString()).toBe(
      '2026-10-19T12:00:00.000Z',
    );

    await unsnoozeItem(db, ANA, 'approvals-7');
    expect([...(await loadSnoozedKeys(db, ANA, now))]).toEqual([]);
  });
});
