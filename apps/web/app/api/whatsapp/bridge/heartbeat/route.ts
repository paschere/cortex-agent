import { getOrgScopedClient } from '@/lib/supabase/service';
import { authenticateBridge } from '@/lib/whatsapp/bridge';
import { pairingReply } from '@/lib/whatsapp/pairing';
import { type OutboxItem, claimOutbox } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
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
 *
 * PAIRING TRAVELS HERE TOO (migration 0169). An unpaired bridge stays off
 * WhatsApp until this reply says `pairingRequested` — an admin asked on the
 * Cortex screen within the last three minutes — and, for the code flow,
 * `pairingPhone`. The bridge reports back the QR or the 8-character code.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Status = 'disconnected' | 'waiting' | 'pairing' | 'connected' | 'logged_out';

interface HeartbeatBody {
  status?: Status;
  phoneNumber?: string | null;
  /** `data:image/png;base64,…`, already rendered by the bridge. */
  qr?: string | null;
  /**
   * The 8-character code for «Vincular con el número de teléfono», while the
   * socket that asked for it is alive. `null` means it is gone; absent means an
   * older bridge that knows nothing about codes.
   */
  pairingCode?: string | null;
  error?: string | null;
}

const STATUSES = new Set<Status>(['disconnected', 'waiting', 'pairing', 'connected', 'logged_out']);

/** WhatsApp rotates the pairing code roughly every 20 seconds. */
const QR_TTL_MS = 60_000;

/**
 * The bridge re-reports a live code on every pairing heartbeat (≤ 15 s), so a
 * short TTL is enough to keep it on screen and makes a code whose socket died
 * without saying so disappear on its own.
 */
const CODE_TTL_MS = 60_000;

/** Baileys' codes are 8 Crockford base-32 characters. */
const PAIRING_CODE = /^[A-Z0-9]{8}$/;

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
    // panel showing a dead code to somebody who is already connected — and the
    // request is fulfilled, so it must not reopen a registration socket later.
    row.pairing_qr = null;
    row.pairing_qr_expires_at = null;
    row.pairing_code = null;
    row.pairing_code_expires_at = null;
    row.pairing_requested_at = null;
    row.pairing_phone = null;
  } else {
    if (body.qr) {
      row.pairing_qr = body.qr;
      row.pairing_qr_expires_at = new Date(now.getTime() + QR_TTL_MS).toISOString();
    }
    if (body.pairingCode !== undefined) {
      const code =
        typeof body.pairingCode === 'string' ? body.pairingCode.trim().toUpperCase() : '';
      const valid = PAIRING_CODE.test(code);
      row.pairing_code = valid ? code : null;
      row.pairing_code_expires_at = valid
        ? new Date(now.getTime() + CODE_TTL_MS).toISOString()
        : null;
    }
  }

  await db.from('whatsapp_sessions').upsert(row, { onConflict: 'organization_id' });

  const sessionRead = await db
    .from('whatsapp_sessions')
    .select('dm_enabled, pairing_requested_at, pairing_phone')
    .maybeSingle();
  // Checked by hand rather than thrown: this reply also carries the archive
  // allow-list, and a missing pairing column (a migration behind) must not stop
  // a connected bridge from learning which groups to read. Worst case it reads
  // as "nobody asked to pair", which is the safe answer.
  const session = sessionRead.error ? null : sessionRead.data;
  if (sessionRead.error) {
    logger.warn(`whatsapp-bridge: could not read the session row — ${sessionRead.error.message}`);
  }

  // Both lists in one read, and they are genuinely different lists. Since
  // migration 0072 archiving a group and answering in it are separate
  // permissions: a client group is often archived and never spoken in, and an
  // internal coordination group is often the reverse.
  const { data: groups } = await db
    .from('whatsapp_groups')
    .select('jid, archive_from, archive_enabled, reply_enabled')
    .or('archive_enabled.eq.true,reply_enabled.eq.true');

  const rows = (groups ?? []) as Array<{
    jid: string;
    archive_from: string | null;
    archive_enabled: boolean;
    reply_enabled: boolean;
  }>;

  // ATENCIÓN A CLIENTES (0185). Dos cosas viajan en este latido:
  //   * si está encendida, el puente tiene que reenviar mensajes directos aunque
  //     el equipo tenga apagado «hablarle a Cortex» (la ruta dm decide cuál es
  //     cuál);
  //   * las respuestas que una persona escribió desde Cortex, para que el
  //     puente las mande COMO RESPUESTA en esa conversación. Sólo existen
  //     dentro de una conversación que el cliente abrió y en la que escribió en
  //     las últimas 24 h (queueHumanReply lo exige), así que el número sigue
  //     sin escribir primero.
  // Leído a mano y sin tumbar el latido: una migración atrasada no puede dejar
  // a un puente conectado sin su lista de grupos.
  let customerEnabled = false;
  let outbox: OutboxItem[] = [];
  const customer = await db.from('wa_customer_settings').select('enabled').maybeSingle();
  if (customer.error) {
    logger.warn(`whatsapp-bridge: no pude leer la atención a clientes — ${customer.error.message}`);
  } else {
    customerEnabled = customer.data?.enabled === true;
    if (status === 'connected') {
      outbox = await claimOutbox(db, { now }).catch((err: Error) => {
        logger.warn(`whatsapp-bridge: no pude armar la cola de respuestas — ${err.message}`);
        return [];
      });
    }
  }

  return NextResponse.json({
    ok: true,
    /** The only groups the bridge may forward messages from, for archiving. */
    archiveGroups: rows
      .filter((g) => g.archive_enabled)
      .map((g) => ({ jid: g.jid, archiveFrom: g.archive_from })),
    /**
     * The only groups the bridge may ever speak in — and even there, only when
     * Cortex is actually mentioned. The bridge keeps a small in-memory buffer of
     * recent messages for these so a mention arrives with context; nothing about
     * them is written down unless the group is ALSO on the archive list.
     */
    replyGroups: rows.filter((g) => g.reply_enabled).map((g) => g.jid),
    dmEnabled: session?.dm_enabled !== false || customerEnabled,
    outbox,
    ...pairingReply(session, now),
  });
}
