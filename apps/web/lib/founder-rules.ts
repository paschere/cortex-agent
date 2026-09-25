/**
 * Las reglas de administración del modo fundador, sin base de datos.
 *
 * ===========================================================================
 * POR QUÉ VIVEN APARTE Y SIN `server-only`
 * ===========================================================================
 * Son las decisiones que, si salen mal, son un incidente y no una molestia:
 * quién puede cambiar el rol de quién, cuándo una salida dejaría a una empresa
 * sin dueño, y qué empresas de una lista mandada por el navegador son de verdad
 * de quien la manda. Separarlas de las consultas permite probarlas una por una
 * (founder-rules.test.ts) sin simular better-auth ni Postgres, y garantiza que
 * la consola del fundador y «Personas» de cada empresa (/admin/users) apliquen
 * LA MISMA regla: dos copias de «no se puede quitar al último dueño» se separan
 * el día que alguien toque una.
 *
 * ===========================================================================
 * LOS DOS ROLES QUE HAY QUE MANTENER DE ACUERDO
 * ===========================================================================
 * better-auth guarda la membresía en `ba_member.role` (owner/admin/member) y
 * Cortex tiene su propio directorio en `public.users.role`
 * (org_admin/team_admin/member). La fuente de verdad es la primera:
 * `resolveSessionDirectory` recalcula la segunda a partir de ella en CADA
 * petición, y sólo conserva `team_admin` cuando la membresía dice `member`.
 *
 * Por eso cambiar sólo `public.users.role` —lo que hacía /admin/users— no
 * duraba: ascender a alguien a admin de la organización se revertía en su
 * siguiente petición. `membershipTargetFor` traduce el rol del directorio al
 * par que hay que escribir, en ese orden: primero la membresía, luego el
 * directorio.
 */

import type { OrgRole, Role } from '@cortex/core';

/** Lo que hay que escribir en cada tabla para que un rol del directorio persista. */
export interface MembershipTarget {
  /** `ba_member.role`. Nunca `owner`: la transferencia de propiedad es otro flujo. */
  membershipRole: 'admin' | 'member';
  /** `public.users.role`, tal como lo dejará `resolveSessionDirectory`. */
  directoryRole: Role;
}

export function membershipTargetFor(role: Role): MembershipTarget {
  if (role === 'org_admin') return { membershipRole: 'admin', directoryRole: 'org_admin' };
  // `team_admin` sólo sobrevive con membresía `member`: con `admin` el
  // directorio lo pisaría con `org_admin` en la siguiente petición.
  if (role === 'team_admin') return { membershipRole: 'member', directoryRole: 'team_admin' };
  return { membershipRole: 'member', directoryRole: 'member' };
}

/** El rol del directorio que corresponde a una membresía, igual que session-directory.ts. */
export function directoryRoleFor(membershipRole: string, current?: Role | null): Role {
  if (membershipRole === 'owner' || membershipRole === 'admin') return 'org_admin';
  return current === 'team_admin' ? 'team_admin' : 'member';
}

export function normalizeMembershipRole(role: string | null | undefined): OrgRole {
  // Igual que `toActiveOrganization`: lo desconocido degrada al menor privilegio.
  return role === 'owner' || role === 'admin' ? role : 'member';
}

export type MembershipRefusal =
  | 'personal'
  | 'not_manager'
  | 'owner_protected'
  | 'last_owner'
  | 'self'
  | 'unchanged';

/** La frase que ve quien pulsó. Una por motivo, sin detalles de la librería. */
export const REFUSAL_MESSAGE: Record<MembershipRefusal, string> = {
  personal: 'Un espacio personal no tiene equipo: nadie más puede entrar ni salir de él.',
  not_manager: 'Solo quien administra la empresa puede cambiar su equipo.',
  owner_protected: 'Solo otro fundador puede cambiar o retirar a un fundador.',
  last_owner: 'La empresa se quedaría sin fundador. Nombra otro antes de hacer este cambio.',
  self: 'No puedes cambiar tu propio rol desde aquí.',
  unchanged: 'Esa persona ya tiene ese rol.',
};

export interface MembershipChangeInput {
  workspaceKind: 'personal' | 'company';
  /** Rol de quien actúa en ESA empresa, leído del servidor. */
  actorRole: OrgRole;
  actorIsTarget: boolean;
  /** `ba_member.role` de la persona afectada. */
  targetRole: OrgRole;
  /** Cuántos `owner` tiene hoy la empresa. */
  ownerCount: number;
}

export type Decision = { ok: true } | { ok: false; reason: MembershipRefusal };

function baseRefusal(input: MembershipChangeInput): MembershipRefusal | null {
  if (input.workspaceKind === 'personal') return 'personal';
  if (input.actorRole !== 'owner' && input.actorRole !== 'admin') return 'not_manager';
  // better-auth impone lo mismo (`isUpdatingCreator && !updaterIsCreator`); se
  // repite aquí para responder en español y ANTES de escribir nada.
  if (input.targetRole === 'owner' && input.actorRole !== 'owner') return 'owner_protected';
  return null;
}

/**
 * ¿Se puede poner a esta persona en `next`?
 *
 * `next` es un rol del directorio; nunca produce `owner` (ver
 * `membershipTargetFor`), así que dárselo a un fundador es siempre quitarle la
 * propiedad, y eso exige que quede otro.
 */
export function decideRoleChange(
  input: MembershipChangeInput & { currentDirectoryRole: Role; next: Role },
): Decision {
  const refusal = baseRefusal(input);
  if (refusal) return { ok: false, reason: refusal };
  if (input.actorIsTarget) return { ok: false, reason: 'self' };
  const target = membershipTargetFor(input.next);
  if (input.targetRole === 'owner' && input.ownerCount <= 1) {
    return { ok: false, reason: 'last_owner' };
  }
  const sameMembership =
    input.targetRole !== 'owner' &&
    normalizeMembershipRole(input.targetRole) === target.membershipRole;
  if (sameMembership && input.currentDirectoryRole === target.directoryRole) {
    return { ok: false, reason: 'unchanged' };
  }
  return { ok: true };
}

/**
 * ¿Se puede retirar a esta persona de la empresa?
 *
 * Salir uno mismo se permite —es «dejar la empresa»— salvo que se sea el
 * último fundador: el disparador de la 0138 revoca credenciales y pausa
 * rutinas, pero ninguna migración le devuelve un dueño a una empresa huérfana.
 */
export function decideRemoval(input: MembershipChangeInput): Decision {
  const refusal = baseRefusal(input);
  if (refusal) return { ok: false, reason: refusal };
  if (input.targetRole === 'owner' && input.ownerCount <= 1) {
    return { ok: false, reason: 'last_owner' };
  }
  return { ok: true };
}

/**
 * Qué empresas de las que pidió el navegador son de verdad de esta cuenta.
 *
 * `owned` sale SIEMPRE de `ba_member` en el servidor. Lo que llega de afuera se
 * deduplica, y cualquier id que no esté en `owned` —de otra empresa, de un
 * espacio personal, inventado— cae en `denied` sin distinguir por qué, para que
 * la respuesta no sirva para averiguar qué empresas existen.
 */
export function partitionOwned(
  requested: readonly string[],
  owned: ReadonlySet<string>,
): { allowed: string[]; denied: string[] } {
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const id of new Set(requested)) (owned.has(id) ? allowed : denied).push(id);
  return { allowed, denied };
}

/* ---------------------------------------------------------------------------
 * Forma de los datos de la consola
 * ------------------------------------------------------------------------- */

export interface MembershipRow {
  memberId: string;
  organizationId: string;
  organizationName: string;
  accountId: string;
  name: string | null;
  email: string;
  role: string;
  directoryRole: string | null;
  joinedAt: string;
}

export interface PersonMembership {
  memberId: string;
  organizationId: string;
  organizationName: string;
  role: OrgRole;
  directoryRole: Role;
  joinedAt: string;
}

export interface FounderPerson {
  accountId: string;
  name: string | null;
  email: string;
  memberships: PersonMembership[];
  /** El ingreso más antiguo en cualquiera de las empresas. */
  firstJoinedAt: string;
}

function asRole(value: string | null): Role | null {
  return value === 'org_admin' || value === 'team_admin' || value === 'member' ? value : null;
}

/**
 * Una fila por persona, con sus empresas dentro.
 *
 * Quien trabaja en tres empresas del mismo fundador es UNA persona con tres
 * membresías, no tres personas: así se ve de un vistazo a quién le afecta un
 * cambio. Ordenadas por nombre visible, y sus empresas por nombre.
 */
export function groupPeople(rows: readonly MembershipRow[]): FounderPerson[] {
  const people = new Map<string, FounderPerson>();
  for (const row of rows) {
    const role = normalizeMembershipRole(row.role);
    const membership: PersonMembership = {
      memberId: row.memberId,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      role,
      directoryRole: directoryRoleFor(role, asRole(row.directoryRole)),
      joinedAt: row.joinedAt,
    };
    const person = people.get(row.accountId);
    if (!person) {
      people.set(row.accountId, {
        accountId: row.accountId,
        name: row.name?.trim() || null,
        email: row.email,
        memberships: [membership],
        firstJoinedAt: row.joinedAt,
      });
      continue;
    }
    person.memberships.push(membership);
    if (row.joinedAt < person.firstJoinedAt) person.firstJoinedAt = row.joinedAt;
  }
  const label = (p: FounderPerson) => (p.name ?? p.email).toLocaleLowerCase('es');
  return [...people.values()]
    .map((person) => ({
      ...person,
      memberships: person.memberships.sort((a, b) =>
        a.organizationName.localeCompare(b.organizationName, 'es'),
      ),
    }))
    .sort((a, b) => label(a).localeCompare(label(b), 'es'));
}

/** Cuántos fundadores tiene cada empresa, a partir de las mismas filas. */
export function ownerCounts(rows: readonly MembershipRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (normalizeMembershipRole(row.role) !== 'owner') continue;
    counts.set(row.organizationId, (counts.get(row.organizationId) ?? 0) + 1);
  }
  return counts;
}

/** Resultado de una acción aplicada a varias empresas: cada una responde por sí. */
export interface PerCompanyResult {
  organizationId: string;
  organizationName: string;
  ok: boolean;
  message: string;
}

/** Resumen de una acción múltiple, para la línea que se lee antes del detalle. */
export function summarizeResults(results: readonly PerCompanyResult[]): {
  tone: 'emerald' | 'amber' | 'rose';
  text: string;
} {
  const done = results.filter((r) => r.ok).length;
  if (results.length === 0) return { tone: 'rose', text: 'No elegiste ninguna empresa.' };
  if (done === results.length) {
    return {
      tone: 'emerald',
      text: done === 1 ? 'Listo en 1 empresa.' : `Listo en las ${done} empresas.`,
    };
  }
  if (done === 0) return { tone: 'rose', text: 'No se pudo en ninguna empresa.' };
  return { tone: 'amber', text: `Listo en ${done} de ${results.length} empresas.` };
}

/* ---------------------------------------------------------------------------
 * Salud de una empresa
 * ------------------------------------------------------------------------- */

export type HealthTone = 'emerald' | 'amber' | 'rose' | 'neutral';

export interface HealthInput {
  meterState: 'ok' | 'warning' | 'grace' | 'blocked' | null;
  seatsFull: boolean;
  failedRuns7d: number;
  blocked: number | null;
  subscriptionStatus: 'active' | 'past_due' | 'canceled' | null;
}

/**
 * Una sola señal por empresa, la peor que haya.
 *
 * No es una nota ni un promedio: es «¿tengo que entrar hoy?». Rojo cuando algo
 * ya está parado (cobro vencido, cupo agotado); ámbar cuando algo lo va a
 * estar o falló hace poco; verde en lo demás.
 */
export function healthOf(input: HealthInput): { tone: HealthTone; label: string } {
  if (input.subscriptionStatus === 'past_due' || input.subscriptionStatus === 'canceled') {
    return { tone: 'rose', label: 'Cobro pendiente' };
  }
  if (input.meterState === 'blocked') return { tone: 'rose', label: 'Sin respuestas' };
  if (input.meterState === 'grace') return { tone: 'amber', label: 'En margen de cortesía' };
  if (input.failedRuns7d > 0) return { tone: 'amber', label: 'Rutinas con fallos' };
  if ((input.blocked ?? 0) > 0) return { tone: 'amber', label: 'Procesos bloqueados' };
  if (input.meterState === 'warning') return { tone: 'amber', label: 'Cupo por agotarse' };
  if (input.seatsFull) return { tone: 'amber', label: 'Asientos llenos' };
  return { tone: 'emerald', label: 'En orden' };
}
