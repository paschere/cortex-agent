import { beforeEach, describe, expect, it } from 'vitest';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import {
  addDomain,
  applyOrPropose,
  clientForEmail,
  clientOverview,
  confirmLink,
  getClient,
  listClients,
  matchCommitmentsToClients,
  registerClient,
  searchClients,
  unlinkedCounterparties,
} from '../store';

/**
 * TWO COMPANIES, ONE DATABASE — the clients half.
 *
 * The fixture is adversarial in the same way `tenancy/__tests__/isolation.test
 * .ts` is: Acme and Globex both have a client called Coltrans, with the same
 * NIT and the same email domain. Every one of those collisions is a row that a
 * query missing its tenant filter would return happily, and it would look
 * right. Nothing here asserts that a filter was called; every assertion is
 * about the rows that came back.
 *
 * The second half of the file tests the rule the whole schema exists for: a
 * link is APPLIED only when it repeats something a person stated, and one thing
 * can never be confirmed to two clients.
 */

const ACME = 'org-acme';
const GLOBEX = 'org-globex';

const ANA = '11111111-1111-4111-8111-111111111111'; // Acme
const CARLA = '33333333-3333-4333-8333-333333333333'; // Globex

const ACME_COLTRANS = 'aaaa0000-0000-4000-8000-000000000001';
const ACME_ALPHA = 'aaaa0000-0000-4000-8000-000000000002';
const GLOBEX_COLTRANS = 'bbbb0000-0000-4000-8000-000000000001';

const DOC_ACME = 'dddd0000-0000-4000-8000-000000000001';

function fixture(): Tables {
  return {
    users: [
      { id: ANA, organization_id: ACME, email: 'ana@acme.com', name: 'Ana' },
      { id: CARLA, organization_id: GLOBEX, email: 'carla@globex.com', name: 'Carla' },
    ],
    clients: [
      {
        id: ACME_COLTRANS,
        organization_id: ACME,
        name: 'Coltrans',
        legal_name: 'Colombiana de Transportes S.A.S.',
        tax_id: '890903938',
        name_key: 'coltrans',
        status: 'active',
        services: [],
        owner_user_id: ANA,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: ACME_ALPHA,
        organization_id: ACME,
        name: 'Alpha Cargo',
        legal_name: null,
        tax_id: '899999068',
        name_key: 'alphacargo',
        status: 'active',
        services: [],
        owner_user_id: null,
        created_at: '2026-01-02T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      },
      // Same name, same NIT, other company. A missing filter returns THIS.
      {
        id: GLOBEX_COLTRANS,
        organization_id: GLOBEX,
        name: 'Coltrans',
        legal_name: 'Colombiana de Transportes S.A.S.',
        tax_id: '890903938',
        name_key: 'coltrans',
        status: 'active',
        services: [],
        owner_user_id: CARLA,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
    client_domains: [
      {
        id: 'dom-acme',
        organization_id: ACME,
        client_id: ACME_COLTRANS,
        domain: 'coltrans.com',
        verified_by: ANA,
        verified_at: '2026-01-01T00:00:00Z',
        note: null,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'dom-globex',
        organization_id: GLOBEX,
        client_id: GLOBEX_COLTRANS,
        domain: 'coltrans.com',
        verified_by: CARLA,
        verified_at: '2026-01-01T00:00:00Z',
        note: null,
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    client_contacts: [],
    client_links: [],
    commitments: [
      {
        id: 'com-1',
        organization_id: ACME,
        title: 'Renovación de contrato',
        kind: 'contract',
        counterparty: 'Coltrans S.A.S.',
        client_id: null,
        due_on: '2026-09-30',
        notice_days: 45,
        state: 'in_force',
        review_state: 'confirmed',
        source_kind: 'manual',
        source_user_id: ANA,
        amount_cop: null,
        recurrence: 'none',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'com-2',
        organization_id: ACME,
        title: 'Pago de aranceles',
        kind: 'customs',
        // Not a client, and it must stay that way. A backfill that turned every
        // counterparty into a client would put the DIAN on the customer list.
        counterparty: 'DIAN',
        client_id: null,
        due_on: '2026-08-15',
        notice_days: 7,
        state: 'in_force',
        review_state: 'confirmed',
        source_kind: 'manual',
        source_user_id: ANA,
        amount_cop: 4_200_000,
        recurrence: 'none',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'com-3',
        organization_id: GLOBEX,
        title: 'Renovación de contrato',
        kind: 'contract',
        counterparty: 'Coltrans',
        client_id: null,
        due_on: '2026-10-31',
        notice_days: 45,
        state: 'in_force',
        review_state: 'confirmed',
        source_kind: 'manual',
        source_user_id: CARLA,
        amount_cop: null,
        recurrence: 'none',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
    kb_documents: [
      {
        id: DOC_ACME,
        organization_id: ACME,
        title: 'Contrato Coltrans 2026',
        status: 'ready',
        created_at: '2026-02-01T00:00:00Z',
      },
    ],
  };
}

let tables: Tables;
let acme: ReturnType<typeof createOrgScopedClient>;
let globex: ReturnType<typeof createOrgScopedClient>;

beforeEach(() => {
  tables = fixture();
  const fake = createFakeSupabase(tables);
  acme = createOrgScopedClient(fake.client, ACME);
  globex = createOrgScopedClient(fake.client, GLOBEX);
});

describe("a workspace cannot see another workspace's clients", () => {
  it('lists only its own, even when the names are identical', async () => {
    const mine = await listClients(acme);
    expect(mine.map((c) => c.id).sort()).toEqual([ACME_COLTRANS, ACME_ALPHA].sort());

    const theirs = await listClients(globex);
    expect(theirs.map((c) => c.id)).toEqual([GLOBEX_COLTRANS]);
  });

  it("refuses to fetch another workspace's client by id", async () => {
    expect(await getClient(acme, GLOBEX_COLTRANS)).toBeNull();
    expect(await getClient(globex, ACME_COLTRANS)).toBeNull();
  });

  it('searches within the workspace, NIT included', async () => {
    // The same NIT exists in both. Each side must find exactly its own row.
    const mine = await searchClients(acme, '890903938');
    expect(mine.map((h) => h.client.id)).toEqual([ACME_COLTRANS]);

    const theirs = await searchClients(globex, '890.903.938-8');
    expect(theirs.map((h) => h.client.id)).toEqual([GLOBEX_COLTRANS]);
  });

  it('finds a client by a domain, and only its own', async () => {
    const mine = await searchClients(acme, 'carlos@coltrans.com');
    expect(mine.map((h) => h.client.id)).toEqual([ACME_COLTRANS]);
    expect(mine[0]?.matchedOn).toBe('domain');
  });

  it('resolves an address to the client in this workspace', async () => {
    const mine = await clientForEmail(acme, 'Carlos.Ruiz@Coltrans.com');
    expect(mine?.clientId).toBe(ACME_COLTRANS);
    expect(mine?.method).toBe('email_domain');
    // The person who registered the domain is carried along, because that is
    // whose statement any resulting link cites.
    expect(mine?.witnessUserId).toBe(ANA);

    const theirs = await clientForEmail(globex, 'carlos@coltrans.com');
    expect(theirs?.clientId).toBe(GLOBEX_COLTRANS);
  });

  it('resolves nothing for an address nobody registered', async () => {
    expect(await clientForEmail(acme, 'alguien@desconocida.com')).toBeNull();
    // A free provider is never a client's domain, whatever else is on file.
    expect(await clientForEmail(acme, 'carlos.ruiz@gmail.com')).toBeNull();
  });

  it('keeps a new client inside the workspace that registered it', async () => {
    const { client, created } = await registerClient(acme, {
      name: 'Naviera del Pacífico',
      nit: '900123456',
      createdBy: ANA,
    });
    expect(created).toBe(true);
    expect(client.organization_id).toBe(ACME);
    expect(await getClient(globex, client.id)).toBeNull();
  });

  it('updates instead of duplicating when the same NIT comes back', async () => {
    const again = await registerClient(acme, {
      name: 'Coltrans Logística',
      nit: '890.903.938-8',
      city: 'Bogotá',
      createdBy: ANA,
    });
    expect(again.created).toBe(false);
    expect(again.client.id).toBe(ACME_COLTRANS);
    expect(again.client.city).toBe('Bogotá');
    expect((tables.clients as Array<{ organization_id: string }>).length).toBe(3);
  });
});

describe('domains', () => {
  it('refuses a free provider outright', async () => {
    await expect(
      addDomain(acme, { clientId: ACME_ALPHA, domain: 'gmail.com', userId: ANA }),
    ).rejects.toThrow(/correo público/);
  });

  it('refuses a domain already registered to another client here', async () => {
    await expect(
      addDomain(acme, { clientId: ACME_ALPHA, domain: 'coltrans.com', userId: ANA }),
    ).rejects.toThrow(/ya está registrado/);
  });

  it('does not see the other workspace holding the same domain', async () => {
    // Globex has coltrans.com too. Acme registering it for a second client of
    // its own must fail on ACME's row, not on Globex's — and Globex adding
    // alpha.com must not be blocked by anything of Acme's.
    const added = await addDomain(globex, {
      clientId: GLOBEX_COLTRANS,
      domain: 'coltranscargo.com',
      userId: CARLA,
    });
    expect(added.organization_id).toBe(GLOBEX);
  });
});

describe('a link is applied only when it repeats what a person said', () => {
  it('applies an email-domain match, in the name of whoever registered it', async () => {
    const owner = await clientForEmail(acme, 'carlos@coltrans.com');
    const result = await applyOrPropose(acme, {
      clientId: owner?.clientId as string,
      kind: 'email_thread',
      ref: 'thread-abc',
      label: 'Cotización Buenaventura',
      method: 'email_domain',
      evidence: owner?.evidence,
      witnessUserId: owner?.witnessUserId,
    });
    expect(result.outcome).toBe('applied');
    expect(result.link?.state).toBe('confirmed');
    expect(result.link?.confirmed_by).toBe(ANA);
  });

  // THE RULE. A name in a title is a good enough reason to ask and nowhere near
  // a good enough reason to apply.
  it('only proposes a name match, even a perfect one', async () => {
    const result = await applyOrPropose(acme, {
      clientId: ACME_COLTRANS,
      kind: 'document',
      id: DOC_ACME,
      label: 'Contrato Coltrans 2026',
      method: 'name_exact',
      evidence: 'Contrato Coltrans 2026',
      witnessUserId: ANA,
    });
    expect(result.outcome).toBe('proposed');
    expect(result.link?.state).toBe('suggested');
    expect(result.link?.confirmed_by).toBeNull();
  });

  it('refuses to apply anything with nobody standing behind it', async () => {
    await expect(
      applyOrPropose(acme, {
        clientId: ACME_COLTRANS,
        kind: 'email_thread',
        ref: 'thread-xyz',
        method: 'email_domain',
        witnessUserId: null,
      }),
    ).rejects.toThrow(/a nombre de alguien/);
  });

  it('never moves something that is already confirmed elsewhere', async () => {
    await applyOrPropose(acme, {
      clientId: ACME_COLTRANS,
      kind: 'document',
      id: DOC_ACME,
      method: 'manual',
      witnessUserId: ANA,
    });
    const second = await applyOrPropose(acme, {
      clientId: ACME_ALPHA,
      kind: 'document',
      id: DOC_ACME,
      method: 'manual',
      witnessUserId: ANA,
    });
    expect(second.outcome).toBe('taken_by_another_client');
    expect(second.link).toBeNull();
    expect(second.heldBy?.id).toBe(ACME_COLTRANS);
  });

  it('is idempotent: the same proposal twice is still one proposal', async () => {
    const first = await applyOrPropose(acme, {
      clientId: ACME_COLTRANS,
      kind: 'document',
      id: DOC_ACME,
      method: 'name_exact',
      witnessUserId: ANA,
    });
    const second = await applyOrPropose(acme, {
      clientId: ACME_COLTRANS,
      kind: 'document',
      id: DOC_ACME,
      method: 'name_exact',
      witnessUserId: ANA,
    });
    expect(first.outcome).toBe('proposed');
    expect(second.outcome).toBe('proposed');
  });

  it('turns a proposal into a fact only through a person', async () => {
    const proposed = await applyOrPropose(acme, {
      clientId: ACME_COLTRANS,
      kind: 'document',
      id: DOC_ACME,
      method: 'name_exact',
      witnessUserId: ANA,
    });
    const confirmed = await confirmLink(acme, { id: proposed.link?.id as string, userId: ANA });
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.confirmed_by).toBe(ANA);
    expect(confirmed.confirmed_at).toBeTruthy();
  });
});

describe('adopting the commitments that already exist', () => {
  it('links what is unambiguous and leaves the rest alone', async () => {
    const result = await matchCommitmentsToClients(acme);
    // "Coltrans S.A.S." → Coltrans. "DIAN" → nothing, and that is correct.
    expect(result.matched).toBe(1);
    expect(result.unmatched).toBe(1);

    const rows = tables.commitments as Array<{ id: string; client_id: string | null }>;
    expect(rows.find((r) => r.id === 'com-1')?.client_id).toBe(ACME_COLTRANS);
    expect(rows.find((r) => r.id === 'com-2')?.client_id).toBeNull();
    // Globex's row is untouched: a scoped handle never reached it.
    expect(rows.find((r) => r.id === 'com-3')?.client_id).toBeNull();
  });

  it('never crosses a workspace boundary', async () => {
    await matchCommitmentsToClients(globex);
    const rows = tables.commitments as Array<{ id: string; client_id: string | null }>;
    expect(rows.find((r) => r.id === 'com-3')?.client_id).toBe(GLOBEX_COLTRANS);
    expect(rows.find((r) => r.id === 'com-1')?.client_id).toBeNull();
  });

  it('reports what is still unclaimed, with the candidates', async () => {
    const backlog = await unlinkedCounterparties(acme);
    const labels = backlog.map((b) => b.counterparty);
    expect(labels).toContain('DIAN');
    expect(backlog.find((b) => b.counterparty === 'DIAN')?.candidates).toEqual([]);
  });
});

describe('the card', () => {
  it('shows what is applied and keeps proposals apart from it', async () => {
    await matchCommitmentsToClients(acme);
    await applyOrPropose(acme, {
      clientId: ACME_COLTRANS,
      kind: 'document',
      id: DOC_ACME,
      label: 'Contrato Coltrans 2026',
      method: 'name_exact',
      witnessUserId: ANA,
    });
    await applyOrPropose(acme, {
      clientId: ACME_COLTRANS,
      kind: 'email_thread',
      ref: 'thread-abc',
      label: 'Cotización Buenaventura',
      method: 'email_domain',
      evidence: 'carlos@coltrans.com · @coltrans.com',
      witnessUserId: ANA,
    });

    const overview = await clientOverview(acme, ACME_COLTRANS, '2026-08-01');
    expect(overview.client.name).toBe('Coltrans');
    expect(overview.domains.map((d) => d.domain)).toEqual(['coltrans.com']);
    expect(overview.commitments.map((c) => c.title)).toEqual(['Renovación de contrato']);
    // One applied, one waiting. The counts only ever reflect the applied ones.
    expect(overview.counts.emailThreads).toBe(1);
    expect(overview.counts.documents).toBe(0);
    expect(overview.proposals).toHaveLength(1);
  });
});
