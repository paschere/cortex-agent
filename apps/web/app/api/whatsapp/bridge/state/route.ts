import { getOrgScopedClient } from '@/lib/supabase/service';
import { authenticateBridge } from '@/lib/whatsapp/bridge';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * The Baileys session, kept in Postgres instead of on disk.
 *
 * THE PROBLEM THIS SOLVES, BECAUSE IT IS THE ONE THAT KILLS THESE PROJECTS.
 * Baileys ships `useMultiFileAuthState`, which writes a directory of JSON
 * files. On Railway the container filesystem is ephemeral — a deploy, a crash,
 * a restart and the directory is gone. With a disk-backed session that means
 * somebody has to open WhatsApp on the dedicated phone and scan a QR code every
 * single time the service ships. It is the classic Baileys frustration, it is
 * why most self-hosted bridges are abandoned within a month, and it is fixed
 * here rather than documented as a caveat.
 *
 * A mounted volume would also survive a deploy, and is the wrong answer: it
 * pins the service to one region and one instance, it is invisible to anything
 * that can read the database, and it is a second kind of state to back up. The
 * session is a credential; credentials live where the rest of them live.
 *
 * TWO HALVES, TWO SHAPES. `creds` is one small object rewritten occasionally —
 * a jsonb column. The signal key store is thousands of small records addressed
 * by (type, id) and written on almost every message — a key-value table, so a
 * new sender key does not rewrite the whole store.
 *
 * GET is the boot path: the bridge reads everything once and keeps it in
 * memory, because Baileys asks for keys synchronously and inline over the
 * message path. POST is the write-through.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface KeyRow {
  key_type: string;
  key_id: string;
  value: unknown;
}

/** Boot: the paired identity and every signal key, in one read. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = authenticateBridge(req);
  if (!auth.ok) return auth.response;

  const db = getOrgScopedClient(auth.caller.organizationId);

  const { data: session } = await db
    .from('whatsapp_sessions')
    .select('creds, status, phone_number')
    .maybeSingle();

  const keys: Record<string, Record<string, unknown>> = {};
  // Paged rather than one unbounded select: an account in many groups
  // accumulates thousands of sender keys, and PostgREST caps a response anyway.
  const PAGE = 1000;
  for (let page = 0; ; page++) {
    const { data, error } = await db
      .from('whatsapp_session_keys')
      .select('key_type, key_id, value')
      .order('key_type', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) break;
    const rows = (data ?? []) as unknown as KeyRow[];
    for (const row of rows) {
      keys[row.key_type] ??= {};
      (keys[row.key_type] as Record<string, unknown>)[row.key_id] = row.value;
    }
    if (rows.length < PAGE) break;
  }

  return NextResponse.json({
    creds: session?.creds ?? null,
    status: session?.status ?? 'disconnected',
    phoneNumber: session?.phone_number ?? null,
    keys,
  });
}

interface StateWrite {
  /** The whole `AuthenticationCreds` object, BufferJSON-encoded. */
  creds?: unknown;
  /** Keys to write: `{ 'pre-key': { '3': {…} }, 'session': { … } }`. */
  set?: Record<string, Record<string, unknown | null>>;
}

/**
 * Write-through. `set` with a null value deletes — that is Baileys' own
 * convention for `keys.set`, and translating it here rather than at the call
 * site keeps the bridge's auth-state adapter a straight pass-through.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = authenticateBridge(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as StateWrite;
  const db = getOrgScopedClient(auth.caller.organizationId);
  const now = new Date().toISOString();

  if (body.creds !== undefined) {
    const { error } = await db
      .from('whatsapp_sessions')
      .upsert(
        { creds: body.creds, updated_at: now, last_seen_at: now },
        { onConflict: 'organization_id' },
      );
    if (error) {
      logger.error(`whatsapp-bridge: could not store creds — ${error.message}`);
      return NextResponse.json({ error: 'Could not store the session' }, { status: 500 });
    }
  }

  const upserts: Array<{ key_type: string; key_id: string; value: unknown; updated_at: string }> =
    [];
  const deletes: Array<{ type: string; id: string }> = [];

  for (const [keyType, entries] of Object.entries(body.set ?? {})) {
    for (const [keyId, value] of Object.entries(entries ?? {})) {
      if (value === null || value === undefined) deletes.push({ type: keyType, id: keyId });
      else upserts.push({ key_type: keyType, key_id: keyId, value, updated_at: now });
    }
  }

  if (upserts.length > 0) {
    for (let i = 0; i < upserts.length; i += 250) {
      const { error } = await db.from('whatsapp_session_keys').upsert(upserts.slice(i, i + 250), {
        onConflict: 'organization_id,key_type,key_id',
      });
      if (error) {
        logger.error(`whatsapp-bridge: could not store session keys — ${error.message}`);
        return NextResponse.json({ error: 'Could not store the session keys' }, { status: 500 });
      }
    }
  }

  for (const key of deletes) {
    await db
      .from('whatsapp_session_keys')
      .delete()
      .eq('key_type', key.type)
      .eq('key_id', key.id)
      .then(undefined, () => undefined);
  }

  return NextResponse.json({ ok: true, wrote: upserts.length, removed: deletes.length });
}

/**
 * Forget everything.
 *
 * Called when WhatsApp says `loggedOut`: the credentials are dead and reusing
 * them produces an endless reconnect loop against a device that no longer
 * exists. Wiping them is what makes the next boot show a QR code instead of
 * retrying forever — see the reconnect policy in `services/whatsapp/src/socket.ts`.
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const auth = authenticateBridge(req);
  if (!auth.ok) return auth.response;

  const db = getOrgScopedClient(auth.caller.organizationId);
  const now = new Date().toISOString();

  await db.from('whatsapp_session_keys').delete().neq('key_type', '__none__');
  await db.from('whatsapp_sessions').upsert(
    {
      creds: null,
      status: 'logged_out',
      pairing_qr: null,
      pairing_qr_expires_at: null,
      last_error:
        'WhatsApp cerró la sesión de este dispositivo. Hay que volver a emparejar escaneando el código QR.',
      updated_at: now,
    },
    { onConflict: 'organization_id' },
  );

  // Groups and links are deliberately left alone. Re-pairing the same number
  // should not mean choosing every archived group again from scratch — the
  // decisions about what is archived and where were made by people and are not
  // the connection's to throw away.
  logger.warn('whatsapp-bridge: session wiped after a logout; re-pairing required');
  return NextResponse.json({ ok: true });
}
