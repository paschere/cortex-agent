import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import {
  type SiigoJournal,
  classifyPayrollAccount,
  normalizeSiigoPayrollJournal,
  summarizePayrollPeople,
  summarizePayrollPeriods,
} from './payroll';
import { planPayrollSync } from './payroll-plan';
import { siigoPayrollPage } from './payroll-provider';
import { readPayrollView, runPayrollSync } from './payroll-store';
import { siigoProvider } from './providers/siigo';
import { cleanEntities } from './store';

/**
 * Nómina desde los comprobantes contables de Siigo. Los comprobantes de
 * ejemplo siguen la forma del SDK oficial (SiigoSAS/siigo_sdk_javascript,
 * JournalEntryViewModel): items[].account.code|movement, customer.identification, value.
 */

const item = (code: string, movement: 'Debit' | 'Credit', value: number, nit?: string) => ({
  account: { code, movement },
  value,
  ...(nit ? { customer: { identification: nit } } : {}),
});

const SEPT: SiigoJournal = {
  id: 'j-sep',
  name: 'CC-10-45',
  date: '2026-09-30',
  items: [
    item('51050601', 'Debit', 4_000_000, '1010101010'),
    item('51050601', 'Debit', 3_000_000, '2020202020'),
    item('51052701', 'Debit', 280_000, '1010101010'),
    item('51053001', 'Debit', 330_000),
    item('51056801', 'Debit', 40_000),
    item('13050501', 'Debit', 999), // no es de nómina
    item('25050101', 'Credit', 3_700_000, '1010101010'),
    item('25050101', 'Credit', 2_800_000, '2020202020'),
    item('23700501', 'Credit', 780_000),
    item('25100501', 'Credit', 330_000),
    item('11100501', 'Credit', 1), // banco: no se guarda
  ],
};

describe('classifyPayrollAccount', () => {
  it('reconoce gastos, pasivos y descarta lo demás', () => {
    expect(classifyPayrollAccount('51050601')).toMatchObject({
      group: 'devengado',
      concept: 'Sueldos',
    });
    expect(classifyPayrollAccount('520568')).toMatchObject({ group: 'aportes' });
    expect(classifyPayrollAccount('7205 30')).toMatchObject({ group: 'prestaciones' });
    expect(classifyPayrollAccount('250501')).toMatchObject({ group: 'neto' });
    expect(classifyPayrollAccount('2370')).toMatchObject({ group: 'deducciones' });
    expect(classifyPayrollAccount('1110')).toBeNull();
    expect(classifyPayrollAccount('4135')).toBeNull();
    expect(classifyPayrollAccount('')).toBeNull();
  });
});

describe('normalizeSiigoPayrollJournal', () => {
  it('conserva sólo las líneas de nómina y saca el mes', () => {
    const j = normalizeSiigoPayrollJournal(SEPT);
    expect(j?.period).toBe('2026-09');
    expect(j?.lines).toHaveLength(9);
    expect(j?.lines.some((l) => l.accountCode.startsWith('1110'))).toBe(false);
    expect(j?.lines[0]?.personTaxId).toBe('1010101010');
  });
  it('un comprobante sin sueldos ni salarios por pagar no es nómina', () => {
    expect(
      normalizeSiigoPayrollJournal({
        id: 'x',
        date: '2026-09-01',
        items: [item('51056801', 'Debit', 10), item('11100501', 'Credit', 10)],
      }),
    ).toBeNull();
    expect(normalizeSiigoPayrollJournal({ id: 'y', date: 'mal', items: [] })).toBeNull();
  });
});

describe('totales', () => {
  const j = normalizeSiigoPayrollJournal(SEPT);
  const rows = (j?.lines ?? []).map((l) => ({
    journalId: 'j-sep',
    period: '2026-09',
    accountCode: l.accountCode,
    movement: l.movement,
    group: l.group,
    concept: l.concept,
    amount: l.amount,
    personTaxId: l.personTaxId ?? null,
  }));
  it('suma el periodo', () => {
    const [p] = summarizePayrollPeriods(rows);
    expect(p).toMatchObject({
      period: '2026-09',
      devengado: 7_280_000,
      prestaciones: 330_000,
      aportes: 40_000,
      costoTotal: 7_650_000,
      neto: 6_500_000,
      deducciones: 780_000,
      provisiones: 330_000,
      comprobantes: 1,
      personas: 2,
    });
  });
  it('un reverso (crédito al gasto) resta', () => {
    const [p] = summarizePayrollPeriods([
      ...rows,
      { ...(rows[0] as (typeof rows)[number]), movement: 'credit', amount: 1_000_000 },
    ]);
    expect(p?.devengado).toBe(6_280_000);
  });
  it('por persona', () => {
    const people = summarizePayrollPeople(rows);
    expect(people[0]).toMatchObject({ taxId: '1010101010', devengado: 4_280_000, neto: 3_700_000 });
  });
});

describe('siigoPayrollPage', () => {
  it('pide /v1/journals con date_start y filtra lo que no es nómina', async () => {
    const calls: unknown[] = [];
    const client = {
      page: async (path: string, query: unknown, page: number) => {
        calls.push({ path, query, page });
        return {
          page,
          pageSize: 100,
          total: 250,
          results: [
            SEPT,
            { id: 'otro', date: '2026-09-02', items: [item('51056801', 'Debit', 1)] },
          ],
        };
      },
    };
    const r = await siigoPayrollPage(client as never, '2026-01-01', 2);
    expect(calls).toEqual([{ path: '/v1/journals', query: { date_start: '2026-01-01' }, page: 2 }]);
    expect(r).toMatchObject({ seen: 2, hasMore: true });
    expect(r.journals).toHaveLength(1);
  });
});

describe('planPayrollSync', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  it('primera carga de dos años, luego ventana de 60 días, repaso mensual', () => {
    expect(planPayrollSync(undefined, now)).toMatchObject({ mode: 'initial', since: '2024-10-08' });
    const done = { since: '2026-10-08T10:00:00Z', full_at: '2026-10-07T00:00:00Z' };
    expect(planPayrollSync(done, now)).toMatchObject({ mode: 'rolling', since: '2026-08-09' });
    expect(planPayrollSync({ ...done, full_at: '2026-08-01T00:00:00Z' }, now).mode).toBe('sweep');
    const resume = { page: 3, since: '2024-10-08', mode: 'initial' as const };
    expect(planPayrollSync({ resume }, now)).toEqual(resume);
  });
});

describe('opción «Nómina» en la conexión', () => {
  it('sólo se acepta si el programa la ofrece', () => {
    expect(cleanEntities(siigoProvider, ['invoices', 'payroll'])).toEqual(['invoices', 'payroll']);
    expect(siigoProvider.options).toContain('payroll');
  });
});

function sept() {
  const j = normalizeSiigoPayrollJournal(SEPT);
  if (!j) throw new Error('el comprobante de ejemplo tiene que ser de nómina');
  return j;
}

function fakeDb(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  const fake = createFakeSupabase({ accounting_payroll_lines: [], ...extra });
  return { db: fake.client as unknown as SupabaseClient, fake };
}

describe('runPayrollSync (incremental, sin duplicar)', () => {
  const session = (journals = [sept()]) => ({
    listPayroll: async () => ({ journals, hasMore: false, seen: journals.length }),
  });
  it('correr dos veces deja las mismas líneas y avanza el cursor', async () => {
    const { db, fake } = fakeDb();
    const now = new Date('2026-10-08T12:00:00Z');
    const a = await runPayrollSync(db, session(), { system: 'siigo', cursor: undefined, now });
    expect(a.partial).toBe(false);
    expect(a.cursor.since).toBe(now.toISOString());
    const first = (fake.tables.accounting_payroll_lines ?? []).length;
    expect(first).toBe(9);
    await runPayrollSync(db, session(), { system: 'siigo', cursor: a.cursor, now });
    expect((fake.tables.accounting_payroll_lines ?? []).length).toBe(first);
  });
  it('un comprobante corregido con menos líneas reemplaza las viejas', async () => {
    const { db, fake } = fakeDb();
    const full = sept();
    await runPayrollSync(db, session([full]), { system: 'siigo', cursor: undefined });
    const shorter = { ...full, lines: full.lines.slice(0, 3) };
    await runPayrollSync(db, session([shorter]), { system: 'siigo', cursor: undefined });
    expect((fake.tables.accounting_payroll_lines ?? []).length).toBe(3);
  });
  it('si quedan páginas, guarda dónde iba', async () => {
    const { db } = fakeDb();
    let calls = 0;
    const paged = {
      listPayroll: async () => ({ journals: [], hasMore: ++calls < 99, seen: 100 }),
    };
    const r = await runPayrollSync(db, paged, { system: 'siigo', cursor: undefined, maxPages: 2 });
    expect(r.partial).toBe(true);
    expect(r.cursor.resume?.page).toBe(3);
  });
});

describe('privacidad de la nómina', () => {
  async function seeded() {
    const { db, fake } = fakeDb({
      users: [
        { id: 'admin', role: 'org_admin', email: 'a@x.co' },
        { id: 'miembro', role: 'member', email: 'm@x.co' },
      ],
      employees: [{ full_name: 'Ana Ruiz', document_number: '1010101010' }],
      ba_organization: [],
      ba_member: [],
      ba_user: [],
    });
    await runPayrollSync(
      db,
      {
        listPayroll: async () => ({
          journals: [sept()],
          hasMore: false,
          seen: 1,
        }),
      },
      { system: 'siigo', cursor: undefined },
    );
    return { db, fake };
  }
  const today = '2026-10-08';

  it('quien administra ve el detalle por persona, con nombre si está en la nómina', async () => {
    const { db } = await seeded();
    const v = await readPayrollView(db, { viewerId: 'admin', today });
    expect(v.detail).toBe(true);
    expect(v.people).toHaveLength(2);
    expect(v.people[0]).toMatchObject({ taxId: '1010101010', name: 'Ana Ruiz', neto: 3_700_000 });
  });

  it('un miembro ve totales, ni una identificación ni un salario individual', async () => {
    const { db } = await seeded();
    const v = await readPayrollView(db, { viewerId: 'miembro', today });
    expect(v.detail).toBe(false);
    expect(v.detailHidden).toBe(true);
    expect(v.people).toEqual([]);
    expect(v.periods[0]?.neto).toBe(6_500_000);
    expect(JSON.stringify(v)).not.toContain('1010101010');
  });

  it('sin saber quién mira, también se oculta', async () => {
    const { db } = await seeded();
    const v = await readPayrollView(db, { viewerId: null, today });
    expect(v.people).toEqual([]);
  });
});
