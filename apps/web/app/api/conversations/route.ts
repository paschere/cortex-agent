import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';

export async function GET() {
  const user = await requireSession();
  const db = getSupabaseServiceClient();
  const { data } = await db
    .from('conversations')
    .select('id, title, created_at, updated_at, agents(name)')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(20);
  return NextResponse.json({ conversations: data ?? [] });
}
