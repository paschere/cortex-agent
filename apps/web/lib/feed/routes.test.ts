import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  rows: [] as Row[],
  writes: [] as string[],
  userId: 'owner',
  orgId: 'org-a',
}));
const files = vi.hoisted(() => ({ putFile: vi.fn(), removeFiles: vi.fn() }));
const promote = vi.hoisted(() => vi.fn(async () => ({ documentId: 'doc', note: 'Guardado' })));
vi.mock('@/lib/session', () => ({
  requireSession: async () => ({ id: state.userId, organization: { id: state.orgId } }),
}));
vi.mock('@/lib/agent', () => ({ buildToolContext: () => ({}) }));
vi.mock('@cortex/agents', () => ({
  listAgents: () => [{ id: 'cortex' }],
  loadAgent: async () => ({ id: 'agent' }),
}));
vi.mock('@cortex/agent-tools', () => ({
  ...files,
  parseDocument: async () => ({ text: 'Contenido leído' }),
}));
vi.mock('@cortex/agent-tools/src/web/scrape', () => ({
  webScrape: { handler: vi.fn(async () => ({ content: 'Página pública', truncated: false })) },
}));
vi.mock('@cortex/agent-tools/src/attachments/promote', () => ({
  attachmentsPromote: { handler: promote },
}));

class Query {
  filters: Array<(row: Row) => boolean> = [];
  payload: Row | null = null;
  operation = 'read';
  constructor(
    readonly table: string,
    readonly org: string,
  ) {}
  select() {
    return this;
  }
  returns() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  eq(key: string, value: unknown) {
    this.filters.push((row) => row[key] === value);
    return this;
  }
  gt(key: string, value: string) {
    this.filters.push((row) => String(row[key]) > value);
    return this;
  }
  is(key: string, value: unknown) {
    this.filters.push((row) => (row[key] ?? null) === value);
    return this;
  }
  not(key: string) {
    this.filters.push((row) => row[key] != null);
    return this;
  }
  insert(row: Row) {
    this.payload = row;
    this.operation = 'insert';
    return this;
  }
  update(row: Row) {
    this.payload = row;
    this.operation = 'update';
    return this;
  }
  delete() {
    this.operation = 'delete';
    return this;
  }
  run(single = false) {
    let rows = state.rows.filter(
      (r) =>
        r.table === this.table && r.organization_id === this.org && this.filters.every((f) => f(r)),
    );
    if (this.operation === 'insert') {
      const row = {
        id: randomUUID(),
        table: this.table,
        organization_id: this.org,
        created_at: new Date().toISOString(),
        purge_at: '2099-01-01T00:00:00.000Z',
        ...this.payload,
      };
      state.rows.push(row);
      state.writes.push(this.table);
      rows = [row];
    }
    if (this.operation === 'update') for (const row of rows) Object.assign(row, this.payload);
    if (this.operation === 'delete') state.rows = state.rows.filter((r) => !rows.includes(r));
    return { data: single ? (rows[0] ?? null) : rows, count: rows.length, error: null };
  }
  async maybeSingle() {
    return this.run(true);
  }
  async single() {
    return this.run(true);
  }
  // biome-ignore lint/suspicious/noThenProperty: emulates a PostgREST query builder
  then(resolve: (value: ReturnType<Query['run']>) => unknown) {
    return Promise.resolve(this.run()).then(resolve);
  }
}
vi.mock('@/lib/supabase/service', () => ({
  getOrgScopedClient: (org: string) => ({ from: (table: string) => new Query(table, org) }),
}));

import { DELETE, POST as action, GET as detail } from '@/app/api/feed/[id]/route';
import { GET, POST } from '@/app/api/feed/route';
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (body: object) =>
  new NextRequest('http://localhost/api/feed/id', { method: 'POST', body: JSON.stringify(body) });
async function addText() {
  const form = new FormData();
  form.set('kind', 'text');
  form.set('text', 'Notas privadas');
  form.set('title', 'Mi nota');
  const res = await POST(
    new NextRequest('http://localhost/api/feed', { method: 'POST', body: form }),
  );
  expect(res.status).toBe(201);
  return (await res.json()).entry.id as string;
}
beforeEach(() => {
  state.rows = [];
  state.writes = [];
  state.userId = 'owner';
  state.orgId = 'org-a';
  vi.clearAllMocks();
});

describe('Feed lifecycle', () => {
  it('accepts consultation data without creating a conversation or memory', async () => {
    await addText();
    expect(state.writes).toEqual(['chat_attachments']);
    expect(state.rows[0]).toMatchObject({
      disposition: 'turn',
      conversation_id: null,
      feed_kind: 'text',
    });
    expect(promote).not.toHaveBeenCalled();
    expect(files.putFile).toHaveBeenCalledOnce();
  });
  it('opens a consultation idempotently without indexing', async () => {
    const id = await addText();
    const first = await (await action(request({ action: 'consult' }), params(id))).json();
    const second = await (await action(request({ action: 'consult' }), params(id))).json();
    expect(first.href).toMatch(/^\/chat\//);
    expect(second.href).toBe(first.href);
    expect(state.writes).toEqual(['chat_attachments', 'conversations']);
    expect(promote).not.toHaveBeenCalled();
  });
  it('only promotes when explicitly requested', async () => {
    const id = await addText();
    expect((await action(request({ action: 'promote' }), params(id))).status).toBe(200);
    expect(promote).toHaveBeenCalledWith({ attachmentId: id, space: undefined }, {});
  });
  it.each(['another-user', 'another-org', 'expired'])(
    'does not expose, consult, promote or delete %s entries',
    async (kind) => {
      const id = await addText();
      if (kind === 'another-user') state.userId = 'other';
      if (kind === 'another-org') state.orgId = 'org-b';
      if (kind === 'expired' && state.rows[0]) state.rows[0].purge_at = '2000-01-01T00:00:00.000Z';
      expect((await (await GET()).json()).entries).toEqual([]);
      expect((await detail(request({}), params(id))).status).toBe(404);
      expect((await action(request({ action: 'consult' }), params(id))).status).toBe(404);
      expect((await action(request({ action: 'promote' }), params(id))).status).toBe(404);
      expect((await DELETE(request({}), params(id))).status).toBe(404);
      expect(promote).not.toHaveBeenCalled();
    },
  );
  it('deletes the temporary original without deleting a promoted document', async () => {
    const id = await addText();
    if (state.rows[0]) state.rows[0].promoted_document_id = 'doc';
    state.rows.push({ table: 'kb_documents', id: 'doc', organization_id: state.orgId });
    expect((await DELETE(request({}), params(id))).status).toBe(200);
    expect(files.removeFiles).toHaveBeenCalledOnce();
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.table).toBe('kb_documents');
  });
});
