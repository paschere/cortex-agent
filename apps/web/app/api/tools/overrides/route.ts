import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { getTool } from '@zipdev/agent-tools';

export const runtime = 'nodejs';

const Body = z.object({
  userId: z.string().uuid(),
  toolId: z.string().min(1).max(200),
  enabled: z.boolean(),
});

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (session.role !== 'org_admin') {
    return NextResponse.json({ error: 'Only org admins can manage tool overrides' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { userId, toolId, enabled } = parsed.data;

  if (!getTool(toolId)) {
    return NextResponse.json({ error: `Unknown tool: ${toolId}` }, { status: 422 });
  }

  const db = getSupabaseServiceClient();
  const { error } = await db
    .from('user_tool_overrides')
    .upsert(
      {
        user_id: userId,
        tool_id: toolId,
        enabled,
        updated_by: session.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,tool_id' },
    );

  if (error) {
    return NextResponse.json({ error: 'Failed to save override' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
