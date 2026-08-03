import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationError, ValidationError } from '@cortex/core';
import { runTool } from '../index';
import { gmailDraft } from './draft';
import type { ToolContext } from '../types';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const insertResult = { data: null, error: null };
  const upsertResult = { data: null, error: null };
  const noRow = { data: null, error: null };

  const fromBuilder = {
    insert: vi.fn().mockResolvedValue(insertResult),
    upsert: vi.fn().mockResolvedValue(upsertResult),
    update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(noRow),
        }),
        maybeSingle: vi.fn().mockResolvedValue(noRow),
      }),
    }),
  };

  const db = { from: vi.fn().mockReturnValue(fromBuilder) };

  const integrations = {
    getAccessToken: vi.fn().mockResolvedValue({ token: 'test-token', scopes: [] }),
    hasScopes: vi.fn().mockResolvedValue(true),
  };

  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };

  return {
    userId: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    conversationId: '00000000-0000-0000-0000-000000000003',
    db: db as unknown as ToolContext['db'],
    integrations: integrations as unknown as ToolContext['integrations'],
    logger: logger as unknown as ToolContext['logger'],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gmail.draft', () => {
  it('happy path: builds MIME, base64url-encodes, POSTs to API, returns draftId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 'd1', message: { id: 'msg1' } }),
      }),
    );

    const ctx = makeCtx();
    const result = await runTool(
      gmailDraft,
      { to: ['recipient@example.com'], subject: 'Hello', body: 'World' },
      ctx,
    );

    expect(result.draftId).toBe('d1');
    expect(result.messageId).toBe('msg1');
    expect(result.deepLink).toBe('https://mail.google.com/mail/u/0/#drafts/d1');

    expect(fetch).toHaveBeenCalledWith(
      'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );

    // Verify MIME content is base64url encoded in the body
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by the mock above
    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1]!;
    const parsed = JSON.parse(callArgs.body as string);
    const raw: string = parsed.message.raw;
    // base64url should not contain + or / or =
    expect(raw).not.toMatch(/[+/=]/);
    // Decode and verify MIME headers
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    expect(decoded).toContain('To: recipient@example.com');
    expect(decoded).toContain('Subject: Hello');
    expect(decoded).toContain('World');
  });

  it('empty to list → ValidationError', async () => {
    const ctx = makeCtx();
    await expect(
      runTool(gmailDraft, { to: [], subject: 'Hello', body: 'World' }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('network error → IntegrationError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'internal server error',
      }),
    );

    const ctx = makeCtx();
    await expect(
      runTool(gmailDraft, { to: ['user@example.com'], subject: 'Test', body: 'Body' }, ctx),
    ).rejects.toBeInstanceOf(IntegrationError);
  });

  it('supports cc and bcc recipients', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 'd2', message: { id: 'msg2' } }),
      }),
    );

    const ctx = makeCtx();
    const result = await runTool(
      gmailDraft,
      {
        to: ['to@example.com'],
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
        subject: 'Multi',
        body: 'Recipients',
      },
      ctx,
    );

    expect(result.draftId).toBe('d2');

    // biome-ignore lint/style/noNonNullAssertion: guaranteed by the mock above
    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1]!;
    const parsed = JSON.parse(callArgs.body as string);
    const decoded = Buffer.from(
      parsed.message.raw.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf-8');
    expect(decoded).toContain('Cc: cc@example.com');
    expect(decoded).toContain('Bcc: bcc@example.com');
  });
});
