import { encryptToken } from '@cortex/core';
import { ConfirmationRequiredError } from '@cortex/core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTool } from '../../registry';
import type { ToolContext } from '../../types';
import { executeCustomTool } from '../execute';
import type { HostResolver } from '../guard';
import { customToolDef } from '../tool-def';
import type { CustomToolRow } from '../types';

/**
 * End-to-end behaviour of a custom tool: the request it builds, the failures it
 * absorbs, the secret it does not leak, and the fact that it goes through
 * `runTool` like everything else.
 */

beforeAll(() => {
  // Same shape as packages/core/src/crypto.test.ts — getEnv() validates the
  // whole schema, so a test that only needs the encryption key still has to
  // satisfy it.
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'k';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  process.env.SUPABASE_DB_URL = 'postgres://x/y';
  process.env.APP_BASE_URL = 'http://localhost:3000';
  process.env.GOOGLE_CLIENT_ID = 'g';
  process.env.GOOGLE_CLIENT_SECRET = 'g';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/cb';
  process.env.HUBSPOT_CLIENT_ID = 'h';
  process.env.HUBSPOT_CLIENT_SECRET = 'h';
  process.env.HUBSPOT_REDIRECT_URI = 'http://localhost:3000/cb';
});

const SECRET = 'sk_live_super_secret_value_9182';

/**
 * Every hostname the tests use resolves to a public address. The DNS half of
 * the guard has its own test file; here the resolver is a stub so these tests
 * measure the executor rather than the network.
 */
const resolve: HostResolver = async (hostname) => {
  if (hostname === 'erp.example.com' || hostname === 'otro.example.com') {
    return [{ address: '203.0.113.10', family: 4 }];
  }
  throw new Error(`ENOTFOUND ${hostname}`);
};

const seen: { url: string; headers: Record<string, string>; body: string | null }[] = [];

const server = setupServer(
  http.get('https://erp.example.com/guias/:guia', async ({ request, params }) => {
    seen.push({ url: request.url, headers: headersOf(request), body: null });
    return HttpResponse.json({
      data: { guia: params.guia, estado: 'EN RUTA', historial: ['a', 'b'] },
    });
  }),
  http.post('https://erp.example.com/guias', async ({ request }) => {
    seen.push({ url: request.url, headers: headersOf(request), body: await request.text() });
    return HttpResponse.json({ ok: true });
  }),
  http.get('https://erp.example.com/denegado', () =>
    HttpResponse.json({ error: 'invalid key' }, { status: 401 }),
  ),
  // An endpoint that echoes the credential straight back at us. Rare, and
  // exactly the case the redaction pass exists for.
  http.get('https://erp.example.com/eco', ({ request }) =>
    HttpResponse.json({ recibido: request.headers.get('authorization') }),
  ),
  http.get('https://erp.example.com/grande', () =>
    HttpResponse.json({ items: new Array(2000).fill('0123456789') }),
  ),
  // Redirect chains.
  http.get('https://erp.example.com/redir-interno', () =>
    HttpResponse.text('', {
      status: 302,
      headers: { location: 'https://169.254.169.254/latest/' },
    }),
  ),
  http.get('https://erp.example.com/redir-externo', () =>
    HttpResponse.text('', { status: 302, headers: { location: 'https://otro.example.com/fin' } }),
  ),
  http.get('https://otro.example.com/fin', ({ request }) => {
    seen.push({ url: request.url, headers: headersOf(request), body: null });
    return HttpResponse.json({ llegó: true });
  }),
  // Nothing should ever reach the metadata service. If the guard fails this
  // handler fires and the assertion below catches it.
  http.get('https://169.254.169.254/latest/', () => {
    seen.push({ url: 'METADATA', headers: {}, body: null });
    return HttpResponse.json({ credenciales: 'AKIA…' });
  }),
);

function headersOf(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  seen.length = 0;
});
afterAll(() => server.close());

function row(overrides: Partial<CustomToolRow> = {}): CustomToolRow {
  return {
    id: 'ct-1',
    organization_id: 'org-1',
    slug: 'consultar_guia',
    name: 'Consultar guía',
    description: 'Úsala cuando pregunten por el estado de una guía.',
    input_schema: {
      fields: [{ name: 'guia', type: 'string', required: true, description: 'Número de guía' }],
    },
    http_method: 'GET',
    url_template: 'https://erp.example.com/guias/{{guia}}',
    headers: {},
    body_encoding: 'none',
    body_template: null,
    auth_type: 'bearer',
    auth_header_name: null,
    auth_username: null,
    auth_secret_encrypted: encryptToken(SECRET),
    response_path: 'data',
    response_max_chars: 8000,
    timeout_ms: 5000,
    allow_insecure_http: false,
    follow_redirects: false,
    requires_confirmation: false,
    rate_limit_per_minute: 20,
    enabled: true,
    ...overrides,
  };
}

describe('executeCustomTool', () => {
  it('builds the request, authenticates it, and returns the selected slice', async () => {
    const { result } = await executeCustomTool(row(), { guia: 'AB-12' }, { resolve });

    expect(seen[0]?.url).toBe('https://erp.example.com/guias/AB-12');
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ guia: 'AB-12', estado: 'EN RUTA', historial: ['a', 'b'] });
  });

  it('sends a JSON body whose shape a hostile argument cannot change', async () => {
    const { result } = await executeCustomTool(
      row({
        http_method: 'POST',
        url_template: 'https://erp.example.com/guias',
        body_encoding: 'json',
        body_template: { guia: '{{guia}}' },
        response_path: null,
      }),
      { guia: '","admin":true,"x":"' },
      { resolve },
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ guia: '","admin":true,"x":"' });
  });

  it('never puts the secret in the preview the tester displays', async () => {
    const { detail } = await executeCustomTool(row(), { guia: 'AB-12' }, { resolve });
    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain(SECRET);
    expect(detail.preview.headers.Authorization).toMatch(/^Bearer •+$/);
  });

  it('scrubs the secret out of a response that echoes it back', async () => {
    const { result, detail } = await executeCustomTool(
      row({ url_template: 'https://erp.example.com/eco', response_path: null }),
      { guia: 'x' },
      { resolve },
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(detail.response)).not.toContain(SECRET);
  });

  it('turns a 401 into a sentence instead of throwing', async () => {
    const { result } = await executeCustomTool(
      row({ url_template: 'https://erp.example.com/denegado' }),
      { guia: 'x' },
      { resolve },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.message).toMatch(/rejected the credentials/i);
  });

  it('refuses an internal destination without ever opening a socket', async () => {
    const { result } = await executeCustomTool(
      row({ url_template: 'https://10.0.0.9/interno' }),
      { guia: 'x' },
      { resolve },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/private, loopback/i);
    expect(seen).toHaveLength(0);
  });

  it('does not follow redirects by default, and says why', async () => {
    const { result } = await executeCustomTool(
      row({ url_template: 'https://erp.example.com/redir-externo' }),
      { guia: 'x' },
      { resolve },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not follow redirects/i);
  });

  it('THE REDIRECT ATTACK: a 302 to an internal address is blocked at the hop', async () => {
    const { result, detail } = await executeCustomTool(
      row({ url_template: 'https://erp.example.com/redir-interno', follow_redirects: true }),
      { guia: 'x' },
      { resolve },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/private, loopback|reserved/i);
    // The first hop happened; the metadata endpoint was never contacted.
    expect(detail.chain).toEqual(['https://erp.example.com/redir-interno']);
    expect(seen.some((s) => s.url === 'METADATA')).toBe(false);
  });

  it('drops the credential when a redirect crosses to another origin', async () => {
    const { result } = await executeCustomTool(
      row({
        url_template: 'https://erp.example.com/redir-externo',
        follow_redirects: true,
        response_path: null,
      }),
      { guia: 'x' },
      { resolve },
    );
    expect(result.ok).toBe(true);
    const finalHop = seen.find((s) => s.url === 'https://otro.example.com/fin');
    expect(finalHop).toBeDefined();
    expect(finalHop?.headers.authorization).toBeUndefined();
  });

  it('truncates a response that would otherwise flood the context', async () => {
    const { result } = await executeCustomTool(
      row({
        url_template: 'https://erp.example.com/grande',
        response_path: null,
        response_max_chars: 400,
      }),
      { guia: 'x' },
      { resolve },
    );
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(String(result.data)).toMatch(/recortada/);
  });
});

// ---------------------------------------------------------------------------
// The part that makes this a Cortex tool rather than a bespoke HTTP caller
// ---------------------------------------------------------------------------

interface Recorded {
  table: string;
  rows: unknown;
}

function makeCtx(recorded: Recorded[]): ToolContext {
  const builder = (table: string) => ({
    insert: vi.fn(async (rows: unknown) => {
      recorded.push({ table, rows });
      return { data: null, error: null };
    }),
    upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
    update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi
          .fn()
          .mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    }),
  });
  return {
    organizationId: 'org-1',
    userId: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    db: {
      from: vi.fn(builder),
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    } as unknown as ToolContext['db'],
    integrations: {
      getAccessToken: vi.fn(),
      hasScopes: vi.fn().mockResolvedValue(true),
    } as unknown as ToolContext['integrations'],
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as ToolContext['logger'],
  };
}

describe('a custom tool inside runTool', () => {
  let recorded: Recorded[];
  beforeEach(() => {
    recorded = [];
  });

  it('is a tool id under the reserved prefix', () => {
    expect(customToolDef(row()).id).toBe('custom.consultar_guia');
  });

  it('validates its arguments against the schema built from the definition', async () => {
    const tool = customToolDef(row(), { resolve });
    await expect(runTool(tool, { guia: 123 }, makeCtx(recorded))).rejects.toThrow(/Invalid input/);
  });

  it('runs, and leaves an audit row that does not contain the secret', async () => {
    const tool = customToolDef(row(), { resolve });
    const out = await runTool(tool, { guia: 'AB-12' }, makeCtx(recorded));
    expect(out.ok).toBe(true);

    const audits = recorded.filter((r) => r.table === 'audit_events');
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    // The tool id is what makes a custom call findable in the audit trail.
    expect(JSON.stringify(audits)).toContain('custom.consultar_guia');
    // And the whole recorded conversation with the database, for good measure.
    expect(JSON.stringify(recorded)).not.toContain(SECRET);
  });

  it('gates a write behind confirmation, because that is what the row says', async () => {
    const tool = customToolDef(row({ http_method: 'POST', requires_confirmation: true }), {
      resolve,
    });
    await expect(runTool(tool, { guia: 'AB-12' }, makeCtx(recorded))).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
  });

  it('a failing endpoint returns a message rather than aborting the turn', async () => {
    const tool = customToolDef(row({ url_template: 'https://erp.example.com/denegado' }), {
      resolve,
    });
    const out = await runTool(tool, { guia: 'AB-12' }, makeCtx(recorded));
    expect(out.ok).toBe(false);
    expect(out.message).toBeTruthy();
  });
});
