import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { PAYROLL_DETAIL_TOOL_ID, canReadPayroll, readPayrollMovements } from './payroll-access';
import { cleanEntities } from './store';
import { siigoProvider } from './providers/siigo';

const ORG = 'org-andina';
const ADMIN = '11111111-1111-4111-a111-111111111111';
const MEMBER = '22222222-2222-4222-a222-222222222222';

function world() {
  const fake = createFakeSupabase({
    users: [
      { id: ADMIN, organization_id: ORG, role: 'org_admin', email: 'jefa@andina.co' },
      { id: MEMBER, organization_id: ORG, role: 'member', email: 'equipo@andina.co' },
    ],
    ba_organization: [{ id: ORG, kind: 'company' }],
    ba_member: [],
    ba_user: [],
    employees: [{ full_name: 'Ana Pérez', document_number: '1032000111', organization_id: ORG }],
    audit_events: [],
    accounting_payroll_lines: [
      {
        organization_id: ORG,
        source_system: 'siigo',
        journal_id: 'j1',
        line_index: 0,
        journal_name: 'CC-1-9',
        journal_date: '2026-09-30',
        period: '2026-09',
        account_code: '25050501',
        movement: 'credit',
        concept_group: 'neto',
        concept: 'Salarios por pagar',
        amount: 3000000,
        person_tax_id: '1032000111',
        person_name: null,
        description: null,
      },
      {
        organization_id: ORG,
        source_system: 'siigo',
        journal_id: 'j1',
        line_index: 1,
        journal_name: 'CC-1-9',
        journal_date: '2026-09-30',
        period: '2026-09',
        account_code: '51050601',
        movement: 'debit',
        concept_group: 'devengado',
        concept: 'Sueldos',
        amount: 3000000,
        person_tax_id: null,
        person_name: null,
        description: null,
      },
    ],
  });
  const db = createOrgScopedClient(fake.client as unknown as SupabaseClient, ORG);
  return { db, tables: fake.tables };
}

describe('permiso de nómina por persona (0235)', () => {
  it('sólo administradores y dueño; sin persona, falla cerrado', async () => {
    const w = world();
    expect(await canReadPayroll(w.db, ADMIN)).toBe(true);
    expect(await canReadPayroll(w.db, MEMBER)).toBe(false);
    expect(await canReadPayroll(w.db, null)).toBe(false);
    expect(await canReadPayroll(w.db, undefined)).toBe(false);
  });

  it('quien tiene el permiso ve los movimientos con su tercero y queda en la auditoría', async () => {
    const w = world();
    const r = await readPayrollMovements(w.db, { viewerId: ADMIN, period: '2026-09' });
    expect(r.allowed).toBe(true);
    const salary = r.lines.find((l) => l.account === '25050501');
    expect(salary).toMatchObject({ personTaxId: '1032000111', personName: 'Ana Pérez', amount: 3000000 });
    const audit = (w.tables.audit_events ?? []) as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      user_id: ADMIN,
      tool_id: PAYROLL_DETAIL_TOOL_ID,
      decision: 'allowed',
      status: 'ok',
    });
    expect((audit[0]?.metadata as Record<string, unknown>).lines).toBe(2);
    // La auditoría no guarda cifras ni nombres.
    expect(JSON.stringify(audit)).not.toContain('1032000111');
    expect(JSON.stringify(audit)).not.toContain('3000000');
  });

  it('quien no lo tiene no recibe ninguna línea y el intento queda auditado como bloqueado', async () => {
    const w = world();
    const r = await readPayrollMovements(w.db, { viewerId: MEMBER, period: '2026-09' });
    expect(r).toEqual({ allowed: false, lines: [], truncated: false });
    const audit = (w.tables.audit_events ?? []) as Array<Record<string, unknown>>;
    expect(audit[0]).toMatchObject({ user_id: MEMBER, decision: 'blocked' });
    const anon = await readPayrollMovements(w.db, { viewerId: null, period: '2026-09' });
    expect(anon.allowed).toBe(false);
  });

  it('filtra por cuenta', async () => {
    const w = world();
    const r = await readPayrollMovements(w.db, { viewerId: ADMIN, period: '2026-09', account: '5105' });
    expect(r.lines.map((l) => l.account)).toEqual(['51050601']);
  });
});

describe('la nómina por persona viene activada por defecto, la protege el permiso', () => {
  it('una conexión nueva sin elegir trae todo, nómina incluida; elegir a mano la puede apagar', () => {
    expect(cleanEntities(siigoProvider, undefined)).toContain('payroll');
    expect(cleanEntities(siigoProvider, ['invoices'])).not.toContain('payroll');
  });

  it('la nómina por persona no es una tabla compartida: ninguna tabla de Siigo la guarda', async () => {
    const { accountingTableSlug } = await import('./tables');
    const { ACCOUNTING_ENTITIES } = await import('./types');
    const slugs = ACCOUNTING_ENTITIES.map((e) => accountingTableSlug('siigo', e));
    expect(slugs.some((s) => /nomina_persona|salario|payroll_lines/.test(s))).toBe(false);
  });
});
