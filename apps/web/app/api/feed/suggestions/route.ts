import { suggestFeedActivations } from '@/lib/feed/source-suggestions';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  const user = await requireSession();
  try {
    const result = await suggestFeedActivations(
      getOrgScopedClient(user.organization.id),
      user.id,
      user.organization.id,
    );
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'No se pudieron preparar sugerencias.' },
      { status: 503 },
    );
  }
}
