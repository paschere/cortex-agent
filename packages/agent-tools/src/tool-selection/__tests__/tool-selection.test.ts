import type { SupabaseClient } from '@supabase/supabase-js';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '../../kb/embedder';
import { BASE_FAMILIES, type SelectableTool, selectToolsForTurn } from '../index';
import { toolEmbedText } from '../rank';
import { resetToolVectorCache, toolVectorHash } from '../store';

const VOYAGE = 'https://api.voyageai.com/v1/embeddings';

// ---------------------------------------------------------------------------
// A stand-in for Voyage that actually carries meaning.
//
// Returning random or constant vectors would make every assertion below vacuous
// — the ranking would "pass" while being incapable of telling a plate lookup
// from a payroll run. This projects each word onto one dimension and normalises,
// so cosine similarity is word overlap. Crude next to a real embedding model,
// but it is a genuine semantic signal, and it is the one property the selector
// depends on.
// ---------------------------------------------------------------------------

function dimensionOf(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % EMBEDDING_DIMENSIONS;
}

function bagOfWords(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    vector[dimensionOf(word)] = (vector[dimensionOf(word)] as number) + 1;
  }
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

/** How the app writes a vector, and how PostgREST reads one back. */
function toPgVector(values: number[]): string {
  return `[${values.join(',')}]`;
}

let embedCalls: Array<{ input: string[]; input_type: string }> = [];

function voyageOk() {
  return http.post(VOYAGE, async ({ request }) => {
    const body = (await request.json()) as { input: string[]; input_type: string };
    embedCalls.push(body);
    return HttpResponse.json({
      data: body.input.map((text, index) => ({ embedding: bagOfWords(text), index })),
    });
  });
}

const server = setupServer(voyageOk());

// ---------------------------------------------------------------------------
// A stand-in for `tool_embeddings`.
// ---------------------------------------------------------------------------

interface StoredRow {
  tool_key: string;
  family: string;
  text_hash: string;
  embedding: string | number[];
}

function fakeDb(rows: Map<string, StoredRow>): {
  db: SupabaseClient;
  rows: Map<string, StoredRow>;
  selects: number;
} {
  const state = { selects: 0 };
  const db = {
    from(_table: string) {
      return {
        select(_columns: string) {
          return {
            async in(_column: string, keys: string[]) {
              state.selects += 1;
              return {
                data: keys.map((k) => rows.get(k)).filter(Boolean),
                error: null,
              };
            },
          };
        },
        async upsert(incoming: StoredRow[]) {
          for (const row of incoming) rows.set(row.tool_key, row);
          return { data: null, error: null };
        },
      };
    },
  };
  return {
    db: db as unknown as SupabaseClient,
    rows,
    get selects() {
      return state.selects;
    },
  };
}

/** Pre-index a catalogue, exactly as a warmed-up deployment would be. */
async function seed(tools: SelectableTool[]): Promise<Map<string, StoredRow>> {
  const rows = new Map<string, StoredRow>();
  for (const tool of tools) {
    const text = toolEmbedText(tool);
    rows.set(tool.id, {
      tool_key: tool.id,
      family: tool.family ?? (tool.id.split('.')[0] as string),
      // Hashed exactly as production hashes it — text AND model. Restating the
      // rule here instead would let the fixture drift from the code and make a
      // fully-indexed deployment look un-indexed to every test below.
      text_hash: await toolVectorHash(text),
      embedding: toPgVector(bagOfWords(text)),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// A catalogue big enough that selection actually engages (>40 tools).
// ---------------------------------------------------------------------------

function family(name: string, blurb: string, count: number): SelectableTool[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${name}.action_${i}`,
    description: `${blurb} (variant ${i}).`,
  }));
}

function catalogue(): SelectableTool[] {
  return [
    // Base families — never ranked, always sent.
    ...family('kb', 'Search the company Brain Knowledge for saved documents and notes', 7),
    ...family('cortex', 'Remember or forget a durable personal instruction', 5),
    ...family('web', 'Search the public internet and fetch a page', 2),
    ...family('pipeline', 'Summarise the sales pipeline stages and totals', 6),
    ...family('schedule', 'Create an unattended recurring routine', 3),
    // Situational families with distinct vocabulary.
    ...family('gmail', 'Read and draft an email message in the inbox and send a reply', 6),
    ...family('gcal', 'Create a calendar event and list meetings on the agenda', 4),
    ...family('payroll', 'Report the salary and compensation paid to an employee', 9),
    ...family('github', 'Open a pull request and list commits in a repository', 10),
  ];
}

const VEHICLES: SelectableTool[] = family(
  'vehicles',
  'Consulta un vehiculo colombiano por su placa en el RUNT y sus comparendos',
  6,
);

const PLATE_QUERY = 'necesito consultar la placa ABC123 en el RUNT del vehiculo';

function familiesIn(tools: SelectableTool[]): Set<string> {
  return new Set(tools.map((t) => t.family ?? (t.id.split('.')[0] as string)));
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers(voyageOk());
  embedCalls = [];
});
afterAll(() => server.close());

beforeEach(() => {
  process.env.VOYAGE_API_KEY = 'test-voyage-key';
  // The vector cache is module state that survives between tests, exactly as it
  // survives between requests in a warm lambda.
  resetToolVectorCache();
});

// ---------------------------------------------------------------------------

describe('a family nobody configured', () => {
  it('is reachable on the turn that asks for it, with no list to edit', async () => {
    // The vehicles incident, reproduced: a family that is registered, granted,
    // and mentioned in no regex anywhere. Indexed like every other family,
    // because indexing is automatic.
    const tools = [...catalogue(), ...VEHICLES];
    const { db } = fakeDb(await seed(tools));

    const result = await selectToolsForTurn({ db, tools, query: PLATE_QUERY });

    expect(result.reason).toBe('semantic');
    expect(result.selectedFamilies[0]).toBe('vehicles');
    expect(familiesIn(result.tools).has('vehicles')).toBe(true);
  });

  it('travels as a whole family, not as the one tool that matched', async () => {
    // Half a family is worse than none: the model reads a plate, tries to fetch
    // the fines, finds nothing, and reports the integration is broken.
    const tools = [...catalogue(), ...VEHICLES];
    const { db } = fakeDb(await seed(tools));

    const result = await selectToolsForTurn({ db, tools, query: PLATE_QUERY });

    expect(result.tools.filter((t) => t.id.startsWith('vehicles.'))).toHaveLength(VEHICLES.length);
  });

  it('is sent even before anything has embedded it', async () => {
    // The first minutes after a deploy, and every MCP server the moment someone
    // connects one: there is no vector yet, so it cannot be ranked. Unrankable
    // must mean "sent", never "hidden" — that distinction is the whole bug.
    const tools = [...catalogue(), ...VEHICLES];
    const { db } = fakeDb(await seed(catalogue())); // vehicles deliberately absent

    const result = await selectToolsForTurn({ db, tools, query: 'how is the pipeline looking' });

    expect(result.unrankedFamilies).toContain('vehicles');
    expect(result.tools.filter((t) => t.id.startsWith('vehicles.'))).toHaveLength(VEHICLES.length);
    // The background index is genuinely in flight at this point — settle it so
    // it cannot land in the middle of the next test's cache.
    await result.indexing;
  });

  it('indexes itself in the background, so the next turn can rank it', async () => {
    const tools = [...catalogue(), ...VEHICLES];
    const store = fakeDb(await seed(catalogue()));

    const first = await selectToolsForTurn({
      db: store.db,
      tools,
      query: 'how is the pipeline looking',
    });
    await first.indexing;

    for (const tool of VEHICLES) expect(store.rows.has(tool.id)).toBe(true);
    // Indexed as documents, retrieved as a query — Voyage places the two
    // asymmetrically and getting it backwards degrades ranking silently.
    expect(embedCalls.map((c) => c.input_type).sort()).toEqual(['document', 'query']);

    resetToolVectorCache();
    const second = await selectToolsForTurn({ db: store.db, tools, query: PLATE_QUERY });
    expect(second.unrankedFamilies).not.toContain('vehicles');
    expect(second.selectedFamilies[0]).toBe('vehicles');
  });

  it('re-embeds when a description is edited, and keeps sending it meanwhile', async () => {
    const tools = [...catalogue(), ...VEHICLES];
    const store = fakeDb(await seed(tools));

    const edited = tools.map((t) =>
      t.id === 'vehicles.action_0' ? { ...t, description: 'Completely rewritten this deploy.' } : t,
    );
    const result = await selectToolsForTurn({
      db: store.db,
      tools: edited,
      query: 'how is the pipeline looking',
    });
    await result.indexing;

    // Stale is treated exactly like missing: included now, re-indexed for later.
    expect(result.unrankedFamilies).toContain('vehicles');
    expect(store.rows.get('vehicles.action_0')?.text_hash).toBe(
      await toolVectorHash(
        toolEmbedText(edited.find((t) => t.id === 'vehicles.action_0') as SelectableTool),
      ),
    );
  });
});

describe('an MCP server connected this afternoon', () => {
  it('is ranked by what its tools say they do, like any other family', async () => {
    const serverId = '7f1f0c9e-0000-4000-8000-000000000001';
    const mcp: SelectableTool[] = [
      {
        id: `mcp:${serverId}:create_invoice`,
        family: `mcp:${serverId}`,
        description: 'Create an invoice in Stripe and email it to the customer',
      },
      {
        id: `mcp:${serverId}:refund_charge`,
        family: `mcp:${serverId}`,
        description: 'Refund a Stripe charge to the customer card',
      },
    ];
    const tools = [...catalogue(), ...mcp];
    const { db } = fakeDb(await seed(tools));

    const result = await selectToolsForTurn({
      db,
      tools,
      query: 'refund the Stripe charge on that customer invoice',
    });

    expect(result.selectedFamilies[0]).toBe(`mcp:${serverId}`);
    expect(result.tools.filter((t) => t.id.startsWith('mcp:'))).toHaveLength(2);
  });
});

describe('when embedding fails', () => {
  it('sends the whole catalogue rather than leaving the model with a stub', async () => {
    const tools = [...catalogue(), ...VEHICLES];
    const { db } = fakeDb(await seed(tools));
    server.use(http.post(VOYAGE, () => new HttpResponse('unauthorized', { status: 401 })));

    const result = await selectToolsForTurn({ db, tools, query: PLATE_QUERY });

    expect(result.reason).toBe('embedding-unavailable');
    expect(result.tools).toHaveLength(tools.length);
  });

  it('does the same when the deployment has no Voyage key at all', async () => {
    process.env.VOYAGE_API_KEY = '';
    const tools = [...catalogue(), ...VEHICLES];
    const { db } = fakeDb(await seed(tools));

    const result = await selectToolsForTurn({ db, tools, query: PLATE_QUERY });

    expect(result.reason).toBe('embedding-unavailable');
    expect(result.tools).toHaveLength(tools.length);
  });

  it('survives a vector table that is not answering', async () => {
    const tools = [...catalogue(), ...VEHICLES];
    const broken = {
      from: () => ({
        select: () => ({
          in: async () => {
            throw new Error('connection refused');
          },
        }),
        upsert: async () => ({ data: null, error: null }),
      }),
    } as unknown as SupabaseClient;

    const result = await selectToolsForTurn({ db: broken, tools, query: PLATE_QUERY });
    await result.indexing;

    // Nothing is rankable, so nothing may be filtered.
    expect(result.tools).toHaveLength(tools.length);
  });
});

describe('the tools that are always there', () => {
  it('keeps the base families whatever the turn is about', async () => {
    const tools = [...catalogue(), ...VEHICLES];
    const { db } = fakeDb(await seed(tools));

    const result = await selectToolsForTurn({ db, tools, query: PLATE_QUERY });

    const present = familiesIn(result.tools);
    for (const base of BASE_FAMILIES) {
      // `format` is in the list and has no tools — a base family that matches
      // nothing is inert, which is the property the old CORE_FAMILIES list
      // lacked in the other direction.
      const exists = tools.some((t) => t.id.startsWith(`${base}.`));
      if (exists) expect(present.has(base)).toBe(true);
    }
  });

  it('answers a greeting with the base families and not much else', async () => {
    const tools = [...catalogue(), ...VEHICLES];
    const { db } = fakeDb(await seed(tools));

    const result = await selectToolsForTurn({ db, tools, query: 'hola' });

    expect(result.tools.length).toBeLessThan(tools.length);
    // At most one situational family survives: below the floor the selector
    // still takes the single best match rather than trusting the threshold.
    expect(result.selectedFamilies.length).toBeLessThanOrEqual(1);
  });

  it('never hands back fewer tools than the floor', async () => {
    const tools = [...catalogue(), ...VEHICLES];
    const { db } = fakeDb(await seed(tools));

    const result = await selectToolsForTurn({ db, tools, query: PLATE_QUERY });
    expect(result.tools.length).toBeGreaterThanOrEqual(10);
  });
});

describe('what it costs', () => {
  it('does not embed anything on a deployment small enough not to need it', async () => {
    const tools = family('kb', 'Search Brain Knowledge', 5);
    const { db } = fakeDb(new Map());

    const result = await selectToolsForTurn({ db, tools, query: PLATE_QUERY });

    expect(result.reason).toBe('below-threshold');
    expect(result.tools).toHaveLength(tools.length);
    expect(embedCalls).toHaveLength(0);
  });

  it('costs a warm instance one embedding and no database read', async () => {
    const tools = [...catalogue(), ...VEHICLES];
    const store = fakeDb(await seed(tools));

    await selectToolsForTurn({ db: store.db, tools, query: PLATE_QUERY });
    const afterCold = store.selects;
    embedCalls = [];

    await selectToolsForTurn({ db: store.db, tools, query: 'what did we pay Maria last month' });

    expect(store.selects).toBe(afterCold); // cache hit: no second SELECT
    expect(embedCalls).toHaveLength(1); // the query, and nothing else
    expect(embedCalls[0]?.input_type).toBe('query');
  });
});

describe('narrowing that actually narrows', () => {
  it('picks the family the request is about and drops the rest', async () => {
    const tools = [...catalogue(), ...VEHICLES];
    const { db } = fakeDb(await seed(tools));

    const result = await selectToolsForTurn({
      db,
      tools,
      query: 'open a pull request with the commits in that repository',
    });

    expect(result.selectedFamilies[0]).toBe('github');
    const present = familiesIn(result.tools);
    expect(present.has('payroll')).toBe(false);
    expect(present.has('vehicles')).toBe(false);
  });
});

describe('the day the embedding model changes', () => {
  /** Seed the table as a deployment running a DIFFERENT model would have left it. */
  async function seedUnderOtherModel(tools: SelectableTool[]): Promise<Map<string, StoredRow>> {
    process.env.EMBEDDING_MODEL = 'voyage-4';
    const rows = await seed(tools);
    process.env.EMBEDDING_MODEL = '';
    return rows;
  }

  it('keeps sending every tool while the catalogue is re-indexed', async () => {
    // The failure this guards against is not expense, it is silence. A tool
    // vector from the old model and a query vector from the new one are
    // coordinates in unrelated spaces: comparing them returns a plausible
    // number, so the wrong family would win and the model would truthfully
    // report it cannot do something it was granted. Treating them as stale
    // instead means every family travels for one turn.
    const tools = [...catalogue(), ...VEHICLES];
    const store = fakeDb(await seedUnderOtherModel(tools));

    const result = await selectToolsForTurn({ db: store.db, tools, query: PLATE_QUERY });
    await result.indexing;

    expect(result.unrankedFamilies).toContain('vehicles');
    // Open failure: nothing was dropped, exactly as when Voyage is unreachable.
    expect(result.tools).toHaveLength(tools.length);
    expect(familiesIn(result.tools).has('vehicles')).toBe(true);
  });

  it('re-embeds once, not once per turn', async () => {
    // The whole cost question in one assertion. A model switch invalidates every
    // row, so the first turn pays to re-index; if the new hash were not written
    // back, every turn afterwards would pay again — a real per-conversation cost
    // hiding behind a change that was supposed to reduce spending.
    const tools = [...catalogue(), ...VEHICLES];
    const store = fakeDb(await seedUnderOtherModel(tools));

    const first = await selectToolsForTurn({ db: store.db, tools, query: PLATE_QUERY });
    await first.indexing;
    expect(embedCalls.length).toBeGreaterThan(1); // the query, plus the backfill

    // A warm instance on the next turn, and a cold one after it — neither may
    // re-embed anything, because the table now holds the new model's hashes.
    embedCalls = [];
    const warm = await selectToolsForTurn({ db: store.db, tools, query: PLATE_QUERY });
    await warm.indexing;
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]?.input_type).toBe('query');

    resetToolVectorCache();
    embedCalls = [];
    const cold = await selectToolsForTurn({ db: store.db, tools, query: PLATE_QUERY });
    await cold.indexing;
    expect(embedCalls).toHaveLength(1);
    // And selection is back to actually narrowing.
    expect(cold.selectedFamilies[0]).toBe('vehicles');
  });
});
