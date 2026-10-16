import { isSameOrigin } from '@/lib/activations/request';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { autofillForForm } from '@/lib/trackers/autofill-view';
import { getView } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/** «Llenar con Cortex» de un formulario de una vista (sólo con sesión). No guarda nada. */

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 });
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const view = await getView(db, id);
  if (!view) return NextResponse.json({ error: 'Esa vista ya no existe.' }, { status: 404 });
  return autofillForForm({
    db,
    view,
    organizationId: user.organization.id,
    userId: user.id,
    body: await req.json().catch(() => null),
    signal: req.signal,
  });
}
