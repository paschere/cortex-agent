import { IntegrationError, ValidationError } from '@cortex/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTool } from '../../index';
import { createIntegrationsClient } from '../../integrations';
import { classifyAudience, matchClientByDomain } from '../../outlook/ingest-thread';
import { outlookListThreads } from '../../outlook/list-threads';
import { outlookSearch } from '../../outlook/search';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import type { ToolContext } from '../../types';
import { normalizeGraphScopes } from '../client';

/**
 * The four things that have to be true before this integration can be trusted
 * with a customer's mailbox:
 *
 *   1. A token that expired refreshes itself, and the ROTATED refresh token
 *      Microsoft hands back is the one that gets stored — the classic Entra ID
 *      mistake is keeping the original, which works exactly once.
 *   2. A revoked grant fails with an instruction, not a status code.
 *   3. Search returns conversations, grouped, in the shape the Gmail tools
 *      already return.
 *   4. One workspace cannot see another workspace's archived mail.
 *
 * No Microsoft account is involved. `fetch` is stubbed the way the Gmail tests
 * stub it, and the isolation test drives the real scoped client over the real
 * in-memory PostgREST from the tenancy suite.
 */

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'k';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  process.env.SUPABASE_DB_URL = 'postgres://x/y';
  process.env.APP_BASE_URL = 'http://localhost:3000';
  process.env.GOOGLE_CLIENT_ID = 'g';
  process.env.GOOGLE_CLIENT_SECRET = 'g';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/cb';
  process.env.MICROSOFT_CLIENT_ID = 'ms-client';
  process.env.MICROSOFT_CLIENT_SECRET = 'ms-secret';
  process.env.MICROSOFT_REDIRECT_URI = 'http://localhost:3000/api/integrations/microsoft/callback';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tool context (the shape the Gmail tests use)
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const noRow = { data: null, error: null };
  const fromBuilder = {
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
    update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue(noRow) }),
        maybeSingle: vi.fn().mockResolvedValue(noRow),
      }),
    }),
  };
  const db = { from: vi.fn().mockReturnValue(fromBuilder) };
  const integrations = {
    getAccessToken: vi.fn().mockResolvedValue({ token: 'graph-token', scopes: ['Mail.Read'] }),
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
    organizationId: 'org-test',
    userId: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    conversationId: '00000000-0000-0000-0000-000000000003',
    db: db as unknown as ToolContext['db'],
    integrations: integrations as unknown as ToolContext['integrations'],
    logger: logger as unknown as ToolContext['logger'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1 + 2. Tokens
// ---------------------------------------------------------------------------

/**
 * A minimal stand-in for the `integrations` row lookup, capturing what the
 * refresher writes back so the rotation can be asserted on.
 */
function tokenDb(row: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
          }),
        }),
      }),
      update: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
        updates.push(payload);
        return { eq: vi.fn().mockResolvedValue({ data: null, error: null }) };
      }),
    }),
  };
  return { db, updates };
}

describe('microsoft token lifecycle', () => {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };

  it('refreshes an expired token and stores the ROTATED refresh token', async () => {
    const { encryptToken, decryptToken } = await import('@cortex/core');
    const { db, updates } = tokenDb({
      id: 'int-1',
      access_token_enc: encryptToken('stale-access'),
      refresh_token_enc: encryptToken('old-refresh'),
      scopes: ['Mail.Read'],
      // Already expired, so the refresh path is the one under test.
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'fresh-access',
        // Entra ID retires the token that was just used and issues a new one.
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        // …and hands scopes back resource-qualified.
        scope:
          'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Calendars.Read offline_access',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createIntegrationsClient(
      db as never,
      '00000000-0000-0000-0000-000000000001',
      logger as never,
    );
    const result = await client.getAccessToken('microsoft');

    expect(result.token).toBe('fresh-access');
    // Stored short, so hasScopes compares like with like.
    expect(result.scopes).toEqual(['Mail.Read', 'Calendars.Read', 'offline_access']);

    // It went to the Entra ID token endpoint with a refresh_token grant.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('login.microsoftonline.com');
    expect(String(init.body)).toContain('grant_type=refresh_token');

    // THE ROTATION. The row must now hold the new refresh token, not the old
    // one — keeping the original is the mistake that works exactly once.
    const written = updates[0];
    expect(written).toBeDefined();
    expect(decryptToken(written?.refresh_token_enc as string)).toBe('rotated-refresh');
    expect(decryptToken(written?.access_token_enc as string)).toBe('fresh-access');
    // And nothing readable was persisted in the clear.
    expect(written?.access_token_enc).not.toContain('fresh-access');
  });

  it('does not refresh a token that is still valid', async () => {
    const { encryptToken } = await import('@cortex/core');
    const { db, updates } = tokenDb({
      id: 'int-1',
      access_token_enc: encryptToken('still-good'),
      refresh_token_enc: encryptToken('refresh'),
      scopes: ['Mail.Read'],
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = createIntegrationsClient(
      db as never,
      '00000000-0000-0000-0000-000000000001',
      logger as never,
    );
    await expect(client.getAccessToken('microsoft')).resolves.toMatchObject({
      token: 'still-good',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('a revoked grant fails with an instruction, not a status code', async () => {
    const { encryptToken } = await import('@cortex/core');
    const { db } = tokenDb({
      id: 'int-1',
      access_token_enc: encryptToken('stale'),
      refresh_token_enc: encryptToken('revoked-refresh'),
      scopes: ['Mail.Read'],
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'AADSTS50173: The provided grant has expired.',
          }),
      }),
    );

    const client = createIntegrationsClient(
      db as never,
      '00000000-0000-0000-0000-000000000001',
      logger as never,
    );

    const err = await client.getAccessToken('microsoft').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    const message = (err as IntegrationError).message;
    // It names the fix.
    expect(message).toMatch(/[Rr]econnect/);
    expect(message).toContain('Integrations');
    // And it never leaks the credential or Microsoft's raw payload.
    expect(message).not.toContain('revoked-refresh');
    expect(message).not.toContain('AADSTS50173');
  });

  it('normalizes resource-qualified scopes idempotently', () => {
    expect(
      normalizeGraphScopes('https://graph.microsoft.com/Mail.Send Mail.Read offline_access'),
    ).toEqual(['Mail.Send', 'Mail.Read', 'offline_access']);
    expect(normalizeGraphScopes(normalizeGraphScopes('Mail.Read').join(' '))).toEqual([
      'Mail.Read',
    ]);
    expect(normalizeGraphScopes(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Search
// ---------------------------------------------------------------------------

const NAVIERA = {
  id: 'm1',
  conversationId: 'conv-A',
  subject: 'Zarpe del 14',
  bodyPreview: 'Confirmamos el zarpe',
  receivedDateTime: '2026-03-02T10:00:00Z',
  from: { emailAddress: { name: 'Luisa Rojas', address: 'luisa@naviera.com.co' } },
  toRecipients: [{ emailAddress: { address: 'ana@acme.com' } }],
};

const NAVIERA_REPLY = {
  id: 'm2',
  conversationId: 'conv-A',
  subject: 'RE: Zarpe del 14',
  bodyPreview: 'Perfecto, quedamos así',
  receivedDateTime: '2026-03-04T09:00:00Z',
  from: { emailAddress: { address: 'ana@acme.com' } },
  toRecipients: [{ emailAddress: { address: 'luisa@naviera.com.co' } }],
};

const ADUANA = {
  id: 'm3',
  conversationId: 'conv-B',
  subject: 'Levante DIAN',
  bodyPreview: 'Falta el documento de transporte',
  receivedDateTime: '2026-03-03T12:00:00Z',
  from: { emailAddress: { address: 'tramites@aduanas.co' } },
  toRecipients: [{ emailAddress: { address: 'ana@acme.com' } }],
};

describe('outlook.search', () => {
  it('groups messages into conversations, newest first, in the gmail shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ value: [NAVIERA, ADUANA, NAVIERA_REPLY] }),
      headers: { get: () => null },
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await runTool(outlookSearch, { query: 'zarpe', maxResults: 5 }, makeCtx());

    // Three messages, two conversations.
    expect(out.threads).toHaveLength(2);
    // conv-A's latest message is 4 March, conv-B's is 3 March.
    expect(out.threads[0]?.id).toBe('conv-A');
    expect(out.threads[0]?.subject).toBe('RE: Zarpe del 14');
    expect(out.threads[0]?.from).toBe('ana@acme.com');
    expect(out.threads[0]?.snippet).toBe('Perfecto, quedamos así');
    expect(out.threads[0]?.date).toBe('2026-03-04T09:00:00Z');
    expect(out.threads[1]?.id).toBe('conv-B');

    // The row carries exactly the keys gmail.search returns — no more.
    expect(Object.keys(out.threads[0] ?? {}).sort()).toEqual([
      'date',
      'from',
      'id',
      'snippet',
      'subject',
    ]);

    // $search rather than $filter (Graph rejects both together), the token on
    // the header, and no $orderby alongside $search.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://graph.microsoft.com/v1.0/me/messages');
    expect(decodeURIComponent(url)).toContain('$search="zarpe"');
    expect(decodeURIComponent(url)).not.toContain('$orderby');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer graph-token');
  });

  it('an empty mailbox returns an empty array, not an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ value: [] }),
        headers: { get: () => null },
      }),
    );
    const out = await runTool(outlookSearch, { query: 'nada', maxResults: 5 }, makeCtx());
    expect(out.threads).toHaveLength(0);
  });

  it('empty query → ValidationError', async () => {
    await expect(
      runTool(outlookSearch, { query: '', maxResults: 5 }, makeCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('list_threads turns a contact into a participants: term and keeps To:', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ value: [NAVIERA, NAVIERA_REPLY] }),
      headers: { get: () => null },
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await runTool(
      outlookListThreads,
      { contactEmail: 'luisa@naviera.com.co', maxResults: 5 },
      makeCtx(),
    );

    expect(out.threads).toHaveLength(1);
    expect(out.threads[0]?.to).toBe('luisa@naviera.com.co');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(decodeURIComponent(url)).toContain('participants:luisa@naviera.com.co');
  });

  it('a 401 from Graph says to reconnect instead of repeating the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () =>
          JSON.stringify({ error: { code: 'InvalidAuthenticationToken', message: 'expired' } }),
        headers: { get: () => null },
      }),
    );
    const err = await runTool(outlookSearch, { query: 'x', maxResults: 5 }, makeCtx()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IntegrationError);
    expect((err as IntegrationError).message).toMatch(/[Rr]econnect Microsoft 365/);
  });
});

// ---------------------------------------------------------------------------
// Archivability
// ---------------------------------------------------------------------------

describe('what may be archived', () => {
  const previous = process.env.INTERNAL_EMAIL_DOMAINS;
  beforeEach(() => {
    process.env.INTERNAL_EMAIL_DOMAINS = 'acme.com';
  });
  afterEach(() => {
    if (previous === undefined) process.env.INTERNAL_EMAIL_DOMAINS = '';
    else process.env.INTERNAL_EMAIL_DOMAINS = previous;
  });

  it('a thread between colleagues is not archive material', () => {
    const audience = classifyAudience(['ana@acme.com', 'ben@acme.com']);
    expect(audience.undecidable).toBe(false);
    expect(audience.external).toHaveLength(0);
  });

  it('a thread with a client is', () => {
    const audience = classifyAudience(['ana@acme.com', 'luisa@naviera.com.co']);
    expect(audience.external).toEqual(['luisa@naviera.com.co']);
    expect(audience.externalDomains).toEqual(['naviera.com.co']);
  });

  it('with no internal domains configured, nothing is archivable', () => {
    process.env.INTERNAL_EMAIL_DOMAINS = '';
    const audience = classifyAudience(['ana@acme.com', 'luisa@naviera.com.co']);
    expect(audience.undecidable).toBe(true);
    expect(audience.external).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. One workspace cannot see another's mail
// ---------------------------------------------------------------------------

const ACME = 'org-acme';
const GLOBEX = 'org-globex';
const ANA = '11111111-1111-4111-8111-111111111111';
const CARLA = '33333333-3333-4333-8333-333333333333';

function fixture(): Tables {
  return {
    microsoft_mail_ingests: [
      {
        id: 'ing-acme',
        organization_id: ACME,
        user_id: ANA,
        conversation_id: 'conv-shared',
        subject: 'Zarpe del 14 — Acme',
        counterpart_domain: 'naviera.com.co',
        client_id: 'client-acme',
        document_id: 'doc-acme',
        sha256: 'aaa',
        status: 'ready',
      },
      {
        id: 'ing-globex',
        organization_id: GLOBEX,
        user_id: CARLA,
        // THE ADVERSARIAL PART: the same Graph conversation id in both
        // workspaces. A lookup that lost its tenant filter returns something
        // plausible rather than nothing, which is how this bug survives review.
        conversation_id: 'conv-shared',
        subject: 'Zarpe del 14 — Globex',
        counterpart_domain: 'naviera.com.co',
        client_id: 'client-globex',
        document_id: 'doc-globex',
        sha256: 'bbb',
        status: 'ready',
      },
    ],
    // Migration 0075's human-vouched domain register: the only thing the mail
    // archive is allowed to attribute a thread from.
    client_domains: [
      {
        id: 'dom-acme',
        organization_id: ACME,
        client_id: 'client-acme',
        domain: 'naviera.com.co',
        verified_by: ANA,
      },
      {
        id: 'dom-globex',
        organization_id: GLOBEX,
        client_id: 'client-globex',
        // THE SAME DOMAIN, registered by both companies. Both really are
        // customers of that shipping line; each must resolve to its own client.
        domain: 'naviera.com.co',
        verified_by: CARLA,
      },
    ],
    clients: [
      { id: 'client-acme', organization_id: ACME, name: 'Naviera del Caribe S.A.S.', tax_id: '1' },
      {
        id: 'client-globex',
        organization_id: GLOBEX,
        name: 'Naviera del Caribe S.A.S.',
        tax_id: '2',
      },
    ],
  };
}

describe('workspace isolation', () => {
  it('an archived thread is invisible to the other workspace', async () => {
    const raw = createFakeSupabase(fixture()).client;
    const acme = createOrgScopedClient(raw, ACME);
    const globex = createOrgScopedClient(raw, GLOBEX);

    const { data: fromAcme } = await acme
      .from('microsoft_mail_ingests')
      .select('id, subject, document_id')
      .eq('conversation_id', 'conv-shared')
      .maybeSingle();
    expect(fromAcme?.id).toBe('ing-acme');
    expect(fromAcme?.document_id).toBe('doc-acme');

    const { data: fromGlobex } = await globex
      .from('microsoft_mail_ingests')
      .select('id, subject, document_id')
      .eq('conversation_id', 'conv-shared')
      .maybeSingle();
    expect(fromGlobex?.id).toBe('ing-globex');

    // Neither one can enumerate the other's, even with no filter at all.
    const { data: allAcme } = await acme.from('microsoft_mail_ingests').select('id');
    expect((allAcme ?? []).map((r) => r.id)).toEqual(['ing-acme']);
  });

  it('the client link resolves inside the workspace, never across it', async () => {
    const raw = createFakeSupabase(fixture()).client;

    // Both workspaces registered the SAME domain for their own client. Each
    // must resolve to its own — an unscoped lookup would find two rows and, via
    // maybeSingle, either throw or pick one at random. Both are leaks.
    await expect(
      matchClientByDomain(createOrgScopedClient(raw, ACME), 'naviera.com.co'),
    ).resolves.toBe('client-acme');
    await expect(
      matchClientByDomain(createOrgScopedClient(raw, GLOBEX), 'naviera.com.co'),
    ).resolves.toBe('client-globex');
  });

  it('an unregistered domain leaves the link empty rather than guessing', async () => {
    const raw = createFakeSupabase(fixture()).client;
    const acme = createOrgScopedClient(raw, ACME);
    // Nobody vouched for this domain, so nothing is attributed — even though a
    // name-similarity matcher would happily have picked "Naviera del Caribe".
    await expect(matchClientByDomain(acme, 'navieradelcaribe.com')).resolves.toBeNull();
    await expect(matchClientByDomain(acme, null)).resolves.toBeNull();
  });
});
