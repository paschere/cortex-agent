import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../tenancy/scoped-client';
import { getTrackerBySlug } from '../../../trackers/store';
import { forgetAutomationWatch } from '../emit';
import { applyRelatedPlan, linkMatches, linkTokens, planLinkRows } from '../related';
import { type AutomationDeps, executeRun } from '../run';
import { automationInputSchema, structuralProblems } from '../spec';

/** Casar por clave (link_rows): factura de Siigo ↔ manifiesto, por FVA o por monto. */

const ORG = 'org-a';
const NOW = new Date('2026-10-28T15:00:00.000Z');
type Row = Record<string, unknown>;
const M1 = '11111111-1111-4111-a111-000000000001';
const M2 = '11111111-1111-4111-a111-000000000002';
const M3 = '11111111-1111-4111-a111-000000000003';
const M4 = '11111111-1111-4111-a111-000000000004';

const base = { duplicates: null, created_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
const mrow = (id: string, nombre: string, values: Row) => ({
  id, organization_id: ORG, tracker_id: 't-man', label: nombre, values: { nombre, ...values },
  created_by: 'u1', created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z',
});
const irow = (id: string, numero: string, values: Row) => ({
  id, organization_id: ORG, tracker_id: 't-fac', label: numero, values: { numero, ...values },
  created_by: 'u1', created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z',
});

function world() {
  const tables: Record<string, Row[]> = {
    trackers: [
      { id: 't-man', organization_id: ORG, slug: 'manifiestos', name: 'Manifiestos', description: '', fields: [
        { key: 'nombre', label: 'Manifiesto', type: 'text' },
        { key: 'claves', label: 'Claves', type: 'text' },
        { key: 'total_cop', label: 'Total COP', type: 'money' },
        { key: 'estado_cruce', label: 'Cruce', type: 'text' },
        { key: 'facturado', label: 'Facturado', type: 'money' },
        { key: 'facturas_n', label: 'N° facturas', type: 'number' },
      ], ...base },
      { id: 't-fac', organization_id: ORG, slug: 'facturas', name: 'Facturas', description: '', fields: [
        { key: 'numero', label: 'Número', type: 'text' },
        { key: 'consecutivo', label: 'Consecutivo', type: 'text' },
        { key: 'total', label: 'Total', type: 'money' },
        { key: 'manifiesto', label: 'Manifiesto', type: 'relation', tracker: 'manifiestos' },
        { key: 'casado_por', label: 'Casado por', type: 'text' },
        { key: 'claves', label: 'Claves', type: 'text' },
      ], ...base },
    ],
    tracker_rows: [
      mrow(M1, 'FLEX 29 / FLEX 30', { claves: 'FLEX 29 / FLEX 30', total_cop: 1000, estado_cruce: 'Pendiente por facturar' }),
      mrow(M2, 'FLEX- 97', { claves: 'FLEX- 97', total_cop: 2000, estado_cruce: 'Pendiente por facturar' }),
      mrow(M3, 'Sin FVA · 111', { claves: '', total_cop: 12_324_691, estado_cruce: 'Pendiente por facturar' }),
      mrow(M4, 'Sin FVA · 222', { claves: '', total_cop: 12_324_691, estado_cruce: 'Pendiente por facturar' }),
      irow('f29', 'FV-2-29', { consecutivo: '29', total: 600, claves: 'FLEX29 / FV-2-29' }),
      irow('f30', 'FV-2-30', { consecutivo: '30', total: 400, claves: 'FLEX30 / FV-2-30' }),
      irow('f97', 'FV-2-97', { consecutivo: '97', total: 2000, claves: 'FLEX97 / FV-2-97' }),
      irow('f98', 'FV-2-98', { consecutivo: '98', total: 5, claves: 'FLEX98 / FV-2-98' }),
    ],
    custom_apps: [{ id: 'app-1', organization_id: ORG, slug: 'pref', name: 'Pref', icon: '', status: 'published', archived_at: null }],
    custom_app_screens: [], custom_app_roles: [], custom_app_automations: [], custom_app_automation_runs: [],
    custom_app_users: [], custom_app_members: [], custom_view_events: [],
    users: [{ id: 'u1', organization_id: ORG, role: 'org_admin', email: 'a@a.co' }],
  };
  const fake = createFakeSupabase(tables);
  forgetAutomationWatch();
  return { db: createOrgScopedClient(fake.client as unknown as SupabaseClient, ORG), tables };
}

const deps = (): AutomationDeps => ({
  now: () => NOW, baseUrl: 'https://cortex.test', signingSecret: 's',
  sendEmail: async () => ({ sent: true }), notifyMembers: async () => 0, pushAppUsers: async () => [],
  askCortex: async () => ({ summary: 'ok', staged: 0 }),
});

const byFva = {
  type: 'link_rows', up: 'manifiesto', on: 'claves', value: 'FLEX{{consecutivo}} / {{numero}}',
  set: { casado_por: 'FVA' },
};
const rollupAction = (target: string, op: string, field?: string) => ({ type: 'rollup', up: 'manifiesto', target, op, ...(field ? { field } : {}) });

let q = 0;
function queueRun(tables: Record<string, Row[]>, rowId: string, ruleId: string) {
  const row = tables.tracker_rows?.find((r) => r.id === rowId) as { values: Row; label: string; tracker_id: string };
  const run = {
    id: `run-${++q}`, organization_id: ORG, app_id: 'app-1', automation_id: ruleId, trigger_ref: 'x', status: 'queued', attempts: 0,
    next_attempt_at: NOW.toISOString(),
    event: { kind: 'row_created', trackerId: row.tracker_id, rowId, before: null, after: row.values, label: row.label, version: `v${q}`, actor: { kind: 'system', id: null }, chain: [], depth: 0 },
    result: [], error: null as string | null, ask_cortex_calls: 0, idempotency_key: `${ruleId}:${q}`, created_at: NOW.toISOString(),
  };
  tables.custom_app_automation_runs?.push(run);
  return run;
}

describe('claves y montos', () => {
  it('«FLEX 29 / FLEX- 30» son dos claves, sin espacios ni guiones', () => {
    expect(linkTokens('FLEX 29 / FLEX- 30')).toEqual(['FLEX29', 'FLEX30']);
    expect(linkTokens('flex-6')).toEqual(['FLEX6']);
    expect(linkTokens('')).toEqual([]);
  });
  it('coincide si comparten una clave; con tolerancia compara montos', () => {
    expect(linkMatches('FLEX29 / FV-2-29', 'FLEX 29 / FLEX 30')).toBe(true);
    expect(linkMatches('FLEX31', 'FLEX 29 / FLEX 30')).toBe(false);
    expect(linkMatches('FLEX', 'FLEX 29')).toBe(false);
    expect(linkMatches('12324691', 12324688.4, 5)).toBe(true);
    expect(linkMatches('12324691', 12324000, 5)).toBe(false);
  });
});

describe('la regla es válida', () => {
  it('pide una dirección y un campo donde buscar', () => {
    const rule = (a: Row) => automationInputSchema.parse({
      name: 'Casar', trigger: { type: 'row_created', tracker: 'facturas' }, actions: [a],
    });
    expect(structuralProblems(rule(byFva))).toEqual([]);
    expect(structuralProblems(rule({ ...byFva, up: undefined }))).toEqual([expect.stringMatching(/UNA dirección/)]);
    expect(structuralProblems(rule({ ...byFva, down: { tracker: 'otra', via: 'y' } })).join(' ')).toMatch(/UNA dirección/);
  });
});

describe('planLinkRows', () => {
  async function plan(w: ReturnType<typeof world>, rowId: string, action: Row, trackerSlug = 'facturas') {
    const tracker = await getTrackerBySlug(w.db, trackerSlug);
    const row = w.tables.tracker_rows?.find((r) => r.id === rowId) as { values: Row; label: string };
    const parsed = automationInputSchema.parse({ name: 'x', trigger: { type: 'row_created', tracker: trackerSlug }, actions: [action] }).actions[0];
    return planLinkRows(w.db, {
      tracker: tracker as never, rowId, action: parsed as never, ctx: { after: row.values as Record<string, string | number>, label: row.label }, now: NOW,
    });
  }

  it('sube: la factura FV-2-97 queda casada con el manifiesto «FLEX- 97»', async () => {
    const w = world();
    const p = await plan(w, 'f97', byFva);
    expect(p.rows).toHaveLength(1);
    expect(JSON.parse(String(p.set.manifiesto))).toMatchObject({ id: M2, label: 'FLEX- 97' });
    expect(p.set.casado_por).toBe('FVA');
    const out = await applyRelatedPlan(w.db, p, 'u1');
    expect(out.changed).toBe(1);
    const f = w.tables.tracker_rows?.find((r) => r.id === 'f97') as { values: Row };
    expect(String(f.values.manifiesto)).toContain(M2);
    expect(f.values.casado_por).toBe('FVA');
  });

  it('1↔N: dos facturas del mismo manifiesto «FLEX 29 / FLEX 30»', async () => {
    const w = world();
    for (const id of ['f29', 'f30']) await applyRelatedPlan(w.db, await plan(w, id, byFva), 'u1');
    for (const id of ['f29', 'f30'])
      expect(String((w.tables.tracker_rows?.find((r) => r.id === id) as { values: Row }).values.manifiesto)).toContain(M1);
  });

  it('sin coincidencia no escribe nada y lo dice', async () => {
    const w = world();
    const p = await plan(w, 'f98', byFva);
    expect(p.rows).toHaveLength(0);
    expect(p.note).toMatch(/Ninguna fila de «Manifiestos» coincide/);
  });

  it('dudoso (dos manifiestos con la misma clave): no casa, deja para revisión', async () => {
    const w = world();
    (w.tables.tracker_rows?.find((r) => r.id === M3) as { values: Row }).values.claves = 'FLEX 98';
    (w.tables.tracker_rows?.find((r) => r.id === M4) as { values: Row }).values.claves = 'FLEX-98';
    const p = await plan(w, 'f98', byFva);
    expect(p.rows).toHaveLength(0);
    expect(p.note).toMatch(/coincide con 2 filas.*dudoso/);
  });

  it('una relación asignada a mano no se pisa (salvo overwrite)', async () => {
    const w = world();
    (w.tables.tracker_rows?.find((r) => r.id === 'f97') as { values: Row }).values.manifiesto = JSON.stringify({ id: M1, label: 'x' });
    expect((await plan(w, 'f97', byFva)).note).toMatch(/Ya tenía/);
    const forced = await plan(w, 'f97', { ...byFva, overwrite: true });
    expect(forced.rows).toHaveLength(1);
  });

  it('por monto con tolerancia, sólo entre manifiestos pendientes, y no si hay dos iguales', async () => {
    const w = world();
    const byAmount = { type: 'link_rows', up: 'manifiesto', on: 'total_cop', value: '{{total}}', tolerance: 5,
      where: [{ field: 'estado_cruce', op: 'eq', value: 'Pendiente por facturar' }], set: { casado_por: 'Monto' } };
    const f = w.tables.tracker_rows?.find((r) => r.id === 'f98') as { values: Row };
    f.values.total = 12_324_693;
    const two = await plan(w, 'f98', byAmount);
    expect(two.rows).toHaveLength(0); // M3 y M4 valen lo mismo: dudoso
    expect(two.note).toMatch(/coincide con 2 filas/);
    (w.tables.tracker_rows?.find((r) => r.id === M4) as { values: Row }).values.estado_cruce = 'Cuadra';
    const one = await plan(w, 'f98', byAmount);
    expect(one.rows).toHaveLength(1);
    expect(JSON.parse(String(one.set.manifiesto)).id).toBe(M3);
    expect(one.set.casado_por).toBe('Monto');
  });

  it('baja: al cerrar el manifiesto, casa las facturas libres que traen su FVA', async () => {
    const w = world();
    (w.tables.tracker_rows?.find((r) => r.id === 'f30') as { values: Row }).values.manifiesto = JSON.stringify({ id: M2, label: 'otro' });
    const down = { type: 'link_rows', down: { tracker: 'facturas', via: 'manifiesto' }, on: 'claves', value: '{{claves}}', set: { casado_por: 'FVA' } };
    const p = await plan(w, M1, down, 'manifiestos');
    // f29 es libre y coincide; f30 ya está asignada a otro manifiesto: no se toca.
    expect(p.rows.map((r) => r.id)).toEqual(['f29']);
    expect(JSON.parse(String(p.set.manifiesto))).toMatchObject({ id: M1 });
  });
});

describe('la corrida: casar y acumular en seguida', () => {
  it('al llegar la factura FV-2-29 se casa y el manifiesto acumula lo facturado (1↔N suma las dos)', async () => {
    const w = world();
    w.tables.custom_app_automations?.push({
      id: 'r-link', organization_id: ORG, app_id: 'app-1', name: 'Casar factura nueva', enabled: true,
      trigger: { type: 'row_created', tracker: 'facturas' }, conditions: [],
      actions: [byFva, rollupAction('facturado', 'sum', 'total'), rollupAction('facturas_n', 'count')],
      tracker_id: 't-fac', trigger_kind: 'row_created', created_by: 'u1',
    });
    for (const id of ['f29', 'f30']) {
      const run = queueRun(w.tables, id, 'r-link');
      const out = await executeRun(w.db, run.id, ORG, deps());
      expect(out.status).toBe('succeeded');
    }
    const m = w.tables.tracker_rows?.find((r) => r.id === M1) as { values: Row };
    expect(m.values.facturado).toBe(1000);
    expect(m.values.facturas_n).toBe(2);
    // Una factura sin manifiesto no rompe la corrida: la regla sólo informa.
    const run = queueRun(w.tables, 'f98', 'r-link');
    await executeRun(w.db, run.id, ORG, deps());
    expect(JSON.stringify(run.result)).toMatch(/Ninguna fila de «Manifiestos» coincide/);
  });
});
