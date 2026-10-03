import 'server-only';
import {
  type AccountingConnectionRow,
  accountLabelOf,
  getAccountingProvider,
  listAccountingConnections,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AccountingRaw,
  BankRaw,
  DriveRaw,
  FeedSourceRaw,
  InboxRaw,
  IntegrationRaw,
  SourcesSnapshot,
  TableSyncRaw,
  WhatsappRaw,
} from './overview';

/**
 * LAS LECTURAS DE «DATOS Y CONEXIONES».
 *
 * Todas con el cliente de la empresa (getOrgScopedClient en la página) y cada
 * una aislada: si una falla devuelve `null`, la página dice qué no pudo leer y
 * las demás tarjetas salen igual. Una lectura caída nunca se pinta como «no
 * tienes nada conectado» — eso haría que alguien conecte dos veces lo mismo.
 */

type Rel<T> = T | T[] | null;
const one = <T>(rel: Rel<T>): T | null => (Array.isArray(rel) ? (rel[0] ?? null) : rel);

async function safe<T>(run: () => PromiseLike<T | null>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

async function integrations(db: SupabaseClient): Promise<IntegrationRaw[] | null> {
  const { data, error } = await db
    .from('integrations')
    .select('provider, scopes, updated_at, user_id')
    .limit(1000);
  if (error) return null;
  return (data ?? []) as IntegrationRaw[];
}

async function accounting(db: SupabaseClient): Promise<AccountingRaw[] | null> {
  const rows: AccountingConnectionRow[] = await listAccountingConnections(db);
  return rows.map((c) => ({
    id: c.id,
    provider: c.provider,
    providerName: getAccountingProvider(c.provider)?.name ?? c.provider,
    account_label: c.account_label || null,
    entities: c.entities,
    enabled: c.enabled,
    interval_minutes: c.interval_minutes,
    last_run_at: c.last_run_at,
    last_status: c.last_status,
    last_error: c.last_error,
    last_counts: (c.last_counts ?? null) as AccountingRaw['last_counts'],
    created_by: c.created_by,
  }));
}

type TrackerRel = Rel<{ name: string | null; slug: string | null }>;

async function drive(db: SupabaseClient): Promise<DriveRaw[] | null> {
  const { data, error } = await db
    .from('drive_folder_syncs')
    .select(
      'id, folder_name, enabled, interval_minutes, last_run_at, last_status, last_error, last_files, last_inserted, last_updated, last_needs_review, last_failed, created_by, trackers(name, slug)',
    )
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return null;
  return (
    (data ?? []) as Array<
      Omit<DriveRaw, 'tracker_name' | 'tracker_slug'> & { trackers: TrackerRel }
    >
  ).map(({ trackers, ...row }) => ({
    ...row,
    tracker_name: one(trackers)?.name ?? null,
    tracker_slug: one(trackers)?.slug ?? null,
  }));
}

async function tableSyncs(db: SupabaseClient): Promise<TableSyncRaw[] | null> {
  const { data, error } = await db
    .from('tracker_syncs')
    .select(
      'id, enabled, interval_minutes, last_run_at, last_status, last_error, last_inserted, last_updated, created_by, trackers(name, slug), feed_sources(name, kind)',
    )
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return null;
  type Row = Omit<TableSyncRaw, 'tracker_name' | 'tracker_slug' | 'source_name' | 'source_kind'> & {
    trackers: TrackerRel;
    feed_sources: Rel<{ name: string | null; kind: string | null }>;
  };
  return ((data ?? []) as Row[]).map(({ trackers, feed_sources, ...row }) => ({
    ...row,
    tracker_name: one(trackers)?.name ?? null,
    tracker_slug: one(trackers)?.slug ?? null,
    source_name: one(feed_sources)?.name ?? null,
    source_kind: one(feed_sources)?.kind ?? null,
  }));
}

async function feedSources(db: SupabaseClient, userId: string): Promise<FeedSourceRaw[] | null> {
  const { data, error } = await db
    .from('feed_sources')
    .select('id, kind, name, enabled, status, last_checked_at, error')
    .eq('actor_id', userId)
    .in('kind', ['url', 'google_sheet', 'api', 'combined'])
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) return null;
  return (data ?? []) as FeedSourceRaw[];
}

/** Una tarjeta por cuenta de banco: cuántos movimientos, cuántos sin factura, el último extracto. */
async function bank(db: SupabaseClient): Promise<BankRaw[] | null> {
  const { data, error } = await db
    .from('payment_reports')
    .select('source_system, payment_id, created_at, created_by')
    .eq('source_kind', 'system')
    .like('source_system', 'extracto %')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) return null;
  const byAccount = new Map<string, BankRaw>();
  for (const r of (data ?? []) as Array<{
    source_system: string | null;
    payment_id: string | null;
    created_at: string;
    created_by: string | null;
  }>) {
    const account = accountLabelOf(r.source_system);
    if (!account) continue;
    const row = byAccount.get(account) ?? {
      account,
      movements: 0,
      unmatched: 0,
      // Ordenado de lo más nuevo a lo más viejo: la primera fila es el último extracto.
      lastImportAt: r.created_at,
      lastBy: r.created_by,
    };
    row.movements += 1;
    if (!r.payment_id) row.unmatched += 1;
    byAccount.set(account, row);
  }
  return [...byAccount.values()];
}

async function whatsapp(db: SupabaseClient, userId: string): Promise<WhatsappRaw | null> {
  const [session, groups, links, mine] = await Promise.all([
    db.from('whatsapp_sessions').select('status, last_seen_at').maybeSingle(),
    db
      .from('whatsapp_groups')
      .select('id', { count: 'exact', head: true })
      .or('archive_enabled.eq.true,reply_enabled.eq.true'),
    db.from('whatsapp_links').select('phone_e164', { count: 'exact', head: true }),
    db.from('whatsapp_links').select('phone_e164').eq('user_id', userId).maybeSingle(),
  ]);
  if (session.error) return null;
  return {
    status: (session.data?.status as string | null) ?? 'disconnected',
    lastSeenAt: (session.data?.last_seen_at as string | null) ?? null,
    // Los conteos son decoración de la tarjeta: si fallan, cero, no una tarjeta rota.
    groups: groups.error ? 0 : (groups.count ?? 0),
    links: links.error ? 0 : (links.count ?? 0),
    mineLinked: !mine.error && !!mine.data,
  };
}

async function inbox(db: SupabaseClient, userId: string): Promise<InboxRaw | null> {
  const { data, error, count } = await db
    .from('chat_attachments')
    .select('created_at', { count: 'exact' })
    .eq('created_by', userId)
    .not('feed_kind', 'is', null)
    .gt('purge_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return null;
  const rows = (data ?? []) as Array<{ created_at: string }>;
  return { count: count ?? rows.length, latestAt: rows[0]?.created_at ?? null };
}

async function people(db: SupabaseClient, ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const { data, error } = await db.from('users').select('id, name, email').in('id', unique);
  // Un nombre que no se pudo leer se dice «alguien del equipo»: no rompe la tarjeta.
  if (error) return {};
  const out: Record<string, string> = {};
  for (const u of (data ?? []) as Array<{ id: string; name: string | null; email: string }>) {
    out[u.id] = u.name?.trim() || u.email.split('@')[0] || 'alguien del equipo';
  }
  return out;
}

export async function readSourcesSnapshot(
  db: SupabaseClient,
  opts: { userId: string; canManage: boolean; hubspotWorkspace: boolean },
): Promise<SourcesSnapshot> {
  const [ints, acc, drv, syncs, feeds, bk, wa, box] = await Promise.all([
    safe(() => integrations(db)),
    safe(() => accounting(db)),
    safe(() => drive(db)),
    safe(() => tableSyncs(db)),
    safe(() => feedSources(db, opts.userId)),
    safe(() => bank(db)),
    safe(() => whatsapp(db, opts.userId)),
    safe(() => inbox(db, opts.userId)),
  ]);
  const owners = [
    ...(acc ?? []).map((a) => a.created_by),
    ...(drv ?? []).map((d) => d.created_by),
    ...(syncs ?? []).map((s) => s.created_by),
    ...(bk ?? []).map((b) => b.lastBy ?? ''),
  ].filter((id) => id && id !== opts.userId);
  return {
    userId: opts.userId,
    canManage: opts.canManage,
    hubspotWorkspace: opts.hubspotWorkspace,
    integrations: ints,
    accounting: acc,
    drive: drv,
    tableSyncs: syncs,
    feedSources: feeds,
    bank: bk,
    whatsapp: wa,
    inbox: box,
    people: await people(db, owners),
  };
}
