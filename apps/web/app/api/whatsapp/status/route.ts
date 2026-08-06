import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { isGroupReplyScope, listVisibleSpaces } from '@cortex/agent-tools';
import { NextResponse } from 'next/server';

/**
 * Everything the WhatsApp screen shows, in one reading.
 *
 * One endpoint rather than four because the answers have to agree with each
 * other: "connected" next to a group list from before the last reconnect is
 * how somebody ends up debugging a problem that does not exist.
 *
 * WHAT IS DELIBERATELY NOT HERE: message content. This screen is about the
 * connection and the decisions — what is archived, since when, and who is
 * linked. The conversations themselves are documents in Brain Knowledge and are
 * read there, subject to the space permissions that were chosen when the group
 * was switched on. A "recent messages" preview here would be a second way to
 * read a group's contents that answers to nothing.
 *
 * `me` and `unlinkedNumbers` were added when the surface moved to Integrations,
 * for one reason: linking your own number used to mean typing it into a box,
 * and a number typed with the wrong country code produces a link that silently
 * matches nobody. Both fields exist so the screen can offer the number back to
 * the person instead of asking for it — the digits come from WhatsApp itself,
 * already through `normalizePhone`, so there is nothing to get wrong.
 */

export const dynamic = 'force-dynamic';

/** After this long with no heartbeat the bridge is not running, whatever it last said. */
const STALE_AFTER_MS = 3 * 60_000;

export async function GET(): Promise<NextResponse> {
  const session = await requireSession();
  const db = getOrgScopedClient(session.organization.id);
  const isAdmin = session.role === 'org_admin';

  const { data: connection } = await db
    .from('whatsapp_sessions')
    .select(
      'status, phone_number, pairing_qr, pairing_qr_expires_at, last_connected_at, last_seen_at, last_error, dm_enabled',
    )
    .maybeSingle();

  const lastSeenMs = connection?.last_seen_at ? Date.parse(connection.last_seen_at as string) : 0;
  const bridgeAlive = Date.now() - lastSeenMs < STALE_AFTER_MS;
  const qrFresh =
    Boolean(connection?.pairing_qr) &&
    Date.parse((connection?.pairing_qr_expires_at as string | null) ?? '') > Date.now();

  const { data: groupRows } = await db
    .from('whatsapp_groups')
    .select(
      'id, jid, subject, participant_count, archive_enabled, space_id, enabled_at, archive_from, last_message_at, last_ingested_at, reply_enabled, reply_scope, reply_space_id, reply_enabled_at, reply_limit_per_hour',
    )
    .order('archive_enabled', { ascending: false })
    .order('last_message_at', { ascending: false })
    .limit(300);

  const spaces = await listVisibleSpaces(db, session.id);
  const spaceNames = new Map(spaces.map((s) => [s.id, s.name]));

  const { data: linkRows } = await db
    .from('whatsapp_links')
    .select('phone_e164, user_id, display_name, last_seen_at, created_at')
    .order('created_at', { ascending: true })
    .limit(200);

  const userIds = [
    ...new Set(((linkRows ?? []) as Array<{ user_id: string }>).map((l) => l.user_id)),
  ];
  const people = new Map<string, string>();
  if (userIds.length > 0) {
    const { data } = await db.from('users').select('id, name, email').in('id', userIds);
    for (const p of data ?? []) {
      people.set(p.id as string, (p.name as string | null) ?? (p.email as string));
    }
  }

  // The directory, for the "link a number" picker. Small workspaces only need
  // one page of it, and a bigger one gets a search box rather than a full dump.
  const { data: directory } = await db
    .from('users')
    .select('id, name, email')
    .order('name', { ascending: true })
    .limit(500);

  // Numbers that wrote to the line and were turned away.
  //
  // `recordUnknownSender` files every refusal in `security_events`, with the
  // number already normalised. That makes this the one list in the product that
  // knows a person's real WhatsApp number without anybody typing it: they write
  // "hola" from their own phone, it lands here, and linking it becomes a click
  // on a value WhatsApp itself supplied.
  //
  // The stored message preview is NOT read back. A refusal row is evidence that
  // somebody wrote, and this screen has no business republishing a stranger's
  // words to whoever opens Integrations.
  //
  // ADMINS ONLY, because the list is other people's phone numbers — including
  // strangers who found the line. Only an admin can act on it (linking is an
  // authorisation and `/api/whatsapp/links` refuses everybody else), so sending
  // it to anybody else would be handing out numbers for no purpose.
  const linkedPhones = new Set(
    ((linkRows ?? []) as Array<{ phone_e164: string }>).map((l) => l.phone_e164),
  );
  const { data: refusals } = isAdmin
    ? await db
        .from('security_events')
        .select('signals, created_at')
        .eq('tool_id', 'whatsapp.inbound')
        .eq('decision', 'block')
        .order('created_at', { ascending: false })
        .limit(200)
    : { data: [] };

  const unlinked = new Map<string, { phone: string; attempts: number; lastAt: string }>();
  for (const row of (refusals ?? []) as Array<{ signals: unknown; created_at: string }>) {
    const signals = row.signals;
    if (!signals || typeof signals !== 'object' || Array.isArray(signals)) continue;
    const phone = (signals as { phone?: unknown }).phone;
    if (typeof phone !== 'string' || !phone) continue;
    if (linkedPhones.has(phone)) continue;
    const seen = unlinked.get(phone);
    if (seen) seen.attempts += 1;
    else unlinked.set(phone, { phone, attempts: 1, lastAt: row.created_at });
  }

  const myLink = ((linkRows ?? []) as Array<{ phone_e164: string; user_id: string }>).find(
    (l) => l.user_id === session.id,
  );

  return NextResponse.json({
    isAdmin,
    connection: {
      status: (connection?.status as string | null) ?? 'disconnected',
      bridgeAlive,
      phoneNumber: (connection?.phone_number as string | null) ?? null,
      qr: qrFresh ? (connection?.pairing_qr as string) : null,
      lastConnectedAt: (connection?.last_connected_at as string | null) ?? null,
      lastSeenAt: (connection?.last_seen_at as string | null) ?? null,
      lastError: (connection?.last_error as string | null) ?? null,
      dmEnabled: connection?.dm_enabled !== false,
    },
    groups: (
      (groupRows ?? []) as Array<{
        id: string;
        jid: string;
        subject: string | null;
        participant_count: number | null;
        archive_enabled: boolean;
        space_id: string | null;
        enabled_at: string | null;
        archive_from: string | null;
        last_message_at: string | null;
        last_ingested_at: string | null;
        reply_enabled: boolean;
        reply_scope: string;
        reply_space_id: string | null;
        reply_enabled_at: string | null;
        reply_limit_per_hour: number;
      }>
    ).map((g) => ({
      id: g.id,
      jid: g.jid,
      subject: g.subject,
      participants: g.participant_count,
      archiving: g.archive_enabled,
      spaceId: g.space_id,
      spaceName: g.space_id ? (spaceNames.get(g.space_id) ?? null) : null,
      archivingSince: g.archive_from ?? g.enabled_at,
      lastMessageAt: g.last_message_at,
      lastIngestedAt: g.last_ingested_at,
      // Answering is a different permission from archiving and is reported as
      // one. The screen has to be able to say, per group and without anybody
      // guessing, whether Cortex can speak there and what it may reach for.
      replying: g.reply_enabled,
      replyScope: isGroupReplyScope(g.reply_scope) ? g.reply_scope : 'plain',
      replySpaceId: g.reply_space_id,
      replySpaceName: g.reply_space_id ? (spaceNames.get(g.reply_space_id) ?? null) : null,
      replyingSince: g.reply_enabled_at,
      replyLimitPerHour: g.reply_limit_per_hour,
    })),
    // Only the spaces this person may actually write to: offering a destination
    // that will be refused a second later is a worse experience than not
    // offering it, and the refusal is enforced again at write time regardless.
    spaces: spaces
      .filter((s) => (s.kind === 'global' ? isAdmin : s.ownerId === session.id))
      .map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
    // Separate list, because the two settings accept different things: a group
    // may be ARCHIVED into a personal space (it is one person choosing to keep
    // a record) but may only ever CITE a company-wide one, since a personal
    // space is private notes and the room contains outsiders.
    citableSpaces: spaces
      .filter((s) => s.kind === 'global')
      .map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
    links: (
      (linkRows ?? []) as Array<{
        phone_e164: string;
        user_id: string;
        display_name: string | null;
        last_seen_at: string | null;
      }>
    ).map((l) => ({
      phone: l.phone_e164,
      userId: l.user_id,
      personName: people.get(l.user_id) ?? l.display_name ?? 'Alguien que ya no está',
      lastSeenAt: l.last_seen_at,
    })),
    people: ((directory ?? []) as Array<{ id: string; name: string | null; email: string }>).map(
      (p) => ({ id: p.id, name: p.name ?? p.email, email: p.email }),
    ),
    // Who is reading, and whether Cortex would answer them today.
    me: {
      id: session.id,
      name: session.name ?? session.email,
      phone: myLink?.phone_e164 ?? null,
    },
    // Newest first, capped: this is an offer to link, not a log. The security
    // page is where the full history of refusals is read.
    unlinkedNumbers: [...unlinked.values()].slice(0, 8),
  });
}
