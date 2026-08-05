import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getVisibleDocument,
  getVisibleSpace,
  listVisibleSpaces,
  searchSpaces,
} from '../../kb/spaces';
import { loadMemoryContext, rememberMemory } from '../../memory/store';
import { createOrgScopedClient } from '../scoped-client';
import { type Tables, createFakeSupabase } from './fake-postgrest';

/**
 * TWO COMPANIES, ONE DATABASE.
 *
 * This is the test the product is being sold on. Acme and Globex both signed up,
 * both have people, conversations, Brain Knowledge, routines, pipelines and
 * vehicles, and NOTHING either of them does may show them a row belonging to the
 * other. The fixture below is deliberately adversarial: the two workspaces have
 * a person with the same name, a global space with the same name, a pipeline
 * with the same slug and a routine with the same name, so a query that has lost
 * its tenant filter returns something plausible rather than something empty —
 * which is exactly how this kind of bug survives review.
 *
 * The subject under test is the real `createOrgScopedClient` wrapping a real
 * (if small) PostgREST implementation, and the code exercised is the real
 * product code — `spaces.ts` for Brain Knowledge, `memory/store.ts` for
 * memories. Nothing here asserts that a filter was "called"; every assertion is
 * about the rows that came back.
 */

const ACME = 'org-acme';
const GLOBEX = 'org-globex';

const ANA = '11111111-1111-4111-8111-111111111111'; // Acme
const BEN = '22222222-2222-4222-8222-222222222222'; // Acme
const CARLA = '33333333-3333-4333-8333-333333333333'; // Globex

const SPACE_ACME_GENERAL = 'aaaa1111-0000-4000-8000-000000000001';
const SPACE_ACME_ANA = 'aaaa2222-0000-4000-8000-000000000002';
const SPACE_GLOBEX_GENERAL = 'bbbb1111-0000-4000-8000-000000000001';
const SPACE_GLOBEX_CARLA = 'bbbb2222-0000-4000-8000-000000000002';

const DOC_ACME = 'dddd1111-0000-4000-8000-000000000001';
const DOC_GLOBEX = 'dddd2222-0000-4000-8000-000000000002';
const DOC_CARLA = 'dddd3333-0000-4000-8000-000000000003';

function fixture(): Tables {
  return {
    users: [
      { id: ANA, organization_id: ACME, email: 'ana@acme.com', name: 'Ana', role: 'org_admin' },
      { id: BEN, organization_id: ACME, email: 'ben@acme.com', name: 'Ben', role: 'member' },
      {
        id: CARLA,
        organization_id: GLOBEX,
        email: 'ana@globex.com',
        name: 'Ana',
        role: 'org_admin',
      },
    ],
    kb_collections: [
      {
        id: SPACE_ACME_GENERAL,
        organization_id: ACME,
        scope: 'global',
        scope_id: null,
        name: 'General',
        description: null,
        created_by: ANA,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: SPACE_ACME_ANA,
        organization_id: ACME,
        scope: 'user',
        scope_id: ANA,
        name: 'Mis notas',
        description: null,
        created_by: ANA,
        created_at: '2026-01-02T00:00:00Z',
      },
      // Same name, different company. A missing filter returns this instead of
      // nothing, which is what makes the failure invisible in real life.
      {
        id: SPACE_GLOBEX_GENERAL,
        organization_id: GLOBEX,
        scope: 'global',
        scope_id: null,
        name: 'General',
        description: null,
        created_by: CARLA,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: SPACE_GLOBEX_CARLA,
        organization_id: GLOBEX,
        scope: 'user',
        scope_id: CARLA,
        name: 'Mis notas',
        description: null,
        created_by: CARLA,
        created_at: '2026-01-03T00:00:00Z',
      },
    ],
    kb_documents: [
      {
        id: DOC_ACME,
        organization_id: ACME,
        collection_id: SPACE_ACME_GENERAL,
        title: 'Tarifas Acme 2026',
        uploaded_by: ANA,
        status: 'ready',
        created_at: '2026-02-01T00:00:00Z',
      },
      {
        id: DOC_GLOBEX,
        organization_id: GLOBEX,
        collection_id: SPACE_GLOBEX_GENERAL,
        title: 'Tarifas Globex 2026',
        uploaded_by: CARLA,
        status: 'ready',
        created_at: '2026-02-01T00:00:00Z',
      },
      {
        id: DOC_CARLA,
        organization_id: GLOBEX,
        collection_id: SPACE_GLOBEX_CARLA,
        title: 'Notas privadas de Carla',
        uploaded_by: CARLA,
        status: 'ready',
        created_at: '2026-02-02T00:00:00Z',
      },
    ],
    kb_chunks: [
      {
        id: 'c1',
        document_id: DOC_ACME,
        chunk_index: 0,
        content: 'Un desarrollador React senior se cotiza en 8.500 USD al mes.',
        metadata: {},
      },
      {
        id: 'c2',
        document_id: DOC_GLOBEX,
        chunk_index: 0,
        content: 'Globex cotiza React senior en 7.900 USD al mes.',
        metadata: {},
      },
      {
        id: 'c3',
        document_id: DOC_CARLA,
        chunk_index: 0,
        content: 'Carla piensa bajar la tarifa de React a 7.000 para cerrar.',
        metadata: {},
      },
    ],
    conversations: [
      { id: 'cv-acme', organization_id: ACME, user_id: ANA, title: 'Propuesta para el cliente' },
      {
        id: 'cv-globex',
        organization_id: GLOBEX,
        user_id: CARLA,
        title: 'Propuesta para el cliente',
      },
    ],
    messages: [
      {
        id: 'm-acme',
        organization_id: ACME,
        conversation_id: 'cv-acme',
        role: 'user',
        content: 'Acme: subimos la tarifa a 9.200',
      },
      {
        id: 'm-globex',
        organization_id: GLOBEX,
        conversation_id: 'cv-globex',
        role: 'user',
        content: 'Globex: bajamos la tarifa a 7.000',
      },
    ],
    pipelines: [
      {
        id: 'p-acme',
        organization_id: ACME,
        slug: 'onboarding',
        name: 'Onboarding',
        archived: false,
      },
      {
        id: 'p-globex',
        organization_id: GLOBEX,
        slug: 'onboarding',
        name: 'Onboarding',
        archived: false,
      },
    ],
    pipeline_runs: [
      { id: 'pr-acme', organization_id: ACME, pipeline_id: 'p-acme', status: 'completed' },
      { id: 'pr-globex', organization_id: GLOBEX, pipeline_id: 'p-globex', status: 'completed' },
    ],
    scheduled_jobs: [
      {
        id: 'j-acme',
        organization_id: ACME,
        user_id: ANA,
        name: 'Resumen diario',
        status: 'active',
      },
      {
        id: 'j-globex',
        organization_id: GLOBEX,
        user_id: CARLA,
        name: 'Resumen diario',
        status: 'active',
      },
    ],
    scheduled_job_runs: [
      { id: 'jr-acme', organization_id: ACME, job_id: 'j-acme', status: 'ok', output: 'Acme ok' },
      {
        id: 'jr-globex',
        organization_id: GLOBEX,
        job_id: 'j-globex',
        status: 'ok',
        output: 'Globex ok',
      },
    ],
    vehicles: [
      { id: 'v-acme', organization_id: ACME, user_id: ANA, plate: 'ABC123', archived: false },
      { id: 'v-globex', organization_id: GLOBEX, user_id: CARLA, plate: 'XYZ789', archived: false },
    ],
    vehicle_fines: [
      {
        id: 'f-acme',
        organization_id: ACME,
        vehicle_id: 'v-acme',
        code: 'C14',
        amount_cop: 500000,
      },
      {
        id: 'f-globex',
        organization_id: GLOBEX,
        vehicle_id: 'v-globex',
        code: 'C29',
        amount_cop: 900000,
      },
    ],
    audit_events: [],
    user_memories: [],
  };
}

/**
 * `kb_search_scoped`, implemented the way migration 0064 implements it — the
 * visible set is derived from the person, whose workspace comes from their
 * directory row, and `p_space_ids` can only narrow it.
 */
function kbSearchScoped(args: Record<string, unknown>, tables: Tables) {
  const userId = args.p_user_id as string | null;
  const requested = (args.p_space_ids as string[] | null) ?? null;
  const query = String(args.p_query_text ?? '').toLowerCase();
  if (!userId) return [];

  const person = tables.users?.find((u) => u.id === userId);
  if (!person) return [];

  const visible = (tables.kb_collections ?? []).filter(
    (c) =>
      c.organization_id === person.organization_id &&
      (c.scope === 'global' || (c.scope === 'user' && c.scope_id === userId)),
  );
  const targets = visible
    .filter((c) => requested === null || requested.includes(c.id as string))
    .map((c) => c.id as string);

  return (tables.kb_chunks ?? [])
    .map((ch) => {
      const doc = (tables.kb_documents ?? []).find((d) => d.id === ch.document_id);
      const space = (tables.kb_collections ?? []).find((c) => c.id === doc?.collection_id);
      return { ch, doc, space };
    })
    .filter(
      ({ doc, space, ch }) =>
        doc &&
        space &&
        targets.includes(space.id as string) &&
        String(ch.content).toLowerCase().includes(query),
    )
    .map(({ ch, doc, space }) => ({
      document_id: doc?.id,
      document_title: doc?.title,
      space_id: space?.id,
      space_name: space?.name,
      space_scope: space?.scope,
      chunk_index: ch.chunk_index,
      content: ch.content,
      score: 0.9,
      metadata: ch.metadata,
    }));
}

/** The memory functions from 0051, which key everything off the person. */
function memoryRpcs() {
  return {
    user_memory_context: (args: Record<string, unknown>, tables: Tables) =>
      (tables.user_memories ?? [])
        .filter((m) => m.user_id === args.p_user_id && m.status === 'active')
        .map((m) => ({ id: m.id, content: m.content, kind: m.kind, source: m.source })),
    user_memory_remember: (args: Record<string, unknown>, tables: Tables) => {
      const id = `mem-${(tables.user_memories ?? []).length + 1}`;
      tables.user_memories ??= [];
      tables.user_memories.push({
        id,
        user_id: args.p_user_id,
        content: args.p_content,
        kind: args.p_kind ?? 'fact',
        status: args.p_status ?? 'active',
        source: args.p_source ?? 'explicit',
      });
      return id;
    },
  };
}

function world() {
  const fake = createFakeSupabase(fixture(), {
    kb_search_scoped: kbSearchScoped,
    ...memoryRpcs(),
  });
  return {
    ...fake,
    acme: createOrgScopedClient(fake.client, ACME),
    globex: createOrgScopedClient(fake.client, GLOBEX),
  };
}

// A Voyage response shaped like the real one; the values never matter here
// because the fake ranks by substring.
function stubEmbedding() {
  process.env.VOYAGE_API_KEY = 'test-key';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }],
      }),
      text: async () => '',
    }),
  );
}

beforeEach(() => {
  stubEmbedding();
});

describe('conversations', () => {
  it('one company never sees the other, even with identical titles', async () => {
    const w = world();

    const { data: acme } = await w.acme.from('conversations').select('id, title');
    expect((acme as Array<{ id: string }>).map((c) => c.id)).toEqual(['cv-acme']);

    const { data: globex } = await w.globex.from('conversations').select('id, title');
    expect((globex as Array<{ id: string }>).map((c) => c.id)).toEqual(['cv-globex']);
  });

  it('knowing the other company’s conversation id is not enough to read it', async () => {
    const w = world();
    const { data } = await w.acme
      .from('conversations')
      .select('id, title')
      .eq('id', 'cv-globex')
      .maybeSingle();
    expect(data).toBeNull();
  });

  it('messages are scoped too, not only the conversations that hold them', async () => {
    const w = world();
    const { data } = await w.acme.from('messages').select('content');
    expect((data as Array<{ content: string }>).map((m) => m.content)).toEqual([
      'Acme: subimos la tarifa a 9.200',
    ]);
  });

  it('an insert lands in the caller’s workspace and cannot be aimed at another', async () => {
    const w = world();
    await w.acme
      .from('conversations')
      .insert({ id: 'cv-new', user_id: ANA, title: 'Nueva', organization_id: GLOBEX });

    const planted = w.tables.conversations?.find((c) => c.id === 'cv-new');
    expect(planted?.organization_id).toBe(ACME);

    const { data: globex } = await w.globex.from('conversations').select('id');
    expect((globex as Array<{ id: string }>).map((c) => c.id)).toEqual(['cv-globex']);
  });

  it('an update cannot move a row to another workspace', async () => {
    const w = world();
    await w.acme
      .from('conversations')
      .update({ title: 'Renombrada', organization_id: GLOBEX })
      .eq('id', 'cv-acme');

    const row = w.tables.conversations?.find((c) => c.id === 'cv-acme');
    expect(row?.organization_id).toBe(ACME);
    expect(row?.title).toBe('Renombrada');
  });

  it('a delete aimed at another workspace’s row does nothing', async () => {
    const w = world();
    await w.acme.from('conversations').delete().eq('id', 'cv-globex');
    expect(w.tables.conversations?.some((c) => c.id === 'cv-globex')).toBe(true);
  });
});

describe('Brain Knowledge', () => {
  it('lists only this company’s spaces, including its own "General"', async () => {
    const w = world();

    const acme = await listVisibleSpaces(w.acme, ANA);
    expect(acme.map((s) => s.id).sort()).toEqual([SPACE_ACME_GENERAL, SPACE_ACME_ANA].sort());

    const globex = await listVisibleSpaces(w.globex, CARLA);
    expect(globex.map((s) => s.id).sort()).toEqual(
      [SPACE_GLOBEX_GENERAL, SPACE_GLOBEX_CARLA].sort(),
    );
  });

  it('a colleague sees the company space but not a personal one', async () => {
    const w = world();
    const ben = await listVisibleSpaces(w.acme, BEN);
    expect(ben.map((s) => s.id)).toEqual([SPACE_ACME_GENERAL]);
  });

  it('another company’s space reads as missing, never as forbidden', async () => {
    const w = world();
    await expect(getVisibleSpace(w.acme, ANA, SPACE_GLOBEX_GENERAL)).rejects.toThrow(
      /no longer exists/i,
    );
  });

  it('semantic search never crosses the boundary', async () => {
    const w = world();

    const acme = await searchSpaces(w.acme, { userId: ANA, query: 'React' });
    expect(acme.map((h) => h.documentTitle)).toEqual(['Tarifas Acme 2026']);

    const globex = await searchSpaces(w.globex, { userId: CARLA, query: 'React' });
    expect(globex.map((h) => h.documentTitle).sort()).toEqual([
      'Notas privadas de Carla',
      'Tarifas Globex 2026',
    ]);
  });

  it('search cannot be aimed at another company’s space by id', async () => {
    const w = world();
    const hits = await searchSpaces(w.acme, {
      userId: ANA,
      query: 'React',
      spaceIds: [SPACE_GLOBEX_GENERAL],
    });
    expect(hits).toEqual([]);
  });

  it('a document id from the other company does not open the document', async () => {
    const w = world();
    await expect(getVisibleDocument(w.acme, ANA, DOC_GLOBEX)).rejects.toThrow(
      /no longer in Brain Knowledge/i,
    );
    await expect(getVisibleDocument(w.acme, ANA, DOC_ACME)).resolves.toMatchObject({
      title: 'Tarifas Acme 2026',
    });
  });

  it('chunks cannot be read without naming a document, so they cannot be swept', async () => {
    const w = world();
    // The shape of the leak this prevents: "give me every chunk in the install".
    await expect(w.acme.from('kb_chunks').select('content')).rejects.toThrow(/document_id/);
    // Naming the document is allowed, and the document itself is scoped.
    const { data } = await w.acme.from('kb_chunks').select('content').eq('document_id', DOC_ACME);
    expect((data as Array<{ content: string }>).length).toBe(1);
  });
});

describe('routines, pipelines and vehicles', () => {
  it('routines with the same name stay in their own company', async () => {
    const w = world();
    const { data: acme } = await w.acme.from('scheduled_jobs').select('id, name');
    expect((acme as Array<{ id: string }>).map((j) => j.id)).toEqual(['j-acme']);

    const { data: runs } = await w.globex.from('scheduled_job_runs').select('output');
    expect((runs as Array<{ output: string }>).map((r) => r.output)).toEqual(['Globex ok']);
  });

  it('a pipeline slug is unique per company and resolves to the caller’s own', async () => {
    const w = world();
    const { data: acme } = await w.acme
      .from('pipelines')
      .select('id')
      .eq('slug', 'onboarding')
      .maybeSingle();
    expect((acme as { id: string }).id).toBe('p-acme');

    const { data: globex } = await w.globex
      .from('pipelines')
      .select('id')
      .eq('slug', 'onboarding')
      .maybeSingle();
    expect((globex as { id: string }).id).toBe('p-globex');
  });

  it('pipeline runs do not leak through the shared slug', async () => {
    const w = world();
    const { data } = await w.acme.from('pipeline_runs').select('id');
    expect((data as Array<{ id: string }>).map((r) => r.id)).toEqual(['pr-acme']);
  });

  it('vehicles and their fines are per company', async () => {
    const w = world();
    const { data: vehicles } = await w.acme.from('vehicles').select('plate');
    expect((vehicles as Array<{ plate: string }>).map((v) => v.plate)).toEqual(['ABC123']);

    const { data: fines } = await w.globex.from('vehicle_fines').select('code');
    expect((fines as Array<{ code: string }>).map((f) => f.code)).toEqual(['C29']);
  });

  it('the directory shows colleagues only', async () => {
    const w = world();
    const { data } = await w.acme.from('users').select('email');
    expect((data as Array<{ email: string }>).map((u) => u.email).sort()).toEqual([
      'ana@acme.com',
      'ben@acme.com',
    ]);
    // Two people called Ana, one in each company. Matching on the name alone
    // still cannot reach across.
    const { data: byName } = await w.acme.from('users').select('id').eq('name', 'Ana');
    expect((byName as Array<{ id: string }>).map((u) => u.id)).toEqual([ANA]);
  });
});

describe('memories', () => {
  it('a memory is written for the caller and read back only by their company', async () => {
    const w = world();
    await rememberMemory(w.acme, { userId: ANA, content: 'Prefiere costos en USD.' });
    await rememberMemory(w.globex, { userId: CARLA, content: 'Prefiere costos en COP.' });

    expect((await loadMemoryContext(w.acme, ANA)).map((m) => m.content)).toEqual([
      'Prefiere costos en USD.',
    ]);
    expect((await loadMemoryContext(w.globex, CARLA)).map((m) => m.content)).toEqual([
      'Prefiere costos en COP.',
    ]);
  });
});
