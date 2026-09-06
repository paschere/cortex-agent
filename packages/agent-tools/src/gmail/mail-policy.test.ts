import { describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { ingestThreads } from './learn';
import { verifiedMailCitations } from './learning-proposals';
import { allowedMailMessages, defaultMailPolicy, readMailPolicy } from './mail-policy';
import type { MailMessage } from './threads';
const fetchMessages = vi.hoisted(() => vi.fn());
vi.mock('./threads', async (original) => ({
  ...(await original<typeof import('./threads')>()),
  fetchThreadMessages: fetchMessages,
}));
const message = {
  id: 'message',
  threadId: 'thread',
  ms: 123,
  body: 'Para solicitar el certificado se necesitan dos firmas.',
  fromEmail: 'proveedor@example.com',
  from: 'Proveedor <proveedor@example.com>',
  to: ['me@company.com'],
  cc: [],
  subject: 'Certificado solicitado',
  labelIds: ['INBOX'],
  headers: [],
  attachments: [],
} as unknown as MailMessage;
describe('mail consultation boundary', () => {
  it('defaults to no automatic alerts, replies or learning', async () => {
    const db = createOrgScopedClient(
      createFakeSupabase({
        mail_policies: [
          {
            organization_id: 'other',
            user_id: 'me',
            data: { ...defaultMailPolicy, learning: true },
          },
        ],
      }).client,
      'org',
    );
    expect(await readMailPolicy(db, 'me')).toEqual({
      ...defaultMailPolicy,
      alerts: false,
      replies: false,
      learning: false,
    });
  });
  it('requires both selected label and exact sender, and excludes bulk folders', () => {
    const p = { ...defaultMailPolicy, labels: ['INBOX'], senders: ['proveedor@example.com'] };
    expect(allowedMailMessages([message], p)).toHaveLength(1);
    expect(
      allowedMailMessages([{ ...message, fromEmail: 'attacker@example.com' }], p),
    ).toHaveLength(0);
    expect(allowedMailMessages([{ ...message, labelIds: ['SENT'] }], p)).toHaveLength(0);
    expect(allowedMailMessages([{ ...message, labelIds: ['INBOX', 'SPAM'] }], p)).toHaveLength(0);
  });
  it('rejects invented quotes or quotes attached to another message', () => {
    const draft = {
      title: 'Firmas necesarias',
      content: message.body,
      kind: 'possible_rule' as const,
      uncertainty: 'Confirmar si sigue vigente',
      citations: [{ messageId: 'message', quote: message.body }],
    };
    expect(verifiedMailCitations(draft, [message])).toBe(true);
    expect(
      verifiedMailCitations(
        { ...draft, citations: [{ messageId: 'other', quote: message.body }] },
        [message],
      ),
    ).toBe(false);
  });
  it('consults without creating KB documents, chunks or attachment records and deduplicates', async () => {
    fetchMessages.mockResolvedValue([message]);
    const tables = {
      mail_policies: [],
      mail_consulted_threads: [],
      kb_documents: [],
      kb_chunks: [],
      mail_attachment_ingests: [],
    };
    const fake = createFakeSupabase(tables);
    const db = createOrgScopedClient(fake.client, 'org');
    const ctx = {
      db,
      userId: 'me',
      organizationId: 'org',
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      integrations: {},
      signal: undefined,
    };
    const first = await ingestThreads(ctx as never, { threadIds: ['thread'], spaceId: 'unused' });
    expect(first.documents[0]?.documentId).toBeNull();
    const second = await ingestThreads(ctx as never, { threadIds: ['thread'], spaceId: 'unused' });
    expect(second.documents).toHaveLength(0);
    expect(tables.kb_documents).toHaveLength(0);
    expect(tables.kb_chunks).toHaveLength(0);
    expect(tables.mail_attachment_ingests).toHaveLength(0);
  });
  it('does not propose a response when the actual latest reply is outside the selected scope', async () => {
    fetchMessages.mockResolvedValue([
      message,
      { ...message, id: 'reply', fromEmail: 'me@company.com', labelIds: ['SENT'], ms: 124 },
    ]);
    const db = createOrgScopedClient(
      createFakeSupabase({
        mail_policies: [
          {
            organization_id: 'org',
            user_id: 'me',
            data: { ...defaultMailPolicy, senders: ['proveedor@example.com'] },
          },
        ],
        mail_consulted_threads: [],
      }).client,
      'org',
    );
    const result = await ingestThreads(
      {
        db,
        userId: 'me',
        organizationId: 'org',
        logger: { warn: vi.fn() },
        integrations: {},
      } as never,
      { threadIds: ['thread'], spaceId: 'unused' },
    );
    expect(result.documents).toHaveLength(0);
  });
  it('honors a paused mailbox before fetching another thread', async () => {
    fetchMessages.mockClear();
    const db = createOrgScopedClient(
      createFakeSupabase({
        gmail_sync_state: [{ organization_id: 'org', user_id: 'me', paused: true }],
        mail_consulted_threads: [],
      }).client,
      'org',
    );
    await expect(
      ingestThreads({ db, userId: 'me', organizationId: 'org' } as never, {
        threadIds: ['thread'],
        spaceId: 'unused',
      }),
    ).rejects.toThrow('pausado');
    expect(fetchMessages).not.toHaveBeenCalled();
  });
});
