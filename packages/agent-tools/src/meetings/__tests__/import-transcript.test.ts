import { IntegrationError } from '@cortex/core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../client';
import {
  type MeetingImportContext,
  buildChunks,
  buildSpeechTurns,
  importMeetingTranscript,
} from '../import-transcript';

/**
 * What these tests are actually protecting.
 *
 * 1. IDEMPOTENCE. The cron sweep re-reads the same two days every thirty
 *    minutes. If re-importing duplicated documents, Brain Knowledge would
 *    fill with copies of Tuesday's standup and every copy would cost an
 *    embedding. The unique index in migration 0059 is the mechanism; this test
 *    is the proof that the code actually leans on it.
 * 2. TURNS AND THEIR TIMESTAMPS. The whole feature is "cite who said it and
 *    when". A chunk without `{speaker, startMs, endMs}` is a wall of text.
 * 3. DEGRADING. Most calls have no transcript (nobody turned it on) and some
 *    accounts never granted the Meet scope. Both are ordinary conditions and
 *    must produce a sentence, never a thrown error and never a half-written
 *    document.
 */

// ---------------------------------------------------------------------------
// A Supabase stand-in with just enough behaviour to be wrong in the same ways
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private filters: Predicate[] = [];
  private mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private payload: Row[] = [];
  private conflictKey: string | null = null;
  private limitTo: number | null = null;

  constructor(
    private readonly store: Record<string, Row[]>,
    private readonly table: string,
    private readonly nextId: () => string,
  ) {}

  private get rows(): Row[] {
    this.store[this.table] ??= [];
    return this.store[this.table] as Row[];
  }

  private matching(): Row[] {
    return this.rows.filter((r) => this.filters.every((f) => f(r)));
  }

  select(_cols?: string): this {
    if (this.mode === 'select') this.mode = 'select';
    return this;
  }
  eq(col: string, value: unknown): this {
    this.filters.push((r) => r[col] === value);
    return this;
  }
  in(col: string, values: unknown[]): this {
    this.filters.push((r) => values.includes(r[col]));
    return this;
  }
  order(): this {
    return this;
  }
  limit(n: number): this {
    this.limitTo = n;
    return this;
  }

  insert(payload: Row | Row[]): this {
    this.mode = 'insert';
    this.payload = Array.isArray(payload) ? payload : [payload];
    return this;
  }
  update(patch: Row): this {
    this.mode = 'update';
    this.payload = [patch];
    return this;
  }
  delete(): this {
    this.mode = 'delete';
    return this;
  }
  upsert(payload: Row, opts?: { onConflict?: string }): this {
    this.mode = 'upsert';
    this.payload = [payload];
    this.conflictKey = opts?.onConflict ?? null;
    return this;
  }

  private run(): { data: Row[]; error: null } {
    if (this.mode === 'insert') {
      const created = this.payload.map((p) => ({ id: this.nextId(), ...p }));
      this.rows.push(...created);
      return { data: created, error: null };
    }
    if (this.mode === 'update') {
      const target = this.matching();
      for (const row of target) Object.assign(row, this.payload[0]);
      return { data: target, error: null };
    }
    if (this.mode === 'delete') {
      const target = new Set(this.matching());
      this.store[this.table] = this.rows.filter((r) => !target.has(r));
      return { data: [], error: null };
    }
    if (this.mode === 'upsert') {
      const row = this.payload[0] as Row;
      const key = this.conflictKey;
      // The unique index, modelled: one row per conference record, updated.
      const existing = key ? this.rows.find((r) => r[key] === row[key]) : undefined;
      if (existing) {
        Object.assign(existing, row);
        return { data: [existing], error: null };
      }
      const created = { id: this.nextId(), ...row };
      this.rows.push(created);
      return { data: [created], error: null };
    }
    const found = this.matching();
    return { data: this.limitTo != null ? found.slice(0, this.limitTo) : found, error: null };
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const { data } = this.run();
    return { data: data[0] ?? null, error: null };
  }
  async single(): Promise<{ data: Row | null; error: { message: string } | null }> {
    const { data } = this.run();
    return data[0] ? { data: data[0], error: null } : { data: null, error: { message: 'no rows' } };
  }
  // biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are thenables, so the stub must be one to stand in for them.
  then<R1, R2 = never>(
    onFulfilled?:
      | ((v: { data: unknown; error: { message: string } | null }) => R1 | PromiseLike<R1>)
      | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }
}

const SPACE_ID = '00000000-0000-0000-0000-0000000000aa';
const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeCtx(seed: Partial<Record<string, Row[]>> = {}): MeetingImportContext & {
  store: Record<string, Row[]>;
} {
  let counter = 0;
  const store: Record<string, Row[]> = {
    kb_collections: [
      {
        id: SPACE_ID,
        name: 'My notes',
        scope: 'user',
        scope_id: USER_ID,
        created_at: '2026-01-01',
      },
    ],
    kb_documents: [],
    kb_chunks: [],
    meeting_imports: [],
    users: [{ id: USER_ID, role: 'member' }],
    ...seed,
  };
  const db = {
    from: (table: string) => new FakeQuery(store, table, () => `id_${++counter}`),
  };
  const logger = {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
  };

  return {
    userId: USER_ID,
    db: db as unknown as MeetingImportContext['db'],
    integrations: {
      getAccessToken: async () => ({ token: 't', scopes: [] }),
      hasScopes: async () => true,
    } as unknown as MeetingImportContext['integrations'],
    logger: logger as unknown as MeetingImportContext['logger'],
    store,
  };
}

// ---------------------------------------------------------------------------
// Google, faked
// ---------------------------------------------------------------------------

const MEET = 'https://meet.googleapis.com/v2';
const CONFERENCE = 'conferenceRecords/rec-1';

const RECORD = {
  name: CONFERENCE,
  startTime: '2026-03-03T15:00:00Z',
  endTime: '2026-03-03T15:42:00Z',
  space: 'spaces/space-1',
};

const PARTICIPANTS = {
  participants: [
    { name: `${CONFERENCE}/participants/p1`, signedinUser: { displayName: 'Ana Ruiz' } },
    { name: `${CONFERENCE}/participants/p2`, signedinUser: { displayName: 'Client Bob' } },
  ],
};

const ENTRIES = {
  transcriptEntries: [
    {
      participant: `${CONFERENCE}/participants/p1`,
      text: 'Thanks for making the time.',
      startTime: '2026-03-03T15:00:04Z',
      endTime: '2026-03-03T15:00:07Z',
    },
    {
      participant: `${CONFERENCE}/participants/p1`,
      text: 'We wanted to confirm the delivery date.',
      startTime: '2026-03-03T15:00:07Z',
      endTime: '2026-03-03T15:00:11Z',
    },
    {
      participant: `${CONFERENCE}/participants/p2`,
      text: 'The fifteenth works for us, and we can sign this week.',
      startTime: '2026-03-03T15:02:00Z',
      endTime: '2026-03-03T15:02:09Z',
    },
  ],
};

/** Flipped per test to exercise the "nobody turned transcription on" path. */
let transcriptsResponse: Record<string, unknown> = {
  transcripts: [{ name: `${CONFERENCE}/transcripts/t1`, state: 'FILE_GENERATED' }],
};
/** Flipped per test to exercise the revoked-scope path. */
let googleStatus = 200;

const server = setupServer(
  http.get(`${MEET}/${CONFERENCE}`, () => {
    if (googleStatus !== 200) {
      return new HttpResponse('insufficient permissions', { status: googleStatus });
    }
    return HttpResponse.json(RECORD);
  }),
  http.get(`${MEET}/${CONFERENCE}/transcripts`, () => HttpResponse.json(transcriptsResponse)),
  http.get(`${MEET}/${CONFERENCE}/participants`, () => HttpResponse.json(PARTICIPANTS)),
  http.get(`${MEET}/${CONFERENCE}/transcripts/t1/entries`, () => HttpResponse.json(ENTRIES)),
  http.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', () =>
    HttpResponse.json({
      items: [
        {
          id: 'ev1',
          summary: 'Acme — delivery date',
          hangoutLink: 'https://meet.google.com/abc-defg-hij',
          start: { dateTime: '2026-03-03T15:00:00Z' },
          end: { dateTime: '2026-03-03T15:45:00Z' },
        },
      ],
    }),
  ),
  http.get(`${MEET}/spaces/space-1`, () => HttpResponse.json({ meetingCode: 'abc-defg-hij' })),
  http.post('https://api.voyageai.com/v1/embeddings', async ({ request }) => {
    const body = (await request.json()) as { input: string[] };
    return HttpResponse.json({
      data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
  process.env.VOYAGE_API_KEY = 'test-key';
  googleStatus = 200;
  transcriptsResponse = {
    transcripts: [{ name: `${CONFERENCE}/transcripts/t1`, state: 'FILE_GENERATED' }],
  };
});
afterEach(() => server.resetHandlers());

// ---------------------------------------------------------------------------

describe('speech turns and their timestamps', () => {
  const speakers = new Map([
    [`${CONFERENCE}/participants/p1`, 'Ana Ruiz'],
    [`${CONFERENCE}/participants/p2`, 'Client Bob'],
  ]);

  it('merges consecutive entries from one speaker and offsets from the call start', () => {
    const turns = buildSpeechTurns(ENTRIES.transcriptEntries as TranscriptEntry[], speakers, {
      originMs: Date.parse(RECORD.startTime),
    });

    expect(turns).toHaveLength(2);
    expect(turns[0]?.speaker).toBe('Ana Ruiz');
    // Two entries became one turn, so the text is joined and the end moves out.
    expect(turns[0]?.text).toContain('Thanks for making the time.');
    expect(turns[0]?.text).toContain('confirm the delivery date');
    expect(turns[0]?.startMs).toBe(4_000);
    expect(turns[0]?.endMs).toBe(11_000);

    expect(turns[1]?.speaker).toBe('Client Bob');
    expect(turns[1]?.startMs).toBe(120_000);
    expect(turns[1]?.endMs).toBe(129_000);
  });

  it('derives an offset for an entry Google did not stamp, keeping order', () => {
    const unstamped: TranscriptEntry[] = [
      {
        participant: `${CONFERENCE}/participants/p1`,
        text: 'First.',
        startTime: '2026-03-03T15:00:10Z',
        endTime: '2026-03-03T15:00:20Z',
      },
      // No timestamps at all: placed where the previous utterance ended.
      {
        participant: `${CONFERENCE}/participants/p2`,
        text: 'Second.',
        startTime: null,
        endTime: null,
      },
      {
        participant: `${CONFERENCE}/participants/p1`,
        text: 'Third.',
        startTime: '2026-03-03T15:00:40Z',
        endTime: '2026-03-03T15:00:45Z',
      },
    ];
    const turns = buildSpeechTurns(unstamped, speakers, {
      originMs: Date.parse(RECORD.startTime),
    });

    expect(turns.map((t) => t.speaker)).toEqual(['Ana Ruiz', 'Client Bob', 'Ana Ruiz']);
    expect(turns[1]?.startMs).toBe(20_000);
    expect(turns[1]?.endMs).toBe(20_000);
    // Monotonic: the derived turn never overtakes the one that follows it.
    expect(turns[1]?.startMs).toBeLessThanOrEqual(turns[2]?.startMs ?? 0);
  });

  it('puts a header first and {speaker, startMs, endMs} on every spoken chunk', () => {
    const turns = buildSpeechTurns(ENTRIES.transcriptEntries as TranscriptEntry[], speakers, {
      originMs: Date.parse(RECORD.startTime),
    });
    const chunks = buildChunks('# Acme — delivery date\nGoogle Meet · 42 min', turns);

    expect(chunks[0]?.chunkIndex).toBe(0);
    expect(chunks[0]?.content).toContain('# Acme');
    // Nobody said the header, so it is not attributed to a participant.
    expect(chunks[0]?.metadata.speaker).toBeUndefined();

    const spoken = chunks.slice(1);
    expect(spoken.length).toBeGreaterThan(0);
    for (const chunk of spoken) {
      expect(typeof chunk.metadata.speaker).toBe('string');
      expect(typeof chunk.metadata.startMs).toBe('number');
      expect(typeof chunk.metadata.endMs).toBe('number');
    }
    // The speaker's name is inside the text too, or the embedding cannot carry it.
    expect(spoken.map((c) => c.content).join('\n')).toContain('Client Bob:');
    // Indices are contiguous, which is what chunk_index means downstream.
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });
});

describe('importing a meeting', () => {
  it('writes one document with the meeting provenance and its speaker chunks', async () => {
    const ctx = makeCtx();
    const result = await importMeetingTranscript(ctx, { conferenceRecord: CONFERENCE });

    expect(result.outcome).toBe('imported');
    // Resolved from the calendar, not from the Meet code.
    expect(result.title).toBe('Acme — delivery date');
    expect(result.participants).toEqual(['Ana Ruiz', 'Client Bob']);
    expect(result.durationSeconds).toBe(42 * 60);

    const docs = ctx.store.kb_documents ?? [];
    expect(docs).toHaveLength(1);
    expect(docs[0]?.source).toBe('meeting');
    expect(docs[0]?.media_kind).toBe('meeting');
    expect(docs[0]?.source_ref).toBe(CONFERENCE);
    expect(docs[0]?.recorded_at).toBe(RECORD.startTime);
    expect(docs[0]?.duration_seconds).toBe(42 * 60);
    expect(docs[0]?.speakers).toEqual(['Ana Ruiz', 'Client Bob']);
    expect(docs[0]?.status).toBe('ready');
    // Defaults to the importer's own space — never a company-wide one.
    expect(docs[0]?.collection_id).toBe(SPACE_ID);

    const chunks = ctx.store.kb_chunks ?? [];
    expect(chunks.length).toBe(result.chunks);
    const meta = chunks[1]?.metadata as { speaker?: string; startMs?: number };
    expect(meta.speaker).toBe('Ana Ruiz');
    expect(meta.startMs).toBe(4_000);

    const ledger = ctx.store.meeting_imports ?? [];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.conference_record).toBe(CONFERENCE);
    expect(ledger[0]?.status).toBe('ready');
    expect(ledger[0]?.document_id).toBe(docs[0]?.id);
  });

  it('re-importing the same conference updates in place instead of duplicating', async () => {
    const ctx = makeCtx();
    const first = await importMeetingTranscript(ctx, { conferenceRecord: CONFERENCE });
    const documentId = first.documentId;
    const chunkCount = (ctx.store.kb_chunks ?? []).length;

    const second = await importMeetingTranscript(ctx, { conferenceRecord: CONFERENCE });

    // Same text, so nothing was re-embedded and nothing was re-written.
    expect(second.outcome).toBe('unchanged');
    expect(second.documentId).toBe(documentId);
    expect(ctx.store.kb_documents).toHaveLength(1);
    expect(ctx.store.meeting_imports).toHaveLength(1);
    expect(ctx.store.kb_chunks).toHaveLength(chunkCount);

    // Now the transcript grows — Meet finished writing the tail of the call.
    server.use(
      http.get(`${MEET}/${CONFERENCE}/transcripts/t1/entries`, () =>
        HttpResponse.json({
          transcriptEntries: [
            ...ENTRIES.transcriptEntries,
            {
              participant: `${CONFERENCE}/participants/p1`,
              text: 'Perfect, I will send the paperwork over this afternoon.',
              startTime: '2026-03-03T15:03:00Z',
              endTime: '2026-03-03T15:03:06Z',
            },
          ],
        }),
      ),
    );

    const third = await importMeetingTranscript(ctx, { conferenceRecord: CONFERENCE });

    expect(third.outcome).toBe('updated');
    expect(third.documentId).toBe(documentId);
    // Still exactly one document and one ledger row, with fresh chunks.
    expect(ctx.store.kb_documents).toHaveLength(1);
    expect(ctx.store.meeting_imports).toHaveLength(1);
    const contents = (ctx.store.kb_chunks ?? []).map((c) => c.content as string).join('\n');
    expect(contents).toContain('paperwork');
    // Chunk indices were rebuilt from zero, not appended to the old ones.
    const indices = (ctx.store.kb_chunks ?? []).map((c) => c.chunk_index as number);
    expect(Math.min(...indices)).toBe(0);
    expect(new Set(indices).size).toBe(indices.length);
  });
});

describe('degrading', () => {
  it('says so plainly when the call has no transcript, and writes nothing', async () => {
    transcriptsResponse = { transcripts: [] };
    const ctx = makeCtx();

    const result = await importMeetingTranscript(ctx, { conferenceRecord: CONFERENCE });

    expect(result.outcome).toBe('unavailable');
    expect(result.note).toMatch(/transcription/i);
    expect(ctx.store.kb_documents).toHaveLength(0);
    expect(ctx.store.kb_chunks).toHaveLength(0);
    // Nothing recorded, so a transcript that appears later is still picked up.
    expect(ctx.store.meeting_imports).toHaveLength(0);
  });

  it('reports a missing Google permission as a permission problem, not a crash', async () => {
    googleStatus = 403;
    const ctx = makeCtx();

    const result = await importMeetingTranscript(ctx, { conferenceRecord: CONFERENCE });

    expect(result.outcome).toBe('unauthorized');
    expect(result.note).toMatch(/meetings\.space\.readonly/);
    expect(ctx.store.kb_documents).toHaveLength(0);
    expect(ctx.store.meeting_imports).toHaveLength(0);
  });

  it('reports a disconnected Google account the same way', async () => {
    const ctx = makeCtx();
    ctx.integrations = {
      getAccessToken: async () => {
        throw new IntegrationError('No google integration for user', 'google');
      },
      hasScopes: async () => false,
    } as unknown as MeetingImportContext['integrations'];

    const result = await importMeetingTranscript(ctx, { conferenceRecord: CONFERENCE });

    expect(result.outcome).toBe('unauthorized');
    expect(ctx.store.kb_documents).toHaveLength(0);
  });
});
