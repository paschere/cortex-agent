import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { confirmClientLinks, groupProposals, linkClientRecords } from '../links';
import { duplicatePairs, mergeClients, mergeRefusal } from '../merge';

/**
 * EL BARRIDO Y UNIR, contra la base de mentira (fake-postgrest) con dos
 * empresas. Lo que se prueba es lo que rompería la confianza:
 *
 *   - correrlo dos veces no cambia nada la segunda (idempotente);
 *   - un nombre que calza con dos clientes PROPONE a los dos y no aplica;
 *   - el NIT del campo estructurado y un alias confirmado SÍ aplican;
 *   - un cliente del programa contable se crea si falta, pero nunca si su
 *     nombre choca con uno que ya existe;
 *   - unir mueve todo, deja el nombre como alias y se niega con dos NIT;
 *   - nada de esto toca a la otra empresa.
 */

const ACME = 'org-acme';
const GLOBEX = 'org-globex';
const ANA = '11111111-1111-4111-8111-111111111111';

const COLTRANS = 'aaaa0000-0000-4000-8000-000000000001';
const NEXA = 'aaaa0000-0000-4000-8000-000000000002';
const NEXA_LTDA = 'aaaa0000-0000-4000-8000-000000000003';
const DUP = 'aaaa0000-0000-4000-8000-000000000004';
const GLOBEX_COLTRANS = 'bbbb0000-0000-4000-8000-000000000001';

let seq = 0;
/** La base de verdad pone el id; el doble no. Se lo ponemos al insertar. */
function withIds(raw: SupabaseClient): SupabaseClient {
  const addId = (v: Record<string, unknown>) => {
    seq += 1;
    return { id: `gen-${seq}`, ...v };
  };
  return {
    from: (table: string) => {
      const q = (raw as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
      const insert = (q.insert as (v: unknown) => unknown).bind(q);
      q.insert = (v: unknown) =>
        insert(
          Array.isArray(v)
            ? v.map((r) => addId(r as Record<string, unknown>))
            : addId(v as Record<string, unknown>),
        );
      return q;
    },
    rpc: (raw as unknown as { rpc: unknown }).rpc,
  } as unknown as SupabaseClient;
}

const client = (
  id: string,
  org: string,
  name: string,
  taxId: string | null,
  created = '2026-01-01T00:00:00Z',
) => ({
  id,
  organization_id: org,
  name,
  legal_name: null,
  tax_id: taxId,
  status: 'active',
  services: [],
  tags: [],
  owner_user_id: null,
  created_at: created,
  updated_at: created,
});

const move = (id: string, org: string, extra: Record<string, unknown>) => ({
  id,
  organization_id: org,
  client_id: null,
  client_matched_by: null,
  direction: 'in',
  kind: 'income',
  status: 'settled',
  amount: 1000,
  currency: 'COP',
  date: '2026-09-01',
  description: 'Abono',
  duplicate_of: null,
  excluded_reason: null,
  ...extra,
});

function fixture(): Tables {
  return {
    users: [{ id: ANA, organization_id: ACME, email: 'ana@acme.com', name: 'Ana' }],
    clients: [
      client(COLTRANS, ACME, 'Coltrans', '890903938'),
      client(NEXA, ACME, 'Nexa', null),
      client(NEXA_LTDA, ACME, 'Nexa Ltda', null),
      client(GLOBEX_COLTRANS, GLOBEX, 'Coltrans', '890903938'),
    ],
    client_aliases: [
      {
        id: 'al-1',
        organization_id: ACME,
        client_id: COLTRANS,
        alias: 'COLTRANS SAS BOGOTA',
        verified_by: ANA,
      },
    ],
    client_domains: [],
    client_contacts: [],
    client_links: [],
    ledger_movements: [
      // NIT con el DV pegado: aplica por NIT.
      move('m-nit', ACME, { counterparty_tax_id: '8909039388', counterparty_name: 'X' }),
      // Alias confirmado: aplica.
      move('m-alias', ACME, { counterparty_name: 'Coltrans S.A.S. Bogotá' }),
      // Dos clientes se pliegan a «nexa»: propone a los dos, no aplica.
      move('m-amb', ACME, { counterparty_name: 'NEXA SAS' }),
      // Lo que SALE es de proveedores: no se toca.
      move('m-out', ACME, { direction: 'out', kind: 'expense', counterparty_tax_id: '890903938' }),
      // Otra empresa, mismo NIT: no se toca desde Acme.
      move('m-globex', GLOBEX, { counterparty_tax_id: '890903938' }),
    ],
    accounting_invoices: [
      // Un cliente que Siigo conoce y Cortex no: se crea.
      {
        id: 'ai-new',
        organization_id: ACME,
        source_system: 'siigo',
        doc_number: 'FV-1',
        client_nit: '899999068',
        client_id: null,
        counterparty_name: 'Ecopetrol',
        currency: 'COP',
        total: 100,
        balance: 100,
        issued_on: '2026-09-01',
        annulled: false,
      },
      // Su nombre choca con «Nexa» (sin NIT): NO se crea.
      {
        id: 'ai-clash',
        organization_id: ACME,
        source_system: 'siigo',
        doc_number: 'FV-2',
        client_nit: '900431212',
        client_id: null,
        counterparty_name: 'NEXA',
        currency: 'COP',
        total: 100,
        balance: 100,
        issued_on: '2026-09-01',
        annulled: false,
      },
    ],
    accounting_connections: [],
    commitments: [],
  };
}

function setup() {
  const fake = createFakeSupabase(fixture());
  const db = createOrgScopedClient(withIds(fake.client), ACME);
  return { fake, db };
}

describe('linkClientRecords', () => {
  it('aplica lo afirmado, propone lo inferido y crea lo que falta', async () => {
    const { fake, db } = setup();
    const report = await linkClientRecords(db, { userId: ANA });
    const ledger = fake.tables.ledger_movements as Array<Record<string, unknown>>;
    const byId = (id: string) => ledger.find((m) => m.id === id) as Record<string, unknown>;

    expect(byId('m-nit').client_id).toBe(COLTRANS);
    expect(byId('m-nit').client_matched_by).toBe('tax_id');
    expect(byId('m-alias').client_id).toBe(COLTRANS);
    expect(byId('m-alias').client_matched_by).toBe('alias');
    expect(byId('m-amb').client_id).toBeNull();
    expect(byId('m-out').client_id).toBeNull();
    expect(byId('m-globex').client_id).toBeNull();

    const proposals = (fake.tables.client_links as Array<Record<string, unknown>>).filter(
      (l) => l.entity_id === 'm-amb',
    );
    expect(proposals.map((p) => p.client_id).sort()).toEqual([NEXA, NEXA_LTDA].sort());
    expect(proposals.every((p) => p.state === 'suggested')).toBe(true);
    expect(report.ambiguous).toBeGreaterThanOrEqual(1);

    const created = (fake.tables.clients as Array<Record<string, unknown>>).filter(
      (c) => c.source === 'accounting',
    );
    expect(created.map((c) => c.name)).toEqual(['Ecopetrol']);
    expect(created[0]?.organization_id).toBe(ACME);
    expect(report.created).toBe(1);
    expect(report.conflicts).toBeGreaterThanOrEqual(1);
    // La factura del cliente nuevo quedó a su nombre en la misma corrida.
    const invoices = fake.tables.accounting_invoices as Array<Record<string, unknown>>;
    expect(invoices.find((i) => i.id === 'ai-new')?.client_id).toBe(created[0]?.id);
    expect(invoices.find((i) => i.id === 'ai-clash')?.client_id).toBeNull();
  });

  it('es idempotente: la segunda corrida no cambia nada', async () => {
    const { fake, db } = setup();
    await linkClientRecords(db, { userId: ANA });
    const snapshot = JSON.stringify(fake.tables);
    const second = await linkClientRecords(db, { userId: ANA });
    expect(second.created).toBe(0);
    expect(second.proposed).toBe(0);
    expect(Object.values(second.applied).reduce((s, n) => s + (n ?? 0), 0)).toBe(0);
    expect(JSON.stringify(fake.tables)).toBe(snapshot);
  });

  it('confirmar una propuesta descarta la rival, llena la columna y puede aprender el nombre', async () => {
    const { fake, db } = setup();
    await linkClientRecords(db, { userId: ANA });
    const links = fake.tables.client_links as Array<Record<string, unknown>>;
    const mine = links.find((l) => l.entity_id === 'm-amb' && l.client_id === NEXA) as Record<
      string,
      unknown
    >;
    const out = await confirmClientLinks(db, {
      ids: [mine.id as string],
      userId: ANA,
      rememberAlias: 'NEXA SAS',
    });
    expect(out.confirmed).toBe(1);
    expect(out.competitorsRejected).toBe(1);
    expect(out.ownerColumns).toBe(1);
    expect(out.aliasLearned).toBe(true);
    const rival = links.find((l) => l.entity_id === 'm-amb' && l.client_id === NEXA_LTDA);
    expect(rival?.state).toBe('rejected');
    const m = (fake.tables.ledger_movements as Array<Record<string, unknown>>).find(
      (r) => r.id === 'm-amb',
    );
    expect(m?.client_id).toBe(NEXA);
    expect(m?.client_matched_by).toBe('person');
  });
});

describe('groupProposals', () => {
  it('agrupa por cliente y evidencia, y nombra a los rivales', () => {
    const groups = groupProposals(
      [
        {
          id: '1',
          client_id: 'a',
          entity_kind: 'ledger_movement',
          entity_id: 'm1',
          method: 'name_exact',
          evidence: 'NEXA SAS',
          label: 'x',
          occurred_at: '2026-09-01',
        },
        {
          id: '2',
          client_id: 'a',
          entity_kind: 'ledger_movement',
          entity_id: 'm2',
          method: 'name_exact',
          evidence: 'Nexa S.A.S.',
          label: 'y',
          occurred_at: '2026-09-02',
        },
        {
          id: '3',
          client_id: 'b',
          entity_kind: 'ledger_movement',
          entity_id: 'm1',
          method: 'name_exact',
          evidence: 'NEXA SAS',
          label: 'x',
          occurred_at: '2026-09-01',
        },
      ],
      new Map([
        ['a', 'Nexa'],
        ['b', 'Nexa Ltda'],
      ]),
    );
    const a = groups.find((g) => g.clientId === 'a');
    expect(a?.ids).toEqual(['1', '2']);
    expect(a?.rivals).toEqual(['Nexa Ltda']);
  });
});

describe('unir clientes', () => {
  it('se niega con dos NIT distintos', () => {
    expect(
      mergeRefusal(
        { id: 'a', name: 'A', tax_id: '890903938' },
        { id: 'b', name: 'B', tax_id: '899999068' },
      ),
    ).toMatch(/dos empresas distintas/);
    expect(
      mergeRefusal(
        { id: 'a', name: 'A', tax_id: '890903938' },
        { id: 'b', name: 'B', tax_id: null },
      ),
    ).toBeNull();
  });

  it('mueve todo, deja el nombre como alias y borra el repetido', async () => {
    const tables = fixture();
    (tables.clients as Array<Record<string, unknown>>).push(
      client(DUP, ACME, 'COLTRANS S.A.S.', null, '2026-03-01T00:00:00Z'),
    );
    tables.commitments = [
      { id: 'cm', organization_id: ACME, client_id: DUP, title: 'Pago', due_on: '2026-10-10' },
    ];
    (tables.ledger_movements as Array<Record<string, unknown>>).push(
      move('m-dup', ACME, { client_id: DUP, client_matched_by: 'person' }),
    );
    tables.client_links = [
      {
        id: 'l1',
        organization_id: ACME,
        client_id: DUP,
        entity_kind: 'meeting',
        entity_id: 'mt',
        entity_key: 'mt',
        method: 'manual',
        state: 'confirmed',
      },
    ];
    tables.client_notes = [];
    const fake = createFakeSupabase(tables);
    const db = createOrgScopedClient(withIds(fake.client), ACME);

    const result = await mergeClients(db, { keepId: COLTRANS, mergeId: DUP, userId: ANA });
    expect(result.kept.id).toBe(COLTRANS);
    expect(result.aliasesAdded).toEqual(['COLTRANS S.A.S.']);
    expect((fake.tables.clients as Array<{ id: string }>).some((c) => c.id === DUP)).toBe(false);
    expect((fake.tables.commitments as Array<{ client_id: string }>)[0]?.client_id).toBe(COLTRANS);
    expect(
      (fake.tables.ledger_movements as Array<Record<string, unknown>>).find((m) => m.id === 'm-dup')
        ?.client_id,
    ).toBe(COLTRANS);
    expect((fake.tables.client_links as Array<{ client_id: string }>)[0]?.client_id).toBe(COLTRANS);
    expect((fake.tables.client_notes as unknown[]).length).toBe(1);
    // La otra empresa, intacta.
    expect(
      (fake.tables.clients as Array<{ id: string }>).some((c) => c.id === GLOBEX_COLTRANS),
    ).toBe(true);
  });

  it('propone duplicados por nombre plegado, nunca con NIT distinto', () => {
    const pairs = duplicatePairs([
      {
        id: 'a',
        name: 'Coltrans',
        legal_name: null,
        tax_id: '890903938',
        created_at: '2026-02-01',
      },
      {
        id: 'b',
        name: 'COLTRANS S.A.S.',
        legal_name: null,
        tax_id: null,
        created_at: '2026-01-01',
      },
      {
        id: 'c',
        name: 'Coltrans Ltda',
        legal_name: null,
        tax_id: '899999068',
        created_at: '2026-01-01',
      },
    ]);
    // a+b sí (se queda el que tiene NIT); a+c no (dos NIT); b+c sí.
    const ids = pairs.map((p) => `${p.keep.id}<${p.merge.id}`).sort();
    expect(ids).toEqual(['a<b', 'c<b']);
  });
});
