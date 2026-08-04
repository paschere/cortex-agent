import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  const user = await requireSession();
  const db = getSupabaseServiceClient();
  // MCP sessions (Claude tool-call logs) are excluded from the sidebar: they
  // are records, not chats to resume. They remain visible in /conversations
  // via ?surface=mcp and in the audit log.
  const { data } = await db
    .from('conversations')
    .select('id, title, created_at, updated_at, agents(name)')
    .eq('user_id', user.id)
    .neq('surface', 'mcp')
    .order('updated_at', { ascending: false })
    .limit(20);
  return NextResponse.json({ conversations: data ?? [] });
}
