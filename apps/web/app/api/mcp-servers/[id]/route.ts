import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { encryptToken } from '@cortex/core';
import { isPrivateUrl } from '@cortex/agent-tools';

export const runtime = 'nodejs';

const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    url: z.string().trim().min(1).max(512).optional(),
    authType: z.enum(['none', 'bearer', 'api_key']).optional(),
    authValue: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    trusted: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'At least one field is required' });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const b = parsed.data;

  const db = getOrgScopedClient(user.organization.id);

  // Verify ownership.
  const { data: existing, error: ownErr } = await db
    .from('user_mcp_servers')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();
  if (ownErr || !existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (b.url && isPrivateUrl(b.url)) {
    return NextResponse.json(
      { error: 'URL is not allowed (private, loopback, or malformed)' },
      { status: 422 },
    );
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.name !== undefined) update.name = b.name;
  if (b.url !== undefined) update.url = b.url;
  if (b.enabled !== undefined) update.enabled = b.enabled;
  if (b.trusted !== undefined) update.trusted = b.trusted;
  if (b.authType !== undefined) {
    update.auth_type = b.authType;
    if (b.authType === 'none') update.auth_value_encrypted = null;
  }
  if (b.authValue !== undefined) {
    update.auth_value_encrypted = encryptToken(b.authValue);
  }

  const { data: updated, error: updErr } = await db
    .from('user_mcp_servers')
    .update(update)
    .eq('id', id)
    .eq('user_id', user.id)
    .select(
      'id, name, url, auth_type, enabled, trusted, tool_count, last_checked_at, last_error, created_at, updated_at',
    )
    .single();

  if (updErr || !updated) {
    return NextResponse.json({ error: 'Failed to update server' }, { status: 500 });
  }

  return NextResponse.json({ server: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await params;
  const db = getOrgScopedClient(user.organization.id);

  // Verify ownership.
  const { data: existing, error: ownErr } = await db
    .from('user_mcp_servers')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();
  if (ownErr || !existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { error: delErr } = await db
    .from('user_mcp_servers')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);
  if (delErr) {
    return NextResponse.json({ error: 'Failed to delete server' }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
