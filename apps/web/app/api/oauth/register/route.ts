import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { registerClient } from '@/lib/oauth';
import { corsJson, corsPreflight } from '@/lib/oauth-cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 7591 — Dynamic Client Registration.
 *
 * claude.ai POSTs application/json with client_name="Claude",
 * redirect_uris=[...], grant_types, response_types, token_endpoint_auth_method.
 * We create a public client (no secret when auth_method=none) and echo the
 * registered metadata.
 */
const RegisterBody = z.object({
  client_name: z.string().min(1).max(255).optional(),
  redirect_uris: z.array(z.string().url()).min(1),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z
    .enum(['none', 'client_secret_post', 'client_secret_basic'])
    .optional(),
  scope: z.string().optional(),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return corsJson(
      { error: 'invalid_client_metadata', error_description: 'Invalid JSON' },
      { status: 400 },
    );
  }

  const parsed = RegisterBody.safeParse(body);
  if (!parsed.success) {
    return corsJson(
      {
        error: 'invalid_client_metadata',
        error_description: parsed.error.message,
      },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const client = await registerClient({
    client_name: input.client_name ?? 'Claude',
    redirect_uris: input.redirect_uris,
    grant_types: input.grant_types,
    response_types: input.response_types,
    token_endpoint_auth_method: input.token_endpoint_auth_method,
    scope: input.scope,
  });

  const response: Record<string, unknown> = {
    client_id: client.id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: client.response_types,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    scope: client.scope,
    client_id_issued_at: Math.floor(
      new Date(client.created_at).getTime() / 1000,
    ),
  };
  if (client.client_secret) {
    response.client_secret = client.client_secret;
    response.client_secret_expires_at = 0; // never expires
  }

  return corsJson(response, { status: 201 });
}

export function OPTIONS() {
  return corsPreflight();
}
