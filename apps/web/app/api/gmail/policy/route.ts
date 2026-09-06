import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { createIntegrationsClient, readMailPolicy, saveMailPolicy } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { NextResponse } from 'next/server';
import { gmailFetch } from '../../../../../../packages/agent-tools/src/gmail/client';
export async function GET() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const policy = await readMailPolicy(db, user.id);
  let labels: { id: string; name: string }[] = [];
  let labelsUnavailable = false;
  try {
    labels = (
      await gmailFetch<{ labels: { id: string; name: string }[] }>(
        { integrations: createIntegrationsClient(db, user.id, logger), signal: undefined },
        '/labels',
      )
    ).labels;
  } catch {
    labelsUnavailable = true;
  }
  return NextResponse.json({ policy, labels, labelsUnavailable });
}
export async function POST(request: Request) {
  const user = await requireSession();
  try {
    const policy = await saveMailPolicy(
      getOrgScopedClient(user.organization.id),
      user.id,
      await request.json(),
    );
    return NextResponse.json({ policy });
  } catch {
    return NextResponse.json(
      { error: 'Revisa etiquetas y direcciones de remitentes.' },
      { status: 400 },
    );
  }
}
