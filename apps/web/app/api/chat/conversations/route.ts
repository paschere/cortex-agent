import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';

export async function GET() {
  const user = await requireSession();
  const db = getSupabaseServiceClient();

  const { data, error } = await db
    .from('conversations')
    .select('id, agent_id, surface, title, created_at, updated_at')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ conversations: data ?? [] });
}
