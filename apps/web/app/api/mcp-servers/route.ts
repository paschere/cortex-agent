import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { encryptToken } from '@cortex/core';
import { isPrivateUrl, syncExternalServerManifest } from '@cortex/agent-tools';

export const runtime = 'nodejs';

const MAX_SERVERS = 5;

const CreateBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    url: z.string().trim().min(1).max(512),
    authType: z.enum(['none', 'bearer', 'api_key']),
    authValue: z.string().min(1).optional(),
  })
  .refine((d) => d.authType === 'none' || !!d.authValue, {
    message: 'authValue is required for bearer / api_key auth',
    path: ['authValue'],
  });

export async function GET() {
  const user = await requireSession();
  const db = getSupabaseServiceClient();

  const { data, error } = await db
    .from('user_mcp_servers')
    .select(
      'id, name, url, auth_type, auth_value_encrypted, enabled, trusted, tool_count, last_checked_at, last_error, created_at, updated_at',
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: 'Failed to load servers' }, { status: 500 });
  }

  const servers = (data ?? []).map((row) => {
    const { auth_value_encrypted, ...rest } = row as Record<string, unknown> & {
      auth_value_encrypted: string | null;
    };
    return { ...rest, authConfigured: !!auth_value_encrypted };
  });

  return NextResponse.json({ servers, atCapacity: servers.length >= MAX_SERVERS });
}

export async function POST(req: NextRequest) {
  const user = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { name, url, authType, authValue } = parsed.data;

  if (isPrivateUrl(url)) {
    return NextResponse.json(
      { error: 'URL is not allowed (private, loopback, or malformed)' },
      { status: 422 },
    );
  }

  const db = getSupabaseServiceClient();

  const { count } = await db
    .from('user_mcp_servers')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id);
  if ((count ?? 0) >= MAX_SERVERS) {
    return NextResponse.json({ error: `Maximum of ${MAX_SERVERS} servers reached` }, { status: 422 });
  }

  const auth_value_encrypted =
    authType !== 'none' && authValue ? encryptToken(authValue) : null;

  const { data: inserted, error: insErr } = await db
    .from('user_mcp_servers')
    .insert({
      user_id: user.id,
      name,
      url,
      auth_type: authType,
      auth_value_encrypted,
    })
    .select('id')
    .single();

  if (insErr || !inserted) {
    return NextResponse.json({ error: 'Failed to create server' }, { status: 500 });
  }

  const id = inserted.id as string;
  // Fire-and-forget manifest sync: never block the create response.
  void syncExternalServerManifest(db, user.id, id).catch(() => {});

  return NextResponse.json({ id, toolCount: 0 }, { status: 201 });
}
