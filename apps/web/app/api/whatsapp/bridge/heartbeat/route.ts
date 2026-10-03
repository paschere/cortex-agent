import { getOrgScopedClient } from '@/lib/supabase/service';
import { authorizeBridgeSession } from '@/lib/whatsapp/bridge';
import { pairingReply } from '@/lib/whatsapp/pairing';
import { PHONE_TAKEN_ERROR } from '@/lib/whatsapp/wipe';
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
 *
 * SO DOES «DESVINCULAR», AND ONE NUMBER PER WORKSPACE (migration 0189). With
 * one bridge serving many workspaces, the same phone could be paired from two
 * of them. When a session reports `connected` with a number that is already
 * another workspace's, nothing is stored, nothing is handed to it (no groups,
 * no outbox, DMs off) and the reply says `unlink: 'phone_taken'`: the bridge
 * logs that device out and wipes it. The workspace that had the number first
 * keeps it. `unlink: 'requested'` is an admin's «Desvincular».
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
  const auth = await authorizeBridgeSession(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as HeartbeatBody;
  const db = getOrgScopedClient(auth.caller.organizationId);
  const now = new Date();

  const status: Status = STATUSES.has(body.status as Status)
    ? (body.status as Status)
    : 'disconnected';
  const reportedPhone =
    typeof body.phoneNumber === 'string' && /^\d{8,15}$/.test(body.phoneNumber)
      ? body.phoneNumber
      : null;

  // Un número, una empresa. Comprobado antes de escribir nada: una sesión con
  // el número de otra empresa no deja rastro aquí salvo la explicación.
  if (status === 'connected' && reportedPhone) {
    const taken = await db.rpc('whatsapp_phone_taken', { p_phone: reportedPhone });
    if (taken.error) {
      logger.warn(`whatsapp-bridge: could not check the number — ${taken.error.message}`);
    } else if (taken.data === true) {
      return refusePhone(db, now);
    }
  }

  const row: Record<string, unknown> = {
    status,
    last_seen_at: now.toISOString(),
    updated_at: now.toISOString(),
    last_error: body.error ?? null,
  };
  if (body.phoneNumber !== undefined) row.phone_number = reportedPhone;
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

  const written = await db.from('whatsapp_sessions').upsert(row, { onConflict: 'organization_id' });
  // 23505 on the phone index: another workspace connected the same number
  // between the check above and this write. Same answer as the check.
  if (written.error?.code === '23505') return refusePhone(db, now);
  if (written.error) {
    logger.warn(`whatsapp-bridge: could not store the heartbeat — ${written.error.message}`);
  }

  const sessionRead = await db
    .from('whatsapp_sessions')
    .select('dm_enabled, pairing_requested_at, pairing_phone, unlink_requested_at')
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
    // «Desvincular» (0189): the bridge logs the device out and wipes the session.
    unlink: session?.unlink_requested_at ? 'requested' : null,
  });
}

/**
 * The number that just connected is another workspace's. Nothing it reported
 * is kept; the reply hands it nothing to read or say and tells it to leave.
 */
async function refusePhone(
  db: ReturnType<typeof getOrgScopedClient>,
  now: Date,
): Promise<NextResponse> {
  logger.warn('whatsapp-bridge: a session connected with a number another workspace holds');
  const saved = await db.from('whatsapp_sessions').upsert(
    {
      status: 'logged_out',
      last_seen_at: now.toISOString(),
      updated_at: now.toISOString(),
      last_error: PHONE_TAKEN_ERROR,
      pairing_requested_at: null,
      pairing_phone: null,
      pairing_code: null,
      pairing_code_expires_at: null,
      pairing_qr: null,
      pairing_qr_expires_at: null,
    },
    { onConflict: 'organization_id' },
  );
  if (saved.error) {
    logger.warn(`whatsapp-bridge: could not record the refusal — ${saved.error.message}`);
  }
  return NextResponse.json({
    ok: true,
    archiveGroups: [],
    replyGroups: [],
    dmEnabled: false,
    outbox: [],
    pairingRequested: false,
    pairingPhone: null,
    unlink: 'phone_taken',
  });
}
