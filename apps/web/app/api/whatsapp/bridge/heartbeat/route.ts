import { getOrgScopedClient } from '@/lib/supabase/service';
import { authenticateBridge } from '@/lib/whatsapp/bridge';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * The bridge says how it is; Cortex says what to listen to.
 *
 * ONE ENDPOINT, BOTH DIRECTIONS, ON PURPOSE. The bridge needs to report its
 * connection state (and its QR code while pairing) and it needs to learn which
 * groups an operator has switched on. Splitting those into a push and a poll
 * would mean two schedules that can disagree — a group enabled in the UI and
 * ignored by a bridge whose poll had not come round yet, with nothing on screen
 * to explain it. Answering the report with the current configuration makes
 * "how fresh is the bridge's idea of what to archive" exactly as fresh as "how
 * recently did it check in", which is one fact an operator can see.
 *
 * THE ALLOW-LIST TRAVELS IN THIS RESPONSE, and it is the first of two locks on
 * "only read the groups that were explicitly switched on". The bridge drops
 * everything else before it leaves Railway, so an un-enabled group's messages
 * never cross the network. The second lock is in the ingest route, which checks
 * again before writing — because a bridge running an old configuration must not
 * be able to archive something nobody chose.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Status = 'disconnected' | 'pairing' | 'connected' | 'logged_out';

interface HeartbeatBody {
  status?: Status;
  phoneNumber?: string | null;
  /** `data:image/png;base64,…`, already rendered by the bridge. */
  qr?: string | null;
  error?: string | null;
}

const STATUSES = new Set<Status>(['disconnected', 'pairing', 'connected', 'logged_out']);

/** WhatsApp rotates the pairing code roughly every 20 seconds. */
const QR_TTL_MS = 60_000;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = authenticateBridge(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as HeartbeatBody;
  const db = getOrgScopedClient(auth.caller.organizationId);
  const now = new Date();

  const status: Status = STATUSES.has(body.status as Status)
    ? (body.status as Status)
    : 'disconnected';

  const row: Record<string, unknown> = {
    status,
    last_seen_at: now.toISOString(),
    updated_at: now.toISOString(),
    last_error: body.error ?? null,
  };
  if (body.phoneNumber !== undefined) row.phone_number = body.phoneNumber;
  if (status === 'connected') {
    row.last_connected_at = now.toISOString();
    // A connected session has nothing to scan. Clearing it stops the pairing
    // panel showing a dead code to somebody who is already connected.
    row.pairing_qr = null;
    row.pairing_qr_expires_at = null;
  } else if (body.qr) {
    row.pairing_qr = body.qr;
    row.pairing_qr_expires_at = new Date(now.getTime() + QR_TTL_MS).toISOString();
  }

  await db.from('whatsapp_sessions').upsert(row, { onConflict: 'organization_id' });

  const { data: session } = await db.from('whatsapp_sessions').select('dm_enabled').maybeSingle();

  const { data: groups } = await db
    .from('whatsapp_groups')
    .select('jid, archive_from')
    .eq('archive_enabled', true);

  return NextResponse.json({
    ok: true,
    /** The only groups the bridge may forward anything from. */
    archiveGroups: ((groups ?? []) as Array<{ jid: string; archive_from: string | null }>).map(
      (g) => ({ jid: g.jid, archiveFrom: g.archive_from }),
    ),
    dmEnabled: session?.dm_enabled !== false,
  });
}
