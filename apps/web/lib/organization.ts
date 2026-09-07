import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { ActiveOrganization, OrgRole } from '@cortex/core';
import { pool } from './auth';
import { workspaceLanding } from './invite-landing';
import { WORKSPACE_LIMIT } from './workspace-limits';

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
    // biome-ignore lint/suspicious/noMisleadingCharacterClass: Unicode combining-mark range after NFD.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'workspace';
}

interface MembershipRow {
  id: string;
  name: string;
  slug: string | null;
  role: string;
  kind: string | null;
}

function toActiveOrganization(row: MembershipRow): ActiveOrganization {
  const role = row.role as OrgRole;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    // Anything unrecognised degrades to the least privilege, never the most.
    role: role === 'owner' || role === 'admin' ? role : 'member',
    kind: row.kind === 'personal' ? 'personal' : 'company',
  };
}

/** The workspace named by the session, but only if the user still belongs to it. */
async function findMembership(
  baUserId: string,
  organizationId: string,
): Promise<ActiveOrganization | null> {
  const { rows } = await pool.query<MembershipRow>(
    `select o.id, o.name, o.slug, m.role, o.kind
       from public.ba_member m
       join public.ba_organization o on o.id = m."organizationId"
      where m."userId" = $1 and m."organizationId" = $2`,
    [baUserId, organizationId],
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
function personalWorkspaceId(baUserId: string): string {
  return `personal:${baUserId}`;
}

/**
 * Create the account's first workspace, with the user as its owner.
 *
 * Slugs are unique across ALL organizations, so two different people named Ana
 * collide. The suffix that breaks that tie is derived from the user id too —
 * a random one would reintroduce the race this function exists to avoid.
 */
export async function ensurePersonalWorkspace(
  baUserId: string,
  name: string | null,
  email: string,
): Promise<ActiveOrganization> {
  const who = (name ?? '').trim() || (email.split('@')[0] ?? 'Mi');
  const workspaceName = `Espacio personal de ${who}`.slice(0, 120);
  // Derive slug collision suffixes from the identity so concurrent requests
  // converge on the same personal workspace.
  const baseSlug = `personal-${slugify(name || email.split('@')[0] || 'workspace')}`;
  const orgId = personalWorkspaceId(baUserId);
  const tieBreak = createHash('sha256').update(baUserId).digest('hex');

  for (let attempt = 0; attempt < 4; attempt++) {
    const slug =
      attempt === 0 ? baseSlug : `${baseSlug}-${tieBreak.slice(attempt * 6, attempt * 6 + 6)}`;
    const { rows } = await pool.query<{ id: string; slug: string | null }>(
      `with new_org as (
         insert into public.ba_organization
           (id, name, slug, kind, personal_owner_user_id, "createdAt")
         values ($1, $2, $3, 'personal', $4, now())
         on conflict do nothing
         returning id, slug
       ), new_member as (
         insert into public.ba_member (id, "organizationId", "userId", role, "createdAt")
         select $5, id, $4, 'owner', now() from new_org
         on conflict ("organizationId", "userId") do nothing
       )
       select id, slug from new_org`,
      [orgId, workspaceName, slug, baUserId, `personal-member:${baUserId}`],
    );

    if (!rows[0]) {
      // Either this account's row already exists (a concurrent request won), or
      // the slug belongs to someone else. Only the first case is ours to adopt.
      const mine = await pool.query<{ slug: string | null }>(
        'select slug from public.ba_organization where id = $1',
        [orgId],
      );
      if (!mine.rows[0]) continue; // slug taken by another account — next suffix
      await claimOwnership(orgId, baUserId);
      return {
        id: orgId,
        name: workspaceName,
        slug: mine.rows[0].slug,
        role: 'owner',
        kind: 'personal',
      };
    }

    return { id: orgId, name: workspaceName, slug: rows[0].slug, role: 'owner', kind: 'personal' };
  }

  const existing = await findMembership(baUserId, orgId);
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

/** Provision the company named during signup exactly once, even across tabs. */
async function ensureInitialCompany(
  baUserId: string,
  preferredName: string,
): Promise<ActiveOrganization> {
  const workspaceName = preferredName.trim().slice(0, 120);
  const orgId = `company:${baUserId}`;
  const baseSlug = slugify(workspaceName);
  const tieBreak = createHash('sha256').update(`company:${baUserId}`).digest('hex');

  for (let attempt = 0; attempt < 4; attempt++) {
    const slug =
      attempt === 0 ? baseSlug : `${baseSlug}-${tieBreak.slice(attempt * 6, attempt * 6 + 6)}`;
    const { rows } = await pool.query<{ id: string; slug: string | null }>(
      `with new_org as (
         insert into public.ba_organization
           (id, name, slug, kind, "createdAt")
         values ($1, $2, $3, 'company', now())
         on conflict do nothing
         returning id, slug
       ), new_member as (
         insert into public.ba_member (id, "organizationId", "userId", role, "createdAt")
         select $4, id, $5, 'owner', now() from new_org
         on conflict ("organizationId", "userId") do nothing
       )
       select id, slug from new_org`,
      [orgId, workspaceName, slug, `company-member:${baUserId}`, baUserId],
    );
    if (rows[0]) {
      return {
        id: orgId,
        name: workspaceName,
        slug: rows[0].slug,
        role: 'owner',
        kind: 'company',
      };
    }

    const existing = await findMembership(baUserId, orgId);
    if (existing) return existing;
    const mine = await pool.query<{ name: string; slug: string | null }>(
      `select name, slug from public.ba_organization
        where id = $1 and kind = 'company'`,
      [orgId],
    );
    if (!mine.rows[0]) continue;
    await claimOwnership(orgId, baUserId);
    return {
      id: orgId,
      name: mine.rows[0].name,
      slug: mine.rows[0].slug,
      role: 'owner',
      kind: 'company',
    };
  }
  throw new Error('could not provision initial company');
}

/**
 * The workspace this request acts in, provisioning one if the account has none.
 *
 * @param activeOrganizationId what the session claims is active — honoured only
 *   when the user is still a member (leaving a workspace must not keep granting
 *   access through a stale session).
 * @param preferredName the company somebody typed at signup, if it survived the
 *   trip (see WORKSPACE_NAME_COOKIE). It provisions one deterministic initial
 *   company only when the account has no company and no pending invitation.
 */
/**
 * La invitación que está esperando a esta dirección, si la hay.
 *
 * Misma consulta que `assertMaySignUp` en lib/auth.ts —`lower(email)` contra el
 * índice de la 0052, sólo pendientes y sin vencer— y a propósito: son dos
 * consumidores de UN hecho («a esta persona la están esperando»), y dos
 * definiciones distintas de ese hecho es como una puerta empieza a discrepar de
 * la otra. Allí decide si puede registrarse; aquí, si hay que fabricarle un
 * espacio.
 *
 * Devuelve la MÁS RECIENTE cuando hay varias: si dos empresas invitaron a la
 * misma persona, la que acaba de mandarle el correo que está mirando es la que
 * tiene más probabilidades de ser a la que iba. Las otras siguen pendientes y
 * las puede aceptar después desde su propio enlace.
 */
async function findPendingInvitationId(email: string): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `select id
         from public.ba_invitation
        where lower(email) = $1
          and status = 'pending'
          and "expiresAt" > now()
        order by "expiresAt" desc
        limit 1`,
      [email.trim().toLowerCase()],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    // Una invitación que no se pudo leer no puede dejar a la persona sin entrar:
    // se sigue al camino de siempre, que como mucho le fabrica un espacio de más.
    console.error('[organization] no se pudo buscar la invitación pendiente', err);
    return null;
  }
}

/**
 * Lo que hay que hacer con esta sesión: entrar a un espacio, o ir a aceptar la
 * invitación que la está esperando.
 *
 * El segundo caso no existía y es la corrección entera: quien llega invitado no
 * necesita un espacio propio, necesita el que le invitaron. Ver
 * `lib/invite-landing.ts`.
 */
export type WorkspaceResolution =
  | { kind: 'workspace'; workspace: ActiveOrganization }
  | { kind: 'pending-invitation'; invitationId: string }
  | { kind: 'forbidden-workspace' };

export async function resolveActiveOrganization(
  baUserId: string,
  activeOrganizationId: string | null | undefined,
  name: string | null,
  email: string,
  preferredName?: string | null,
  requestOrganizationId: string | null = null,
): Promise<WorkspaceResolution> {
  // Every identity owns one isolated personal tenant, including invited users.
  // This is idempotent and race-safe; it never changes the active company.
  const personal = await ensurePersonalWorkspace(baUserId, name, email);
  const explicitRequest = requestOrganizationId !== null;
  const requestedId = explicitRequest ? requestOrganizationId : activeOrganizationId;
  const claimed = requestedId ? await findMembership(baUserId, requestedId) : null;
  // An explicit tab/request context never falls back. Membership is read from
  // BA on every request, so removal takes effect despite a stale session/cookie.
  if (explicitRequest && !claimed) return { kind: 'forbidden-workspace' };
  const firstCompany =
    claimed?.kind === 'company' ? null : await findFirstCompanyMembership(baUserId);
  const pendingInvitationId =
    !firstCompany && (!claimed || claimed.kind === 'personal')
      ? await findPendingInvitationId(email)
      : null;

  // A personal workspace is automatic and must not hide an invitation or cause
  // the signup company to be created beside one. Existing company memberships
  // skip this lookup on ordinary requests.
  const landing = workspaceLanding({
    activeMembershipId: claimed?.id ?? null,
    // The automatic personal tenant must not hide an invitation from a new
    // account. Only an explicitly active workspace or an existing company
    // membership wins before the pending invitation.
    firstMembershipId: firstCompany?.id ?? null,
    pendingInvitationId,
  });

  if (landing.action === 'accept-invitation') {
    return { kind: 'pending-invitation', invitationId: landing.invitationId };
  }

  const initialCompany =
    !explicitRequest &&
    (!claimed || claimed.kind === 'personal') &&
    !firstCompany &&
    !pendingInvitationId &&
    preferredName?.trim()
      ? await ensureInitialCompany(baUserId, preferredName)
      : null;
  const resolved = initialCompany ?? claimed ?? firstCompany ?? personal;

  // Write the choice back so the next request reads it from the session instead
  // of re-deriving it. Best-effort: a failure here costs a lookup, not access.
  try {
    if (explicitRequest) return { kind: 'workspace', workspace: resolved };
    await pool.query(
      `update public.ba_session set "activeOrganizationId" = $2
        where "userId" = $1 and ("activeOrganizationId" is distinct from $2)`,
      [baUserId, resolved.id],
    );
  } catch (err) {
    console.error('[organization] could not persist active workspace', err);
  }

  return { kind: 'workspace', workspace: resolved };
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
    `select o.id, o.name, o.slug, m.role, o.kind
       from public.ba_member m
       join public.ba_organization o on o.id = m."organizationId"
      where m."userId" = $1
      order by (o.kind = 'personal') desc, m."createdAt" asc`,
    [baUserId],
  );
  return rows.map(toActiveOrganization);
}

async function findFirstCompanyMembership(baUserId: string): Promise<ActiveOrganization | null> {
  const { rows } = await pool.query<MembershipRow>(
    `select o.id, o.name, o.slug, m.role, o.kind
       from public.ba_member m
       join public.ba_organization o on o.id = m."organizationId"
      where m."userId" = $1 and o.kind = 'company'
      order by m."createdAt" asc
      limit 1`,
    [baUserId],
  );
  return rows[0] ? toActiveOrganization(rows[0]) : null;
}

export async function countOwnedCompanies(baUserId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)::text as count
       from public.ba_member m
       join public.ba_organization o on o.id = m."organizationId"
      where m."userId" = $1 and m.role = 'owner' and o.kind = 'company'`,
    [baUserId],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Un espacio de trabajo MÁS, creado a propósito.
 *
 * ===========================================================================
 * POR QUÉ NO SIRVE `createWorkspace`
 * ===========================================================================
 * Aquella deriva el id de un hash del id de cuenta (`firstWorkspaceId`) y eso no
 * es un detalle: es lo que convierte la carrera de la primera petición —una
 * cuenta nueva dispara la página, sus datos y una precarga a la vez, y las tres
 * encuentran «sin membresía»— en una sola fila. Con ids aleatorios, cada una
 * ganaba su propio INSERT y la cuenta terminaba con tres espacios idénticos.
 * Observado, no hipotético.
 *
 * Aquí la carrera no existe: no hay tres peticiones concurrentes descubriendo lo
 * mismo, hay una persona que escribió un nombre y pulsó un botón. Un id derivado
 * sería justo lo contrario de lo que hace falta —sólo permitiría UNO— así que
 * este camino usa un id aleatorio, y por eso está separado en vez de ser una
 * bandera del otro.
 *
 * El tope se comprueba aquí y no sólo en better-auth porque la respuesta tiene
 * que ser una frase en español que diga cuántos hay y cuántos caben, no un error
 * de librería. Se comprueba ANTES de escribir nada.
 */
export async function createAdditionalWorkspace(
  baUserId: string,
  name: string,
): Promise<{ ok: true; workspace: ActiveOrganization } | { ok: false; reason: 'limit' }> {
  const workspaceName = name.trim().slice(0, 120) || 'Espacio sin nombre';
  const baseSlug = slugify(workspaceName);
  const orgId = randomUUID();
  const client = await pool.connect();

  try {
    await client.query('begin');
    // Serializes company creation for one identity, so two tabs cannot both
    // observe the final free slot and exceed the founder limit.
    await client.query(`select pg_advisory_xact_lock(hashtext('cortex:create-company:' || $1))`, [
      baUserId,
    ]);
    const { rows: counts } = await client.query<{ count: string }>(
      `select count(*)::text as count
         from public.ba_member m
         join public.ba_organization o on o.id = m."organizationId"
        where m."userId" = $1 and m.role = 'owner' and o.kind = 'company'`,
      [baUserId],
    );
    if (Number(counts[0]?.count ?? 0) >= WORKSPACE_LIMIT) {
      await client.query('rollback');
      return { ok: false, reason: 'limit' };
    }

    // Los slugs son únicos en TODA la instalación, así que dos empresas que se
    // llaman igual chocan. `on conflict do nothing` keeps the transaction usable
    // while a new deterministic suffix is tried.
    for (let attempt = 0; attempt < 4; attempt++) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomUUID().slice(0, 6)}`;
      const { rows } = await client.query<{ id: string; slug: string | null }>(
        `with new_org as (
         insert into public.ba_organization (id, name, slug, kind, "createdAt")
         values ($1, $2, $3, 'company', now())
         on conflict do nothing
         returning id, slug
       ), new_member as (
         insert into public.ba_member (id, "organizationId", "userId", role, "createdAt")
         select $4, id, $5, 'owner', now() from new_org
         returning "organizationId"
       )
       select o.id, o.slug from new_org o
       join new_member m on m."organizationId" = o.id`,
        [orgId, workspaceName, slug, randomUUID(), baUserId],
      );
      if (!rows[0]) continue;
      await client.query('commit');
      return {
        ok: true,
        workspace: {
          id: orgId,
          name: workspaceName,
          slug: rows[0].slug,
          role: 'owner',
          kind: 'company',
        },
      };
    }
    throw new Error('could not create an additional workspace');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
