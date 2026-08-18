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
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'workspace';
}

/**
 * A human name for a first workspace.
 *
 * The company somebody typed at signup wins, because it is the only one of the
 * three that is actually the answer to "what is this workspace" — the other two
 * are guesses made in its absence, and they are the reason a colleague opening
 * an invitation used to be asked to join "ana's workspace" instead of the
 * company they both work at. Falls back to the old behaviour exactly, so an
 * account created any other way is unaffected.
 */
function defaultWorkspaceName(
  name: string | null,
  email: string,
  preferredName?: string | null,
): string {
  const company = (preferredName ?? '').trim();
  if (company) return company.slice(0, 120);
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
  preferredName?: string | null,
): Promise<ActiveOrganization> {
  const workspaceName = defaultWorkspaceName(name, email, preferredName);
  // The slug follows the same preference, so `acme.cortex` beats `ana-restrepo`
  // — but the derived tie-break below is untouched, because a random suffix here
  // would reintroduce the duplicate-workspace race this function exists to
  // avoid.
  const baseSlug = slugify(preferredName?.trim() || name || email.split('@')[0] || 'workspace');
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
 * @param preferredName the company somebody typed at signup, if it survived the
 *   trip (see WORKSPACE_NAME_COOKIE). Used ONLY when a workspace is being
 *   created, and only to name it — it reaches no other branch, so a stale or
 *   forged value cannot affect who is a member of what.
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
  | { kind: 'pending-invitation'; invitationId: string };

export async function resolveActiveOrganization(
  baUserId: string,
  activeOrganizationId: string | null | undefined,
  name: string | null,
  email: string,
  preferredName?: string | null,
): Promise<WorkspaceResolution> {
  const claimed = activeOrganizationId
    ? await findMembership(baUserId, activeOrganizationId)
    : null;
  const member = claimed ?? (await findFirstMembership(baUserId));

  // La invitación sólo se busca cuando NO hay ninguna membresía. Es una consulta
  // más en el camino de una cuenta recién creada, y cero en todas las demás
  // peticiones del producto.
  const landing = workspaceLanding({
    activeMembershipId: claimed?.id ?? null,
    firstMembershipId: member?.id ?? null,
    pendingInvitationId: member ? null : await findPendingInvitationId(email),
  });

  if (landing.action === 'accept-invitation') {
    return { kind: 'pending-invitation', invitationId: landing.invitationId };
  }

  const resolved = member ?? (await createWorkspace(baUserId, name, email, preferredName));

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
    `select o.id, o.name, o.slug, m.role
       from public.ba_member m
       join public.ba_organization o on o.id = m."organizationId"
      where m."userId" = $1
      order by m."createdAt" asc`,
    [baUserId],
  );
  return rows.map(toActiveOrganization);
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
  const mine = await listMemberships(baUserId);
  if (mine.length >= WORKSPACE_LIMIT) return { ok: false, reason: 'limit' };

  const workspaceName = name.trim().slice(0, 120) || 'Espacio sin nombre';
  const baseSlug = slugify(workspaceName);
  const orgId = randomUUID();

  // Los slugs son únicos en TODA la instalación, así que dos empresas que se
  // llaman igual chocan. Se reintenta con sufijo aleatorio —y aquí sí puede ser
  // aleatorio, porque no hay carrera que desempatar— y al agotarse se cae a un
  // slug que no puede chocar, en vez de negarle a alguien su espacio por un
  // nombre que ya usó un desconocido.
  for (let attempt = 0; attempt < 4; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomUUID().slice(0, 6)}`;
    const { rows } = await pool.query<{ id: string; slug: string | null }>(
      `insert into public.ba_organization (id, name, slug, "createdAt")
       values ($1, $2, $3, now())
       on conflict do nothing
       returning id, slug`,
      [orgId, workspaceName, slug],
    );
    if (!rows[0]) continue;
    await claimOwnership(orgId, baUserId);
    return {
      ok: true,
      workspace: { id: orgId, name: workspaceName, slug: rows[0].slug, role: 'owner' },
    };
  }
  throw new Error('could not create an additional workspace');
}
