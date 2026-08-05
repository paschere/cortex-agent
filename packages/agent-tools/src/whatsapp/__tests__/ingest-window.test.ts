import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Row, makeDb, silentLogger } from './fake-db';

/**
 * Embeddings are mocked because this file is about what gets WRITTEN, not about
 * Voyage. Without the mock every document would land `status = 'pending'` for
 * want of an API key, and the second pass would see a document that is not
 * ready and rebuild it — which would make the idempotence test pass or fail for
 * a reason that has nothing to do with idempotence.
 */
vi.mock('../../kb/embedder', () => ({
  embedDocuments: async (texts: string[]) => ({
    ok: true as const,
    data: texts.map(() => [0.1, 0.2, 0.3]),
  }),
}));

const { flushGroup } = await import('../flush');
const { ingestWindow } = await import('../ingest-window');
const { planWindows } = await import('../windows');
import type { StagedMessage } from '../windows';

const ORG = 'org-test';
const USER = '00000000-0000-0000-0000-000000000001';
const SPACE = '00000000-0000-0000-0000-0000000000aa';
const GROUP = '120363000000000001@g.us';
const ZONE = 'America/Bogota';

let store: Record<string, Row[]>;

function seed(): void {
  store = {
    kb_collections: [
      { id: SPACE, name: 'Operación', scope: 'user', scope_id: USER, created_at: '2026-01-01' },
    ],
    kb_documents: [],
    kb_chunks: [],
    users: [{ id: USER, role: 'member' }],
    whatsapp_groups: [
      {
        id: 'g1',
        jid: GROUP,
        subject: 'Despachos Acme',
        space_id: SPACE,
        archive_enabled: true,
        enabled_by: USER,
      },
    ],
    whatsapp_messages: [],
    whatsapp_ingest_windows: [],
  };
}

let seq = 0;
function staged(sentAt: string, from: string, text: string): StagedMessage {
  seq += 1;
  return {
    id: `row-${seq}`,
    messageId: `wa-${seq}`,
    senderJid: '573001112233@s.whatsapp.net',
    senderName: from,
    sentAt,
    body: text,
    kind: 'text',
    transcript: null,
    mediaFilename: null,
    attachmentDocumentId: null,
  };
}

const CONVERSATION = () => [
  staged('2026-03-03T14:00:00Z', 'Ana', 'el cliente pregunta por el despacho de mañana'),
  staged('2026-03-03T14:02:00Z', 'Beto', 'sale a las 6, ya está cargado'),
  staged('2026-03-03T14:04:00Z', 'Ana', 'perfecto, le confirmo'),
];

function ctx() {
  return { organizationId: ORG, userId: USER, db: makeDb(store), logger: silentLogger };
}
const REF = { jid: GROUP, subject: 'Despachos Acme', spaceId: SPACE };

function windowOf(messages: StagedMessage[]) {
  const planned = planWindows(messages, {
    nowMs: Date.parse('2026-03-03T20:00:00Z'),
    timeZone: ZONE,
  });
  const first = planned.closed[0];
  if (!first) throw new Error('fixture produced no closed window');
  return first;
}

beforeEach(() => {
  seed();
  seq = 0;
});

describe('ingestWindow', () => {
  it('writes one document with the conversation, its header and its provenance', async () => {
    const result = await ingestWindow(ctx(), REF, windowOf(CONVERSATION()), { timeZone: ZONE });

    expect(result.outcome).toBe('imported');
    expect(store.kb_documents).toHaveLength(1);

    const doc = store.kb_documents?.[0] as Row;
    // The same provenance columns a Meet import writes (0058/0059), so every
    // citation renderer built for recordings works on this unchanged.
    expect(doc.media_kind).toBe('whatsapp');
    expect(doc.collection_id).toBe(SPACE);
    expect(doc.recorded_at).toBe('2026-03-03T14:00:00.000Z');
    expect(doc.duration_seconds).toBe(240);
    expect(doc.speakers).toEqual(['Ana', 'Beto']);
    expect(doc.status).toBe('ready');
    expect(doc.source_ref).toContain(GROUP);

    // The header is chunk 0 and names the group, so "the Acme group in March"
    // finds the conversation itself and not only a line inside it.
    const chunks = (store.kb_chunks ?? []) as Row[];
    expect(chunks.length).toBeGreaterThan(1);
    const header = chunks.find((c) => c.chunk_index === 0) as Row;
    expect(header.content).toContain('Despachos Acme');
    expect(header.content).toContain('Who took part: Ana, Beto');
  });

  it('tags every passage with who wrote it and when', async () => {
    await ingestWindow(ctx(), REF, windowOf(CONVERSATION()), { timeZone: ZONE });

    const body = (store.kb_chunks ?? []).filter((c) => c.chunk_index !== 0) as Row[];
    expect(body.length).toBeGreaterThan(0);
    for (const chunk of body) {
      const metadata = chunk.metadata as { speaker?: string; startMs?: number };
      expect(typeof metadata.speaker).toBe('string');
      expect(typeof metadata.startMs).toBe('number');
    }
    // And the name is inside the text too, because the embedding is computed
    // from the text — "what did Ana say" only matches if Ana is in it.
    expect((body[0]?.content as string) ?? '').toContain('Ana:');
  });

  it('re-ingesting the same window updates rather than duplicates', async () => {
    const window = windowOf(CONVERSATION());
    const first = await ingestWindow(ctx(), REF, window, { timeZone: ZONE });
    const second = await ingestWindow(ctx(), REF, window, { timeZone: ZONE });

    expect(first.outcome).toBe('imported');
    // Byte-identical: no chunk churn and, more to the point, no embedding spend.
    expect(second.outcome).toBe('unchanged');
    expect(second.documentId).toBe(first.documentId);
    expect(store.kb_documents).toHaveLength(1);
    expect(store.whatsapp_ingest_windows).toHaveLength(1);
  });

  it('folds a conversation that carried on into the document it already has', async () => {
    const messages = CONVERSATION();
    const first = await ingestWindow(ctx(), REF, windowOf(messages), { timeZone: ZONE });

    messages.push(staged('2026-03-03T14:20:00Z', 'Ana', 'el cliente ya confirmó, sale a las 6'));
    const second = await ingestWindow(ctx(), REF, windowOf(messages), { timeZone: ZONE });

    expect(second.outcome).toBe('updated');
    expect(second.documentId).toBe(first.documentId);
    expect(store.kb_documents).toHaveLength(1);
    expect(store.whatsapp_ingest_windows).toHaveLength(1);
    // Chunks are replaced, never appended: boundaries move when a window grows.
    const stale = (store.kb_chunks ?? []).filter((c) => c.document_id !== first.documentId);
    expect(stale).toHaveLength(0);
  });

  it('keeps one document when a late message shifts the window backwards', async () => {
    // The one case the window key alone cannot cover: an older message arrives,
    // the window starts earlier, the key changes. Matching the ledger on time
    // range is what stops this forking a second document out of one episode.
    const messages = CONVERSATION();
    await ingestWindow(ctx(), REF, windowOf(messages), { timeZone: ZONE });

    messages.unshift(staged('2026-03-03T13:58:00Z', 'Beto', 'ojo con la guía'));
    const shifted = windowOf(messages);
    const second = await ingestWindow(ctx(), REF, shifted, { timeZone: ZONE });

    expect(second.outcome).toBe('updated');
    expect(store.kb_documents).toHaveLength(1);
    expect(store.whatsapp_ingest_windows).toHaveLength(1);
  });

  it('refuses to write into a space the person who enabled the group cannot write to', async () => {
    // The space was made personal to somebody else after the group was switched
    // on. An unattended archive must not keep writing into it.
    (store.kb_collections?.[0] as Row).scope_id = 'someone-else';

    const result = await ingestWindow(ctx(), REF, windowOf(CONVERSATION()), { timeZone: ZONE });

    expect(result.outcome).toBe('failed');
    expect(store.kb_documents).toHaveLength(0);
  });

  it('writes nothing for a stretch with no words in it', async () => {
    const stickers = [
      { ...staged('2026-03-03T14:00:00Z', 'Ana', ''), kind: 'other' as const, body: null },
      { ...staged('2026-03-03T14:01:00Z', 'Beto', ''), kind: 'other' as const, body: null },
    ];
    const result = await ingestWindow(ctx(), REF, windowOf(stickers), { timeZone: ZONE });

    expect(result.outcome).toBe('empty');
    expect(store.kb_documents).toHaveLength(0);
  });
});

describe('flushGroup', () => {
  function stageRows(messages: StagedMessage[]): void {
    store.whatsapp_messages = messages.map((m) => ({
      id: m.id,
      organization_id: ORG,
      group_jid: GROUP,
      message_id: m.messageId,
      sender_jid: m.senderJid,
      sender_name: m.senderName,
      sent_at: m.sentAt,
      body: m.body,
      kind: m.kind,
      transcript: m.transcript,
      media_filename: m.mediaFilename,
      attachment_document_id: m.attachmentDocumentId,
      document_id: null,
      window_key: null,
    }));
  }

  const NOW = Date.parse('2026-03-03T20:00:00Z');

  it('archives a switched-on group and marks its messages as filed', async () => {
    stageRows(CONVERSATION());
    const group = store.whatsapp_groups?.[0] as Row;

    const result = await flushGroup(
      { organizationId: ORG, db: makeDb(store), logger: silentLogger },
      group as never,
      { nowMs: NOW, timeZone: ZONE },
    );

    expect(result.windows.map((w) => w.outcome)).toEqual(['imported']);
    expect(store.kb_documents).toHaveLength(1);
    for (const row of store.whatsapp_messages ?? []) {
      expect(row.document_id).toBeTruthy();
    }
  });

  it('NEVER archives a group that was not switched on', async () => {
    // The single failure this feature is least allowed to have. The ingest
    // route already refuses to stage the messages; this is the second lock, for
    // anything staged before the group was switched back off.
    stageRows(CONVERSATION());
    const group = { ...(store.whatsapp_groups?.[0] as Row), archive_enabled: false };

    const result = await flushGroup(
      { organizationId: ORG, db: makeDb(store), logger: silentLogger },
      group as never,
      { nowMs: NOW, timeZone: ZONE },
    );

    expect(result.windows).toHaveLength(0);
    expect(store.kb_documents).toHaveLength(0);
    expect(store.whatsapp_ingest_windows).toHaveLength(0);
  });

  it('never archives a group with no destination space', async () => {
    stageRows(CONVERSATION());
    const group = { ...(store.whatsapp_groups?.[0] as Row), space_id: null };

    const result = await flushGroup(
      { organizationId: ORG, db: makeDb(store), logger: silentLogger },
      group as never,
      { nowMs: NOW, timeZone: ZONE },
    );

    expect(result.windows).toHaveLength(0);
    expect(store.kb_documents).toHaveLength(0);
  });

  it('leaves a conversation that is still going for the next pass', async () => {
    stageRows(CONVERSATION());
    const group = store.whatsapp_groups?.[0] as Row;

    const result = await flushGroup(
      { organizationId: ORG, db: makeDb(store), logger: silentLogger },
      group as never,
      // Two minutes after the last message: the group is still talking.
      { nowMs: Date.parse('2026-03-03T14:06:00Z'), timeZone: ZONE },
    );

    expect(result.stillTalking).toBe(true);
    expect(result.windows).toHaveLength(0);
    expect(store.kb_documents).toHaveLength(0);
  });

  it('does no work at all when nothing new has arrived', async () => {
    stageRows(CONVERSATION());
    const group = store.whatsapp_groups?.[0] as Row;
    const opts = { nowMs: NOW, timeZone: ZONE };
    const deps = { organizationId: ORG, db: makeDb(store), logger: silentLogger };

    await flushGroup(deps, group as never, opts);
    const again = await flushGroup(deps, group as never, opts);

    expect(again.windows).toHaveLength(0);
    expect(again.pendingMessages).toBe(0);
    expect(store.kb_documents).toHaveLength(1);
  });
});
