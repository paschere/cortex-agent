import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { ActiveOrganization, OrgRole } from '@cortex/core';
import { pool } from './auth';

/**
 * Workspace resolution for the multi-tenant surface.
 *
 * Every signed-in account must act inside exactly one workspace at a time.
 * Rather than creating that workspace in better-auth's user-create hook, it is
 * created lazily on the first authenticated request. That ordering matters:
 * a user who signs up in order to ACCEPT an invitation already belongs to the
 * inviting workspace by the time they reach the app, so no stray "personal"
 * workspace is minted for them.
 */

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'workspace';
}

/** A human name for a first workspace: "Ana's workspace", else the email local part. */
function defaultWorkspaceName(name: string | null, email: string): string {
  const who = (name ?? '').trim() || (email.split('@')[0] ?? 'My');
  return `${who}'s workspace`;
}

interface MembershipRow {
  id: string;
  name: string;
  slug: string | null;
  role: string;
}

function toActiveOrganization(row: MembershipRow): ActiveOrganization {
  const role = row.role as OrgRole;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    // Anything unrecognised degrades to the least privilege, never the most.
    role: role === 'owner' || role === 'admin' ? role : 'member',
  };
}

/** The workspace named by the session, but only if the user still belongs to it. */
async function findMembership(
  baUserId: string,
  organizationId: string,
): Promise<ActiveOrganization | null> {
  const { rows } = await pool.query<MembershipRow>(
    `select o.id, o.name, o.slug, m.role
       from public.ba_member m
       join public.ba_organization o on o.id = m."organizationId"
      where m."userId" = $1 and m."organizationId" = $2`,
    [baUserId, organizationId],
  );
  return rows[0] ? toActiveOrganization(rows[0]) : null;
}

/** Oldest workspace the user belongs to — the stable default when none is active. */
async function findFirstMembership(baUserId: string): Promise<ActiveOrganization | null> {
  const { rows } = await pool.query<MembershipRow>(
    `select o.id, o.name, o.slug, m.role
       from public.ba_member m
       join public.ba_organization o on o.id = m."organizationId"
      where m."userId" = $1
      order by m."createdAt" asc
      limit 1`,
    [baUserId],
  );
  return rows[0] ? toActiveOrganization(rows[0]) : null;
}

/**
 * The workspace id an account's first workspace will always get.
 *
 * Derived from the user id rather than random, and that is the whole point:
 * a fresh account typically fires several requests at once (the page, its data
 * fetches, a prefetch), every one of them finds no membership, and every one of
 * them tries to provision. With random ids each of those wins its own INSERT
 * and the account ends up owning several identical workspaces — observed, not
 * hypothetical. A derived id turns the race into a single row: the first writer
 * creates it, the rest hit `on conflict do nothing` and adopt it.
 */
function firstWorkspaceId(baUserId: string): string {
  const h = createHash('sha256').update(`cortex:workspace:${baUserId}`).digest('hex');
  // Shape the digest into a v4-looking UUID so the column keeps a uniform format.
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    ((Number.parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

/**
 * Create the account's first workspace, with the user as its owner.
 *
 * Slugs are unique across ALL organizations, so two different people named Ana
 * collide. The suffix that breaks that tie is derived from the user id too —
 * a random one would reintroduce the race this function exists to avoid.
 */
async function createWorkspace(
  baUserId: string,
  name: string | null,
  email: string,
): Promise<ActiveOrganization> {
  const workspaceName = defaultWorkspaceName(name, email);
  const baseSlug = slugify(name ?? email.split('@')[0] ?? 'workspace');
  const orgId = firstWorkspaceId(baUserId);
  const tieBreak = createHash('sha256').update(baUserId).digest('hex');

  for (let attempt = 0; attempt < 4; attempt++) {
    const slug =
      attempt === 0 ? baseSlug : `${baseSlug}-${tieBreak.slice(attempt * 6, attempt * 6 + 6)}`;
    const { rows } = await pool.query<{ id: string; slug: string | null }>(
      `insert into public.ba_organization (id, name, slug, "createdAt")
       values ($1, $2, $3, now())
       on conflict do nothing
       returning id, slug`,
      [orgId, workspaceName, slug],
    );

    if (!rows[0]) {
      // Either this account's row already exists (a concurrent request won), or
      // the slug belongs to someone else. Only the first case is ours to adopt.
      const mine = await pool.query<{ slug: string | null }>(
        `select slug from public.ba_organization where id = $1`,
        [orgId],
      );
      if (!mine.rows[0]) continue; // slug taken by another account — next suffix
      await claimOwnership(orgId, baUserId);
      return { id: orgId, name: workspaceName, slug: mine.rows[0].slug, role: 'owner' };
    }

    await claimOwnership(orgId, baUserId);
    return { id: orgId, name: workspaceName, slug: rows[0].slug, role: 'owner' };
  }

  const existing = await findFirstMembership(baUserId);
  if (existing) return existing;
  throw new Error('could not provision a workspace');
}

/** Idempotent: the unique index on (organizationId, userId) absorbs the retry. */
async function claimOwnership(orgId: string, baUserId: string): Promise<void> {
  await pool.query(
    `insert into public.ba_member (id, "organizationId", "userId", role, "createdAt")
     values ($1, $2, $3, 'owner', now())
     on conflict ("organizationId", "userId") do nothing`,
    [randomUUID(), orgId, baUserId],
  );
}

/**
 * The workspace this request acts in, provisioning one if the account has none.
 *
 * @param activeOrganizationId what the session claims is active — honoured only
 *   when the user is still a member (leaving a workspace must not keep granting
 *   access through a stale session).
 */
export async function resolveActiveOrganization(
  baUserId: string,
  activeOrganizationId: string | null | undefined,
  name: string | null,
  email: string,
): Promise<ActiveOrganization> {
  if (activeOrganizationId) {
    const claimed = await findMembership(baUserId, activeOrganizationId);
    if (claimed) return claimed;
  }

  const resolved =
    (await findFirstMembership(baUserId)) ?? (await createWorkspace(baUserId, name, email));

  // Write the choice back so the next request reads it from the session instead
  // of re-deriving it. Best-effort: a failure here costs a lookup, not access.
  try {
    await pool.query(
      `update public.ba_session set "activeOrganizationId" = $2
        where "userId" = $1 and ("activeOrganizationId" is distinct from $2)`,
      [baUserId, resolved.id],
    );
  } catch (err) {
    console.error('[organization] could not persist active workspace', err);
  }

  return resolved;
}

/** Point the session at another workspace the user belongs to. */
export async function setActiveOrganization(
  baUserId: string,
  organizationId: string,
): Promise<ActiveOrganization | null> {
  const membership = await findMembership(baUserId, organizationId);
  if (!membership) return null;
  await pool.query(`update public.ba_session set "activeOrganizationId" = $2 where "userId" = $1`, [
    baUserId,
    organizationId,
  ]);
  return membership;
}

/** Every workspace the user belongs to — for the workspace switcher. */
export async function listMemberships(baUserId: string): Promise<ActiveOrganization[]> {
  const { rows } = await pool.query<MembershipRow>(
    `select o.id, o.name, o.slug, m.role
       from public.ba_member m
       join public.ba_organization o on o.id = m."organizationId"
      where m."userId" = $1
      order by m."createdAt" asc`,
    [baUserId],
  );
  return rows.map(toActiveOrganization);
}
