import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import type { TrackerOrigin } from './origin';
import {
  canRefreshOrigin,
  loadOriginStatuses,
  refreshDecision,
  requestOriginRefresh,
  statusOfSyncRow,
} from './origin-status';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  last_run_at: ago(3),
  last_status: 'ok',
  last_error: null,
  next_run_at: new Date(NOW + 12 * 60_000).toISOString(),
  enabled: true,
  created_by: 'u-owner',
  ...over,
});

const siigo: TrackerOrigin = {
  kind: 'accounting',
  provider: 'siigo',
  label: 'Siigo',
  ref: 'c1',
  fields: ['total'],
  creates: true,
};

describe('estado de una sincronización', () => {
  it('ok, error, nunca y actualizando', () => {
    expect(statusOfSyncRow(row(), NOW)).toMatchObject({ state: 'ok', running: false });
    expect(statusOfSyncRow(row({ last_status: 'error', last_error: 'x' }), NOW).state).toBe(
      'error',
    );
    expect(statusOfSyncRow(row({ last_run_at: null }), NOW).state).toBe('never');
    expect(statusOfSyncRow(null, NOW).state).toBe('never');
    // Pedida hace un minuto y sin lectura posterior: está corriendo.
    expect(statusOfSyncRow(row({ next_run_at: ago(1), last_run_at: ago(20) }), NOW).running).toBe(
      true,
    );
    // Una lectura posterior a lo pedido: ya terminó.
    expect(statusOfSyncRow(row({ next_run_at: ago(5), last_run_at: ago(3) }), NOW).running).toBe(
      false,
    );
    // Una pausada nunca «actualiza».
    expect(
      statusOfSyncRow(row({ enabled: false, next_run_at: ago(1), last_run_at: ago(20) }), NOW)
        .running,
    ).toBe(false);
  });

  it('el límite de frecuencia: no se pide dos veces en un minuto', () => {
    expect(refreshDecision(row({ last_run_at: ago(0.2) }), NOW)).toMatchObject({
      ok: false,
      reason: 'too_soon',
    });
    expect(refreshDecision(row({ last_run_at: ago(5) }), NOW)).toEqual({ ok: true });
    expect(refreshDecision(row({ enabled: false }), NOW)).toMatchObject({ reason: 'paused' });
    expect(refreshDecision(row({ next_run_at: ago(1), last_run_at: ago(20) }), NOW)).toMatchObject({
      reason: 'running',
    });
  });

  it('quién puede pedirla: administración siempre; hoja/carpeta también quien la creó', () => {
    const sheet = { ...siigo, kind: 'sheet' as const, provider: undefined };
    expect(
      canRefreshOrigin({ origin: siigo, createdBy: null }, { userId: 'a', canManage: true }),
    ).toBe(true);
    expect(
      canRefreshOrigin({ origin: siigo, createdBy: 'a' }, { userId: 'a', canManage: false }),
    ).toBe(false);
    expect(
      canRefreshOrigin({ origin: sheet, createdBy: 'a' }, { userId: 'a', canManage: false }),
    ).toBe(true);
    expect(
      canRefreshOrigin({ origin: sheet, createdBy: 'b' }, { userId: 'a', canManage: false }),
    ).toBe(false);
  });
});

describe('«Actualizar ahora»', () => {
  const db = (over: Record<string, unknown> = {}) => {
    const fake = createFakeSupabase({ accounting_connections: [row(over)] });
    return { db: fake.client as unknown as SupabaseClient, tables: fake.tables };
  };

  it('adelanta next_run_at y encola la corrida de la conexión', async () => {
    const w = db();
    const jobs: Array<{ name: string; data: Record<string, unknown> }> = [];
    const out = await requestOriginRefresh(w.db, siigo, {
      organizationId: 'org',
      now: NOW,
      enqueueJob: async (name, data) => {
        jobs.push({ name, data });
        return true;
      },
    });
    expect(out).toMatchObject({ ok: true, queued: true });
    expect(jobs).toEqual([
      { name: 'accounting/run', data: { organizationId: 'org', connectionId: 'c1' } },
    ]);
    expect((w.tables.accounting_connections?.[0] as { next_run_at: string }).next_run_at).toBe(
      new Date(NOW).toISOString(),
    );
  });

  it('hojas y carpetas encolan su propio trabajo con syncId', async () => {
    for (const [kind, table, job] of [
      ['sheet', 'tracker_syncs', 'table-sync/run'],
      ['drive_folder', 'drive_folder_syncs', 'drive-table/run'],
    ] as const) {
      const fake = createFakeSupabase({ [table]: [row()] });
      const jobs: string[] = [];
      const out = await requestOriginRefresh(
        fake.client as unknown as SupabaseClient,
        { ...siigo, kind, provider: undefined },
        {
          organizationId: 'org',
          now: NOW,
          enqueueJob: async (name, data) => {
            jobs.push(`${name}:${String(data.syncId)}`);
            return true;
          },
        },
      );
      expect(out.ok).toBe(true);
      expect(jobs).toEqual([`${job}:c1`]);
    }
  });

  it('con una lectura de hace segundos dice cuánto esperar y no encola nada', async () => {
    const w = db({ last_run_at: ago(0.25) });
    let queued = 0;
    const out = await requestOriginRefresh(w.db, siigo, {
      organizationId: 'org',
      now: NOW,
      enqueueJob: async () => {
        queued += 1;
        return true;
      },
    });
    expect(out).toMatchObject({ ok: false, waitSeconds: 45 });
    expect(queued).toBe(0);
  });

  it('una conexión en pausa se dice, no se despierta', async () => {
    const w = db({ enabled: false });
    const out = await requestOriginRefresh(w.db, siigo, { organizationId: 'org', now: NOW });
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.error).toContain('en pausa');
  });

  it('loadOriginStatuses lee cada origen por su ref', async () => {
    const w = db();
    const list = await loadOriginStatuses(w.db, { origins: [siigo] }, NOW);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ enabled: true, status: { state: 'ok' } });
  });
});
