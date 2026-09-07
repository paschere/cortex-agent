import 'server-only';
import {
  type GlobalNotificationView,
  NOTIFICATION_KINDS,
  NOTIFICATION_TONES,
  type NotificationKind,
  type NotificationTone,
} from '@/lib/notifications-shape';
import type { Pool } from 'pg';

const KNOWN_KINDS = new Set<string>(NOTIFICATION_KINDS);
const KNOWN_TONES = new Set<string>(NOTIFICATION_TONES);

interface GlobalRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  organization_name: string;
  organization_kind: string | null;
  kind: string;
  tone: string;
  title: string;
  body: string | null;
  href: string | null;
  occurrences: number | null;
  occurred_at: Date | string;
  read_at: Date | string | null;
}

/** Minimal shape shared by pg.Pool and a deterministic test double. */
export interface NotificationQuery {
  query<T extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

const MEMBERSHIP_JOIN = `
  from public.ba_member membership
  join public.ba_user account on account.id = membership."userId"
  join public.ba_organization organization on organization.id = membership."organizationId"
  join public.users directory
    on directory.organization_id = organization.id
   and lower(directory.email) = lower(account.email)`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toView(row: GlobalRow): GlobalNotificationView {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationKind: row.organization_kind === 'personal' ? 'personal' : 'company',
    kind: (KNOWN_KINDS.has(row.kind) ? row.kind : 'routine_finished') as NotificationKind,
    tone: (KNOWN_TONES.has(row.tone) ? row.tone : 'info') as NotificationTone,
    title: row.title,
    body: row.body,
    href: row.href,
    occurrences: row.occurrences ?? 1,
    occurredAt: iso(row.occurred_at),
    readAt: row.read_at ? iso(row.read_at) : null,
  };
}

/**
 * Bandeja de la identidad BA en todos sus espacios actuales.
 *
 * La relación de membresía se consulta en la misma sentencia que devuelve el
 * contenido. Un organizationId del navegador jamás participa en esta lectura.
 */
export async function listGlobalNotifications(
  db: NotificationQuery,
  baUserId: string,
  limit = 160,
): Promise<GlobalNotificationView[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const { rows } = await db.query<GlobalRow>(
    `select notification.id,
            notification.organization_id,
            organization.name as organization_name,
            organization.kind as organization_kind,
            notification.kind, notification.tone, notification.title,
            notification.body, notification.href, notification.occurrences,
            notification.occurred_at, notification.read_at
       ${MEMBERSHIP_JOIN}
       join public.notifications notification
         on notification.organization_id = organization.id
        and notification.user_id = directory.id
      where membership."userId" = $1
      order by notification.occurred_at desc
      limit $2`,
    [baUserId, safeLimit],
  );
  return rows.map(toView);
}

export async function countGlobalUnread(db: NotificationQuery, baUserId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `select count(*)::text as count
       ${MEMBERSHIP_JOIN}
       join public.notifications notification
         on notification.organization_id = organization.id
        and notification.user_id = directory.id
      where membership."userId" = $1 and notification.read_at is null`,
    [baUserId],
  );
  return Number(rows[0]?.count ?? 0);
}

export interface NotificationTarget {
  id: string;
  organizationId: string;
}

/** Marca únicamente pares aviso+espacio que todavía pertenecen a la identidad. */
export async function markGlobalRead(
  db: NotificationQuery,
  baUserId: string,
  targets: NotificationTarget[],
): Promise<number> {
  if (targets.length === 0) return 0;
  const ids = targets.map((target) => target.id);
  const organizations = targets.map((target) => target.organizationId);
  const result = await db.query<{ id: string }>(
    `update public.notifications notification
        set read_at = now()
       from unnest($2::uuid[], $3::text[]) as target(id, organization_id),
            public.ba_member membership,
            public.ba_user account,
            public.users directory
      where membership."userId" = $1
        and membership."organizationId" = target.organization_id
        and account.id = membership."userId"
        and directory.organization_id = membership."organizationId"
        and lower(directory.email) = lower(account.email)
        and notification.id = target.id
        and notification.organization_id = target.organization_id
        and notification.user_id = directory.id
        and notification.read_at is null
      returning notification.id`,
    [baUserId, ids, organizations],
  );
  return result.rowCount ?? result.rows.length;
}

export async function markAllGlobalRead(db: NotificationQuery, baUserId: string): Promise<number> {
  const result = await db.query<{ id: string }>(
    `update public.notifications notification
        set read_at = now()
       from public.ba_member membership
       join public.ba_user account on account.id = membership."userId"
       join public.users directory
         on directory.organization_id = membership."organizationId"
        and lower(directory.email) = lower(account.email)
      where membership."userId" = $1
        and notification.organization_id = membership."organizationId"
        and notification.user_id = directory.id
        and notification.read_at is null
      returning notification.id`,
    [baUserId],
  );
  return result.rowCount ?? result.rows.length;
}

export function notificationSnapshotKey(items: GlobalNotificationView[]): string {
  return items
    .map(
      (item) =>
        `${item.organizationId}:${item.id}:${item.readAt ?? ''}:${item.occurrences}:${item.occurredAt}`,
    )
    .join('|');
}

export type { Pool };
