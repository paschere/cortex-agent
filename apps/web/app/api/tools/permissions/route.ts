import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { getTool, listTools } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

const Body = z.object({
  teamId: z.string().uuid(),
  toolPattern: z.string().min(1).max(200),
  allowed: z.boolean(),
});

/** Every family prefix present in the live registry (e.g. 'hubspot', 'kb'). */
function knownFamilies(): Set<string> {
  return new Set(listTools().map((t) => t.id.split('.')[0] ?? t.id));
}

/** A pattern is valid if it is a registered tool id or '<known family>.*'. */
function isValidPattern(pattern: string): boolean {
  if (pattern.endsWith('.*')) return knownFamilies().has(pattern.slice(0, -2));
  return Boolean(getTool(pattern));
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (session.role !== 'org_admin') {
    return NextResponse.json(
      { error: 'Only org admins can manage team tool permissions' },
      { status: 403 },
    );
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
  const { teamId, toolPattern, allowed } = parsed.data;

  if (!isValidPattern(toolPattern)) {
    return NextResponse.json(
      { error: `Unknown tool or family pattern: ${toolPattern}` },
      { status: 422 },
    );
  }

  const db = getSupabaseServiceClient();
  const { error } = await db.from('team_tool_permissions').upsert(
    {
      team_id: teamId,
      tool_pattern: toolPattern,
      allowed,
      updated_by: session.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'team_id,tool_pattern' },
  );

  if (error) {
    return NextResponse.json({ error: 'Failed to save tool permission' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
