import { getOrgScopedClient } from '@/lib/supabase/service';
import { authenticateBridge } from '@/lib/whatsapp/bridge';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * The catalogue of groups the paired account is in.
 *
 * This is what the operator picks from. It carries the group's id, its name and
 * how many people are in it — nothing that was said in it. A row existing means
 * "Cortex can see this group"; `archive_enabled` (which this endpoint never
 * touches) means "somebody chose to remember it".
 *
 * The separation matters: knowing a group exists is not the same as archiving
 * it, and the list has to exist BEFORE the choice can be made. Refreshed on
 * every reconnect, because groups are created, renamed and left.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface IncomingGroup {
  jid?: string;
  subject?: string | null;
  participantCount?: number | null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = authenticateBridge(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as { groups?: IncomingGroup[] };
  const incoming = (body.groups ?? []).filter(
    (g) => typeof g.jid === 'string' && g.jid.endsWith('@g.us'),
  );
  if (incoming.length === 0) return NextResponse.json({ ok: true, groups: 0 });

  const db = getOrgScopedClient(auth.caller.organizationId);
  const now = new Date().toISOString();

  // Upsert on the group id: the name and the headcount are refreshed, and every
  // decision already attached to the row — whether it is archived, which space
  // it goes to, who switched it on — is untouched. The bridge reports facts
  // about WhatsApp; it does not get to change what the company decided.
  for (let i = 0; i < incoming.length; i += 200) {
    await db.from('whatsapp_groups').upsert(
      incoming.slice(i, i + 200).map((g) => ({
        jid: g.jid as string,
        subject: g.subject ?? null,
        participant_count:
          typeof g.participantCount === 'number' ? Math.max(0, g.participantCount) : null,
        updated_at: now,
      })),
      { onConflict: 'organization_id,jid' },
    );
  }

  return NextResponse.json({ ok: true, groups: incoming.length });
}
